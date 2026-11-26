import { streetCloudNoiseSide } from "./street-cloud-noise";

export const streetSkyUnit=17;
export const streetCloudShadowUnit=20;
export const streetCloudNoiseUnit=21;
export const streetPreviousSkyUnit=25;
const width=1024,height=256;
const skyRowsPerFrame=64,skyBlendMs=220;
const cloudShadowSide=128,cloudShadowSpan=8;
type CloudShadowRegion=readonly [left:number,bottom:number,span:number];
type SkyObserver=readonly [number,number,number];

export class StreetSky {
  private target:WebGLFramebuffer|null=null;
  private texture:WebGLTexture|null=null;
  private lighting:object|undefined;
  private spare:WebGLTexture|null=null;
  private atmosphereObserver?:SkyObserver;
  private pending?:{observer:SkyObserver;row:number};
  private blendStarted?:number;
  private motionSupported:boolean;
  previousAmount=0;
  private supported:boolean;
  private hdrSupported:boolean;
  private cloudShadowsSupported:boolean;
  private cloudShadowTarget:WebGLFramebuffer|null=null;
  private cloudShadowTexture:WebGLTexture|null=null;
  private cloudShadowRegion?:CloudShadowRegion;
  private cloudShadowLighting?:object;
  private noise?:WebGLTexture;
  private noiseSource?:Uint8Array<ArrayBuffer>;
  readonly supportsCloudNoise:boolean;

  constructor(private readonly gl:WebGL2RenderingContext){
    const units=gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
    this.supported=units>streetSkyUnit;
    this.hdrSupported=this.supported&&Boolean(gl.getExtension("EXT_color_buffer_float"));
    this.cloudShadowsSupported=units>streetCloudShadowUnit;
    this.supportsCloudNoise=units>streetCloudNoiseUnit;
    this.motionSupported=units>streetPreviousSkyUnit;
  }

  bindSampler(location:WebGLUniformLocation|null){
    this.gl.uniform1i(location,this.supported?streetSkyUnit:0);
  }

  bindCloudShadowSampler(location:WebGLUniformLocation|null){
    this.gl.uniform1i(location,this.cloudShadowsSupported?streetCloudShadowUnit:0);
  }

  bindCloudNoiseSampler(location:WebGLUniformLocation|null){
    this.gl.uniform1i(location,this.supportsCloudNoise?streetCloudNoiseUnit:0);
  }

  setCloudNoise(source:Uint8Array<ArrayBuffer>){
    const size=streetCloudNoiseSide;
    if(!this.supportsCloudNoise||source===this.noiseSource||source.length!==size**3*2)return false;
    const {gl}=this,texture=this.noise??gl.createTexture();
    if(!texture)return false;
    gl.activeTexture(gl.TEXTURE0+streetCloudNoiseUnit);
    gl.bindTexture(gl.TEXTURE_3D,texture);
    gl.texImage3D(gl.TEXTURE_3D,0,gl.RG8,size,size,size,0,gl.RG,gl.UNSIGNED_BYTE,source);
    gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_R,gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_S,gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_T,gl.REPEAT);
    gl.activeTexture(gl.TEXTURE0);
    this.noise=texture;
    this.noiseSource=source;
    this.invalidate();
    return true;
  }

  useCloudNoise(location:WebGLUniformLocation|null){
    if(!this.supportsCloudNoise)return;
    const {gl}=this;
    if(this.noise){
      gl.activeTexture(gl.TEXTURE0+streetCloudNoiseUnit);
      gl.bindTexture(gl.TEXTURE_3D,this.noise);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.uniform1i(location,Number(Boolean(this.noise)));
  }

  get supportsHdr(){return this.hdrSupported;}
  get needsFrame(){return Boolean(this.pending)||this.previousAmount>0;}

  private createSkyTexture(format:number){
    const {gl}=this;
    const texture=gl.createTexture();
    if(!texture)return null;
    gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texStorage2D(gl.TEXTURE_2D,6,format,width,height);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    return texture;
  }

  private allocateSky(format:number){
    const {gl}=this,target=gl.createFramebuffer(),texture=this.createSkyTexture(format);
    if(!target||!texture){
      gl.deleteTexture(texture);gl.deleteFramebuffer(target);
      return false;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,target);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    const ready=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    if(!ready){
      gl.deleteTexture(texture);gl.deleteFramebuffer(target);
      return false;
    }
    this.target=target;this.texture=texture;
    return true;
  }

  update(lighting:object,draw:(hdr:boolean,observer?:SkyObserver)=>void,
    motion?:{observer:SkyObserver;now:number;moving:boolean}){
    if(!this.supported)return false;
    const {gl}=this;
    gl.activeTexture(gl.TEXTURE0+streetSkyUnit);
    if(!this.target){
      this.hdrSupported=this.hdrSupported&&this.allocateSky(gl.RGBA16F);
      if(!this.hdrSupported&&!this.allocateSky(gl.RGBA8)){
        gl.activeTexture(gl.TEXTURE0);
        this.supported=false;
        return false;
      }
    }
    if(this.lighting!==lighting){
      gl.bindTexture(gl.TEXTURE_2D,null);
      gl.bindFramebuffer(gl.FRAMEBUFFER,this.target);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.texture,0);
      gl.viewport(0,0,width,height);
      draw(this.hdrSupported);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);
      gl.bindTexture(gl.TEXTURE_2D,this.texture);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.lighting=lighting;
      this.atmosphereObserver=motion?.observer;
      this.pending=undefined;this.blendStarted=undefined;
    }else if(motion&&this.motionSupported){
      const {observer,now,moving}=motion;
      const last=this.atmosphereObserver??observer;
      this.atmosphereObserver=last;
      const distance=Math.hypot(observer[0]-last[0],observer[1]-last[1],observer[2]-last[2]);
      if(this.blendStarted!==undefined&&now-this.blendStarted>=skyBlendMs)this.blendStarted=undefined;
      if(!this.pending&&this.blendStarted===undefined&&distance>=(moving ? .32 : .10)){
        this.spare??=this.createSkyTexture(this.hdrSupported?gl.RGBA16F:gl.RGBA8);
        if(this.spare)this.pending={observer,row:0};
        else this.motionSupported=false;
      }
      const pending=this.pending;
      if(pending&&this.spare){
        gl.bindTexture(gl.TEXTURE_2D,null);
        gl.activeTexture(gl.TEXTURE0+streetPreviousSkyUnit);
        gl.bindTexture(gl.TEXTURE_2D,null);
        gl.activeTexture(gl.TEXTURE0+streetSkyUnit);
        gl.bindFramebuffer(gl.FRAMEBUFFER,this.target);
        gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.spare,0);
        gl.viewport(0,0,width,height);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0,pending.row,width,skyRowsPerFrame);
        draw(this.hdrSupported,pending.observer);
        gl.disable(gl.SCISSOR_TEST);
        gl.bindFramebuffer(gl.FRAMEBUFFER,null);
        gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);
        pending.row+=skyRowsPerFrame;
        if(pending.row>=height){
          gl.bindTexture(gl.TEXTURE_2D,this.spare);
          gl.generateMipmap(gl.TEXTURE_2D);
          [this.texture,this.spare]=[this.spare,this.texture];
          this.atmosphereObserver=pending.observer;
          this.pending=undefined;this.blendStarted=now;
        }
      }
    }
    gl.bindTexture(gl.TEXTURE_2D,this.texture);
    this.previousAmount=motion&&this.blendStarted!==undefined?1-(motion.now-this.blendStarted)/skyBlendMs:0;
    if(this.previousAmount>0){
      gl.activeTexture(gl.TEXTURE0+streetPreviousSkyUnit);
      gl.bindTexture(gl.TEXTURE_2D,this.spare);
    }
    gl.activeTexture(gl.TEXTURE0);
    return true;
  }

  updateCloudShadows(lighting:object,x:number,y:number,draw:(region:CloudShadowRegion)=>void){
    if(!this.cloudShadowsSupported)return;
    const {gl}=this;
    gl.activeTexture(gl.TEXTURE0+streetCloudShadowUnit);
    if(!this.cloudShadowTarget){
      const target=gl.createFramebuffer(),texture=gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texStorage2D(gl.TEXTURE_2D,1,gl.R8,cloudShadowSide,cloudShadowSide);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER,target);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
      const ready=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      if(!ready){
        gl.deleteTexture(texture);gl.deleteFramebuffer(target);
        gl.activeTexture(gl.TEXTURE0);
        this.cloudShadowsSupported=false;
        return;
      }
      this.cloudShadowTarget=target;this.cloudShadowTexture=texture;
    }
    const left=Math.round(x/2)*2-cloudShadowSpan/2,bottom=Math.round(y/2)*2-cloudShadowSpan/2;
    if(this.cloudShadowLighting!==lighting||this.cloudShadowRegion?.[0]!==left||
      this.cloudShadowRegion?.[1]!==bottom){
      const region=[left,bottom,cloudShadowSpan] as const;
      gl.bindTexture(gl.TEXTURE_2D,null);
      gl.bindFramebuffer(gl.FRAMEBUFFER,this.cloudShadowTarget);
      gl.viewport(0,0,cloudShadowSide,cloudShadowSide);
      draw(region);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);
      this.cloudShadowLighting=lighting;this.cloudShadowRegion=region;
    }
    gl.bindTexture(gl.TEXTURE_2D,this.cloudShadowTexture);
    gl.activeTexture(gl.TEXTURE0);
    return this.cloudShadowRegion;
  }

  invalidate(){this.lighting=undefined;this.cloudShadowLighting=undefined;}

  get cloudNoiseSource(){return this.noiseSource;}

  dispose(){
    this.gl.deleteFramebuffer(this.target);
    this.gl.deleteTexture(this.texture);
    this.gl.deleteTexture(this.spare);
    this.gl.deleteFramebuffer(this.cloudShadowTarget);
    this.gl.deleteTexture(this.cloudShadowTexture);
    this.gl.deleteTexture(this.noise??null);
  }
}

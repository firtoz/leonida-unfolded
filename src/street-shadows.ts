import type { Bounds } from "./native-spatial";

type Vec=readonly [number,number,number];
const groundExtent=140;
const shadowTransitionMs=180;
export const streetShadowUnit=16;
export const streetDistantShadowUnit=22;
const dot=(a:Vec,b:Vec)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
export function streetShadowCenter(eye:Vec,origin:Vec,yaw:number,reach:number,altitude:number):Vec{
  // The same physical view can be entered from a different local scene origin.
  const snap=(value:number,offset:number)=>Math.round((value+offset)/8)*8-offset;
  return [snap(eye[0]+Math.cos(yaw)*reach,origin[0]),snap(eye[1]+Math.sin(yaw)*reach,origin[1]),
    snap(eye[2]-Math.max(12,Math.min(altitude*.68,120)),origin[2])];
}

export class StreetShadows {
  private target:WebGLFramebuffer|null=null;
  private texture:WebGLTexture|null=null;
  private key="";
  private revision=-1;
  private paintedAt=-Infinity;
  private frame?:{axes:number[][];center:Vec;sun:Vec;extent:number};
  private previousAxes?:number[][];
  private layer=0;

  private readonly unit:number;
  private readonly size:number;

  constructor(private readonly gl:WebGL2RenderingContext,private readonly distant=false){
    this.unit=distant?streetDistantShadowUnit:streetShadowUnit;
    this.size=distant?1024:2048;
  }

  bindSampler(location:WebGLUniformLocation|null){
    this.gl.uniform1i(location,this.unit);
  }

  update(eye:Vec,origin:Vec,sun:Vec,sunIntensity:number,revision:number,now:number,settled:boolean,yaw:number,altitude:number,
    uniform:(name:string)=>WebGLUniformLocation|null,draw:(center:Vec,inside:(bounds:Bounds)=>boolean,axes:number[][])=>void){
    const {gl}=this;
    const enabled=uniform(this.distant?"sunDistantShadows":"sunShadows");
    if(!enabled)return;
    gl.uniform1i(enabled,0);
    if(sun[2]<.10||sunIntensity<=0||this.distant&&altitude<48)return;
    if(this.distant&&!settled&&!this.target)return;
    if(!this.target&&!this.allocate())return;
    // In flight a larger patch is visible and the terrain under the camera
    // is usually out of frame. Keep walking shadows at their original density.
    const previousExtent=this.frame?.extent??groundExtent;
    const extent=this.distant?630:altitude>=(previousExtent===280?92:100)?280:altitude>=(previousExtent>=210?36:42)?210:groundExtent;
    const reach=(extent-groundExtent)*(this.distant?.48:.63);
    const center=streetShadowCenter(eye,origin,yaw,reach,altitude);
    const key=[...center,...sun,extent,settled].join(",");
    const setAxes=(prefix:string,rows:number[][])=>{
      gl.uniform4fv(uniform(prefix+"X"),rows[0]);
      gl.uniform4fv(uniform(prefix+"Y"),rows[1]);
      gl.uniform4fv(uniform(prefix+"Z"),rows[2]);
    };
    gl.activeTexture(gl.TEXTURE0+this.unit);
    const elapsed=now-this.paintedAt;
    const updateInterval=this.distant?750:settled?120:340;
    const prior=this.frame;
    const changed=key!==this.key||revision!==this.revision;
    const drift=prior?Math.hypot(center[0]-prior.center[0],center[1]-prior.center[1],center[2]-prior.center[2]):Infinity;
    const jump=!prior||prior.extent!==extent||dot(prior.sun,sun)<.99998||drift>extent*.20;
    // A matrix snapped 8 m ahead may differ without affecting the visible
    // footprint. During flight, preserve the cached projection across steps.
    const reproject=settled?key!==this.key:drift>extent*.09;
    const pending=changed&&(reproject||revision!==this.revision||jump);
    if(pending&&(!this.distant||settled)&&(jump||elapsed>=updateInterval||!this.distant&&settled&&reproject)){
      const length=Math.hypot(sun[0],sun[1]);
      const right:Vec=length>1e-5?[-sun[1]/length,sun[0]/length,0]:[1,0,0];
      const up:Vec=[sun[1]*right[2]-sun[2]*right[1],sun[2]*right[0]-sun[0]*right[2],sun[0]*right[1]-sun[1]*right[0]];
      const row=(axis:Vec,range:number,sign=1)=>{
        const scale=sign/range;
        return [axis[0]*scale,axis[1]*scale,axis[2]*scale,-dot(center,axis)*scale];
      };
      const axes=[row(right,extent),row(up,extent),row(sun,extent+100,-1)];
      const inside=([x0,y0,z0,x1,y1,z1]:Bounds)=>axes.every(([a,b,c,d])=>{
        const projected=(a*(x0+x1)+b*(y0+y1)+c*(z0+z1))*.5+d;
        const reach=(Math.abs(a)*(x1-x0)+Math.abs(b)*(y1-y0)+Math.abs(c)*(z1-z0))*.5;
        return Math.abs(projected)<=1+reach;
      });
      const textureTarget=this.distant?gl.TEXTURE_2D:gl.TEXTURE_2D_ARRAY;
      gl.bindTexture(textureTarget,null);
      gl.bindFramebuffer(gl.FRAMEBUFFER,this.target);
      if(!this.distant){
        // Keep the outgoing depth layer while the new projection takes over.
        this.previousAxes=prior&&altitude>0&&dot(prior.sun,sun)>.99998&&drift<=extent*.35?prior.axes:undefined;
        this.layer=1-this.layer;
        gl.framebufferTextureLayer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,this.texture,0,this.layer);
      }
      gl.viewport(0,0,this.size,this.size);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1.6,2);
      draw(center,inside,axes);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);
      this.key=key;this.revision=revision;this.paintedAt=now;
      this.frame={axes,center,sun,extent};
    }
    if(this.frame)setAxes(this.distant?"distantShadow":"shadow",this.frame.axes);
    const fade=this.previousAxes?Math.max(0,1-(now-this.paintedAt)/shadowTransitionMs):0;
    if(!this.distant){
      gl.uniform1f(uniform("shadowLayer"),this.layer);
      gl.uniform1f(uniform("shadowPreviousWeight"),fade);
      if(fade>0&&this.previousAxes)setAxes("shadowPrevious",this.previousAxes);
    }
    gl.activeTexture(gl.TEXTURE0+this.unit);
    gl.bindTexture(this.distant?gl.TEXTURE_2D:gl.TEXTURE_2D_ARRAY,this.texture);
    gl.uniform1i(enabled,Number(Boolean(this.frame)&&(!this.distant||dot(this.frame!.sun,sun)>.99998)));
    gl.activeTexture(gl.TEXTURE0);
    if(fade>0)return 16;
    return pending&&(!this.distant||settled)&&(key!==this.key||revision!==this.revision)?Math.max(1,updateInterval-elapsed):undefined;
  }

  private allocate(){
    const {gl}=this;
    const target=gl.createFramebuffer(),texture=gl.createTexture();
    gl.activeTexture(gl.TEXTURE0+this.unit);
    const textureTarget=this.distant?gl.TEXTURE_2D:gl.TEXTURE_2D_ARRAY;
    gl.bindTexture(textureTarget,texture);
    if(this.distant)gl.texStorage2D(textureTarget,1,gl.DEPTH_COMPONENT24,this.size,this.size);
    else gl.texStorage3D(textureTarget,1,gl.DEPTH_COMPONENT24,this.size,this.size,2);
    gl.texParameteri(textureTarget,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(textureTarget,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(textureTarget,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(textureTarget,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(textureTarget,gl.TEXTURE_COMPARE_MODE,gl.COMPARE_REF_TO_TEXTURE);
    gl.bindFramebuffer(gl.FRAMEBUFFER,target);
    if(this.distant)gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,textureTarget,texture,0);
    else gl.framebufferTextureLayer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,texture,0,this.layer);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    const complete=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.activeTexture(gl.TEXTURE0);
    if(complete){this.target=target;this.texture=texture;}
    else{gl.deleteFramebuffer(target);gl.deleteTexture(texture);}
    return complete;
  }

  dispose(){
    this.gl.deleteFramebuffer(this.target);
    this.gl.deleteTexture(this.texture);
  }
}

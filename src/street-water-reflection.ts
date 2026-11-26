import { streetProjection } from "./street-destination";
import { streetDistance, type StreetStreamView } from "./street-priority";

export const streetWaterReflectionUnit=19;
const maximumWidth=640,maximumHeight=360;
const refreshInterval=120;
type Camera=StreetStreamView;
type Uniforms=(name:string)=>WebGLUniformLocation|null;
type Target={
  framebuffer:WebGLFramebuffer; color:WebGLTexture; depth:WebGLRenderbuffer;
  width:number; height:number;
};

export class StreetWaterReflection {
  private supported?:boolean;
  private target?:Target;
  private camera?:Camera;
  private signature="";
  private lighting?:object;
  private drawnAt=-Infinity;

  constructor(private readonly gl:WebGL2RenderingContext){}

  update(view:Camera,revision:string,lighting:object,now:number,moving:boolean,uniform:Uniforms,draw:()=>void){
    const {gl}=this;
    this.supported??=gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)>streetWaterReflectionUnit;
    if(!this.supported)return false;
    const bucket=(n:number)=>Math.max(16,Math.round(n/16)*16);
    const width=bucket(Math.min(maximumWidth,maximumHeight*view.aspect));
    const height=Math.min(maximumHeight,bucket(width/view.aspect));
    if(!this.target||this.target.width!==width||this.target.height!==height){
      this.dispose();
      this.target=this.allocate(width,height);
      this.camera=undefined;
      if(!this.target){this.supported=false;return false;}
    }
    const previous=this.camera;
    const displaced=previous?streetDistance([...previous.eye,...previous.eye],view.eye):Infinity;
    const rotated=previous?Math.hypot(Math.sin(view.yaw)-Math.sin(previous.yaw),Math.cos(view.yaw)-Math.cos(previous.yaw))+
      Math.abs(view.pitch-previous.pitch):Infinity;
    const viewpointChanged=!previous||displaced>.03||rotated>.002||previous.fov!==view.fov;
    const overdue=now-this.drawnAt>=refreshInterval;
    if(viewpointChanged&&(!moving||overdue||displaced>400||rotated>.2)||
      this.lighting!==lighting||revision!==this.signature&&overdue){
      gl.activeTexture(gl.TEXTURE0+streetWaterReflectionUnit);
      gl.bindTexture(gl.TEXTURE_2D,null);
      gl.bindFramebuffer(gl.FRAMEBUFFER,this.target.framebuffer);
      gl.viewport(0,0,width,height);
      gl.clearColor(0,0,0,0);
      gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.uniform1i(uniform("waterReflectionPass"),1);
      gl.activeTexture(gl.TEXTURE1);
      draw();
      gl.uniform1i(uniform("waterReflectionPass"),0);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      gl.activeTexture(gl.TEXTURE0+streetWaterReflectionUnit);
      gl.bindTexture(gl.TEXTURE_2D,this.target.color);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);
      this.camera=view;
      this.signature=revision;
      this.lighting=lighting;
      this.drawnAt=now;
    }
    const camera=this.camera;
    if(!camera)return false;
    gl.activeTexture(gl.TEXTURE0+streetWaterReflectionUnit);
    gl.bindTexture(gl.TEXTURE_2D,this.target.color);
    gl.uniform1i(uniform("waterReflection"),streetWaterReflectionUnit);
    gl.uniform3f(uniform("waterReflectionEye"),...camera.eye);
    gl.uniform4f(uniform("waterReflectionAngles"),Math.cos(camera.yaw),Math.sin(camera.yaw),
      Math.cos(camera.pitch),Math.sin(camera.pitch));
    gl.uniform2f(uniform("waterReflectionProjection"),streetProjection(camera.fov)/camera.aspect,streetProjection(camera.fov));
    gl.activeTexture(gl.TEXTURE1);
    return true;
  }

  private allocate(width:number,height:number):Target|undefined{
    const {gl}=this;
    const framebuffer=gl.createFramebuffer(),color=gl.createTexture(),depth=gl.createRenderbuffer();
    if(!framebuffer||!color||!depth){
      gl.deleteFramebuffer(framebuffer);gl.deleteTexture(color);gl.deleteRenderbuffer(depth);
      return;
    }
    gl.activeTexture(gl.TEXTURE0+streetWaterReflectionUnit);
    gl.bindTexture(gl.TEXTURE_2D,color);
    const levels=1+Math.floor(Math.log2(Math.max(width,height)));
    gl.texStorage2D(gl.TEXTURE_2D,levels,gl.RGBA8,width,height);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.bindRenderbuffer(gl.RENDERBUFFER,depth);
    gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,width,height);
    gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,color,0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,depth);
    const complete=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.bindRenderbuffer(gl.RENDERBUFFER,null);
    gl.activeTexture(gl.TEXTURE1);
    if(complete)return {framebuffer,color,depth,width,height};
    gl.deleteFramebuffer(framebuffer);gl.deleteTexture(color);gl.deleteRenderbuffer(depth);
  }

  dispose(){
    if(!this.target)return;
    this.gl.deleteFramebuffer(this.target.framebuffer);
    this.gl.deleteTexture(this.target.color);
    this.gl.deleteRenderbuffer(this.target.depth);
    this.target=undefined;
  }
}

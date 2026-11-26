import { streetFarPlane, streetNearPlane } from "./street-grid";
import { streetProjection } from "./street-destination";
import type { StreetLighting } from "./street-lighting";
import type { StreetStreamView } from "./street-priority";
import { makeProgram, uniforms } from "./view-gl";

const vertex=`#version 300 es
out vec2 uv;
void main(){
  uv=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));
  gl_Position=vec4(uv*2.0-1.0,0.0,1.0);
}`;
const trace=`#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform highp sampler2D sceneDepth;
uniform vec2 screenSize,projection;
uniform vec3 sun;
uniform vec2 contact;
uniform float inverseFarPlane;
float depthAt(vec2 p){
  float raw=texelFetch(sceneDepth,ivec2(clamp(p*screenSize,vec2(0.0),screenSize-1.0)),0).r;
  return ${streetNearPlane}/(1.0-raw+${streetNearPlane}*inverseFarPlane);
}
vec3 position(vec2 p,float z){
  return vec3((p*2.0-1.0)*z/projection,z);
}
void main(){
  color=vec4(0.0);
  float depth=depthAt(uv);
  if(depth>88.0)return;
  vec3 surface=position(uv,depth);
  vec2 dx=vec2(1.0/screenSize.x,0.0),dy=vec2(0.0,1.0/screenSize.y);
  float left=depthAt(uv-dx),right=depthAt(uv+dx),down=depthAt(uv-dy),up=depthAt(uv+dy);
  vec3 tangent=abs(left-depth)<abs(right-depth)?surface-position(uv-dx,left):position(uv+dx,right)-surface;
  vec3 bitangent=abs(down-depth)<abs(up-depth)?surface-position(uv-dy,down):position(uv+dy,up)-surface;
  vec3 normal=normalize(cross(bitangent,tangent));
  float facing=dot(normal,sun);
  if(facing<.08)return;
  float footprint=2.0*depth/max(projection.y*screenSize.y,1.0);
  vec3 start=surface+normal*(contact.y+min(.05,footprint*.65));
  float occlusion=0.0;
  for(int i=1;i<=6;i++){
    float fraction=float(i)/6.0;
    vec3 probe=start+sun*(fraction*contact.x);
    if(probe.z<=${streetNearPlane})break;
    vec2 p=probe.xy/probe.z*projection*.5+.5;
    if(any(lessThanEqual(p,vec2(0.0)))||any(greaterThanEqual(p,vec2(1.0))))break;
    float occluder=depthAt(p),separation=probe.z-occluder;
    float thickness=min(.23,max(.08,3.0*footprint+.04));
    float hit=smoothstep(contact.y+footprint*.5,contact.y+footprint+.009,separation)*
      (1.0-smoothstep(thickness*.65,thickness,separation));
    occlusion=max(occlusion,hit*(1.0-.6*fraction));
  }
  float edge=min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
  color.r=occlusion*smoothstep(.08,.45,facing)*(1.0-smoothstep(40.0,88.0,depth))*smoothstep(0.0,.03,edge);
}`;
const composite=`#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform sampler2D mask;
uniform vec2 maskScale;
uniform float strength;
void main(){
  color=vec4(0.0,0.0,0.0,texture(mask,uv*maskScale).r*strength);
}`;

export class StreetContactShadows {
  private programs?:{trace:WebGLProgram;composite:WebGLProgram;traceUniform:ReturnType<typeof uniforms>;mixUniform:ReturnType<typeof uniforms>};
  private target?:{framebuffer:WebGLFramebuffer;texture:WebGLTexture;width:number;height:number};
  private lastKey?:string;
  private failed=false;

  constructor(private readonly gl:WebGL2RenderingContext){}

  paint(camera:StreetStreamView,lighting:StreetLighting,revision:number,moving:boolean,
    main:WebGLProgram,depth:()=>WebGLTexture|undefined){
    const {contactShadow,sunDirection,sunlight}=lighting;
    if(this.failed||!contactShadow||sunDirection[2]<.06||sunlight[0]<.16)return;
    const {gl}=this,screenWidth=gl.drawingBufferWidth,screenHeight=gl.drawingBufferHeight;
    const divisor=moving?3:2;
    const width=Math.min(960,Math.max(1,Math.floor(screenWidth/divisor)));
    const height=Math.min(540,Math.max(1,Math.floor(screenHeight/divisor)));
    const farPlane=camera.farPlane??streetFarPlane;
    const key=[...camera.eye,camera.yaw,camera.pitch,camera.fov,farPlane,screenWidth,screenHeight,divisor,revision,...sunDirection,...contactShadow].join(",");
    const target=this.allocate(width,height);
    if(!target)return;
    const programs=this.programs??=this.createPrograms();
    if(!programs)return;
    gl.activeTexture(gl.TEXTURE5);
    if(key!==this.lastKey){
      const sceneDepth=depth();
      if(!sceneDepth){gl.activeTexture(gl.TEXTURE1);return;}
      const {yaw,pitch,aspect,fov}=camera;
      const cx=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
      const ahead=sunDirection[0]*cx+sunDirection[1]*sy;
      const projection=streetProjection(fov),location=programs.traceUniform;
      gl.useProgram(programs.trace);
      gl.bindFramebuffer(gl.FRAMEBUFFER,target.framebuffer);
      gl.viewport(0,0,width,height);
      gl.disable(gl.DEPTH_TEST);
      gl.bindVertexArray(null);
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D,sceneDepth);
      gl.uniform1i(location("sceneDepth"),5);
      gl.uniform2f(location("screenSize"),screenWidth,screenHeight);
      gl.uniform2f(location("projection"),projection/aspect,projection);
      gl.uniform3f(location("sun"),sunDirection[0]*sy-sunDirection[1]*cx,
        sunDirection[2]*cp-ahead*sp,ahead*cp+sunDirection[2]*sp);
      gl.uniform2f(location("contact"),...contactShadow);
      gl.uniform1f(location("inverseFarPlane"),1/farPlane);
      gl.drawArrays(gl.TRIANGLES,0,3);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      gl.viewport(0,0,screenWidth,screenHeight);
      this.lastKey=key;
    }
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(programs.composite);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D,target.texture);
    gl.uniform1i(programs.mixUniform("mask"),5);
    gl.uniform2f(programs.mixUniform("maskScale"),width/target.width,height/target.height);
    gl.uniform1f(programs.mixUniform("strength"),.28*Math.min(1,sunlight[0])*(1-.42*lighting.cloudCover));
    gl.drawArrays(gl.TRIANGLES,0,3);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.activeTexture(gl.TEXTURE1);
    gl.useProgram(main);
  }

  private createPrograms(){
    const {gl}=this;
    let traceProgram:WebGLProgram|undefined;
    try{
      traceProgram=makeProgram(gl,vertex,trace);
      const compositeProgram=makeProgram(gl,vertex,composite);
      return {trace:traceProgram,composite:compositeProgram,
        traceUniform:uniforms(gl,traceProgram),mixUniform:uniforms(gl,compositeProgram)};
    }catch{
      gl.deleteProgram(traceProgram??null);
      this.failed=true;
    }
  }

  private allocate(width:number,height:number){
    const {gl}=this,previous=this.target;
    if(previous&&previous.width>=width&&previous.height>=height)return previous;
    width=Math.max(width,previous?.width??0);
    height=Math.max(height,previous?.height??0);
    const texture=gl.createTexture(),framebuffer=gl.createFramebuffer();
    if(texture&&framebuffer){
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texStorage2D(gl.TEXTURE_2D,1,gl.R8,width,height);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
      const complete=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      gl.activeTexture(gl.TEXTURE1);
      if(complete){
        this.releaseTarget();
        return this.target={texture,framebuffer,width,height};
      }
    }
    gl.deleteFramebuffer(framebuffer);gl.deleteTexture(texture);
    this.failed=true;
  }

  private releaseTarget(){
    if(!this.target)return;
    this.gl.deleteFramebuffer(this.target.framebuffer);
    this.gl.deleteTexture(this.target.texture);
    this.target=undefined;
    this.lastKey=undefined;
  }

  dispose(){
    this.releaseTarget();
    if(!this.programs)return;
    this.gl.deleteProgram(this.programs.trace);
    this.gl.deleteProgram(this.programs.composite);
    this.programs=undefined;
  }
}

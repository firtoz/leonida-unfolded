import { streetAmbientOcclusion } from "./street-shadow-constants";
import { streetFarPlane, streetNearPlane } from "./street-grid";
import { streetProjection } from "./street-destination";
import type { StreetLighting } from "./street-lighting";
import type { StreetStreamView } from "./street-priority";
import { rendererReview } from "./street-renderer-review";
import { makeProgram, uniforms } from "./view-gl";

const vertex=`#version 300 es
out vec2 uv;
void main(){
  uv=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));
  gl_Position=vec4(uv*2.0-1.0,0.0,1.0);
}`;
const depthLookup=`
uniform highp sampler2D sceneDepth;
uniform vec2 screenSize;
uniform float inverseFarPlane;
ivec2 depthPixel(vec2 p){
  return ivec2(clamp(p*screenSize,vec2(0.0),screenSize-1.0));
}
float depthAtPixel(ivec2 pixel){
  float raw=texelFetch(sceneDepth,pixel,0).r;
  return ${streetNearPlane}/(1.0-raw+${streetNearPlane}*inverseFarPlane);
}
float depthAt(vec2 p){
  return depthAtPixel(depthPixel(p));
}`;
const trace=`#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform vec2 projection;
uniform vec3 sun;
uniform vec2 contact;
uniform bool ambientEnabled;
${depthLookup}
vec3 position(vec2 p,float z){
  return vec3((p*2.0-1.0)*z/projection,z);
}
vec2 pixelCenter(ivec2 pixel){
  return (vec2(pixel)+.5)/screenSize;
}
vec3 positionAtPixel(ivec2 pixel){
  return position(pixelCenter(pixel),depthAtPixel(pixel));
}
vec3 surfaceNormal(ivec2 pixel,vec3 surface){
  ivec2 last=ivec2(screenSize)-1,dx=ivec2(1,0),dy=ivec2(0,1);
  vec3 left=positionAtPixel(max(pixel-dx,ivec2(0))),right=positionAtPixel(min(pixel+dx,last));
  vec3 down=positionAtPixel(max(pixel-dy,ivec2(0))),up=positionAtPixel(min(pixel+dy,last));
  vec3 tangent=pixel.x>0&&abs(left.z-surface.z)<abs(right.z-surface.z)||pixel.x==last.x?surface-left:right-surface;
  vec3 bitangent=pixel.y>0&&abs(down.z-surface.z)<abs(up.z-surface.z)||pixel.y==last.y?surface-down:up-surface;
  vec3 perpendicular=cross(bitangent,tangent);
  return perpendicular*inversesqrt(max(dot(perpendicular,perpendicular),1e-16));
}
float ambientObscurance(vec2 p,vec3 surface,vec3 normal,float footprint){
  // Short rays keep the effect on local geometry such as curb seams.
  const float reach=${streetAmbientOcclusion.reachMeters};
  vec2 circle=vec2(.92387953,.38268343);
  vec2 radius=min(projection*(.5*reach/surface.z),${streetAmbientOcclusion.maxRadiusPixels}.0/screenSize);
  float amount=0.0;
  for(int direction=0;direction<${streetAmbientOcclusion.directionCount};direction++){
    float horizon=0.0;
    for(int ring=1;ring<=${streetAmbientOcclusion.ringCount};ring++){
      vec2 tap=p+circle*radius*(float(ring)*${streetAmbientOcclusion.ringSpacing});
      if(any(lessThan(tap,vec2(0.0)))||any(greaterThan(tap,vec2(1.0))))continue;
      vec3 delta=positionAtPixel(depthPixel(tap))-surface;
      float range=length(delta);
      float height=dot(delta,normal)-max(${streetAmbientOcclusion.minimumHeightMeters},footprint*${streetAmbientOcclusion.footprintHeightScale});
      horizon=max(horizon,clamp(height/max(range,.05),0.0,1.0)*
        (1.0-smoothstep(.20,reach,range)));
    }
    amount+=horizon;
    circle=mat2(.70710678,.70710678,-.70710678,.70710678)*circle;
  }
  return clamp(amount*${streetAmbientOcclusion.strength},0.0,1.0)*(1.0-smoothstep(${streetAmbientOcclusion.fadeStartMeters}.0,${streetAmbientOcclusion.fadeEndMeters}.0,surface.z));
}
void main(){
  color=vec4(0.0);
  ivec2 pixel=depthPixel(uv);
  float depth=depthAtPixel(pixel);
  if(depth>88.0)return;
  vec2 center=pixelCenter(pixel);
  vec3 surface=position(center,depth);
  vec3 normal=surfaceNormal(pixel,surface);
  float footprint=2.0*depth/max(projection.y*screenSize.y,1.0);
  if(ambientEnabled&&depth<${streetAmbientOcclusion.fadeEndMeters}.0)color.g=ambientObscurance(center,surface,normal,footprint);
  float facing=dot(normal,sun);
  if(facing<.08||contact.x<=0.0)return;
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
uniform vec2 maskScale,maskSize;
uniform float strength,ambientStrength;
${depthLookup}
float ambientAtSurface(){
  float depth=depthAt(uv);
  if(depth>${streetAmbientOcclusion.fadeEndMeters}.0)return 0.0;
  vec2 pixel=uv*maskSize-.5;
  vec2 fraction=fract(pixel);
  ivec2 first=ivec2(floor(pixel));
  float sum=0.0,weight=0.0;
  for(int i=0;i<4;i++){
    ivec2 offset=ivec2(i&1,i>>1);
    ivec2 texel=clamp(first+offset,ivec2(0),ivec2(maskSize)-1);
    vec2 linearWeight=mix(1.0-fraction,fraction,vec2(offset));
    // Do not mix the foreground mask across a depth discontinuity.
    float difference=abs(depthAt((vec2(texel)+.5)/maskSize)-depth);
    float w=linearWeight.x*linearWeight.y*(1.0-smoothstep(.025+depth*.003,.07+depth*.009,difference));
    sum+=w*texelFetch(mask,texel,0).g;
    weight+=w;
  }
  return sum/max(weight,.01);
}
void main(){
  float contact=texture(mask,uv*maskScale).r*strength;
  float ambient=ambientStrength>0.0?ambientAtSurface()*ambientStrength:0.0;
  color=vec4(0.0,0.0,0.0,1.0-(1.0-contact)*(1.0-ambient));
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
    const ambient=rendererReview.ambientOcclusion;
    const contact=contactShadow&&sunDirection[2]>=.06&&sunlight[0]>=.16?contactShadow:[0,0] as const;
    if(this.failed||!ambient&&contact[0]<=0)return;
    const {gl}=this,screenWidth=gl.drawingBufferWidth,screenHeight=gl.drawingBufferHeight;
    const divisor=moving?3:2;
    const width=Math.min(960,Math.max(1,Math.floor(screenWidth/divisor)));
    const height=Math.min(540,Math.max(1,Math.floor(screenHeight/divisor)));
    const farPlane=camera.farPlane??streetFarPlane;
    const key=[...camera.eye,camera.yaw,camera.pitch,camera.aspect,camera.fov,farPlane,screenWidth,screenHeight,divisor,revision,ambient,...sunDirection,...contact].join(",");
    const target=this.allocate(width,height);
    if(!target)return;
    const programs=this.programs??=this.createPrograms();
    if(!programs)return;
    const redraw=key!==this.lastKey;
    const sceneDepth=ambient||redraw?depth():undefined;
    if((ambient||redraw)&&!sceneDepth)return;
    gl.activeTexture(gl.TEXTURE5);
    if(redraw&&sceneDepth){
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
      gl.uniform2f(location("contact"),...contact);
      gl.uniform1i(location("ambientEnabled"),Number(ambient));
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
    const mix=programs.mixUniform;
    gl.uniform1i(mix("mask"),5);
    gl.uniform2f(mix("maskScale"),width/target.width,height/target.height);
    gl.uniform1f(mix("strength"),.28*Math.min(1,sunlight[0])*(1-.42*lighting.cloudCover));
    gl.uniform1f(mix("ambientStrength"),ambient ? .32 : 0);
    gl.uniform1i(mix("sceneDepth"),ambient ? 6 : 5);
    if(ambient&&sceneDepth){
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D,sceneDepth);
      gl.uniform2f(mix("screenSize"),screenWidth,screenHeight);
      gl.uniform2f(mix("maskSize"),width,height);
      gl.uniform1f(mix("inverseFarPlane"),1/farPlane);
    }
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
      gl.texStorage2D(gl.TEXTURE_2D,1,rendererReview.ambientOcclusion?gl.RG8:gl.R8,width,height);
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

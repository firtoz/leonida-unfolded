import type {StreetCloudAssets} from "./street-cloud-assets";
import type {StreetCloudBlend,StreetCloudConfig} from "./street-cloud-config";
import {makeProgram,uniforms} from "./view-gl";

export const streetCloudDensityUnit=23;
export const streetNativeCloudNoiseUnit=24;
const mapSide=256,densitySlices=16,volumeSide=128;

const vertex=`#version 300 es
void main(){
  vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);
  gl_Position=vec4(p*2.0-1.0,0.0,1.0);
}`;

const weatherShader=`#version 300 es
precision highp float;
uniform sampler2D lowerA,lowerB,upperA,upperB,gradient;
uniform vec3 transition;
layout(location=0) out vec4 mapA;
layout(location=1) out vec4 mapB;
void main(){
  vec2 uv=gl_FragCoord.xy/256.0;
  vec2 g=texture(gradient,uv).rg;
  float d=mix(g.r,g.g,clamp(2.0*transition.z,0.0,1.0));
  float width=2.0*transition.y;
  float t=clamp((d+width-(1.0+width)*(1.0-transition.x))/width,0.0,1.0);
  vec3 a=mix(texture(lowerA,uv).rgb,texture(upperA,uv).rgb,t);
  vec2 b=mix(texture(lowerB,uv).rg,texture(upperB,uv).rg,t);
  mapA=vec4(a,b.r);
  mapB=vec4(b.g,0.0,0.0,1.0);
}`;

const densityShader=`#version 300 es
precision highp float;
uniform highp sampler2DArray weatherMap;
uniform sampler2D profiles;
uniform float altitude;
uniform vec2 heightShear;
out vec4 density;
void main(){
  vec2 uv=gl_FragCoord.xy/256.0+altitude*heightShear;
  vec4 a=texture(weatherMap,vec3(uv,0.0));
  float b=texture(weatherMap,vec3(uv,1.0)).r;
  float r=a.r>0.0||a.g>0.0?
    max(texture(profiles,vec2(a.r,altitude)).r,texture(profiles,vec2(a.g,altitude)).g):0.0;
  float g=a.b>0.0?texture(profiles,vec2(a.b,altitude)).b:0.0;
  float x=altitude<0.5?a.a:b;
  float y=x>0.0?texture(profiles,vec2(x,altitude)).a:0.0;
  density=vec4(r,g,altitude<0.5?y:0.0,altitude>=0.5?y:0.0);
}`;

export const nativeCloudVolumeShader=`
#if STREET_NATIVE_CLOUDS
uniform bool hasNativeClouds;
uniform highp sampler3D nativeCloudDensity,nativeCloudNoise;
uniform vec4 nativeCloudShapes[20];
uniform vec3 nativeCloudFrequency;
uniform vec3 nativeCloudWarp;

float nativeCloudVolume(vec3 position,float altitude,bool screenCloud){
  vec4 profiles=textureLod(nativeCloudDensity,vec3(position.xy/32.0+.5,(altitude*16.0+1.0)/18.0),0.0);
  if(all(lessThanEqual(profiles,vec4(0.0))))return 0.0;
  float distanceKm=screenCloud?length(position-cloudObserver):0.0;
  float gate=clamp((distanceKm-nativeCloudWarp.x)*nativeCloudWarp.y,0.0,1.0);
  if(gate>0.0){
    vec4 magnitudes=vec4(nativeCloudShapes[4].w,nativeCloudShapes[9].w,
      nativeCloudShapes[14].w,nativeCloudShapes[19].w);
    float amplitude=gate*dot(profiles,magnitudes)/dot(profiles,vec4(1.0));
    vec2 warp=(textureLod(nativeCloudNoise,position*nativeCloudWarp.z,0.0).rg-.5)*amplitude;
    position+=vec3(warp.x,warp.y,warp.x);
  }
  vec2 n0=2.0*textureLod(nativeCloudNoise,position*nativeCloudFrequency.x,0.0).rg-1.0;
  vec2 n1=2.0*textureLod(nativeCloudNoise,position*nativeCloudFrequency.y,0.0).rg-1.0;
  vec2 n2=distanceKm<10.0?2.0*textureLod(nativeCloudNoise,position*nativeCloudFrequency.z,0.0).rg-1.0:vec2(0.0);
  vec3 red=vec3(n0.r,n1.r,n2.r),green=vec3(n0.g,n1.g,n2.g);
  float density=0.0;
  for(int i=0;i<4;i++){
    float p=clamp(32.0*altitude,0.0,1.0)*profiles[i];
    if(p<=0.0)continue;
    int shape=i*5;
    vec4 r=nativeCloudShapes[shape+2],g=nativeCloudShapes[shape+3],gate=nativeCloudShapes[shape+4];
    vec4 w=mix(nativeCloudShapes[shape],nativeCloudShapes[shape+1],clamp(altitude*gate.z+gate.y,0.0,1.0));
    vec3 bands=red*r.xyz+green*g.xyz;
    float raw=max(0.0,w.w*clamp(gate.x*p,0.0,1.0)*(dot(w.xyz,bands)+mix(r.w,g.w,p)));
    density=max(density,raw*mix(.15,1.0,clamp(1.25*abs(p-raw)-.25,0.0,1.0)));
  }
  return min(density,1.0);
}
#endif
`;

type Program={object:WebGLProgram;uniform:ReturnType<typeof uniforms>};

export class StreetNativeClouds{
  private readonly maps=new Map<string,WebGLTexture>();
  private programs:Program[]=[];
  private weather?:WebGLTexture;
  private density?:WebGLTexture;
  private noise?:WebGLTexture;
  private framebuffer?:WebGLFramebuffer;
  private lastBlend?:StreetCloudBlend;
  private failed=false;
  readonly supported:boolean;

  constructor(private readonly gl:WebGL2RenderingContext){
    this.supported=gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)>streetNativeCloudNoiseUnit&&
      gl.getParameter(gl.MAX_3D_TEXTURE_SIZE)>=volumeSide&&Boolean(gl.getExtension("EXT_texture_compression_bptc"))&&
      Boolean(gl.getExtension("EXT_texture_compression_rgtc"));
  }

  upload(assets:StreetCloudAssets){
    if(!this.supported||this.failed||this.noise)return false;
    const {gl}=this;
    gl.activeTexture(gl.TEXTURE0+streetNativeCloudNoiseUnit);
    try{
      for(const {name,width,height,format,bytes} of assets.maps){
        const texture=this.createTexture(gl.TEXTURE_2D,name==="cloud_map_lut"||name==="weather_gradient"?gl.CLAMP_TO_EDGE:gl.REPEAT);
        this.maps.set(name,texture);
        if(format===71)gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
        else{
          const compressed=format===98?gl.getExtension("EXT_texture_compression_bptc")!.COMPRESSED_RGBA_BPTC_UNORM_EXT:
            gl.getExtension("EXT_texture_compression_rgtc")!.COMPRESSED_RED_GREEN_RGTC2_EXT;
          gl.compressedTexImage2D(gl.TEXTURE_2D,0,compressed,width,height,0,bytes);
        }
      }
      this.noise=this.createTexture(gl.TEXTURE_3D,gl.REPEAT);
      gl.texImage3D(gl.TEXTURE_3D,0,gl.RG8,volumeSide,volumeSide,volumeSide,0,gl.RG,gl.UNSIGNED_BYTE,assets.noise);
      this.weather=this.createTexture(gl.TEXTURE_2D_ARRAY,gl.REPEAT);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY,1,gl.RGBA8,mapSide,mapSide,2);
      this.density=this.createTexture(gl.TEXTURE_3D,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_S,gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_T,gl.REPEAT);
      gl.texStorage3D(gl.TEXTURE_3D,1,gl.RGBA8,mapSide,mapSide,densitySlices+2);
      this.framebuffer=gl.createFramebuffer()??undefined;
      if(!this.framebuffer)throw Error("Could not create a cloud framebuffer");
      for(const fragment of [weatherShader,densityShader]){
        const object=makeProgram(gl,vertex,fragment);
        this.programs.push({object,uniform:uniforms(gl,object)});
      }
      return true;
    }catch{
      this.dispose();
      this.failed=true;
      return false;
    }finally{gl.activeTexture(gl.TEXTURE0);}
  }

  private createTexture(target:number,wrap:number){
    const {gl}=this,texture=gl.createTexture();
    if(!texture)throw Error("Could not create a cloud texture");
    gl.bindTexture(target,texture);
    gl.texParameteri(target,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(target,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(target,gl.TEXTURE_WRAP_S,wrap);
    gl.texParameteri(target,gl.TEXTURE_WRAP_T,wrap);
    if(target===gl.TEXTURE_3D)gl.texParameteri(target,gl.TEXTURE_WRAP_R,wrap);
    return texture;
  }

  // Called before the scene sets its framebuffer, viewport, program and VAO.
  prepare(config:StreetCloudConfig|undefined,blend:StreetCloudBlend|undefined){
    if(!config||!blend||!this.framebuffer||this.failed)return false;
    const old=this.lastBlend;
    if(old?.lower===blend.lower&&old.upper===blend.upper&&old.progress===blend.progress&&
      old.shear[0]===blend.shear[0]&&old.shear[1]===blend.shear[1])return true;
    const sources=[...blend.lower,...blend.upper,"weather_gradient","cloud_map_lut"].map(name=>this.maps.get(name));
    if(sources.some(texture=>!texture))return false;
    const {gl}=this;
    const depth=gl.isEnabled(gl.DEPTH_TEST),alpha=gl.isEnabled(gl.BLEND);
    const bindings=sources.slice(0,5).map((_,index)=>{
      gl.activeTexture(gl.TEXTURE0+index);
      return gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture|null;
    });
    const reserved=streetCloudDensityUnit;
    gl.activeTexture(gl.TEXTURE0+reserved);
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.framebuffer);
    gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.viewport(0,0,mapSide,mapSide);
    try{
      const [map,density]=this.programs;
      gl.useProgram(map.object);
      for(const [i,name] of ["lowerA","lowerB","upperA","upperB","gradient"].entries()){
        gl.activeTexture(gl.TEXTURE0+i);
        gl.bindTexture(gl.TEXTURE_2D,sources[i]!);
        gl.uniform1i(map.uniform(name),i);
      }
      gl.uniform3f(map.uniform("transition"),blend.progress,config.tightness,config.direction);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,this.weather!,0,0);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT1,this.weather!,0,1);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0,gl.COLOR_ATTACHMENT1]);
      if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error("Weather map framebuffer incomplete");
      gl.drawArrays(gl.TRIANGLES,0,3);

      gl.useProgram(density.object);
      gl.activeTexture(gl.TEXTURE0+reserved);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY,this.weather!);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D,sources[5]!);
      gl.uniform1i(density.uniform("weatherMap"),reserved);
      gl.uniform1i(density.uniform("profiles"),0);
      gl.uniform2f(density.uniform("heightShear"),...blend.shear);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT1,null,0,0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      const altitude=density.uniform("altitude");
      for(let slice=0;slice<densitySlices;slice++){
        gl.framebufferTextureLayer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,this.density!,0,slice+1);
        gl.uniform1f(altitude,(slice+.5)/densitySlices);
        gl.drawArrays(gl.TRIANGLES,0,3);
      }
      this.lastBlend=blend;
      return true;
    }catch{
      this.failed=true;
      return false;
    }finally{
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      for(const [index,binding] of bindings.entries()){
        gl.activeTexture(gl.TEXTURE0+index);
        gl.bindTexture(gl.TEXTURE_2D,binding);
      }
      if(depth)gl.enable(gl.DEPTH_TEST);
      if(alpha)gl.enable(gl.BLEND);
      gl.activeTexture(gl.TEXTURE0);
    }
  }

  bind(){
    const {gl}=this;
    gl.activeTexture(gl.TEXTURE0+streetCloudDensityUnit);
    gl.bindTexture(gl.TEXTURE_3D,this.density!);
    gl.activeTexture(gl.TEXTURE0+streetNativeCloudNoiseUnit);
    gl.bindTexture(gl.TEXTURE_3D,this.noise!);
    gl.activeTexture(gl.TEXTURE0);
  }

  dispose(){
    const {gl}=this;
    for(const program of this.programs)gl.deleteProgram(program.object);
    for(const texture of this.maps.values())gl.deleteTexture(texture);
    this.maps.clear();
    for(const texture of [this.weather,this.density,this.noise])gl.deleteTexture(texture??null);
    gl.deleteFramebuffer(this.framebuffer??null);
  }
}

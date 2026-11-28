import { MapDepth, type ProjectedAnchor } from "./map-depth";
import { CELL, type Rect } from "./recover";
import { ocean, type NativeScene } from "./native-map";
import { NativeView } from "./native-view";
import { makeProgram, overlaySampling, projection, setCamera, uniforms, type Camera } from "./view-gl";
import type { MapRay } from "./walk-surface";

type Point = readonly [number, number];
export type TerrainSource = {image:ImageBitmap; rect:Rect; elevation:Uint16Array<ArrayBuffer>};

const waterline=27988;
// Fit against sector height bounds, converted from world units to board cells.
const heightScale=.010733639/CELL;
const radians=Math.PI/180;

const vertex=`#version 300 es
precision highp float;
precision highp usampler2D;
uniform usampler2D heights;
uniform ivec2 grid;
uniform vec4 bounds;
${projection}
uniform vec2 elevationScale;
out vec2 uv;
out vec2 worldXY;
out vec3 surfaceNormal;

float landHeight(ivec2 pixel, ivec2 edge) {
  float z=float(texelFetch(heights,clamp(pixel,ivec2(0),edge),0).r);
  return max(0.0,z-elevationScale.x)*elevationScale.y;
}

void main() {
  uv=vec2(gl_VertexID % grid.x, gl_VertexID / grid.x)/vec2(grid-1);
  vec2 span=vec2(textureSize(heights,0)-1);
  vec2 pixel=clamp(uv*(span+1.0)-0.5,vec2(0.0),span);
  ivec2 p=ivec2(pixel), q=min(p+1,ivec2(span));
  vec2 f=fract(pixel);
  float north=mix(float(texelFetch(heights,p,0).r),float(texelFetch(heights,ivec2(q.x,p.y),0).r),f.x);
  float south=mix(float(texelFetch(heights,ivec2(p.x,q.y),0).r),float(texelFetch(heights,q,0).r),f.x);
  float z=max(0.0,mix(north,south,f.y)-elevationScale.x)*elevationScale.y;
  ivec2 mid=ivec2(pixel+0.5),edge=ivec2(span);
  ivec2 stepSize=max(ivec2(round(span/vec2(grid-1))),ivec2(1));
  ivec2 east=ivec2(stepSize.x,0),southward=ivec2(0,stepSize.y);
  float eastRise=landHeight(mid+east,edge)-landHeight(mid-east,edge);
  float southRise=landHeight(mid+southward,edge)-landHeight(mid-southward,edge);
  vec2 slope=vec2(eastRise,southRise)*span/(2.0*vec2(stepSize)*bounds.zw);
  surfaceNormal=vec3(-slope,1.0);
  worldXY=bounds.xy+uv*bounds.zw;
  gl_Position=projectMap(vec3(worldXY,z));
}`;

const fragment=`#version 300 es
precision highp float;
precision highp usampler2D;
uniform usampler2D heights;
uniform float shadeTerrain;
${overlaySampling}
uniform bool waterEffects;
uniform float waterLevel;
in vec2 uv;
in vec2 worldXY;
in vec3 surfaceNormal;
out vec4 color;

void main() {
  vec4 overlay=mapSample(worldXY);
  if(overlay.a==0.0){color=vec4(0.0);return;}
  vec3 base=overlay.rgb;
  float sampleHeight=float(texture(heights,uv).r);
  if (waterEffects && sampleHeight<waterLevel) {
    // Wide world-space ripples stay legible in the raised overview.
    float depth=waterLevel-sampleHeight;
    float edge=1.0-smoothstep(20.0,520.0,depth);
    float ripple=sin(dot(worldXY,vec2(0.31,0.17))+0.6*sin(worldXY.y*0.43));
    float band=smoothstep(0.45,0.96,ripple);
    vec3 shallow=vec3(0.35,0.66,0.68);
    vec3 deep=vec3(0.06,0.24,0.34);
    vec3 tint=mix(deep,shallow,edge);
    base=mix(base,tint,0.16+0.12*edge);
    base=mix(base,vec3(0.69,0.83,0.83),band*(0.045+0.055*edge));
  }
  vec3 normal=normalize(surfaceNormal);
  float shade=0.93+0.14*dot(normal,normalize(vec3(-0.6,-0.4,1.0)));
  color=vec4(base*mix(1.0,shade,shadeTerrain),overlay.a);
}`;

export class TerrainView {
  private readonly gl:WebGL2RenderingContext;
  private readonly program:WebGLProgram;
  private readonly uniform:ReturnType<typeof uniforms>;
  private readonly indices:WebGLBuffer;
  private readonly mesh:WebGLVertexArrayObject;
  private readonly textures:WebGLTexture[]=[];
  private readonly count:number;
  private readonly patches:{first:number;count:number;rect:Rect}[]=[];
  private readonly resize:ResizeObserver;
  private frame=0;
  center:Point=[0,0];
  scale=1;
  angle=0;
  private native:NativeView|null=null;
  showNative=false;
  tilt=0;
  raised=false;
  relief=3;
  waterEffects=true;

  afterPaint:()=>void=()=>{};
  sceneRevision=0;
  private source:TerrainSource|null=null;
  private readonly depth:MapDepth;
  private readonly elevationTexture:WebGLTexture;
  private readonly roadTexture:WebGLTexture;
  private roadRect:Rect=[0,0,0,0];
  roadOpacity=0;
  private readonly depthCache=new Map<string,boolean>();
  private readonly overlayTexture:WebGLTexture;

  constructor(readonly canvas:HTMLCanvasElement,private readonly rect:Rect,
    private readonly project:(rect:Rect,density:number,scale:number)=>HTMLCanvasElement|null){
    const gl=canvas.getContext("webgl2",{alpha:false,antialias:false});
    if(!gl||gl.isContextLost())throw new Error("WebGL 2 is unavailable in this browser.");
    this.gl=gl;
    this.program=makeProgram(gl,vertex,fragment);
    this.uniform=uniforms(gl,this.program);
    gl.useProgram(this.program);
    const [, ,width,height]=rect;
    const columns=Math.round(width*2)+1,rows=Math.round(height*2)+1;
    const triangles=new Uint32Array((columns-1)*(rows-1)*6);
    const chunk=8;
    const stepX=width/(columns-1),stepY=height/(rows-1);
    let i=0;
    for(let py=0;py<rows-1;py+=chunk)for(let px=0;px<columns-1;px+=chunk){
      const right=Math.min(columns-1,px+chunk),bottom=Math.min(rows-1,py+chunk);
      const first=i;
      for(let y=py;y<bottom;y++)for(let x=px;x<right;x++){
        const a=y*columns+x,b=a+columns;
        triangles.set([a,b,a+1,a+1,b,b+1],i);
        i+=6;
      }
      this.patches.push({first,count:i-first,
        rect:[rect[0]+px*stepX,rect[1]+py*stepY,(right-px)*stepX,(bottom-py)*stepY]});
    }
    this.count=triangles.length;
    this.mesh=gl.createVertexArray();
    this.indices=gl.createBuffer();
    gl.bindVertexArray(this.mesh);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,triangles,gl.STATIC_DRAW);
    this.elevationTexture=this.texture(0,gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.R16UI,1,1,0,gl.RED_INTEGER,gl.UNSIGNED_SHORT,new Uint16Array(1));
    this.roadTexture=this.texture(2,gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4));
    this.depth=new MapDepth(gl);
    this.overlayTexture=this.texture(1,gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4));
    gl.uniform1i(this.uniform("heights"),0);
    gl.uniform1i(this.uniform("mapColor"),1);
    gl.uniform2i(this.uniform("grid"),columns,rows);
    gl.uniform4f(this.uniform("bounds"),...rect);
    gl.uniform1f(this.uniform("waterLevel"),waterline);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.09,0.067,0.137,1);
    this.resize=new ResizeObserver(()=>this.draw());
    this.resize.observe(canvas);
  }

  installRoads(image:ImageBitmap,rect:Rect){
    this.roadRect=rect;
    const {gl}=this;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D,this.roadTexture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE,image);
    this.draw();
  }

  installHeight(source:TerrainSource){
    this.sceneRevision++;
    this.source=source;
    const {gl}=this,{image,elevation}=source;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D,this.elevationTexture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.R16UI,image.width,image.height,0,gl.RED_INTEGER,gl.UNSIGNED_SHORT,elevation);
    this.draw();
  }

  installNative(scene:NativeScene){
    this.sceneRevision++;
    const next=new NativeView(this.gl,scene);
    this.native?.dispose();
    this.native=next;
    this.draw();
  }

  updateNativeColors(scene:NativeScene){this.native?.updateVertexColors(scene.vertices);}

  private texture(unit:number,filter:number){
    const {gl}=this;
    const texture=gl.createTexture();
    this.textures.push(texture);
    gl.activeTexture(gl.TEXTURE0+unit);
    gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    return texture;
  }

  open(center:Point,scale:number){
    this.center=center;
    this.scale=Math.min(4096,scale);
    this.draw();
  }

  private heightAt([x,y]:Point){
    if(!this.raised||!this.source)return 0;
    const {rect,elevation,image}=this.source;
    const u=Math.floor((x-rect[0])/rect[2]*image.width);
    const v=Math.floor((y-rect[1])/rect[3]*image.height);
    if(u<0||u>=image.width||v<0||v>=image.height)return 0;
    return Math.max(0,elevation[v*image.width+u]-waterline)*heightScale*this.relief;
  }

  private focalLength(){return this.canvas.clientHeight*1.12;}

  // Intersect the cursor ray with the ground plane through the camera target.
  private ground(x:number,y:number,z=this.heightAt(this.center)):Point|null{
    const px=x-this.canvas.clientWidth/2,py=y-this.canvas.clientHeight/2;
    const focal=this.focalLength(),pitch=this.tilt*radians;
    const sin=Math.sin(pitch),cos=Math.cos(pitch);
    const denominator=focal*cos+py*sin;
    if(denominator<focal*.008)return null;
    const distance=focal/this.scale;
    const rise=z-this.heightAt(this.center);
    const v=(py*(distance-rise*cos)+focal*rise*sin)/denominator;
    const forward=distance-v*sin-rise*cos;
    if(forward<=0)return null;
    const u=px*forward/focal;
    return [u*Math.cos(this.angle)+v*Math.sin(this.angle),v*Math.cos(this.angle)-u*Math.sin(this.angle)];
  }

  mapPoint(x:number,y:number){
    const base=this.ground(x,y);
    if(!base)return null;
    let target:Point=[this.center[0]+base[0],this.center[1]+base[1]];
    if(this.raised){
      const corrected=this.ground(x,y,this.heightAt(target));
      if(corrected)target=[this.center[0]+corrected[0],this.center[1]+corrected[1]];
    }
    return target;
  }

  walkRay(x:number,y:number):MapRay|null{
    if(!this.raised){
      const point=this.mapPoint(x,y);
      return point?{origin:[...point,1000],direction:[0,0,-1],minimum:0}:null;
    }
    const focal=this.focalLength(),distance=focal/this.scale;
    const px=(x-this.canvas.clientWidth/2)/focal,py=(y-this.canvas.clientHeight/2)/focal;
    const pitch=this.tilt*radians,sin=Math.sin(pitch),cos=Math.cos(pitch);
    const east=Math.cos(this.angle),south=Math.sin(this.angle);
    const along=py*cos-sin,originV=sin*distance;
    return {
      origin:[this.center[0]+originV*south,this.center[1]+originV*east,
        (this.heightAt(this.center)+cos*distance)/this.relief],
      direction:[px*east+along*south,along*east-px*south,(-cos-py*sin)/this.relief],
      minimum:Math.max(.08,distance*.08),
    };
  }

  screenPoint(point:Point):Point|null {
    const projected=this.projectAnchor(point);
    return projected?[projected.x,projected.y]:null;
  }

  projectAnchor(point:Point,elevation?:number,label=false):ProjectedAnchor|null{
    return this.anchorProjection(label)(point,elevation);
  }

  anchorProjection(label=false){
    const [cx,cy]=this.center,width=this.canvas.clientWidth,height=this.canvas.clientHeight;
    const sin=Math.sin(this.angle),cos=Math.cos(this.angle),pitch=this.tilt*radians;
    const pitchSin=Math.sin(pitch),pitchCos=Math.cos(pitch);
    const focal=height*1.12,distance=focal/this.scale,near=Math.max(.08,distance*.08);
    const focus=this.heightAt([cx,cy]),relief=this.raised?this.relief/CELL:0;
    return ([x,y]:Point,elevation?:number):ProjectedAnchor|null=>{
      const dx=x-cx,dy=y-cy,u=dx*cos-dy*sin,v=dx*sin+dy*cos;
      const land=elevation===undefined?this.heightAt([x,y]):elevation*relief;
      const lift=label?(elevation===undefined?3:1.2)*relief:0;
      const rise=land+lift-focus,forward=distance-v*pitchSin-rise*pitchCos;
      if(forward<=near)return null;
      return {
        x:width/2+u*focal/forward,
        y:height/2+(v*pitchCos-rise*pitchSin)*focal/forward,
        depth:label&&elevation===undefined&&!this.source?-1:1+near/8192-near/forward,
      };
    };
  }

  visibleAnchors(points:ProjectedAnchor[]){
    if(!this.raised)return points.map(()=>true);
    const needed=new Map<string,ProjectedAnchor>();
    const key=({x,y,depth}:ProjectedAnchor)=>`${x},${y},${depth}`;
    for(const point of points){
      const id=key(point);
      if(!this.depthCache.has(id))needed.set(id,point);
    }
    if(needed.size){
      const {clientWidth:w,clientHeight:h}=this.canvas;
      const values=new Float32Array(needed.size*3);
      let offset=0;
      for(const {x,y,depth} of needed.values()){
        values.set([x/w,1-y/h,depth],offset);
        offset+=3;
      }
      const results=this.depth.visible(values);
      let i=0;
      for(const id of needed.keys())this.depthCache.set(id,results[i++*4]!==0);
    }
    return points.map(point=>this.depthCache.get(key(point))===true);
  }

  private uploadOverlay():Rect{
    const cw=this.canvas.clientWidth,ch=this.canvas.clientHeight;
    const points:Point[]=[];
    for(const y of [0,ch/2,ch])for(const x of [0,cw/2,cw]){
      for(const z of [0,this.raised?4*this.relief:0]){
        const p=this.ground(x,y,z);
        if(p)points.push([p[0]+this.center[0],p[1]+this.center[1]]);
      }
    }
    if(!points.length)return [0,0,0,0];
    const [left,top,w,h]=this.rect;
    const x=Math.max(left,Math.floor(Math.min(...points.map(p=>p[0])))-1);
    const y=Math.max(top,Math.floor(Math.min(...points.map(p=>p[1])))-1);
    const endX=Math.min(left+w,Math.ceil(Math.max(...points.map(p=>p[0])))+1);
    const endY=Math.min(top+h,Math.ceil(Math.max(...points.map(p=>p[1])))+1);
    if(endX<=x||endY<=y)return [0,0,0,0];
    const density=Math.min(this.scale*Math.min(2,devicePixelRatio||1),1800/Math.max(endX-x,endY-y));
    const raster=this.project([x,y,endX-x,endY-y],density,this.scale);
    if(!raster)return [0,0,0,0];
    const {gl}=this;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D,this.overlayTexture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE,raster);
    return [x,y,raster.width/density,raster.height/density];
  }

  color(x:number,y:number):[number,number,number]{
    this.paint();
    const {gl,canvas}=this,pixel=new Uint8Array(4);
    gl.readPixels(Math.floor(x*canvas.width/canvas.clientWidth),
      canvas.height-1-Math.floor(y*canvas.height/canvas.clientHeight),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
    return [pixel[0],pixel[1],pixel[2]];
  }

  pan(oldX:number,oldY:number,x:number,y:number){
    const start=this.ground(oldX,oldY),end=this.ground(x,y);
    if(start&&end)this.center=[this.center[0]+start[0]-end[0],this.center[1]+start[1]-end[1]];
    this.draw();
  }

  rotate(dx:number,dy:number){
    this.angle-=dx*.006;
    this.tilt=Math.min(65,Math.max(0,this.tilt-dy*.25));
    this.draw();
  }

  zoom(factor:number,x:number,y:number){
    const start=this.ground(x,y);
    this.scale=Math.min(4096,Math.max(.3,this.scale*factor));
    const end=this.ground(x,y);
    if(start&&end)this.center=[this.center[0]+start[0]-end[0],this.center[1]+start[1]-end[1]];
    this.draw();
  }

  cancelDraw(){
    cancelAnimationFrame(this.frame);
    this.frame=0;
  }

  draw(){
    if(document.hidden)return;
    if(!this.frame)this.frame=requestAnimationFrame(()=>{
      this.frame=0;
      this.paint();
    });
  }
  private drawOverlay([x,y,w,h]:Rect){
    const {gl}=this;
    if(w*h>=this.rect[2]*this.rect[3]*.4){
      gl.drawElements(gl.TRIANGLES,this.count,gl.UNSIGNED_INT,0);
      return;
    }
    let first=0,count=0;
    for(const patch of this.patches){
      const [px,py,pw,ph]=patch.rect;
      if(px>=x+w||py>=y+h||px+pw<=x||py+ph<=y)continue;
      if(first+count!==patch.first){
        if(count)gl.drawElements(gl.TRIANGLES,count,gl.UNSIGNED_INT,first*4);
        first=patch.first;count=0;
      }
      count+=patch.count;
    }
    if(count)gl.drawElements(gl.TRIANGLES,count,gl.UNSIGNED_INT,first*4);
  }

  private paint(){
    if(this.canvas.hidden)return;
    const {gl,canvas}=this;
    const width=canvas.clientWidth,height=canvas.clientHeight;
    if(!width||!height||gl.isContextLost())return;
    const ratio=Math.min(2,devicePixelRatio||1);
    const w=Math.round(width*ratio),h=Math.round(height*ratio);
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
    this.depthCache.clear();
    this.depth.begin(w,h);
    gl.viewport(0,0,w,h);
    const native=this.showNative?this.native:null;
    if(native)gl.clearColor(ocean[0]/255,ocean[1]/255,ocean[2]/255,1);
    else gl.clearColor(0.09,0.067,0.137,1);
    gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    const focal=this.focalLength(),pitch=this.tilt*radians;
    const camera:Camera={
      center:this.center,rotation:[Math.cos(this.angle),Math.sin(this.angle)],
      tilt:[Math.cos(pitch),Math.sin(pitch)],focal:[2*focal/width,2*focal/height],
      distance:focal/this.scale,focus:this.heightAt(this.center),relief:this.raised?this.relief:0,
    };
    const overlay=this.uploadOverlay();
    gl.useProgram(this.program);
    gl.bindVertexArray(this.mesh);
    setCamera(gl,this.uniform,camera);
    gl.uniform2f(this.uniform("elevationScale"),waterline,heightScale*camera.relief);
    gl.uniform4f(this.uniform("overlayRect"),...overlay);
    gl.uniform1f(this.uniform("shadeTerrain"),Number(this.raised&&this.source!==null));
    gl.uniform1i(this.uniform("waterEffects"),Number(!native&&this.raised&&this.source!==null&&this.waterEffects));
    if(overlay[2]>0){
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
      this.drawOverlay(overlay);
      gl.disable(gl.BLEND);
    }
    if(native){
      gl.clear(gl.DEPTH_BUFFER_BIT);
      native.paint(camera,overlay,this.roadRect,this.roadOpacity);
    }
    this.depth.present();
    this.afterPaint();
  }

  dispose(){
    this.cancelDraw();
    this.resize.disconnect();
    this.native?.dispose();
    this.depth.dispose();
    for(const texture of this.textures)this.gl.deleteTexture(texture);
    this.gl.deleteBuffer(this.indices);
    this.gl.deleteVertexArray(this.mesh);
    this.gl.deleteProgram(this.program);
  }
}

import { pauseMapVertexLayout } from "./pause-map-constants";
import type { Rect } from "./recover";
import type { NativeScene } from "./native-map";
import type { Bounds, NativeTile } from "./native-spatial";
import { makeProgram, overlaySampling, projection, setCamera, uniforms, type Camera } from "./view-gl";

const vertex=`#version 300 es
precision highp float;
layout(location=0) in vec3 world;
layout(location=1) in vec4 tint;
uniform float relief;
${projection}
out vec3 location;
out vec3 rgb;
flat out int surface;
void main(){
  location=vec3(world.xy,world.z*relief);
  rgb=tint.rgb;
  surface=int(round(tint.a*255.0));
  gl_Position=projectMap(location);
  // Keep authored coplanar terrain, decks and markings in a stable order.
  float offset=surface==4?0.000003:surface==3?0.000002:surface==2?0.000001:0.0;
  gl_Position.z-=offset*gl_Position.w;
  if(relief==0.0)gl_Position.z-=clamp(world.z,-4.0,4.0)*0.0002*gl_Position.w;
}
`;
const fragment=`#version 300 es
precision highp float;
in vec3 location;
in vec3 rgb;
flat in int surface;
uniform sampler2D roadMask;
uniform vec4 roadRect;
uniform float roadOpacity;
out vec4 color;
${overlaySampling}
void main(){
  vec3 normal=normalize(cross(dFdx(location),dFdy(location)));
  // Vertical faces can have either sign of Z after interpolation and rounding.
  // Use orientation-independent lighting there and orient upward only on slopes.
  float up=abs(normal.z);
  float sun=dot(normal.xy,vec2(0.72,0.57));
  float direction=mix(abs(sun),sun*sign(normal.z),smoothstep(0.025,0.15,up));
  float shade=1.0-0.18*(1.0-up)+0.10*direction;
  vec3 base=rgb*mix(1.0,shade,float(surface!=0));
  if(surface<=1){
    vec4 overlay=mapSample(location.xy);
    base=mix(base,overlay.rgb,overlay.a);
  }
  if(surface==1&&roadOpacity>0.0&&roadRect.z>0.0){
    vec2 uv=(location.xy-roadRect.xy)/roadRect.zw;
    if(all(greaterThanEqual(uv,vec2(0.0)))&&all(lessThanEqual(uv,vec2(1.0)))){
      vec4 road=texture(roadMask,uv);
      base=mix(base,road.rgb,road.a*roadOpacity);
    }
  }
  color=vec4(base,1.0);
}
`;

type Plane = [number,number,number,number];

function frustum(camera:Camera):Plane[]{
  const [cx,cy]=camera.center,[cos,sin]=camera.rotation,[ct,st]=camera.tilt,[fx,fy]=camera.focal;
  const forward:Plane=[-sin*st,-cos*st,-camera.relief*ct,camera.distance+camera.focus*ct];
  const horizontal:Plane=[cos*fx,-sin*fx,0,0];
  const vertical:Plane=[-sin*ct*fy,-cos*ct*fy,camera.relief*st*fy,-camera.focus*st*fy];
  const plane=(other:Plane,direction:number):Plane=>{
    const [a,b,c,d]=forward.map((value,i)=>value+direction*other[i]);
    return [a,b,c,d-a*cx-b*cy];
  };
  const near=Math.max(.08,camera.distance*.08);
  return [plane(horizontal,1),plane(horizontal,-1),plane(vertical,1),plane(vertical,-1),plane([0,0,0,near],-1)];
}

function classify(bounds:Bounds,planes:Plane[]){
  let fullyVisible=true;
  const [x0,y0,z0,x1,y1,z1]=bounds;
  for(const [a,b,c,d] of planes){
    const far=a*(a>=0?x1:x0)+b*(b>=0?y1:y0)+c*(c>=0?z1:z0)+d;
    if(far<-.0001)return -1;
    const near=a*(a>=0?x0:x1)+b*(b>=0?y0:y1)+c*(c>=0?z0:z1)+d;
    if(near<-.0001)fullyVisible=false;
  }
  return fullyVisible?1:0;
}

export class NativeView {
  private readonly program:WebGLProgram;
  private readonly vao:WebGLVertexArrayObject;
  private readonly vertices:WebGLBuffer;
  private readonly indices:WebGLBuffer;
  private readonly uniform:ReturnType<typeof uniforms>;
  private readonly tiles:NativeTile[];

  constructor(private readonly gl:WebGL2RenderingContext,scene:NativeScene){
    this.program=makeProgram(gl,vertex,fragment);
    this.uniform=uniforms(gl,this.program);
    this.tiles=scene.tiles;
    this.vao=gl.createVertexArray();
    this.vertices=gl.createBuffer();
    this.indices=gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.vertices);
    gl.bufferData(gl.ARRAY_BUFFER,scene.vertices,gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0,3,gl.FLOAT,false,pauseMapVertexLayout.strideBytes,0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1,4,gl.UNSIGNED_BYTE,true,pauseMapVertexLayout.strideBytes,pauseMapVertexLayout.colorOffsetBytes);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,scene.indices,gl.STATIC_DRAW);
  }

  updateVertexColors(vertices:ArrayBuffer){
    const {gl}=this;
    gl.bindBuffer(gl.ARRAY_BUFFER,this.vertices);
    gl.bufferSubData(gl.ARRAY_BUFFER,0,vertices);
  }

  paint(camera:Camera,bounds:Rect,roadRect:Rect,roadOpacity:number){
    const {gl}=this;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    setCamera(gl,this.uniform,camera);
    gl.uniform1f(this.uniform("relief"),camera.relief);
    gl.uniform1i(this.uniform("mapColor"),1);
    gl.uniform1i(this.uniform("roadMask"),2);
    gl.uniform4f(this.uniform("roadRect"),...roadRect);
    gl.uniform1f(this.uniform("roadOpacity"),roadOpacity/100);
    gl.uniform4f(this.uniform("overlayRect"),...bounds);
    const planes=frustum(camera);
    // Overview frames keep one draw per tile. At street level, check the tighter
    // meshlet groups in tiles that cross a frustum plane.
    const fineCulling=camera.distance<24;
    for(const tile of this.tiles){
      const visibility=classify(tile.bounds,planes);
      if(visibility<0)continue;
      if(visibility>0||!fineCulling||tile.chunks.length===1){
        gl.drawElements(gl.TRIANGLES,tile.count,gl.UNSIGNED_INT,tile.first*4);
        continue;
      }
      let first=0,count=0;
      for(const range of tile.chunks){
        if(classify(range.bounds,planes)<0)continue;
        if(first+count!==range.first){
          if(count)gl.drawElements(gl.TRIANGLES,count,gl.UNSIGNED_INT,first*4);
          first=range.first;count=0;
        }
        count+=range.count;
      }
      if(count)gl.drawElements(gl.TRIANGLES,count,gl.UNSIGNED_INT,first*4);
    }
  }

  dispose(){
    const {gl}=this;
    gl.deleteBuffer(this.vertices);
    gl.deleteBuffer(this.indices);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}

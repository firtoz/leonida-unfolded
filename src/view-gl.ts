export type Camera = {
  center:readonly [number,number];
  rotation:readonly [number,number];
  tilt:readonly [number,number];
  focal:readonly [number,number];
  distance:number;
  focus:number;
  relief:number;
};
export const projection=`
uniform vec2 center;
uniform vec2 rotation;
uniform vec2 tilt;
uniform vec2 focal;
uniform float distanceToGround;
uniform float focusHeight;

vec4 projectMap(vec3 world) {
  vec2 offset=world.xy-center;
  vec2 plane=vec2(dot(offset,vec2(rotation.x,-rotation.y)),dot(offset,rotation.yx));
  float height=world.z-focusHeight;
  float forward=distanceToGround-plane.y*tilt.y-height*tilt.x;
  float up=-plane.y*tilt.x+height*tilt.y;
  float nearPlane=max(0.08,distanceToGround*0.08);
  return vec4(plane.x*focal.x,up*focal.y,forward*(1.0+nearPlane/4096.0)-2.0*nearPlane,forward);
}
`;

export const overlaySampling=`
uniform sampler2D mapColor;
uniform vec4 overlayRect;
vec4 mapSample(vec2 world) {
  if(overlayRect.z<=0.0) return vec4(0.0);
  vec2 uv=(world-overlayRect.xy)/overlayRect.zw;
  if(any(lessThan(uv,vec2(0.0)))||any(greaterThan(uv,vec2(1.0)))) return vec4(0.0);
  return texture(mapColor,uv);
}
`;

export function makeProgram(gl:WebGL2RenderingContext,vertex:string,fragment:string){
  const program=gl.createProgram();
  for(const [type,source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]] as const){
    const shader=gl.createShader(type);
    if(!shader){gl.deleteProgram(program);throw new Error("Could not allocate a terrain shader.");}
    gl.shaderSource(shader,source);
    gl.compileShader(shader);
    const compiled=gl.getShaderParameter(shader,gl.COMPILE_STATUS);
    const error=compiled?null:gl.getShaderInfoLog(shader);
    if(compiled)gl.attachShader(program,shader);
    gl.deleteShader(shader);
    if(!compiled){gl.deleteProgram(program);throw new Error(error??"Could not compile the terrain shader.");}
  }
  gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS)){
    const message=gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(message??"Could not link the terrain shaders.");
  }
  return program;
}

export function uniforms(gl:WebGL2RenderingContext,program:WebGLProgram){
  const locations=new Map<string,WebGLUniformLocation|null>();
  return (name:string)=>{
    if(!locations.has(name))locations.set(name,gl.getUniformLocation(program,name));
    return locations.get(name)??null;
  };
}

export function setCamera(gl:WebGL2RenderingContext,uniform:ReturnType<typeof uniforms>,camera:Camera){
  gl.uniform2f(uniform("center"),...camera.center);
  gl.uniform2f(uniform("rotation"),...camera.rotation);
  gl.uniform2f(uniform("tilt"),...camera.tilt);
  gl.uniform2f(uniform("focal"),...camera.focal);
  gl.uniform1f(uniform("distanceToGround"),camera.distance);
  gl.uniform1f(uniform("focusHeight"),camera.focus);
}

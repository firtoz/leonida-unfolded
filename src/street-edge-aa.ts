import {makeProgram, uniforms} from "./view-gl";

const vertex=`#version 300 es
void main(){
  vec2 uv=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));
  gl_Position=vec4(uv*2.0-1.0,0.0,1.0);
}`;

const fragment=`#version 300 es
precision highp float;
uniform sampler2D sceneColor;
out vec4 color;
float luminance(vec3 rgb){
  return dot(rgb,vec3(.299,.587,.114));
}
void main(){
  vec2 texel=1.0/vec2(textureSize(sceneColor,0));
  vec2 uv=gl_FragCoord.xy*texel;
  vec3 center=texture(sceneColor,uv).rgb;
  float mid=luminance(center);
  float nw=luminance(texture(sceneColor,uv+texel*vec2(-1.0,1.0)).rgb);
  float ne=luminance(texture(sceneColor,uv+texel*vec2(1.0,1.0)).rgb);
  float sw=luminance(texture(sceneColor,uv+texel*vec2(-1.0,-1.0)).rgb);
  float se=luminance(texture(sceneColor,uv+texel*vec2(1.0,-1.0)).rgb);
  float low=min(mid,min(min(nw,ne),min(sw,se)));
  float high=max(mid,max(max(nw,ne),max(sw,se)));
  if(high-low<max(.045,high*.14)){
    color=vec4(center,1.0);
    return;
  }
  vec2 direction=vec2((sw+se)-(nw+ne),(nw+sw)-(ne+se));
  float reduction=max((nw+ne+sw+se)*.03125,.012);
  direction=clamp(direction/(min(abs(direction.x),abs(direction.y))+reduction),-5.0,5.0)*texel;
  vec3 taps=(texture(sceneColor,uv-direction/6.0).rgb+texture(sceneColor,uv+direction/6.0).rgb)*.5;
  vec3 wide=taps*.5+(texture(sceneColor,uv-direction*.5).rgb+texture(sceneColor,uv+direction*.5).rgb)*.25;
  float filtered=luminance(wide);
  color=vec4(filtered<low||filtered>high?taps:wide,1.0);
}`;

export class StreetEdgeAA{
  private program?:WebGLProgram;
  private texture?:WebGLTexture;
  private width=0;
  private height=0;
  private failed=false;

  constructor(private readonly gl:WebGL2RenderingContext){}

  paint(main:WebGLProgram){
    const {gl}=this,width=gl.drawingBufferWidth,height=gl.drawingBufferHeight;
    if(this.failed||!width||!height)return;
    gl.activeTexture(gl.TEXTURE2);
    try{
      if(!this.program){
        this.program=makeProgram(gl,vertex,fragment);
        gl.useProgram(this.program);
        gl.uniform1i(uniforms(gl,this.program)("sceneColor"),2);
      }
      const allocate=!this.texture||this.width!==width||this.height!==height;
      if(allocate){
        gl.deleteTexture(this.texture??null);
        this.texture=gl.createTexture()??undefined;
        if(!this.texture)return;
        gl.bindTexture(gl.TEXTURE_2D,this.texture);
        gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGB8,width,height);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        this.width=width;
        this.height=height;
      }else gl.bindTexture(gl.TEXTURE_2D,this.texture??null);
      gl.copyTexSubImage2D(gl.TEXTURE_2D,0,0,0,0,0,width,height);
      if(allocate&&gl.getError()!==gl.NO_ERROR){
        this.failed=true;
        this.dispose();
        return;
      }
      gl.useProgram(this.program);
      gl.bindVertexArray(null);
      gl.disable(gl.DEPTH_TEST);
      gl.drawArrays(gl.TRIANGLES,0,3);
      gl.enable(gl.DEPTH_TEST);
    }catch{
      this.failed=true;
      this.dispose();
    }finally{
      gl.activeTexture(gl.TEXTURE1);
      gl.useProgram(main);
    }
  }

  dispose(){
    this.gl.deleteTexture(this.texture??null);
    this.gl.deleteProgram(this.program??null);
    this.texture=undefined;
    this.program=undefined;
  }
}

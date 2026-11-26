import { makeProgram, uniforms } from "./view-gl";

const vertex=`#version 300 es
void main(){
  vec2 uv=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));
  gl_Position=vec4(uv*2.0-1.0,0.0,1.0);
}`;
const fragment=`#version 300 es
precision highp float;
uniform sampler2D sceneColor;
uniform highp sampler2D sceneDepth;
out vec4 color;
void main(){
  ivec2 at=ivec2(gl_FragCoord.xy);
  color=texelFetch(sceneColor,at,0);
  gl_FragDepth=texelFetch(sceneDepth,at,0).r;
}`;

const maxPixels=2560*1440;
export class StreetFrameSnapshot {
  private program?:WebGLProgram;
  private texture?:WebGLTexture;
  private width=0;
  private height=0;
  private failed=false;

  constructor(private readonly gl:WebGL2RenderingContext){}

  capture(main:WebGLProgram){
    const {gl}=this,width=gl.drawingBufferWidth,height=gl.drawingBufferHeight;
    if(this.failed||!width||!height||width*height>maxPixels)return;
    try{
      if(!this.program){
        const program=makeProgram(gl,vertex,fragment),location=uniforms(gl,program);
        gl.useProgram(program);
        gl.uniform1i(location("sceneColor"),2);
        gl.uniform1i(location("sceneDepth"),5);
        this.program=program;
      }
      gl.activeTexture(gl.TEXTURE2);
      const allocate=!this.texture||width!==this.width||height!==this.height;
      if(allocate){
        gl.deleteTexture(this.texture??null);
        this.texture=gl.createTexture()??undefined;
        if(!this.texture)return;
        gl.bindTexture(gl.TEXTURE_2D,this.texture);
        gl.texStorage2D(gl.TEXTURE_2D,1,gl.getContextAttributes()?.alpha?gl.RGBA8:gl.RGB8,width,height);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        this.width=width;this.height=height;
      }else gl.bindTexture(gl.TEXTURE_2D,this.texture??null);
      const texture=this.texture;
      if(!texture)return;
      gl.copyTexSubImage2D(gl.TEXTURE_2D,0,0,0,0,0,width,height);
      if(allocate&&gl.getError()!==gl.NO_ERROR){
        this.failed=true;
        this.dispose();
        return;
      }
      return {texture,width,height};
    }catch{
      this.failed=true;
      this.dispose();
    }finally{gl.activeTexture(gl.TEXTURE1);gl.useProgram(main);}
  }

  restore(width:number,height:number,depth:WebGLTexture,main:WebGLProgram){
    const {gl,texture,program}=this;
    if(!texture||!program||this.width!==width||this.height!==height)return false;
    gl.viewport(0,0,width,height);
    gl.useProgram(program);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.activeTexture(gl.TEXTURE5);gl.bindTexture(gl.TEXTURE_2D,depth);
    gl.activeTexture(gl.TEXTURE1);
    gl.disable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.ALWAYS);
    gl.drawArrays(gl.TRIANGLES,0,3);
    gl.depthFunc(gl.LESS);
    gl.useProgram(main);
    return true;
  }

  dispose(){
    this.gl.deleteTexture(this.texture??null);
    this.gl.deleteProgram(this.program??null);
    this.texture=undefined;
    this.program=undefined;
  }
}

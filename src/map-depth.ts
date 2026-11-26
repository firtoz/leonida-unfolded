import { makeProgram, uniforms } from "./view-gl";

export type ProjectedAnchor = { x:number; y:number; depth:number };
const vertex=`#version 300 es
precision highp float;
layout(location=0) in vec3 anchor;
uniform float count;
flat out vec3 sampleAt;
void main(){
  sampleAt=anchor;
  gl_PointSize=1.0;
  gl_Position=vec4((float(gl_VertexID)+0.5)*2.0/count-1.0,0.0,0.0,1.0);
}
`;
const fragment=`#version 300 es
precision highp float;
uniform sampler2D sceneDepth;
flat in vec3 sampleAt;
out vec4 result;
float visibleAt(vec2 offset){
  vec2 uv=sampleAt.xy+offset/vec2(textureSize(sceneDepth,0));
  return float(sampleAt.z<=texture(sceneDepth,uv).r+0.000001);
}
void main(){
  float hits=visibleAt(vec2(0))+visibleAt(vec2(1,0))+visibleAt(vec2(-1,0))
    +visibleAt(vec2(0,1))+visibleAt(vec2(0,-1));
  result=vec4(float(hits>=3.0),0.0,0.0,1.0);
}
`;

export class MapDepth {
  private readonly scene:WebGLFramebuffer;
  private readonly multisample:WebGLFramebuffer;
  private readonly multisampleColor:WebGLRenderbuffer;
  private readonly multisampleDepth:WebGLRenderbuffer;
  private samples:number;
  private depthPending=false;
  private readonly output:WebGLFramebuffer;
  private readonly color:WebGLTexture;
  private readonly depth:WebGLTexture;
  private readonly results:WebGLTexture;
  private readonly program:WebGLProgram;
  private readonly vao:WebGLVertexArrayObject;
  private readonly points:WebGLBuffer;
  private readonly uniform:ReturnType<typeof uniforms>;
  private width=0;
  private height=0;
  private capacity=0;

  constructor(private gl:WebGL2RenderingContext){
    this.scene=gl.createFramebuffer();this.output=gl.createFramebuffer();
    this.multisample=gl.createFramebuffer();
    this.multisampleColor=gl.createRenderbuffer();this.multisampleDepth=gl.createRenderbuffer();
    const colorSamples=gl.getInternalformatParameter(gl.RENDERBUFFER,gl.RGBA8,gl.SAMPLES) as Int32Array;
    const depthSamples=gl.getInternalformatParameter(gl.RENDERBUFFER,gl.DEPTH_COMPONENT24,gl.SAMPLES) as Int32Array;
    this.samples=colorSamples.find(samples=>samples>1&&samples<=4&&depthSamples.includes(samples))??0;
    this.color=gl.createTexture();this.depth=gl.createTexture();this.results=gl.createTexture();
    this.program=makeProgram(gl,vertex,fragment);
    this.uniform=uniforms(gl,this.program);
    this.vao=gl.createVertexArray();this.points=gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.points);
    gl.vertexAttribPointer(0,3,gl.FLOAT,false,12,0);
    gl.enableVertexAttribArray(0);
  }

  begin(width:number,height:number){
    const {gl}=this;
    if(width!==this.width||height!==this.height){
      this.width=width;this.height=height;
      gl.bindFramebuffer(gl.FRAMEBUFFER,this.scene);
      this.allocate(this.color,gl.RGBA8,width,height,gl.RGBA,gl.UNSIGNED_BYTE,gl.COLOR_ATTACHMENT0);
      this.allocate(this.depth,gl.DEPTH_COMPONENT24,width,height,gl.DEPTH_COMPONENT,gl.UNSIGNED_INT,gl.DEPTH_ATTACHMENT);
      this.check();
      if(this.samples){
        gl.bindFramebuffer(gl.FRAMEBUFFER,this.multisample);
        this.allocateSamples(this.multisampleColor,gl.RGBA8,gl.COLOR_ATTACHMENT0);
        this.allocateSamples(this.multisampleDepth,gl.DEPTH_COMPONENT24,gl.DEPTH_ATTACHMENT);
        if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)this.samples=0;
      }
    }
    this.depthPending=this.samples>0;
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.samples?this.multisample:this.scene);
  }

  private allocateSamples(buffer:WebGLRenderbuffer,format:number,attachment:number){
    const {gl}=this;
    gl.bindRenderbuffer(gl.RENDERBUFFER,buffer);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER,this.samples,format,this.width,this.height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER,attachment,gl.RENDERBUFFER,buffer);
  }

  private allocate(texture:WebGLTexture,format:number,width:number,height:number,type:number,scalar:number,attachment:number){
    const {gl}=this;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D,0,format,width,height,0,type,scalar,null);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,attachment,gl.TEXTURE_2D,texture,0);
  }

  private check(){
    const {gl}=this;
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)
      throw new Error("Map depth framebuffer is incomplete.");
  }

  present(){
    const {gl,width,height}=this;
    if(this.samples){
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,this.multisample);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,this.scene);
      gl.blitFramebuffer(0,0,width,height,0,0,width,height,gl.COLOR_BUFFER_BIT,gl.NEAREST);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER,this.scene);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,null);
    gl.blitFramebuffer(0,0,width,height,0,0,width,height,gl.COLOR_BUFFER_BIT,gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  }

  visible(points:Float32Array){
    const {gl}=this,count=points.length/3;
    if(!count)return new Uint8Array();
    if(this.depthPending){
      const {width,height}=this;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,this.multisample);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,this.scene);
      gl.blitFramebuffer(0,0,width,height,0,0,width,height,gl.DEPTH_BUFFER_BIT,gl.NEAREST);
      this.depthPending=false;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.output);
    if(count>this.capacity){
      this.capacity=2**Math.ceil(Math.log2(count));
      this.allocate(this.results,gl.RGBA8,this.capacity,1,gl.RGBA,gl.UNSIGNED_BYTE,gl.COLOR_ATTACHMENT0);
      this.check();
    }
    const pixels=new Uint8Array(count*4);
    gl.viewport(0,0,count,1);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.points);
    gl.bufferData(gl.ARRAY_BUFFER,points,gl.STREAM_DRAW);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D,this.depth);
    gl.uniform1i(this.uniform("sceneDepth"),3);
    gl.uniform1f(this.uniform("count"),count);
    gl.drawArrays(gl.POINTS,0,count);
    gl.readPixels(0,0,count,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    gl.enable(gl.DEPTH_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.viewport(0,0,this.width,this.height);
    return pixels;
  }

  dispose(){
    const {gl}=this;
    for(const texture of [this.color,this.depth,this.results])gl.deleteTexture(texture);
    gl.deleteFramebuffer(this.scene);gl.deleteFramebuffer(this.output);
    gl.deleteFramebuffer(this.multisample);
    gl.deleteRenderbuffer(this.multisampleColor);gl.deleteRenderbuffer(this.multisampleDepth);
    gl.deleteVertexArray(this.vao);gl.deleteBuffer(this.points);gl.deleteProgram(this.program);
  }
}

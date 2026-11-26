// Copy the settled opaque depth before water or any screen-space shading.
// WebGL can resolve the multisampled default depth buffer into a texture
// when the attachment formats and source and destination rectangles agree.
export class StreetSceneDepth {
  private target?:{framebuffer:WebGLFramebuffer;texture:WebGLTexture;width:number;height:number};
  private supported=true;
  constructor(private readonly gl:WebGL2RenderingContext){}

  capture(rows?:number){
    if(!this.supported)return;
    const {gl}=this,width=gl.drawingBufferWidth,height=gl.drawingBufferHeight;
    if(!width||!height)return;
    const prior=this.target;
    if(!prior||prior.width<width||prior.height<height){
      const target=this.allocate(Math.max(width,prior?.width??0),Math.max(height,prior?.height??0));
      if(!target){
        this.supported=false;
        this.dispose();
        return;
      }
      this.dispose();
      this.target=target;
    }
    const {framebuffer,texture}=this.target!;
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,framebuffer);
    const copyHeight=Math.min(rows??height,height);
    gl.blitFramebuffer(0,0,width,copyHeight,0,0,width,copyHeight,gl.DEPTH_BUFFER_BIT,gl.NEAREST);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,null);
    if(prior!==this.target&&gl.getError()!==gl.NO_ERROR){
      this.supported=false;
      this.dispose();
      return;
    }
    return texture;
  }

  private allocate(width:number,height:number){
    const {gl}=this,stencil=gl.getParameter(gl.STENCIL_BITS),depth=gl.getParameter(gl.DEPTH_BITS);
    const format=stencil===8&&depth===24?gl.DEPTH24_STENCIL8:
      stencil===0&&depth===24?gl.DEPTH_COMPONENT24:stencil===0&&depth===16?gl.DEPTH_COMPONENT16:undefined;
    if(format===undefined)return;
    const texture=gl.createTexture(),framebuffer=gl.createFramebuffer();
    if(texture&&framebuffer){
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texStorage2D(gl.TEXTURE_2D,1,format,width,height);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,stencil?gl.DEPTH_STENCIL_ATTACHMENT:gl.DEPTH_ATTACHMENT,gl.TEXTURE_2D,texture,0);
      gl.drawBuffers([gl.NONE]);
      gl.readBuffer(gl.NONE);
      const ready=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      gl.activeTexture(gl.TEXTURE1);
      if(ready)return {texture,framebuffer,width,height};
    }
    gl.deleteFramebuffer(framebuffer);gl.deleteTexture(texture);
  }

  dispose(){
    if(!this.target)return;
    this.gl.deleteFramebuffer(this.target.framebuffer);
    this.gl.deleteTexture(this.target.texture);
    this.target=undefined;
  }
}

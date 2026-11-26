import type { StreetOceanReply, StreetOceanRequest, StreetOceanSource } from "./street-ocean-worker";

export const streetOceanWaveUnits=[27,28] as const;
const phaseStep=100;
type Wave=Extract<StreetOceanReply,{pixels:unknown}>;

export class StreetOceanWaves {
  readonly supported:boolean;
  private worker?:Worker;
  private ready=false;
  private pending=false;
  private failed=false;
  private next?:Wave;
  private textures?:[WebGLTexture,WebGLTexture];
  private phases:number[]=[];
  private lengths?:Wave["lengths"];
  private beaufort?:number;
  private clock?:number;

  constructor(private readonly gl:WebGL2RenderingContext,private readonly source:StreetOceanSource,
    private readonly wake:()=>void){
    this.supported=gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)>streetOceanWaveUnits[1];
  }

  get available(){return this.supported&&!this.failed;}

  private open(){
    if(this.worker||!this.available)return;
    try{
      const worker=new Worker(new URL("./street-ocean-worker.js",import.meta.url),{type:"module"});
      this.worker=worker;
      worker.onmessage=({data}:MessageEvent<StreetOceanReply>)=>{
        if(this.worker!==worker)return;
        this.pending=false;
        if("error" in data){this.fail();return;}
        if("ready" in data){this.ready=true;this.wake();return;}
        if(data.beaufort!==this.beaufort){this.wake();return;}
        this.next=data;
        // Changes from the procedural surface need a main render even in
        // reduced motion. Later phases use the existing water timer.
        if(!this.phases.length)this.wake();
      };
      worker.onerror=()=>{if(this.worker===worker)this.fail();};
      worker.postMessage({source:this.source} satisfies StreetOceanRequest);
    }catch{this.fail();}
  }

  bind(now:number,beaufort:number,moving:boolean,uniform:(name:string)=>WebGLUniformLocation|null){
    if(!this.available)return false;
    this.open();
    if(!this.ready)return false;
    if(this.beaufort!==beaufort||(!moving&&this.clock!==undefined)){
      this.beaufort=beaufort;
      this.phases=[];
      this.next=undefined;
      this.clock=undefined;
    }
    if(moving)this.clock??=now;
    const time=moving?Math.max(0,now-this.clock!):0;
    if(this.phases.length&&time-this.phases.at(-1)!>2*phaseStep){
      // Resume near the new clock after an inactive view or a slow frame.
      this.phases=[];
      this.next=undefined;
    }
    if(this.next&&time-this.next.ticks>2*phaseStep)this.next=undefined;
    if(this.next&&(!this.phases.length||moving&&(this.phases.length===1||time>=this.phases[1]))){
      const next=this.next;
      this.next=undefined;
      if(!moving&&next.ticks!==0){
        this.phases=[];
      }else{
        if(!this.upload(next))return false;
        this.lengths=next.lengths;
      }
    }
    if(!this.next&&!this.pending&&(!this.phases.length||moving)){
      const ticks=this.phases.length?this.phases.at(-1)!+phaseStep:Math.floor(time/phaseStep)*phaseStep;
      this.pending=true;
      this.worker?.postMessage({beaufort,ticks} satisfies StreetOceanRequest);
    }
    if(!this.phases.length||!this.textures||!this.lengths)return false;
    const {gl}=this;
    const [a,b]=this.phases;
    gl.uniform3f(uniform("oceanBandLengths"),...this.lengths);
    gl.uniform1f(uniform("oceanPhaseBlend"),b===undefined?0:Math.min(1,Math.max(0,(time-a)/(b-a))));
    for(const [i,unit] of streetOceanWaveUnits.entries()){
      gl.activeTexture(gl.TEXTURE0+unit);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY,this.textures[b===undefined?0:i]);
    }
    gl.activeTexture(gl.TEXTURE1);
    return true;
  }

  private upload({ticks,pixels}:Wave){
    const {gl}=this;
    gl.activeTexture(gl.TEXTURE0+streetOceanWaveUnits[0]);
    if(!this.textures){
      const first=gl.createTexture(),second=gl.createTexture();
      if(!first||!second){
        gl.deleteTexture(first);gl.deleteTexture(second);
        gl.activeTexture(gl.TEXTURE1);
        this.fail();return false;
      }
      this.textures=[first,second];
      for(const texture of this.textures){
        gl.bindTexture(gl.TEXTURE_2D_ARRAY,texture);
        gl.texStorage3D(gl.TEXTURE_2D_ARRAY,9,gl.RGBA16F,256,256,3);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_WRAP_S,gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_WRAP_T,gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      }
    }
    if(this.phases.length===2){
      const first=this.textures[0];
      this.textures[0]=this.textures[1];
      this.textures[1]=first;
      this.phases.shift();
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY,this.textures[this.phases.length]);
    const type=pixels instanceof Uint16Array?gl.HALF_FLOAT:gl.FLOAT;
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY,0,0,0,0,256,256,3,gl.RGBA,type,pixels);
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.activeTexture(gl.TEXTURE1);
    this.phases.push(ticks);
    return true;
  }

  private fail(){
    this.failed=true;
    this.dispose();
    this.wake();
  }

  dispose(){
    this.worker?.terminate();this.worker=undefined;
    for(const texture of this.textures??[])this.gl.deleteTexture(texture);
    this.textures=undefined;
    this.next=undefined;
  }
}

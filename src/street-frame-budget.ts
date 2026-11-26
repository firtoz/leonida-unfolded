const scales=[1,.90,.80,.72];
const sampleInterval=110;
type GpuTimer={TIME_ELAPSED_EXT:number;GPU_DISJOINT_EXT:number};

// Change only the moving viewport. Static views always use the display size.
export class StreetFrameBudget {
  private readonly timing:GpuTimer|null;
  private query:WebGLQuery|null=null;
  private sampledAt=-Infinity;
  private changedAt=-Infinity;
  private level=0;
  private average=0;
  private samples=0;

  constructor(private readonly gl:WebGL2RenderingContext){
    this.timing=gl.getExtension("EXT_disjoint_timer_query_webgl2");
  }

  update(now:number,moving:boolean){
    const {gl,timing,query}=this;
    if(timing&&query){
      const disjoint=gl.getParameter(timing.GPU_DISJOINT_EXT);
      const available=gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE);
      if(available&&!disjoint){
        const ms=gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6;
        if(ms>0&&ms<100){
          this.average=this.samples?this.average*.72+ms*.28:ms;
          this.samples++;
          if(moving&&this.samples>=3&&this.average>20&&this.level<scales.length-1&&now-this.changedAt>360){
            this.level++;
            this.changedAt=now;this.samples=0;
          }else if(moving&&this.samples>=5&&this.average<12.5&&this.level>0&&now-this.changedAt>1100){
            this.level--;
            this.changedAt=now;this.samples=0;
          }
        }
      }
      if(available||disjoint){
        gl.deleteQuery(query);
        this.query=null;
      }
    }
    return moving?scales[this.level]:1;
  }

  begin(now:number){
    const {gl,timing}=this;
    if(!timing||this.query||now-this.sampledAt<sampleInterval||
      gl.getQuery(timing.TIME_ELAPSED_EXT,gl.CURRENT_QUERY))return false;
    this.query=gl.createQuery();
    if(!this.query)return false;
    this.sampledAt=now;
    gl.beginQuery(timing.TIME_ELAPSED_EXT,this.query);
    return true;
  }

  end(){if(this.timing)this.gl.endQuery(this.timing.TIME_ELAPSED_EXT);}

  reset(){
    this.gl.deleteQuery(this.query);
    this.query=null;
    this.sampledAt=this.changedAt=-Infinity;
    this.level=this.average=this.samples=0;
  }

  dispose(){this.gl.deleteQuery(this.query);}
}

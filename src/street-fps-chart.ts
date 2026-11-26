import Stats from "stats.js";

const samplePeriod=1000;

export class StreetFpsChart {
  private readonly chart=new Stats.Panel("FPS","#0ff","#002");
  private windowStart?:number;
  private frames=0;
  private lastFrame=0;
  private idleTimer=0;

  constructor(private readonly panel:HTMLElement,private readonly idle:HTMLElement){
    const {dom}=this.chart;
    dom.setAttribute("role","img");
    dom.setAttribute("aria-label","Frames per second history");
    panel.prepend(dom);
  }

  setEnabled(enabled:boolean){
    this.panel.hidden=!enabled;
    this.reset();
  }

  frame(now:number){
    if(this.panel.hidden)return;
    if(this.windowStart===undefined)this.windowStart=now;
    else {
      this.frames++;
      const elapsed=now-this.windowStart;
      if(elapsed>=samplePeriod){
        this.chart.update(this.frames*1000/elapsed,100);
        this.windowStart=now;
        this.frames=0;
      }
    }
    this.lastFrame=now;
    if(this.idle.hidden===false)this.idle.hidden=true;
    if(!this.idleTimer)this.idleTimer=window.setTimeout(this.checkIdle,samplePeriod);
  }

  reset(){
    clearTimeout(this.idleTimer);
    this.idleTimer=0;
    this.windowStart=undefined;
    this.frames=0;
    this.idle.hidden=true;
  }

  private checkIdle=()=>{
    this.idleTimer=0;
    const remaining=samplePeriod-(performance.now()-this.lastFrame);
    if(remaining>0){this.idleTimer=window.setTimeout(this.checkIdle,remaining);return;}
    this.reset();
    this.idle.hidden=false;
  };
}

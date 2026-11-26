import type { Archive } from "./archive";
import { streetBudgets } from "./street-capacity";
import { indexedGraphicsPages, type IndexedGraphicsRange } from "./street-index-scan";
import type { GraphicsReply, GraphicsRequest } from "./street-scan-worker";

type GraphicsPages=Awaited<ReturnType<typeof indexedGraphicsPages>>;
type Read={resolve:(pages:GraphicsPages|undefined)=>void;reject:(error:Error)=>void};

class GraphicsReader {
  private worker?:Worker;
  private pending=new Map<number,Read>();
  private serial=0;
  private unavailable=false;
  private closed=false;

  constructor(private readonly archive:Archive){this.start();}

  private start(){
    try{
      const worker=this.worker=new Worker(new URL("./street-scan-worker.js",import.meta.url),{type:"module"});
      worker.onmessage=({data}:MessageEvent<GraphicsReply>)=>{
        const read=this.pending.get(data.job);
        if(!read)return;
        this.pending.delete(data.job);
        if("pages" in data)read.resolve(data);
        else read.reject(new Error(data.error));
      };
      worker.onerror=event=>{event.preventDefault();this.stop();};
      worker.onmessageerror=()=>this.stop();
      return worker;
    }catch{
      this.stop();
    }
  }

  private stop(){
    this.worker?.terminate();
    this.worker=undefined;
    this.unavailable=true;
    for(const read of this.pending.values()){
      if(this.closed)read.reject(new Error("Street graphics reader closed."));
      else read.resolve(undefined);
    }
    this.pending.clear();
  }

  async read(offset:number,range?:IndexedGraphicsRange){
    const worker=this.unavailable?undefined:this.worker??this.start();
    if(worker){
      const pages=await new Promise<GraphicsPages|undefined>((resolve,reject)=>{
        const job=++this.serial;
        this.pending.set(job,{resolve,reject});
        try{
          worker.postMessage({graphics:true,file:this.archive.file,offset,range,job} satisfies GraphicsRequest);
        }catch{
          this.stop();
        }
      });
      if(pages)return pages;
    }
    return indexedGraphicsPages(this.archive,offset,range);
  }

  get queued(){return this.unavailable?Infinity:this.pending.size;}

  close(){this.closed=true;this.stop();}
}

const graphicsReaders=new WeakMap<Archive,GraphicsReader[]>();

export function prepareStreetGraphics(archive:Archive){
  if(streetBudgets.geometryReads<2||typeof Worker==="undefined")return;
  const readers=Array.from({length:Math.min(4,streetBudgets.geometryReads)},()=>new GraphicsReader(archive));
  graphicsReaders.set(archive,readers);
  return ()=>{
    graphicsReaders.delete(archive);
    for(const reader of readers)reader.close();
  };
}

export function streetGraphicsPages(archive:Archive,offset:number,range?:IndexedGraphicsRange){
  const readers=graphicsReaders.get(archive);
  if(!readers)return indexedGraphicsPages(archive,offset,range);
  return readers.reduce((best,reader)=>reader.queued<best.queued?reader:best).read(offset,range);
}

import { mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { availableParallelism } from "node:os";
import { indexScanVersion, indexSegmentSize, type ScanSegment } from "../src/street-index-scan";
import type { ScanReply, ScanRequest } from "../src/street-scan-worker";

const [source,output,requested]=process.argv.slice(2);
if(!source||!output)throw new Error("Usage: bun scripts/scan-local-street-index.ts <levels.rpf> <checkpoint directory> [workers]");
const file=Bun.file(resolve(source)),directory=resolve(output);
const lanes=requested===undefined?Math.min(6,Math.max(1,availableParallelism()-2)):Number(requested);
if(!Number.isSafeInteger(lanes)||lanes<1||lanes>16||!(await file.exists())||!file.size)throw new Error("Invalid archive or worker count.");
const total=Math.ceil(file.size/indexSegmentSize);
const hash=Buffer.from(await crypto.subtle.digest("SHA-256",await file.slice(0,4096).arrayBuffer())).toString("hex");
const identity={format:indexScanVersion,size:file.size,hash,total};
await mkdir(directory,{recursive:true,mode:0o700});
const metadata=Bun.file(resolve(directory,"scan.json"));
if(await metadata.exists()){
  if(JSON.stringify(await metadata.json())!==JSON.stringify(identity))throw new Error("Checkpoint directory belongs to a different archive or scan format.");
}else await Bun.write(metadata,JSON.stringify(identity));
let cursor=0,done=0,started=performance.now();
await Promise.all(Array.from({length:lanes},async()=>{
  const worker=new Worker(new URL("../src/street-scan-worker.ts",import.meta.url));
  try{
    while(cursor<total){
      const segment=cursor++,path=resolve(directory,`${segment}.json.gz`);
      if(!await Bun.file(path).exists()){
        const result=await new Promise<ScanSegment>((resolve,reject)=>{
          worker.onmessage=({data}:MessageEvent<ScanReply>)=>"result" in data?resolve(data.result):reject(new Error(data.error));
          worker.onerror=event=>reject(new Error(event.message));
          worker.postMessage({file,segment,scope:"full"} satisfies ScanRequest);
        });
        const temporary=path+".partial";
        await Bun.write(temporary,Bun.gzipSync(JSON.stringify(result)));
        await rename(temporary,path);
      }
      done++;
      if(done%25===0||done===total)console.log(`${done}/${total} · ${((performance.now()-started)/1000).toFixed(1)} s`);
    }
  }finally{worker.terminate();}
}));

import { open, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { Archive } from "../src/archive";
import { packStreetIndex } from "../src/street-index-pack";
import { indexScanVersion, indexSegmentSize, type ScanSegment } from "../src/street-index-scan";

const [source,checkpoint,output]=process.argv.slice(2);
if(!source||!checkpoint||!output)throw new Error("Usage: bun scripts/pack-local-street-index.ts <levels.rpf> <checkpoint directory> <output.terrain-index>");
const directory=resolve(checkpoint),file=Bun.file(resolve(source)),destination=resolve(output);
const identity=await Bun.file(resolve(directory,"scan.json")).json();
const headerHash=Buffer.from(await crypto.subtle.digest("SHA-256",await file.slice(0,4096).arrayBuffer())).toString("hex");
if(![5,6,indexScanVersion].includes(identity.format)||identity.size!==file.size||identity.hash!==headerHash||identity.total!==Math.ceil(file.size/indexSegmentSize))
  throw new Error("Scan checkpoints belong to a different archive or scan format.");

async function* checkpoints(){
  const utf8=new TextDecoder();
  for(let i=0;i<identity.total;i++){
    const input=Bun.file(resolve(directory,`${i}.json.gz`));
    if(!await input.exists())throw new Error(`Missing scan checkpoint ${i}; finish the scan before packing.`);
    yield JSON.parse(utf8.decode(Bun.gunzipSync(await input.bytes()))) as ScanSegment;
  }
}
const packed=await packStreetIndex(new Archive("levels.rpf",file),identity.total,checkpoints(),
  (done,total)=>console.log(`${done}/${total} placement maps`),identity.format);
const temporary=destination+".partial";
const out=await open(temporary,"wx",0o600);
try{
  for await(const bytes of packed.file.stream())await out.writeFile(bytes);
  await out.close();
  await rename(temporary,destination);
}catch(error){
  await out.close();
  await unlink(temporary).catch(()=>{});
  throw error;
}
const {manifest,unknown,failedMaps,linked}=packed;
console.log(JSON.stringify({placements:manifest.placements,unknown,failedMaps,linked,maps:manifest.maps,vegetation:manifest.vegetation,
  models:manifest.models,cells:Object.keys(manifest.shards).length,bytes:packed.file.size}));

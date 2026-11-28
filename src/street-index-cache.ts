import { streetIndexDatabaseVersion } from "./street-cache-versions";
import { gunzipSync } from "fflate";
import type { ScanSegment } from "./street-index-scan";

export function openStreetIndexCache(){
  return new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open("terrain-atlas-street-index",streetIndexDatabaseVersion);
    request.onupgradeneeded=()=>request.result.createObjectStore("segments");
    request.onsuccess=()=>resolve(request.result);
    request.onerror=request.onblocked=()=>reject(request.error??new Error("Could not open the local index cache."));
  });
}

const decoder=new TextDecoder();

export function decodeStreetCheckpoint(value:Uint8Array|ScanSegment):ScanSegment{
  return value instanceof Uint8Array?JSON.parse(decoder.decode(gunzipSync(value))) as ScanSegment:value;
}

export async function* readStreetCheckpoints(db:IDBDatabase,key:string,total:number){
  for(let start=0;start<total;start+=32){
    const end=Math.min(total,start+32);
    const rows=await new Promise<(Uint8Array|ScanSegment)[]>((resolve,reject)=>{
      const range=IDBKeyRange.bound([key,start],[key,end],false,true);
      const request=db.transaction("segments").objectStore("segments").getAll(range);
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    if(rows.length!==end-start)throw new Error("The saved world scan has missing segments.");
    for(const row of rows)yield decodeStreetCheckpoint(row);
  }
}

export function saveStreetIndexBundle(db:IDBDatabase,kind:"spatial"|"bundle",key:string,file:Blob){
  return new Promise<void>((resolve,reject)=>{
    const tx=db.transaction("segments","readwrite",{durability:"relaxed"});
    tx.objectStore("segments").put(file,[kind,key]);
    tx.oncomplete=()=>resolve();
    tx.onabort=()=>reject(tx.error);
  });
}

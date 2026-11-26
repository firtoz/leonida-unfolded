import type { StreetChunk } from "./street-mesh";
import type { StreetBlockTexture, StreetTextureImage } from "./street-terrain-material";
import { streetBudgets } from "./street-capacity";
import type { StreetWaterTileIndex } from "./street-water-tiles";
import type { RoadHeightMip } from "./street-road-material";

type Assets={mesh:StreetChunk;texture:StreetTextureImage;blocks:StreetBlockTexture;waterIndex:StreetWaterTileIndex;roadHeight:RoadHeightMip[]};
type CacheEntry={key:string;created:number;bytes:number};
type CacheWrite={kind:keyof Assets;id:string;value:Assets[keyof Assets];bytes:number};
type CacheRead={key:string;complete:(value:unknown,failed?:true)=>void};
const textureLimit=16*1024*1024;
const assetKeyLimit=16_384;
let opening:Promise<IDBDatabase|undefined>|undefined;
let storageHeadroom:Promise<number|undefined>|undefined;
let storageLimit:number|undefined;

function decodedStorageHeadroom(){
  return storageHeadroom??=Promise.resolve().then(()=>navigator.storage?.estimate())
    .then(estimate=>{
      const {quota,usage}=estimate??{};
      if(quota!==undefined&&usage!==undefined&&Number.isFinite(quota)&&Number.isFinite(usage)&&quota>0&&usage>=0)
        return Math.max(0,quota-usage);
    }).catch(()=>undefined);
}

function openCache(){
  return opening??=new Promise(resolve=>{
    const request=indexedDB.open("terrain-atlas-decoded-fps",1);
    request.onupgradeneeded=()=>{
      const db=request.result;
      db.createObjectStore("assets");
      db.createObjectStore("entries",{keyPath:"key"}).createIndex("age","created");
      db.createObjectStore("size");
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=request.onblocked=()=>resolve(undefined);
  });
}

export class StreetAssetCache {
  private db?:IDBDatabase;
  private readonly namespace:Promise<string>;
  private readonly inventories=new Map<keyof Assets,{expires:number;result:Promise<Set<IDBValidKey>|undefined>}>();
  private writes:CacheWrite[]=[];
  private reads:CacheRead[]=[];
  private pendingBytes=0;
  private writeTimer?:ReturnType<typeof setTimeout>;
  private writing=false;
  private writable=true;
  constructor(files:Record<string,File>){
    const sources=Object.entries(files).filter(([path])=>
      path==="levels.rpf"||path==="textures.rpf"||path.startsWith("data/ttdb/")).sort(([a],[b])=>a.localeCompare(b));
    const key=JSON.stringify([1,streetBudgets.materialSide,sources.map(([path,file])=>[path,file.size,file.lastModified])]);
    this.namespace=crypto.subtle.digest("SHA-256",new TextEncoder().encode(key))
      .then(hash=>Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,"0")).join(""));
  }

  async get<K extends keyof Assets>(kind:K,id:string):Promise<Assets[K]|undefined>{
    try{
      const prefix=`${await this.namespace}:${kind}:`;
      const key=prefix+id;
      this.db??=await openCache();
      const db=this.db;
      if(!db)return;
      // Avoid a storage transaction for every absent asset in a cold scene.
      const keys=await this.cachedKeys(db,kind,prefix);
      if(keys&&!keys.has(key))return;
      return await new Promise(resolve=>{
        this.reads.push({key,complete:(value,failed)=>{
          if(value===undefined&&!failed)keys?.delete(key);
          resolve(value as Assets[K]|undefined);
        }});
        if(this.reads.length===1)queueMicrotask(()=>this.readPending(db));
      });
    }catch{return;}
  }

  async hasCachedMeshes(){
    try{
      const prefix=`${await this.namespace}:mesh:`;
      this.db??=await openCache();
      if(!this.db)return false;
      const keys=await this.cachedKeys(this.db,"mesh",prefix);
      return keys===undefined||keys.size>0;
    }catch{return true;}
  }

  private readPending(db:IDBDatabase){
    const reads=this.reads;
    this.reads=[];
    try{
      const store=db.transaction("assets").objectStore("assets");
      for(const {key,complete} of reads){
        const request=store.get(key);
        request.onsuccess=()=>complete(request.result);
        request.onerror=event=>{event.preventDefault();complete(undefined,true);};
      }
    }catch{
      for(const {complete} of reads)complete(undefined,true);
    }
  }

  private cachedKeys(db:IDBDatabase,kind:keyof Assets,prefix:string){
    const now=Date.now();
    let inventory=this.inventories.get(kind);
    if(!inventory||now>=inventory.expires){
      const result=new Promise<Set<IDBValidKey>|undefined>(resolve=>{
        const range=IDBKeyRange.bound(prefix,`${prefix}\uffff`);
        const request=db.transaction("entries").objectStore("entries").getAllKeys(range,assetKeyLimit+1);
        request.onsuccess=()=>resolve(request.result.length<=assetKeyLimit?new Set(request.result):undefined);
        request.onerror=()=>resolve(undefined);
      }).catch(()=>undefined);
      inventory={expires:now+30_000,result};
      this.inventories.set(kind,inventory);
    }
    return inventory.result;
  }

  put<K extends keyof Assets>(kind:K,id:string,value:Assets[K],bytes:number){
    if(!this.db||!this.writable||bytes<=0||bytes>(kind==="mesh"?streetBudgets.decodedMeshEntryBytes:textureLimit)||
      this.pendingBytes+bytes>streetBudgets.decodedCacheWriteBytes)return;
    // Messages transfer the original buffers. Keep only a bounded copy pending for disk.
    try{this.writes.push({kind,id,value:structuredClone(value),bytes});}
    catch{return;}
    this.pendingBytes+=bytes;
    this.scheduleWrite();
  }

  private scheduleWrite(){
    if(this.writing||!this.writable||!this.writes.length)return;
    this.writeTimer??=setTimeout(()=>{void this.flush();},180);
  }

  private async flush(){
    const db=this.db,writes=this.writes;
    this.writes=[];this.pendingBytes=0;this.writeTimer=undefined;
    if(!db||!writes.length)return;
    this.writing=true;
    try{
      const [namespace,headroom]=await Promise.all([this.namespace,decodedStorageHeadroom()]);
      const latest=new Map(writes.map(write=>[`${namespace}:${write.kind}:${write.id}`,write]));
      const tx=db.transaction(["assets","entries","size"],"readwrite",{durability:"relaxed"});
      const assets=tx.objectStore("assets"),entries=tx.objectStore("entries"),size=tx.objectStore("size");
      const prior=[...latest.keys()].map(key=>entries.get(key));
      const total=size.get("total");
      const evicted=new Set<IDBValidKey>();
      let added=0;
      for(const [key,{value,bytes}] of latest){
        added+=bytes;
        assets.put(value,key);
        entries.put({key,created:Date.now(),bytes} satisfies CacheEntry);
      }
      tx.oncomplete=()=>{
        for(const [kind,inventory] of this.inventories)void inventory.result.then(keys=>{
          if(!keys||inventory!==this.inventories.get(kind))return;
          for(const key of evicted)keys.delete(key);
          for(const [key,row] of latest)if(row.kind===kind&&!evicted.has(key))keys.add(key);
          if(keys.size>assetKeyLimit)this.inventories.delete(kind);
        });
        this.writing=false;this.scheduleWrite();
      };
      tx.onabort=()=>{this.writable=false;this.writes=[];this.pendingBytes=0;};
      total.onsuccess=()=>{
        const previous=total.result??0;
        // Existing payloads already occupy part of the origin's physical storage.
        // Only new growth needs to fit in the remaining quota.
        const limit=storageLimit??=headroom===undefined?streetBudgets.decodedCacheBytes:previous+headroom;
        let used=previous+added-prior.reduce((bytes,row)=>bytes+((row.result as CacheEntry|undefined)?.bytes??0),0);
        if(used<=limit){size.put(used,"total");return;}
        const cursor=entries.index("age").openCursor();
        cursor.onsuccess=()=>{
          const row=cursor.result;
          if(!row||used<=limit){size.put(used,"total");return;}
          used-=(row.value as CacheEntry).bytes;
          evicted.add(row.primaryKey);
          assets.delete(row.primaryKey);
          row.delete();row.continue();
        };
      };
    }catch{
      this.writing=false;this.writable=false;this.writes=[];this.pendingBytes=0;
    }
  }
}

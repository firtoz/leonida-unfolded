import { streetIndexBundleHeader } from "./street-cache-versions";
import { gunzipSync } from "fflate";
import { streetAsset, type IndexedPlacement } from "./street-index-placement";
import type { Footprint, IndexedVegetation } from "./street-index-scan";
import { canopyAtlasRadius, canopyQueryRadius, grassQueryRadius, vegetationDistance, type VegetationModel } from "./street-vegetation";
import type { StreetAsset } from "./street-mesh";
import { bridgeDeckProxy, lowSkylineHeight } from "./street-lod";

export const indexFileName="terrain-street.terrain-index";
export const indexFileExtension=".terrain-index";
export const indexBundleMagic=streetIndexBundleHeader.magic;
export const indexShardSize=256;
const maxManifest=8*1024*1024;
const maxShard=64*1024*1024;
const decoder=new TextDecoder();
type Span=[number,number];
export type IndexManifest={
  archive:{size:number;fingerprint:string};
  scanVersion?:number;
  terrain?:true;
  terrainLinks?:true;
  placementLods?:true;
  authoredLods?:true;
  stagedMaps?:true;
  propLods?:true;
  total:number; maps:number; vegetation:number; models:number; placements:number;
  plants:VegetationModel[];
  shards:Record<string,Span>;
};
export type IndexShard={
  entities:IndexedPlacement[];
  models:VegetationModel[];
  vegetation:IndexedVegetation[];
};
type ProxyShard={skyline:StreetAsset[];bridge:StreetAsset[]};
export function indexShardKey(x:number,y:number){
  return `${Math.floor(x/indexShardSize)},${Math.floor(y/indexShardSize)}`;
}
export function* indexShardKeys([left,bottom,right,top]:Footprint){
  for(let y=Math.floor(bottom/indexShardSize);y<=Math.floor(top/indexShardSize);y++)
    for(let x=Math.floor(left/indexShardSize);x<=Math.floor(right/indexShardSize);x++)yield `${x},${y}`;
}

export async function streetArchiveFingerprint(file:Blob){
  const bytes=new Uint8Array(3*4096);
  await Promise.all([0,Math.floor(file.size/2),Math.max(0,file.size-4096)].map(async (at,index)=>{
    bytes.set(new Uint8Array(await file.slice(at,at+4096).arrayBuffer()),index*4096);
  }));
  const hash=await crypto.subtle.digest("SHA-256",bytes);
  return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,"0")).join("");
}

export class StreetIndexBundle {
  private cache=new Map<string,Promise<IndexShard>>();
  private proxyCache=new Map<string,Promise<ProxyShard>>();
  private readonly plantIds:Map<number,number>;
  private constructor(readonly file:Blob,readonly manifest:IndexManifest,private readonly dataStart:number){
    this.plantIds=new Map(manifest.plants.map(({hash},id)=>[hash,id]));
  }

  static async open(file:Blob,archive:Blob){
    const header=await file.slice(0,streetIndexBundleHeader.byteLength).arrayBuffer();
    if(header.byteLength!==streetIndexBundleHeader.byteLength||decoder.decode(header.slice(0,streetIndexBundleHeader.lengthOffset))!==streetIndexBundleHeader.magic)
      throw new Error("Unsupported world index format.");
    const size=new DataView(header).getUint32(streetIndexBundleHeader.lengthOffset,true), dataStart=streetIndexBundleHeader.byteLength+size;
    if(!size||size>maxManifest||dataStart>file.size)throw new Error("Invalid world index header.");
    const manifest=JSON.parse(await file.slice(streetIndexBundleHeader.byteLength,dataStart).text()) as IndexManifest;
    if(manifest.archive?.size!==archive.size||manifest.archive.fingerprint!==await streetArchiveFingerprint(archive))
      throw new Error("Saved world index belongs to a different archive.");
    if(!Array.isArray(manifest.plants)||!manifest.shards||
      manifest.terrain!==undefined&&manifest.terrain!==true||
      manifest.stagedMaps!==undefined&&manifest.stagedMaps!==true||
      manifest.propLods!==undefined&&manifest.propLods!==true||
      manifest.scanVersion!==undefined&&(!Number.isSafeInteger(manifest.scanVersion)||manifest.scanVersion<1)||
      ![manifest.total,manifest.maps,manifest.vegetation,manifest.models,manifest.placements].every(n=>Number.isSafeInteger(n)&&n>=0))
      throw new Error("Invalid world index manifest.");
    for(const [key,span] of Object.entries(manifest.shards)){
      if(key!=="wide"&&!/^-?\d+,-?\d+$/.test(key))throw new Error("Invalid world index cell.");
      if(!Array.isArray(span)||span.length!==2||!span.every(Number.isSafeInteger)||
        span[0]<0||span[1]<18||span[1]>maxShard||dataStart+span[0]+span[1]>file.size)
        throw new Error("Invalid world index range.");
    }
    return new StreetIndexBundle(file,manifest,dataStart);
  }

  private async shard(key:string,retain=true){
    const span=Object.hasOwn(this.manifest.shards,key)?this.manifest.shards[key]:undefined;
    if(!span)return;
    let pending=this.cache.get(key);
    pending??=(async()=>{
      const [offset,size]=span;
      const start=this.dataStart+offset;
      const bytes=new Uint8Array(await this.file.slice(start,start+size).arrayBuffer());
      const length=new DataView(bytes.buffer).getUint32(bytes.byteLength-4,true);
      if(length>maxShard)throw new Error("Oversized world index cell.");
      const rows=JSON.parse(decoder.decode(gunzipSync(bytes))) as IndexShard;
      if(!Array.isArray(rows.entities)||!Array.isArray(rows.models)||!Array.isArray(rows.vegetation))
        throw new Error("Invalid world index cell.");
      return rows;
    })();
    if(retain){
      this.cache.delete(key);
      this.cache.set(key,pending);
      if(this.cache.size>64)this.cache.delete(this.cache.keys().next().value!);
    }
    return pending;
  }

  private proxyShard(key:string){
    let pending=this.proxyCache.get(key);
    this.proxyCache.delete(key);
    pending??=this.shard(key,false).then(shard=>{
      const result:ProxyShard={skyline:[],bridge:[]};
      if(!shard)return result;
      const entries=shard.models.map(model=>{
        const {name,bounds}=model;
        const bridge=bridgeDeckProxy(name);
        const skyline=bounds&&bounds[5]-bounds[2]>=lowSkylineHeight&&/_(?:slod\d*[a-z]?|lod_s\d+)(?:_|$)/i.test(name)&&
          !/(?:_children_|_water|^[ns]\d+_[ew]\d+_)/i.test(name);
        return {model,bridge,skyline};
      });
      const models=new Map(entries.map(entry=>[entry.model.hash,entry]));
      for(const row of shard.entities){
        const entry=row.model===undefined?models.get(row.hash):entries[row.model];
        if(!entry?.bridge&&!entry?.skyline)continue;
        const asset=entry&&streetAsset(entry.model,row);
        if(!asset)continue;
        if(entry.bridge)result.bridge.push(asset);
        if(entry.skyline&&asset.kind==="skyline")result.skyline.push(asset);
      }
      return result;
    }).catch(()=>{this.proxyCache.delete(key);return {skyline:[],bridge:[]};});
    this.proxyCache.set(key,pending);
    if(this.proxyCache.size>640)this.proxyCache.delete(this.proxyCache.keys().next().value!);
    return pending;
  }

  async proxies(kind:keyof ProxyShard,[x,y]:readonly [number,number],radius:number,active:()=>boolean){
    const keys=[...indexShardKeys([x-radius,y-radius,x+radius,y+radius])].filter(key=>{
      if(!Object.hasOwn(this.manifest.shards,key))return false;
      const [left,bottom]=key.split(",").map(value=>Number(value)*indexShardSize);
      return Math.hypot(Math.max(left-x,x-left-indexShardSize,0),
        Math.max(bottom-y,y-bottom-indexShardSize,0))<=radius;
    });
    const assets:StreetAsset[]=[];
    for(let start=0;start<keys.length&&active();start+=8)
      for(const rows of await Promise.all(keys.slice(start,start+8).map(key=>this.proxyShard(key))))assets.push(...rows[kind]);
    return active()?assets:[];
  }

  async buildings([x,y]:readonly [number,number],radius:number,active:()=>boolean,select?:(name:string)=>boolean,includeTerrain=false){
    const keys=[...indexShardKeys([x-radius,y-radius,x+radius,y+radius])];
    const shards=await Promise.all(keys.map(key=>this.shard(key)));
    if(!active())return [];
    const assets:StreetAsset[]=[];
    const limit=radius*radius;
    for(const shard of shards){
      if(!shard)continue;
      const models=new Map(shard.models.map(model=>[model.hash,model]));
      for(const row of shard.entities){
        const [px,py]=row.placement.position;
        const dx=x-px,dy=y-py;
        if(dx*dx+dy*dy>limit)continue;
        const model=row.model===undefined?models.get(row.hash):shard.models[row.model];
        if(select&&model&&!select(model.name))continue;
        const asset=streetAsset(model,row,includeTerrain);
        if(asset)assets.push(asset);
      }
    }
    return assets;
  }

  async foliage([x,y]:readonly [number,number],distant=false){
    const reach=distant?canopyAtlasRadius:canopyQueryRadius;
    const keys=[...indexShardKeys([x-reach,y-reach,x+reach,y+reach]),"wide"];
    const shards=await Promise.all(keys.map(key=>this.shard(key)));
    const sources=new Map<number,IndexedVegetation>();
    for(const shard of shards)for(const row of shard?.vegetation??[]){
      const grass=!distant&&row.grass&&vegetationDistance(x,y,...row.grass)<=grassQueryRadius&&row.grassModels.some(hash=>this.plantIds.has(hash));
      const woody=row.woody&&vegetationDistance(x,y,...row.woody)<=reach&&row.woodyModels.some(hash=>this.plantIds.has(hash));
      if(grass||woody)sources.set(row.system[0],row);
    }
    return {sources:[...sources.values()],models:this.manifest.plants,modelIds:this.plantIds};
  }
}

import { gzipSync } from "fflate";
import { Archive } from "./archive";
import type { StreetAsset } from "./street-mesh";
import { decodeStreetCheckpoint, openStreetIndexCache, saveStreetIndexBundle } from "./street-index-cache";
import { batchPlant, PlacementDrawables, indexStreetPropLod, readIndexedPlacements, streetAsset, type IndexedPlacement } from "./street-index-placement";
import { StreetIndexBundle } from "./street-index-bundle";
import { indexScanVersion, indexSegmentSize, type Footprint, type IndexedMap, type IndexedVegetation, type ScanScope, type ScanSegment } from "./street-index-scan";
import { StreetRpf9 } from "./street-rpf9";
import { canopyAtlasRadius, canopyQueryRadius, grassQueryRadius, vegetationDistance, type VegetationModel } from "./street-vegetation";
import { streetBudgets } from "./street-capacity";
import type { PackReply, PackRequest, ScanReply, ScanRequest } from "./street-scan-worker";

export type StreetIndexStatus = {
  scanned:number; sampled:number; total:number; bytes:number; maps:number; vegetation:number; models:number;
  directorySegments?:number;
  restoreMs?:number;
  cached:number; savedBytes:number; savedSegments:number; estimatedSize:boolean; portable:boolean; portableError?:string; milliseconds:number; persistent:boolean; running:boolean; done:boolean; error?:string;
  packing?:{done:number;total?:number};
};
const cellSize=256;
function scanOrder(total:number){
  const order=[0];
  if(total>1)order.push(total-1);
  const queue:[number,number][]=[[0,total-1]];
  for(let i=0;i<queue.length;i++){
    const [left,right]=queue[i];
    if(right-left<2)continue;
    const middle=Math.floor((left+right)/2);
    order.push(middle);
    queue.push([left,middle],[middle,right]);
  }
  return order;
}

function sampleOrder(total:number){
  const stride=12,order:number[]=[];
  // Inspect evenly spaced parts of the archive first, then fill the gaps.
  // A sequential sample can spend the whole startup in unrelated resources.
  for(let column=0;column<3;column++)for(let row=0;row<4;row++)
    for(let segment=column+3*row;segment<total;segment+=stride)order.push(segment);
  return order;
}

class SpatialRows<T>{
  private readonly cells=new Map<number,Map<number,T[]>>();
  private readonly large:T[]=[];
  constructor(private readonly bounds:(row:T)=>Footprint){}
  clear(){this.cells.clear();this.large.length=0;}
  add(row:T){
    const [left,bottom,right,top]=this.bounds(row).map(value=>Math.floor(value/cellSize));
    if((right-left+1)*(top-bottom+1)>256){this.large.push(row);return;}
    for(let y=bottom;y<=top;y++){
      let columns=this.cells.get(y);
      if(!columns)this.cells.set(y,columns=new Map());
      for(let x=left;x<=right;x++){
        const cell=columns.get(x);
        if(cell)cell.push(row);else columns.set(x,[row]);
      }
    }
  }
  nearby([x,y]:readonly [number,number],radius:number){
    const rows=new Set(this.large);
    for(let col=Math.floor((x-radius)/cellSize);col<=Math.floor((x+radius)/cellSize);col++)
      for(let row=Math.floor((y-radius)/cellSize);row<=Math.floor((y+radius)/cellSize);row++)
        for(const item of this.cells.get(row)?.get(col)??[])rows.add(item);
    return [...rows].map(row=>({row,distance:vegetationDistance(x,y,...this.bounds(row))}))
      .filter(({distance})=>distance<=radius).sort((a,b)=>a.distance-b.distance).map(({row})=>row);
  }
}

const encoder=new TextEncoder();

function restore(db:IDBDatabase,key:string,apply:(segment:number,result:ScanSegment,size:number,estimated:boolean)=>void){
  return new Promise<void>((resolve,reject)=>{
    const tx=db.transaction("segments");
    const cursor=tx.objectStore("segments").openCursor(IDBKeyRange.bound([key,0],[key,Number.MAX_SAFE_INTEGER]));
    cursor.onsuccess=()=>{
      const row=cursor.result;
      if(!row)return;
      try{
        const value=row.value as Uint8Array|ScanSegment;
        const packed=value instanceof Uint8Array;
        const result=decodeStreetCheckpoint(value);
        apply((row.key as [string,number])[1],result,packed?value.byteLength:encoder.encode(JSON.stringify(result)).byteLength,!packed);
      }catch{ /* A damaged segment can be rebuilt during the next scan. */ }
      row.continue();
    };
    tx.oncomplete=()=>resolve();
    tx.onabort=()=>reject(tx.error);
  });
}

function checkpoint(db:IDBDatabase,key:string,segment:number,result:Uint8Array){
  return new Promise<void>((resolve,reject)=>{
    const tx=db.transaction("segments","readwrite",{durability:"relaxed"});
    tx.objectStore("segments").put(result,[key,segment]);
    tx.oncomplete=()=>resolve();
    tx.onabort=()=>reject(tx.error);
  });
}

function cachedBundle(db:IDBDatabase,key:string,kind:"spatial"|"bundle"){
  return new Promise<Blob|undefined>((resolve,reject)=>{
    const request=db.transaction("segments").objectStore("segments").get([kind,key]);
    request.onsuccess=()=>resolve(request.result instanceof Blob?request.result:undefined);
    request.onerror=()=>reject(request.error);
  });
}

export class LocalStreetIndex{
  private readonly scanned=new Set<number>();
  private readonly maps=new SpatialRows<IndexedMap>(row=>row.bounds);
  private readonly mapRoots=new Set<number>();
  private readonly nearbyModels=new Set<number>();
  private readonly grass=new SpatialRows<IndexedVegetation>(row=>row.grass!);
  private readonly woody=new SpatialRows<IndexedVegetation>(row=>row.woody!);
  private readonly drawables=new PlacementDrawables();
  private readonly models=this.drawables.models;
  private readonly propLods=this.drawables.propLods;
  private readonly plants:VegetationModel[]=[];
  private readonly plantIds=new Map<number,number>();
  private readonly entities=new Map<number,Promise<IndexedPlacement[]>>();
  private readonly archive:Archive;
  private readonly token:string;
  private db?:IDBDatabase;
  private started=0;
  private waiting?:Promise<void>;
  private scanning=false;
  private running=false;
  private scanGeneration=0;
  private closed=false;
  private cursor=0;
  private sampleCursor=0;
  private sampled=0;
  private readonly order:number[];
  private readonly samples:number[];
  private readonly priority=new Set<number>();
  private readonly focus=new Map<number,number>();
  private sharedPropSegments?:number[];
  private sharedPropCursor=0;
  private point?:readonly [number,number];
  private pointZ?:number;
  private hintCell="";
  private bytes=0;
  private directorySegments=0;
  private mapCount=0;
  private vegetationCount=0;
  private cached=0;
  private savedBytes=0;
  private savedSegments=0;
  private estimatedSize=false;
  private bundle?:StreetIndexBundle;
  private fallbackBundle?:StreetIndexBundle;
  private bundlePortable=false;
  private packWorker?:Worker;
  private packing?:StreetIndexStatus["packing"];
  private packingAttempted=false;
  private portableError?:string;
  private restoreMs?:number;
  private error?:string;
  readonly total:number;

  constructor(archive:Archive,private readonly publish:(stats:StreetIndexStatus,nearbyChanged:boolean)=>void,
    private readonly executable:Blob,private readonly bundleFile?:Blob){
    this.archive=new Archive(archive.path,archive.file);
    this.total=Math.ceil(archive.file.size/indexSegmentSize);
    this.order=scanOrder(this.total);
    this.samples=sampleOrder(this.total);
    const file=archive.file as File;
    this.token=`${file.size}:${file.lastModified??0}`;
  }

  private report(nearbyChanged=false){
    const saved=this.bundle??this.fallbackBundle,manifest=this.bundle?.manifest;
    this.publish({scanned:manifest?this.total:this.scanned.size,sampled:this.sampled,total:this.total,bytes:this.bytes,maps:manifest?.maps??this.mapCount,
      directorySegments:this.directorySegments||undefined,
      restoreMs:this.restoreMs,
      vegetation:manifest?.vegetation??this.vegetationCount,models:manifest?.models??this.models.size,cached:this.cached,
      savedBytes:saved?.file.size??this.savedBytes,savedSegments:saved?this.total:this.savedSegments,
      estimatedSize:!saved&&this.estimatedSize,portable:this.bundlePortable,portableError:this.portableError,
      milliseconds:performance.now()-this.started,persistent:!!this.db,running:this.running,
      done:this.complete,error:this.error,packing:this.packing},nearbyChanged);
  }

  private accept(segment:number,result:ScanSegment){
    if(this.scanned.has(segment))return false;
    this.scanned.add(segment);
    this.vegetationCount+=result.vegetation.length;
    let nearbyChanged=this.addMaps(result.maps);
    const point=this.point;
    for(const row of result.vegetation){
      if(row.grass)this.grass.add(row);
      if(row.woody)this.woody.add(row);
      if(point&&(row.grass&&vegetationDistance(...point,...row.grass)<=grassQueryRadius||
        row.woody&&vegetationDistance(...point,...row.woody)<=canopyQueryRadius))nearbyChanged=true;
    }
    for(const alias of result.aliases??[])
      if(this.drawables.addAlias(alias)&&this.nearbyModels.has(alias.hash))nearbyChanged=true;
    for(const candidate of result.models){
      if(!this.drawables.add(candidate))continue;
      if(this.nearbyModels.has(candidate.hash))nearbyChanged=true;
      for(const hash of this.drawables.references(candidate.hash)??[])
        if(this.nearbyModels.has(hash))nearbyChanged=true;
      if(this.models.get(candidate.hash)!==candidate)continue;
      const lod=indexStreetPropLod(this.propLods,candidate);
      if(lod!==undefined&&!this.models.has(lod)&&this.nearbyModels.has(lod))nearbyChanged=true;
      if(!batchPlant.test(candidate.name))continue;
      let id=this.plantIds.get(candidate.hash);
      if(id===undefined){id=this.plants.length;this.plantIds.set(candidate.hash,id);}
      this.plants[id]=candidate;
    }
    return nearbyChanged;
  }

  private addMaps(rows:IndexedMap[]){
    let nearbyChanged=false;
    const point=this.point;
    for(const row of rows){
      const root=row.pages[0][0];
      if(this.mapRoots.has(root))continue;
      this.mapRoots.add(root);
      this.maps.add(row);
      if(point&&vegetationDistance(...point,...row.bounds)<=450)nearbyChanged=true;
    }
    this.mapCount=this.mapRoots.size;
    return nearbyChanged;
  }

  start(){
    if(this.closed)return;
    const resumed=!this.running&&this.waiting;
    this.running=true;
    if(resumed&&!this.complete){
      this.error=undefined;
      this.report();
    }
    void this.prepare().then(()=>this.scan()).then(()=>this.compact());
  }

  prepare(){return this.waiting??=this.initialize();}

  pause(){
    if(!this.running)return;
    this.running=false;
    this.scanGeneration++;
    if(this.started&&!this.closed)this.report();
  }
  close(){this.closed=true;this.pause();this.packWorker?.terminate();this.db?.close();this.db=undefined;}
  ready(){return this.waiting??Promise.resolve();}

  prioritize(point:readonly [number,number],known:readonly StreetAsset[]=[],altitude?:number,terrain?:Promise<StreetAsset[]>){
    this.point=point;
    this.pointZ=altitude;
    if(this.bundle||this.bundleFile&&!this.portableError&&!this.fallbackBundle)return;
    if(!this.sharedPropSegments&&known.length){
      // Shared props can live in a different pack from their placements.
      // Use verified prop ranges from the build profile as hints only.
      const seeds=new Set(known.filter(asset=>/^prop_/i.test(asset.name))
        .map(asset=>Math.floor(asset.streams[0][0]/indexSegmentSize)));
      const segments=new Set<number>();
      for(const delta of [0,-1,1,-2,2,-3,3,-4,4,-5,5,-6,6,-7,7,-8,8]){
        for(const seed of seeds){
          const segment=seed+delta;
          if(segment>=0&&segment<this.total&&segments.size<17)segments.add(segment);
        }
      }
      this.sharedPropSegments=[...segments];
    }
    const [x,y]=point.map(value=>Math.floor(value/128)),key=`${x},${y}`;
    if(key===this.hintCell)return;
    this.hintCell=key;
    this.nearbyModels.clear();
    this.priority.clear();
    this.focus.clear();
    this.queueNearbyMaps(this.maps.nearby(point,450),point);
    const landmarks=known.map(asset=>({asset,distance:Math.hypot(asset.center[0]-point[0],asset.center[1]-point[1])}))
      .filter(({distance})=>distance<=600).sort((a,b)=>a.distance-b.distance).slice(0,4);
    for(const {asset,distance} of landmarks){
      this.queueFocus(Math.floor(asset.instance[0]/indexSegmentSize),2-distance/600);
      this.queueFocus(Math.floor(asset.streams[0][0]/indexSegmentSize),2-distance/600);
    }
    const baseOffsets=async ()=>{
      const authored=await terrain?.catch(()=>undefined)??[];
      return authored.filter(asset=>/_lod$/i.test(asset.name)&&
        Math.max(Math.abs(Math.floor(asset.center[0]/128)-x),Math.abs(Math.floor(asset.center[1]/128)-y))<=1)
        .map(asset=>asset.instance[0]);
    };
    void baseOffsets().then(offsets=>{
      if(this.hintCell!==key||this.closed)return;
      // Terrain ranges are available before the object index exists.
      for(const offset of offsets){
        const segment=Math.floor(offset/indexSegmentSize);
        if(!this.scanned.has(segment))this.priority.add(segment);
        this.queueNeighbors(segment);
      }
    }).catch(()=>{});
  }

  private queueNeighbors(segment:number){
    for(const neighbor of [segment-1,segment+1,segment-2,segment+2]){
      if(neighbor>=0&&neighbor<this.total&&!this.scanned.has(neighbor))this.priority.add(neighbor);
    }
  }

  private queueNearbyMaps(rows:IndexedMap[],point:readonly [number,number]){
    const scores=new Map<number,number>();
    for(const row of rows){
      const [left,bottom,right,top]=row.bounds;
      if(Math.max(right-left,top-bottom)>1600)continue;
      const distance=vegetationDistance(...point,left,bottom,right,top);
      if(distance>450)continue;
      const segment=Math.floor(row.pages[0][0]/indexSegmentSize);
      const box=row.streamingBounds,z=this.pointZ;
      // Keep the wider placement search and prioritize maps whose authored
      // streaming bounds intersect the native first-view query box.
      const containsFocus=box&&z!==undefined&&point[0]>=box[0]-.1&&point[0]<=box[3]+.1&&
        point[1]>=box[1]-.1&&point[1]<=box[4]+.1&&z>=box[2]-.1&&z<=box[5]+.1;
      const score=(1-distance/600)*(containsFocus?2:1);
      scores.set(segment,(scores.get(segment)??0)+score);
    }
    for(const [segment,score] of scores)this.queueFocus(segment,score);
  }

  private queueFocus(segment:number,score:number){
    // Many authored placement groups follow their corresponding drawables.
    // Also search forward for groups split across a segment boundary.
    for(const delta of [0,-1,-2,1,-3,2,-4,-5,-6,-7,-8]){
      const neighbor=segment+delta;
      if(neighbor<0||neighbor>=this.total||this.scanned.has(neighbor))continue;
      const priority=score/(1+Math.abs(delta)+(delta>0?.5:0));
      this.focus.set(neighbor,Math.max(priority,this.focus.get(neighbor)??0));
    }
  }

  private async initialize(){
    this.started=performance.now();
    let legacyKeys:string[]=[];
    const db=await (async()=>{
      const sample=await this.archive.read(0,Math.min(4096,this.archive.file.size));
      const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",sample)),
        byte=>byte.toString(16).padStart(2,"0")).join("");
      this.cacheKey=`scan-v${indexScanVersion}:${this.token}:${fingerprint}`;
      legacyKeys=[6,5].map(version=>`scan-v${version}:${this.token}:${fingerprint}`);
      return openStreetIndexCache();
    })().catch(()=>undefined);
    if(this.closed){db?.close();return;}
    this.db=db;
    const cached=db?await Promise.all([this.cacheKey,...legacyKeys].flatMap(key=>
      (["bundle","spatial"] as const).map(kind=>cachedBundle(db,key,kind).catch(()=>undefined)))):[];
    const spatial=new Set(cached.filter((_,i)=>i%2===1));
    for(const file of new Set([this.bundleFile,...cached])){
      if(!file)continue;
      try{
        const bundle=await StreetIndexBundle.open(file,this.archive.file);
        if(bundle.manifest.total!==this.total)throw new Error("Saved world index is incomplete.");
        if(this.closed)return;
        const currentScan=(bundle.manifest.scanVersion??5)>=indexScanVersion;
        const upgraded=currentScan&&bundle.manifest.terrain===true&&bundle.manifest.terrainLinks===true&&bundle.manifest.placementLods===true&&bundle.manifest.authoredLods===true&&
          bundle.manifest.stagedMaps===true&&bundle.manifest.propLods===true;
        this.portableError=undefined;
        const version=bundle.manifest.scanVersion??5;
        if(db&&file===this.bundleFile){
          const key=currentScan?this.cacheKey:legacyKeys[version===6?0:1];
          void saveStreetIndexBundle(db,"bundle",key,file).catch(()=>{});
        }
        const portable=file===this.bundleFile||!spatial.has(file);
        if(!upgraded){
          if(!this.fallbackBundle){this.fallbackBundle=bundle;this.bundlePortable=portable;}
          continue;
        }
        this.bundle=bundle;
        this.fallbackBundle=undefined;
        this.bundlePortable=portable;
        this.report(true);
        return;
      }catch(error){if(file===this.bundleFile)this.portableError=(error as Error).message;}
    }
    if(this.closed)return;
    if(this.bundleFile&&this.point)this.prioritize(this.point);
    let nearbyChanged=false;
    const restoreStarted=performance.now();
    try{
      if(db)await restore(db,this.cacheKey,(segment,result,size,estimated)=>{
        nearbyChanged=this.accept(segment,result)||nearbyChanged;
        this.savedBytes+=size;this.savedSegments++;this.estimatedSize||=estimated;
      });
      this.cached=this.scanned.size;
    }catch{this.db?.close();this.db=undefined;}
    if(db)this.restoreMs=performance.now()-restoreStarted;
    if(!this.closed)this.report(nearbyChanged||!!this.fallbackBundle);
  }

  private cacheKey="";

  private compact(){
    if(this.closed||this.bundle||this.packingAttempted||!this.db||!this.complete||this.savedSegments!==this.total)return;
    this.packingAttempted=true;
    const finish=()=>{
      this.packWorker?.terminate();
      this.packWorker=undefined;
      this.packing=undefined;
      if(!this.closed)this.report();
    };
    try{
      const worker=this.packWorker=new Worker(new URL("./street-scan-worker.js",import.meta.url),{type:"module"});
      this.packing={done:0};
      this.report();
      worker.onmessage=({data}:MessageEvent<PackReply>)=>{
        if("error" in data){finish();return;}
        if("done" in data){this.packing=data;this.report();return;}
        void StreetIndexBundle.open(data.file,this.archive.file).then(bundle=>{
          if(this.closed)return;
          this.bundle=bundle;
          this.fallbackBundle=undefined;
          this.bundlePortable=false;
          this.maps.clear();this.grass.clear();this.woody.clear();
          this.models.clear();this.propLods.clear();this.entities.clear();this.mapRoots.clear();this.nearbyModels.clear();this.plantIds.clear();
          this.plants.length=0;
          this.report(true);
        }).catch(()=>{}).finally(finish);
      };
      worker.onerror=event=>{event.preventDefault();finish();};
      worker.onmessageerror=finish;
      worker.postMessage({pack:true,file:this.archive.file,key:this.cacheKey,total:this.total} satisfies PackRequest);
    }catch{finish();}
  }

  private async scan(){
    if(this.scanning||this.closed||this.complete)return;
    this.scanning=true;
    this.error=undefined;
    const generation=this.scanGeneration;
    // The sparse reader uses about a MiB at a time. Keep it separate from the
    // full reader even when browser privacy settings report very few cores.
    const lanes=Math.max(2,streetBudgets.scanWorkers);
    let issued=0;
    const pending=new Set<number>();
    const next=(lane:number):{segment:number;scope:ScanScope}|undefined=>{
      const preferSamples=lane>=Math.ceil(lanes/2);
      for(;;){
        let focus:number|undefined,score=0;
        for(const [segment,weight] of this.focus){
          if(this.scanned.has(segment)||pending.has(segment)){this.focus.delete(segment);continue;}
          if(weight>score){score=weight;focus=segment;}
        }
        // First-camera range hints can reveal both map placements and their
        // drawables. Spend idle lanes on the broad sample once those reads are queued.
        let sharedProp:number|undefined;
        if(lane===lanes-1&&this.sharedPropSegments){
          while(this.sharedPropCursor<this.sharedPropSegments.length){
            const segment=this.sharedPropSegments[this.sharedPropCursor++];
            if(!this.scanned.has(segment)&&!pending.has(segment)){sharedProp=segment;break;}
          }
        }
        if(preferSamples&&this.point&&sharedProp===undefined&&focus===undefined&&this.priority.size===0){
          while(this.sampleCursor<this.total){
            const segment=this.samples[this.sampleCursor++];
            if(!this.scanned.has(segment)&&!pending.has(segment))return {segment,scope:"sample"};
          }
        }
        const urgent=sharedProp??focus??(issued%3!==0?this.priority.values().next().value:undefined);
        const segment=urgent??this.order[this.cursor++];
        if(segment===undefined)return undefined;
        this.priority.delete(segment);
        this.focus.delete(segment);
        if(this.scanned.has(segment)||pending.has(segment))continue;
        issued++;
        pending.add(segment);
        return {segment,scope:"full"};
      }
    };
    const lane=async(_:unknown,id:number)=>{
      let worker:Worker|undefined;
      let inline:StreetRpf9|undefined;
      let current:number|undefined;
      try{
        while(this.running&&generation===this.scanGeneration&&this.scanned.size<this.total){
          const task=next(id);
          if(!task)break;
          const {segment,scope}=task;
          current=scope==="full"?segment:undefined;
          let result:ScanSegment;
          const active=()=>!this.closed&&generation===this.scanGeneration;
          if(inline)result=await inline.readSegment(segment,scope,active,this.point);
          else try{
            // Each lane retains a reader and processes one segment at a time.
            worker??=new Worker(new URL("./street-scan-worker.js",import.meta.url),{type:"module"});
            const reader=worker;
            result=await new Promise<ScanSegment>((resolve,reject)=>{
              reader.onmessage=({data}:MessageEvent<ScanReply>)=>
                "result" in data?resolve(data.result):reject(new Error(data.error));
              reader.onerror=event=>{event.preventDefault();reject(new Error(event.message));};
              reader.onmessageerror=()=>reject(new Error("Archive worker response could not be read."));
              reader.postMessage({file:this.archive.file,segment,scope,executable:this.executable,point:this.point} satisfies ScanRequest);
            });
          }catch{
            worker?.terminate();worker=undefined;
            inline=new StreetRpf9(new Archive(this.archive.path,this.archive.file),this.executable);
            result=await inline.readSegment(segment,scope,active,this.point);
          }
          if(!active()){
            if(!this.closed&&current!==undefined)this.priority.add(current);
            break;
          }
          this.bytes+=result.bytes;
          if(result.directory)this.directorySegments++;
          const point=this.point;
          if(point)this.queueNearbyMaps(result.maps,point);
          if(scope==="sample"){
            this.sampled++;
            const nearbyChanged=this.addMaps(result.maps);
            if(result.maps.length||this.sampled%16===0)this.report(nearbyChanged);
            continue;
          }
          const nearbyChanged=this.accept(segment,result);
          pending.delete(segment);
          const db=this.db;
          if(db)try{
            const packed=gzipSync(encoder.encode(JSON.stringify(result)),{level:1});
            await checkpoint(db,this.cacheKey,segment,packed);
            this.savedBytes+=packed.byteLength;
            this.savedSegments++;
          }
          catch{if(this.db===db){db.close();this.db=undefined;}}
          if(!this.closed)this.report(nearbyChanged);
        }
      }catch(error){
        this.error=(error as Error).message;
        this.running=false;
        if(current!==undefined&&!this.scanned.has(current))this.priority.add(current);
        if(!this.closed)this.report();
      }finally{worker?.terminate();}
    };
    try{
      await Promise.all(Array.from({length:lanes},lane));
    }finally{
      this.scanning=false;
      if(this.running&&!this.closed&&generation!==this.scanGeneration&&!this.complete)void this.scan();
    }
  }

  async foliage(point:readonly [number,number],distant=false){
    const saved=this.bundle??this.fallbackBundle;
    if(saved)return saved.foliage(point,distant);
    const grass=distant?[]:this.grass.nearby(point,grassQueryRadius);
    const woody=this.woody.nearby(point,distant?canopyAtlasRadius:canopyQueryRadius);
    for(const row of grass)for(const hash of row.grassModels)this.nearbyModels.add(hash);
    for(const row of woody)for(const hash of row.woodyModels)this.nearbyModels.add(hash);
    const sources=[...new Set([
      ...grass.filter(row=>row.grassModels.some(hash=>this.plantIds.has(hash))),
      ...woody.filter(row=>row.woodyModels.some(hash=>this.plantIds.has(hash))),
    ])];
    return {sources,models:this.plants,modelIds:this.plantIds};
  }

  private readEntities(map:IndexedMap){
    const key=map.pages[0][0];
    let entry=this.entities.get(key);
    this.entities.delete(key);
    entry??=readIndexedPlacements(this.archive,map).catch(()=>[]);
    this.entities.set(key,entry);
    if(this.entities.size>768)this.entities.delete(this.entities.keys().next().value!);
    return entry;
  }

  get complete(){return !!this.bundle||this.scanned.size===this.total;}
  get hasRestoredSegments(){return this.cached>0;}
  get failed(){return this.error!==undefined;}

  async skyline(point:readonly [number,number],radius:number,active:()=>boolean){
    return (this.bundle??this.fallbackBundle)?.proxies("skyline",point,radius,active)??[];
  }

  async bridges(point:readonly [number,number],radius:number,active:()=>boolean){
    return (this.bundle??this.fallbackBundle)?.proxies("bridge",point,radius,active)??[];
  }

  async foreground(point:readonly [number,number],radius:number,active:()=>boolean){
    await this.ready();
    if(!active())return [];
    return this.bundle?.buildings(point,radius,active)??[];
  }

  async buildings([x,y]:readonly [number,number],radius:number,active:()=>boolean,select?:(name:string)=>boolean,includeTerrain=false){
    if(this.bundle)return this.bundle.buildings([x,y],radius,active,select,includeTerrain);
    const prior=this.fallbackBundle?.buildings([x,y],radius,active,select,includeTerrain).catch(()=>[])??[];
    const maps=this.maps.nearby([x,y],radius);
    const assets:StreetAsset[]=[];
    const stagedPages=this.fallbackBundle?new Set<number>():undefined;
    for(let start=0;start<maps.length&&active();start+=12){
      const records=await Promise.all(maps.slice(start,start+12).map(map=>this.readEntities(map)));
      if(!active())break;
      for(const rows of records)for(const row of rows){
        if(row.staged){stagedPages?.add(row.range[0]);continue;}
        const [px,py]=row.placement.position;
        if(Math.hypot(x-px,y-py)>radius)continue;
        this.nearbyModels.add(row.hash);
        const model=this.drawables.resolve(row);
        if(!model||select&&!select(model.name))continue;
        const asset=streetAsset(model,row,includeTerrain);
        if(asset)assets.push(asset);
      }
    }
    const fallback=await prior;
    if(!active())return [];
    if(!fallback.length)return assets;
    const current=new Set(assets.map(asset=>asset.id));
    return [...assets,...fallback.filter(asset=>!current.has(asset.id)&&!stagedPages?.has(asset.instance[0]))];
  }
}

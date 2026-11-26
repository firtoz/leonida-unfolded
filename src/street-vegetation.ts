import { inflate, readResources, view, type Archive } from "./archive";
import { emptyBounds, type Bounds } from "./native-spatial";
import type { InstanceTile, StreetChunk } from "./street-mesh";
import {streetBudgets} from "./street-capacity";

export type VegetationRange = [offset:number, stored:number, decoded:number, raw?:1];
export type VegetationModel = {name:string;hash:number;system:number;streams:number[][];geometryDescriptor?:number;bounds?:Bounds;drawable?:number;verified?:true;keyedOnly?:true;assetType?:1|2;
  graphicsRange?:import("./street-index-scan").IndexedGraphicsRange};
export type VegetationBatch = [
  model:number, at:number, start:number, count:number, grass:0|1, radius:number,
  left:number, bottom:number, right:number, top:number, instanceRadius?:number, fadeStart?:number, archetypeKey?:bigint,
  verticalBounds?:readonly [low:number,high:number]
];
type Footprint = [left:number,bottom:number,right:number,top:number];
export type VegetationLocator = {
  system:VegetationRange; graphics:VegetationRange[]; grass?:Footprint; woody?:Footprint; excluded?:number[];
  systemPages?:VegetationRange[];
};
export type VegetationSource = VegetationLocator & {batches:VegetationBatch[]};
export type VegetationLod = {
  ordinal:number; level:number; children:number; wholeBatch:boolean; instanceSlots:boolean;
  parent?:{ordinal:number;selector:number;instance:number;indices?:number[]};
};

export const grassDrawRadius=30, canopyDrawRadius=280;
export const nativePaletteMaterial=81;
export const nativePackedTintMaterial=82;
export const vegetationUpdateSize=16;
export const grassQueryRadius=grassDrawRadius+vegetationUpdateSize;
export const canopyQueryRadius=canopyDrawRadius+vegetationUpdateSize;
const coarseCanopyRadius=490;
export const distantCanopyRadius=740;
export const canopyAtlasRadius=1180;
const grassLimit=18, canopyLimit=30;

export function vegetationDistance(x:number,y:number,left:number,bottom:number,right:number,top:number){
  return Math.hypot(Math.max(left-x,0,x-right),Math.max(bottom-y,0,y-top));
}

export function nearbyVegetationSources(locators:VegetationLocator[],[x,y]:readonly [number,number]){
  const nearest=(key:"grass"|"woody",radius:number,limit:number)=>locators.flatMap(source=>{
    const bounds=source[key];
    const distance=bounds?vegetationDistance(x,y,...bounds):Infinity;
    return distance<=radius+vegetationUpdateSize?[{source,distance}]:[];
  }).sort((a,b)=>a.distance-b.distance||a.source.system[0]-b.source.system[0]).slice(0,limit);
  const candidates=[...nearest("grass",grassDrawRadius,48),...nearest("woody",canopyDrawRadius,64)]
    .sort((a,b)=>a.distance-b.distance);
  return [...new Set(candidates.map(({source})=>source))];
}

export function scanVegetation(data:DataView,models?:ReadonlyMap<number,number>,excluded:readonly number[]=[]){
  if(data.byteLength<0x50||data.getUint32(0x10,true)!==0x50524430||data.getUint8(0x14)!==0x7a)
    throw new Error("Invalid vegetation resource.");
  const table=Number(data.getBigUint64(0x38,true))-0x50000000;
  const count=data.getUint16(0x4c,true);
  if(table<0||table+16*count>data.byteLength)return {batches:[],graphicsSize:0};
  let graphicsSize=0;
  const blocks=Array.from({length:count},(_,i)=>{
    const at=table+16*i,type=data.getUint32(at,true),length=data.getUint32(at+4,true);
    const pointer=data.getBigUint64(at+8,true),offset=Number(pointer&0xfffffffn),segment=pointer>>28n;
    if(segment===6n)graphicsSize=Math.max(graphicsSize,offset+length);
    return {type,length,offset,segment};
  });
  const batches:VegetationBatch[]=[];
  const ignored=new Set(excluded);
  for(const {type,length,offset,segment} of blocks){
    if(segment!==5n||offset+length>data.byteLength||type!==0xba049770&&type!==0x7c475b5d)continue;
    const grass=type===0x7c475b5d?1:0,record=grass?416:368,ref=grass?0x178:0x90,box=grass?0x80:0xa0;
    if(length%record)continue;
    for(let at=offset;at<offset+length;at+=record){
      if(ignored.has(at))continue;
      const hash=data.getUint32(at+0x44,true),model=models?models.get(hash):hash;
      if(model===undefined)continue;
      const packed=data.getBigUint64(at+ref,true),instances=data.getUint16(at+ref+8,true);
      const block=blocks[Number(packed&0xfffffn)-1],skip=Number(packed>>20n);
      if(!instances||block?.segment!==6n||block.type!==(grass?0xed86f522:0xea6b3a96)||
        skip+instances*(grass?16:64)>block.length)continue;
      const lo=[0,4,8].map(i=>data.getFloat32(at+box+i,true)),hi=[16,20,24].map(i=>data.getFloat32(at+box+i,true));
      if(lo.some((v,i)=>Math.abs(v)>=50000||Math.abs(hi[i])>=50000||!(v<=hi[i]))||hi[2]<(grass?-1:-20))continue;
      const lod=data.getFloat32(at+(grass?0xb8:0x60),true);
      const radius=Number.isFinite(lod)&&lod>0?lod:grass?grassDrawRadius:canopyDrawRadius;
      const authored=data.getFloat32(at+(grass?0xbc:0x168),true);
      const batch:VegetationBatch=[model,at,block.offset+skip,instances,grass,radius,
        Math.floor(lo[0]),Math.floor(lo[1]),Math.ceil(hi[0]),Math.ceil(hi[1])];
      batch[13]=[lo[2],hi[2]];
      if(Number.isFinite(authored)&&authored>0&&Number.isFinite(lod)&&(grass?lod>=0&&lod<=authored:authored<=lod)){
        batch[10]=authored;
        if(grass)batch[11]=lod;
      }
      batches.push(batch);
    }
  }
  return {batches,graphicsSize};
}

export function vegetationDrawRadius(batch:VegetationBatch){
  const [,,,,grass,radius,,,,,instanceRadius]=batch;
  return Math.min(instanceRadius??radius,grass?grassDrawRadius:canopyDrawRadius);
}

// Prop-batch ordinals are appended to the ordinary entity pointer array.
export function readVegetationLods(data:DataView,batches:readonly VegetationBatch[]){
  const links=new Map<number,VegetationLod>();
  if(data.byteLength<0x50||data.getUint32(0x10,true)!==0x50524430||data.getUint8(0x14)!==0x7a)return links;
  const table=Number(data.getBigUint64(0x38,true))-0x50000000;
  const blocks=data.getUint16(0x4c,true),root=data.getUint32(0x20,true);
  if(table<0||table+16*blocks>data.byteLength||!root||root>blocks)return links;
  const entry=table+16*(root-1),map=Number(data.getBigUint64(entry+8,true))-0x50000000;
  if(data.getUint32(entry,true)!==0xd3593fa6||data.getUint32(entry+4,true)<0x154||
    map<0||map+0x154>data.byteLength)return links;
  const entities=data.getUint16(map+0xd8,true),count=data.getUint16(map+0x150,true),stride=0x170;
  const reference=data.getBigUint64(map+0x148,true),block=Number(reference&0xfffffn);
  if(!count||count>data.getUint16(map+0x152,true)||!block||block>blocks)return links;
  const row=table+16*(block-1),skip=Number(reference>>20n);
  const at=Number(data.getBigUint64(row+8,true))-0x50000000+skip,end=at+count*stride;
  if(data.getUint32(row,true)!==0xba049770||at<skip||end>data.byteLength||
    skip+count*stride>data.getUint32(row+4,true))return links;
  for(const [,offset,,,grass] of batches){
    if(grass||offset<at||offset>=end||(offset-at)%stride)continue;
    const ordinal=entities+(offset-at)/stride,level=data.getUint8(offset+0x7e);
    const children=data.getUint32(offset+0x68,true),parent=data.getInt16(offset+0x5c,true);
    const selector=data.getInt8(offset+0x7f),instance=data.getInt16(offset+0x5e,true);
    if(level>6)continue;
    const flags=data.getUint32(offset+0x48,true),wholeBatch=(flags&0x4800)===0x4000;
    const lod:VegetationLod={ordinal,level,children,wholeBatch,instanceSlots:!wholeBatch&&Boolean(flags&0x1800)};
    if(parent>=0&&(selector>=0||selector===-1&&!(flags&8))){
      const indices=flags&0x800?readParentIndices(offset):undefined;
      if(!(flags&0x800)||indices)lod.parent={ordinal:parent,selector,instance,indices};
    }
    links.set(offset,lod);
  }
  return links;

  function readParentIndices(offset:number){
    const size=data.getUint16(offset+0x88,true);
    if(!size)return [];
    const ref=data.getBigUint64(offset+0x80,true),block=Number(ref&0xfffffn),skip=Number(ref>>20n);
    if(!block||block>blocks)return;
    const entry=table+16*(block-1);
    const start=Number(data.getBigUint64(entry+8,true))-0x50000000+skip;
    if(data.getUint32(entry,true)!==0x12||skip+size*2>data.getUint32(entry+4,true)||
      start<skip||start+size*2>data.byteLength)return;
    return Array.from({length:size},(_,i)=>data.getInt16(start+i*2,true));
  }
}

export function uncoveredVegetationRanges(ranges:readonly Pick<InstanceTile,"first"|"count">[],
  ordinals:Uint16Array,covered:ReadonlySet<number>){
  const remaining:Pick<InstanceTile,"first"|"count">[]=[];
  for(const {first,count} of ranges)for(let index=first;index<first+count;index++){
    if(covered.has(ordinals[index]))continue;
    const prior=remaining.at(-1);
    if(prior&&prior.first+prior.count===index)prior.count++;
    else remaining.push({first:index,count:1});
  }
  return remaining;
}

export function sameVegetationAffinesByOrdinal(a:StreetChunk["instances"],b:StreetChunk["instances"],count:number){
  if(!a?.affine||!b?.affine||!a.ordinals||!b.ordinals||!count||
    a.ordinals.length!==count||b.ordinals.length!==count||a.poses.length!==16*count||b.poses.length!==16*count)return false;
  const offsetsByOrdinal=new Uint32Array(count);
  for(const [index,ordinal] of a.ordinals.entries()){
    if(ordinal>=count||offsetsByOrdinal[ordinal])return false;
    offsetsByOrdinal[ordinal]=index+1;
  }
  for(const [index,ordinal] of b.ordinals.entries()){
    const match=offsetsByOrdinal[ordinal];
    if(!match)return false;
    for(let component=0;component<12;component++)
      if(a.poses[16*(match-1)+component]!==b.poses[16*index+component])return false;
    offsetsByOrdinal[ordinal]=0;
  }
  return true;
}

export function nativePackedRange(batch:VegetationBatch){
  return batch[4]&&batch[12]!==undefined?batch[10]:undefined;
}

// The native affine group truncates its authored start and adds a 20 m fade.
const nativeAffineFadeLength=20;
function nativeAffineFadeStart(batch:VegetationBatch,key:bigint|undefined){
  return !batch[4]&&key!==undefined&&batch[10]!==undefined?Math.trunc(batch[10]):undefined;
}

export function nativeVegetationRadius(batch:VegetationBatch,key=batch[12]){
  const start=nativeAffineFadeStart(batch,key);
  return start===undefined?batch[10]??batch[5]:start+nativeAffineFadeLength;
}

export function vegetationCandidates(sources:VegetationSource[],[x,y]:readonly [number,number]){
  const candidates=sources.flatMap(source=>source.batches.flatMap(batch=>{
    const [,,,,,,left,bottom,right,top]=batch;
    const drawRadius=batch[12]===undefined?vegetationDrawRadius(batch):nativeVegetationRadius(batch);
    const distance=vegetationDistance(x,y,left,bottom,right,top);
    return distance<=drawRadius+vegetationUpdateSize?[{source,batch,drawRadius,distance}]:[];
  })).sort((a,b)=>a.distance-b.distance||a.source.system[0]-b.source.system[0]||a.batch[1]-b.batch[1]);
  let grass=0,canopy=0;
  return candidates.filter(({batch})=>batch[12]!==undefined||(batch[4]?grass++<grassLimit:canopy++<canopyLimit));
}

export function canopyModel(model:VegetationModel|undefined){
  const bounds=model?.bounds;
  return Boolean(bounds&&bounds[5]-bounds[2]>=2.25&&/^veg_(?:tree|palm|bush)_/.test(model.name)&&
    !/_(?:dead|support|branch|log|stump)(?:_|$)/.test(model.name));
}

export function vegetationBatchId(source:VegetationLocator,batch:VegetationBatch){
  return `vegetation:${source.system[0].toString(16)}-${batch[1].toString(16)}`;
}

export function nativePackedPlantCandidates(sources:VegetationSource[],[x,y]:readonly [number,number],
  models:readonly VegetationModel[],inView:(bounds:Bounds,range:number)=>boolean,occupied:ReadonlySet<string>){
  return sources.flatMap(source=>source.batches.flatMap(batch=>{
    const [model,,,count,,,left,bottom,right,top,,,,vertical]=batch;
    const drawRadius=nativePackedRange(batch),bounds=models[model]?.bounds;
    if(!drawRadius||!vertical||!bounds||occupied.has(vegetationBatchId(source,batch)))return [];
    const distance=vegetationDistance(x,y,left,bottom,right,top);
    if(distance>drawRadius+vegetationUpdateSize)return [];
    const extent=Math.max(...bounds.map(Math.abs));
    if(!inView([left-extent,bottom-extent,vertical[0]-extent,right+extent,top+extent,vertical[1]+extent],
      drawRadius+vegetationUpdateSize))return [];
    const width=Math.max(bounds[3]-bounds[0],bounds[4]-bounds[1]);
    const score=width*Math.sqrt(Math.min(128,count))/(distance+80)**2;
    return [{source,batch,drawRadius,score}];
  })).sort((a,b)=>b.score-a.score||a.source.system[0]-b.source.system[0]||a.batch[1]-b.batch[1]);
}

export function visibleNativeCanopyCandidates(sources:VegetationSource[],[x,y]:readonly [number,number],
  models:readonly VegetationModel[],inView:(bounds:Bounds,range:number)=>boolean,occupied:ReadonlySet<string>){
  return sources.flatMap(source=>source.batches.flatMap(batch=>{
    const [model,,,count,grass,,left,bottom,right,top,,,key,vertical]=batch;
    const bounds=models[model]?.bounds;
    if(grass||key===undefined||!vertical||!bounds||occupied.has(vegetationBatchId(source,batch)))return [];
    const drawRadius=nativeVegetationRadius(batch);
    const distance=vegetationDistance(x,y,left,bottom,right,top);
    const extent=Math.max(...bounds.map(Math.abs));
    if(distance>drawRadius||!inView([left-extent,bottom-extent,vertical[0]-extent,
      right+extent,top+extent,vertical[1]+extent],drawRadius))return [];
    const score=(bounds[5]-bounds[2])*Math.sqrt(count)/(distance+35);
    return [{source,batch,drawRadius,score}];
  })).sort((a,b)=>b.score-a.score||a.source.system[0]-b.source.system[0]||a.batch[1]-b.batch[1]);
}

export function distantCanopyCandidates(sources:VegetationSource[],[x,y]:readonly [number,number],
  models:readonly VegetationModel[],onScreen:(bounds:Bounds)=>boolean,nearBatches:ReadonlySet<string>,
  linkedFallback?:(source:VegetationSource,batch:VegetationBatch)=>boolean){
  const candidates=sources.flatMap(source=>source.batches.flatMap(batch=>{
    const [model,,,count,grass,,left,bottom,right,top]=batch;
    const distance=vegetationDistance(x,y,left,bottom,right,top);
    if(grass||distance<96&&!linkedFallback?.(source,batch)||distance>distantCanopyRadius||!canopyModel(models[model])||
      nearBatches.has(vegetationBatchId(source,batch)))return [];
    const bounds=models[model].bounds!;
    const visible=onScreen([left,bottom,-10,right,top,52]);
    const score=(bounds[5]-bounds[2])*Math.sqrt(Math.min(24,count))/(distance+35);
    return [{source,batch,drawRadius:distantCanopyRadius,outer:distance>coarseCanopyRadius,visible,score}];
  })).sort((a,b)=>Number(b.visible)-Number(a.visible)||b.score-a.score||
    a.source.system[0]-b.source.system[0]||a.batch[1]-b.batch[1]);
  return [...candidates.filter(row=>!row.outer).slice(0,12),...candidates.filter(row=>row.outer).slice(0,10)];
}

export function distantCanopyAtlasCandidates(sources:VegetationSource[],[x,y]:readonly [number,number],
  models:readonly VegetationModel[],onScreen:(bounds:Bounds)=>boolean,occupied:ReadonlySet<string>,
  focus?:{fov:number;aspect:number;onScreen:(bounds:Bounds)=>boolean}){
  const defaultCellSize=112;
  const horizontalSpan=focus?Math.tan(focus.fov*Math.PI/360)*focus.aspect:Infinity;
  const cellSize=Math.max(80,Math.min(defaultCellSize,
    Math.round(defaultCellSize*horizontalSpan/(Math.tan(Math.PI/8)*16/9))));
  const focused=cellSize<defaultCellSize;
  const visibleSectorLimit=Math.ceil(5*defaultCellSize/cellSize);
  // Narrow views can spend more slots on visible stands without filling the atlas cache with turn reserve.
  const innerLimit=focused?20:24;
  const candidates=sources.flatMap(source=>source.batches.flatMap(batch=>{
    const [model,,,count,grass,,left,bottom,right,top]=batch;
    const distance=vegetationDistance(x,y,left,bottom,right,top),plant=models[model];
    if(grass||distance<230||distance>canopyAtlasRadius||!canopyModel(plant)||
      occupied.has(vegetationBatchId(source,batch)))return [];
    const bounds=plant.bounds!;
    const dx=(left+right)*.5-x,dy=(bottom+top)*.5-y;
    const sector=Math.floor((Math.atan2(dy,dx)+Math.PI)*4/Math.PI)%8;
    const cell=`${Math.floor((left+right)/(2*cellSize))},${Math.floor((bottom+top)/(2*cellSize))}`;
    const footprint:Bounds=[left,bottom,-10,right,top,52];
    const visible=onScreen(footprint),outer=distance>distantCanopyRadius;
    if(outer&&!visible)return [];
    const inView=focused&&Boolean(focus?.onScreen(footprint));
    const score=(bounds[5]-bounds[2])*Math.sqrt(Math.min(96,count))/(distance+80);
    return [{source,batch,drawRadius:outer?canopyAtlasRadius:distantCanopyRadius,visible,inView,score,sector,cell,outer}];
  })).sort((a,b)=>Number(b.inView)-Number(a.inView)||Number(b.visible)-Number(a.visible)||b.score-a.score||
    a.source.system[0]-b.source.system[0]||a.batch[1]-b.batch[1]);
  const cells=new Set<string>(),sectors=new Uint8Array(8),outerSectors=new Uint8Array(8);
  const selected:typeof candidates=[];
  let inner=0,outer=0;
  for(const row of candidates){
    if(cells.has(row.cell))continue;
    if(row.outer){
      if(outer>=10||outerSectors[row.sector]>=4)continue;
      outer++;outerSectors[row.sector]++;
    }else{
      if(inner>=innerLimit||sectors[row.sector]>=(row.inView?visibleSectorLimit:5))continue;
      inner++;sectors[row.sector]++;
    }
    selected.push(row);cells.add(row.cell);
    if(inner===innerLimit&&outer===10)break;
  }
  return selected;
}

export function broadleafCanopyCandidates(sources:VegetationSource[],[x,y]:readonly [number,number],
  models:readonly VegetationModel[],onScreen:(bounds:Bounds)=>boolean,occupied:ReadonlySet<string>,limit=16,
  shrubs=false){
  const candidates=sources.flatMap(source=>source.batches.flatMap(batch=>{
    const [model,,,count,grass,reach,left,bottom,right,top,instanceRadius]=batch,plant=models[model];
    const bounds=plant?.bounds;
    if(grass||!bounds||
      occupied.has(vegetationBatchId(source,batch))||!onScreen([left,bottom,-10,right,top,52]))return [];
    const distance=vegetationDistance(x,y,left,bottom,right,top);
    const height=bounds[5]-bounds[2],width=Math.max(bounds[3]-bounds[0],bounds[4]-bounds[1]);
    if(shrubs){
      // Smaller authored bushes have their own atlas and should not compete with tree crowns.
      if(!/^veg_bush_/i.test(plant.name)||height<=0||canopyModel(plant)||
        distance<32||distance>Math.min(440,instanceRadius??reach))return [];
    }else if(!canopyModel(plant)||/_palm(?:_|$)/i.test(plant.name)||distance<96||distance>distantCanopyRadius)return [];
    // The authored stand size remains informative when the atlas samples its transforms.
    const score=height*width*Math.sqrt(Math.min(shrubs?96:192,count))/(distance+80)**2;
    const cell=`${Math.floor((left+right)/160)},${Math.floor((bottom+top)/160)}`;
    return [{source,batch,drawRadius:shrubs?440:distantCanopyRadius,score,cell}];
  })).sort((a,b)=>b.score-a.score||a.source.system[0]-b.source.system[0]||a.batch[1]-b.batch[1]);
  const cells=new Map<string,number>();
  const selected:typeof candidates=[];
  for(const row of candidates){
    const count=cells.get(row.cell)??0;
    if(count>=(shrubs?2:3))continue;
    cells.set(row.cell,count+1);
    selected.push(row);
    if(selected.length===limit)break;
  }
  return selected;
}

async function vegetationPage(archive:Archive,[offset,size,decoded,raw]:VegetationRange){
  return decodeVegetationPage(await archive.read(offset,size),decoded,raw);
}

function decodeVegetationPage(stored:Uint8Array,decoded:number,raw:1|undefined){
  const bytes=raw?stored:inflate(stored,decoded);
  if(bytes.length!==decoded)throw new Error("Invalid vegetation page length.");
  return bytes;
}

export async function readVegetationHeader(archive:Archive,source:VegetationLocator){
  if(source.systemPages){
    const pages=source.systemPages;
    const bytes=new Uint8Array(pages.reduce((size,page)=>size+page[2],0));
    let cursor=0,index=0;
    for await(const {bytes:stored} of readResources(archive,pages.map(([offset,length])=>[offset,length]))){
      const [,,decoded,raw]=pages[index++];
      bytes.set(decodeVegetationPage(stored,decoded,raw),cursor);
      cursor+=decoded;
    }
    return view(bytes);
  }
  return view(await vegetationPage(archive,source.system));
}

export async function readVegetationSource(archive:Archive,source:VegetationLocator,cachedHeader?:DataView){
  const data=cachedHeader??await readVegetationHeader(archive,source);
  if(data.getUint32(0x10,true)!==0x50524430||data.getUint8(0x14)!==0x7a)
    throw new Error("Invalid vegetation resource.");
  return {...readVegetationGraphics(archive,source,data),data};
}

type VegetationStorage={
  data?:DataView;
  instanceLayouts?:ReadonlyMap<number,VegetationInstanceLayout>;
  pages:Map<number,Promise<Uint8Array>>;
  instances(start:number,size:number):Promise<DataView>;
};

type VegetationPageCache={bytes:number;entries:Map<string,{bytes:number;data:Promise<Uint8Array>}>};
const vegetationPages=new WeakMap<Archive,VegetationPageCache>();
const vegetationPageKey=([offset,stored,decoded,raw]:VegetationRange)=>`${offset}:${stored}:${decoded}:${raw??0}`;

export function readVegetationGraphics(archive:Archive,source:VegetationLocator,
  header:DataView|ReadonlyMap<number,VegetationInstanceLayout>):VegetationStorage{
  let cache=vegetationPages.get(archive);
  if(!cache){
    cache={bytes:0,entries:new Map()};
    vegetationPages.set(archive,cache);
  }
  const shared=cache,capacity=streetBudgets.drawableBytes/2;
  return {
    data:header instanceof DataView?header:undefined,
    instanceLayouts:header instanceof DataView?undefined:header,
    pages:new Map<number,Promise<Uint8Array>>(),
    async instances(start:number,size:number){
      const bytes=new Uint8Array(size);
      const jobs:{index:number;page:VegetationRange;base:number;from:number;to:number}[]=[];
      let base=0,copied=0;
      for(const [index,page] of source.graphics.entries()){
        const end=base+page[2],from=Math.max(start,base),to=Math.min(start+size,end);
        if(from<to)jobs.push({index,page,base,from,to});
        if(end>=start+size)break;
        base=end;
      }
      const missing=jobs.filter(({index,page})=>{
        const key=vegetationPageKey(page),resident=shared.entries.get(key);
        if(resident){
          shared.entries.delete(key);
          shared.entries.set(key,resident);
          if(!this.pages.has(index))this.pages.set(index,resident.data);
          return false;
        }
        return !this.pages.has(index);
      });
      if(missing.length){
        const read=(async()=>{
          const stored:Uint8Array[]=[];
          for await(const {bytes} of readResources(archive,missing.map(({page})=>[page[0],page[1]])))stored.push(bytes);
          return stored;
        })();
        for(const [i,{index,page}] of missing.entries()){
          this.pages.set(index,read.then(stored=>decodeVegetationPage(stored[i],page[2],page[3])));
        }
      }
      await Promise.all(jobs.map(async ({index,page,base,from,to})=>{
        const key=vegetationPageKey(page),data=this.pages.get(index)!;
        if(!shared.entries.has(key)&&page[2]<=capacity){
          const entry={bytes:page[2],data};
          shared.entries.set(key,entry);shared.bytes+=entry.bytes;
          for(const [old,resident] of shared.entries){
            if(shared.bytes<=capacity)break;
            shared.entries.delete(old);shared.bytes-=resident.bytes;
          }
          void data.catch(()=>{
            if(shared.entries.get(key)!==entry)return;
            shared.entries.delete(key);shared.bytes-=entry.bytes;
          });
        }
        let cached:Uint8Array;
        try{cached=await data;}
        catch(error){
          if(this.pages.get(index)===data)this.pages.delete(index);
          throw error;
        }
        bytes.set(cached.subarray(from-base,to-base),from-start);
        copied+=to-from;
      }));
      if(copied!==size)throw new Error("Invalid vegetation instance range.");
      return view(bytes);
    },
  };
}

export type VegetationInstanceLayout=ReturnType<typeof vegetationInstanceLayout>;

export function vegetationInstanceLayout(batch:VegetationBatch,table:DataView,identity:number|bigint){
  const [,at,start,count,grass]=batch;
  const record=grass?416:368,refOffset=grass?0x178:0x90;
  if(at<0||at+record>table.byteLength||(typeof identity==="bigint"?table.getBigUint64(at+0x20,true)!==identity:
    table.getUint32(at+0x44,true)!==identity))
    throw new Error("Invalid vegetation batch.");
  const reference=table.getBigUint64(at+refOffset,true),block=Number(reference&0xfffffn)-1;
  const blockCount=table.getUint16(0x4c,true),blockBase=Number(table.getBigUint64(0x38,true))-0x50000000;
  const entry=blockBase+16*block,stride=grass?16:64,skip=Number(reference>>20n),size=count*stride;
  if(block<0||block>=blockCount||blockBase<0||blockBase+16*blockCount>table.byteLength||
      table.getUint16(at+refOffset+8,true)!==count||table.getUint32(entry,true)!==(grass?0xed86f522:0xea6b3a96)||
      skip+size>table.getUint32(entry+4,true)||Number(table.getBigUint64(entry+8,true))-0x60000000+skip!==start)
    throw new Error("Invalid vegetation instance table.");
  const boundsAt=at+(grass?0x80:0xa0);
  const low=[0,4,8].map(i=>table.getFloat32(boundsAt+i,true));
  const high=[0,4,8].map(i=>table.getFloat32(boundsAt+16+i,true));
  if(low.some((v,i)=>!Number.isFinite(v)||!Number.isFinite(high[i])||v>high[i]))throw new Error("Invalid vegetation bounds.");
  const scaleMin=grass?table.getFloat32(at+0xa0,true):1,scaleMax=grass?table.getFloat32(at+0xa4,true):1;
  if(grass&&(!Number.isFinite(scaleMin)||scaleMin<0||scaleMax<scaleMin||!(scaleMax<=10)))
    throw new Error("Invalid vegetation scale.");
  return {low,high,scaleMin,scaleMax,stride};
}

export async function readVegetationBatch(batch:VegetationBatch,storage:ReturnType<typeof readVegetationGraphics>,modelHash:number){
  const [,at,start,count]=batch;
  const {data:header,instanceLayouts}=storage;
  const layout=header?vegetationInstanceLayout(batch,header,batch[12]??modelHash):instanceLayouts?.get(at);
  if(!layout)throw new Error("Invalid vegetation batch.");
  const data=await storage.instances(start,count*layout.stride);
  return {data,...layout};
}

export async function placeVegetation(mesh:StreetChunk,model:VegetationModel,batch:VegetationBatch,
  storage:VegetationStorage,id:string,radius:number,sampleLimit?:number,authoredDistance=true):Promise<StreetChunk>{
  const [,,,count,grass]=batch;
  const {data,low,high,scaleMin,scaleMax,stride}=await readVegetationBatch(batch,storage,model.hash);
  const origin:StreetChunk["origin"]=[Math.floor(low[0]/32)*32,Math.floor(low[1]/32)*32,0];
  const groups=new Map<string,{poses:number[];ids:string[];ordinals:number[];bounds:Bounds}>();
  // Spread the budget across the full authored batch, keeping the same instances as the camera moves.
  const samples=Math.min(count,sampleLimit??(grass?256:512));
  const tileSize=grass?(radius>grassDrawRadius?24:8):32;
  const keyedAffine=!grass&&batch[12]!==undefined;
  for(let sample=0;sample<samples;sample++){
    const i=Math.floor((sample+.5)*count/samples),offset=i*stride;
    const position=grass?low.map((v,axis)=>v+(high[axis]-v)*data.getUint16(offset+axis*2,true)/65535):
      [12,28,44].map(delta=>data.getFloat32(offset+delta,true));
    // The authored geometry box can exclude the pivot of a keyed affine model.
    if(!position.every((value,axis)=>keyedAffine?Math.abs(value)<50000:
      value>=low[axis]-.02&&value<=high[axis]+.02))continue;
    let matrix:number[];
    if(grass){
      const scale=scaleMin+(scaleMax-scaleMin)*data.getUint8(offset+11)/255;
      if(scale<=.001)continue;
      const x=data.getUint8(offset+6)/127.5-1,y=data.getUint8(offset+7)/127.5-1;
      const horizontal=x*x+y*y,z=Math.sqrt(Math.max(.0001,1-horizontal)),k=(1-z)/horizontal;
      const xx=1-x*x*k,xy=-x*y*k,yy=1-y*y*k;
      // The ordinary packed shader selects one of 72 headings in five-degree steps.
      // Apply heading before tilt so it rotates about the plant's local up axis.
      const heading=(data.getUint8(offset+13)%72)*Math.PI/36;
      const c=Math.cos(heading),s=Math.sin(heading);
      matrix=[xx*c+xy*s,xy*c-xx*s,x,xy*c+yy*s,yy*c-xy*s,y,-x*c-y*s,x*s-y*c,z].map(v=>v*scale);
    }else{
      matrix=[0,4,8,16,20,24,32,36,40].map(delta=>data.getFloat32(offset+delta,true));
      const [a,b,c,d,e,f,g,h,k]=matrix,det=Math.abs(a*(e*k-f*h)-b*(d*k-f*g)+c*(d*h-e*g));
      if(!(det>.0001&&det<1000))continue;
    }
    const key=position.slice(0,2).map(v=>Math.floor(v/tileSize)).join(",");
    let group=groups.get(key);
    if(!group){group={poses:[],ids:[],ordinals:[],bounds:emptyBounds()};groups.set(key,group);}
    const local=position.map((v,axis)=>v-origin[axis]);
    group.poses.push(...local,...matrix);
    if(grass&&mesh.packedVegetationTint){
      group.poses.push(data.getUint8(offset+8)/255,data.getUint8(offset+9)/255,data.getUint8(offset+10)/255,2);
    }else group.poses.push(1,1,1,1);
    group.ids.push(id+":"+i);
    if(!grass)group.ordinals.push(i);
    for(let axis=0;axis<3;axis++){
      let lo=local[axis],hi=lo;
      for(let j=0;j<3;j++){
        const a=mesh.bounds[j]*matrix[axis*3+j],b=mesh.bounds[j+3]*matrix[axis*3+j];
        lo+=Math.min(a,b);hi+=Math.max(a,b);
      }
      group.bounds[axis]=Math.min(group.bounds[axis],lo);
      group.bounds[axis+3]=Math.max(group.bounds[axis+3],hi);
    }
  }
  if(!groups.size)throw new Error("Empty vegetation batch.");
  const ids:string[]=[],tiles:InstanceTile[]=[],bounds=emptyBounds();
  const poses=new Float32Array([...groups.values()].reduce((n,g)=>n+g.poses.length,0));
  const ordinals=grass?undefined:new Uint16Array(poses.length/16);
  for(const group of groups.values()){
    poses.set(group.poses,ids.length*16);
    ordinals?.set(group.ordinals,ids.length);
    tiles.push({first:ids.length,count:group.ids.length,bounds:group.bounds});
    for(const instance of group.ids)ids.push(instance);
    for(let i=0;i<3;i++){
      bounds[i]=Math.min(bounds[i],group.bounds[i]);bounds[i+3]=Math.max(bounds[i+3],group.bounds[i+3]);
    }
  }
  const instanceRadius=authoredDistance?batch[10]:undefined;
  const linearFade=authoredDistance&&nativeAffineFadeStart(batch,batch[12])!==undefined;
  // Retain the authored fade width when the viewer's draw budget caps the range.
  const fadeWidth=linearFade?nativeAffineFadeLength:
    instanceRadius===undefined?0:instanceRadius-(batch[11]??instanceRadius);
  const fade=instanceRadius===undefined?undefined:Math.max(0,radius-fadeWidth);
  return {...mesh,id,modelName:model.name,origin,bounds,vegetation:radius,vegetationFadeStart:fade,
    vegetationLinearFade:linearFade?true:undefined,
    instances:{poses,ids,affine:true,tiles,ordinals}};
}

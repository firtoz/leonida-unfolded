import { Inflate } from "fflate";
import { readResources, view, type Archive, type Range } from "./archive";
import { joaat } from "./places";
import { placementLayout, type MapPage } from "./street-placement-probe";
import { readPlacement } from "./street-placement";
import { scanVegetation, type VegetationLocator, type VegetationModel } from "./street-vegetation";
import type { Bounds } from "./native-spatial";
import { readDrawableAliases, type DrawableAlias } from "./street-archetypes";

export type Footprint = [number,number,number,number];
export type IndexedMap = { bounds:Footprint; streamingBounds?:Bounds; pages:MapPage[] };
export type VisitIndexedMap = (pages:MapPage[],data:DataView)=>void;
export type IndexedVegetation = VegetationLocator & {
  graphicsStart:number; graphicsSize:number; grassModels:number[]; woodyModels:number[];
};
export type ScanSegment = { maps:IndexedMap[]; vegetation:IndexedVegetation[]; models:VegetationModel[];
  bytes:number; aliases?:DrawableAlias[]; directory?:boolean };
export type ScanScope = "sample" | "full";
export type StreetMemberRange = {offset:number;end:number;type?:number;chunks?:readonly number[];streamingBounds?:Bounds};
export type IndexedGraphicsRange = {end:number;chunks?:readonly number[]};
export const indexSegmentSize = 64 * 1024 * 1024;
export const indexScanVersion=8;
const windowSize = 8 * 1024 * 1024;
const maxPage = 2 * 1024 * 1024;
const maxGraphicsPage = 32 * 1024 * 1024;
const pageAlignment = 4096;
const align = (value:number) => Math.ceil(value/16)*16;
const names = /(?:^|\0)([a-z0-9_][a-z0-9_.-]{1,159})\.#dr\0/gi;
const decoder = new TextDecoder("latin1");

export function growBounds(a:Footprint|undefined,b:Footprint):Footprint {
  return a ? [Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3])] : b;
}

function zlibHeader(bytes:Uint8Array,at:number){
  return bytes[at]===0x78 && !(bytes[at+1]&32) && (0x7800+bytes[at+1])%31===0;
}

function adler(bytes:Uint8Array){
  let sum=1, weighted=0;
  for(let from=0;from<bytes.length;from+=5552){
    for(let i=from,end=Math.min(from+5552,bytes.length);i<end;i++){sum+=bytes[i];weighted+=sum;}
    sum%=65521;weighted%=65521;
  }
  return ((weighted<<16)|sum)>>>0;
}

function carvedZlibReader(decodedLimit:number){
  const chunks:Uint8Array[]=[];
  let length=0,from=2,trailer:number|undefined,failed=false;
  // fflate 0.8.3 retains the unread input and current bit offset. The zlib
  // trailer gives an independent check on both the end offset and output.
  const stream=new Inflate(chunk=>{
    length+=chunk.length;
    if(length>decodedLimit)throw new Error("Oversized archive stream");
    if(chunk.length)chunks.push(chunk);
  }) as unknown as {push:Inflate["push"];p:Uint8Array;s:{f?:number;p:number;l?:unknown}};
  return {
    get failed(){return failed;},
    read(input:Uint8Array){
      if(failed)return;
      try{
        while(trailer===undefined&&from<input.length){
          const end=Math.min(from+65536,input.length);
          stream.push(input.subarray(from,end),false);
          if(stream.s.f&&!stream.s.l)trailer=end-stream.p.length+(stream.s.p?1:0);
          from=end;
        }
        if(trailer===undefined||trailer+4>input.length)return;
        let bytes=chunks[0];
        if(chunks.length!==1){
          bytes=new Uint8Array(length);
          let at=0;
          for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
        }
        if(view(input).getUint32(trailer)!==adler(bytes)){failed=true;return;}
        return {bytes,stored:trailer+4};
      }catch{failed=true;}
    },
  };
}

export function readCarvedZlib(input:Uint8Array,decodedLimit=maxPage){
  return zlibHeader(input,0)?carvedZlibReader(decodedLimit).read(input):undefined;
}

function prd(data:DataView){
  return data.byteLength>=0x50 && data.getUint32(0x10,true)===0x50524430 && data.getUint8(0x14)===0x7a;
}

function sysPointer(data:DataView,at:number){
  if(at+8>data.byteLength || data.getUint32(at+4,true))return -1;
  const offset=data.getUint32(at,true)-0x50000000;
  return offset>=0&&offset<0x10000000?offset:-1;
}

function resourceHeader(input:Uint8Array):DataView|undefined {
  let header:DataView|undefined;
  const stream=new Inflate(chunk=>{
    if(chunk.length>=0x18)header=view(chunk);
  });
  try{
    // A discovery sample may skip inconclusive prefixes. The complete
    // scan still validates and reads every candidate in this range.
    stream.push(input.subarray(2,258),false);
    return header;
  }catch{return undefined;}
}

function drawableBounds(data:DataView,at:number){
  if(at<0||at+28>data.byteLength)return;
  const bounds=[0,4,8,16,20,24].map(delta=>data.getFloat32(at+delta,true)) as Bounds;
  if(bounds.every((v,i)=>Number.isFinite(v)&&Math.abs(v)<3000&&(i>=3||v<=bounds[i+3]))&&
    bounds.some((v,i)=>i<3&&bounds[i+3]-v>.02))return bounds;
}

function dictionaryCount(data:DataView){
  const n=data.getUint16(0x28,true);
  return n>0&&n<=8192&&n===data.getUint16(0x2a,true)&&n===data.getUint16(0x38,true)&&n===data.getUint16(0x3a,true)&&
    sysPointer(data,0x20)>=0&&sysPointer(data,0x30)>=0?n:0;
}

type DictionaryModel=Pick<VegetationModel,"name"|"hash"|"bounds"|"drawable"|"verified"|"keyedOnly"|"assetType">;
function nameAt(bytes:Uint8Array,data:DataView,pointer:number,tag:"dr"|"ft"){
  const at=sysPointer(data,pointer);
  const end=at<0?-1:bytes.subarray(at,at+164).indexOf(0);
  if(end<=4)return;
  const label=decoder.decode(bytes.subarray(at,at+end));
  if(label.endsWith(`.#${tag}`)&&/^[a-z0-9_][a-z0-9_.-]{1,159}$/i.test(label.slice(0,-4)))return label.slice(0,-4);
}

function fragmentHeader(data:DataView){
  if(data.byteLength<0xb0||sysPointer(data,0xa8)<0||sysPointer(data,0x18)<0)return false;
  for(const at of [0x10,0x20,0x28]){
    if(data.getBigUint64(at,true)!==0n&&sysPointer(data,at)<0)return false;
  }
  const count=data.getUint16(0x30,true),size=data.getUint16(0x36,true);
  return count>0&&count<=4096&&data.getUint16(0x32,true)<=4096&&
    size<=4096&&data.getUint16(0x34,true)<=size;
}

function drawableDictionary(bytes:Uint8Array,count:number):DictionaryModel[]|undefined {
  const data=view(bytes),hashes=sysPointer(data,0x20),items=sysPointer(data,0x30);
  if(hashes+count*4>bytes.length||items+count*8>bytes.length)return;
  const entries:DictionaryModel[]=[];
  for(let i=0;i<count;i++){
    const drawable=sysPointer(data,items+i*8);
    if(drawable<0)return [];
    if(drawable+0x70>bytes.length)return;
    const materials=sysPointer(data,drawable+0x10),lod=sysPointer(data,drawable+0x50);
    if(materials<0||lod<0)return [];
    if(materials+28>bytes.length||lod+12>bytes.length)return;
    const hash=data.getUint32(hashes+i*4,true);
    if(!hash)return [];
    const authored=nameAt(bytes,data,drawable+0xa8,"dr");
    entries.push({hash,name:authored??`drawable_${hash.toString(16)}`,drawable,bounds:drawableBounds(data,drawable+0x30),
      ...(authored?{verified:true as const,assetType:2 as const}:{})});
  }
  return entries;
}

function fragmentDrawable(bytes:Uint8Array,drawable:number):DictionaryModel|undefined {
  const data=view(bytes),embedded=nameAt(bytes,data,drawable+0xa8,"ft");
  const root=fragmentHeader(data)?nameAt(bytes,data,0xa8,"ft"):undefined;
  const name=embedded??root;
  if(!name)return;
  const materials=sysPointer(data,drawable+0x10),lod=sysPointer(data,drawable+0x50);
  if(materials<0||materials+28>bytes.length||lod<0||lod+12>bytes.length)return;
  const materialCount=data.getUint16(materials+24,true),slots=sysPointer(data,materials+16);
  const list=sysPointer(data,lod),first=list<0?-1:sysPointer(data,list);
  if(!materialCount||materialCount>512||slots<0||slots+materialCount*8>bytes.length||first<0||first+40>bytes.length||
    sysPointer(data,first+8)<0)return;
  return {name,hash:joaat(name),drawable,bounds:drawableBounds(data,drawable+0x30),verified:true,assetType:1,
    ...(!embedded?{keyedOnly:true as const}:{})};
}

function drawableNames(data:Uint8Array,typedRoot=false):DictionaryModel[]{
  const metadata=view(data);
  const labels=Array.from(decoder.decode(data).matchAll(names),match=>({
    name:match[1],offset:match.index!+(match[0][0]==="\0"?1:0),
  }));
  const remaining=new Set(labels.map(({offset})=>offset)),refs=new Map<number,number>();
  // Only the first pointer to each candidate label can validate a name.
  for(let i=0;remaining.size&&i+8<=data.length;i+=8){
    const pointer=sysPointer(metadata,i);
    if(remaining.delete(pointer))refs.set(pointer,i);
  }
  const hits:DictionaryModel[]=labels.flatMap(({name,offset})=>{
    const ref=refs.get(offset);
    if(ref===undefined)return [];
    const bounds=ref>=0x98&&sysPointer(metadata,ref-0x98)>=0?drawableBounds(metadata,ref-0x78):undefined;
    const hasDrawable=ref>=0xa8&&sysPointer(metadata,ref-0x98)>=0&&sysPointer(metadata,ref-0x58)>=0&&!!bounds;
    return [{name,hash:joaat(name),bounds,...(hasDrawable?{verified:true as const,assetType:2 as const}:{})}];
  });
  if(typedRoot&&sysPointer(metadata,0x10)>=0&&sysPointer(metadata,0x50)>=0){
    const name=nameAt(data,metadata,0xa8,"dr"),bounds=drawableBounds(metadata,0x30);
    if(name&&bounds&&!hits.some(hit=>hit.name===name&&hit.verified))
      hits.unshift({name,hash:joaat(name),bounds,drawable:0,verified:true,assetType:2});
  }
  return hits;
}

const indexedBounds=new WeakMap<Uint8Array,Map<string,Bounds|undefined>>();
export function readIndexedBounds(metadata:Uint8Array,name:string){
  let models=indexedBounds.get(metadata);
  if(!models){
    models=new Map(drawableNames(metadata).map(({name,bounds})=>[name,bounds]));
    indexedBounds.set(metadata,models);
  }
  return models.get(name);
}
type Page = { range:MapPage; bytes:Uint8Array };
const next=(entry:Page)=>align(entry.range[0]+entry.range[1]);
function newRoot(bytes:Uint8Array,at:number){
  return at%pageAlignment===16&&bytes.length>=16&&view(bytes).getBigUint64(0,true)===0n&&sysPointer(view(bytes),8)>=0;
}

export async function readIndexedGraphics(archive:Archive,at:number,extent?:number,
  decoded?:(page:Uint8Array)=>void,limit=archive.file.size):Promise<number[][]>{
  let buffer:Uint8Array=new Uint8Array(), start=-1, size=0;
  const ranges:number[][]=[];
  for(let i=0;i<64&&at+7<limit&&(extent===undefined||size<extent);i++){
    if(at<start||at+7>start+buffer.length){
      start=at;
      buffer=await archive.read(at,Math.min(64*1024,limit-at));
    }
    let input=buffer.subarray(at-start);
    const prefixed=input.length>=18&&zlibHeader(input,16);
    if(prefixed&&(extent!==undefined?input.subarray(0,16).every(n=>n===0):
      i===0&&!zlibHeader(input,0)&&view(input).getUint32(12,true)===0)){
      at+=16;input=input.subarray(16);
    }
    if(!zlibHeader(input,0)){
      if(!i&&extent!==undefined&&at+extent<=limit)return [[at,extent,extent,1]];
      break;
    }
    const reader=carvedZlibReader(maxGraphicsPage);
    let page=reader.read(input);
    if(!page&&!reader.failed&&at+input.length<limit){
      start=at;buffer=input;
      for(let length=256*1024;!page&&!reader.failed;length=Math.min(length*4,maxGraphicsPage)){
        const end=Math.min(length,limit-at);
        if(buffer.length<end){
          const grown=new Uint8Array(end);
          grown.set(buffer);
          grown.set(await archive.read(at+buffer.length,end-buffer.length),buffer.length);
          buffer=grown;
          page=reader.read(buffer);
        }
        if(length===maxGraphicsPage||at+buffer.length===limit)break;
      }
    }
    if(!page||prd(view(page.bytes))||newRoot(page.bytes,at))break;
    ranges.push([at,page.stored,page.bytes.length]);size+=page.bytes.length;
    decoded?.(page.bytes);
    at=align(at+page.stored);
  }
  if(!ranges.length||extent!==undefined&&size<extent)throw new Error("Missing indexed graphics pages.");
  return ranges;
}
async function decodeAlignedGraphicsPage(bytes:Uint8Array<ArrayBuffer>){
  if(typeof DecompressionStream==="undefined"||!zlibHeader(bytes,0))return;
  // At most fifteen padding bytes follow a directory chunk. If its checksum
  // also ends in zero, the ordinary decoder will locate the exact boundary.
  let end=bytes.length;
  while(end>bytes.length-15&&bytes[end-1]===0)end--;
  const chunks:Uint8Array<ArrayBuffer>[]=[];
  let size=0;
  try{
    const stream=new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller){controller.enqueue(bytes.subarray(0,end));controller.close();}
    });
    const reader=stream.pipeThrough(new DecompressionStream("deflate")).getReader();
    while(true){
      const {value,done}=await reader.read();
      if(done)break;
      size+=value.length;
      if(size>maxGraphicsPage){
        await reader.cancel();
        return;
      }
      chunks.push(value);
    }
  }catch{return;}
  if(chunks.length===1)return {bytes:chunks[0],stored:end};
  const data=new Uint8Array(size);
  let offset=0;
  for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
  return {bytes:data,stored:end};
}

export async function indexedGraphicsPages(archive:Archive,offset:number,range?:IndexedGraphicsRange){
  const pages:Uint8Array[]=[];
  let end=offset;
  if(range?.chunks){
    const ranges:Range[]=[];
    for(const length of range.chunks.slice(0,64)){
      if(length<=0||end+length>range.end)break;
      ranges.push([end,length]);
      end+=length;
    }
    end=offset;
    for await(const {offset:at,bytes} of readResources(archive,ranges)){
      const page=await decodeAlignedGraphicsPage(bytes)??readCarvedZlib(bytes,maxGraphicsPage);
      if(!page||align(page.stored)!==bytes.length||prd(view(page.bytes))||newRoot(page.bytes,at))break;
      pages.push(page.bytes);
      end=at+bytes.length;
    }
    if(pages.length)return {pages,end};
  }
  const ranges=await readIndexedGraphics(archive,offset,undefined,page=>pages.push(page),range?.end);
  const [start,stored]=ranges.at(-1)!;
  return {pages,end:align(start+stored)};
}

function joined(pages:Page[]){
  if(pages.length===1)return pages[0].bytes;
  const bytes=new Uint8Array(pages.reduce((sum,page)=>sum+page.bytes.length,0));
  let pos=0;
  for(const page of pages){bytes.set(page.bytes,pos);pos+=page.bytes.length;}
  return bytes;
}

function mapBounds(data:DataView){
  let bounds:Footprint|undefined;
  const {offsets,streamingBounds}=placementLayout(data,undefined,false);
  for(const at of offsets){
    try{
      const [x,y]=readPlacement(data,at,data.getUint32(at,true)).position;
      if(Math.abs(x)<50000&&Math.abs(y)<50000)bounds=growBounds(bounds,[x,y,x,y]);
    }catch{}
  }
  return bounds&&{bounds,streamingBounds};
}

export async function scanStreetSegment(archive:Archive,segment:number,active:()=>boolean,scope:ScanScope="full",
  members?:readonly StreetMemberRange[],visitMap?:VisitIndexedMap):Promise<ScanSegment>{
  const before=archive.bytesRead;
  const start=segment*indexSegmentSize,end=Math.min(archive.file.size,start+indexSegmentSize);
  const result:ScanSegment={maps:[],vegetation:[],models:[],bytes:0};
  let window:Uint8Array=new Uint8Array(), windowStart=-1, windowView=view(window);
  let member:StreetMemberRange|undefined;
  let directPages:Map<number,number>|undefined;
  function prefix(at:number){
    const i=at-windowStart;
    return i>=16&&i+2<=window.length&&zlibHeader(window,i)&&
      windowView.getBigUint64(i-16)===0n&&windowView.getBigUint64(i-8)===0n;
  }
  async function page(at:number):Promise<Page|undefined>{
    const pageEnd=member?.end??archive.file.size;
    if(at+7>=pageEnd)return;
    const stored=directPages?.get(at);
    if(directPages&&stored===undefined)return;
    const limit=Math.min(stored??maxPage,maxPage,pageEnd-at);
    if(limit<7)return;
    const i=at-windowStart;
    let input=window.subarray(i,i+limit);
    if(i<0||i+2>window.length)input=await archive.read(at,Math.min(stored??65536,limit));
    if(!zlibHeader(input,0))return;
    let decoded=readCarvedZlib(input);
    if(!decoded&&input.length<limit)
      decoded=readCarvedZlib(await archive.read(at,limit));
    return decoded&&{range:[at,decoded.stored,decoded.bytes.length],bytes:decoded.bytes};
  }

  async function inspect(fileOffset:number){
    // The prepared directory already identifies map members. Their decoded
    // headers still go through the full PRD and system-pointer checks below.
    if(scope==="sample"&&member?.type!==0x49){
      const i=fileOffset-windowStart;
      const preview=resourceHeader(window.subarray(i,i+258));
      if(!preview||sysPointer(preview,8)<0||preview.getUint32(0x10,true)!==0x50524430||preview.getUint8(0x14)!==0x7a)return;
    }
    const root=await page(fileOffset);
    if(!root||root.bytes.length<0x50)return;
    const header=view(root.bytes);
    if(sysPointer(header,8)<0)return;
    if(prd(header)){
      const blockCount=header.getUint16(0x4c,true), blocksAt=sysPointer(header,0x38);
      const schemaAt=sysPointer(header,0x28), structs=header.getUint16(0x48,true);
      if(blocksAt<0||schemaAt<0||!blockCount||blockCount>4096||structs>4096)return;
      const system=[root];
      let size=root.bytes.length, at=next(root);
      let required=Math.max(blocksAt+blockCount*16,schemaAt+structs*32);
      while(required<=maxPage && size<required && system.length<32){
        if(at%pageAlignment===16&&prefix(at))break;
        const continuation=await page(at);
        if(!continuation)break;
        system.push(continuation);size+=continuation.bytes.length;at=next(continuation);
      }
      if(size<required)return;
      const data=view(joined(system));
      if(scope==="full"){
        let definitions=readDrawableAliases(data);
        while(definitions&&definitions.needed<=maxPage&&definitions.needed>size&&system.length<32&&active()){
          if(at%pageAlignment===16&&prefix(at))break;
          const continuation=await page(at);
          if(!continuation||size+continuation.bytes.length>maxPage)break;
          system.push(continuation);size+=continuation.bytes.length;at=next(continuation);
          if(size>=definitions.needed)definitions=readDrawableAliases(view(joined(system)));
        }
        if(definitions){
          if(definitions.needed<=size&&definitions.aliases.length)(result.aliases??=[]).push(...definitions.aliases);
          return;
        }
      }
      try{
        if(visitMap)visitMap(system.map(p=>p.range),data);
        else{
          const bounds=mapBounds(data);
          if(bounds)result.maps.push({...bounds,pages:system.map(p=>p.range)});
        }
      }catch{}
      if(scope==="sample"||system.length!==1)return; // Current batch reader handles root-page metadata.
      const {batches,graphicsSize}=scanVegetation(data);
      if(!batches.length||graphicsSize<=0||graphicsSize>maxPage)return;
      const locator:IndexedVegetation={system:root.range,graphics:[],graphicsStart:at,graphicsSize,grassModels:[],woodyModels:[]};
      const grassIds=new Set<number>(),woodyIds=new Set<number>();
      for(const [hash,,,,grass,,left,bottom,right,top] of batches){
        const field=grass?"grass":"woody";
        locator[field]=growBounds(locator[field],[left,bottom,right,top]);
        (grass?grassIds:woodyIds).add(hash);
      }
      locator.grassModels=[...grassIds];
      locator.woodyModels=[...woodyIds];
      result.vegetation.push(locator);
      return;
    }
    if(scope==="sample"||header.getBigUint64(0,true)!==0n)return;
    const pages=[root];
    const count=dictionaryCount(header);
    if(count){
      let at=next(root),size=root.bytes.length;
      let dictionary=drawableDictionary(root.bytes,count);
      while(!dictionary&&pages.length<8&&size<maxPage&&active()){
        if(at%pageAlignment===16&&prefix(at))break;
        const continuation=await page(at);
        if(!continuation||size+continuation.bytes.length>maxPage)break;
        pages.push(continuation);size+=continuation.bytes.length;at=next(continuation);
        dictionary=drawableDictionary(joined(pages),count);
      }
      if(dictionary?.length){
        const streams=pages.map(({range:[at,length,decoded]})=>[at,length,decoded]);
        const covered=new Set<number>();
        for(const entry of dictionary){
          const model={...entry,system:pages.length,streams};
          result.models.push(model);
          covered.add(entry.hash);
          const named=joaat(entry.name);
          if(!entry.name.startsWith("drawable_")&&named!==entry.hash){
            result.models.push({...model,hash:named});
            covered.add(named);
          }
        }
        for(const {name,bounds,verified,assetType} of drawableNames(joined(pages))){
          const hash=joaat(name);
          if(!covered.has(hash))result.models.push({name,hash,system:pages.length,streams,bounds,verified,assetType});
        }
        return;
      }
      pages.length=1;
    }
    const fragmentRoot=sysPointer(header,0x18);
    const possibleFragment=fragmentRoot>0&&fragmentHeader(header);
    let at=next(root), hitSystem=1, hits=drawableNames(root.bytes,member?.type===2);
    let fragment=fragmentRoot>0?fragmentDrawable(root.bytes,fragmentRoot):undefined;
    while(!fragment&&(!hits.length||possibleFragment)&&pages.length<4&&active()){
      if(at%pageAlignment===16&&prefix(at))break;
      const entry=await page(at);
      if(!entry)break;
      const data=view(entry.bytes);
      if(data.byteLength>=16&&data.getBigUint64(0,true)===0n&&sysPointer(data,8)>=0&&at%pageAlignment===16)break;
      pages.push(entry);at=next(entry);
      const metadata=joined(pages);
      if(!hits.length){
        hits=drawableNames(metadata,member?.type===2);
        if(hits.length)hitSystem=pages.length;
      }
      if(fragmentRoot>0)fragment=fragmentDrawable(metadata,fragmentRoot);
    }
    if(!hits.length&&!fragment)return;
    const streams=pages.map(({range:[at,length,decoded]})=>[at,length,decoded]);
    for(const hit of hits)
      result.models.push({...hit,system:hitSystem,streams:streams.slice(0,hitSystem)});
    if(fragment)result.models.push({...fragment,system:pages.length,streams});
  }

  if(members){
    const previewEnd=(range:StreetMemberRange)=>Math.min(range.end,
      range.offset+(range.chunks?.[0]??(scope==="sample"?258:65536)));
    for(let cursor=0;cursor<members.length&&active();){
      const first=members[cursor].offset;
      let last=cursor;
      let end=previewEnd(members[last]);
      while(last+1<members.length&&members[last+1].offset<=end+16384&&members[last+1].offset-first<1024*1024)
        end=Math.max(end,previewEnd(members[++last]));
      windowStart=first-16;
      window=await archive.read(windowStart,end-windowStart);
      windowView=view(window);
      for(;cursor<=last&&active();cursor++){
        member=members[cursor];
        if(!prefix(member.offset))continue;
        directPages=undefined;
        if(member.chunks){
          directPages=new Map();
          let at=member.offset;
          for(const stored of member.chunks){directPages.set(at,stored);at+=stored;}
        }
        const firstModel=result.models.length;
        await inspect(member.offset);
        const graphicsRanges=new Map<number,IndexedGraphicsRange>();
        for(let i=firstModel;i<result.models.length;i++){
          const model=result.models[i];
          const [at,stored]=model.streams[model.system-1];
          const start=align(at+stored);
          let range=graphicsRanges.get(start);
          if(!range){
            range={end:member.end,
              chunks:directPages?.has(start)?member.chunks?.slice(model.system):undefined};
            graphicsRanges.set(start,range);
          }
          model.graphicsRange=range;
        }
      }
    }
    result.bytes=archive.bytesRead-before;
    return result;
  }

  const sample=scope==="sample",windowBytes=sample?1024*1024:windowSize;
  const lookahead=sample?65536:maxPage;
  for(let block=start;block<end&&active();block+=windowSize){
    const sampleStart=sample?block+windowSize/2:block;
    windowStart=Math.max(sampleStart,4096);
    const windowEnd=Math.min(end,sampleStart+windowBytes+16);
    if(windowStart+17>=windowEnd)continue;
    window=await archive.read(windowStart,Math.min(windowBytes+lookahead,archive.file.size-windowStart));
    windowView=view(window);
    for(let search=windowStart+16;search<windowEnd&&active();search+=pageAlignment){
      if(search-windowStart+1>=window.length)break;
      if(prefix(search))await inspect(search);
    }
  }
  result.bytes=archive.bytesRead-before;
  return result;
}

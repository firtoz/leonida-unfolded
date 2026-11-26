import { Archive, view } from "./archive";
import type { PreparedRpf9Directory } from "./rpf9-directory";
import type { openRpf9Preparer } from "./rpf9-prepare";
import { drawableNameKey } from "./street-drawable-identity";
import { readCarvedZlib } from "./street-index-scan";
import { readRpf9BootMember, readRpf9BootPaths } from "./rpf9-boot";

type Member = NonNullable<ReturnType<PreparedRpf9Directory["member"]>>;
type Prepare = Awaited<ReturnType<typeof openRpf9Preparer>>;
const extentKey = BigInt(`0x${drawableNameKey("data/imposterextents.dat")}`);
const metadataMountKey = 0x3ff2869f747c66fen;
const extentStride = 0x510;

export type ImposterAtlasRecord={
  textures:readonly [bigint,bigint,bigint];
  center:readonly [number,number,number];
  radius:number;
  axis:number;
};
export type PackedSlodModel={
  center:readonly [number,number,number];
  minimum:number;
  maximum:number;
};

export function readImposterAtlasTable(bytes:Uint8Array){
  const data=view(bytes),header=0x30;
  if(bytes.length<header+16||data.getUint32(0)!==0x5053494e||data.getUint32(8,true)!==0x05a54c31||
    data.getUint32(12,true)!==16||data.getUint32(24,true)!==0x492a6ea5)
    throw new Error("Invalid impostor atlas metadata");
  const start=header+16,stride=0x40,length=data.getUint32(28,true);
  const count=data.getUint16(header+8,true),capacity=data.getUint16(header+10,true);
  if(!count||count>capacity||length!==count*stride||start+length>bytes.length||
    data.getBigUint64(header,true)!==2n)throw new Error("Invalid impostor atlas descriptor array");
  const records=new Map<bigint,ImposterAtlasRecord>();
  for(let at=start;at<start+length;at+=stride){
    const key=data.getBigUint64(at,true);
    if(!key||records.has(key))throw new Error("Invalid impostor atlas model identity");
    records.set(key,{
      center:[data.getFloat32(at+0x10,true),data.getFloat32(at+0x14,true),data.getFloat32(at+0x18,true)],
      radius:data.getFloat32(at+0x1c,true),
      axis:Math.min(2,data.getUint32(at+0x20,true)),
      textures:[data.getBigUint64(at+0x28,true),data.getBigUint64(at+0x30,true),data.getBigUint64(at+0x38,true)],
    });
  }
  return records;
}

export function readImposterTreeRegistry(bytes:Uint8Array){
  const data=view(bytes),header=0x30,start=0x40,stride=0x68;
  if(bytes.length<start||data.getUint32(0)!==0x5053494e||data.getUint32(8,true)!==0xed26378b||
    data.getUint32(12,true)!==16||data.getUint32(24,true)!==0xe68c3ae7||data.getBigUint64(header,true)!==2n)
    throw new Error("Invalid TreeInfo descriptor");
  const count=data.getUint16(header+8,true),size=data.getUint32(28,true);
  if(count>data.getUint16(header+10,true)||size!==count*stride||start+size>bytes.length)
    throw new Error("Invalid TreeInfo array");
  const tags=new Map<number,bigint>(),ambiguous=new Set<number>();
  const coverage=new Map<bigint,readonly [floor:number,scale:number]>();
  const ambiguousCoverage=new Set<bigint>();
  for(let at=start;at<start+size;at+=stride){
    const tag=data.getUint32(at+0x38,true),key=data.getBigUint64(at+0x10,true);
    if(!key)continue;
    const floor=data.getFloat32(at+0x3c,true),scale=data.getFloat32(at+0x40,true);
    if(floor>=0&&floor<1&&scale>0&&scale<=1&&!ambiguousCoverage.has(key)){
      const prior=coverage.get(key);
      if(prior&&(prior[0]!==floor||prior[1]!==scale)){
        coverage.delete(key);
        ambiguousCoverage.add(key);
      }else coverage.set(key,[floor,scale]);
    }
    if(tag>0xffff||ambiguous.has(tag))continue;
    const prior=tags.get(tag);
    if(prior!==undefined&&prior!==key){tags.delete(tag);ambiguous.add(tag);}
    else tags.set(tag,key);
  }
  return {tags,coverage};
}

export function readImposterTreeTags(bytes:Uint8Array){
  return readImposterTreeRegistry(bytes).tags;
}

export function readPackedSlodModels(bytes:Uint8Array){
  const data=view(bytes),header=0x40,stride=0x40;
  if(bytes.length<header||data.getUint32(0)!==0x5053494e||data.getUint32(8,true)!==0x8b910459||
    data.getUint32(24,true)!==0x488b4199)throw new Error("Invalid SLODInfo descriptor");
  const start=header+data.getUint32(12,true),size=data.getUint32(28,true);
  if(size!==0x400*stride||start+size>bytes.length)throw new Error("Invalid SLODInfo model bank");
  const models=new Map<number,PackedSlodModel>();
  for(let tag=0;tag<0x400;tag++){
    const at=start+tag*stride;
    const center=[data.getFloat32(at,true),data.getFloat32(at+4,true),data.getFloat32(at+8,true)] as const;
    const minimum=data.getFloat32(at+0x10,true),maximum=data.getFloat32(at+0x14,true);
    if(center.every(Number.isFinite)&&Number.isFinite(maximum)&&minimum>=0&&maximum>minimum)
      models.set(tag,{center,minimum,maximum});
  }
  return models;
}

function readImposterViews(bytes:Uint8Array){
  const header=0x30, stride=0x70;
  if(bytes.length<header)throw new Error("Truncated PSIN header");
  const data=view(bytes),headerSize=data.getUint32(0xc,true),viewBytes=data.getUint32(0x1c,true);
  if(data.getUint32(0)!==0x5053494e||data.getUint32(0x8,true)!==0x5a236345||
    data.getUint32(0x18,true)!==0xa5884a52||headerSize!==0x80||header+headerSize+viewBytes>bytes.length)
    throw new Error("Invalid PSIN impostor metadata");
  const count=data.getUint32(header+4,true);
  if(!count||count*stride!==viewBytes)throw new Error("Invalid PSIN view array");
  return Array.from({length:count},(_,i)=>{
    const at=header+headerSize+i*stride;
    const orientation=Array.from({length:6},(_,component)=>data.getFloat32(at+0x28+component*4,true));
    if(!orientation.every(Number.isFinite))throw new Error("Invalid PSIN view orientation");
    return orientation;
  });
}

function findMember(directory:PreparedRpf9Directory,key:bigint,type:number){
  for(let slot=0;slot<directory.layout.entryCount;slot++){
    const member=directory.member(slot);
    if(member?.type===type&&member.nameKey===key&&!member.alternateBacking)return member;
  }
}

async function decodeMember(archive:Archive,member:Member,base:number,end:number,limit:number){
  const {offset,storedBytes,logicalBytes}=member;
  if(!storedBytes||!logicalBytes||storedBytes>limit||logicalBytes>limit||
    base+offset+storedBytes>end)throw new Error("Invalid RPF9 impostor data range");
  const raw=await archive.read(base+offset,storedBytes);
  const decoded=new Uint8Array(logicalBytes);
  let written=0,at=0;
  while(written<logicalBytes){
    const page=readCarvedZlib(raw.subarray(at),logicalBytes-written);
    if(!page?.bytes.length)throw new Error("Truncated RPF9 impostor data");
    decoded.set(page.bytes,written);
    written+=page.bytes.length;
    at+=Math.ceil(page.stored/16)*16;
  }
  if(at!==storedBytes)throw new Error("Unexpected trailing RPF9 impostor data");
  return decoded;
}

export async function openStreetImposterMetadata(common:Archive,data:Archive,prepare:Prepare){
  const [commonRoot,dataRoot]=await Promise.all([
    prepare(common,0,common.file.size),prepare(data,0,data.file.size)
  ]);
  const extentMember=findMember(commonRoot,extentKey,0xff);
  const mount=findMember(dataRoot,metadataMountKey,0);
  if(!extentMember||!mount?.storedBytes||mount.offset+mount.storedBytes>data.file.size)
    throw new Error("RPF9 impostor metadata is missing");
  const {offset:base,storedBytes}=mount,end=base+storedBytes;
  const [extents,metadata]=await Promise.all([
    decodeMember(common,extentMember,0,common.file.size,2*1024*1024),prepare(data,base,storedBytes)
  ]);
  const rows=view(extents),count=rows.getUint32(0,true);
  if(4+count*extentStride!==extents.length)throw new Error("Invalid impostor extent table");
  const entries=new Map<bigint,number>();
  for(let i=0;i<count;i++){
    const at=4+i*extentStride;
    entries.set(rows.getBigUint64(at+8,true),at);
  }
  const payloads=new Map<bigint,Member>();
  for(let slot=0;slot<metadata.layout.entryCount;slot++){
    const member=metadata.member(slot);
    if(member?.type===0x0b&&member.nameKey&&!member.alternateBacking&&entries.has(member.nameKey))
      payloads.set(member.nameKey,member);
  }
  const readBoot=(stem:string)=>readRpf9BootMember(data,dataRoot,stem,prepare.processMember);
  let paths:Promise<ReturnType<typeof readRpf9BootPaths>>|undefined;
  async function bootTable(type:number){
    const stem=(await (paths??=readBoot("data/default").then(readRpf9BootPaths))).get(type);
    if(!stem)throw new Error("RPF9 impostor registry path is missing");
    return readBoot(stem);
  }
  let atlas:Promise<ReturnType<typeof readImposterAtlasTable>>|undefined;
  let treeRegistry:Promise<ReturnType<typeof readImposterTreeRegistry>>|undefined;
  let slodModels:Promise<ReturnType<typeof readPackedSlodModels>>|undefined;
  return {
    atlasTable(){
      return atlas??=bootTable(0x137).then(readImposterAtlasTable);
    },
    treeRegistry(){
      return treeRegistry??=bootTable(0x135).then(readImposterTreeRegistry);
    },
    slodModels(){
      return slodModels??=bootTable(0x136).then(readPackedSlodModels);
    },
    async read(key:bigint){
      const at=entries.get(key),member=payloads.get(key);
      if(at===undefined||!member)return;
      const psin=await decodeMember(data,member,base,end,256*1024);
      return {psin,views:readImposterViews(psin),extents:extents.subarray(at,at+extentStride)};
    }
  };
}

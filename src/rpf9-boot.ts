import { Archive, view } from "./archive";
import type { PreparedRpf9Directory } from "./rpf9-directory";
import { drawableNameKey } from "./street-drawable-identity";
import { readCarvedZlib } from "./street-index-scan";

const protectionAttribute=0x286030a358a789fbn;
const metadataLimit=2*1024*1024;
const bootStrings=0x10,bootFiles=0x34b2cc4b;
const prefix="$(target)/";
const align=(value:number)=>Math.ceil(value/16)*16;

export type Rpf9MemberProtection={
  id:number; operation:number; seed:Uint8Array;
  prefix:number; stripe:number; gap:number; suffix:number;
};

export type Rpf9MemberProcessor=(bytes:Uint8Array,protection:Rpf9MemberProtection)=>Promise<void>;

function readMemberProtection(record:Uint8Array,storedBytes:number):Rpf9MemberProtection {
  if(record.length<0x38||storedBytes%16)throw new Error("Invalid RPF9 member protection");
  const data=view(record);
  const lengths=Array.from({length:4},(_,i)=>Number(data.getBigUint64(0x18+i*8,true)));
  if(lengths.some(value=>!Number.isSafeInteger(value)||value%16))
    throw new Error("Misaligned RPF9 member protection range");
  const [prefix,stripe,gap,suffix]=lengths;
  return {id:data.getUint32(0,true),operation:data.getUint16(4,true),seed:record.slice(6,22),
    prefix,stripe,gap,suffix};
}

// The compiled default and startup manifests use the same row layout. Their
// string and file blocks follow an optional 16-byte root block in default.
export function readRpf9BootPaths(bytes:Uint8Array):Map<number,string>{
  if(bytes.length<0x48)throw new Error("Truncated RPF9 boot manifest");
  const data=view(bytes);
  if(data.getUint32(0)!==0x5053494e)throw new Error("Invalid RPF9 boot manifest");
  const hasRoot=data.getUint32(8,true)===0x44;
  const tags=hasRoot?[0x44,bootStrings,bootFiles,0xb275b0d2,0x91f5f058]:
    [bootStrings,bootFiles,0xb275b0d2,0x91f5f058];
  const blocks:{start:number;end:number}[]=[];
  let cursor=align(8+tags.length*16);
  for(const [i,tag] of tags.entries()){
    const row=8+i*16;
    if(row+16>bytes.length||data.getUint32(row,true)!==tag||data.getBigUint64(row+8,true)!==0xaaaaaaaaaaaaaaaan)
      throw new Error("Unsupported RPF9 boot block table");
    const end=cursor+data.getUint32(row+4,true);
    if(end>bytes.length)throw new Error("Truncated RPF9 boot block");
    blocks.push({start:cursor,end});
    cursor=align(end);
  }
  const stringsIndex=Number(hasRoot);
  const strings=blocks[stringsIndex],files=blocks[stringsIndex+1];
  if((files.end-files.start)%32)throw new Error("Invalid RPF9 boot file rows");
  const paths=new Map<number,string>(),decoder=new TextDecoder("utf-8",{fatal:true});
  for(let row=files.start;row<files.end;row+=32){
    const type=data.getUint32(row+16,true);
    if(paths.has(type))continue;
    const ref=data.getBigUint64(row,true);
    if((ref&0xfffffn)!==BigInt(stringsIndex+1))continue;
    const start=strings.start+Number(ref>>20n);
    if(start>=strings.end)throw new Error("Invalid RPF9 boot path pointer");
    const end=bytes.indexOf(0,start);
    if(end<0||end>=strings.end)throw new Error("Unterminated RPF9 boot path");
    const path=decoder.decode(bytes.subarray(start,end)).toLowerCase();
    if(path.startsWith(prefix))paths.set(type,path.slice(prefix.length));
  }
  return paths;
}

export async function readRpf9BootMember(archive:Archive,directory:PreparedRpf9Directory,
  stem:string,processMember:Rpf9MemberProcessor) {
  const key=BigInt(`0x${drawableNameKey(stem)}`);
  for(let slot=0;slot<directory.layout.entryCount;slot++){
    const member=directory.member(slot);
    if(member?.nameKey!==key||member.type!==0x0b||member.alternateBacking)continue;
    return readRpf9PackedMember(archive,directory,slot,processMember);
  }
  throw new Error("Missing authored RPF9 boot member");
}

export async function readRpf9PackedMember(archive:Archive,directory:PreparedRpf9Directory,
  slot:number,processMember:Rpf9MemberProcessor,mount?:{base:number;end:number}){
  const member=directory.member(slot);
  if(!member||member.alternateBacking)throw new Error("Invalid RPF9 packed member");
  const {offset,storedBytes,logicalBytes}=member;
  if(!storedBytes||!logicalBytes||storedBytes>metadataLimit||logicalBytes>metadataLimit||
    offset<directory.layout.wideEnd||(mount?.base??0)+offset+storedBytes>(mount?.end??archive.file.size))
    throw new Error("Invalid RPF9 packed member range");
  const chunks=directory.packedChunks(slot,storedBytes,logicalBytes);
  if(!chunks)throw new Error("Missing RPF9 packed member chunk table");
  const protection=directory.attribute(slot,protectionAttribute);
  const raw=await archive.read((mount?.base??0)+offset,storedBytes);
  if(protection)await processMember(raw,readMemberProtection(protection,storedBytes));
  const bytes=new Uint8Array(logicalBytes);
  let cursor=0;
  for(const chunk of chunks){
    const stored=raw.subarray(chunk.offset,chunk.offset+chunk.stored);
    if(chunk.raw){
      bytes.set(stored,cursor);
    }else{
      const decoded=readCarvedZlib(stored,chunk.decoded);
      if(!decoded||decoded.stored!==stored.length||decoded.bytes.length!==chunk.decoded)
        throw new Error("Invalid RPF9 packed member zlib chunk");
      bytes.set(decoded.bytes,cursor);
    }
    cursor+=chunk.decoded;
  }
  return bytes;
}

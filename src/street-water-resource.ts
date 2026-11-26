import type { Archive } from "./archive";
import type { PreparedRpf9Directory, Rpf9Chunk } from "./rpf9-directory";
import type { openRpf9Preparer } from "./rpf9-prepare";
import { drawableNameKey } from "./street-drawable-identity";
import { readCarvedZlib } from "./street-index-scan";

export type WaterDictionary={metadata:Uint8Array;graphics:Uint8Array};
export type WaterTileDictionary={metadata:Uint8Array;offset:number;graphicsOffset:number};
export const waterTileGraphicsBytes=2*128**2;
const key=(name:string)=>BigInt(`0x${drawableNameKey(name)}`);
const waveMount=key("textures/water");
const atlasMount=0xe48673c8b40792d8n;
const atlasExtinctionKey=0xf478ba5eb71e967n;

function namedMember(directory:PreparedRpf9Directory,name:bigint,type:number){
  for(let slot=0;slot<directory.layout.entryCount;slot++){
    const entry=directory.member(slot);
    if(entry?.nameKey===name&&entry.type===type&&!entry.alternateBacking&&entry.storedBytes)
      return {entry,slot};
  }
}

function decodeChunk(input:Uint8Array,chunk:Rpf9Chunk){
  if(chunk.raw)return input;
  const page=readCarvedZlib(input,chunk.decoded);
  if(page?.bytes.length===chunk.decoded&&Math.ceil(page.stored/16)*16===chunk.stored)return page.bytes;
}

export function openStreetWaterResources(archive:Archive,prepare:Awaited<ReturnType<typeof openRpf9Preparer>>){
  const root=prepare(archive,0,archive.file.size);
  const mounts=new Map<bigint,Promise<{directory:PreparedRpf9Directory;base:number;end:number}|undefined>>();
  function openMount(mountKey:bigint){
    let mount=mounts.get(mountKey);
    if(!mount){
      mount=root.then(async directory=>{
        const found=namedMember(directory,mountKey,0);
        if(!found)return;
        const {offset:base,storedBytes}=found.entry;
        if(base<directory.layout.wideEnd||base+storedBytes>archive.file.size)return;
        return {directory:await prepare(archive,base,storedBytes),base,end:base+storedBytes};
      });
      mounts.set(mountKey,mount);
    }
    return mount;
  }
  async function read(name:string):Promise<WaterDictionary|undefined>{
    const source=await openMount(name==="water"?waveMount:atlasMount);
    if(!source)return;
    // The extinction dictionary has a distinct archive identity from its inner texture.
    const entryKey=name==="waterfogatlas_gfb2"?atlasExtinctionKey:key(name);
    const found=namedMember(source.directory,entryKey,5);
    if(!found)return;
    const {entry,slot}=found,{base,directory,end}=source;
    if(entry.offset<directory.layout.wideEnd||base+entry.offset+entry.storedBytes>end||
      entry.storedBytes>8*1024*1024||entry.logicalBytes>8*1024*1024)return;
    const chunks=directory.decodedChunks(slot,entry.storedBytes,entry.logicalBytes);
    if(chunks?.length!==2||chunks[0].decoded!==entry.systemBytes||chunks[0].decoded>4096)return;
    const input=await archive.read(base+entry.offset+16,entry.storedBytes-16);
    const metadata=decodeChunk(input.subarray(0,chunks[0].stored),chunks[0]);
    const graphics=decodeChunk(input.subarray(chunks[0].stored),chunks[1]);
    if(metadata&&graphics)return {metadata,graphics};
  }
  async function* tiles(current:()=>boolean):AsyncGenerator<WaterTileDictionary>{
    const mount=await openMount(atlasMount);
    if(!mount)return;
    const {base,directory,end}=mount;
    const candidates:{offset:number;chunk:Rpf9Chunk}[]=[];
    for(let slot=0;slot<directory.layout.entryCount;slot++){
      const entry=directory.member(slot);
      if(!entry||entry.type!==5||entry.alternateBacking||!entry.systemBytes||entry.systemBytes>1024||
        entry.logicalBytes-entry.systemBytes!==waterTileGraphicsBytes||
        entry.offset<directory.layout.wideEnd||base+entry.offset+entry.storedBytes>end)continue;
      const chunks=directory.decodedChunks(slot,entry.storedBytes,entry.logicalBytes);
      if(chunks?.length===2&&chunks[0].decoded===entry.systemBytes&&
        chunks[1].decoded===waterTileGraphicsBytes&&!chunks[1].raw)
        candidates.push({offset:base+entry.offset+16,chunk:chunks[0]});
    }
    candidates.sort((a,b)=>a.offset-b.offset);
    for(let i=0;i<candidates.length&&current();i+=32){
      const group=await Promise.all(candidates.slice(i,i+32).map(async ({offset,chunk})=>{
        const metadata=decodeChunk(await archive.read(offset,chunk.stored),chunk);
        if(metadata)return {metadata,offset,graphicsOffset:offset+chunk.stored};
      }));
      if(!current())return;
      for(const row of group)if(row)yield row;
    }
  }
  return {read,tiles};
}

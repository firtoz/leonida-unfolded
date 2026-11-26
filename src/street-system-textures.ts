import {view,type Archive} from "./archive";
import {findTextureDescriptor} from "./layers";
import type {openRpf9Preparer} from "./rpf9-prepare";
import type {PreparedRpf9Directory} from "./rpf9-directory";
import {readCarvedZlib} from "./street-index-scan";
import {blockOffset} from "./texture";

const systemMount=0x66e64c2d0772ecb8n;
const systemDictionary=0xb8629fb6c04b2981n;

function memberByKey(directory:PreparedRpf9Directory,key:bigint,type:number){
  for(let slot=0;slot<directory.layout.entryCount;slot++){
    const entry=directory.member(slot);
    if(entry?.nameKey===key&&entry.type===type&&!entry.alternateBacking&&entry.storedBytes&&
       entry.offset>=directory.layout.wideEnd)return {entry,slot};
  }
  throw Error("Missing system texture directory");
}

export async function openStreetSystemTextures(archive:Archive,prepare:Awaited<ReturnType<typeof openRpf9Preparer>>,
  active:()=>boolean=()=>true){
  const root=await prepare(archive,0,archive.file.size);
  const {entry:mount}=memberByKey(root,systemMount,0);
  const mountEnd=mount.offset+mount.storedBytes;
  if(mountEnd>archive.file.size)throw Error("System texture mount exceeds archive");
  const directory=await prepare(archive,mount.offset,mount.storedBytes);
  const {entry,slot}=memberByKey(directory,systemDictionary,5);
  const start=mount.offset+entry.offset+16;
  if(start>mountEnd||start+entry.storedBytes-16>mountEnd||entry.logicalBytes>64*1024**2)
    throw Error("System dictionary exceeds archive");
  const chunks=directory.decodedChunks(slot,entry.storedBytes,entry.logicalBytes);
  if(!chunks||chunks.length<2||chunks[0].decoded!==entry.systemBytes||chunks[0].decoded>64*1024)
    throw Error("Missing system texture chunks");
  async function readChunk(chunk:NonNullable<typeof chunks>[number],offset:number){
    if(!active())throw Error("System asset request superseded");
    const stored=await archive.read(offset,chunk.stored);
    if(!active())throw Error("System asset request superseded");
    if(chunk.raw)return stored;
    const decoded=readCarvedZlib(stored,chunk.decoded);
    if(decoded?.bytes.length!==chunk.decoded||Math.ceil(decoded.stored/16)*16!==chunk.stored)
      throw Error("Invalid system texture chunk");
    return decoded.bytes;
  }
  const metadata=await readChunk(chunks[0],start);
  let logical=0,physical=start+chunks[0].stored;
  const pages=chunks.slice(1).map(chunk=>{
    const page={chunk,logical,physical};
    logical+=chunk.decoded;
    physical+=chunk.stored;
    return page;
  });
  const pending=new Map<number,Promise<Uint8Array>>();
  async function readSlice(from:number,to:number){
    const page=pages.find(page=>from>=page.logical&&to<=page.logical+page.chunk.decoded&&from<to);
    if(!page)throw Error("System surface exceeds graphics chunk");
    let result=pending.get(page.physical);
    if(!result){result=readChunk(page.chunk,page.physical);pending.set(page.physical,result);}
    return (await result).subarray(from-page.logical,to-page.logical);
  }
  return {metadata,readSlice};
}

export async function readStreetBlueNoise(archive:Archive,prepare:Awaited<ReturnType<typeof openRpf9Preparer>>){
  const {metadata,readSlice}=await openStreetSystemTextures(archive,prepare);
  const {width,height,depth,dimension,format,layout,start,elements}=findTextureDescriptor(metadata,"blue_noise_64");
  if(width!==64||height!==64||depth!==32||dimension!==1||format!==56||layout!==5||elements!==width*height*depth)
    throw Error("Unexpected blue-noise descriptor");
  const data=view(await readSlice(start,start+width*height*2));
  const rgba=new Uint8ClampedArray(width*height*4);
  // Keep both bytes of R16_UNORM in red and green so each rank can be
  // reconstructed exactly before the material applies its bilinear filter.
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const rank=data.getUint16(blockOffset(x,y,width,2),true),to=(y*width+x)*4;
    rgba[to]=rank>>>8;
    rgba[to+1]=rank&255;
    rgba[to+3]=255;
  }
  return {width,height,rgba};
}

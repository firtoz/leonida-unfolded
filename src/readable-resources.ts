import { readCarvedZlib } from "./street-index-scan";
import { view, type Archive } from "./archive";

const scanWindow=4*1024*1024;
const alignment=16;
const alignPage=(offset:number)=>Math.ceil(offset/alignment)*alignment;

export async function* scanSmallReadableResources(archive:Archive,decodedLimit:number,memberStarts=false,from=0,span=archive.file.size-from) {
  // The overlap keeps a small resource complete at a scan-window boundary.
  const storedLimit=decodedLimit+1024;
  const until=Math.min(archive.file.size,from+span);
  for(let start=from;start<until;start+=scanWindow){
    const base=Math.max(0,start-alignment);
    const prefix=start-base;
    const span=Math.min(prefix+scanWindow+storedLimit,archive.file.size-base);
    const window=await archive.read(base,span),data=view(window);
    const end=Math.min(prefix+scanWindow,window.length-7,until-base);
    for(let at=prefix;at<end;at+=alignment){
      if(window[at]!==0x78||(0x7800+window[at+1])%31)continue;
      if(memberStarts&&(at<alignment||data.getBigUint64(at-alignment)||data.getBigUint64(at-8)))continue;
      const resource=readCarvedZlib(window.subarray(at,at+storedLimit),decodedLimit);
      if(!resource)continue;
      yield {bytes:resource.bytes, next:alignPage(base+at+resource.stored)};
      at+=Math.floor((resource.stored-1)/alignment)*alignment;
    }
  }
}

export async function findSmallReadableResource(archive:Archive,decodedLimit:number,
  matches:(bytes:Uint8Array)=>boolean) {
  for await(const {bytes} of scanSmallReadableResources(archive,decodedLimit))
    if(matches(bytes))return bytes;
}

export async function readAdjacentResourcePage(archive:Archive,offset:number,decodedLimit:number) {
  const available=archive.file.size-offset;
  if(available<7)throw new Error(`${archive.path}: missing adjacent resource page`);
  const input=await archive.read(offset,Math.min(available,decodedLimit+Math.max(1024,decodedLimit/16)));
  const resource=readCarvedZlib(input,decodedLimit);
  if(!resource)throw new Error(`${archive.path}: invalid adjacent resource page`);
  return {bytes:resource.bytes,next:alignPage(offset+resource.stored)};
}

export async function readAdjacentResource(archive:Archive,offset:number,decodedLimit:number){
  return (await readAdjacentResourcePage(archive,offset,decodedLimit)).bytes;
}

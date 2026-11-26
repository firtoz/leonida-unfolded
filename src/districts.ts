import { hex, text, view, type Archive } from "./archive";
import { CELL, type Rect } from "./recover";
import { compact, englishLabels, joaat } from "./places";
import { readAdjacentResource, readAdjacentResourcePage, scanSmallReadableResources } from "./readable-resources";

export type Point = readonly [number, number];
export type District = { id:string; name?:string; detail:boolean; ring:Point[]; bounds:Rect; anchor:Point; area:number };
export type MapLabel = { name:string; point:Point; minScale:number };
type Block = { type:number; start:number; end:number };

const districtPageSize=65536;

async function readPsoPages(archive:Archive,first:Awaited<ReturnType<typeof readAdjacentResourcePage>>) {
  const start=view(first.bytes);
  if(start.byteLength<24||start.getUint32(0)!==0x5053494e)throw new Error("Invalid region PSIN section.");
  const sectionEnd=start.getUint32(4);
  if(sectionEnd<24||sectionEnd>16*1024*1024)throw new Error("Invalid region PSIN size.");
  const pages=[first.bytes];
  let page=first,size=page.bytes.length;
  while(size<sectionEnd&&page.bytes.length===districtPageSize){
    page=await readAdjacentResourcePage(archive,page.next,districtPageSize);
    pages.push(page.bytes);
    size+=page.bytes.length;
  }
  if(size<sectionEnd)throw new Error("Incomplete region PSIN section.");
  const payload=new Uint8Array(size);
  let at=0;
  for(const bytes of pages){payload.set(bytes,at);at+=bytes.length;}
  return payload;
}

async function readPso(archive:Archive,offset:number){
  return readPsoPages(archive,await readAdjacentResourcePage(archive,offset,districtPageSize));
}

function blocks(data:DataView){
  const rows:{type:number;length:number}[]=[];
  let at=8;
  while(at+16<=data.byteLength&&data.getBigUint64(at+8)===0xaaaaaaaaaaaaaaaan){
    rows.push({type:data.getUint32(at,true),length:data.getUint32(at+4,true)});
    at+=16;
  }
  const align=(n:number)=>Math.ceil(n/16)*16;
  let start=align(at);
  const schemaOffset=data.getUint32(4);
  return rows.map(({type,length}):Block=>{
    const block={type,start,end:start+length};
    if(block.end>Math.min(schemaOffset,data.byteLength))throw new Error("Invalid region PSIN block size.");
    start=align(block.end);
    return block;
  });
}

const regionId=(name:string)=>joaat(`region_${compact(name)}`);

function labels(payload:Uint8Array){
  const names=new Map<number,string>();
  // Both the dialogue variants and their shared NUL-terminated text pool hold place names.
  for(const {type,start,end} of blocks(view(payload))){
    if(type!==0x8be39ce2&&type!==0x10)continue;
    for(const [raw] of text.decode(payload.subarray(start,end)).matchAll(/[ -~]{3,60}(?=\0)/g)){
      const name=raw.replace(/^(?:in|at|on)(?: the)? /,"");
      if(!/^[A-Za-z0-9][A-Za-z0-9 .&'()-]+$/.test(name))continue;
      if(compact(name).length<3)continue;
      const id=regionId(name);
      if(!names.has(id))names.set(id,name);
    }
  }
  return names;
}

// Seek hints for the verified localization archive. String positions and
// region mappings come from the local streams.
const dialogueNamesHint=0x1ad43000;
const labelAnchorsHint=0x1c2fb000;
const englishHint=0x19be010;
const extraTextHint=0x1b89010;

async function findRegionKeys(common:Archive){
  const keys=new Map<number,string>();
  for await(const resource of scanSmallReadableResources(common,districtPageSize)){
    for(const [key,stem] of text.decode(resource.bytes).matchAll(/REGION_([A-Z0-9_]+)_NAME\b/g))
      keys.set(joaat(key),stem);
  }
  return keys;
}

async function readNames(common:Archive,localization:Archive,englishSource:Promise<Uint8Array>,regionIds:Set<number>){
  const [dictionary,keys,anchors,english,extra]=await Promise.all([
    readPso(localization,dialogueNamesHint).then(labels),
    findRegionKeys(common),
    readPso(localization,labelAnchorsHint),
    englishSource,
    readAdjacentResource(localization,extraTextHint,0x1c0000),
  ]);
  const decoder=new TextDecoder();
  const matched=new Map<number,{name:string;score:number}>();
  for(const payload of [english,extra]){
    const document=decoder.decode(payload);
    for(const phrase of document.matchAll(/[A-Z0-9][A-Za-z0-9'’-]*(?:[ .&'-]+[A-Za-z0-9][A-Za-z0-9'’-]*)*/g)){
      const words=[...phrase[0].matchAll(/[A-Za-z0-9][A-Za-z0-9'’-]*/g)];
      for(let first=0;first<words.length;first++){
        const word=words[first];
        if(!/^[A-Z0-9]/.test(word[0]))continue;
        const begin=word.index;
        for(let last=first;last<Math.min(first+8,words.length);last++){
          const end=words[last].index+words[last][0].length;
          if(end-begin>55)break;
          const name=phrase[0].slice(begin,end).replace(/[’']s$/i,""),id=regionId(name);
          if(!regionIds.has(id))continue;
          const start=phrase.index+begin,stop=phrase.index+end;
          const score=3*Number(/[a-z]/.test(name))+Number(document[start-1]==="\0")+
            Number(document[stop]==="\0");
          if((matched.get(id)?.score??-1)<score)matched.set(id,{name,score});
        }
      }
    }
  }
  for(const [id,{name}] of matched)dictionary.set(id,name);
  const exactNames=new Map<number,string>();
  for(const [key,candidates] of englishLabels(english,new Set(keys.keys()))){
    const stem=keys.get(key)!;
    const expected=compact(stem)
      .replace(/^(vicecounty)(s|w)?$/,"vice$2county")
      .replace(/^kellycountye$/,"eastkellycounty")
      .replace(/^lummoxcountysw$/,"southwestlummoxcounty")
      .replace(/^portvc$/,"portvicecity")
      .replace(/^milezeroairbase$/,"milezeroairstation");
    // Some adjacent entries share an index. Verify the label against its key
    // before accepting either the indexed string or its immediate successor.
    const name=candidates.find(candidate=>{
      const normalized=compact(candidate).replace(/^southvicedalecounty$/,"vicescounty")
        .replace(/^westvicedalecounty$/,"vicewcounty").replace(/^vicedalecounty$/,"vicecounty")
        .replace(/nationalpark$/,"park");
      return /^[\p{L}\p{N}][\p{L}\p{N} .’'&-]{1,55}$/u.test(candidate)&&
        (normalized===expected||normalized===`${expected}s`||
          (stem==="RICHARD_BAREBONE"&&normalized==="richardbarebonestatepark"));
    });
    if(!name)continue;
    exactNames.set(key,name);
    dictionary.set(regionId(name),name);
    // The registry key can use an abbreviation while the label uses full words.
    dictionary.set(regionId(stem),name);
    dictionary.set(joaat(`region_${stem}`),name);
  }
  const mapLabels:MapLabel[]=[];
  const data=view(anchors),seen=new Set<string>();
  for(const block of blocks(data)){
    if(block.type!==0xd4b18146)continue;
    for(let at=block.start;at+48<=block.end;at+=48){
      const name=exactNames.get(data.getUint32(at,true));
      if(!name)continue;
      const point:Point=[data.getFloat32(at+16,true)/CELL,-data.getFloat32(at+20,true)/CELL];
      const key=`${name}:${point}`;
      if(!point.every(Number.isFinite)||seen.has(key))continue;
      seen.add(key);
      const group=data.getUint32(at+4,true);
      const minScale=group===0x9a9303e1||group===0xf9cb0d65?0:
        group===0x5803dcfc||group===0x85f44dbe?5:group===0xe44f290?8:16;
      mapLabels.push({name,point,minScale});
    }
  }
  return {dictionary,mapLabels};
}

function regions(payload:Uint8Array,names:Map<number,string>,detail:boolean):District[]{
  const data=view(payload),table=blocks(data);
  const idAt=(at:number)=>data.getUint32(at,true);
  function pointer(at:number,type:number,length:number){
    const ref=data.getBigUint64(at,true);
    const block=table[Number(ref&0xfffffn)-1];
    const offset=Number(ref>>20n);
    if(!block||block.type!==type||offset+length>block.end-block.start)return -1;
    return block.start+offset;
  }
  const result:District[]=[];
  for(const block of table){
    if(block.type!==0xb55501c9)continue;
    for(let row=block.start;row+224<=block.end;row+=224){
      const hash=idAt(row+16),name=names.get(hash);
      const shape=pointer(row+24,0xfc24fa58,48);
      if(shape<0)continue;
      const count=data.getUint16(shape+16,true);
      const vertices=pointer(shape+8,0x31,count*16);
      if(vertices<0||count<3)continue;
      const ring:Point[]=Array.from({length:count},(_,i)=>[
        data.getFloat32(vertices+i*16,true)/CELL,-data.getFloat32(vertices+i*16+4,true)/CELL,
      ]);
      if(ring.some(p=>!p.every(Number.isFinite)))continue;
      const x=ring.map(p=>p[0]),y=ring.map(p=>p[1]);
      const left=Math.min(...x),top=Math.min(...y);
      const bounds:Rect=[left,top,Math.max(...x)-left,Math.max(...y)-top];
      let area2=0,cx=0,cy=0;
      for(let i=0,j=count-1;i<count;j=i++){
        const cross=x[j]*y[i]-x[i]*y[j];
        area2+=cross;cx+=(x[j]+x[i])*cross;cy+=(y[j]+y[i])*cross;
      }
      if(Math.abs(area2)<1e-6)continue;
      const centroid:Point=[cx/(3*area2),cy/(3*area2)];
      const anchor=contains(ring,centroid)?centroid:interiorPoint(ring,bounds);
      result.push({id:hex(hash),name,detail,ring,bounds,anchor,area:Math.abs(area2)/2});
    }
  }
  return result;
}

export function contains(ring:Point[],[x,y]:Point){
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const [a,b]=ring[i],[c,d]=ring[j];
    if((b>y)!==(d>y)&&x<a+(c-a)*(y-b)/(d-b))inside=!inside;
  }
  return inside;
}

function interiorPoint(ring:Point[],[x,y,w,h]:Rect):Point {
  let best:Point=ring[0],score=0;
  for(let row=1;row<20;row++){
    const v=y+h*row/20,edges:number[]=[];
    for(let i=0,j=ring.length-1;i<ring.length;j=i++){
      const [a,b]=ring[i],[c,d]=ring[j];
      if((b>v)!==(d>v))edges.push(a+(c-a)*(v-b)/(d-b));
    }
    edges.sort((a,b)=>a-b);
    for(let i=0;i+1<edges.length;i+=2){
      const width=edges[i+1]-edges[i];
      if(width>score){score=width;best=[edges[i]+width/2,v];}
    }
  }
  return score?best:[x+w/2,y+h/2];
}

export function loadEnglish(localization:Archive){
  return readAdjacentResource(localization,englishHint,0x3b0000);
}

// A build-specific seek hint for the district manifest. Region member sizes
// and page boundaries are recovered from the selected levels archive.
const districtMountHint=0xf96c4000;

async function readDistrictShapes(archive:Archive){
  const found:Uint8Array[]=[];
  let afterManifest=false;
  for await(const resource of scanSmallReadableResources(archive,districtPageSize,false,districtMountHint,128*1024)){
    const data=view(resource.bytes);
    if(data.byteLength<24||data.getUint32(0)!==0x5053494e)continue;
    if(!afterManifest){
      afterManifest=text.decode(resource.bytes).includes("map_regions_30_districts/all.pso.meta\0");
      continue;
    }
    const payload=await readPsoPages(archive,resource).catch(()=>undefined);
    if(!payload)continue;
    const sections=blocks(view(payload));
    if(!sections.some(block=>block.type===0xb55501c9))continue;
    if(!sections.some(block=>block.type===(found.length?0xb85800d2:0x5d497a7e)))continue;
    found.push(payload);
    if(found.length===2)return found;
  }
  throw new Error("District region data is unavailable.");
}

export async function loadDistricts(levels:Archive,common:Archive,localization?:Archive,english?:Promise<Uint8Array>){
  const shapes=await readDistrictShapes(levels);
  const districts=shapes.flatMap((bytes,index)=>regions(bytes,new Map(),index>0)).sort((a,b)=>a.area-b.area);
  if(!localization)return {districts,mapLabels:[]};
  const ids=new Set(districts.map(district=>Number(district.id)));
  const {dictionary,mapLabels}=await readNames(common,localization,english??loadEnglish(localization),ids);
  for(const district of districts)district.name=dictionary.get(Number(district.id));
  return {districts,mapLabels};
}

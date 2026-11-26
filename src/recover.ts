import { Archive, hex, identify, inflate, readResources, text, view } from "./archive";
import { loadPack, mipRecords, type Pack, type Texture } from "./texture";
import { reviewNeighborSeams, reviewSectorCrops } from "./review";
import compatibility from "./xbox-series-compatibility.json";
import { findSmallReadableResource } from "./readable-resources";
import { catalogueSatelliteTerrain } from "./satellite-catalog";

const SYSTEM = 0x50000000;
export const CELL = 128;
export type Rect = [x:number,y:number,w:number,h:number];
export type Mesh = { name: string; offset: number; bindingOffset: number; field: string };
export type Placement = { x: number; y: number; id: string; meshes: Mesh[]; boundsOffset?: number; recovery?: "seams"|"sector"|"seams-and-sector"|"edges" };
export type Sector = {
  x: number; y: number; id: string; mesh: Mesh; alternatives: string[];
};
export type Atlas = {
  build: string; world: Rect; cells: Placement[]; sectors: Sector[];
  catalog: string[]; textures: Record<string,Texture>; optional: string[];
};
export type Issue = { path: string; required: boolean; detail: string };
export type ImportState = { atlas: Atlas; archives: Map<string,Archive>; packs: Map<string,Pack>; issues: Issue[] };
type Drawable = { name: string; east: number; north: number; patch: number; meshes: Map<string,Mesh> };

export const origin = (s: number) => 4*(s-Number(s>0));
export const cellKey = (x:number,y:number) => `${x},${y}`;
const sectorKey = (east:number,north:number) => cellKey(east,north);

function coords(ns:string,n:string,ew:string,e:string) {
  return [Number(e)*(ew==="w"?-1:1),Number(n)*(ns==="s"?-1:1)] as const;
}

function namePointers(data: DataView) {
  const pointers=new Map<number,number>();
  for (let at=0;at+8<=data.byteLength;at+=8) {
    const low = data.getUint32(at,true);
    if (low>=SYSTEM && low<SYSTEM+data.byteLength && data.getUint32(at+4,true)===0) {
      pointers.set(low-SYSTEM,pointers.has(low-SYSTEM) ? -1 : at);
    }
  }
  return pointers;
}

export function readDrawables(payload: Uint8Array, offset: number, kind: "lod"|"slod"|"slod2", known: Map<bigint,Texture>) {
  const raw=text.decode(payload);
  const names = kind==="slod2" ? /([ns])(\d\d)_([ew])(\d\d)_slod2\.#dr\x00/g :
    new RegExp(`([ns])(\\d\\d)_([ew])(\\d\\d)_(\\d{3})_${kind}\\.#dr\\x00`,"g");
  const data=view(payload);
  const matches=[...raw.matchAll(names)];
  if (!matches.length) return [];
  const pointers=namePointers(data);
  const result: Drawable[]=[];
  for (const match of matches) {
    const [east,north]=coords(match[1],match[2],match[3],match[4]);
    const patch=Number(match[5]??0);
    if (!east||!north || (kind==="lod"&&(patch<1||patch>64)) || (kind==="slod"&&(patch<1||patch>16))) continue;
    const ptr=pointers.get(match.index!)??-1;
    if (ptr<0x78 || ptr+8>payload.length) continue;
    const low=kind==="slod2"?511.5:kind==="slod"?124:63.5;
    const high=kind==="slod2"?514:kind==="slod"?145:64.5;
    const spans=[0,4].map(a=>data.getFloat32(ptr-0x68+a,true)-data.getFloat32(ptr-0x78+a,true));
    if (!spans.every(n=>n>=low&&n<=high)) continue;
    const footer = data.getUint32(ptr-0x58,true)-SYSTEM;
    if (footer<=0 || footer%16 || footer+32>payload.length || data.getUint32(ptr-0x54,true)) continue;
    const name=match[0].slice(0,-1);
    const meshes=new Map<string,Mesh>();
    let hasBinding=false;
    const size=kind==="slod2"?512:1024;
    for(let at=footer-32;at>=Math.max(0,footer-32*128);at-=32) {
      if (data.getBigUint64(at,true)!==6n ||
          data.getUint32(at+12,true) ||
          data.getBigUint64(at+16,true)!==BigInt(SYSTEM+at+5)) break;
      const texture=known.get(data.getBigUint64(at+24,true));
      hasBinding ||= texture!==undefined;
      if (texture?.width===size && texture.height===size && texture.mode===0x243)
        meshes.set(texture.id,{name,offset,bindingOffset:at,field:hex(data.getUint32(at+8,true))});
    }
    if (meshes.size>0 || kind==="lod"&&hasBinding) result.push({name,east,north,patch,meshes});
  }
  return result;
}

function parseSectorBounds(payload: Uint8Array, offset: number) {
  const raw=text.decode(payload);
  const data=view(payload);
  const name=raw.slice(0x20,0x28).match(/^([ns])(\d\d)_([ew])(\d\d)\x00$/);
  if (payload.length!==0xa60 || !raw.startsWith("PSIN") || raw.slice(-20,-16)!=="CHKS" || !name ||
      data.getUint32(4)!==0x8e0 || data.getUint32(8)!==0x4c4efe40 || raw.slice(0x8e0,0x8e4)!=="LSCH")
    throw new Error(`levels.rpf: invalid sector bounds at ${hex(offset)}`);
  const [east,north]=coords(name[1],name[2],name[3],name[4]);
  const west=origin(east)*CELL,south=origin(north)*CELL;
  const p=(at:number,x:number,y:number,width:number) => data.getFloat32(at,true)===x &&
    data.getFloat32(at+4,true)===y && data.getFloat32(at+16,true)===x+width && data.getFloat32(at+20,true)===y+width;
  if (!p(0xc0,west,south,512)) throw new Error(`levels.rpf: sector origin mismatch at ${hex(offset)}`);
  for(let i=0;i<64;i++) if (!p(0xe0+i*32,west+(i%8)*64,south+(7-Math.floor(i/8))*64,64))
    throw new Error(`levels.rpf: invalid patch coordinates at ${hex(offset)}`);
  return sectorKey(east,north);
}

export async function loadWorld(archive:Archive) {
  const candidate=await findSmallReadableResource(archive,65536,bytes=>{
    const textStart=text.decode(bytes.subarray(0,128)).trimStart();
    return textStart.startsWith("<")&&text.decode(bytes).includes("<RegionTintMap>");
  });
  const xml=candidate?text.decode(candidate):"";
  const min=xml.match(/<WorldAABBMin\s+x="([-.\d]+)"\s+y="([-.\d]+)"\s*\/>/);
  const max=xml.match(/<WorldAABBMax\s+x="([-.\d]+)"\s+y="([-.\d]+)"\s*\/>/);
  if (!xml.includes("<RegionTintMap>") || !min || !max) throw new Error("common.rpf: RegionTintMap bounds missing");
  const result:[number,number,number,number]=[
    +min[1]/CELL,-max[2]/CELL,(+max[1]- +min[1])/CELL,(+max[2]- +min[2])/CELL,
  ];
  if (!result.every(Number.isInteger) || result[2]<=0 || result[3]<=0)
    throw new Error("common.rpf: invalid terrain bounds");
  return result;
}

function placements(drawables: Drawable[], bounds:Map<string,number>) {
  const groups = new Map<string,Map<string,{draw:Drawable;mesh:Mesh}>>();
  for (const draw of drawables) for (const [id,mesh] of draw.meshes) {
    let group=groups.get(id);
    if(!group) groups.set(id,group=new Map());
    group.set(`${draw.east},${draw.north},${draw.patch}`,{draw,mesh});
  }
  const cells=new Map<string,Placement|null>();
  const candidates=new Map<string,Placement|null>();
  for (const [id,group] of groups) {
    if (group.size<2 || group.size>4) continue;
    const rows=[...group.values()].sort((a,b)=>a.draw.patch-b.draw.patch);
    const {east,north,patch}=rows[0].draw;
    const col=Math.floor((patch-1)%8/2),row=Math.floor((patch-1)/16);
    if (!rows.every(({draw})=>draw.east===east&&draw.north===north&&
      Math.floor((draw.patch-1)%8/2)===col&&Math.floor((draw.patch-1)/16)===row))
      continue;
    const x=origin(east)+col,y=-origin(north)-row-1;
    const key=cellKey(x,y);
    const target=group.size===4?cells:candidates;
    target.set(key,target.has(key)?null:{x,y,id,meshes:rows.map(row=>row.mesh),boundsOffset:bounds.get(sectorKey(east,north))});
  }
  return {
    cells:[...cells.values()].filter((cell):cell is Placement=>cell!==null).sort((a,b)=>a.y-b.y||a.x-b.x),
    candidates:[...candidates.values()].filter((cell):cell is Placement=>cell!==null&&
      cell.boundsOffset!==undefined&&!cells.has(cellKey(cell.x,cell.y))),
  };
}

async function catalogFor(pack:Pack) {
  const candidates:{texture:Texture;offset:number}[]=[];
  const optional=pack.source.path.includes("image_based");
  for(const texture of pack.descriptors) {
    const mips=mipRecords(pack,texture);
    const base=mips.find(s=>s.side===256&&mips.some(m=>m.side===512&&m.stream===s.stream+1)&&
      (!optional||(pack.addresses[s.stream+1]-pack.addresses[s.stream]===32768&&
        pack.addresses[s.stream+2]-pack.addresses[s.stream+1]===131072)));
    if(base)candidates.push({texture,offset:base.offset});
  }
  if(!optional)return candidates.map(row=>row.texture.id);
  const readable:string[]=[];
  for(let i=0;i<candidates.length;i+=48) {
    const batch=candidates.slice(i,i+48);
    const probes=await Promise.all(batch.map(row=>pack.source.read(row.offset,2)));
    for(const [j,bytes] of probes.entries()) {
      if(bytes[0]===0x78&&(bytes[0]*256+bytes[1])%31===0&&!(bytes[1]&32))
        readable.push(batch[j].texture.id);
    }
  }
  return readable;
}

async function readSatelliteModels(levels:Archive,common:Archive,executable:Blob,known:Map<bigint,Texture>,
  progress:(count:number,total:number)=>void){
  const catalogue=await catalogueSatelliteTerrain(levels,common,executable);
  const lod:Drawable[]=[],slod:Drawable[]=[],slod2:Drawable[]=[],bounds=new Map<string,number>();
  let done=0;
  for await(const {offset,bytes} of readResources(levels,catalogue.drawables)){
    const metadata=inflate(bytes,512*1024);
    lod.push(...readDrawables(metadata,offset,"lod",known));
    slod.push(...readDrawables(metadata,offset,"slod",known));
    slod2.push(...readDrawables(metadata,offset,"slod2",known));
    if(++done%256===0||done===catalogue.drawables.length)progress(done,catalogue.drawables.length);
  }
  for await(const {offset,bytes} of readResources(levels,catalogue.bounds)){
    const metadata=inflate(bytes,65536);
    if(metadata.byteLength!==0xa60||view(metadata).getUint32(8)!==0x4c4efe40)continue;
    const key=parseSectorBounds(metadata,offset);
    if(bounds.has(key))throw new Error("Duplicate terrain sector bounds.");
    bounds.set(key,offset);
  }
  return {lod,slod,slod2,bounds};
}

export class ImportFailure extends Error {
  constructor(readonly issues:Issue[]) {
    super("The required archive files could not be imported");
  }
}

export const pauseArchive=(path:string)=>path==="common.rpf"||path==="levels.rpf";
export const imageryArchive=(path:string)=>path.startsWith("data/ttdb/terrain/");

export async function openArchives(inputs:Record<string,Blob>,include=(path:string)=>true,required=true,readTerrain=true) {
  const archives=new Map<string,Archive>(),packs=new Map<string,Pack>(),issues:Issue[]=[];
  const sources=inputProfile.filter(spec=>include(spec.path));
  for(let start=0;start<sources.length;start+=6){
    const results=await Promise.all(sources.slice(start,start+6).map(async spec=>{
      const file=inputs[spec.path];
      if(!file)return {spec,problem:"Missing file"};
      const source=new Archive(spec.path,file);
      try{
        await identify(source,spec);
        const pack=readTerrain&&imageryArchive(spec.path)?await loadPack(source):undefined;
        return {spec,source,pack};
      }catch(error){
        return {spec,problem:String((error as Error).message)};
      }
    }));
    // Keep profile order for pack lookup and error reporting.
    for(const {spec,source,pack,problem} of results){
      if(!source)issues.push({path:spec.path,required:spec.required,detail:problem??"Unreadable file"});
      else{
        if(pack)packs.set(spec.path,pack);
        archives.set(spec.path,source);
      }
    }
  }
  if (required&&issues.some(issue=>issue.required)) throw new ImportFailure(issues);
  return {archives,packs,issues};
}

export async function recover({archives,packs,issues}:Awaited<ReturnType<typeof openArchives>>,world:Rect,
  progress:(label:string,done:number,total:number)=>void,executable:Blob):Promise<ImportState> {
  const levels=archives.get("levels.rpf")!;
  const known = new Map<bigint,Texture>();
  const textureList = [...packs.values()].flatMap(pack=>pack.descriptors);
  for (const texture of textureList) known.set(BigInt(texture.id),texture);
  const common=archives.get("common.rpf");
  if(!common)throw new Error("Opening Satellite requires common.rpf.");
  progress("Discovering satellite terrain",0,0);
  const {lod:meshes,slod2:coarse,slod:middle,bounds}=await readSatelliteModels(levels,common,executable,known,
    (count,total)=>progress("Reading terrain mesh bindings",count,total));
  const options=new Map<string,Map<string,Set<number>>>();
  for (const draw of middle) {
    const key=sectorKey(draw.east,draw.north);
    let list=options.get(key);
    if(!list) options.set(key,list=new Map());
    for(const id of draw.meshes.keys()) {
      let patches=list.get(id);
      if(!patches) list.set(id,patches=new Set());
      patches.add(draw.patch);
    }
  }
  const sectors:Sector[]=[];
  const observed=new Set(meshes.map(draw=>sectorKey(draw.east,draw.north)));
  for (const draw of coarse) if(draw.meshes.size===1&&observed.has(sectorKey(draw.east,draw.north))) {
    const [id,mesh]=[...draw.meshes][0];
    const list=[...(options.get(sectorKey(draw.east,draw.north))??[])];
    const alternatives=list.filter(([,patches])=>patches.size>=8).sort((a,b)=>b[1].size-a[1].size).map(([id])=>id);
    sectors.push({x:origin(draw.east),y:-origin(draw.north)-4,id,mesh,alternatives});
  }
  const {cells,candidates}=placements(meshes,bounds);
  if (cells.length!==8103 || sectors.length!==589)
    throw new Error(`levels.rpf: terrain index is incomplete (${cells.length}/8103 cells, ${sectors.length}/589 sectors)`);
  const catalog = new Set<string>();
  const textures: Record<string,Texture> = Object.create(null);
  for (const pack of packs.values()) {
    for(const id of await catalogFor(pack))catalog.add(id);
    for(const texture of pack.descriptors)textures[texture.id]=texture;
  }
  const verified=await reviewNeighborSeams(cells,candidates.filter(cell=>cell.meshes.length===3),packs,textures,
    (done,total)=>progress("Checking seams around missing cells",done,total));
  const seamIds=new Set(verified.map(cell=>cell.id));
  const {verified:bySector,evidence}=await reviewSectorCrops(sectors,candidates.filter(cell=>!seamIds.has(cell.id)),packs,textures,
    (done,total)=>progress("Comparing missing cells with sector imagery",done,total));
  cells.push(...verified,...bySector);
  const recoveredIds=new Set([...seamIds,...bySector.map(cell=>cell.id)]);
  const corroborated=await reviewNeighborSeams(cells,candidates.filter(cell=>!recoveredIds.has(cell.id)),packs,textures,
    (done,total)=>progress("Checking edges around the remaining gaps",done,total),evidence);
  cells.push(...corroborated);
  corroborated.forEach(cell=>recoveredIds.add(cell.id));
  const byEdges=await reviewNeighborSeams(cells,candidates.filter(cell=>!recoveredIds.has(cell.id)),packs,textures,
    (done,total)=>progress("Checking detailed tiles with different geometry",done,total),"edges");
  cells.push(...byEdges);
  for (const cell of cells) catalog.add(cell.id);
  return {atlas:{build:compatibility.build,world,cells,sectors,catalog:[...catalog],textures,
                 optional:compatibility.files.filter(f=>!f.required&&archives.has(f.path)).map(f=>f.path)},
          packs,archives,issues};
}

const streetNavigation={path:"navmeshes.rpf",size:6707512496,required:false,probes:[
  [0,"fa6627a1cfa3b1662673206680a0f915be4112886954d1cd189730d5512ed767"],
  [1801031680,"48456d08e425f1dd886d4ca566a08c0844cff80b0565d87bf21c48630aab8a63"],
  [4120727552,"12693945e02060a7fab65ad15791a713c7d031faf353be3764962e90a86d496d"],
]};
export const inputProfile=[...compatibility.files,...compatibility.texturePacks,streetNavigation];
export const buildName=compatibility.build;
export const optionalArchives=compatibility.files.filter(file=>!file.required).map(file=>file.path);

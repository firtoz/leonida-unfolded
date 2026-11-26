import { view, type Archive } from "./archive";
import { CELL } from "./recover";
import type { Point } from "./districts";
import { readAdjacentResourcePage, scanSmallReadableResources } from "./readable-resources";

export type PlaceKind = "Shop"|"Food and drink"|"Landmark"|"Place";
export type Place = { name:string; point:Point; kind:PlaceKind; elevation:number };

export function joaat(name:string){
  let hash=0;
  for(const c of name.toLowerCase()){
    hash=Math.imul(hash+c.charCodeAt(0),1025);
    hash^=hash>>>6;
  }
  hash=Math.imul(hash,9);
  hash^=hash>>>11;
  return Math.imul(hash,32769)>>>0;
}

export const compact=(name:string)=>name.toLowerCase().replace(/[^a-z0-9]/g,"");

export function englishLabels(payload:Uint8Array,keys:Set<number>){
  const decoder=new TextDecoder();
  if(payload.length!==0x3b0000||decoder.decode(payload.subarray(0x10,0x14))!=="0DRP")
    throw new Error("Invalid English localization resource.");
  const strings=decoder.decode(payload.subarray(0x110060,0x3ad050)).split("\0");
  const data=view(payload),result=new Map<number,string[]>();
  for(let at=0x70;at<0x110000;at+=16){
    const key=data.getUint32(at,true);
    if(!keys.has(key))continue;
    const ref=data.getBigUint64(at+8,true);
    if((ref&0xffffffn)!==1n)continue;
    const index=Number(ref>>24n);
    result.set(key,strings.slice(index,index+2));
  }
  return result;
}

function kindFor(key:string):PlaceKind {
  if(/STADIUM|MUSEUM|MONUMENT|LIGHTHOUSE|OBSERVATORY|AQUARIUM|AIRPORT|AIRFIELD|MARINA|RACEWAY|THEATER|THEATRE/.test(key))
    return "Landmark";
  if(/CONVENIENCE|MARKET|PAWN|LIQUOR|GASSTATION|GASOLINE|FUEL|SHOP|GROCERY|AMMUNATION|GUNSTORE|DEALERSHIP/.test(key))
    return "Shop";
  if(/RESTAURANT|BURGER|PIZZA|DINER|COFFEE|CAFE|BAKERY|TAVERN|BAR(?:_|$)/.test(key))
    return "Food and drink";
  return "Place";
}

export async function readLocationNames(common:Archive){
  const opening="<GameShape__Data__LocationNameLoopkup>";
  const closing="</GameShape__Data__LocationNameLoopkup>";
  const decoder=new TextDecoder();
  let first:Awaited<ReturnType<typeof readAdjacentResourcePage>>|undefined;
  for await(const resource of scanSmallReadableResources(common,65536,true)){
    if(decoder.decode(resource.bytes.subarray(0,512)).includes(opening)){
      first=resource;
      break;
    }
  }
  if(!first)throw new Error("Location name table is unavailable.");
  let page=first,xml=decoder.decode(page.bytes,{stream:true});
  while(!xml.endsWith(closing)&&page.bytes.length===65536){
    if(xml.length>=16*1024*1024)throw new Error("Location name table exceeds its size limit.");
    page=await readAdjacentResourcePage(common,page.next,65536);
    xml+=decoder.decode(page.bytes,{stream:true});
  }
  xml+=decoder.decode();
  if(!xml.endsWith(closing))throw new Error("Invalid location name table.");
  return xml;
}

export async function loadPlaces(common:Archive,english:Promise<Uint8Array>){
  const xml=await readLocationNames(common);
  const interior=xml.match(/<InteriorNames>([\s\S]*?)<\/InteriorNames>/)?.[1];
  if(!interior)throw new Error("Location table missing its interior entries.");
  const nodes=[...interior.matchAll(/<Name>(LOCATION_([A-Z0-9_]+)_NAME)<\/Name>\s*<Pos x="([-\d.e+]+)" y="([-\d.e+]+)" z="([-\d.e+]+)"\s*\/>/g)];
  const entries=new Map(nodes.map(([,key,stem])=>[joaat(key),stem]));
  const choices=englishLabels(await english,new Set(entries.keys()));
  const names=new Map<string,string>();
  for(const [id,stem] of entries){
    const expected=compact(stem);
    const candidates=choices.get(id)??[];
    const name=candidates.find(label=>compact(label)===expected)||candidates.find(label=>{
      const normalized=compact(label);
      return /^[\p{L}\p{N}¡¿][\p{L}\p{N} .’'&!,+()/\-]{1,65}$/u.test(label)&&normalized.length>=4&&
        Math.min(expected.length,normalized.length)/Math.max(expected.length,normalized.length)>=.48&&
        (expected.includes(normalized)||normalized.includes(expected));
    });
    if(name)names.set(stem,name);
  }
  const result:Place[]=[];
  const byName=new Map<string,Point[]>();
  for(const [,,stem,sx,sy,sz] of nodes){
    const name=names.get(stem);
    if(!name)continue;
    const [x,y,z]=[Number(sx),Number(sy),Number(sz)];
    if(![x,y,z].every(Number.isFinite)||Math.abs(x)>20000||Math.abs(y)>20000||Math.abs(z)>1500)continue;
    const point:Point=[x/CELL,-y/CELL],previous=byName.get(name)??[];
    if(previous.some(([px,py])=>Math.hypot((px-point[0])*CELL,(py-point[1])*CELL)<12))continue;
    previous.push(point);
    byName.set(name,previous);
    result.push({name,point,kind:kindFor(stem),elevation:z});
  }
  return result.sort((a,b)=>Number(b.kind==="Landmark")-Number(a.kind==="Landmark"));
}

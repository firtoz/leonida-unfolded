import { view, type Archive } from "./archive";
import { englishLabels, joaat, readLocationNames } from "./places";
import { StreetRpf9 } from "./street-rpf9";

type Position = readonly [number,number,number];
export type NamedRoad = { name:string; a:Position; b:Position };
type RoadNode = { position:Position; address:number; name?:string; first:number };
type Region = { start:number; length:number };

const nodeType=0x0c69a100,linkType=0x0f2da4c2;
const cellSize=128;
const abbreviations:Record<string,string>={street:"st",road:"rd",drive:"dr",avenue:"ave",boulevard:"blvd",lane:"ln",
  court:"ct",place:"pl",highway:"hwy",parkway:"pkwy",terrace:"ter",circle:"cir",causeway:"cswy",
  expressway:"expy",trail:"trl",bridge:"brg"};
const roadEnding=/(?:st|rd|dr|ave|blvd|ln|ct|pl|hwy|pkwy|ter|cir|cswy|expy|trl|brg|tunnel|loop|alley|way|plaza|promenade)$/;
const normalize=(name:string)=>name.normalize("NFD").toLowerCase().replace(/[^a-z0-9]/g,"");
function canonical(name:string){
  const value=normalize(name);
  const ending=Object.keys(abbreviations).find(key=>value.endsWith(key));
  return ending?value.slice(0,-ending.length)+abbreviations[ending]:value;
}
function matchingName(key:string,candidates:readonly string[]){
  const expected=canonical(key);
  const valid=candidates.filter(name=>/^[\p{L}\p{N}][\p{L}\p{N} .’'&-]{1,49}$/u.test(name));
  return valid.find(name=>canonical(name)===expected)??valid.find(name=>{
    const candidate=canonical(name);
    if(/^\d/.test(expected))return candidate.replace(/^(?:sr|us|i)(?=\d)/,"")===expected;
    return candidate.replace(roadEnding,"")===expected;
  });
}

async function roadDictionary(common:Archive,english:Promise<Uint8Array>){
  const xml=await readLocationNames(common);
  const names=xml.match(/<RoadNames>([\s\S]*?)<\/RoadNames>/)?.[1];
  if(!names)throw new Error("Road name references are unavailable.");
  const entries=[...names.matchAll(/<Item key="([^"]+)">\s*<Name>([A-Z0-9_]+)<\/Name>/g)]
    .map(([,key,label])=>({id:joaat(key),key:joaat(label),stem:label.replace(/^[A-Z]+_|_NAME$/g,"")}));
  const localized=englishLabels(await english,new Set(entries.map(entry=>entry.key)));
  const dictionary=new Map<number,string>();
  for(const {id,key,stem} of entries){
    const name=matchingName(stem,localized.get(key)??[]);
    if(name)dictionary.set(id,name);
  }
  return dictionary;
}

// Metadata block layout and graph record fields are documented in SixNG.
function blocks(bytes:Uint8Array,type:number,stride:number):Region[]{
  const data=view(bytes);
  if(data.byteLength<0x50||data.getUint32(0x10)!==0x30445250||data.getUint8(0x14)!==0x7a)return [];
  const table=Number(data.getBigUint64(0x38,true))-0x50000000,count=data.getUint16(0x4c,true);
  if(table<0x50||table+count*16>data.byteLength)return [];
  const result:Region[]=[];
  for(let i=0;i<count;i++){
    const row=table+i*16;
    if(data.getUint32(row,true)!==type)continue;
    const length=data.getUint32(row+4,true),start=Number(data.getBigUint64(row+8,true))-0x50000000;
    if(start<0x50||start+length>data.byteLength||length%stride)throw new Error("Invalid road graph block.");
    result.push({start,length});
  }
  return result;
}

function readNodes(bytes:Uint8Array,regions:Region[],dictionary:Map<number,string>){
  const data=view(bytes),nodes:RoadNode[]=[];
  for(const {start,length} of regions)for(let at=start;at<start+length;at+=60)nodes.push({
    position:[data.getFloat32(at,true),data.getFloat32(at+4,true),data.getFloat32(at+8,true)],
    address:data.getUint32(at+0x14,true),name:dictionary.get(data.getUint32(at+0x20,true)),
    first:data.getUint32(at+0x38,true),
  });
  return nodes;
}
function readLinks(bytes:Uint8Array,regions:Region[]){
  const data=view(bytes),links:number[]=[];
  for(const {start,length} of regions)for(let at=start;at<start+length;at+=20)links.push(data.getUint32(at,true));
  return links;
}
function namedSegments(nodes:RoadNode[],links:number[]){
  const byAddress=new Map(nodes.map((node,index)=>[node.address,index]));
  const roads:NamedRoad[]=[],seen=new Set<number>();
  for(const [i,node] of nodes.entries()){
    const end=nodes[i+1]?.first??links.length;
    if(node.first>end||end>links.length)throw new Error("Invalid road graph link range.");
    for(let link=node.first;link<end;link++){
      const j=byAddress.get(links[link]);
      if(j===undefined||i===j)continue;
      const other=nodes[j],key=Math.min(i,j)*nodes.length+Math.max(i,j);
      if((!node.name&&!other.name)||seen.has(key))continue;
      const a=node.position,b=other.position;
      if(![...a,...b].every(value=>Number.isFinite(value)&&Math.abs(value)<50000)||Math.hypot(a[0]-b[0],a[1]-b[1])<.5)continue;
      seen.add(key);
      if(node.name&&node.name===other.name){roads.push({name:node.name,a,b});continue;}
      const middle:Position=[(a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2];
      if(node.name)roads.push({name:node.name,a,b:middle});
      if(other.name)roads.push({name:other.name,a:middle,b});
    }
  }
  return roads;
}

export async function loadRoadNames(levels:Archive,common:Archive,executable:Blob,english:Promise<Uint8Array>){
  const directory=new StreetRpf9(levels,executable);
  const [dictionary,{mounts}]=await Promise.all([roadDictionary(common,english),directory.levelMounts(common)]);
  const mount=[...mounts.values()].find(row=>row.path.endsWith("/road_nodes.rpf"));
  if(!mount)throw new Error("The road graph is unavailable.");
  const members=await directory.mountedMembers(mount,new Set([0x0b]));
  members.sort((a,b)=>(b.systemBytes??0)-(a.systemBytes??0));
  let nodes:RoadNode[]|undefined,links:number[]|undefined;
  for(const member of members){
    if(nodes&&links)break;
    const bytes=await directory.readSystem(member).catch(()=>undefined);
    if(!bytes)continue;
    const nodeBlocks=!nodes&&blocks(bytes,nodeType,60),linkBlocks=!links&&blocks(bytes,linkType,20);
    if(nodeBlocks&&nodeBlocks.length)nodes=readNodes(bytes,nodeBlocks,dictionary);
    if(linkBlocks&&linkBlocks.length)links=readLinks(bytes,linkBlocks);
  }
  if(!nodes||!links)throw new Error("The road graph could not be read.");
  return namedSegments(nodes,links);
}

export type RoadLabelPath={id:number;name:string;points:Position[];anchor:Position;anchorIndex:number;length:number;
  bounds:readonly [left:number,bottom:number,right:number,top:number]};

function labelPaths(roads:NamedRoad[]){
  const junctions=new Map<string,number[]>(),visited=new Set<number>(),result:RoadLabelPath[]=[];
  const key=(name:string,point:Position)=>`${name}:${point.join(",")}`;
  for(const [index,{name,a,b}] of roads.entries())for(const point of [a,b]){
    const id=key(name,point),incident=junctions.get(id);
    if(incident)incident.push(index);else junctions.set(id,[index]);
  }
  for(const [index,{name,a,b}] of roads.entries()){
    if(visited.has(index))continue;
    visited.add(index);
    const extend=(start:Position)=>{
      const points:Position[]=[];
      let at=start;
      for(;;){
        const incident=junctions.get(key(name,at));
        if(incident?.length!==2)break;
        const next=incident.find(value=>!visited.has(value));
        if(next===undefined)break;
        visited.add(next);
        const road=roads[next];
        at=key(name,road.a)===key(name,at)?road.b:road.a;
        points.push(at);
      }
      return points;
    };
    const points=[...extend(a).reverse(),a,b,...extend(b)];
    const distances=[0];
    for(let i=1;i<points.length;i++)distances.push(distances[i-1]+Math.hypot(
      points[i][0]-points[i-1][0],points[i][1]-points[i-1][1]));
    const length=distances.at(-1)!;
    const count=Math.max(1,Math.ceil(length/176)),reach=420;
    let segment=1,first=0,last=0;
    for(let i=0;i<count;i++){
      const center=(i+.5)*length/count;
      while(distances[segment]<center)segment++;
      while(distances[first+1]<center-reach)first++;
      while(last<points.length-1&&distances[last]<center+reach)last++;
      const from=points[segment-1],to=points[segment];
      const mix=(center-distances[segment-1])/(distances[segment]-distances[segment-1]);
      const anchor:Position=[from[0]+(to[0]-from[0])*mix,from[1]+(to[1]-from[1])*mix,from[2]+(to[2]-from[2])*mix];
      const anchorIndex=segment-first;
      const window=[...points.slice(first,segment),anchor,...points.slice(segment,last+1)];
      let left=Infinity,bottom=Infinity,right=-Infinity,top=-Infinity;
      for(const [x,y] of window){
        left=Math.min(left,x);bottom=Math.min(bottom,y);right=Math.max(right,x);top=Math.max(top,y);
      }
      result.push({id:result.length,name,points:window,anchor,anchorIndex,length,bounds:[left,bottom,right,top]});
    }
  }
  return result;
}

export class RoadNames {
  private readonly cells=new Map<string,NamedRoad[]>();
  readonly labels:RoadLabelPath[];

  constructor(roads:NamedRoad[]){
    for(const road of roads){
      const {name,a,b}=road;
      const left=Math.floor(Math.min(a[0],b[0])/cellSize),right=Math.floor(Math.max(a[0],b[0])/cellSize);
      const bottom=Math.floor(Math.min(a[1],b[1])/cellSize),top=Math.floor(Math.max(a[1],b[1])/cellSize);
      for(let iy=bottom;iy<=top;iy++)for(let ix=left;ix<=right;ix++){
        const key=`${ix},${iy}`,cell=this.cells.get(key);
        if(cell)cell.push(road);else this.cells.set(key,[road]);
      }
    }
    this.labels=labelPaths(roads).sort((a,b)=>b.length-a.length||a.id-b.id);
  }

  near(x:number,y:number,z:number,preferred?:string){
    if(![x,y,z].every(Number.isFinite))return;
    const radius=preferred?38:32;
    let nearest:string|undefined,best=Infinity;
    for(let iy=Math.floor((y-radius)/cellSize);iy<=Math.floor((y+radius)/cellSize);iy++)
      for(let ix=Math.floor((x-radius)/cellSize);ix<=Math.floor((x+radius)/cellSize);ix++)
        for(const {name,a,b} of this.cells.get(`${ix},${iy}`)??[]){
          const dx=b[0]-a[0],dy=b[1]-a[1],dz=b[2]-a[2];
          const t=Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy)));
          const distance=(x-a[0]-t*dx)**2+(y-a[1]-t*dy)**2;
          const elevation=Math.abs(z-a[2]-t*dz);
          const current=name===preferred;
          const score=distance+9*elevation**2-(current?96:0);
          if(distance<=(current?38:32)**2&&elevation<=(current?10.5:9)&&score<best){best=score;nearest=name;}
        }
    return nearest;
  }
}

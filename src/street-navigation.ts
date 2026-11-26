import { view } from "./archive";
import type { StreetNavCatalog } from "./street-nav-catalog";
import type { StreetChunk } from "./street-mesh";


function pointer(data:DataView,field:number,bytes:number){
  const at=data.getUint32(field,true)-0x50000000;
  if(at<0||at+bytes>data.byteLength||data.getUint32(field+4,true))
    throw new Error("Invalid navigation reference");
  return at;
}

function* records(data:DataView,field:number,stride:number,count:number){
  const list=pointer(data,field,36);
  const blocks=data.getUint32(list+32,true);
  if(data.getUint32(list+8,true)!==count||blocks>512)
    throw new Error("Unexpected navigation array length");
  const table=pointer(data,list+16,blocks*16);
  let found=0;
  for(let block=0;block<blocks;block++){
    const slot=table+block*16,length=data.getUint32(slot+8,true);
    if(!length||length>8192||found+length>count)throw new Error("Invalid navigation block");
    const start=pointer(data,slot,length*stride);
    for(let i=0;i<length;i++)yield start+i*stride;
    found+=length;
  }
  if(found!==count)throw new Error("Incomplete navigation array");
}

export function decodeNavigationCell(content:Uint8Array,column:number,row:number,surfaces=false):StreetChunk{
  if(content.byteLength<0xcc||content.byteLength>16<<20)throw new Error("Invalid navigation cell size");
  const data=view(content);
  const vertexCount=data.getUint32(pointer(data,0x70,36)+8,true);
  const polygonCount=data.getUint32(pointer(data,0x98,36)+8,true);
  if(vertexCount>0x10000||polygonCount>0x20000)throw new Error("Oversized navigation cell");
  const area=(row+256)*512+column+256;
  if(data.getUint32(20,true)!==0x10015||data.getUint32(0xc8,true)!==area)
    throw new Error("Navigation area ID mismatch");
  const sector=pointer(data,0xa0,32);
  const origin:StreetChunk["origin"]=[0,4,8].map(by=>data.getFloat32(sector+by,true)) as StreetChunk["origin"];
  const extent=[0x60,0x64,0x68].map(at=>data.getFloat32(at,true));
  if(origin[0]!==column*128||origin[1]!==row*128||!Number.isFinite(origin[2])||
     extent[0]!==128||extent[1]!==128||!Number.isFinite(extent[2])||extent[2]<0)
    throw new Error("Invalid navigation world bounds");

  const vertices=new Float32Array(vertexCount*4);
  let vertex=0;
  for(const at of records(data,0x70,6,vertexCount)){
    for(let axis=0;axis<3;axis++)vertices[vertex+axis]=data.getUint16(at+axis*2,true)*extent[axis]/65536;
    vertices[vertex+3]=69;
    vertex+=4;
  }
  const indexCount=data.getUint32(0x90,true);
  if(indexCount>polygonCount*15)throw new Error("Invalid navigation index count");
  const indices=Uint16Array.from(records(data,0x80,2,indexCount),at=>data.getUint16(at,true));
  const edges=new Map<number,boolean>(),surfaceTriangles:number[]=[];
  let index=0;
  for(const at of records(data,0x98,44,polygonCount)){
    const packed=data.getUint16(at+4,true),count=packed&15;
    if(!count||packed>>>4!==(index&0xfff)||index+count>indices.length)
      throw new Error("Invalid navigation polygon");
    for(let i=0;i<count;i++){
      const a=indices[index+i],b=indices[index+(i+1)%count];
      if(a>=vertexCount||b>=vertexCount)throw new Error("Invalid navigation index");
      if(surfaces)continue;
      if(count<3||a===b)continue;
      const key=Math.min(a,b)*65536+Math.max(a,b);
      edges.set(key,!edges.has(key));
    }
    if(surfaces)for(let i=1;i<count-1;i++)surfaceTriangles.push(indices[index],indices[index+i],indices[index+i+1]);
    index+=count;
  }
  if(index!==indexCount)throw new Error("Incomplete navigation polygons");
  const outline:number[]=[];
  for(const [key,outer] of edges)if(outer)outline.push(Math.floor(key/65536),key&0xffff);
  return {id:`nav:${column},${row}`,kind:"navigation",origin,vertices,indices:Uint32Array.from(surfaces?surfaceTriangles:outline),
    bounds:[0,0,0,128,128,extent[2]]};
}

export async function loadStreetNavigation(catalog:StreetNavCatalog,[x,y]:readonly [number,number],known:string[],active:()=>boolean){
  const cx=Math.floor(x/128),cy=Math.floor(y/128);
  const cells: [number,number][]=[];
  for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)cells.push([cx+dx,cy+dy]);
  cells.sort(([a,b],[u,v])=>Math.hypot((a+.5)*128-x,(b+.5)*128-y)-Math.hypot((u+.5)*128-x,(v+.5)*128-y));
  const meshes:StreetChunk[]=[],wanted:string[]=[];
  const resident=new Set(known);
  let skipped=0;
  for(const [column,row] of cells){
    if(!active()||wanted.length>=4)break;
    const id=`nav:${column},${row}`;
    try{
      if(!resident.has(id)){
        const content=await catalog.read(column,row);
        if(!content)continue;
        if(!active())break;
        meshes.push(decodeNavigationCell(content,column,row));
      }
      wanted.push(id);
    }catch{skipped++;}
  }
  return {meshes,wanted,skipped};
}

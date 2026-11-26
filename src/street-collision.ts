import {inflate,view,type Archive} from "./archive";
import {emptyBounds,type Bounds} from "./native-spatial";
import type {StreetChunk} from "./street-mesh";

type CompoundRange=readonly [offset:number,stored:number,size:number];
type Child=readonly [index:number,primitiveCount?:number];
type Compound=readonly [streams:readonly CompoundRange[],childCount:number,children:readonly Child[]];
export type CollisionRegion={bounds:readonly [number,number,number,number];compounds:readonly Compound[]};
const streamMargin=128;
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,0];
const boxTriangles=[
  0,2,3,0,3,1, 4,5,7,4,7,6,
  0,4,6,0,6,2, 1,3,7,1,7,5,
  0,1,5,0,5,4, 2,6,7,2,7,3,
];

function appendBox(data:DataView,at:number,vertices:Float32Array,bounds:Bounds,output:number[]){
  const corners=[4,6,8,10].map(offset=>3*data.getUint16(at+offset,true));
  if(data.getUint16(at,true)!==0||data.getUint32(at+12,true)!==0xffffffff||
    new Set(corners).size!==4||corners.some(index=>index>=vertices.length))
    throw new Error("Invalid static collision box.");
  const [a,b,c,d]=corners.map(index=>vertices.subarray(index,index+3));
  const center=[0,1,2].map(i=>(a[i]+b[i]+c[i]+d[i])*.25);
  const x=[0,1,2].map(i=>(a[i]+b[i]-c[i]-d[i])*.25);
  const y=[0,1,2].map(i=>(a[i]-b[i]+c[i]-d[i])*.25);
  const z=[0,1,2].map(i=>(a[i]-b[i]-c[i]+d[i])*.25);
  const volume=x[0]*(y[1]*z[2]-y[2]*z[1])+x[1]*(y[2]*z[0]-y[0]*z[2])+x[2]*(y[0]*z[1]-y[1]*z[0]);
  if(Math.abs(volume)<=1e-10)throw new Error("Degenerate static collision box.");
  for(let corner=0;corner<8;corner++){
    for(let axis=0;axis<3;axis++){
      const value=center[axis]+(corner&1?x[axis]:-x[axis])+(corner&2?y[axis]:-y[axis])+(corner&4?z[axis]:-z[axis]);
      if(value<bounds[axis]-.01||value>bounds[axis+3]+.01)
        throw new Error("Static collision box outside its archived bounds.");
      output.push(value);
    }
  }
}

function pointer(data:DataView,field:number,size:number){
  const offset=data.getUint32(field,true)-0x50000000;
  if(data.getUint32(field+4,true)||offset<0||offset+size>data.byteLength)
    throw new Error("Invalid static collision pointer.");
  return offset;
}

async function readRange(archive:Archive,[offset,stored,size]:CompoundRange){
  const bytes=inflate(await archive.read(offset,stored),size);
  if(bytes.length!==size)throw new Error("Incomplete static collision resource.");
  return bytes;
}

async function readCompound(archive:Archive,streams:readonly CompoundRange[]){
  const blocks=await Promise.all(streams.map(range=>readRange(archive,range)));
  const bytes=blocks.length===1?blocks[0]:new Uint8Array(blocks.reduce((sum,block)=>sum+block.length,0));
  if(blocks.length>1){
    let start=0;
    for(const block of blocks){bytes.set(block,start);start+=block.length;}
  }
  return view(bytes);
}

function decodeChild(data:DataView,id:string,childCount:number,[childIndex,primitiveCount]:Child):StreetChunk{
  const u=(field:number)=>data.getUint32(field,true);
  const f=(field:number)=>data.getFloat32(field,true);
  if(data.getUint8(16)!==6||u(0x98)!==0x10001*childCount)throw new Error("Unsupported static collision compound.");
  const matrix=pointer(data,0x78,64*childCount)+64*childIndex;
  if(identity.some((value,i)=>value!==f(matrix+4*i)))throw new Error("Unsupported static collision transform.");
  const child=pointer(data,pointer(data,0x70,8*childCount)+8*childIndex,0xd8);
  const vertexCount=u(child+0xd0),faceCount=u(child+0xd4);
  if(data.getUint8(child+16)!==5||vertexCount<3||vertexCount>0x7fff||faceCount<=(primitiveCount??0)||faceCount>0xffff)
    throw new Error("Unsupported static collision geometry.");
  const vertexStart=pointer(data,child+0xb0,6*vertexCount),faceStart=pointer(data,child+0x88,16*faceCount);
  const bounds:Bounds=emptyBounds();
  const vertices=new Float32Array(vertexCount*3),indices=new Uint32Array((faceCount-(primitiveCount??0))*3);
  for(let axis=0;axis<3;axis++){
    const gain=f(child+0x90+axis*4),center=f(child+0xa0+axis*4);
    if(!Number.isFinite(gain)||gain<=0||!Number.isFinite(center))throw new Error("Invalid collision quantization.");
    for(let i=0;i<vertexCount;i++){
      const value=center+gain*data.getInt16(vertexStart+i*6+axis*2,true);
      vertices[i*3+axis]=value;
      bounds[axis]=Math.min(bounds[axis],value);
      bounds[axis+3]=Math.max(bounds[axis+3],value);
    }
    const lo=0x30+axis*4,hi=0x20+axis*4;
    const rootMargins=[f(lo)-bounds[axis],bounds[axis+3]-f(hi)];
    if(![Math.abs(bounds[axis]-f(child+lo)),Math.abs(bounds[axis+3]-f(child+hi))].every(delta=>delta<.01)||
      !rootMargins.every(delta=>childCount===1?Math.abs(delta)<.01:delta<.02))
      throw new Error("Static collision disagrees with its archived bounds.");
  }
  let written=0,primitives=0;
  const boxes:number[]=[];
  for(let i=0;i<faceCount;i++){
    const at=faceStart+i*16;
    const tag=data.getUint8(at+3);
    if(tag>=1&&tag<=4){
      if(++primitives>(primitiveCount??faceCount))throw new Error("Unexpected static collision primitive.");
      if(tag===3)appendBox(data,at,vertices,bounds,boxes);
      continue;
    }
    if(tag!==0)throw new Error("Unsupported static collision primitive.");
    const a=data.getUint16(at+4,true)&0x7fff,b=data.getUint16(at+6,true)&0x7fff,c=data.getUint16(at+8,true)&0x7fff;
    if(Math.max(a,b,c)>=vertexCount||a===b||b===c||a===c)throw new Error("Invalid static collision triangle.");
    indices[written++]=a;indices[written++]=b;indices[written++]=c;
  }
  if(primitiveCount!==undefined&&primitives!==primitiveCount)throw new Error("Incomplete static collision triangle stream.");
  const triangles=indices.subarray(0,written);
  let collision={vertices,indices:triangles};
  if(boxes.length){
    const combinedVertices=new Float32Array(vertices.length+boxes.length);
    const boxCount=boxes.length/24;
    const combinedIndices=new Uint32Array(triangles.length+boxCount*boxTriangles.length);
    combinedVertices.set(vertices);combinedVertices.set(boxes,vertices.length);
    combinedIndices.set(triangles);
    for(let box=0;box<boxCount;box++){
      const vertex=vertexCount+box*8,first=triangles.length+box*boxTriangles.length;
      for(let i=0;i<boxTriangles.length;i++)combinedIndices[first+i]=vertex+boxTriangles[i];
    }
    for(let i=0;i<boxes.length;i++){
      const axis=i%3;
      bounds[axis]=Math.min(bounds[axis],boxes[i]);
      bounds[axis+3]=Math.max(bounds[axis+3],boxes[i]);
    }
    collision={vertices:combinedVertices,indices:combinedIndices};
  }
  if(!collision.indices.length)throw new Error("Empty static collision geometry.");
  return {id,kind:"collision",origin:[0,0,0],bounds,vertices:new Float32Array(),indices:new Uint32Array(),collision};
}

export function decodeStaticCollision(content:Uint8Array,offset:number,known:ReadonlySet<string>){
  const data=view(content);
  if(data.byteLength<0x9c||data.getUint8(16)!==6)return {wanted:[],meshes:[]};
  const childCount=data.getUint16(0x98,true);
  if(!childCount||childCount>4096||data.getUint16(0x9a,true)!==childCount)return {wanted:[],meshes:[]};
  const root="collision:"+offset.toString(16);
  const wanted:string[]=[],meshes:StreetChunk[]=[];
  for(let child=0;child<childCount;child++){
    const id=childCount===1?root:`${root}:${child}`;
    if(known.has(id)){wanted.push(id);continue;}
    try {
      meshes.push(decodeChild(data,id,childCount,[child]));
      wanted.push(id);
    }catch{
      // World-space triangle and box compounds use the supported layout.
    }
  }
  return {wanted,meshes};
}

export async function loadCollisionRegions(archive:Archive,regions:readonly CollisionRegion[],[x,y]:readonly [number,number],known:readonly string[]){
  const compounds=regions.flatMap(({bounds:[left,bottom,right,top],compounds})=>
    x>=left-streamMargin&&x<=right+streamMargin&&y>=bottom-streamMargin&&y<=top+streamMargin?compounds:[]);
  const resources=new Map<string,Promise<DataView>>();
  const childrenById=new Map<string,Promise<StreetChunk|null>>();
  const resident=new Set(known);
  for(const [streams,count,children] of compounds){
    const root="collision:"+streams[0][0].toString(16);
    for(const child of children){
      const id=count===1?root:`${root}:${child[0]}`;
      if(childrenById.has(id))continue;
      if(resident.has(id)){
        childrenById.set(id,Promise.resolve(null));
        continue;
      }
      let resource=resources.get(root);
      if(!resource){
        resource=readCompound(archive,streams);
        resources.set(root,resource);
      }
      childrenById.set(id,resource.then(data=>decodeChild(data,id,count,child)));
    }
  }
  const wanted:string[]=[],meshes:StreetChunk[]=[];
  const ids=[...childrenById.keys()];
  const results=await Promise.allSettled(childrenById.values());
  results.forEach((result,index)=>{
    if(result.status!=="fulfilled")return; // Use mesh-derived collision if a source read or decode fails.
    wanted.push(ids[index]);
    if(result.value)meshes.push(result.value);
  });
  return {wanted,meshes};
}

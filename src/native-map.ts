import { text, view, type Archive } from "./archive";
import { CELL } from "./recover";
import { readCarvedZlib } from "./street-index-scan";
import { readRpf9DirectoryLayout } from "./rpf9-directory";
import { emptyBounds, extendBounds, groundHelipads, rangeBounds, type NativeBatch, type NativePart, type NativeTile } from "./native-spatial";

export type NativeScene = {
  vertices:ArrayBuffer;
  indices:Uint32Array<ArrayBuffer>;
  tiles:NativeTile[];
  parts:number;
};

type Color = readonly [number,number,number];
const landColors:Record<number,Color>={
  0:[169,175,170],10:[176,178,146],20:[132,162,125],
  30:[222,208,162],40:[152,175,128],50:[113,152,117],
};
export const ocean=[46,114,150] as const;
function materialColor(name:string,index:number):Color {
  if(name.startsWith("terrain_"))return landColors[index]??landColors[0];
  if(name==="water_shallows_std")return index===10?[76,160,178]:[60,137,163];
  if(name.startsWith("water_"))return ocean;
  if(name==="buildings_std")return [163,167,176];
  if(name==="routes_rail_std")return [167,148,152];
  if(name==="routes_lanes_std")return [240,231,211];
  if(name==="routes_tunnels_std")return [167,156,164];
  return index===20?[224,214,195]:[236,228,208];
}

const permutations=[[0,1,2],[1,2,0],[2,0,1],[2,1,0],[0,2,1],[1,0,2]] as const;
const system=0x50000000,graphics=0x60000000;
function pointer(data:DataView,at:number,base:number,span:number,limit=data.byteLength) {
  const offset=data.getUint32(at,true)-base;
  if(data.getUint32(at+4,true)||offset<0||offset+span>limit)throw new Error("Invalid pause-map resource pointer.");
  return offset;
}

function mesh(g:DataView,v:number,i:number,bounds:number[],name:string):NativePart {
  const u=(at:number)=>g.getUint32(at,true);
  if(u(v)!==0x4042||(u(v+8)&255)!==0x21)throw new Error("Unexpected pause-map vertex layout.");
  const count=((u(v+8)>>>8)-64)/4;
  const positions=v+0x80,tints=positions+12*count,ids=positions+16*count;
  if(!Number.isInteger(count)||count<1||count>65536||ids+4*count>g.byteLength)
    throw new Error("Invalid pause-map vertex count.");
  const origin=[0,1,2].map(axis=>g.getFloat32(v+0x60+4*axis,true));
  const scale=[0,1,2].map(axis=>g.getFloat32(v+0x70+4*axis,true));
  const vertices=new Float32Array(count*4),colors=new Uint8Array(vertices.buffer);
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  const surface=name.startsWith("water_")?0:name.startsWith("terrain_")?1:
    name.startsWith("buildings")?2:name.startsWith("routes_lanes")?4:name.startsWith("routes_")?3:2;
  for(let j=0;j<count;j++){
    const at=positions+8*j;
    const lo=u(at),hi=u(at+4);
    const x=origin[0]+(lo>>>8)*scale[0];
    const y=origin[1]+((lo&255)|((hi&65535)<<8))*scale[1];
    const z=origin[2]+(hi>>>16)*scale[2];
    vertices[j*4]=x;vertices[j*4+1]=y;vertices[j*4+2]=z;
    min[0]=Math.min(min[0],x);min[1]=Math.min(min[1],y);min[2]=Math.min(min[2],z);
    max[0]=Math.max(max[0],x);max[1]=Math.max(max[1],y);max[2]=Math.max(max[2],z);
    const rgb=materialColor(name,g.getUint8(ids+j*4));
    for(let c=0;c<3;c++)colors[j*16+12+c]=Math.round(rgb[c]*g.getUint8(tints+j*4+c)/255);
    colors[j*16+15]=surface;
  }
  // Quantizers sometimes permute axes. Validate XYZ against the drawable's own bounds.
  const error=(p:readonly number[])=>Math.max(...p.map((axis,j)=>
    Math.max(0,bounds[j]-min[axis],max[axis]-bounds[j+4])));
  const order=permutations.find(p=>error(p)<.7);
  if(!order)throw new Error("Pause-map vertices disagree with their drawable bounds.");
  for(let j=0;j<count;j++){
    const at=j*4;
    const x=vertices[at+order[0]],y=vertices[at+order[1]],z=vertices[at+order[2]];
    vertices[at]=x/CELL;vertices[at+1]=-y/CELL;vertices[at+2]=z/CELL;
  }
  const flags=u(i),meshlets=flags&65535,triangles=u(i+4),remapCount=u(i+8);
  const triangleStart=i+12+16*meshlets,remapStart=triangleStart+4*triangles;
  if(flags>>>16!==0x8000||!meshlets||!triangles||triangles>65535||
     remapStart+2*remapCount>g.byteLength||u(i+16)!==0)
    throw new Error("Invalid pause-map meshlet table.");
  const indices=new Uint32Array(triangles*3),spans:NativePart["spans"]=[];
  for(let m=0;m<meshlets;m++){
    const first=u(i+16+16*m),next=m+1<meshlets?u(i+32+16*m):null;
    const t0=first>>>16,t1=next===null?triangles:next>>>16;
    const v0=first&65535,v1=next===null?remapCount:next&65535;
    if(t0>=t1||t1>triangles||v0>=v1||v1>remapCount)throw new Error("Invalid pause-map meshlet range.");
    spans.push({first:t0*3,count:(t1-t0)*3});
    for(let t=t0;t<t1;t++){
      const packed=u(triangleStart+t*4);
      for(let c=0;c<3;c++){
        const local=v0+((packed>>>(7*c))&127);
        if(local>=v1)throw new Error("Invalid pause-map local index.");
        const index=g.getUint16(remapStart+local*2,true);
        if(index>=count)throw new Error("Invalid pause-map vertex index.");
        indices[t*3+c]=index;
      }
    }
  }
  const [ax,ay,az]=order;
  return {name,vertices,indices,spans,bounds:[min[ax]/CELL,-max[ay]/CELL,min[az]/CELL,
                                   max[ax]/CELL,-min[ay]/CELL,max[az]/CELL]};
}

function resourceParts(metadata:Uint8Array,graphicsBytes:Uint8Array) {
  const bytes=text.decode(metadata),m=view(metadata),g=view(graphicsBytes);
  const refs=new Map<number,number>();
  for(let at=0;at+8<=m.byteLength;at+=8){
    const target=m.getUint32(at,true);
    if(target>=system&&target<system+m.byteLength&&m.getUint32(at+4,true)===0&&!refs.has(target-system))
      refs.set(target-system,at);
  }
  const parts:NativePart[]=[];
  for(const match of bytes.matchAll(/maptile_3d01_([a-z_]+)\.#dr\0/g)){
    const name=match[1];
    if(name.startsWith("reflections"))continue;
    // The name determines the layer. Placement and geometry come from its drawable.
    const ref=refs.get(match.index);
    if(ref===undefined||ref<0xa8)throw new Error("Missing pause-map drawable name reference.");
    const model=pointer(m,ref-0x58,system,16);
    const count=m.getUint16(model+8,true);
    if(count<1||count>32)throw new Error("Invalid pause-map drawable part count.");
    const list=pointer(m,model,system,count*8);
    const bounds=Array.from({length:8},(_,i)=>m.getFloat32(ref-0x78+i*4,true));
    for(let j=0;j<count;j++){
      const entry=list+j*8;
      if(!m.getUint32(entry,true))continue;
      const object=pointer(m,entry,system,0x18);
      const pieceCount=m.getUint16(object+0x10,true);
      if(pieceCount<1||pieceCount>128)throw new Error("Invalid pause-map drawable geometry count.");
      const pieces=pointer(m,object+8,system,pieceCount*8);
      for(let k=0;k<pieceCount;k++){
        const part=pointer(m,pieces+k*8,system,0x48);
        const vd=pointer(m,part+8,system,32);
        const meshlets=pointer(m,part+0x40,system,8);
        const id=pointer(m,meshlets,system,32);
        const vertices=pointer(m,vd+0x18,graphics,0x80,g.byteLength);
        const indices=pointer(m,id+0x18,graphics,12,g.byteLength);
        parts.push(mesh(g,vertices,indices,bounds,name));
      }
    }
  }
  return parts;
}

// Seek to the Pause map mount for this validated archive build. The map
// member locations and stream sizes are discovered from the selected file.
const pauseMapMountOffset=31546920960;
const pauseMapReadWindow=64*1024*1024;
const mountAlignment=4096;
const pageLimit=1024*1024;
const nextPage=(at:number,stored:number)=>Math.ceil((at+stored)/16)*16;
const decoderName=/maptile_3d01_[a-z_]+\.#dr\0/;

export async function loadNativeMap(archive:Archive,progress:(done:number,total:number)=>void):Promise<NativeScene>{
  const header=await archive.read(pauseMapMountOffset,64);
  const layout=readRpf9DirectoryLayout(header,archive.file.size-pauseMapMountOffset);
  const bytes=await archive.read(pauseMapMountOffset,
    Math.min(pauseMapReadWindow,archive.file.size-pauseMapMountOffset));
  const data=view(bytes);
  let end=bytes.length;
  for(let offset=mountAlignment;offset+64<=bytes.length;offset+=mountAlignment){
    if(data.getUint32(offset,true)!==0x52504639)continue;
    try{
      readRpf9DirectoryLayout(bytes.subarray(offset,offset+64),archive.file.size-pauseMapMountOffset-offset);
      end=offset;
      break;
    }catch{
      // A signature inside a resource does not identify a mount.
    }
  }
  const mount=bytes.subarray(0,end);
  const parts:NativePart[]=[];
  let vertexCount=0,indexCount=0,groups=0;
  for(let at=nextPage(layout.wideEnd,16);at+7<mount.length;at+=16){
    if(bytes[at]!==0x78||(0x7800+bytes[at+1])%31)continue;
    if(data.getBigUint64(at-16)||data.getBigUint64(at-8))continue;
    const metadata=readCarvedZlib(mount.subarray(at,at+pageLimit),pageLimit);
    if(!metadata||!decoderName.test(text.decode(metadata.bytes)))continue;

    let graphics=nextPage(at,metadata.stored);
    let graphicsBytes=new Uint8Array(0);
    let decoded:NativePart[]|undefined;
    do {
      const page=readCarvedZlib(mount.subarray(graphics,graphics+pageLimit),pageLimit);
      if(!page)break;
      const joined=new Uint8Array(graphicsBytes.length+page.bytes.length);
      joined.set(graphicsBytes);
      joined.set(page.bytes,graphicsBytes.length);
      graphicsBytes=joined;
      graphics=nextPage(graphics,page.stored);
      try{
        decoded=resourceParts(metadata.bytes,graphicsBytes);
      }catch{
        // Some drawables use multiple adjacent graphics pages.
      }
    }while(!decoded&&graphicsBytes.length<8*pageLimit);
    if(!decoded)throw new Error("Pause-map geometry is incomplete.");
    for(const part of decoded){
      parts.push(part);
      vertexCount+=part.vertices.length/4;
      indexCount+=part.indices.length;
    }
    at=graphics-16;
    groups++;
    if(groups%32===0)progress(groups,layout.entryCount);
  }
  if(!parts.length)throw new Error("Pause-map geometry is unavailable.");
  progress(groups,groups);
  groundHelipads(parts);
  const buckets=new Map<string,NativePart[]>();
  for(const part of parts){
    const [x,y,,right,bottom]=part.bounds;
    const key=`${Math.floor((x+right)/16)},${Math.floor((y+bottom)/16)}`;
    const tile=buckets.get(key);
    if(tile)tile.push(part);else buckets.set(key,[part]);
  }
  const vertices=new Float32Array(vertexCount*4),indices=new Uint32Array(indexCount);
  const packed=new Uint8Array(vertices.buffer),tiles:NativeTile[]=[];
  let vertex=0,index=0;
  for(const bucket of buckets.values()){
    const bounds=emptyBounds(),first=index;
    const clusters=new Map<string,{part:NativePart;offset:number;range:NativeBatch}[]>();
    for(const part of bucket){
      packed.set(new Uint8Array(part.vertices.buffer),vertex*16);
      extendBounds(bounds,part.bounds);
      for(const span of part.spans){
        const range={...span,bounds:rangeBounds(part,span.first,span.count)};
        const [x,y,,right,bottom]=range.bounds;
        const key=`${Math.floor((x+right)/4)},${Math.floor((y+bottom)/4)}`;
        const item={part,offset:vertex,range};
        const cluster=clusters.get(key);
        if(cluster)cluster.push(item);else clusters.set(key,[item]);
      }
      vertex+=part.vertices.length/4;
    }
    const chunks:NativeBatch[]=[];
    for(const cluster of clusters.values()){
      const chunkBounds=emptyBounds(),start=index;
      for(const {part,offset,range} of cluster){
        for(let i=range.first;i<range.first+range.count;i++)indices[index++]=part.indices[i]+offset;
        extendBounds(chunkBounds,range.bounds);
      }
      chunks.push({first:start,count:index-start,bounds:chunkBounds});
    }
    tiles.push({first,count:index-first,bounds,chunks});
  }
  return {vertices:vertices.buffer,indices,tiles,parts:parts.length};
}

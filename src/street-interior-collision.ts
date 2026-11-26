import type { Bounds } from "./native-spatial";
import type { InteriorMembership } from "./street-interior";
import type { StreetChunk } from "./street-mesh";
import { placementMatrix } from "./street-placement";

type Point=[number,number,number];
type AddVertex=(point:Point)=>number;
const boxFaces=[0,2,1,1,2,3,4,5,6,5,7,6,0,1,4,1,5,4,2,6,3,3,6,7,0,4,2,2,4,6,1,3,5,3,7,5];

function appendBox([a,b,c,d]:Point[],addVertex:AddVertex,indices:number[]){
  const center=a.map((x,i)=>(x+b[i]+c[i]+d[i])*.25);
  // The four archived points are alternating corners of the oriented box.
  const axes=[b,c,d].map(point=>a.map((x,i)=>(x+point[i])*0.5-center[i]));
  const corners=Array.from({length:8},(_,i)=>addVertex(center.map((x,axis)=>
    x+axes.reduce((n,edge,bit)=>n+edge[axis]*(i&(1<<bit)?-1:1),0)) as Point));
  for(const corner of boxFaces)indices.push(corners[corner]);
}

const ringSides=24,hemisphereSteps=6;
const ringDirections=Array.from({length:ringSides},(_,i)=>{
  const angle=i*2*Math.PI/ringSides;
  return [Math.cos(angle),Math.sin(angle)] as const;
});

function appendTube(start:Point,end:Point,radius:number,capsule:boolean,addVertex:AddVertex,indices:number[]){
  const delta=end.map((n,i)=>n-start[i]),length=Math.hypot(...delta);
  if(!length&&!capsule)return;
  const axis=length?delta.map(n=>n/length):[0,0,1];
  const normal=Math.abs(axis[2])<.9?[-axis[1],axis[0],0]:[0,-axis[2],axis[1]];
  const normalLength=Math.hypot(...normal);
  const [x,y,z]=normal.map(n=>n/normalLength),[u,v,w]=axis;
  const tangent=[v*z-w*y,w*x-u*z,u*y-v*x];
  const offset=(point:Point,height:number)=>point.map((n,i)=>n+axis[i]*height) as Point;
  const ring=(point:Point,height:number,width:number)=>{
    const center=offset(point,height);
    return ringDirections.map(([cos,sin])=>addVertex(center.map((n,i)=>
      n+width*(cos*normal[i]/normalLength+sin*tangent[i])) as Point));
  };
  const rings:number[][]=[];
  if(capsule)for(let i=hemisphereSteps-1;i>0;i--){
    const angle=i*Math.PI/(2*hemisphereSteps);
    rings.push(ring(start,-radius*Math.sin(angle),radius*Math.cos(angle)));
  }
  rings.push(ring(start,0,radius),ring(end,0,radius));
  if(capsule)for(let i=1;i<hemisphereSteps;i++){
    const angle=i*Math.PI/(2*hemisphereSteps);
    rings.push(ring(end,radius*Math.sin(angle),radius*Math.cos(angle)));
  }
  const bottom=addVertex(offset(start,capsule?-radius:0));
  const top=addVertex(offset(end,capsule?radius:0));
  for(let side=0;side<ringSides;side++){
    const next=(side+1)%ringSides;
    indices.push(bottom,rings[0][next],rings[0][side],top,rings.at(-1)![side],rings.at(-1)![next]);
    for(let i=1;i<rings.length;i++){
      const a=rings[i-1],b=rings[i];
      indices.push(a[side],a[next],b[side],a[next],b[next],b[side]);
    }
  }
}

export function readInteriorCollision(data:DataView,interior:InteriorMembership):StreetChunk|undefined{
  if(data.byteLength<0xa0||data.getUint8(0x10)!==6)return;
  const pointer=(at:number,size:number)=>{
    const offset=data.getUint32(at,true)-0x50000000;
    if(data.getUint32(at+4,true)||offset<0||offset+size>data.byteLength)throw new RangeError("Invalid interior collision reference");
    return offset;
  };
  const count=data.getUint16(0x98,true);
  if(!count||count!==data.getUint16(0x9a,true))return;
  const {placement,id}=interior.scene;
  const [a,b,c,d,e,f,g,h,k]=placementMatrix(placement,placement.position);
  const bounds:Bounds=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
  const vertices:number[]=[],indices:number[]=[];
  try{
    const children=pointer(0x70,8*count),transforms=pointer(0x78,64*count);
    for(let child=0;child<count;child++){
      const at=pointer(children+8*child,0xd8),kind=data.getUint8(at+0x10);
      if(kind!==4&&kind!==5)continue;
      const vertexCount=data.getUint32(at+0xd0,true),faceCount=data.getUint32(at+0xd4,true);
      if(!vertexCount||vertexCount>0x8000||!faceCount)continue;
      const positions=pointer(at+0xb0,6*vertexCount),polygons=pointer(at+0x88,16*faceCount);
      const matrix=Array.from({length:16},(_,i)=>data.getFloat32(transforms+64*child+4*i,true));
      const step=Array.from({length:3},(_,axis)=>data.getFloat32(at+0x90+4*axis,true));
      const center=Array.from({length:3},(_,axis)=>data.getFloat32(at+0xa0+4*axis,true));
      if(![...matrix,...step,...center].every(Number.isFinite)||step.some(value=>value<=0))continue;
      const first=vertices.length/3;
      const addVertex=([x,y,z]:Point)=>{
        const u=matrix[0]*x+matrix[4]*y+matrix[8]*z+matrix[12];
        const v=matrix[1]*x+matrix[5]*y+matrix[9]*z+matrix[13];
        const w=matrix[2]*x+matrix[6]*y+matrix[10]*z+matrix[14];
        const position=[a*u+b*v+c*w,d*u+e*v+f*w,g*u+h*v+k*w];
        const index=vertices.length/3;
        vertices.push(...position);
        for(let axis=0;axis<3;axis++){
          bounds[axis]=Math.min(bounds[axis],position[axis]);
          bounds[axis+3]=Math.max(bounds[axis+3],position[axis]);
        }
        return index;
      };
      const points=Array.from({length:vertexCount},(_,i)=>center.map((n,axis)=>
        n+step[axis]*data.getInt16(positions+6*i+2*axis,true)) as Point);
      for(const point of points)addVertex(point);
      for(let i=0;i<faceCount;i++){
        const row=polygons+16*i;
        const shape=data.getUint8(row+3),index=(offset:number)=>data.getUint16(row+offset,true)&0x7fff;
        if(shape===0){
          const face=[index(4),index(6),index(8)];
          if(face.some(index=>index>=vertexCount))throw new RangeError("Invalid interior collision face");
          indices.push(...face.map(index=>first+index));
        }else if(shape===3){
          const corners=[4,6,8,10].map(offset=>points[index(offset)]);
          if(corners.every(Boolean))appendBox(corners,addVertex,indices);
        }else if(shape===2||shape===4){
          const start=points[index(0)],end=points[index(8)],radius=data.getFloat32(row+4,true);
          if(start&&end&&Number.isFinite(radius)&&radius>0)appendTube(start,end,radius,shape===2,addVertex,indices);
        }
      }
    }
  }catch{return;}
  if(indices.length)return {id:`interior-collision:${id}`,kind:"collision",interior,bounds,origin:placement.position,
    vertices:new Float32Array(0),indices:new Uint16Array(0),
    collision:{vertices:Float32Array.from(vertices),indices:Uint32Array.from(indices)}};
}

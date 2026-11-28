import type { Bounds } from "./native-spatial";
import { placementMatrix, readPlacement, type Placement } from "./street-placement";
import { streetProjection } from "./street-destination";
import type { StreetStreamView } from "./street-priority";

const mapTypes=0xd98bb561,mapData=0xd3593fa6,entityType=0xce501483;
const interiorType=0x10506455,instanceType=0x09cc28be;
const roomType=0x0b1811f1,portalType=0x995072ca,setType=0xd6a799f9;
const roomSpatialType=0xec238d86,roomVolumeType=0x2a27943c;
type Point3=[number,number,number];
type InteriorEntity={key:bigint;hash:number;placement:Placement};
type InteriorRoom={name:number;bounds:Bounds;entities:number[]};
type InteriorPortal={from:number;to:number;flags:number;corners:Point3[];entities:number[]};
type InteriorSet={name:number;locations:number[];entities:InteriorEntity[]};
export type StreetInterior={key:bigint;name:number;bounds:Bounds;entities:InteriorEntity[];rooms:InteriorRoom[];
  portals:InteriorPortal[];sets:InteriorSet[]};
export type StreetInteriorInstance=InteriorEntity&{ordinal:number;defaultSets:number[];spatialKey:bigint};
type InteriorVolume={room:number;bounds:Bounds;vertices:Point3[];triangles:Uint16Array};
export type InteriorRoomVolumes={bounds:Bounds;volumes:InteriorVolume[]};
export type InteriorScene={id:string;placement:Placement;bounds:Bounds;rooms:Bounds[];
  spatial?:InteriorRoomVolumes;
  portals:{from:number;to:number;flags?:number;corners:Point3[];plane:[number,number,number,number]}[]};
export type InteriorMembership={scene:InteriorScene;rooms:number[]};

export function streetInteriorScene(id:string,{bounds,rooms,portals}:StreetInterior,placement:Placement,
  spatial?:InteriorRoomVolumes):InteriorScene{
  const [a,b,c,d,e,f,g,h,k,x,y,z]=placementMatrix(placement,[0,0,0]);
  return {id,placement,bounds,spatial,rooms:rooms.map(room=>room.bounds),portals:portals.map(({from,to,flags,corners})=>{
    const worldCorners=corners.map(([u,v,w]):Point3=>[a*u+b*v+c*w+x,d*u+e*v+f*w+y,g*u+h*v+k*w+z]);
    const [p,q,r]=corners;
    const [ux,uy,uz]=q.map((n,i)=>n-p[i]),[vx,vy,vz]=r.map((n,i)=>n-p[i]);
    const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
    return {from,to,flags,corners:worldCorners,plane:[nx,ny,nz,nx*p[0]+ny*p[1]+nz*p[2]]};
  })};
}

type ScreenPoint=[number,number];
type ScreenRect=readonly [number,number,number,number];
type Aperture={polygon:ScreenPoint[];bounds:ScreenRect};
const screenEpsilon=1e-8;
const fullScreen:Aperture={polygon:[[-1,-1],[1,-1],[1,1],[-1,1]],bounds:[-1,-1,1,1]};
export const interiorClipEdgeCapacity=48;
export const interiorPortalVisibilityOnly=4;

export function packInteriorClip(openings:readonly Aperture[]){
  const distinct=[...new Set(openings)];
  const count=distinct.reduce((sum,opening)=>sum+opening.polygon.length,0);
  // Full-screen rooms and larger aperture unions still use scene depth.
  if(!count||count>interiorClipEdgeCapacity||distinct.includes(fullScreen))return;
  const edges=new Float32Array(count*4);
  let offset=0;
  for(const {polygon} of distinct)for(const [index,[x,y]] of polygon.entries()){
    const [u,v]=polygon[(index+1)%polygon.length],a=y-v,b=u-x;
    edges.set([a,b,-a*x-b*y,Number(index===polygon.length-1)],offset);
    offset+=4;
  }
  return edges;
}

// Sutherland–Hodgman clipping also works before perspective division using
// signed distances in homogeneous coordinates.
function clipPolygon<T extends ScreenPoint|Point3>(polygon:T[],distance:(point:T)=>number):T[]{
  if(!polygon.length)return polygon;
  const clipped:T[]=[];
  let previous=polygon[polygon.length-1],before=distance(previous);
  for(const point of polygon){
    const after=distance(point);
    if((before<0)!==(after<0)){
      const fraction=before/(before-after);
      clipped.push(previous.map((value,i)=>value+(point[i]-value)*fraction) as T);
    }
    if(after>=0)clipped.push(point);
    previous=point;before=after;
  }
  return clipped;
}

function aperture(polygon:ScreenPoint[]):Aperture|undefined{
  if(polygon.length<3)return;
  let area=0,left=Infinity,bottom=Infinity,right=-Infinity,top=-Infinity;
  for(const [index,[x,y]] of polygon.entries()){
    const [u,v]=polygon[(index+1)%polygon.length];
    area+=x*v-y*u;
    left=Math.min(left,x);bottom=Math.min(bottom,y);right=Math.max(right,x);top=Math.max(top,y);
  }
  if(Math.abs(area)<=screenEpsilon)return;
  if(area<0)polygon.reverse();
  return {polygon,bounds:[left,bottom,right,top]};
}

function edgeDistance(a:ScreenPoint,b:ScreenPoint,[x,y]:ScreenPoint){
  return (b[0]-a[0])*(y-a[1])-(b[1]-a[1])*(x-a[0]);
}

export function interiorApertureIntersects({polygon,bounds:[left,bottom,right,top]}:Aperture,[x0,y0,x1,y1]:ScreenRect){
  if(left>x1||right<x0||bottom>y1||top<y0)return false;
  return polygon.every((a,index)=>{
    const b=polygon[(index+1)%polygon.length];
    return edgeDistance(a,b,[b[1]<a[1]?x1:x0,b[0]>a[0]?y1:y0])>=-screenEpsilon;
  });
}

type Eye=StreetStreamView["eye"];
export type InteriorCamera={eye:Eye;rooms:number[]};

function localInteriorEye(scene:InteriorScene,eye:Eye):Point3{
  const [a,b,c,d,e,f,g,h,k,x,y,z]=placementMatrix(scene.placement,[0,0,0]);
  const [u,v,w]=[eye[0]-x,eye[1]-y,eye[2]-z],{scale:[xy,height]}=scene.placement;
  return [(a*u+d*v+g*w)/xy**2,(b*u+e*v+h*w)/xy**2,(c*u+f*v+k*w)/height**2];
}

function containsEye(bounds:Bounds,eye:Point3){
  return eye.every((n,i)=>n>=bounds[i]&&n<=bounds[i+3]);
}

function pointInVolume({vertices,triangles}:InteriorVolume,[x,y,z]:Point3){
  const relative=vertices.map(([a,b,c])=>[a-x,b-y,c-z,Math.hypot(a-x,b-y,c-z)]);
  let angle=0;
  for(let i=0;i<triangles.length;i+=3){
    const [ax,ay,az,a]=relative[triangles[i]], [bx,by,bz,b]=relative[triangles[i+1]], [cx,cy,cz,c]=relative[triangles[i+2]];
    const triple=ax*(by*cz-bz*cy)+ay*(bz*cx-bx*cz)+az*(bx*cy-by*cx);
    const denominator=a*b*c+(ax*bx+ay*by+az*bz)*c+(bx*cx+by*cy+bz*cz)*a+(cx*ax+cy*ay+cz*az)*b;
    angle+=Math.atan2(triple,denominator);
  }
  // Each triangle contributes twice atan2. Native membership uses an absolute
  // winding above one half after normalization by the full solid angle.
  return Math.abs(angle)>Math.PI;
}

function initialInteriorRooms(scene:InteriorScene,worldEye:Eye){
  if(scene.spatial){
    const eye=localInteriorEye(scene,[worldEye[0],worldEye[1],worldEye[2]+.0005]);
    if(!containsEye(scene.spatial.bounds,eye))return [0];
    const volume=scene.spatial.volumes.find(volume=>volume.room<scene.rooms.length&&
      containsEye(volume.bounds,eye)&&pointInVolume(volume,eye));
    return [volume?.room??0];
  }
  const eye=localInteriorEye(scene,worldEye);
  const rooms=containsEye(scene.bounds,eye)?scene.rooms.flatMap((bounds,room)=>room&&containsEye(bounds,eye)?[room]:[]):[];
  const start=rooms.filter(room=>scene.portals.every(({from,to,plane:[nx,ny,nz,offset]})=>{
    const side=nx*eye[0]+ny*eye[1]+nz*eye[2]-offset;
    return from===room&&to===0?side<=0:to===room&&from===0?side>=0:true;
  }));
  return start.length?start:[0];
}

export function isInsideAuthoredInterior(scene:InteriorScene,eye:Eye,rooms:readonly number[]){
  return Boolean(scene.spatial&&rooms.length===1&&rooms[0]!==0&&initialInteriorRooms(scene,eye)[0]===rooms[0]);
}

function insidePortal(corners:Point3[],point:Point3){
  const [a,b,c]=corners;
  const cross=(a:Point3,b:Point3,c:Point3):Point3=>{
    const [x,y,z]=[b[0]-a[0],b[1]-a[1],b[2]-a[2]], [u,v,w]=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];
    return [y*w-z*v,z*u-x*w,x*v-y*u];
  };
  const [nx,ny,nz]=cross(a,b,c);
  return corners.every((corner,index)=>{
    const [x,y,z]=cross(corner,corners[(index+1)%corners.length],point);
    return nx*x+ny*y+nz*z>=-screenEpsilon;
  });
}

export function trackInteriorCamera(scene:InteriorScene,eye:Eye,previous?:InteriorCamera):InteriorCamera{
  if(previous?.eye.every((n,i)=>n===eye[i]))return previous;
  if(!previous)return {eye,rooms:initialInteriorRooms(scene,eye)};
  const local=localInteriorEye(scene,eye);
  const old=localInteriorEye(scene,previous.eye);
  const rooms=new Set<number>();
  for(let room of previous.rooms){
    let fraction=-1;
    for(let step=0;step<10;step++){
      let nextRoom=room;
      for(const {from,to,flags=0,corners,plane:[nx,ny,nz,offset]} of scene.portals){
        // A portal can be usable for visibility while excluded from room tracking.
        if((flags&interiorPortalVisibilityOnly)!==0||from===to||from!==room&&to!==room)continue;
        const sign=from===room?1:-1;
        const start=sign*(nx*old[0]+ny*old[1]+nz*old[2]-offset);
        const end=sign*(nx*local[0]+ny*local[1]+nz*local[2]-offset);
        if(start>0||end<=0)continue;
        const hit=start/(start-end);
        if(hit<=fraction)continue;
        const point=eye.map((n,i)=>previous.eye[i]+(n-previous.eye[i])*hit) as Point3;
        if(!insidePortal(corners,point))continue;
        fraction=hit;nextRoom=from===room?to:from;
        break;
      }
      if(nextRoom===room)break;
      room=nextRoom;
    }
    if(room===0||containsEye(scene.rooms[room],local))rooms.add(room);
  }
  // Free flight can pass through a solid wall and leave the tracked room.
  return {eye,rooms:rooms.size?[...rooms]:initialInteriorRooms(scene,eye)};
}

// Keep distinct portal routes separate. Combining them into one rectangle
// can make a room visible through a gap between two disjoint apertures.
export function visibleInteriorRooms(scene:InteriorScene,view:StreetStreamView,
  start=initialInteriorRooms(scene,view.eye)){
  const {eye:[ex,ey,ez],yaw,pitch,aspect,fov,farPlane}=view;
  const cos=Math.cos(yaw),sin=Math.sin(yaw),ct=Math.cos(pitch),st=Math.sin(pitch),scale=streetProjection(fov);
  const apertures=scene.portals.map(portal=>{
    let polygon=portal.corners.map(([x,y,z]):Point3=>{
      const dx=x-ex,dy=y-ey,dz=z-ez,ahead=dx*cos+dy*sin;
      return [(dx*sin-dy*cos)*scale/aspect,(dz*ct-ahead*st)*scale,ahead*ct+dz*st];
    });
    // The aperture still matters when crossing inside the render near plane.
    polygon=clipPolygon(polygon,point=>point[2]-screenEpsilon);
    if(farPlane!==undefined)polygon=clipPolygon(polygon,point=>farPlane-point[2]);
    for(const axis of [0,1])for(const sign of [-1,1])polygon=clipPolygon(polygon,point=>point[2]+sign*point[axis]);
    return aperture(polygon.map(([x,y,w])=>[x/w,y/w]));
  });
  const queue=start.map(room=>({room,opening:fullScreen}));
  const visible=new Map(queue.map(({room,opening})=>[room,[opening]]));
  for(let i=0;i<queue.length;i++){
    const {room,opening:current}=queue[i];
    for(const [index,{from,to}] of scene.portals.entries()){
      const other=from===room?to:to===room?from:-1,target=apertures[index];
      if(other<0||!target||!interiorApertureIntersects(current,target.bounds))continue;
      const prior=visible.get(other);
      if(prior?.includes(fullScreen))continue;
      let points=target.polygon;
      if(current!==fullScreen)for(const [index,a] of current.polygon.entries()){
        const b=current.polygon[(index+1)%current.polygon.length];
        points=clipPolygon(points,point=>edgeDistance(a,b,point));
      }
      const opening=current===fullScreen?target:aperture(points);
      if(!opening||prior?.some(({polygon})=>polygon.every((a,index)=>
        opening.polygon.every(point=>edgeDistance(a,polygon[(index+1)%polygon.length],point)>=-screenEpsilon))))continue;
      if(prior)prior.push(opening);
      else visible.set(other,[opening]);
      queue.push({room:other,opening});
    }
  }
  return visible;
}

// Packed map-type references are one-based block IDs with a byte offset.
// Interior children and ownership lists are ordinal-addressed, including
// when their storage shares blocks with unrelated archetypes.
function interiorMetadata(data:DataView,type:number,required:number){
  const u32=(at:number)=>data.getUint32(at,true);
  const u16=(at:number)=>data.getUint16(at,true);
  const u64=(at:number)=>data.getBigUint64(at,true);
  const vec3=(at:number):Point3=>[data.getFloat32(at,true),data.getFloat32(at+4,true),data.getFloat32(at+8,true)];
  const box=(min:number,max:number):Bounds=>{
    const low=vec3(min),high=vec3(max);
    if(![...low,...high].every(Number.isFinite)||low.some((value,axis)=>value>high[axis]))
      throw new RangeError("Invalid interior bounds");
    return [...low,...high];
  };
  const pointer=(at:number)=>u32(at+4)===0?u32(at)-0x50000000:-1;
  if(data.byteLength<0x50||u32(0x10)!==0x50524430||data.getUint8(0x14)!==0x7a)return;
  const table=pointer(0x38),count=u16(0x4c);
  if(table<0||table+count*16>data.byteLength)return;
  let found=false;
  for(let i=0;i<count&&!found;i++)found=u32(table+16*i)===required;
  if(!found)return;
  const blocks=Array.from({length:count},(_,index)=>{
    const row=table+index*16;
    return {type:u32(row),size:u32(row+4),start:pointer(row+8)};
  });
  const root=blocks[u32(0x20)-1];
  if(root?.type!==type||root.start<0||root.start+root.size>data.byteLength)return;
  const blockType=(ref:bigint)=>blocks[Number(ref&0xfffffn)-1]?.type;
  const record=(ref:bigint,type:number,bytes:number)=>{
    const block=blocks[Number(ref&0xfffffn)-1],skip=Number(ref>>20n);
    if(block?.type!==type||block.start<0||skip+bytes>block.size||block.start+skip+bytes>data.byteLength)
      throw new RangeError("Invalid interior record reference");
    return block.start+skip;
  };
  const array=<T>(at:number,type:number,stride:number,read:(start:number)=>T)=>{
    const count=u16(at+8);
    if(!count)return [];
    if(count>u16(at+10))throw new RangeError("Invalid interior array count");
    const start=record(u64(at),type,count*stride);
    return Array.from({length:count},(_,index)=>read(start+index*stride));
  };
  const field=(hash:number,kind:number)=>{
    const table=pointer(0x28),count=u16(0x48);
    if(table<0||table+32*count>data.byteLength)return;
    for(let i=0;i<count;i++){
      const row=table+32*i;
      if(u32(row)!==type)continue;
      const members=pointer(row+16),count=u16(row+30);
      if(members<0||members+16*count>data.byteLength)return;
      for(let j=0;j<count;j++){
        const member=members+16*j,offset=u32(member+4);
        if(u32(member)===hash&&data.getUint8(member+8)===kind&&offset+12<=root.size)return root.start+offset;
      }
    }
  };
  const entity=(at:number)=>{
    const hash=u32(at+0x44);
    const placement=readPlacement(data,at+0x44,hash);
    placement.tintSelector=u32(at+0x70)&0x7f;
    placement.propLayerControl=data.getUint8(at+0x80);
    placement.propDirtControl=data.getUint8(at+0x81);
    return {key:u64(at+0x20),hash,placement};
  };
  return {root,blockType,record,array,field,entity,u32,u64,vec3,box};
}

export function readInteriorRoomVolumes(data:DataView):InteriorRoomVolumes|undefined{
  const meta=interiorMetadata(data,roomSpatialType,roomVolumeType);
  if(!meta||meta.root.size<0x30)return;
  const {root,array,u32,vec3,box}=meta;
  try{
    const bounds=box(root.start,root.start+0x10);
    const volumes=array(root.start+0x20,roomVolumeType,0x80,at=>{
      const vertices=array(at+0x40,0x33,16,vec3);
      const rows=array(at+0x50,0xd4d0a753,6,triangle=>triangle);
      const triangles=new Uint16Array(rows.length*3);
      for(let i=0;i<rows.length;i++)for(let j=0;j<3;j++)triangles[i*3+j]=data.getUint16(rows[i]+j*2,true);
      if(!vertices.length||!triangles.length||triangles.some(index=>index>=vertices.length)||
        vertices.some(point=>!point.every(Number.isFinite)))throw new RangeError("Invalid interior room volume");
      return {room:u32(at),bounds:box(at+0x60,at+0x70),vertices,triangles};
    });
    if(volumes.length)return {bounds,volumes};
  }catch{return;}
}

export function readStreetInteriorInstances(data:DataView):StreetInteriorInstance[]{
  const meta=interiorMetadata(data,mapData,instanceType);
  if(!meta)return [];
  const {blockType,record,array,field,entity,u32,u64}=meta;
  const entityArray=field(0xccab9307,0x52);
  if(entityArray===undefined)return [];
  let refs:bigint[];
  try{refs=array(entityArray,7,8,u64);}
  catch{return [];}
  return refs.flatMap((ref,ordinal)=>{
    if(blockType(ref)!==instanceType)return [];
    try{
      const at=record(ref,instanceType,0x250);
      const instance=entity(at);
      if(!instance.key||!instance.hash)return [];
      // Interior pivots use the stored local-to-world quaternion. The
      // ordinary entity reader conjugates it for a CEntityDef instead.
      const [x,y,z,w]=instance.placement.rotation;
      instance.placement.rotation=[-x,-y,-z,w];
      return [{...instance,ordinal,spatialKey:u64(at+0x98),defaultSets:array(at+0xa0,0x4a,4,u32)}];
    }catch{return [];}
  });
}

export function readStreetInteriors(data:DataView):StreetInterior[]{
  const meta=interiorMetadata(data,mapTypes,interiorType);
  if(!meta||meta.root.size<0x50)return [];
  const {root,blockType,record,array,entity,u32,u64,vec3,box}=meta;
  const interiors:StreetInterior[]=[];
  let refs:bigint[];
  try{refs=array(root.start+0x18,7,8,u64);}
  catch{return [];}
  for(const ref of refs){
    if(blockType(ref)!==interiorType)continue;
    try{
      const at=record(ref,interiorType,0x220),key=u64(at+8),name=u32(at+0x78);
      const child=(pointer:number)=>entity(record(u64(pointer),entityType,0x90));
      const entities=array(at+0xc0,7,8,child);
      const ownedEntities=(at:number)=>array(at,0x15,4,start=>{
        const index=u32(start);
        if(index>=entities.length)throw new RangeError("Invalid interior entity ordinal");
        return index;
      });
      const rooms=array(at+0xd0,roomType,0x70,start=>({
        name:u32(start),bounds:box(start+0x10,start+0x20),entities:ownedEntities(start+0x50),
      }));
      const portals=array(at+0xe0,portalType,0x58,start=>{
        const from=u32(start+8),to=u32(start+12),corners=array(start+0x38,0x33,16,vec3);
        if(from>=rooms.length||to>=rooms.length||corners.length<3||corners.some(p=>!p.every(Number.isFinite)))
          throw new RangeError("Invalid interior portal");
        return {from,to,flags:u32(start+0x10),corners,entities:ownedEntities(start+0x48)};
      });
      const sets=array(at+0xf0,setType,0x28,start=>({
        name:u32(start),locations:array(start+8,0x15,4,u32),entities:array(start+0x18,7,8,child),
      }));
      const bounds=box(at+0x40,at+0x4c);
      if(key&&name&&rooms.length)interiors.push({key,name,bounds,entities,rooms,portals,sets});
    }catch{
      // One unsupported definition does not invalidate siblings in the same pack.
    }
  }
  return interiors;
}

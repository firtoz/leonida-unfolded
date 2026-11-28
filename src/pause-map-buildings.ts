import { CELL } from "./recover";
import type { NativePart } from "./native-spatial";
import { pauseMapBuildingMaterial, pauseMapVertexLayout, pauseMapBuildingPalette, pauseMapEntryMatching } from "./pause-map-constants";
import { interiorPortalVisibilityOnly, type StreetInterior } from "./street-interior";
import { placementMatrix, type Placement } from "./street-placement";

export type PauseMapEntry = readonly [x:number,y:number,z:number];

export function pauseMapEntries(definition:StreetInterior,placement:Placement):PauseMapEntry[]{
  const [a,b,c,d,e,f,g,h,k,x,y,z]=placementMatrix(placement,[0,0,0]);
  const rooms=new Set<number>();
  const world=(u:number,v:number,w:number):PauseMapEntry=>[a*u+b*v+c*w+x,d*u+e*v+f*w+y,g*u+h*v+k*w+z];
  const entries=definition.portals.flatMap(({from,to,flags,corners})=>{
    if((from===0)===(to===0)||(flags&interiorPortalVisibilityOnly)!==0)return [];
    const room=definition.rooms[from||to];
    if(!room)return [];
    rooms.add(from||to);
    const [u,v,w]=corners.reduce(([u,v,w],[px,py,pz])=>[u+px/corners.length,v+py/corners.length,w+pz/corners.length],[0,0,0]);
    const [left,bottom,,right,top]=room.bounds;
    const dx=(left+right)*.5-u,dy=(bottom+top)*.5-v;
    const distance=Math.hypot(dx,dy);
    // Place the probe just inside the portal so it falls on the footprint.
    const inset=distance?Math.min(.5,pauseMapEntryMatching.insetMeters/distance):0;
    const px=u+dx*inset,py=v+dy*inset;
    return [world(px,py,w)];
  });
  for(const id of rooms){
    const [left,bottom,low,right,top]=definition.rooms[id].bounds;
    entries.push(world((left+right)*.5,(bottom+top)*.5,low));
  }
  return entries;
}

export function shadePauseMapEntries(parts:readonly NativePart[],entries:readonly PauseMapEntry[],
  onVertex?:(part:NativePart,index:number)=>void){
  const cell=pauseMapEntryMatching.cellMeters/CELL;
  const bins=new Map<string,number[]>();
  const probes=entries.map(([x,y,z])=>[x/CELL,-y/CELL,z/CELL] as const);
  probes.forEach(([x,y],index)=>{
    const key=`${Math.floor(x/cell)},${Math.floor(y/cell)}`;
    const bucket=bins.get(key);
    if(bucket)bucket.push(index);
    else bins.set(key,[index]);
  });
  const roofs=new Map<number,{part:NativePart;vertex:number;height:number}>();
  for(const part of parts){
    if(part.name!==pauseMapBuildingMaterial)continue;
    const [left,top,,right,bottom]=part.bounds;
    const nearby:number[]=[];
    for(let x=Math.floor(left/cell);x<=Math.floor(right/cell);x++)
      for(let y=Math.floor(top/cell);y<=Math.floor(bottom/cell);y++)
        for(const id of bins.get(`${x},${y}`)??[]){
          const [u,v]=probes[id];
          if(u>=left&&u<=right&&v>=top&&v<=bottom)nearby.push(id);
        }
    if(!nearby.length)continue;
    const {vertices,indices}=part;
    for(let i=0;i<indices.length;i+=3){
      const a=indices[i]*4,b=indices[i+1]*4,c=indices[i+2]*4;
      const x=vertices[a],y=vertices[a+1],bx=vertices[b]-x,by=vertices[b+1]-y;
      const cx=vertices[c]-x,cy=vertices[c+1]-y,area=bx*cy-by*cx;
      if(!area)continue;
      for(const id of nearby){
        const [u,v,z]=probes[id],dx=u-x,dy=v-y;
        const s=(dx*cy-dy*cx)/area,t=(bx*dy-by*dx)/area;
        if(s<0||t<0||s+t>1)continue;
        const height=vertices[a+2]+s*(vertices[b+2]-vertices[a+2])+t*(vertices[c+2]-vertices[a+2]);
        if(height<z-pauseMapEntryMatching.roofHeightToleranceMeters/CELL||
          height<=(roofs.get(id)?.height??-Infinity))continue;
        roofs.set(id,{part,vertex:indices[i],height});
      }
    }
  }
  const matches=new Map<NativePart,number[]>();
  for(const {part,vertex} of roofs.values()){
    const vertices=matches.get(part);
    if(vertices)vertices.push(vertex);
    else matches.set(part,[vertex]);
  }
  let buildings=0;
  for(const [part,matched] of matches){
    const count=part.vertices.length/4;
    const parents=Uint32Array.from({length:count},(_,i)=>i);
    function root(vertex:number){
      while(parents[vertex]!==vertex){
        parents[vertex]=parents[parents[vertex]];
        vertex=parents[vertex];
      }
      return vertex;
    }
    const {indices,vertices}=part;
    // Roof and wall faces can carry separate vertices at the same corner.
    const corners=new Map<string,number>();
    for(let i=0;i<count;i++){
      const at=i*4,key=`${vertices[at]},${vertices[at+1]},${vertices[at+2]}`;
      const corner=corners.get(key);
      if(corner===undefined)corners.set(key,i);
      else parents[i]=corner;
    }
    for(let i=0;i<indices.length;i+=3){
      const first=root(indices[i]);
      parents[root(indices[i+1])]=first;
      parents[root(indices[i+2])]=first;
    }
    const highlighted=new Set(matched.map(root));
    const colors=new Uint8Array(part.vertices.buffer);
    for(let i=0;i<count;i++){
      if(highlighted.has(root(i))){
        colors.set(pauseMapBuildingPalette.exteriorEntry,i*pauseMapVertexLayout.strideBytes+pauseMapVertexLayout.colorOffsetBytes);
        onVertex?.(part,i);
      }
    }
    buildings+=highlighted.size;
  }
  return buildings;
}

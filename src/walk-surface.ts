import type { NativeScene } from "./native-map";
import type { Bounds } from "./native-spatial";
import type { StreetChunk } from "./street-mesh";

export type Point3=[number,number,number];
export type MapRay={origin:Point3;direction:Point3;minimum:number};
export const maximumWalkSlope=1.15;

function crosses(bounds:Bounds,{origin,direction,minimum}:MapRay,max:number){
  for(let axis=0;axis<3;axis++){
    const v=direction[axis],p=origin[axis];
    if(Math.abs(v)<1e-10){
      if(p<bounds[axis]||p>bounds[axis+3])return false;
      continue;
    }
    const a=(bounds[axis]-p)/v,b=(bounds[axis+3]-p)/v;
    minimum=Math.max(minimum,Math.min(a,b));
    max=Math.min(max,Math.max(a,b));
    if(minimum>max)return false;
  }
  return true;
}

export function pickWalkSurface(scene:NativeScene,ray:MapRay){
  const vertices=new Float32Array(scene.vertices),colors=new Uint8Array(scene.vertices),{indices}=scene;
  const [dx,dy,dz]=ray.direction,[ox,oy,oz]=ray.origin;
  let closest=Infinity;
  let hit:{point:Point3;walkable:boolean;water:boolean;structure:boolean}|undefined;
  for(const tile of scene.tiles){
    if(!crosses(tile.bounds,ray,closest))continue;
    for(const chunk of tile.chunks){
      if(!crosses(chunk.bounds,ray,closest))continue;
      for(let i=chunk.first;i<chunk.first+chunk.count;i+=3){
        const a=indices[i]*4,b=indices[i+1]*4,c=indices[i+2]*4;
        const ux=vertices[b]-vertices[a],uy=vertices[b+1]-vertices[a+1],uz=vertices[b+2]-vertices[a+2];
        const vx=vertices[c]-vertices[a],vy=vertices[c+1]-vertices[a+1],vz=vertices[c+2]-vertices[a+2];
        const px=dy*vz-dz*vy,py=dz*vx-dx*vz,pz=dx*vy-dy*vx;
        const d=ux*px+uy*py+uz*pz;
        if(Math.abs(d)<1e-10)continue;
        const sx=ox-vertices[a],sy=oy-vertices[a+1],sz=oz-vertices[a+2];
        const u=(sx*px+sy*py+sz*pz)/d;
        if(u<0||u>1)continue;
        const qx=sy*uz-sz*uy,qy=sz*ux-sx*uz,qz=sx*uy-sy*ux;
        const v=(dx*qx+dy*qy+dz*qz)/d;
        if(v<0||u+v>1)continue;
        const t=(vx*qx+vy*qy+vz*qz)/d;
        if(t<ray.minimum||t>=closest)continue;
        closest=t;
        const surface=colors[a*4+15],water=surface===0;
        const walkable=!water&&Math.hypot(uy*vz-uz*vy,uz*vx-ux*vz)<=maximumWalkSlope*Math.abs(ux*vy-uy*vx);
        hit={point:[ox+t*dx,oy+t*dy,oz+t*dz],walkable,water,structure:surface===2};
      }
    }
  }
  return hit;
}

export function walkFloor(meshes:StreetChunk[],x:number,y:number,hint?:number){
  let best:number|undefined,score=Infinity;
  for(const mesh of meshes){
    if(mesh.visualOnly)continue;
    const [ox,oy,oz]=mesh.origin,px=x-ox,py=y-oy;
    const [left,bottom,,right,top]=mesh.bounds;
    if(px<left||px>right||py<bottom||py>top)continue;
    const {vertices,indices}=mesh.collision??mesh,stride=mesh.collision?3:4;
    for(let i=0;i<indices.length;i+=3){
      const a=indices[i]*stride,b=indices[i+1]*stride,c=indices[i+2]*stride;
      const ax=vertices[a],ay=vertices[a+1],az=vertices[a+2];
      const ux=vertices[b]-ax,uy=vertices[b+1]-ay,uz=vertices[b+2]-az;
      const vx=vertices[c]-ax,vy=vertices[c+1]-ay,vz=vertices[c+2]-az;
      const det=ux*vy-uy*vx;
      if(Math.abs(det)<1e-6||Math.hypot(uy*vz-uz*vy,uz*vx-ux*vz)>maximumWalkSlope*Math.abs(det))continue;
      const sx=px-ax,sy=py-ay,u=(sx*vy-sy*vx)/det,v=(ux*sy-uy*sx)/det;
      if(u<-.001||v<-.001||u+v>1.001)continue;
      const height=oz+az+u*uz+v*vz;
      const distance=hint===undefined?-height:Math.abs(height-hint);
      if(distance<score){score=distance;best=height;}
    }
  }
  return best;
}

import type { Bounds } from "./native-spatial";
import { skylineRadius, streetNearPlane } from "./street-grid";
import { defaultStreetFov, streetProjection } from "./street-destination";

export type StreetStreamView={eye:readonly [number,number,number];yaw:number;pitch:number;aspect:number;fov?:number;
  farPlane?:number;flightTerrain?:boolean;distantCanopy?:boolean};
export type StreetPendingBox={id:string;bounds:Bounds};
export const streetHorizon=315;
export const streetRegionSize=64;

export function streetViewChanged(view:StreetStreamView,previous:StreetStreamView){
  return Math.sin(view.pitch)*Math.sin(previous.pitch)+
    Math.cos(view.pitch)*Math.cos(previous.pitch)*Math.cos(view.yaw-previous.yaw)<Math.cos(Math.PI/6)||
    Math.abs((view.fov??defaultStreetFov)-(previous.fov??defaultStreetFov))>=8||
    Math.abs(view.aspect/previous.aspect-1)>=.12;
}

export function streetFrustum({eye:[x,y,z],yaw,pitch,aspect,fov}:StreetStreamView,margin=1,farDepth=Infinity){
  const cos=Math.cos(yaw),sin=Math.sin(yaw),ct=Math.cos(pitch),st=Math.sin(pitch);
  const vertical=streetProjection(fov)/margin,horizontal=vertical/aspect;
  const forward=[cos*ct,sin*ct,st],right=[sin*horizontal,-cos*horizontal,0];
  const up=[-cos*st*vertical,-sin*st*vertical,ct*vertical];
  const plane=(axis:number[],sign:number)=>forward.map((v,i)=>v+axis[i]*sign);
  const makePlane=([a,b,c]:number[],offset=0)=>
    [a,b,c,a*x+b*y+c*z+offset,a<0?0:3,b<0?1:4,c<0?2:5,a<0?3:0,b<0?4:1,c<0?5:2] as const;
  const planes=[forward,plane(right,1),plane(right,-1),plane(up,1),plane(up,-1)].map(axis=>makePlane(axis));
  if(Number.isFinite(farDepth))planes.push(makePlane(forward.map(value=>-value),-farDepth));
  const visible=(bounds:Bounds,horizon=streetHorizon)=>{
    if(x+horizon<bounds[0]||x-horizon>bounds[3]||y+horizon<bounds[1]||y-horizon>bounds[4])return false;
    for(let i=0;i<planes.length;i++){
      const p=planes[i];
      if(p[0]*bounds[p[4]]+p[1]*bounds[p[5]]+p[2]*bounds[p[6]]<p[3])return false;
    }
    return true;
  };
  return Object.assign(visible,{contains(bounds:Bounds){
    for(let i=0;i<planes.length;i++){
      const p=planes[i];
      if(p[0]*bounds[p[7]]+p[1]*bounds[p[8]]+p[2]*bounds[p[9]]<p[3])return false;
    }
    return true;
  }});
}

export function streetDistance(bounds:Bounds,[x,y,z]:StreetStreamView["eye"]){
  return Math.max(0,bounds[0]-x,x-bounds[3])**2+
    Math.max(0,bounds[1]-y,y-bounds[4])**2+Math.max(0,bounds[2]-z,z-bounds[5])**2;
}

// Undefined means the bounds can cross the near plane, so a caller
// cannot safely use the projected rectangle to prove separation.
export function streetScreenBounds(bounds:Bounds,{eye,yaw,pitch,aspect,fov}:StreetStreamView){
  const cos=Math.cos(yaw),sin=Math.sin(yaw),ct=Math.cos(pitch),st=Math.sin(pitch);
  const scale=streetProjection(fov);
  const result:[number,number,number,number]=[Infinity,Infinity,-Infinity,-Infinity];
  for(let corner=0;corner<8;corner++){
    const x=bounds[corner&1?3:0]-eye[0],y=bounds[corner&2?4:1]-eye[1],z=bounds[corner&4?5:2]-eye[2];
    const ahead=x*cos+y*sin,depth=ahead*ct+z*st;
    if(depth<=streetNearPlane)return;
    const right=(x*sin-y*cos)*scale/(depth*aspect),up=(z*ct-ahead*st)*scale/depth;
    result[0]=Math.min(result[0],right);result[1]=Math.min(result[1],up);
    result[2]=Math.max(result[2],right);result[3]=Math.max(result[3],up);
  }
  return result;
}

export function streetLoadPriority(camera:StreetStreamView){
  const visible=streetFrustum(camera,1.18);
  return (bounds:Bounds,skyline=false)=>{
    const distance=streetDistance(bounds,camera.eye);
    return distance+(visible(bounds,skyline?skylineRadius:streetHorizon)?0:1_000_000);
  };
}

import type { Bounds } from "./native-spatial";
import { placementMatrix, type Placement } from "./street-placement";

type Point=[number,number,number];
export type StreetRoller={anchor:Point;up:Point;back:Point;travel:number;radius:number};

export const rollerDrawable=/^prop_.*door_roller_/i;

export function readStreetRoller(data:DataView,drawable:number,placement:Placement,bounds:Bounds):StreetRoller|undefined{
  const reference=(at:number,size:number)=>{
    if(at<0||at+8>data.byteLength||data.getUint32(at+4,true))return -1;
    const offset=data.getUint32(at,true)-0x50000000;
    return offset>=0&&offset+size<=data.byteLength?offset:-1;
  };
  const attachment=reference(drawable+0x90,0x48);
  if(drawable<0||attachment<0)return;
  const marker=reference(attachment+0x40,0x24);
  if(marker<0||data.getUint32(marker+0x20,true)!==0xbca7812c)return;
  const coordinate=(at:number)=>data.getFloat32(marker+at,true);
  // This animation supports the vertical marker in the authored segmented roller.
  if(![0,4,8,16,20].every(offset=>coordinate(offset)===0)||!(coordinate(24)>0)||placement.linear)return;
  const [,b,c,,e,f,,h,k]=placementMatrix(placement,placement.position);
  const backLength=Math.hypot(b,e,h),upLength=Math.hypot(c,f,k);
  const travel=coordinate(24)*upLength,radius=-bounds[1]*backLength*.5;
  if(!Number.isFinite(travel)||!Number.isFinite(radius)||radius<=0||travel<=radius)return;
  return {anchor:placement.position,up:[c/upLength,f/upLength,k/upLength],back:[-b/backLength,-e/backLength,-h/backLength],travel,radius};
}

export function poseRoller(roller:StreetRoller,anchor:Point,closed:Float32Array,vertices:Float32Array,fraction:number){
  const {up,back,travel,radius}=roller;
  if(fraction===0){vertices.set(closed);return;}
  for(let i=0;i<closed.length;i+=4){
    const [x,y,z]=[closed[i]-anchor[0],closed[i+1]-anchor[1],closed[i+2]-anchor[2]];
    const height=x*up[0]+y*up[1]+z*up[2],depth=x*back[0]+y*back[1]+z*back[2];
    // The rear housing and the cover above the mover limit remain stationary.
    if(height>travel||depth>=radius)continue;
    const distance=height+fraction*(travel+radius*.5);
    const angle=Math.max(0,distance-travel)/radius;
    const bend=radius-depth;
    const raised=distance<=travel?distance:travel+bend*Math.sin(angle);
    const rolled=distance<=travel?depth:radius-bend*Math.cos(angle);
    for(let axis=0;axis<3;axis++)vertices[i+axis]=closed[i+axis]+up[axis]*(raised-height)+back[axis]*(rolled-depth);
  }
}

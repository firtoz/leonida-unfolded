import type {Bounds} from "./native-spatial";
import {streetProjection} from "./street-destination";
import {streetNearPlane} from "./street-grid";
import {interiorApertureIntersects,type visibleInteriorRooms,type InteriorScene} from "./street-interior";
import type {InstanceTile} from "./street-mesh";
import {placementMatrix} from "./street-placement";
import type {StreetStreamView} from "./street-priority";

type Opening=NonNullable<ReturnType<ReturnType<typeof visibleInteriorRooms>["get"]>>[number];
export type IndoorFoliageRoom={scene:InteriorScene;bounds:Bounds;openings:readonly Opening[]};
type Range=Pick<InstanceTile,"first"|"count">;

export function indoorFoliageRoom(scene:InteriorScene,openings:readonly Opening[],origin:readonly [number,number,number]):IndoorFoliageRoom|undefined{
  if(!scene.spatial||!scene.portals.some(portal=>portal.from===0||portal.to===0))return;
  const stored=scene.spatial.bounds;
  const [a,b,c,d,e,f,g,h,k,x,y,z]=placementMatrix(scene.placement,origin);
  const bounds:Bounds=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
  for(let corner=0;corner<8;corner++){
    const u=stored[corner&1?3:0],v=stored[corner&2?4:1],w=stored[corner&4?5:2];
    const point=[a*u+b*v+c*w+x,d*u+e*v+f*w+y,g*u+h*v+k*w+z];
    for(let axis=0;axis<3;axis++){
      bounds[axis]=Math.min(bounds[axis],point[axis]-.25);
      bounds[axis+3]=Math.max(bounds[axis+3],point[axis]+.25);
    }
  }
  if(bounds.every(Number.isFinite))return {scene,bounds,openings};
}

export function hiddenExteriorFoliage(room:IndoorFoliageRoom,camera:StreetStreamView,width:number,height:number){
  const {eye:[eyeX,eyeY,eyeZ],yaw,pitch,aspect,fov,farPlane}=camera;
  const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
  const scale=streetProjection(fov),padX=4/width,padY=4/height;
  const {bounds:interior,openings}=room;
  const fineNear=streetNearPlane+.04;
  if(!farPlane||!Number.isFinite(farPlane)||width<=0||height<=0)return;
  return (box:Bounds)=>{
    const outside=box[0]>interior[3]||box[3]<interior[0]||box[1]>interior[4]||box[4]<interior[1]||
      box[2]>interior[5]||box[5]<interior[2];
    if(!outside)return false;
    let left=Infinity,bottom=Infinity,right=-Infinity,top=-Infinity,nearest=Infinity;
    for(let corner=0;corner<8;corner++){
      const x=box[corner&1?3:0]-eyeX,y=box[corner&2?4:1]-eyeY,z=box[corner&4?5:2]-eyeZ;
      const ahead=x*cy+y*sy,depth=ahead*cp+z*sp;
      if(!(depth>fineNear))return false;
      nearest=Math.min(nearest,depth);
      const px=(x*sy-y*cy)*scale/(depth*aspect),py=(z*cp-ahead*sp)*scale/depth;
      left=Math.min(left,px);right=Math.max(right,px);bottom=Math.min(bottom,py);top=Math.max(top,py);
    }
    if(nearest>=farPlane-.04)return false;
    // Keep two pixels of coverage around silhouettes and every portal boundary.
    const clip=[Math.max(-1,left-padX),Math.max(-1,bottom-padY),Math.min(1,right+padX),Math.min(1,top+padY)] as const;
    return clip[0]<clip[2]&&clip[1]<clip[3]&&!openings.some(aperture=>interiorApertureIntersects(aperture,clip));
  };
}

export function visibleIndoorFoliage(ranges:Range[]|undefined,tiles:readonly InstanceTile[]|undefined,bounds:Bounds,
  instances:number,hidden:(bounds:Bounds)=>boolean){
  if(!tiles)return hidden(bounds)?[]:ranges;
  const source=ranges??[{first:0,count:instances}];
  const retained:Range[]=[];
  let removed=false;
  let tileIndex=0;
  for(const range of source){
    const end=range.first+range.count;
    let first=range.first;
    while(tileIndex<tiles.length){
      const tile=tiles[tileIndex],tileEnd=tile.first+tile.count;
      if(tile.first>=end)break;
      if(tileEnd<=first){tileIndex++;continue;}
      if(hidden(tile.bounds)){
        if(tile.first>first)retained.push({first,count:tile.first-first});
        first=Math.min(end,tileEnd);
        removed=true;
      }
      if(tileEnd>end)break;
      tileIndex++;
    }
    if(first<end)retained.push({first,count:end-first});
  }
  return removed?retained:ranges;
}

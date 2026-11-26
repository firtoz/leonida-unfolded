import {emptyBounds,type Bounds} from "./native-spatial";
import type {ImposterAtlasRecord,PackedSlodModel} from "./street-imposter-metadata";
import {streetFarPlane} from "./street-grid";
import type {InstanceTile,StreetChunk} from "./street-mesh";
import {streetFrustum,type StreetStreamView} from "./street-priority";
import type {readVegetationBatch,VegetationBatch} from "./street-vegetation";

type Tile={poses:number[];bounds:Bounds};
type Group={key:bigint;center:PackedSlodModel["center"];radius:number;coverage:number;tiles:Map<string,Tile>};
export type ImpostorCoverage={model:bigint;positions:Float32Array;radius:number};

const coverageCell=.25;
// visualsettings.dat: imposter.trees.SLODFadeLength for the supported build.
const slodFadeLength=25;
// Keep candidates resident across the next few vegetation cells. The shader applies the exact band.
const motionReserve=64;

export function packedImpostorBatchInRange(batch:VegetationBatch,[x,y,z]:StreetStreamView["eye"]){
  const [,,,,packed,range,left,bottom,right,top,end,,,height]=batch;
  if(!packed||!height)return false;
  // The header bounds enclose every decoded pivot. Reuse the same reserve
  // as the per-instance check so turning or crossing a cell keeps coverage.
  const dx=Math.max(left-x,0,x-right),dy=Math.max(bottom-y,0,y-top);
  const dz=Math.max(height[0]-z,0,z-height[1]);
  return dx*dx+dy*dy+dz*dz<=((end??range)+motionReserve)**2;
}

export function packedImpostorBasis(upX:number,upY:number,heading:number,scaleXY:number,scaleZ:number){
  const x=upX/127.5-1,y=upY/127.5-1,z=1-Math.abs(x)-Math.abs(y);
  const fold=Math.max(0,-z);
  const ux=x-Math.sign(x)*fold,uy=y-Math.sign(y)*fold;
  const length=Math.hypot(ux,uy,z);
  const nx=ux/length,ny=uy/length,nz=z/length;
  // The native heading table uses 72 bins. Use their midpoints until the table is known.
  const yaw=(heading%72+.5)*Math.PI/36;
  const c=Math.cos(yaw),s=Math.sin(yaw);
  const bx=-nz*s,by=nz*c,bz=nx*s-ny*c;
  const tangentLength=Math.hypot(bx,by,bz);
  const tx=bx/tangentLength,ty=by/tangentLength,tz=bz/tangentLength;
  return [
    (ty*nz-tz*ny)*scaleXY,tx*scaleXY,nx*scaleZ,
    (tz*nx-tx*nz)*scaleXY,ty*scaleXY,ny*scaleZ,
    (tx*ny-ty*nx)*scaleXY,tz*scaleXY,nz*scaleZ,
  ] as const;
}

export function packedImpostorCoverage(placements:Iterable<ImpostorCoverage>){
  const models=new Map<bigint,Map<string,number[]>>();
  const cell=(v:number)=>Math.floor(v/coverageCell);
  for(const {model,positions,radius} of placements){
    let cells=models.get(model);
    if(!cells){cells=new Map();models.set(model,cells);}
    for(let at=0;at<positions.length;at+=3){
      const px=positions[at],py=positions[at+1],pz=positions[at+2];
      const key=`${cell(px)},${cell(py)},${cell(pz)}`;
      const points=cells.get(key);
      if(points)points.push(px,py,pz,radius);
      else cells.set(key,[px,py,pz,radius]);
    }
  }
  return (model:bigint,x:number,y:number,z:number,tolerance:number)=>{
    const cells=models.get(model);
    if(!cells)return 0;
    let radius=0;
    const radiusSquared=tolerance*tolerance;
    for(let cx=cell(x-tolerance);cx<=cell(x+tolerance);cx++)
      for(let cy=cell(y-tolerance);cy<=cell(y+tolerance);cy++)
        for(let cz=cell(z-tolerance);cz<=cell(z+tolerance);cz++){
          const points=cells.get(`${cx},${cy},${cz}`);
          if(points)for(let at=0;at<points.length;at+=4)
            if((x-points[at])**2+(y-points[at+1])**2+(z-points[at+2])**2<=radiusSquared)
              radius=Math.max(radius,points[at+3]);
        }
    return radius;
  };
}

export function packedImpostorView(camera:StreetStreamView,tags:ReadonlyMap<number,bigint>,
  atlases:ReadonlyMap<bigint,ImposterAtlasRecord>,models:ReadonlyMap<number,PackedSlodModel>,
  covered:ReturnType<typeof packedImpostorCoverage>){
  const farPlane=camera.farPlane??streetFarPlane;
  const visible=streetFrustum(camera,1,farPlane);
  const padded=streetFrustum(camera,1.18,farPlane+motionReserve);
  const [x,y,z]=camera.eye;
  const origin:StreetChunk["origin"]=[Math.floor(x/128)*128,Math.floor(y/128)*128,0];
  const groups=new Map<number,Group>();

  function append(batch:VegetationBatch,{data,low,high,scaleMin,scaleMax,stride}:Awaited<ReturnType<typeof readVegetationBatch>>){
    const [,,,count,packed,range,,,,,end]=batch;
    if(!packed)return;
    const radius=end??range;
    const tolerance=.035+Math.hypot(...high.map((value,axis)=>(value-low[axis])/131070));
    for(let i=0;i<count;i++){
      const at=i*stride,tag=data.getUint16(at+14,true)||data.getUint16(at+8,true);
      const model=tags.get(tag),atlas=model===undefined?undefined:atlases.get(model);
      const slod=models.get(tag);
      if(model===undefined||!atlas||!slod||!(atlas.radius>0))continue;
      const scale=scaleMin+(scaleMax-scaleMin)*data.getUint8(at+11)/255;
      const scaleZ=scaleMin+(scaleMax-scaleMin)*data.getUint8(at+12)/255;
      if(scale<=.001||scaleZ<=.001)continue;
      const px=low[0]+(high[0]-low[0])*data.getUint16(at,true)/65535;
      const py=low[1]+(high[1]-low[1])*data.getUint16(at+2,true)/65535;
      const pz=low[2]+(high[2]-low[2])*data.getUint16(at+4,true)/65535;
      const dx=px-x,dy=py-y,dz=pz-z;
      const pivotDistance=dx*dx+dy*dy+dz*dz;
      if(pivotDistance>(radius+motionReserve)**2)continue;
      const [mx,my,mz]=slod.center;
      const distance=(dx+mx*scale)**2+(dy+my*scale)**2+(dz+mz*scale)**2;
      // The native culler squares the padded lower range before comparing distances.
      const minimum=Math.abs(slod.minimum-slodFadeLength);
      if(distance<Math.max(0,minimum-motionReserve)**2||distance>(slod.maximum+motionReserve)**2)continue;
      const basis=packedImpostorBasis(data.getUint8(at+6),data.getUint8(at+7),data.getUint8(at+13),scale,scaleZ);
      const [cx,cy,cz]=atlas.center;
      const bounds:Bounds=emptyBounds();
      const positions=[px,py,pz];
      for(let axis=0;axis<3;axis++){
        const row=axis*3;
        const a=basis[row],b=basis[row+1],c=basis[row+2];
        const center=positions[axis]+a*cx+b*cy+c*cz;
        const extent=atlas.radius*Math.SQRT2*Math.hypot(a,b,c);
        bounds[axis]=center-extent;
        bounds[axis+3]=center+extent;
      }
      const nearRadius=covered(model,px,py,pz,tolerance);
      let group=groups.get(tag);
      if(!group){group={key:model,center:slod.center,radius,coverage:0,tiles:new Map()};groups.set(tag,group);}
      group.radius=Math.max(group.radius,radius);
      // A shared atlas is more useful when more of its crowns can draw now.
      // Use their approximate projected area to put close, large stands first.
      if(pivotDistance<=radius**2&&pivotDistance>nearRadius**2&&distance>=minimum**2&&
        distance<=slod.maximum**2&&visible(bounds,radius))
        group.coverage+=Math.min(1,(atlas.radius*Math.max(scale,scaleZ))**2/Math.max(1,distance));
      const cell=`${Math.floor(px/128)},${Math.floor(py/128)}`;
      let tile=group.tiles.get(cell);
      if(!tile){tile={poses:[],bounds:emptyBounds()};group.tiles.set(cell,tile);}
      tile.poses.push(px-origin[0],py-origin[1],pz,...basis,
        radius,nearRadius,minimum,slod.maximum);
      for(let axis=0;axis<3;axis++){
        tile.bounds[axis]=Math.min(tile.bounds[axis],bounds[axis]-origin[axis]);
        tile.bounds[axis+3]=Math.max(tile.bounds[axis+3],bounds[axis+3]-origin[axis]);
      }
    }
  }

  function mesh(tag:number,geometry:StreetChunk,id:string,useGeometryBounds=false):StreetChunk{
    const group=groups.get(tag)!;
    const poses=new Float32Array([...group.tiles.values()].reduce((sum,tile)=>sum+tile.poses.length,0));
    const tiles:InstanceTile[]=[],bounds=emptyBounds();
    let first=0;
    for(const tile of group.tiles.values()){
      const count=tile.poses.length/16;
      poses.set(tile.poses,first*16);
      const tileBounds=useGeometryBounds?emptyBounds():tile.bounds;
      if(useGeometryBounds)for(let at=0;at<tile.poses.length;at+=16){
        for(let axis=0;axis<3;axis++){
          let low=tile.poses[at+axis],high=low;
          for(let col=0;col<3;col++){
            const scale=tile.poses[at+3+axis*3+col];
            const a=geometry.bounds[col]*scale,b=geometry.bounds[col+3]*scale;
            low+=Math.min(a,b);high+=Math.max(a,b);
          }
          tileBounds[axis]=Math.min(tileBounds[axis],low);
          tileBounds[axis+3]=Math.max(tileBounds[axis+3],high);
        }
      }
      tiles.push({first,count,bounds:tileBounds});
      first+=count;
      for(let axis=0;axis<3;axis++){
        bounds[axis]=Math.min(bounds[axis],tileBounds[axis]);
        bounds[axis+3]=Math.max(bounds[axis+3],tileBounds[axis+3]);
      }
    }
    return {...geometry,id,modelName:"ip_slod_imposter",origin,bounds,vegetation:group.radius,packedSlodCenter:group.center,
      instances:{poses,affine:true,tiles}};
  }

  function modelsInDeliveryOrder(){
    const foreground:{tag:number;key:bigint}[]=[],ahead:typeof foreground=[],reserve:typeof foreground=[];
    for(const [tag,{key,radius,coverage,tiles}] of groups){
      if(coverage>0){foreground.push({tag,key});continue;}
      const inView=[...tiles.values()].some(({bounds})=>padded([
        bounds[0]+origin[0],bounds[1]+origin[1],bounds[2],
        bounds[3]+origin[0],bounds[4]+origin[1],bounds[5],
      ],radius+motionReserve));
      (inView?ahead:reserve).push({tag,key});
    }
    foreground.sort((a,b)=>groups.get(b.tag)!.coverage-groups.get(a.tag)!.coverage);
    return [...foreground,...ahead,...reserve];
  }

  return {append,mesh,models:modelsInDeliveryOrder};
}

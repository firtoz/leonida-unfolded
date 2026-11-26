import type { Bounds } from "./native-spatial";

type LodVariant={name:string;rank:number};

export function sameStreetLodPlacement(a:readonly number[],b:readonly number[],first?:Bounds,second?:Bounds){
  if(Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2])<=3)return true;
  if(!first||!second)return false;
  // Some exported LODs use a different pivot and rotation for the same footprint.
  for(let axis=0;axis<3;axis++){
    const span=Math.max(first[axis+3]-first[axis],second[axis+3]-second[axis]);
    const tolerance=Math.max(.35,span*.035);
    if(Math.abs(first[axis]-second[axis])>tolerance||Math.abs(first[axis+3]-second[axis+3])>tolerance)return false;
  }
  return true;
}

export function streetLodVariant(name:string):LodVariant{
  const suffix=/_(s?lod)(\d*)$/i.exec(name);
  if(!suffix)return {name,rank:0};
  return {name:name.slice(0,suffix.index),rank:(suffix[1].toLowerCase()==="slod"?16:1)+Math.min(14,Number(suffix[2]))};
}
export const districtAggregate=/^[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)*_lod_(?:\d+[a-z]?_)*s\d+(?:_|$)/i;
export const terrainSectorLod=/^(?:[ns]\d+_[ew]\d+_)+(waterveg_)?slod\d+$/i;
export function streetPropLodVariant(name:string):LodVariant{
  return /_hd$/i.test(name)?{name:name.slice(0,-3),rank:0}:streetLodVariant(name);
}

export function sameStreetPropBatch(coarse:Float32Array,finer:Float32Array){
  if(coarse.length!==finer.length||!coarse.length||coarse.length%9)return false;
  const poses=new Set<string>();
  for(let at=0;at<finer.length;at+=9)poses.add(finer.subarray(at,at+9).join(","));
  if(poses.size!==finer.length/9)return false;
  for(let at=0;at<coarse.length;at+=9)if(!poses.delete(coarse.subarray(at,at+9).join(",")))return false;
  return true;
}

export function authoredLodParent(name:string){
  return /^(.+_s?lod\d*)_children_/i.exec(name)?.[1];
}

export function clonedPrefabName(name:string){
  const clone=/^.+_s?lod\d*(?:_[a-z])?_children_(.+)_s?lod\d*_cln$/i.exec(name)?.[1];
  if(clone)return `prefab_${clone.replace(/^am_e_/i,"am_")}`;
}

export const bridgeHorizon=1450;
export const lowSkylineHeight=8,tallSkylineHeight=24,lowSkylineHorizon=1100;
export function roadBridgeDrawable(name:string){
  return /(?:^|_)road(?:_[a-z0-9]+)?_(?:old_?)?bridge[a-z]*_/i.test(name)&&
    !/(?:_|^)(?:detail\d*|dtl|decal\d*|railing|bolts|cln)(?:_|$)/i.test(name);
}

export function bridgeDeckProxy(name:string){
  return roadBridgeDrawable(name)&&/_(?:s?lod)\d*$/i.test(name);
}

export function prefabBridgeSkyline(name:string){
  return /^prefab_am_bridge_\d+[a-z]?_slod\d*$/i.test(name);
}

export function streetLodInRange(bounds:Bounds,eye:readonly [number,number,number],distance:number){
  const x=(bounds[0]+bounds[3])*.5-eye[0];
  const y=(bounds[1]+bounds[4])*.5-eye[1];
  const z=(bounds[2]+bounds[5])*.5-eye[2];
  return x*x+y*y+z*z<=(distance+20)**2;
}

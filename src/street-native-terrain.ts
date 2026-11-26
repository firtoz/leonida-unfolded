import { terrainSectorBounds } from "./street-grid";
import type { Rpf9Mount } from "./rpf9-level-manifest";
import type { DetailProfile } from "./street-detail";
import type { StreetAsset } from "./street-mesh";
import { indexedTerrainTile } from "./street-index-placement";
import { joaat } from "./places";
import { view } from "./archive";
import type { StreetRpf9 } from "./street-rpf9";

export type TerrainFootprint=readonly [left:number,bottom:number,right:number,top:number];

export function intersectsTerrain(a:TerrainFootprint,b:TerrainFootprint){
  return a[0]<=b[2]&&b[0]<=a[2]&&a[1]<=b[3]&&b[1]<=a[3];
}

export function terrainViewFootprint([x,y]:readonly [number,number],reach:number):TerrainFootprint{
  const col=Math.floor(x/128),row=Math.floor(y/128);
  return [(col-reach)*128,(row-reach)*128,(col+reach+1)*128,(row+reach+1)*128];
}

export function terrainMounts(mounts:Iterable<Rpf9Mount>,base:TerrainFootprint,detail?:TerrainFootprint){
  const selected:Rpf9Mount[]=[];
  for(const mount of mounts){
    const match=/^platform:\/levels\/americas\/map\/terrain\/([ns]\d{2})_([ew]\d{2})_([ns]\d{2})_([ew]\d{2})\/([^/]+)\.rpf$/.exec(mount.path);
    if(!match)continue;
    const [,n0,e0,n1,e1,file]=match;
    const group=[n0,e0,n1,e1].join("_");
    if(file===group||file===group+"_metadata"){
      const a=terrainSectorBounds(n0,e0),b=terrainSectorBounds(n1,e1);
      if(intersectsTerrain(base,[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3])]))
        selected.push(mount);
      continue;
    }
    const tile=/^([ns]\d{2})_([ew]\d{2})$/.exec(file);
    if(tile&&detail&&intersectsTerrain(detail,terrainSectorBounds(tile[1],tile[2])))selected.push(mount);
  }
  return selected;
}

export function terrainMaterialHashes(data:DataView,sectorHash:number){
  const hashes=new Set<number>();
  if(data.byteLength<0x50||data.getUint32(0x10,true)!==0x50524430)return hashes;
  const table=Number(data.getBigUint64(0x38,true))-0x50000000;
  const count=data.getUint16(0x4c,true),root=data.getUint32(0x20,true);
  if(table<0||table+count*16>data.byteLength||!root||root>count||
    data.getUint32(table+(root-1)*16,true)!==0xd98bb561)return hashes;
  function block(index:number){
    if(index<1||index>count)return;
    const entry=table+(index-1)*16;
    const start=Number(data.getBigUint64(entry+8,true))-0x50000000;
    const end=start+data.getUint32(entry+4,true);
    if(start<0||end>data.byteLength)return;
    return {type:data.getUint32(entry,true),start,end};
  }
  for(let i=1;i<=count;i++){
    const definitions=block(i);
    if(definitions?.type!==0x82d6fc83||(definitions.end-definitions.start)%0xb8)continue;
    for(let row=definitions.start;row<definitions.end;row+=0xb8){
      const length=data.getUint16(row+0x98,true),reference=data.getBigUint64(row+0x90,true);
      const list=block(Number(reference&0xfffffn));
      if(!list||!length)continue;
      const start=list.start+Number(reference>>20n);
      if(start+length*8>list.end)continue;
      for(let j=0;j<length;j++){
        const entry=data.getBigUint64(start+j*8,true),extension=block(Number(entry&0xfffffn));
        if(extension?.type!==0xc170daef)continue;
        const at=extension.start+Number(entry>>20n);
        if(at+0x50>extension.end||data.getUint32(at+0x20,true)!==sectorHash)continue;
        const material=data.getUint32(at+0x44,true);
        if(material)hashes.add(material);
      }
    }
  }
  return hashes;
}

export async function readNativeTerrainMaterial(directory:StreetRpf9,mounts:Iterable<Rpf9Mount>,name:string){
  const coordinates=/^([ns]\d{2})_([ew]\d{2})$/.exec(name);
  if(!coordinates)return;
  const [left,bottom]=terrainSectorBounds(coordinates[1],coordinates[2]);
  const regional=[...mounts];
  const metadata=regional.find(mount=>mount.path.startsWith("platform:/levels/americas/map/terrain/")&&
    mount.path.endsWith("/"+name+"_metadata.rpf"))??terrainMounts(regional,[left+1,bottom+1,left+511,bottom+511])
    .find(mount=>mount.path.endsWith("_metadata.rpf"));
  if(!metadata)return;
  const path=metadata.path.split("/");
  const group=path[path.length-2];
  path[path.length-1]=group+"_terrain_images_merged.rpf";
  const images=regional.find(mount=>mount.path===path.join("/"));
  if(!images)return;
  const hashes=new Set<number>();
  const sectorHash=joaat(name);
  for(const pack of await directory.mountedMembers(metadata)){
    if(pack.type!==0x4a)continue;
    const data=view(await directory.readSystem(pack));
    for(const hash of terrainMaterialHashes(data,sectorHash))hashes.add(hash);
  }
  if(hashes.size!==1)return;
  return directory.readMountedMetadata(images,hashes.values().next().value!);
}

export type NativeTerrainCell={assets:StreetAsset[]};

export function nativeTerrainCells(assets:StreetAsset[]){
  const cells=new Map<string,NativeTerrainCell>();
  const lowByName=new Map<string,StreetAsset>();
  const lowByPlacement=new Map<string,StreetAsset>();
  const detail:DetailProfile=Object.create(null);
  for(const asset of assets){
    if(!asset.placement||indexedTerrainTile.exec(asset.name)?.[2]!=="lod")continue;
    const key=asset.placement.position.slice(0,2).map(value=>Math.floor(value/128)).join(",");
    let cell=cells.get(key);
    if(!cell)cells.set(key,cell={assets:[]});
    cell.assets.push(asset);
    lowByName.set(asset.name,asset);
    const link=asset.terrainLink;
    if(link)lowByPlacement.set(`${link.map}:${link.ordinal}`,asset);
  }
  for(const cell of cells.values())cell.assets.sort((a,b)=>a.name.localeCompare(b.name));
  for(const asset of assets){
    const match=indexedTerrainTile.exec(asset.name);
    if(match?.[2]!=="hd")continue;
    const parent=asset.terrainLink?.parent;
    const low=parent&&lowByPlacement.get(parent.join(":"))||lowByName.get(match[1]+"_lod");
    if(!low)continue;
    const previous=detail[low.name];
    detail[low.name]=previous?[...[previous].flat(),asset]:asset;
  }
  return {cells,detail};
}

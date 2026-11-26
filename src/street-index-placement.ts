import { inflate, readResources, view, type Archive } from "./archive";
import { placementLayout, type MapPage, type PlacementLodLink, type TerrainPlacementLink } from "./street-placement-probe";
import { readPlacement, type Placement } from "./street-placement";
import type { IndexedMap } from "./street-index-scan";
import { districtAggregate, prefabBridgeSkyline, terrainSectorLod } from "./street-lod";
import type { StreetAsset } from "./street-mesh";
import type { VegetationModel } from "./street-vegetation";
import { joaat } from "./places";
import { drawableNameKey } from "./street-drawable-identity";
import type { DrawableAlias } from "./street-archetypes";
import { rollerDrawable } from "./street-roller";

export type IndexedPlacement={at:number;hash:number;placement:Placement;range:number[];aggregate?:true;staged?:true;key?:string;model?:number;terrainLink?:TerrainPlacementLink;placementLod?:PlacementLodLink};

const terrain=/^(?:[ns]\d+_[ew]\d+_\d+|terrain_)/i;
export const indexedTerrainTile=/^([ns]\d+_[ew]\d+_\d+)(?:_?[a-d])?_(lod|hd)$/i;
const districtLod=/(?:^(?:[a-z][a-z0-9]*_)+\d+[a-z]?_(?:structure_)?slod\d*(?:_?[a-z])?|_lod_(?:\d+[a-z]?_)*slod\d+(?:_\d+)?)$/i;
const namedStagedDrawable=/^(?:nb_nrb_01_intro_cliff_|(?:ec_(?:cargo)?cont(?:ainer)?_|prop_am_excon_)drug_?(?:trip|trp)_|ec_drug_trip_gi_proxy$)/i;
const effectLightingProxy=/^gi_proxy_(?:fire(?:_.*)?|smoke)$/i;
export const batchPlant=/^veg_(?:grass|weed|bush|tree|palm|pot|crop)_.*(?<!_uw)(?<!_water)(?<!_imposter)$/i;
const modelKind=(name:string)=>rollerDrawable.test(name)?"structure":/^veg_(?:tree|palm|bush|weed|grass)_/.test(name)?"foliage":
  /(?:^|_)water(?:_|\d|$)/.test(name)&&!/(?:pipe|tank|tower|pump|filter|fall|crate)/.test(name)?"water":
  /(?:^|_)road_bridge(?:_|$)|^tr_[a-z0-9]+_bridge_[ns]_\d+[a-z]?(?:_\d+)?$/.test(name)?"road":
  /^(?:prop_|p_|prefab_)/.test(name)?"prop":undefined;

export function indexStreetModel(models:Map<number,VegetationModel>,candidate:VegetationModel){
  const existing=models.get(candidate.hash);
  if(existing&&(existing.name!==candidate.name||existing.streams[0][0]<=candidate.streams[0][0]))return false;
  models.set(candidate.hash,candidate);
  return true;
}

export class PlacementDrawables {
  readonly models=new Map<number,VegetationModel>();
  readonly propLods=new Map<number,VegetationModel>();
  private readonly keyed=new Map<number,Map<string,VegetationModel|null>>();
  private readonly aliases=new Map<number,DrawableAlias|null>();
  private readonly links=new Map<number,Set<number>>();

  addAlias(alias:DrawableAlias){
    const prior=this.aliases.get(alias.hash);
    if(prior===null||prior?.asset===alias.asset&&prior.kind===alias.kind)return false;
    this.aliases.set(alias.hash,prior?null:alias);
    if(prior)this.links.get(prior.asset)?.delete(alias.hash);
    else{
      let references=this.links.get(alias.asset);
      if(!references)this.links.set(alias.asset,references=new Set());
      references.add(alias.hash);
    }
    return true;
  }

  references(asset:number){return this.links.get(asset);}

  add(model:VegetationModel){
    const existing=this.models.get(model.hash);
    const differs=!!existing&&(existing.name!==model.name||existing.verified!==model.verified||
      !!existing.verified&&!!model.verified&&
      (existing.streams[0][0]!==model.streams[0][0]||existing.drawable!==model.drawable));
    const changed=!model.keyedOnly&&indexStreetModel(this.models,model);
    // Ordinary hashes keep one model. Retain corroborated alternatives only
    // where the same hash appears at more than one referenced drawable.
    if(differs||model.keyedOnly||this.keyed.has(model.hash)){
      let variants=this.keyed.get(model.hash);
      if(!variants)this.keyed.set(model.hash,variants=new Map());
      for(const candidate of existing?[existing,model]:[model]){
        if(!candidate.verified||joaat(candidate.name)!==candidate.hash)continue;
        const key=drawableNameKey(candidate.name),previous=variants.get(key);
        if(previous===undefined)variants.set(key,candidate);
        else if(previous&&(previous.streams[0][0]!==candidate.streams[0][0]||previous.drawable!==candidate.drawable))
          variants.set(key,null);
      }
    }
    return changed||!!model.keyedOnly||differs;
  }

  resolve(row:IndexedPlacement){
    const model=this.models.get(row.hash),variants=this.keyed.get(row.hash);
    if(row.key){
      const verified=variants?.get(row.key);
      if(verified)return verified;
    }
    if(model)return model;
    const alias=this.aliases.get(row.hash);
    if(alias){
      const candidates=this.keyed.get(alias.asset);
      const source=candidates?.size===1?candidates.values().next().value:
        candidates?undefined:this.models.get(alias.asset);
      if(source?.verified&&source.assetType===alias.kind&&joaat(source.name)===alias.asset)return source;
    }
    return this.propLods.get(row.hash);
  }
}

export function indexStreetPropLod(lods:Map<number,VegetationModel>,model:VegetationModel){
  if(!model.bounds||!/(?:^prop_|^prefab_).*_batchlod$/i.test(model.name))return;
  const hash=joaat(model.name.slice(0,-"_batchlod".length));
  // Keep the original resource name so the drawable reader can locate it.
  if(indexStreetModel(lods,{...model,hash}))return hash;
}

export function streetAsset(model:VegetationModel|undefined,{at,hash,placement,range,aggregate:authored,staged,terrainLink,placementLod}:IndexedPlacement,
  includeTerrain=false,includeStaged=false):StreetAsset|undefined{
  if(!model||!includeStaged&&(staged||namedStagedDrawable.test(model.name)||effectLightingProxy.test(model.name)))return;
  const ground=terrain.test(model.name);
  if(ground&&(!includeTerrain||!indexedTerrainTile.test(model.name)))return;
  const sector=terrainSectorLod.exec(model.name);
  // Sector water/vegetation proxies use water materials, outside the opaque sector pass.
  if(sector?.[1])return;
  const {position}=placement;
  const bounds=model.bounds;
  const kind=modelKind(model.name);
  // Sector-wide terrain proxies can sit above the detailed ground. They
  // remain distance-only even when the archive names their children.
  const aggregate=!ground&&!sector&&bounds&&Math.max(bounds[3]-bounds[0],bounds[4]-bounds[1])>=96&&
    (districtAggregate.test(model.name)||authored&&!kind&&!/(?:^|_)(?:scum|waterveg)(?:_|$)/i.test(model.name));
  return {...model,at,hash,instance:range,center:position.slice(0,2),centerZ:position[2],placement,
    localBounds:bounds,kind:ground?"terrain":sector||districtLod.test(model.name)||aggregate?"skyline":kind,
    terrainLink:ground?terrainLink:undefined,
    placementLod:!ground&&(prefabBridgeSkyline(model.name)||kind!=="prop"&&kind!=="foliage"&&kind!=="water")?placementLod:undefined,
    ...(aggregate?{aggregate:true as const}:{}),
    id:`native:${range[0].toString(16)}-${at.toString(16)}`,indexed:true};
}

export async function readIndexedPlacements(archive:Archive,map:IndexedMap):Promise<IndexedPlacement[]>{
  const bytes=new Uint8Array(map.pages.reduce((sum,page)=>sum+page[2],0));
  let cursor=0,index=0;
  // Adjacent system pages share one range read, including their alignment padding.
  for await(const {bytes:stored} of readResources(archive,map.pages.map(([offset,length])=>[offset,length]))){
    const [,,decoded,raw]=map.pages[index++];
    const page=raw?stored:inflate(stored,decoded);
    if(page.length!==decoded)throw new Error("Invalid indexed placement page.");
    bytes.set(page,cursor);
    cursor+=decoded;
  }
  return decodeIndexedPlacements(view(bytes),map.pages);
}

export function decodeIndexedPlacements(data:DataView,pages:readonly MapPage[]):IndexedPlacement[]{
  let cursor=0;
  const offsets=pages.map(([, , size])=>{
    const start=cursor;
    cursor+=size;
    return start;
  });
  const {offsets:placements,authoredLods,staged,keyOffset,tintSelectorOffset,propLayerControlOffset,propDirtControlOffset,
    links,lodLinks}=placementLayout(data);
  return placements.flatMap(at=>{
    const page=offsets.findIndex((start,index)=>at-52>=start&&at+24<=start+pages[index][2]);
    if(page<0||pages[page][3])return [];
    const hash=data.getUint32(at,true);
    try{
      const [offset,stored,size]=pages[page];
      const row:IndexedPlacement={at:at-offsets[page],hash,placement:readPlacement(data,at,hash),range:[offset,stored,size]};
      if(tintSelectorOffset!==undefined&&at+tintSelectorOffset>=offsets[page]&&
        at+tintSelectorOffset+4<=offsets[page]+size)
        row.placement.tintSelector=data.getUint32(at+tintSelectorOffset,true)&0x7f;
      if(propLayerControlOffset!==undefined&&at+propLayerControlOffset>=offsets[page]&&
        at+propLayerControlOffset<offsets[page]+size)
        row.placement.propLayerControl=data.getUint8(at+propLayerControlOffset);
      if(propDirtControlOffset!==undefined&&at+propDirtControlOffset>=offsets[page]&&
        at+propDirtControlOffset<offsets[page]+size)
        row.placement.propDirtControl=data.getUint8(at+propDirtControlOffset);
      row.terrainLink=links.get(at);
      row.placementLod=lodLinks.get(at);
      if(keyOffset!==undefined){
        const key=data.getBigUint64(at+keyOffset,true);
        if(key)row.key=key.toString(16).padStart(16,"0");
      }
      if(staged)row.staged=true;
      if(authoredLods){
        const level=data.getUint8(at+0x3a),children=data.getUint32(at+0x24,true);
        if((level>=2&&level<=4||level===6)&&children>1)row.aggregate=true;
      }
      return [row];
    }
    catch{return [];}
  });
}

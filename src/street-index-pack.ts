import { streetIndexBundleHeader } from "./street-cache-versions";
import { gzipSync } from "fflate";
import type { Archive } from "./archive";
import { indexShardKey, indexShardKeys, indexShardSize, streetArchiveFingerprint, type IndexManifest, type IndexShard } from "./street-index-bundle";
import { batchPlant, PlacementDrawables, indexStreetPropLod, readIndexedPlacements, streetAsset, type IndexedPlacement } from "./street-index-placement";
import { growBounds, indexScanVersion, type IndexedMap, type IndexedVegetation, type ScanSegment } from "./street-index-scan";
import type { VegetationModel } from "./street-vegetation";

export async function packStreetIndex(archive:Archive,total:number,
  checkpoints:Iterable<ScanSegment>|AsyncIterable<ScanSegment>,progress?:(done:number,total:number)=>void,scanVersion=indexScanVersion){
  const drawables=new PlacementDrawables(),{models,propLods}=drawables;
  const maps=new Map<number,IndexedMap>(),foliage=new Map<number,IndexedVegetation>();
  let count=0;
  for await(const rows of checkpoints){
    for(const model of rows.models)drawables.add(model);
    for(const alias of rows.aliases??[])drawables.addAlias(alias);
    for(const map of rows.maps)maps.set(map.pages[0][0],map);
    for(const row of rows.vegetation)foliage.set(row.system[0],row);
    count++;
  }
  if(count!==total)throw new Error("The world scan is incomplete.");
  for(const model of models.values())indexStreetPropLod(propLods,model);

  const cells=new Map<string,{entities:IndexedPlacement[];vegetation:IndexedVegetation[];models:Map<VegetationModel,number>}>();
  function cell(key:string){
    let entry=cells.get(key);
    if(!entry)cells.set(key,entry={entities:[],vegetation:[],models:new Map()});
    return entry;
  }
  let placements=0,unknown=0,failedMaps=0,linked=0;
  const seen=new Set<string>(),jobs=[...maps.values()].sort((a,b)=>a.pages[0][0]-b.pages[0][0]);
  progress?.(0,jobs.length);
  for(let start=0;start<jobs.length;start+=12){
    const batch=await Promise.all(jobs.slice(start,start+12).map(map=>
      readIndexedPlacements(archive,map).catch(()=>{failedMaps++;return [];})));
    for(const rows of batch)for(const row of rows){
      const key=`${row.range[0]}:${row.at}`;
      if(seen.has(key))continue;
      seen.add(key);
      const model=drawables.resolve(row);
      if(!model){unknown++;continue;}
      const asset=streetAsset(model,row,true,true);
      if(!asset)continue;
      if(model.keyedOnly||model.hash!==row.hash)linked++;
      const shard=cell(indexShardKey(row.placement.position[0],row.placement.position[1]));
      let slot=shard.models.get(model);
      if(slot===undefined){slot=shard.models.size;shard.models.set(model,slot);}
      const {key:_placementKey,terrainLink,placementLod:_placementLod,...placement}=row;
      shard.entities.push({...placement,terrainLink:asset.kind==="terrain"?terrainLink:undefined,placementLod:asset.placementLod,model:slot});
      placements++;
    }
    const done=start+batch.length;
    if(done===jobs.length||Math.floor(done/512)>Math.floor(start/512))progress?.(done,jobs.length);
  }

  for(const row of foliage.values()){
    const bounds=row.grass?row.woody?growBounds(row.grass,row.woody):row.grass:row.woody;
    if(!bounds)continue;
    const [left,bottom,right,top]=bounds.map(value=>Math.floor(value/indexShardSize));
    if((right-left+1)*(top-bottom+1)>64)cell("wide").vegetation.push(row);
    else for(const key of indexShardKeys(bounds))cell(key).vegetation.push(row);
  }

  const manifest:IndexManifest={
    archive:{size:archive.file.size,fingerprint:await streetArchiveFingerprint(archive.file)},
    scanVersion,terrain:true,terrainLinks:true,placementLods:true,authoredLods:true,stagedMaps:true,propLods:true,total,maps:maps.size,vegetation:foliage.size,models:models.size,placements,
    plants:[...models.values()].filter(model=>batchPlant.test(model.name)),shards:Object.create(null),
  };
  const payloads:BlobPart[]=[],encoder=new TextEncoder();
  let offset=0;
  for(const [key,{entities,vegetation,models}] of cells){
    const list=[...models.keys()];
    const byHash=new Map(list.map(({hash},index)=>[hash,index]));
    // Store a slot only when the normal hash lookup would pick a different drawable.
    const sparse=entities.map(({model,...row})=>byHash.get(row.hash)===model?row:{...row,model});
    const data:IndexShard={entities:sparse,models:list,vegetation};
    const payload=gzipSync(encoder.encode(JSON.stringify(data)),{level:3});
    manifest.shards[key]=[offset,payload.byteLength];
    payloads.push(payload);
    offset+=payload.byteLength;
  }
  const encoded=encoder.encode(JSON.stringify(manifest)),header=new Uint8Array(streetIndexBundleHeader.byteLength);
  header.set(encoder.encode(streetIndexBundleHeader.magic));
  new DataView(header.buffer).setUint32(streetIndexBundleHeader.lengthOffset,encoded.byteLength,true);
  return {file:new Blob([header,encoded,...payloads]),manifest,unknown,failedMaps,linked};
}

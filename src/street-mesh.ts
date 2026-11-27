import type { StreetAssetCache } from "./street-asset-cache";
import { inflate, readResources, text, view, type Archive, type Range } from "./archive";
import { emptyBounds, type Bounds } from "./native-spatial";
import type { DetailProfile } from "./street-detail";
import { bridgeDeckProxy, bridgeHorizon, districtAggregate, roadBridgeDrawable, sameStreetLodPlacement, streetLodVariant } from "./street-lod";
import { readableRoadMasks, retroDecalControls, roadDecalControl, roadWeightPrefix, elevatedRoadWeightPrefix, projectedRoadWeightPrefix, roadHeightPrefix, roadControlPrefix, roadSurfacePrefix, roadTintPrefix, roadSurfaceTintPrefix, type DecalLayers, type RoadLayers, type RoadVertices } from "./street-road-material";
import { detailAtlasSlicePrefix, materialMaskChainPrefix, standardPaletteMaterial, terrainTexturePrefix, waterScumTexturePrefix, type TerrainLayers } from "./street-terrain-material";
import {dynamicTerrainControl,sectorTerrainPage,type ComposedTerrainSource,type DynamicTerrainSource} from "./street-dynamic-terrain";
import { placementMatrix, placementNormalMatrix, readPlacement, type Placement } from "./street-placement";
import { readStreetRoller, rollerDrawable, type StreetRoller } from "./street-roller";
import type { InteriorMembership } from "./street-interior";
import { nativePackedTintMaterial, nativePaletteMaterial, type VegetationModel } from "./street-vegetation";
import { readIndexedBounds } from "./street-index-scan";
import { indexedTerrainTile } from "./street-index-placement";
import { streetGraphicsPages } from "./street-graphics";
import {streetFrustum,streetHorizon,streetLoadPriority,streetRegionSize,type StreetPendingBox,type StreetStreamView} from "./street-priority";
import {flightTerrainRadius,skylineRadius,type DetailCell} from "./street-grid";
import {streetBudgets} from "./street-capacity";
import {nativeTerrainCells,type NativeTerrainCell} from "./street-native-terrain";

type Vec3=[number,number,number];
export type StreetMesh = {
  origin:Vec3;
  vertices:Float32Array<ArrayBuffer>;
  indices:Uint16Array<ArrayBuffer>|Uint32Array<ArrayBuffer>;
};
export type PropMaterialLayers={
  textures:readonly [diffuse0:string,diffuse1:string,material0:string,material1:string,control:string];
  palette:Uint8Array;paletteKey:string;weightPower:number;dirt?:string;
  parallax?:{materials:readonly [string,string];march:readonly [number,number,number,number]};
};
export type StaticMaterialLayers={
  textures:PropMaterialLayers["textures"]; weightPower:number; layerControl:number;
  detail?:readonly [StaticLayerDetail|undefined,StaticLayerDetail|undefined];
  normals?:readonly [string,string];
  parallax?:NonNullable<PropMaterialLayers["parallax"]>["march"];
  dirt?:string;
  dirtDirect?:true;
};
type StaticLayerDetail=readonly [scaleU:number,scaleV:number,strength:number,phase:0|1,slice?:number];
export type StreetRoomMaterial={
  colorCube:string; projected:string; parameters:readonly [number,number,number,number];
  glass?:{textures:[string,string,string,string,string]; density:[number,number,number];
    absorption:[number,number,number,number]};
};
type SurfaceDecalBlend = {control:string; dirt:string; reciprocal:number};
type MaterialSpan = {first:number;count:number;texture:string|null;vertexPalette?:true;bump?:string;bumpStrength?:number;ground?:boolean;water?:boolean;cutout?:boolean;overlay?:boolean;frontOnlyDecal?:boolean;singleSided?:boolean;groundBlend?:boolean;vertexOpacity?:boolean;noDecalColor?:true;fallback?:string;textureBounds?:Bounds;road?:RoadLayers;terrain?:TerrainLayers;decalLayers?:DecalLayers;retroBlend?:number;decalTintMasks?:[string,string];decalTintMask?:string;surfacePalette?:string|true;surfaceDecalBlend?:SurfaceDecalBlend;propLayers?:PropMaterialLayers;staticLayers?:StaticMaterialLayers;room?:StreetRoomMaterial};
type Appearance = {uv:Float32Array<ArrayBuffer>;spans:MaterialSpan[]};
type AppearanceBuilder = {uv:number[];spans:MaterialSpan[];normals?:{first:number;values:Int16Array}[];foliage?:boolean;coarseGeometry?:boolean;
  waterScum?:string;mixedWater?:boolean;
  packedVegetationTint?:true;ordinaryPropLayers?:true;
  dynamic?:DynamicTerrainSource[];
  terrainColors?:{first:number;values:Uint8Array}[];
  terrainTintUV?:{first:number;values:Float32Array}[];
  terrainTangents?:{first:number;values:Int16Array}[];
  terrainSecondaryTangents?:{first:number;values:Int16Array}[];
  road?:{first:number;coordinates:Float32Array;weights:Uint8Array}[];
  decalOpacity?:{first:number;values:Uint8Array}[];
  parallaxDirtBias?:{first:number;values:Uint8Array}[];
  decalBlend?:{first:number;values:Uint8Array}[]};
export type InstanceTile = {first:number;count:number;bounds:Bounds};
export type StreetChunk = StreetMesh & {id:string;bounds:Bounds;kind:"terrain"|"structure"|"collision"|"water"|"road"|"foliage"|"navigation"|"skyline"|"prop";
  interior?:InteriorMembership;
  roller?:StreetRoller;
  geometryKey?:string;
  packedSlodCenter?:readonly [number,number,number];
  packedVegetationTint?:true;
  cropCanopy?:true;
  vegetationLinearFade?:true;
  vegetationLod?:{key:string;parent?:string;count:number;level:number;fallback?:true;
    instanceSlots?:true;parentInstance?:number;parentIndices?:number[]};
  modelName?:string;placementLod?:import("./street-placement-probe").PlacementLodLink;visualOnly?:true;overview?:true;aggregate?:true;indexedTerrain?:"supplement"|"replacement";
  appearance?:Appearance;normals?:Int16Array<ArrayBuffer>;terrainColors?:Uint8Array<ArrayBuffer>;terrainTintUV?:Float32Array<ArrayBuffer>;terrainTangents?:Int16Array<ArrayBuffer>;terrainSecondaryTangents?:Int16Array<ArrayBuffer>;road?:RoadVertices;decalOpacity?:Uint8Array<ArrayBuffer>;decalBlend?:Uint8Array<ArrayBuffer>;replaces?:string;
  instances?:{poses:Float32Array<ArrayBuffer>;ids?:string[];affine?:true;tiles?:InstanceTile[];ordinals?:Uint16Array<ArrayBuffer>;
    tintSelectors?:Uint8Array<ArrayBuffer>;propLayerControls?:Uint8Array<ArrayBuffer>;propDirtControls?:Uint8Array<ArrayBuffer>};
  collision?:{vertices:Float32Array<ArrayBuffer>;indices:Uint32Array<ArrayBuffer>};
  dynamic?:DynamicTerrainSource[];vegetation?:number;vegetationFadeStart?:number;drawDistance?:number};
export type StreetAsset={
  interior?:InteriorMembership;
  name:string; center:number[]; instance:number[]; streams:number[][]; system:number;
  at:number; hash:number; parts?:number[]; geometryDescriptor?:number; collisionRef?:number; coverage?:number[]; kind?:string; id?:string;
  distantDescriptor?:number;
  indexed?:true;aggregate?:true;
  centerZ?:number;
  localBounds?:Bounds;
  drawable?:number;
  graphicsRange?:VegetationModel["graphicsRange"];
  terrainLink?:import("./street-placement-probe").TerrainPlacementLink;
  placementLod?:import("./street-placement-probe").PlacementLodLink;
  placement?:Placement;
  batchStreams?:number[][]; batchSkip?:number[];
};
const structureRadius=450,foliageRadius=180,instanceCellSize=64;
const propDetailRadius=160;

function instanceOrigin(asset:StreetAsset):Vec3{
  return [Math.floor(asset.center[0]/instanceCellSize)*instanceCellSize,
    Math.floor(asset.center[1]/instanceCellSize)*instanceCellSize,0];
}

function propDrawDistance({localBounds,placement}:StreetAsset){
  if(!localBounds||!placement)return streetHorizon;
  const [left,bottom,low,right,top,high]=localBounds;
  const size=Math.max(right-left,top-bottom,high-low)*Math.max(...placement.scale);
  return Math.max(96,Math.min(streetHorizon,size*112));
}

function nearbyStructures(x:number,y:number,additional:StreetAsset[],withMaterials:boolean){
  const nearby:{asset:StreetAsset;distance:number}[]=[];
  const seen=new Set<string>();
  const placements=new Set<string>();
  const regionX=Math.floor(x/streetRegionSize)*streetRegionSize,regionY=Math.floor(y/streetRegionSize)*streetRegionSize;
  const add=(asset:StreetAsset)=>{
    const identity=`${asset.instance[0]}:${asset.at}`;
    if(seen.has(identity))return;
    const foliage=asset.kind==="foliage";
    if(foliage&&!withMaterials)return;
    const grouped=foliage||asset.kind==="prop"&&!asset.batchStreams;
    if(asset.kind==="prop"&&!asset.batchStreams){
      const [px,py]=asset.center;
      const distance=Math.hypot(Math.max(regionX-px,px-regionX-streetRegionSize,0),
        Math.max(regionY-py,py-regionY-streetRegionSize,0));
      if(distance>propDrawDistance(asset)+24)return;
    }
    const bridge=bridgeDeckProxy(asset.name);
    const bounds=grouped?undefined:asset.coverage??(bridge?structureBounds(asset):undefined);
    const [left,bottom]=grouped?instanceOrigin(asset):bounds??asset.center;
    const right=bounds?.[3]??left+(grouped?instanceCellSize:0);
    const top=bounds?.[4]??bottom+(grouped?instanceCellSize:0);
    const distance=Math.hypot(Math.max(0,left-x,x-right),Math.max(0,bottom-y,y-top));
    if(distance<=(foliage||asset.batchStreams?foliageRadius:bridge?bridgeHorizon:structureRadius)){
      seen.add(identity);
      if(asset.indexed&&asset.placement&&!asset.batchStreams){
        const {position,rotation,scale}=asset.placement;
        const signature=[asset.streams[0][0],asset.hash,...position,...rotation,...scale].join(",");
        if(placements.has(signature))return;
        placements.add(signature);
      }
      nearby.push({asset,distance});
    }
  };
  for(const asset of additional)add(asset);
  nearby.sort((a,b)=>a.distance-b.distance);
  return nearby;
}

function structureBatches(structures:ReturnType<typeof nearbyStructures>,x:number,y:number,cached:Set<string>){
  const batches=new Map<string,StreetAsset[]>();
  for(const {asset} of structures){
    const id=asset.kind==="foliage"||asset.kind==="prop"&&!asset.batchStreams
      ?`${asset.kind}:${asset.name}:${asset.streams[0][0].toString(16)}:${instanceOrigin(asset).slice(0,2).join(",")}`+
        (asset.kind==="prop"?`:${asset.geometryDescriptor??"default"}`:"")
      :asset.id??asset.name;
    const batch=batches.get(id);
    if(batch)batch.push(asset);
    else batches.set(id,[asset]);
  }
  return [...batches].map(([id,assets]):[string,StreetAsset[]]=>{
    const descriptor=assets[0].distantDescriptor;
    if(descriptor===undefined||assets.some(asset=>{
      const bounds=structureBounds(asset);
      const [left,bottom]=bounds??asset.center;
      const right=bounds?.[3]??left,top=bounds?.[4]??bottom;
      return Math.hypot(Math.max(0,left-x,x-right),Math.max(0,bottom-y,y-top))<=
        (cached.has(id)?propDetailRadius+32:propDetailRadius);
    }))return [id,assets];
    const [first,...rest]=assets;
    return [`${id}:lod`,[{...first,geometryDescriptor:descriptor},...rest]];
  });
}

export type StreetGeometryPhase="base"|"detail"|"planning"|"remaining";

export function structureBounds(asset:StreetAsset):Bounds|undefined{
  if(asset.coverage?.length===6&&asset.coverage.every(Number.isFinite))return asset.coverage as Bounds;
  const {placement,localBounds}=asset;
  if(!placement||!localBounds)return;
  const transform=placedVertex(placement,[0,0,0]),bounds=emptyBounds();
  for(let corner=0;corner<8;corner++){
    const point=transform(localBounds[corner&1?3:0],localBounds[corner&2?4:1],localBounds[corner&4?5:2]);
    for(let axis=0;axis<3;axis++){
      bounds[axis]=Math.min(bounds[axis],point[axis]);bounds[axis+3]=Math.max(bounds[axis+3],point[axis]);
    }
  }
  return bounds;
}

export function cachedMeshBytes(mesh:StreetChunk){
  const palettes=new Set(mesh.appearance?.spans.flatMap(span=>span.propLayers?[span.propLayers.palette]:[]));
  return mesh.vertices.byteLength+mesh.indices.byteLength+(mesh.appearance?.uv.byteLength??0)+
    (mesh.normals?.byteLength??0)+(mesh.terrainColors?.byteLength??0)+(mesh.terrainTintUV?.byteLength??0)+
    (mesh.terrainTangents?.byteLength??0)+(mesh.terrainSecondaryTangents?.byteLength??0)+
    (mesh.road?.uv.byteLength??0)+(mesh.road?.weights.byteLength??0)+(mesh.decalOpacity?.byteLength??0)+
    (mesh.decalBlend?.byteLength??0)+(mesh.instances?.poses.byteLength??0)+(mesh.instances?.ordinals?.byteLength??0)+
    (mesh.instances?.tintSelectors?.byteLength??0)+(mesh.instances?.propLayerControls?.byteLength??0)+
    (mesh.instances?.propDirtControls?.byteLength??0)+
    [...palettes].reduce((sum,palette)=>sum+palette.byteLength,0)+
    (mesh.collision?.indices.byteLength??0)+(mesh.collision?.vertices.byteLength??0)+256;
}

export async function loadStreetRegion(archive:Archive,[x,y]:readonly [number,number],known:string[],withMaterials=false,
  progress?:(meshes:StreetChunk[])=>void,active=()=>true,
  readStructures?:(point:readonly [number,number],radius:number,remember:(offset:number,table:DataView)=>void)=>Promise<StreetAsset[]>,
  surfaceOnly=false, reportWork?:(phase:StreetGeometryPhase,done?:number,total?:number)=>void,
  getCamera?:()=>StreetStreamView|undefined,showPending?:(boxes:StreetPendingBox[])=>void,
  assetCache?:StreetAssetCache,nearReady?:()=>void,
  readForeground?:(point:readonly [number,number],radius:number)=>Promise<StreetAsset[]>,
  readTerrain?:(point:readonly [number,number],reach:number,detailReach:number,cells?:readonly DetailCell[])=>Promise<StreetAsset[]>,
  onStructurePlan?:(planned:ReadonlySet<string>,conditional:ReadonlySet<string>)=>void){
  const cached=new Set(known),wanted:string[]=[],meshes:StreetChunk[]=[];
  const tables=new Map<number,Promise<DataView>>();
  const streamKey=(streams:number[][])=>streams.map(range=>range.join(",")).join(":");
  function instanceTable(range:number[],indexed=false){
    const offset=range[0];
    let table=tables.get(offset);
    if(!table){
      table=placementTable(archive,range,indexed);
      tables.set(offset,table);
    }
    return table;
  }
  const cx=Math.floor(x/128),cy=Math.floor(y/128);
  const cells: [number,number][]=[];
  let lastBatch=performance.now();
  function flush(size:number){
    if(!progress||!meshes.length)return;
    const now=performance.now();
    if(meshes.length>=size||now-lastBatch>=90){
      progress(meshes.splice(0));
      lastBatch=now;
    }
  }
  const cellId=([col,row]:DetailCell)=>`${col},${row}`;
  function startWork(phase:StreetGeometryPhase,total:number){
    let done=0,last=performance.now();
    if(total)reportWork?.(phase,0,total);
    return ()=>{
      done++;
      const now=performance.now();
      if(done===total||now-last>=80){
        reportWork?.(phase,done,total);
        last=now;
      }
    };
  }
  const reach=surfaceOnly?0:3;
  for(let dy=-reach;dy<=reach;dy++)for(let dx=-reach;dx<=reach;dx++)cells.push([cx+dx,cy+dy]);
  const distanceToCell=([col,row]:DetailCell)=>{
    const left=col*128,bottom=row*128;
    return Math.max(0,left-x,x-left-128)**2+Math.max(0,bottom-y,y-bottom-128)**2;
  };
  cells.sort((a,b)=>distanceToCell(a)-distanceToCell(b));
  const near=cells.filter(([col,row])=>Math.max(Math.abs(col-cx),Math.abs(row-cy))<=1);
  const distant=cells.filter(cell=>!near.includes(cell));
  if(!surfaceOnly&&readForeground&&!known.length){
    void Promise.all([readForeground([x,y],48),assetCache?.hasCachedMeshes()]).then(([assets,hasMeshes])=>{
      if(!active()||hasMeshes)return;
      const camera=getCamera?.();
      const rank=camera&&streetLoadPriority(camera);
      const nearby=assets.flatMap(asset=>{
        if(!asset.indexed||asset.kind==="skyline"||asset.kind==="foliage"||asset.batchStreams)return [];
        const [px,py,pz]=asset.placement?.position??[asset.center[0],asset.center[1],camera?.eye[2]??0];
        const distance=rank?.(structureBounds(asset)??[px,py,pz,px,py,pz]);
        return [{asset,distance:distance??((asset.center[0]-x)**2+(asset.center[1]-y)**2)}];
      }).sort((a,b)=>a.distance-b.distance);
      const resources=new Set<number>();
      for(const {asset} of nearby){
        if(resources.size>=streetBudgets.geometryReads)break;
        const offset=asset.streams[0][0];
        if(resources.has(offset))continue;
        resources.add(offset);
        void indexedDrawableBlocks(archive,asset).catch(()=>{});
      }
    }).catch(()=>{});
  }
  const additional=readStructures?.([x,y],structureRadius,(offset,table)=>{
    if(!tables.has(offset))tables.set(offset,Promise.resolve(table));
  });
  void additional?.catch(()=>{});
  let terrainError:unknown;
  function terrainFallback<T>(fallback:T){
    return (error:unknown)=>{terrainError??=error;return fallback;};
  }
  type RegionCell=NativeTerrainCell;
  const emptyTerrain=new Map<string,RegionCell>();
  let indexedTerrain:StreetAsset[]=[];
  let outerTerrain=emptyTerrain;
  let skipped=0;
  let detailProfile:DetailProfile|undefined;
  async function baseDrawable(entry:StreetAsset){
    return [entry.placement!,await indexedDrawableBlocks(archive,entry)] as const;
  }
  async function loadTerrainCell(col:number,row:number,source:RegionCell,detail:boolean){
    const id=`${col},${row}`;
    const key=`terrain-v${detail?44:7}:${Number(withMaterials)}:${id}:${Number(detail)}:native`;
    const localCache=Math.abs(col-cx)<=1&&Math.abs(row-cy)<=1?assetCache:undefined;
    const saved=await localCache?.get("mesh",key);
    if(saved)return saved;
    const origin:Vec3=[col*128,row*128,0],vertices:number[]=[],indices:number[]=[];
    const appearance:AppearanceBuilder={uv:[],spans:[],normals:withMaterials?[]:undefined};
    let incomplete=false;
    for(const entry of source.assets){
      const {name}=entry;
      const v=vertices.length,i=indices.length;
      const spanCount=appearance.spans.length,last=appearance.spans.at(-1),lastCount=last?.count;
      const normalCount=appearance.normals?.length??0;
      const restoreBase=()=>{
        vertices.length=v;indices.length=i;
        appearance.uv.length=v/2;
        appearance.spans.length=spanCount;
        if(appearance.normals)appearance.normals.length=normalCount;
        if(last&&lastCount!==undefined)last.count=lastCount;
      };
      try{
        const high=detail?detailProfile?.[name]:undefined;
        if(high){
          let fallback:string|undefined;
          try{
            const [transform,blocks]=await baseDrawable(entry);
            const lowVertices:number[]=[],lowAppearance:AppearanceBuilder={uv:[],spans:[]};
            appendDrawable(blocks,entry,0,0,transform,origin,65,lowVertices,[],true,
              lowAppearance,undefined,entry.geometryDescriptor);
            fallback=matchedGroundAtlas(lowVertices,lowAppearance);
          }catch{
            // The high-detail mesh can still use its own materials.
          }
          for(const part of Array.isArray(high)?high:[high]){
            const [transform,blocks]=part.indexed?await baseDrawable(part):await Promise.all([
              instanceTable(part.instance).then(data=>readPlacement(data,part.at,part.hash)),
              drawableBlocks(archive,part.streams,part.system),
            ]);
            appendDrawable(blocks,part.indexed?part:part.name,0,0,transform,origin,65,vertices,indices,true,appearance,
              part.parts,part.geometryDescriptor,false,withMaterials,fallback);
          }
        }else{
          const [transform,blocks]=await baseDrawable(entry);
          appendDrawable(blocks,entry,0,0,transform,origin,65,vertices,indices,true,
            appearance,undefined,entry.geometryDescriptor,true);
        }
      }catch{
        // Keep the complete LOD cell if any part of its replacement fails.
        skipped++;
        incomplete=true;
        if(detail)return;
        restoreBase();
      }
    }
    if(!indices.length)return;
    const result=chunk(detail?`${id}:detail`:id,"terrain",origin,vertices,indices,appearance);
    if(detail)result.replaces=id;
    if(!incomplete)localCache?.put("mesh",key,result,cachedMeshBytes(result));
    return result;
  }
  const pendingBase=(cell:DetailCell,sources:Map<string,RegionCell>)=>{
    const id=cellId(cell);
    return sources.has(id)&&!cached.has(id);
  };
  async function loadBaseCell([col,row]:DetailCell,sources:Map<string,RegionCell>,complete:()=>void,prefetch=false){
    const id=cellId([col,row]),source=sources.get(id);
    if(!source)return;
    if(!prefetch)wanted.push(id);
    if(!cached.has(id)){
      const mesh=await loadTerrainCell(col,row,source,false);
      if(mesh&&active()){
        meshes.push(mesh);
        if(prefetch)cached.add(id);
      }
      complete();
    }
  }
  const cameraCell=cellId([cx,cy]);
  if(progress&&readTerrain&&!surfaceOnly&&!cached.has(cameraCell)){
    const assets=await readTerrain([x,y],0,-1).catch(()=>[]);
    if(!active())return {wanted,meshes,skipped};
    const source=nativeTerrainCells(assets).cells.get(cameraCell);
    if(source){
      const priorSkips=skipped;
      const mesh=await loadTerrainCell(cx,cy,source,false);
      if(!active())return {wanted,meshes,skipped};
      if(mesh&&skipped===priorSkips){
        cached.add(cameraCell);
        meshes.push(mesh);
        flush(1);
      }
    }
  }
  const native=readTerrain?.([x,y],reach,1).then(assets=>{
    if(!active())return;
    const source=nativeTerrainCells(assets);
    return source.cells.size?source:undefined;
  }).catch(()=>undefined);
  const readBaseCells=async (requested:DetailCell[]):Promise<Map<string,RegionCell>>=>{
    const terrain=await native;
    if(!active()||!terrain)return emptyTerrain;
    const selected=new Map<string,RegionCell>();
    for(const cell of requested){
      const id=cellId(cell),source=terrain.cells.get(id);
      if(source)selected.set(id,source);
    }
    return selected;
  };
  const distantSources=readBaseCells(distant).catch(terrainFallback(emptyTerrain));
  const detailSources=(async()=>{
    const terrain=await native;
    if(active())return terrain?.detail;
  })().catch(terrainFallback(undefined));
  const nearSources=await readBaseCells(near).catch(terrainFallback(emptyTerrain));
  const baseDone=startWork("base",near.filter(cell=>pendingBase(cell,nearSources)).length);
  // Deliver the camera cell first, then overlap reads for its neighbors.
  for(let start=0;start<near.length&&active();){
    const end=start===0?1:start+streetBudgets.terrainReads;
    await Promise.all(near.slice(start,end).map(async cell=>{
      await loadBaseCell(cell,nearSources,baseDone);
      if(active())flush(1);
    }));
    start=end;
  }
  if(!active())return {wanted,meshes,skipped};
  nearReady?.();
  // Native detail shares the terrain directory already used for nearby base cells.
  // Its geometry can arrive while the separate structure catalog is still resolving.
  const nearbyDetail=readTerrain&&!surfaceOnly?loadNearbyDetail():undefined;
  void nearbyDetail?.catch(()=>{});
  async function loadNearbyDetail(){
    if(!detailSources||!active())return;
    detailProfile=await detailSources;
    const available=detailProfile;
    if(!available)return;
    const detailedCells=near.filter(cell=>{
      const source=nearSources.get(cellId(cell));
      return source&&source.assets.some(entry=>Object.hasOwn(available,entry.name));
    })
      .sort((a,b)=>distanceToCell(a)-distanceToCell(b)).slice(0,streetBudgets.detailCells);
    for(const cell of detailedCells)wanted.push(`${cellId(cell)}:detail`);
    const missing=detailedCells.filter(cell=>!cached.has(`${cellId(cell)}:detail`));
    for(let start=0;start<missing.length&&active();start+=streetBudgets.terrainReads){
      await Promise.all(missing.slice(start,start+streetBudgets.terrainReads).map(async ([col,row])=>{
        const mesh=await loadTerrainCell(col,row,nearSources.get(`${col},${row}`)!,true);
        if(mesh&&active()){
          meshes.push(mesh);
          flush(1);
        }
      }));
    }
  }
  async function loadDetail(){
    await (nearbyDetail??loadNearbyDetail());
    if(detailProfile&&indexedTerrain.length&&active())await loadIndexedTerrain(detailProfile);
  }
  async function loadIndexedTerrain(profile:DetailProfile){
    const base=new Map<string,StreetAsset>();
    for(const source of [...nearSources.values(),...outerTerrain.values()])
      for(const entry of source.assets)base.set(entry.name,entry);
    const detail=new Set(Object.values(profile).flatMap(value=>Array.isArray(value)?value.map(part=>part.name):[value.name]));
    const atlases=new Map<string,Promise<string|undefined>>();
    function atlasFor(name:string,origin:Vec3){
      const entry=base.get(name);
      if(!entry)return;
      const key=`${name}:${origin[0]}:${origin[1]}`;
      let image=atlases.get(key);
      if(!image){
        image=(async()=>{
          const [placement,blocks]=await baseDrawable(entry);
          const vertices:number[]=[],appearance:AppearanceBuilder={uv:[],spans:[]};
          appendDrawable(blocks,entry,0,0,placement,origin,65,vertices,[],true,appearance,
            undefined,entry.geometryDescriptor,true);
          return matchedGroundAtlas(vertices,appearance);
        })().catch(()=>undefined);
        atlases.set(key,image);
      }
      return image;
    }
    const seen=new Set<string>();
    const parents=new Map<string,StreetAsset|null>();
    for(const terrainAsset of indexedTerrain){
      const link=terrainAsset.terrainLink;
      if(!link||indexedTerrainTile.exec(terrainAsset.name)?.[2].toLowerCase()!=="lod")continue;
      const key=`${link.map}:${link.ordinal}`;
      parents.set(key,parents.has(key)?null:terrainAsset);
    }
    const jobs=indexedTerrain.flatMap(asset=>{
      const tile=indexedTerrainTile.exec(asset.name);
      if(!tile||!asset.placement)return [];
      const high=tile[2].toLowerCase()==="hd";
      const [px,py,pz]=asset.placement.position;
      const col=Math.floor(px/128),row=Math.floor(py/128);
      if(Math.max(Math.abs(col-cx),Math.abs(row-cy))>(high?1:3)|| (high?detail:base).has(asset.name))return [];
      const signature=`${asset.name}:${px}:${py}:${pz}`;
      if(seen.has(signature))return [];
      seen.add(signature);
      const parent=asset.terrainLink?.parent;
      const authored=parent?parents.get(parent.join(":")):undefined;
      const baseName=authored&&base.has(authored.name)?authored.name:`${tile[1]}_lod`;
      return [{asset,id:`terrain:${asset.id}`,high,col,row,baseName,distance:Math.hypot(x-px,y-py)}];
    }).sort((a,b)=>a.distance-b.distance);
    const complete=startWork("detail",jobs.filter(({id})=>!cached.has(id)).length);
    for(let start=0;start<jobs.length&&active();start+=streetBudgets.terrainReads){
      await Promise.all(jobs.slice(start,start+streetBudgets.terrainReads).map(async ({asset,id,high,col,row,baseName})=>{
        if(cached.has(id)){wanted.push(id);return;}
        try{
          const placement=asset.placement!;
          const blocks=await indexedDrawableBlocks(archive,asset);
          if(!active())return;
          const origin:Vec3=[col*128,row*128,0],vertices:number[]=[],indices:number[]=[];
          const appearance:AppearanceBuilder={uv:[],spans:[],normals:withMaterials?[]:undefined};
          const replacesBase=high&&base.has(baseName);
          const fallback=replacesBase&&withMaterials?await atlasFor(baseName,origin):undefined;
          if(!active())return;
          appendDrawable(blocks,asset,0,0,placement,origin,65,vertices,indices,true,appearance,
            asset.parts,asset.geometryDescriptor??indexedDescriptor(blocks.metadata,asset),!high,withMaterials,fallback);
          if(!indices.length||replacesBase&&withMaterials&&
            !appearance.spans.some(span=>!span.overlay&&(span.texture||span.terrain||span.road||span.fallback)))return;
          const mesh=chunk(id,"terrain",origin,vertices,indices,appearance);
          mesh.modelName=asset.name;
          mesh.indexedTerrain=replacesBase&&withMaterials?"replacement":"supplement";
          mesh.visualOnly=true;
          if(high)mesh.replaces=`${col},${row}`;
          wanted.push(id);meshes.push(mesh);flush(1);
        }catch{ /* Keep the available terrain whenever a supplemental piece cannot be decoded. */ }
        finally{complete();}
      }));
    }
  }
  if(surfaceOnly){await loadNearbyDetail();return {wanted,meshes,skipped};}
  reportWork?.("planning");
  const [extras,sources]=await Promise.all([additional??[],distantSources]);
  if(!active())return {wanted,meshes,skipped};
  indexedTerrain=extras.filter(asset=>asset.kind==="terrain");
  outerTerrain=sources;
  const [regionX,regionY]=[x,y].map(value=>Math.floor(value/streetRegionSize)*streetRegionSize);
  const structures=structureBatches(nearbyStructures(x,y,extras.filter(asset=>asset.kind!=="terrain"),withMaterials),x,y,cached).filter(([id,batch])=>{
    if(cached.has(id))return true;
    return batch.some(asset=>{
      const bounds=structureBounds(asset);
      if(!bounds)return true;
      const [left,bottom,,right,top]=bounds;
      const bridge=bridgeDeckProxy(asset.name);
      if(asset.kind==="skyline"&&!(bridge&&asset.placementLod?.distance)&&
        !asset.aggregate&&!districtAggregate.test(asset.name)){
        // The entire proxy is within the near exclusion for every camera position in this region.
        return left<=regionX+streetRegionSize-streetHorizon||right>=regionX+streetHorizon||
          bottom<=regionY+streetRegionSize-streetHorizon||top>=regionY+streetHorizon;
      }
      const radius=bridge?bridgeHorizon:asset.kind==="skyline"?skylineRadius:streetHorizon;
      return right>=regionX-radius&&left<=regionX+streetRegionSize+radius&&
        top>=regionY-radius&&bottom<=regionY+streetRegionSize+radius;
    });
  });
  const variants=new Map<string,{job:typeof structures[number];rank:number;position:Placement["position"];bounds?:Bounds}[]>();
  for(const job of structures){
    const [,batch]=job,asset=batch[0];
    if(!asset.placement||asset.kind==="skyline"||asset.kind==="foliage"||asset.kind==="prop"||asset.batchStreams)continue;
    const {name,rank}=streetLodVariant(asset.name);
    const variant={job,rank,position:asset.placement.position,bounds:structureBounds(asset)};
    const entries=variants.get(name);
    if(entries)entries.push(variant);else variants.set(name,[variant]);
  }
  const preferred=new Map<string,typeof structures>();
  for(const group of variants.values())for(const variant of group){
    if(!variant.rank)continue;
    const finer=group.filter(row=>row.rank<variant.rank&&sameStreetLodPlacement(row.position,variant.position,row.bounds,variant.bounds));
    if(finer.length)preferred.set(variant.job[0],finer.map(row=>row.job));
  }
  if(onStructurePlan)onStructurePlan(new Set([...wanted,...structures.map(([id])=>id)]),new Set(preferred.keys()));
  const resolved=new Set(cached);
  const hasPreferred=(id:string)=>preferred.get(id)?.some(([better])=>resolved.has(better));
  const remainingDone=startWork("remaining",distant.filter(cell=>pendingBase(cell,sources)).length+
    structures.filter(([id])=>!cached.has(id)).length);
  const structuresByResource=new Map<string,{remaining:number;blocks?:ReturnType<typeof drawableBlocks>}>();
  const placementBatches=new Map<string,ReturnType<typeof drawableBlocks>>();
  const resourceKey=(asset:StreetAsset)=>`${asset.system}:${streamKey(asset.streams)}`;
  const batchShapes=new Map<string,string>(),shapeUses=new Map<string,number>();
  const placedShapes=new Map<string,{mesh:StreetChunk;bytes:number}>();
  let shapeBytes=0;
  function takeShape(key:string){
    const shape=placedShapes.get(key);
    if(shape){placedShapes.delete(key);shapeBytes-=shape.bytes;}
    return shape?.mesh;
  }
  function keepShape(key:string,mesh:StreetChunk){
    const bytes=cachedMeshBytes(mesh),limit=streetBudgets.drawableBytes/4;
    if(bytes>limit)return false;
    placedShapes.set(key,{mesh,bytes});
    shapeBytes+=bytes;
    while(shapeBytes>limit||placedShapes.size>192)takeShape(placedShapes.keys().next().value!);
    return true;
  }
  function loadResource(asset:StreetAsset,entry:{blocks?:ReturnType<typeof drawableBlocks>}){
    return entry.blocks??=asset.indexed?indexedDrawableBlocks(archive,asset):drawableBlocks(archive,asset.streams,asset.system);
  }
  for(const [id,[asset]] of structures){
    if(cached.has(id))continue;
    const key=resourceKey(asset),entry=structuresByResource.get(key);
    if(entry)entry.remaining++;
    else structuresByResource.set(key,{remaining:1});
    if(!asset.batchStreams&&(asset.kind==="prop"||asset.kind==="foliage")){
      const shapeKey=`${key}:${asset.kind}:${asset.name}:${asset.drawable??""}:${asset.geometryDescriptor??""}:${asset.parts?.join(",")??""}`;
      batchShapes.set(id,shapeKey);
      shapeUses.set(shapeKey,(shapeUses.get(shapeKey)??0)+1);
    }
  }
  const boxes=new Map<string,Bounds>();
  for(const [id,batch] of structures){
    if(cached.has(id))continue;
    const bounds=structureBounds(batch[0]);
    if(bounds)boxes.set(id,bounds);
  }
  let priorityCamera:StreetStreamView|undefined;
  let priority:(bounds:Bounds,skyline?:boolean)=>number;
  function notifyPending(current?:StreetPendingBox){
    if(!showPending)return;
    const pending=current?[current]:[];
    for(const [id] of structures){
      const bounds=boxes.get(id);
      if(bounds)pending.push({id,bounds});
      if(pending.length===40)break;
    }
    showPending(pending);
  }
  const objectPriority=([id,batch]:typeof structures[number])=>{
    const asset=batch[0];
    if(asset.kind==="prop"&&batch.length>1){
      let nearest=Infinity;
      for(const item of batch){
        const [px,py]=item.center,pz=item.centerZ??priorityCamera?.eye[2]??0;
        nearest=Math.min(nearest,priority([px,py,pz,px,py,pz]));
      }
      return nearest;
    }
    const [ax,ay]=asset.center,az=asset.centerZ??priorityCamera?.eye[2]??0;
    return priority(boxes.get(id)??[ax,ay,az,ax,ay,az],asset.kind==="skyline");
  };
  const terrainPriority=([col,row]:DetailCell)=>{
    const [left,bottom]=[col*128,row*128],z=priorityCamera?.eye[2]??0;
    return priority([left,bottom,z-20,left+128,bottom+128,z]);
  };
  function orderWork(){
    priorityCamera=getCamera?.();
    priority=priorityCamera?streetLoadPriority(priorityCamera):bounds=>
      Math.max(0,bounds[0]-x,x-bounds[3])**2+Math.max(0,bounds[1]-y,y-bounds[4])**2;
    const priorities=new Map(structures.map(job=>[job[0],objectPriority(job)]));
    const rank=([id]:typeof structures[number])=>{
      const base=priorities.get(id)!;
      const finer=preferred.get(id);
      return finer?Math.max(base,...finer.map(job=>priorities.has(job[0])?priorities.get(job[0])!+1:base)):base;
    };
    structures.sort((a,b)=>rank(a)-rank(b));
    distant.sort((a,b)=>terrainPriority(a)-terrainPriority(b));
    notifyPending();
  }
  orderWork();
  const prefetching=new Set<string>();
  const meshLookups=new Map<string,{key:string;result:Promise<StreetChunk|undefined>}>();
  let cacheSlots=streetBudgets.cachedStructures;
  function lookupMesh(id:string,batch:StreetAsset[],resource:string){
    let lookup=meshLookups.get(id);
    const asset=batch[0];
    if(!lookup&&assetCache&&cacheSlots>0&&asset.indexed&&asset.kind!=="foliage"){
      cacheSlots--;
      // A spatial batch can contain different placements at the streaming boundary.
      const members=asset.kind==="prop"?batch.map(row=>`${row.instance[0].toString(16)}-${row.at}`).sort().join(","):"";
      const aggregate=asset.kind==="skyline"&&(asset.aggregate||districtAggregate.test(asset.name));
      const deckSchema=roadBridgeDrawable(asset.name)?":bridge-material":"";
      const groupSchema=indexedRootShape(asset)&&!asset.parts?":root-group":"";
      const tintSchema=asset.kind==="prop"&&!asset.batchStreams&&
        (withMaterials||batch.some(row=>row.placement?.tintSelector!==undefined))?":instance-tint-v5":"";
      const boundsSchema=asset.kind==="prop"&&!asset.batchStreams?":instance-bounds-v1":"";
      const kind=asset.kind??"structure";
      const version=withMaterials&&kind==="structure"?39:withMaterials&&kind==="prop"?34:32;
      const rollerSchema=rollerDrawable.test(asset.name)?":roller-v1":"";
      const key=`object-v${version}:${Number(withMaterials)}:${id}:${resource}:${asset.geometryDescriptor??""}:${kind}:${members}${asset.drawable===undefined?"":`:${asset.drawable}`}${aggregate?":aggregate":""}${deckSchema}${groupSchema}${tintSchema}${boundsSchema}${rollerSchema}`;
      lookup={key,result:assetCache.get("mesh",key)};
      meshLookups.set(id,lookup);
    }
    return lookup;
  }
  const detailDeadline=performance.now()+300;
  let detailWork:Promise<void>|undefined;
  let earlyFlight:{view:StreetStreamView;plan:ReturnType<typeof planFlightTerrain>}|undefined;
  async function planFlightTerrain(view:StreetStreamView){
    const visible=streetFrustum(view,1.32),farReach=Math.ceil(flightTerrainRadius/128);
    const flightCells:DetailCell[]=[];
    for(let row=cy-farReach;row<=cy+farReach;row++)for(let col=cx-farReach;col<=cx+farReach;col++){
      if(Math.max(Math.abs(row-cy),Math.abs(col-cx))<=reach)continue;
      const left=col*128,bottom=row*128;
      if(visible([left,bottom,-20,left+128,bottom+128,80],flightTerrainRadius)&&
        distanceToCell([col,row])<=flightTerrainRadius**2)flightCells.push([col,row]);
    }
    flightCells.sort((a,b)=>distanceToCell(a)-distanceToCell(b));
    const assets=flightCells.length&&readTerrain?await readTerrain([x,y],farReach,-1,flightCells).catch(()=>[]):[];
    if(!active())return;
    const sources=nativeTerrainCells(assets).cells;
    if(!sources.size)return;
    return {sources,cells:flightCells.filter(cell=>sources.has(cellId(cell))).slice(0,24)};
  }
  function startEarlyFlightTerrain(){
    const view=getCamera?.();
    if(!progress||!readTerrain||!view?.flightTerrain)return;
    const plan=planFlightTerrain(view).then(async result=>{
      if(!active()||!result)return;
      // Give visible distant ground a small head start while the object
      // queue continues. The final view alone decides which cells to keep.
      const cells=result.cells.filter(cell=>pendingBase(cell,result.sources)).slice(0,4);
      await Promise.all(cells.map(async cell=>{
        await loadBaseCell(cell,result.sources,()=>{},true);
        if(active())flush(1);
      }));
      return result;
    });
    earlyFlight={view,plan};
    void plan.catch(()=>{});
  }
  let foregroundObjects=0;
  while(structures.length){
    if(!active())return {wanted,meshes,skipped};
    if(!detailWork&&(foregroundObjects>=5||performance.now()>detailDeadline)){
      detailWork=loadDetail();
      void detailWork.catch(()=>{});
      startEarlyFlightTerrain();
    }
    if(getCamera?.()!==priorityCamera)orderWork();
    for(const [id,batch] of structures){
      if(prefetching.size>=streetBudgets.geometryReads)break;
      if(cached.has(id)||preferred.has(id))continue;
      const shapeKey=batchShapes.get(id);
      if(shapeKey&&placedShapes.has(shapeKey))continue;
      const asset=batch[0];
      const key=resourceKey(asset),entry=structuresByResource.get(key)!;
      if(entry.blocks||prefetching.has(key))continue;
      prefetching.add(key);
      const lookup=lookupMesh(id,batch,key);
      const work=lookup?lookup.result.then(saved=>saved||!active()?undefined:loadResource(asset,entry)):loadResource(asset,entry);
      void work.catch(()=>{}).finally(()=>prefetching.delete(key));
    }
    const job=structures.shift()!;
    const [id,batch]=job;
    const asset=batch[0];
    const key=resourceKey(asset);
    if(!cached.has(id)&&hasPreferred(id)){
      const entry=structuresByResource.get(key)!;
      if(!--entry.remaining)structuresByResource.delete(key);
      boxes.delete(id);
      remainingDone();
      continue;
    }
    const rank=objectPriority(job);
    while(distant.length&&terrainPriority(distant[0])<rank){
      await loadBaseCell(distant.shift()!,sources,remainingDone);
      if(!active())return {wanted,meshes,skipped};
      flush(4);
    }
    wanted.push(id);
    if(!cached.has(id)){
      const entry=structuresByResource.get(key)!;
      if(!active())return {wanted,meshes,skipped};
      const shapeKey=batchShapes.get(id);
      const later=shapeKey?(shapeUses.get(shapeKey)??1)-1:0;
      if(shapeKey)shapeUses.set(shapeKey,later);
      const lookup=lookupMesh(id,batch,key);
      if(lookup){
        const saved=await lookup.result;
        meshLookups.delete(id);
        if(saved){
          if(shapeKey&&!later)takeShape(shapeKey);
          if(shapeKey&&saved.instances)saved.geometryKey=`placed:${Number(withMaterials)}:${shapeKey}`;
          saved.modelName??=asset.name;
          saved.placementLod=asset.placementLod;
          if(asset.kind==="prop"&&!asset.batchStreams)saved.drawDistance=Math.max(...batch.map(propDrawDistance));
          if(bridgeDeckProxy(asset.name)&&saved.kind!=="skyline")saved.drawDistance=bridgeHorizon;
          meshes.push(saved);
          resolved.add(id);
          boxes.delete(id);
          if(!--entry.remaining)structuresByResource.delete(key);
          remainingDone();
          flush(foregroundObjects++<5?1:6);
          continue;
        }
      }
      if(showPending&&asset.indexed&&!boxes.has(id)&&asset.placement){
        const metadata=await indexedMetadata(archive,asset).catch(()=>undefined);
        const localBounds=metadata&&readIndexedBounds(metadata,asset.name);
        const bounds=localBounds&&structureBounds({...asset,localBounds});
        if(bounds&&active()){
          boxes.set(id,bounds);
          notifyPending({id,bounds});
        }
      }
      let decoded:StreetChunk|undefined;
      try{
        if(asset.batchStreams){
          const key=streamKey(asset.batchStreams);
          let placement=placementBatches.get(key);
          if(!placement){
            placement=drawableBlocks(archive,asset.batchStreams);
            placementBatches.set(key,placement);
          }
          decoded=await loadPropBatch(asset,loadResource(asset,entry),placement,withMaterials);
        }else if(shapeKey){
          let mesh=takeShape(shapeKey)??loadPlacedShape(asset,await loadResource(asset,entry),withMaterials);
          mesh.geometryKey=`placed:${Number(withMaterials)}:${shapeKey}`;
          if(later&&keepShape(shapeKey,mesh))mesh=structuredClone(mesh);
          decoded=await loadPlacedBatch(id,batch,range=>instanceTable(range,asset.indexed),mesh);
        }else{
          decoded=await loadStreetAsset(archive,asset,withMaterials,
            asset.placement?undefined:instanceTable(asset.instance,asset.indexed),loadResource(asset,entry));
        }
      }catch{skipped++;}
      if(!active())return {wanted,meshes,skipped};
      if(decoded){
        if(bridgeDeckProxy(asset.name)&&decoded.kind!=="skyline")decoded.drawDistance=bridgeHorizon;
        if(lookup)assetCache?.put("mesh",lookup.key,decoded,cachedMeshBytes(decoded));
        meshes.push(decoded);
        resolved.add(id);
      }
      if(boxes.delete(id)&&!decoded)notifyPending();
      if(!--entry.remaining)structuresByResource.delete(key);
      remainingDone();
      flush(decoded&&foregroundObjects++<5?1:6);
    }
  }
  detailWork??=loadDetail();
  void detailWork.catch(()=>{});
  for(const cell of distant){
    if(!active())return {wanted,meshes,skipped};
    await loadBaseCell(cell,sources,remainingDone);
    flush(4);
  }
  await detailWork;
  const prepared=await earlyFlight?.plan;
  if(!active())return {wanted,meshes,skipped};
  if(terrainError){
    flush(1);
    // The caller keeps resident chunks when metadata could not be fetched.
    throw terrainError;
  }
  const view=getCamera?.();
  if(view?.flightTerrain){
    const plan=prepared&&view===earlyFlight?.view?prepared:await planFlightTerrain(view);
    if(!active())return {wanted,meshes,skipped};
    const sources=plan?.sources??emptyTerrain;
    const selected=plan?.cells??[];
    const complete=startWork("remaining",selected.filter(cell=>pendingBase(cell,sources)).length);
    for(let start=0;start<selected.length&&active();start+=streetBudgets.terrainReads){
      await Promise.all(selected.slice(start,start+streetBudgets.terrainReads).map(async cell=>{
        await loadBaseCell(cell,sources,complete);
        if(active())flush(3);
      }));
    }
  }
  return {wanted,meshes,skipped};
}

export async function loadPropAsset(archive:Archive,asset:StreetAsset){
  if(!asset.batchStreams)throw new Error("Missing prop placement streams.");
  return loadPropBatch(asset,drawableBlocks(archive,asset.streams,asset.system),drawableBlocks(archive,asset.batchStreams),true);
}

export async function loadVegetationGeometry(archive:Archive,model:VegetationModel,indexed=false,coarseGeometry=false){
  const blocks=await (indexed?indexedDrawableBlocks(archive,model):drawableBlocks(archive,model.streams,model.system));
  const vertices:number[]=[],indices:number[]=[];
  const appearance:AppearanceBuilder={uv:[],spans:[],normals:[],foliage:true,coarseGeometry};
  const identity:Placement={position:[0,0,0],rotation:[0,0,0,1],scale:[1,1]};
  appendDrawable(blocks,model,0,0,identity,identity.position,66,vertices,indices,true,appearance,
    undefined,model.geometryDescriptor??(indexed?indexedDescriptor(blocks.metadata,model):undefined));
  if(!indices.length||!appearance.spans.some(span=>span.texture||span.vertexPalette))throw new Error("Missing vegetation geometry or material.");
  return chunk(model.name,"foliage",identity.position,vertices,indices,appearance);
}

async function loadPropBatch(asset:StreetAsset,resource:ReturnType<typeof drawableBlocks>,
  placement:ReturnType<typeof drawableBlocks>,withMaterials:boolean):Promise<StreetChunk>{
  const [model,{metadata,gpu}]=await Promise.all([resource,placement]);
  const table=view(metadata),at=asset.at;
  if(table.getUint32(0x10,true)!==0x50524430||table.getUint32(at+0x44,true)!==asset.hash)
    throw new Error("Invalid prop batch archetype.");
  const reference=table.getBigUint64(at+0x90,true),block=Number(reference&0xfffffn)-1;
  const count=table.getUint16(at+0x98,true),blockCount=table.getUint16(0x4c,true);
  if(!count||block<0||block>=blockCount)throw new Error("Invalid prop batch reference.");
  const entry=pointer(table,0x38,system,16*blockCount)+16*block;
  const skip=Number(reference>>20n),size=table.getUint32(entry+4,true);
  if(table.getUint32(entry,true)!==0xea6b3a96||skip+count*64>size)
    throw new Error("Invalid prop batch matrix table.");
  const start=pointer(table,entry+8,graphics,size,gpu.byteLength)+skip;
  const origin=instanceOrigin(asset);
  const vertices:number[]=[],indices:number[]=[],appearance:AppearanceBuilder={uv:[],spans:[],normals:[]};
  const identity:Placement={position:[0,0,0],rotation:[0,0,0,1],scale:[1,1]};
  appendDrawable(model,asset.name,0,0,identity,identity.position,66,vertices,indices,
    true,withMaterials?appearance:undefined,asset.parts,asset.geometryDescriptor);
  if(!indices.length)throw new Error("Empty prop drawable.");
  const mesh=chunk(asset.id??asset.name,"prop",origin,vertices,indices,appearance);
  const split=count>32;
  const groups=new Map<string,{poses:number[];ids:string[];bounds:Bounds}>();
  const excluded=new Set(asset.batchSkip);
  for(let i=0;i<count;i++){
    if(excluded.has(i))continue;
    const offset=start+64*i;
    const matrix=Array.from({length:12},(_,j)=>gpu.getFloat32(offset+j*4,true));
    if(!matrix.every(Number.isFinite))continue;
    const [a,b,c,,d,e,f,,g,h,k]=matrix;
    const volume=Math.abs(a*(e*k-f*h)-b*(d*k-f*g)+c*(d*h-e*g));
    if(volume<=.0001||volume>=1000)continue;
    const xyz=[matrix[3],matrix[7],matrix[11]];
    if(!xyz.every((v,axis)=>v>=table.getFloat32(at+0xa0+4*axis,true)-.02&&
      v<=table.getFloat32(at+0xb0+4*axis,true)+.02))continue;
    const local=xyz.map((v,axis)=>v-origin[axis]);
    const tile=split?`${Math.floor(xyz[0]/32)},${Math.floor(xyz[1]/32)}`:"";
    let group=groups.get(tile);
    if(!group){
      group={poses:[],ids:[],bounds:emptyBounds()};
      groups.set(tile,group);
    }
    const {poses,ids,bounds}=group;
    const tint=Array.from({length:4},(_,j)=>gpu.getUint8(offset+0x34+j)/255);
    poses.push(...local,...matrix.slice(0,3),...matrix.slice(4,7),...matrix.slice(8,11),...tint);
    ids.push(`${mesh.id}:${i}`);
    for(let axis=0;axis<3;axis++){
      let lo=local[axis],hi=lo;
      for(let j=0;j<3;j++){
        const v=matrix[axis*4+j],a=v*mesh.bounds[j],b=v*mesh.bounds[j+3];
        lo+=Math.min(a,b);hi+=Math.max(a,b);
      }
      bounds[axis]=Math.min(bounds[axis],lo);
      bounds[axis+3]=Math.max(bounds[axis+3],hi);
    }
  }
  if(!groups.size)throw new Error("No verified prop poses.");
  const bounds=emptyBounds(),tiles:InstanceTile[]=[],ids:string[]=[];
  const poses=new Float32Array([...groups.values()].reduce((sum,group)=>sum+group.poses.length,0));
  for(const group of groups.values()){
    poses.set(group.poses,ids.length*16);
    tiles.push({first:ids.length,count:group.ids.length,bounds:group.bounds});
    for(const id of group.ids)ids.push(id);
    for(let axis=0;axis<3;axis++){
      bounds[axis]=Math.min(bounds[axis],group.bounds[axis]);
      bounds[axis+3]=Math.max(bounds[axis+3],group.bounds[axis+3]);
    }
  }
  return {...mesh,bounds,instances:{poses,ids,affine:true,tiles:tiles.length>1?tiles:undefined}};
}

function loadPlacedShape(asset:StreetAsset,blocks:Awaited<ReturnType<typeof drawableBlocks>>,withMaterials:boolean){
  const vertices:number[]=[],indices:number[]=[],appearance:AppearanceBuilder={uv:[],spans:[],normals:[],
    foliage:asset.kind==="foliage",ordinaryPropLayers:asset.kind==="prop"?true:undefined};
  const identity:Placement={position:[0,0,0],rotation:[0,0,0,1],scale:[1,1]};
  appendDrawable(blocks,asset,0,0,identity,identity.position,66,vertices,indices,true,withMaterials?appearance:undefined,
    asset.parts,asset.geometryDescriptor??(asset.indexed?indexedDescriptor(blocks.metadata,asset):undefined));
  if(!indices.length)throw new Error("Empty instanced drawable.");
  const mesh=chunk(asset.name,asset.kind==="foliage"?"foliage":"prop",identity.position,vertices,indices,appearance);
  mesh.modelName=asset.name;
  return mesh;
}

async function loadPlacedBatch(id:string,assets:StreetAsset[],table:(range:number[])=>Promise<DataView>,mesh:StreetChunk):Promise<StreetChunk>{
  const asset=assets[0],origin=instanceOrigin(asset);
  if(asset.kind==="prop")mesh.drawDistance=Math.max(...assets.map(propDrawDistance));
  const shapeBounds=mesh.bounds;
  const size=[0,1,2].map(axis=>Math.max(Math.abs(shapeBounds[axis]),Math.abs(shapeBounds[axis+3])));
  const bounds=emptyBounds(),poses:number[]=[],ids:string[]=[];
  // Extra draw ranges pay for themselves on triangle-heavy rigid props.
  const tiles:InstanceTile[]|undefined=asset.kind==="prop"&&assets.length>1&&mesh.indices.length>=3000?[]:undefined;
  // The high bit is never set in the authored selector. Use 0xff for rows with no reflected field.
  const tintSelectors=asset.kind==="prop"&&assets.some(row=>row.placement?.tintSelector!==undefined)
    ?new Uint8Array(assets.length).fill(0xff):undefined;
  const propLayerControls=tintSelectors&&mesh.appearance?.spans.some(span=>span.propLayers)
    ?new Uint8Array(assets.length):undefined;
  const propDirtControls=propLayerControls&&mesh.appearance?.spans.some(span=>span.propLayers?.dirt)&&
    assets.every(row=>row.placement?.propDirtControl!==undefined)?new Uint8Array(assets.length):undefined;
  for(const item of assets){
    const {position,rotation,scale,tintSelector,propLayerControl}=item.placement??readPlacement(await table(item.instance),item.at,item.hash);
    const local=position.map((value,axis)=>value-origin[axis]);
    poses.push(...local,...rotation,...scale);
    if(tintSelectors&&tintSelector!==undefined)tintSelectors[ids.length]=tintSelector;
    if(propLayerControls){
      if(propLayerControl===undefined)tintSelectors![ids.length]=0xff;
      else propLayerControls[ids.length]=propLayerControl;
    }
    if(propDirtControls)propDirtControls[ids.length]=item.placement!.propDirtControl!;
    if(tiles){
      const transform=placedVertex({position,rotation,scale},origin),box=emptyBounds();
      for(let corner=0;corner<8;corner++){
        const point=transform(shapeBounds[corner&1?3:0],shapeBounds[corner&2?4:1],shapeBounds[corner&4?5:2]);
        for(let axis=0;axis<3;axis++){
          // Allow for GPU float rounding and the decal's normal offset.
          box[axis]=Math.min(box[axis],point[axis]-.02);
          box[axis+3]=Math.max(box[axis+3],point[axis]+.02);
        }
      }
      tiles.push({first:ids.length,count:1,bounds:box});
    }
    ids.push(item.id??item.name);
    const radius=Math.hypot(size[0]*scale[0],size[1]*scale[0],size[2]*scale[1]);
    for(let axis=0;axis<3;axis++){
      bounds[axis]=Math.min(bounds[axis],local[axis]-radius);
      bounds[axis+3]=Math.max(bounds[axis+3],local[axis]+radius);
    }
  }
  return {...mesh,id,origin,bounds,instances:{poses:Float32Array.from(poses),ids,tiles,tintSelectors,propLayerControls,propDirtControls}};
}

function matchedGroundAtlas(vertices:number[],appearance:AppearanceBuilder){
  const texture=appearance.spans[0]?.texture;
  if(!texture||appearance.spans.some(span=>span.texture!==texture))return;
  for(let at=0;at<vertices.length;at+=4){
    const u=vertices[at]/128,v=1-vertices[at+1]/128;
    if(Math.abs(appearance.uv[at/2]-u)>.00025||Math.abs(appearance.uv[at/2+1]-v)>.00025)return;
  }
  return texture;
}

export async function loadStreetAsset(archive:Archive,asset:StreetAsset,withMaterials:boolean,
  instances:Promise<DataView>|undefined=undefined,
  resource=asset.indexed?indexedDrawableBlocks(archive,asset):drawableBlocks(archive,asset.streams,asset.system)):Promise<StreetChunk>{
  const [placement,blocks]=await Promise.all([asset.placement??(instances??placementTable(archive,asset.instance,asset.indexed))
    .then(table=>readPlacement(table,asset.at,asset.hash)),resource]);
  const vertices:number[]=[],indices:number[]=[];
  const waterHint=asset.kind==="water";
  const water=drawableWaterMaterials(blocks.metadata,asset,waterHint);
  const mixedWater=water!==undefined&&water.binding>=0&&!water.allWater;
  const kind=water?.allWater||waterHint&&(!asset.indexed||!water)?"water":
    asset.kind==="road"||asset.kind==="foliage"||asset.kind==="skyline"?asset.kind:"structure";
  const scum=withMaterials&&water?.allWater&&water.count===1&&scumDrawable.test(asset.name)&&
    view(blocks.metadata).getUint32(water.binding,true)===waterMicroGeometry?
      colorBinding(view(blocks.metadata),water.binding,1):null;
  const appearance:AppearanceBuilder|undefined=scum?{uv:[],spans:[],waterScum:waterScumTexturePrefix+scum}:
    (withMaterials||mixedWater)&&kind!=="water"?
      {uv:[],spans:[],normals:[],mixedWater,foliage:kind==="foliage",road:kind==="road"?[]:undefined,decalOpacity:kind==="road"||kind==="structure"?[]:undefined,decalBlend:kind==="road"||kind==="structure"?[]:undefined}:undefined;
  const aggregate=kind==="skyline"&&(asset.aggregate||districtAggregate.test(asset.name));
  const material=kind==="water"&&!scum?67:kind==="road"?68:kind==="skyline"?(aggregate?75:70):66;
  appendDrawable(blocks,asset,0,0,placement,placement.position,material,vertices,indices,true,appearance,
    asset.parts,asset.geometryDescriptor??(asset.indexed?indexedDescriptor(blocks.metadata,asset):undefined),undefined,withMaterials);
  if(!indices.length)throw new Error("Empty street drawable.");
  const mesh=chunk(asset.id??asset.name,kind,placement.position,vertices,indices,appearance);
  mesh.interior=asset.interior;
  mesh.modelName=asset.name;
  if(asset.localBounds&&rollerDrawable.test(asset.name)){
    const nameRef=drawableNameReference(blocks.metadata,asset);
    if(nameRef>=0)mesh.roller=readStreetRoller(view(blocks.metadata),nameRef-0xa8,placement,asset.localBounds);
  }
  mesh.placementLod=asset.placementLod;
  if(aggregate)mesh.aggregate=true;
  if(asset.collisionRef!==undefined){
    mesh.collision=authoredCollision(view(blocks.metadata),asset.collisionRef,placement);
    const positions=mesh.collision.vertices;
    for(let i=0;i<positions.length;i++) {
      const axis=i%3;
      mesh.bounds[axis]=Math.min(mesh.bounds[axis],positions[i]);
      mesh.bounds[axis+3]=Math.max(mesh.bounds[axis+3],positions[i]);
    }
  }
  return mesh;
}

async function placementTable(archive:Archive,[offset,length,size]:number[],indexed=false){
  const data=view(inflate(await archive.read(offset,length),size));
  if(data.byteLength!==size||!indexed&&data.getUint32(0x10,true)!==0x50524430)
    throw new Error("Invalid gameplay instance resource.");
  return data;
}

function chunk(id:string,kind:StreetChunk["kind"],origin:Vec3,vertices:number[],indices:number[],appearance?:AppearanceBuilder):StreetChunk{
  let left=Infinity,bottom=Infinity,low=Infinity,right=-Infinity,top=-Infinity,high=-Infinity;
  for(let i=0;i<vertices.length;i+=4){
    const x=vertices[i],y=vertices[i+1],z=vertices[i+2];
    left=Math.min(left,x);bottom=Math.min(bottom,y);low=Math.min(low,z);
    right=Math.max(right,x);top=Math.max(top,y);high=Math.max(high,z);
  }
  const bounds:Bounds=[left,bottom,low,right,top,high];
  let normals:Int16Array<ArrayBuffer>|undefined;
  if(appearance?.normals?.length){
    normals=new Int16Array(vertices.length/4*3);
    for(const {first,values} of appearance.normals)normals.set(values,first*3);
  }
  let road:RoadVertices|undefined;
  let terrainColors:Uint8Array<ArrayBuffer>|undefined;
  if(appearance?.terrainColors?.length){
    terrainColors=new Uint8Array(vertices.length);
    for(const {first,values} of appearance.terrainColors)terrainColors.set(values,first*4);
  }
  let terrainTintUV:Float32Array<ArrayBuffer>|undefined;
  if(appearance?.terrainTintUV?.length){
    terrainTintUV=new Float32Array(vertices.length/2);
    for(const {first,values} of appearance.terrainTintUV)terrainTintUV.set(values,first*2);
  }
  let terrainTangents:Int16Array<ArrayBuffer>|undefined;
  if(appearance?.terrainTangents?.length){
    terrainTangents=new Int16Array(vertices.length);
    for(const {first,values} of appearance.terrainTangents)terrainTangents.set(values,first*4);
  }
  if(appearance?.road?.length){
    const count=vertices.length/4;
    road={uv:new Float32Array(count*2),weights:new Uint8Array(count*4)};
    for(const {first,coordinates,weights} of appearance.road){
      road.uv.set(coordinates,first*2);
      road.weights.set(weights,first*4);
    }
  }
  let terrainSecondaryTangents:Int16Array<ArrayBuffer>|undefined;
  if(appearance?.terrainSecondaryTangents?.length){
    terrainSecondaryTangents=new Int16Array(vertices.length);
    for(const {first,values} of appearance.terrainSecondaryTangents)terrainSecondaryTangents.set(values,first*4);
  }
  let decalOpacity:Uint8Array<ArrayBuffer>|undefined;
  if(appearance?.decalOpacity?.length){
    decalOpacity=new Uint8Array(vertices.length/4).fill(255);
    for(const {first,values} of appearance.decalOpacity)decalOpacity.set(values,first);
  }
  let decalBlend:Uint8Array<ArrayBuffer>|undefined;
  if(appearance?.decalBlend?.length||appearance?.parallaxDirtBias?.length){
    decalBlend=new Uint8Array(vertices.length/4);
    for(const {first,values} of appearance.decalBlend??[])decalBlend.set(values,first);
    for(const {first,values} of appearance.parallaxDirtBias??[])decalBlend.set(values,first);
  }
  // Keep the fixed restart index out of compact WebGL2 index buffers.
  const indexFormat=vertices.length<=0xffff*4?Uint16Array:Uint32Array;
  return {id,kind,origin,bounds,vertices:Float32Array.from(vertices),indices:indexFormat.from(indices),normals,terrainColors,terrainTintUV,terrainTangents,terrainSecondaryTangents,road,decalOpacity,decalBlend,
    dynamic:appearance?.dynamic,packedVegetationTint:appearance?.packedVegetationTint,
    appearance:appearance?.spans.some(span=>span.texture||span.vertexPalette||span.water||span.cutout||span.overlay||span.fallback||span.road||span.terrain)
      ?{uv:Float32Array.from(appearance.uv),spans:appearance.spans}:undefined};
}

const system=0x50000000,graphics=0x60000000;
const structureDecals=new Set(["0x388e79a4f59411dd","0x5cc420b2b8f3eb8c"]);
// Standard object decal and dirt passes composite over an opaque base material.
const decalBlendEffect=0xd41ddcc3;
const propDecalBlendEffect=0xc8fd534c;
const layeredPropDecalEffect=0x990e2a3c;
const layeredObjectDecalEffect=0x274d56ce; // standard_2lyr_decal
const retroDecalEffect=0x0b3ca885; // standard_2lyr_retroreflection_decal_blend
const immersedDecalEffect=0x4431c5c3;
const layeredSurfaceDecals=new Set([immersedDecalEffect,0xb637d50d]);
const exteriorGlassEffects=new Set([0x298c4c0f,0x653582a4,0xe3ba3129]);
const luminousSurfaceEffects=new Set([0xfaec4fc8,0x3a09c775,0x3bc8ac60,0x60643f2e]);
const dirtEffect=0x512937b5; // standard_dirt
const clothDirtEffect=0x68e93cdf; // standard_dirt_secmo
const layeredPavementEffect=0x1251cae5; // standard_2lyr_pxm_ground
// Foliage materials also occur on standalone drawables such as planters and driftwood.
const reflectedDiffuseEffects=new Set([0x28d751f1,0x578bb142,0x40be6a4d]);
const surfaceOpacityEffects=new Set([0x0ca0d9a0,0xec8e6107]);
const objectDecalEffects=new Set([
  decalBlendEffect,layeredObjectDecalEffect,0x037206ee,
  0xe0b4c573, // standard_decal
  0xea9cce3a, // standard_pxm_decal
  0x5ee453cc, // standard_decal_ground
]);
const objectDirtEffects=new Set([0xc18881f1,0xaf83d7c6,0x5d3b9bfa,0xcbe2712d]);
// Elevated freeway blocks use the same reflected blend on a standalone drawable.
const elevatedRoadDrawable=/^[a-z][a-z0-9]*_fw_\d+_block_/i;
const layeredGroundEffects=new Set([0x61e09df7,0x0ad54cb9,0x388f8fb6]);
const singleSidedLandscapeEffects=new Set([0x360e396b,0x27e5c49d,0x0ad54cb9,0x76fcff28]);
const mixedProjectedGroundEffect=0x6f968246;
const uv3LandscapeEffect=0x27e5c49d; // standard_uber_4lyr_pxm_hbb_uv3
const spxUV3LandscapeEffect=0x76fcff28; // standard_uber_4lyr_spx_dm_hbb_uv3
const fixedUVLandscapeEffect=0xb21f1ba5; // standard_uber_4lyr_pxm_hbb_fixuv1
const uberGroundEffects=new Set([
  0x4a579bbf, // standard_uber_4lyr_pxm_hbb
  uv3LandscapeEffect,
  fixedUVLandscapeEffect,
  0x61fad45c, // standard_uber_4lyr_dpm_dfm_dm_hbb
  0xf8e1f225, // standard_uber_4lyr_dfm_dm_hbb_uv3
  0x40497278, // standard_uber_4lyr_dpm_dfm_dm_hbb_uv3
]);
const reflectedGroundDecals=new Set([0xde6b843d,0x42c64b5e]);
// These road decals have a readable DiffuseTex and a verified COLOR0 opacity channel.
const roadDiffuseDecals=new Map([
  ["0x64d60e6f640d72cd",0xec8e6107],
  ["0x67285ccaf7a007e1",0x0ca0d9a0],
  ["0xf43aa4d9144dd323",0x0ca0d9a0],
  ["0x2599e2e9ad7685cd",0x70746df0],
]);
function pointer(source:DataView,at:number,base:number,size:number,limit=source.byteLength){
  const address=source.getBigUint64(at,true)-BigInt(base);
  if(address<0n||address+BigInt(size)>BigInt(limit))throw new Error("Invalid tunnel drawable reference.");
  return Number(address);
}

function systemReference(data:DataView,at:number,size:number){
  if(at<0||at+8>data.byteLength)return -1;
  const offset=data.getUint32(at,true)-system;
  return offset>=0&&offset+size<=data.byteLength&&!data.getUint32(at+4,true)?offset:-1;
}

function authoredCollision(data:DataView,reference:number,placement:Placement):NonNullable<StreetChunk["collision"]>{
  const at=pointer(data,reference,system,0xd8);
  const vertexCount=data.getUint32(at+0xd0,true),faceCount=data.getUint32(at+0xd4,true);
  if(data.getUint8(at+0x10)!==4||!vertexCount||vertexCount>0x8000||!faceCount)
    throw new Error("Invalid gameplay collision bound.");
  const polygonStart=pointer(data,at+0x88,system,16*faceCount);
  const vertexStart=pointer(data,at+0xb0,system,6*vertexCount);
  const f=(field:number,axis:number)=>data.getFloat32(at+field+4*axis,true);
  const vertices=new Float32Array(vertexCount*3),indices=new Uint32Array(faceCount*3);
  const bounds=emptyBounds();
  const transform=placedVertex(placement,placement.position);
  for(let i=0;i<vertexCount;i++){
    const local=([0,1,2] as const).map(axis=>{
      const step=f(0x90,axis);
      const value=f(0xa0,axis)+step*data.getInt16(vertexStart+6*i+2*axis,true);
      if(!Number.isFinite(value)||step<=0)throw new Error("Invalid gameplay collision vertex.");
      bounds[axis]=Math.min(bounds[axis],value);
      bounds[axis+3]=Math.max(bounds[axis+3],value);
      return value;
    });
    vertices.set(transform(local[0],local[1],local[2]),3*i);
  }
  for(let axis=0;axis<3;axis++){
    if(!(Math.abs(bounds[axis]-f(0x30,axis))<.002&&Math.abs(bounds[axis+3]-f(0x20,axis))<.002))
      throw new Error("Gameplay collision vertices disagree with their source bounds.");
  }
  for(let i=0;i<faceCount;i++)for(let c=0;c<3;c++){
    const index=data.getUint16(polygonStart+16*i+4+2*c,true)&0x7fff;
    if(index>=vertexCount)throw new Error("Invalid gameplay collision face.");
    indices[3*i+c]=index;
  }
  return {vertices,indices};
}

function colorBinding(data:DataView,material:number,slot=0){
  if(material<0)return null;
  const slots=systemReference(data,material+0x10,8*(slot+1));
  if(slots<0)return null;
  const texture=systemReference(data,slots+slot*8,0x38);
  return textureDescriptorKey(data,texture);
}

function textureDescriptorKey(data:DataView,texture:number){
  if(texture<0)return null;
  const rowPointer=systemReference(data,texture+0x30,16);
  const entry=rowPointer-16;
  if(entry<0||data.getBigUint64(entry,true)!==6n||systemReference(data,entry+16,0)!==entry+5)return null;
  return "0x"+data.getBigUint64(entry+24,true).toString(16).padStart(16,"0");
}

function reflectedColorBinding(data:DataView,material:number,parameter:number,fallback?:number){
  const reflection=systemReference(data,material+0x20,8);
  if(reflection>=0){
    const count=data.getUint8(reflection+1);
    for(let i=0,at=reflection+8;i<count&&at+8<=data.byteLength;i++,at+=8){
      if(data.getUint32(at,true)!==parameter)continue;
      const slot=data.getUint32(at+4,true)/4;
      if(Number.isInteger(slot)&&slot<32)return colorBinding(data,material,slot);
    }
  }
  return fallback===undefined?null:colorBinding(data,material,fallback);
}

function terrainLayers(data:DataView,material:number,vertexWeights:boolean,hasGroundAtlas:boolean,placement:Placement):TerrainLayers|undefined{
  if(material<0)return;
  const effect=data.getUint32(material,true);
  const mixedProjected=effect===mixedProjectedGroundEffect&&hasGroundAtlas;
  const spx=effect===spxUV3LandscapeEffect;
  if(uberGroundEffects.has(effect)||mixedProjected||spx){
    const parameters=systemReference(data,material+0x20,8+17*8);
    if(vertexWeights||parameters<0||data.getUint8(parameters+1)<17)return;
    // These terrain passes bind the same layer layout despite the extra
    // samplers in the uber shader. Require the reflected texture roles.
    for(const [slot,hash] of [[2,0xc075f9b6],[9,0x32b9df09],[12,0xd883aa9e],[13,0x3d10f3b7],[14,0xce7b968e]]){
      const at=parameters+8+slot*8;
      if(data.getUint32(at,true)!==hash||data.getUint32(at+4,true)!==slot*4)return;
    }
  }else if(!layeredGroundEffects.has(effect)||vertexWeights&&effect===0x388f8fb6)return;
  const buffers=systemReference(data,material+8,16);
  const constants=buffers<0?-1:systemReference(data,buffers+8,0x120);
  if(constants<0)return;
  const vec=(offset:number):TerrainLayers["primary"]=>[
    data.getFloat32(constants+offset,true),data.getFloat32(constants+offset+4,true),
    data.getFloat32(constants+offset+8,true),data.getFloat32(constants+offset+12,true),
  ];
  const channels=vec(0x30);
  if(channels.some(value=>value!==0)&&(!mixedProjected||channels.some(value=>value!==0&&value!==1)))return;
  const primary=vec(0),selectors=vec(0x20);
  const [maskUV,maskSampling,tintUV,tintSampling]=vec(0x70);
  const mixedLocal=effect===0x61e09df7&&selectors.includes(2);
  if(mixedLocal&&(vertexWeights||primary.join()!=="1,1,0,0"||maskUV!==1||maskSampling!==0||
    systemReference(data,buffers+8,0x1b0)!==constants||vec(0x150).some(value=>value!==0)||
    vec(0x190).join()!=="1,0,0,0"||vec(0x1a0).join()!=="0,1,1,0"))return;
  // Keep the same sector colors on fixed-UV ground and its mixed-UV neighbors
  // when the strip material belongs to the projected sector layout.
  const sectorStrip=effect===fixedUVLandscapeEffect&&maskUV===1&&maskSampling===1&&tintUV===1&&tintSampling===2;
  const mixedSector=mixedProjected||effect===0x388f8fb6&&(maskUV!==1||selectors.includes(2));
  const localEffect=hasGroundAtlas&&effect===0x388f8fb6&&mixedSector;
  const tintSamplingSupported=tintUV===1&&tintSampling===2;
  const insetUV3=hasGroundAtlas&&(effect===uv3LandscapeEffect||spx)&&maskUV===3&&maskSampling===0&&tintSamplingSupported;
  const [vertexFirst,complexVertexTint]=localEffect?vec(0x160):insetUV3?vec(0x180):[0,0];
  const [sectorWeight,tintAlpha,vertexAlpha]=localEffect?vec(0x170):insetUV3?vec(0x190):[0,0,0];
  const nativeUV3Blend=insetUV3&&sectorWeight===0&&complexVertexTint===0&&
    [vertexFirst,tintAlpha,vertexAlpha].every(value=>value===0||value===1);
  // Untinted SPX materials use the road pass, which supports their parallax.
  if(spx&&(!nativeUV3Blend||vec(0x140).every(value=>value===0)))return;
  const nativeLocalBlend=localEffect&&tintSamplingSupported&&
    (maskUV===3&&maskSampling===0||maskUV===1&&maskSampling===1)&&complexVertexTint===0&&
    [vertexFirst,tintAlpha,vertexAlpha].every(value=>value===0||value===1);
  const nativeBlend=nativeLocalBlend||nativeUV3Blend;
  const projectedDetail=hasGroundAtlas&&(sectorStrip||mixedSector&&!nativeLocalBlend);
  const vertexBlend=!vertexWeights&&((projectedDetail&&mixedSector)||nativeBlend||mixedLocal||effect===0x4a579bbf||effect===0x61fad45c||effect===uv3LandscapeEffect);
  if(vertexWeights){
    // Both tunnel variants share this vertex-weighted local blend.
    const [scaleU,scaleV,offsetU,offsetV]=primary;
    // These tiled layers have either zero offset or a whole number of repeats.
    if(selectors.some(v=>v!==1&&v!==2)||scaleU!==128||scaleV!==128||
      (offsetU!==0||offsetV!==0)&&(offsetU!==128||offsetV!==128)||
      vec(0x10).join()!=="1,1,0,0"||(maskUV!==1&&maskUV!==3)||maskSampling!==0||
      systemReference(data,buffers+8,0x1ac)!==constants||
      vec(0x190).join()!=="1,0,0,0"||vec(0x1a0)[2]!==1)return;
  }else if(vertexBlend){
    // The projected-color pass can also use the material's fixed UV1 mask.
    const fixedMask=(projectedDetail||nativeLocalBlend)&&maskUV===1&&maskSampling===1;
    if(maskSampling!==0&&!fixedMask||(maskUV!==1&&maskUV!==3)||selectors.some(v=>v!==1&&v!==2)||
      vec(0x10).join()!=="1,1,0,0")return;
  }else if(maskUV!==1||selectors.some(v=>v!==1))return;
  const slots=vertexWeights?[14,12,9,13,4,0,5,1]:mixedProjected?[2,14,12,9,13]:[2,14,12,9,13,4,0,5,1];
  const ids=slots.map(slot=>colorBinding(data,material,slot));
  if(!ids.every((value):value is string=>value!==null))return;
  // The DFM/DM material has a shorter constant layout than the fixed-UV PXM effect.
  const tail=nativeLocalBlend?-0x20:0;
  const field=(offset:number)=>vec(offset+tail);
  const heightGain=field(0xf0),heightBias=field(0x100),powers=field(0x110);
  if(![...primary,...heightGain,...heightBias,...powers].every(Number.isFinite)||
    primary[0]<=0||primary[1]<=0)return;
  for(let i=0;i<4;i++)powers[i]=20-19*Math.min(1,Math.max(0,(powers[i]-.2)/.57));
  const textures=ids.map((id,i)=>terrainTexturePrefix+
    (vertexWeights?(i<4?"diffuse":"height"):(i===0?"weights":i<5?"color":"height"))+":"+id);
  const strength=vec(0x60);
  const normalKeys=[15,10,11,7].map(slot=>colorBinding(data,material,slot));
  const normals=strength.some(v=>v>0)&&strength.every(v=>v>=0&&v<=4)&&
    normalKeys.every((key):key is string=>key!==null)
    ?{strength,textures:normalKeys.map(key=>terrainTexturePrefix+"normal:"+key)}:undefined;
  let tint:TerrainLayers["tint"];
  const authoredTint=vertexWeights&&tintSampling===1&&(tintUV===1||tintUV===2||tintUV===3);
  if(!nativeBlend&&!projectedDetail&&(authoredTint||(tintUV===1||effect===uv3LandscapeEffect&&tintUV===3)&&(tintSampling===0||tintSampling===2))&&
    systemReference(data,buffers+8,0x1a8+tail)===constants){
    const amount=field(0x150),mode=field(0x130),scale=field(0x140);
    const maskAlpha=data.getFloat32(constants+0x1a4+tail,true);
    const key=colorBinding(data,material,16);
    if(key&&amount.some(v=>v>0)&&amount.every(v=>v>=0&&v<=1)&&
      mode.every(v=>authoredTint?v>=0&&v<=1:v===0||v===1)&&scale.every(v=>Number.isFinite(v)&&v>=0)&&
      (maskAlpha===0||maskAlpha===1))
      tint={texture:terrainTexturePrefix+"tint:"+key,uv:tintUV===2||tintUV===3?tintUV:undefined,
        inset:tintSampling===2,maskAlpha:maskAlpha===1,mode,scale,amount};
  }
  let vertexTint:TerrainLayers["vertexTint"];
  if(!nativeBlend&&!projectedDetail&&systemReference(data,buffers+8,0x1ac)===constants){
    const [beforeSector,overlay]=field(0x190),maskAlpha=field(0x1a0)[2];
    const mode=field(0x160),scale=field(0x170),amount=field(0x180);
    const sectorMode=field(0x130),sectorAmount=field(0x150);
    if(overlay===0&&(beforeSector===0||beforeSector===1)&&(maskAlpha===0||maskAlpha===1)&&
      mode.every(v=>v===0||v===1)&&scale.every(v=>Number.isFinite(v)&&v>=0)&&
      amount.some(v=>v>0)&&amount.every(v=>v>=0&&v<=1)&&sectorAmount.every(Number.isFinite)){
      const invertAlpha=sectorMode.map((v,i)=>v===0&&sectorAmount[i]>0?1:0) as TerrainLayers["primary"];
      vertexTint={beforeSector:beforeSector===1,maskAlpha:maskAlpha===1,invertAlpha,mode,scale,amount};
    }
  }
  let detail:TerrainLayers["detail"];
  if(nativeBlend){
    const mode=field(0x120),scale=field(0x130),amount=field(0x140);
    const vertexMode=field(0x150),vertexScale=field(0x160),vertexAmount=field(0x170);
    if([...mode,...vertexMode].some(value=>value!==0&&value!==1)||
      [...scale,...vertexScale].some(value=>!Number.isFinite(value)||value<0)||
      [...amount,...vertexAmount].some(value=>!(value>=0&&value<=1)))return;
    if(amount.some(value=>value>0)){
      const key=colorBinding(data,material,16);
      if(!key)return;
      tint={texture:terrainTexturePrefix+"tint:"+key,inset:true,maskAlpha:tintAlpha===1,mode,scale,amount};
    }
    const invertAlpha=mode.map((value,i)=>Number(value===0&&amount[i]>0)) as TerrainLayers["primary"];
    vertexTint={beforeSector:vertexFirst===1,maskAlpha:vertexAlpha===1,invertAlpha,
      mode:vertexMode,scale:vertexScale,amount:vertexAmount};
  }
  if(nativeLocalBlend){
    const slots=systemReference(data,material+0x10,7*8);
    const small=systemReference(data,buffers,0x58);
    if(small>=0&&slots>=0&&data.getBigUint64(slots+6*8,true)===0n&&
      systemReference(data,buffers+8,0x230)===constants){
      const nearestEven=(value:number)=>{
        const lower=Math.floor(value);
        return value-lower===0.5&&lower%2===0?lower:Math.round(value);
      };
      const slices=vec(0x1e0).map(nearestEven);
      const scales=[0x1f0,0x200,0x210,0x220].map(vec);
      const strength=[0,0x1c,0x38,0x54].map((at,i)=>
        scales[i][0]>0||scales[i][1]>0?data.getFloat32(small+at,true):0) as TerrainLayers["primary"];
      const [x,,,y,,,z]=placementMatrix(placement,placement.position),basis=Math.hypot(x,y,z);
      if(Number.isFinite(basis)&&basis>0&&slices.every(slice=>slice>=0&&slice<32)&&
        scales.every(([a,b,u,v])=>[a,b].every(value=>value>=0&&value<=1)&&u>0&&v>0&&Number.isFinite(u*v))&&
        strength.some(value=>value>0)&&strength.every(value=>value>=0&&value<=1)){
        const textures=slices.map(slice=>detailAtlasSlicePrefix+slice) as NonNullable<TerrainLayers["detail"]>["textures"];
        detail={textures,strength,u:scales.map(scale=>scale[2]*basis) as TerrainLayers["primary"],
          v:scales.map(scale=>scale[3]*basis) as TerrainLayers["primary"]};
      }
    }
  }
  if((mixedLocal||vertexWeights)&&!vertexTint||
    vertexWeights&&!tint&&vec(0x150).some(v=>v!==0))return;
  const secondary=selectors.map(value=>value-1) as TerrainLayers["primary"];
  return {textures,primary:vertexWeights?[128,128,0,0]:primary,heightGain,heightBias,powers,tint,vertexTint,normals,
    vertexWeightUV:vertexWeights?secondary:undefined,layerUV:vertexBlend?secondary:undefined,
    projectedDetail:projectedDetail?true:undefined,nativeLocalBlend:nativeBlend?true:undefined,detail,vertexBlend:vertexBlend?true:undefined,maskUV:vertexBlend&&maskUV===3?3:undefined};
}

function twoLayerDecal(data:DataView,material:number,packed:string|null):{primary:string;layers:DecalLayers;retroBlend?:number}|undefined{
  const effect=material>=0?data.getUint32(material,true):0;
  if((reflectedGroundDecals.has(effect)||layeredSurfaceDecals.has(effect))&&data.getUint32(material+4,true)===0x6d657461){
    const parameters=systemReference(data,material+0x20,72);
    if(parameters<0||data.getUint8(parameters)!==1||data.getUint8(parameters+1)<8)return;
    const matches=(slot:number,hash:number)=>data.getUint32(parameters+8+8*slot,true)===hash&&
      data.getUint32(parameters+12+8*slot,true)===4*slot;
    if(layeredSurfaceDecals.has(effect)&&!matches(0,0x4d56d7fe))return;
    if(!matches(7,0x346394ea)||!matches(2,0x7d4f12e2))return;
    const primary=colorBinding(data,material,7),secondary=colorBinding(data,material,2);
    if(primary&&secondary)return {primary,layers:[secondary]};
    return;
  }
  if(material>=0&&data.getUint32(material,true)===retroDecalEffect){
    const control=colorBinding(data,material,11);
    const constants=systemReference(data,material+8,8);
    const c=constants<0?-1:systemReference(data,constants,0x128);
    if(c<0)return;
    const f=(offset:number)=>data.getFloat32(c+offset,true);
    const primary=reflectedColorBinding(data,material,0x346394ea);
    const secondary=reflectedColorBinding(data,material,0x7d4f12e2);
    if(!primary||!secondary||!control)return;
    // Same-coordinate lane paint uses the two diffuse layers and their
    // vertex blend. The material-A block is never a visible paint color.
    if(control==="0xc15d09760dac448e"&&f(0x14)===1&&f(0x100)===1)
      return {primary,layers:[secondary]};
    if(!retroDecalControls.has(control))return;
    if(f(0x14)!==2||[0x48,0x50,0x54,0x74,0x88,0x98].some(offset=>f(offset)!==1)||
      [0x80,0x84,0x8c,0x94,0x9c,0x120,0x124].some(offset=>f(offset)!==0))return;
    const sharpness=f(0x90);
    if(sharpness===Math.fround(.3)||sharpness===Math.fround(.36))
      return {primary,layers:[secondary,control],retroBlend:1/(sharpness*sharpness)};
    return;
  }
  if(material<0||packed!=="0x793537a81856c06a"||data.getUint32(material,true)!==0x4f0b809b)return;
  const reflection=systemReference(data,material+0x20,72);
  if(reflection<0||data.getUint32(reflection+8+2*8,true)!==0x7d4f12e2||
    data.getUint32(reflection+8+7*8,true)!==0x346394ea)return;
  const constants=systemReference(data,material+8,8);
  const c=constants<0?-1:systemReference(data,constants,0x130);
  if(c<0||data.getFloat32(c+0x14,true)!==1||data.getFloat32(c+0x4c,true)!==1||
    data.getFloat32(c+0x50,true)!==1||data.getFloat32(c+0x54,true)!==1||
    data.getFloat32(c+0x7c,true)!==0||data.getFloat32(c+0x80,true)!==0||
    data.getFloat32(c+0x84,true)!==0||data.getFloat32(c+0x88,true)!==1||
    data.getFloat32(c+0x8c,true)!==0||data.getFloat32(c+0x90,true)!==.5||
    data.getFloat32(c+0x9c,true)!==0||data.getFloat32(c+0x128,true)!==0||
    data.getFloat32(c+0x12c,true)!==0)return;
  const primary=colorBinding(data,material,7),secondary=colorBinding(data,material,2);
  if(!primary||!secondary||colorBinding(data,material,11)!==roadDecalControl)return;
  const layers:DecalLayers=[secondary,roadDecalControl];
  return {primary,layers};
}

function sharedDecalDiffuse(data:DataView,material:number,packed:string|null){
  if(material<0||packed!=="0xa783d1d19cba9f92"||data.getUint32(material,true)!==0x274d56ce)return;
  const constants=systemReference(data,material+8,8);
  const c=constants<0?-1:systemReference(data,constants,0x6c);
  if(c<0||[0x14,0x44,0x48,0x4c,0x68].some(offset=>data.getFloat32(c+offset,true)!==1))return;
  const primary=colorBinding(data,material,7);
  if(primary&&primary===colorBinding(data,material,2))return primary;
}

function roadLayers(data:DataView,material:number,ground=false,opaqueWeights=false,elevated=false,
  zeroAuxiliary?:()=>boolean,hasAtlas=false,placement?:Placement):RoadLayers|undefined{
  if(material<0)return;
  const effect=data.getUint32(material,true);
  if(effect!==0x360e396b&&!(ground&&effect===0x76fcff28))return;
  if(elevated){
    const roles=[[2,0xc075f9b6],[9,0x32b9df09],[12,0xd883aa9e],[13,0x3d10f3b7],[14,0xce7b968e]];
    const reflection=systemReference(data,material+0x20,8+15*8);
    if(reflection<0||data.getUint8(reflection+1)<15||!roles.every(([slot,hash])=>
      data.getUint32(reflection+8+slot*8,true)===hash&&data.getUint32(reflection+12+slot*8,true)===slot*4))return;
  }
  const mask=opaqueWeights?null:colorBinding(data,material,2);
  if(!opaqueWeights&&(!mask||!ground&&!readableRoadMasks.has(mask)))return;
  const shaders=[14,12,9,13].map(slot=>colorBinding(data,material,slot));
  if(!shaders.every((id):id is string=>id!==null))return;
  const [red,green,blue,residual]=ground?shaders.map(id=>roadSurfacePrefix+id):shaders;
  const buffers=systemReference(data,material+8,16);
  if(buffers<0)return;
  const constants=systemReference(data,buffers+8,0x120);
  if(constants<0)return;
  const vec=(offset:number)=>[0,4,8,12].map(i=>data.getFloat32(constants+offset+i,true)) as RoadLayers["primary"];
  const projection=vec(0x70).join();
  const sampling=vec(0x90).join();
  // The inset sector tint is already baked into the projected color. Use the
  // authored tiled layers for close-up detail and retain that sector color.
  const projectedUV3=ground&&(effect===0x360e396b&&projection==="3,0,1,1"&&sampling==="1,1,0,0"||
    projection==="3,0,1,2"&&sampling===(effect===0x76fcff28?"3,0,0,0":"1,2,0,0"));
  // Local roads with an active sector tint can use the atlas for paint and
  // the authored four layers for detail. This variant samples its mask on UV0.
  const projectedUV0=ground&&!elevated&&hasAtlas&&effect===0x360e396b&&
    projection==="1,0,1,0"&&sampling==="1,0,0,0"&&systemReference(data,buffers+8,0x1a0)===constants&&
    vec(0x130).every(value=>value===1)&&vec(0x150).every(value=>value===1)&&vec(0x190).join()==="0,1,1,0"&&
    Boolean(colorBinding(data,material,16))&&zeroAuxiliary?.()===true;
  const projectedColor=projectedUV3||projectedUV0;
  const authoredMaskUV3=ground&&effect===0x360e396b&&projection==="3,0,1,0"&&sampling==="1,0,0,0";
  const authoredMaskUV1=ground&&!elevated&&effect===0x360e396b&&projection==="2,0,1,0"&&sampling==="1,0,0,0"&&
    vec(0x80).join()==="1,1,0,0"&&zeroAuxiliary?.()===true;
  const maskUV=opaqueWeights?undefined:authoredMaskUV1?1:projectedUV3||authoredMaskUV3?3:undefined;
  const localVertexColor=projectedUV3&&!elevated&&effect===0x76fcff28&&
    systemReference(data,buffers+8,0x19c)===constants&&vec(0x20).every(value=>value===1)&&
    vec(0x140).every(value=>value===0)&&[0x160,0x170].every(offset=>vec(offset).every(value=>value===1))&&
    data.getFloat32(constants+0x180,true)===1&&data.getFloat32(constants+0x184,true)===0&&zeroAuxiliary?.()===true;
  const authoredHeight=localVertexColor||authoredMaskUV1||authoredMaskUV3&&!elevated&&zeroAuxiliary?.()===true;
  let tint:RoadLayers["tint"];
  if(ground&&effect===0x360e396b&&projection==="1,0,1,1"){
    if(systemReference(data,buffers+8,0x160)!==constants||vec(0x130).some(value=>value!==1))return;
    const key=colorBinding(data,material,16),scale=vec(0x140),amount=vec(0x150);
    if(!key||scale.some(value=>!(value>=0&&value<=4))||amount.some(value=>!(value>=0&&value<=1)))return;
    tint={texture:roadTintPrefix+key,scale,amount};
  }else if(!projectedColor&&!authoredMaskUV3&&!authoredMaskUV1&&projection!=="1,0,1,0")return;
  if(authoredHeight&&!localVertexColor&&systemReference(data,buffers+8,0x19c)===constants&&
    [0x120,0x130,0x150,0x160].every(offset=>vec(offset).every(value=>value===1))&&
    data.getFloat32(constants+0x180,true)===1&&data.getFloat32(constants+0x184,true)===0&&
    data.getFloat32(constants+0x194,true)===1&&data.getFloat32(constants+0x198,true)===0){
    const key=colorBinding(data,material,16),amount=vec(0x140),vertexAmount=vec(0x170);
    if(key&&[...amount,...vertexAmount].every(value=>value>=0&&value<=1))
      tint={texture:roadSurfaceTintPrefix+key,scale:[1,1,1,1],amount,surfaceAlpha:true,vertexAmount};
  }
  let detail:RoadLayers["detail"];
  if(authoredHeight&&placement&&systemReference(data,buffers+8,0x250)===constants&&
    (localVertexColor||authoredMaskUV1||vec(0xc0).every(value=>value===0))){
    const slots=systemReference(data,material+0x10,7*8);
    const small=systemReference(data,buffers,0x58);
    // This effect's empty slot six resolves the shared mapdetail_atlas.
    if(slots>=0&&data.getBigUint64(slots+6*8,true)===0n&&small>=0){
      const slices=vec(0x200);
      const scales=[0x210,0x220,0x230,0x240].map(vec);
      const strength=[0,0x1c,0x38,0x54].map((offset,i)=>
        scales[i][1]>0?data.getFloat32(small+offset,true):0) as RoadLayers["primary"];
      const [x,,,y,,,z]=placementMatrix(placement,placement.position),basis=Math.hypot(x,y,z);
      if(Number.isFinite(basis)&&basis>0&&slices.every(slice=>Number.isInteger(slice)&&slice>=0&&slice<32)&&
        scales.every(([first,second,u,v])=>first===0&&(localVertexColor?second>=0&&second<=1:second===1)&&Number.isFinite(basis*u)&&basis*u>0&&
          Number.isFinite(basis*v)&&basis*v>0)&&strength.every(value=>value>=0&&value<=1)){
        detail={textures:slices.map(slice=>detailAtlasSlicePrefix+slice) as NonNullable<RoadLayers["detail"]>["textures"],
          u:scales.map(scale=>scale[2]*basis) as RoadLayers["primary"],
          v:scales.map(scale=>scale[3]*basis) as RoadLayers["primary"],strength};
      }
    }
  }
  const cutoff=vec(0x100),gain=vec(0xf0);
  let height:RoadLayers["height"];
  if(authoredHeight||cutoff.some(v=>v!==0)||gain.some(v=>v!==1)){
    if(!ground||cutoff.some(v=>!(v>=0&&v<=1))||gain.some(v=>!(v>=0&&v<=8)))return;
    const textures=[4,0,5,1].map((slot,i)=>{
      const key=authoredHeight||cutoff[i]>.01&&gain[i]>0?colorBinding(data,material,slot):null;
      return key?roadHeightPrefix+key:null;
    }) as NonNullable<RoadLayers["height"]>["textures"];
    if(textures.some((key,i)=>(authoredHeight||cutoff[i]>.01&&gain[i]>0)&&!key))return;
    height={textures,gain,cutoff,authored:authoredHeight?true:undefined};
  }
  const mode=effect===0x76fcff28?"3,0,0,0":"1,0,0,0";
  if(!projectedColor&&vec(0x90).join(",")!==mode)return;
  const selectors=vec(0x20);
  if(ground&&(selectors.some(v=>v!==1&&v!==2)||vec(0x30).some(v=>v!==0)))return;
  const primary=vec(0),secondary=vec(0x10),powers=vec(0x110);
  if(![...primary,...secondary,...powers].every(Number.isFinite))return;
  for(let i=0;i<4;i++)powers[i]=20-19*Math.min(1,Math.max(0,(powers[i]-.2)*1.7543859481811523));
  const primaryLayers=ground?selectors.map(value=>Number(value===1)) as RoadLayers["primary"]:undefined;
  const control=localVertexColor&&colorBinding(data,material,3);
  const strength=vec(0xc0),center=vec(0xd0),refine=vec(0xe0);
  const parallax:RoadLayers["parallax"]=control&&[...strength,...center,...refine].every(Number.isFinite)&&
    refine.some(value=>value>0)&&refine.every(value=>value>=0)?
    {texture:roadControlPrefix+control,origin:[0,0],strength,center,refine}:undefined;
  const parameters:Omit<RoadLayers,"textures">={primary,secondary,powers,primaryLayers,height,tint,detail,maskUV,parallax,
    useProjectedColor:projectedColor?true:undefined,localVertexColor:localVertexColor?true:undefined};
  const weightPrefix=elevated?elevatedRoadWeightPrefix:projectedUV0?projectedRoadWeightPrefix:roadWeightPrefix;
  return mask?{textures:[ground?weightPrefix+mask:mask,red,green,blue,residual],...parameters}:
    {textures:[red,green,blue,residual],vertexOnly:true,...parameters};
}

async function drawableBlocks(archive:Archive,streamRanges:number[][],systemBlocks=1){
  const ranges=streamRanges.map(([offset,length]):Range=>[offset,length]);
  const blocks:Uint8Array[]=[];
  for await(const {bytes} of readResources(archive,ranges)){
    const length=streamRanges[blocks.length][2],block=inflate(bytes,length);
    if(block.length!==length)throw new Error("Tunnel drawable stream length mismatch.");
    blocks.push(block);
  }
  const metadata=new Uint8Array(blocks.slice(0,systemBlocks).reduce((n,b)=>n+b.length,0));
  let metadataOffset=0;
  for(const block of blocks.slice(0,systemBlocks)){metadata.set(block,metadataOffset);metadataOffset+=block.length;}
  const streams=blocks.slice(systemBlocks);
  if(streams.length===1)return {metadata,gpu:view(streams[0]),sourceOffset:streamRanges[0][0]};
  const raw=new Uint8Array(streams.reduce((sum,s)=>sum+s.length,0));
  let start=0;
  for(const stream of streams){raw.set(stream,start);start+=stream.length;}
  return {metadata,gpu:view(raw),sourceOffset:streamRanges[0][0]};
}

type DrawableReference=Pick<StreetAsset,"streams"|"system"|"name"|"drawable"|"indexed"|"geometryDescriptor"|"graphicsRange">;
type DrawableName=string|Pick<DrawableReference,"name"|"drawable"|"indexed"|"geometryDescriptor">;
function indexedRootShape(drawable:string|Pick<DrawableReference,"drawable"|"indexed"|"geometryDescriptor">){
  return typeof drawable!=="string"&&drawable.indexed===true&&drawable.drawable===undefined&&drawable.geometryDescriptor===undefined;
}
const indexedHeaders=new WeakMap<Archive,Map<number,Promise<Uint8Array<ArrayBuffer>>>>();
function indexedMetadata(archive:Archive,model:DrawableReference){
  let headers=indexedHeaders.get(archive);
  if(!headers)indexedHeaders.set(archive,headers=new Map());
  const key=model.streams[0][0];
  let metadata=headers.get(key);
  headers.delete(key);
  if(!metadata)metadata=drawableBlocks(archive,model.streams.slice(0,model.system),model.system).then(blocks=>blocks.metadata);
  headers.set(key,metadata);
  if(headers.size>64)headers.delete(headers.keys().next().value!);
  return metadata;
}

type DrawableCache={entries:Map<number,Promise<Awaited<ReturnType<typeof drawableBlocks>>>>;
  sizes:Map<number,number>;bytes:number};
const indexedResources=new WeakMap<Archive,DrawableCache>();
function indexedDrawableBlocks(archive:Archive,model:DrawableReference){
  let cache=indexedResources.get(archive);
  if(!cache)indexedResources.set(archive,cache={entries:new Map(),sizes:new Map(),bytes:0});
  const store=cache,sourceOffset=model.streams[0][0];
  const previous=store.entries.get(sourceOffset);
  if(previous){
    store.entries.delete(sourceOffset);store.entries.set(sourceOffset,previous);
    return previous;
  }
  const read=(async()=>{
    const [offset,length]=model.streams[model.system-1];
    let [metadata,{pages,end}]=await Promise.all([
      indexedMetadata(archive,model),
      streetGraphicsPages(archive,Math.ceil((offset+length)/16)*16,model.graphicsRange),
    ]);
    function extendMetadata(last:number,size:number){
      const candidate=new Uint8Array(size);
      candidate.set(metadata);
      let at=metadata.length;
      for(let page=0;page<=last;page++){
        candidate.set(pages[page],at);
        at+=pages[page].length;
      }
      return candidate;
    }
    // Grouped drawables can have a small system continuation before the first
    // geometry page, even when the requested model descriptor fits in the root.
    let systemSize=metadata.length;
    for(let i=1;i<pages.length&&systemSize+pages[i-1].length<=2*1024*1024;i++){
      systemSize+=pages[i-1].length;
      if(startsWithPositions(pages[0])||!startsWithPositions(pages[i]))continue;
      const candidate=extendMetadata(i-1,systemSize);
      if(!matchesIndexedGraphics(candidate,model,pages.slice(i)))continue;
      metadata=candidate;
      pages.splice(0,i);
      break;
    }
    // Some roots already contain the drawable name, but their primary
    // model list starts on a following system page.
    const ref=drawableNameReference(metadata,model);
    const data=view(metadata);
    const lod=ref<0?-1:data.getUint32(ref-0x58,true)-system;
    if(lod>=metadata.length&&lod<2*1024*1024&&!data.getUint32(ref-0x54,true)){
      let size=metadata.length;
      for(let i=0;i<pages.length-1&&size+pages[i].length<=2*1024*1024;i++){
        size+=pages[i].length;
        if(size<lod+12)continue;
        const candidate=extendMetadata(i,size);
        if(model.drawable===undefined?indexedDescriptor(candidate,model)===undefined:!indexedPartGroup(view(candidate),ref))continue;
        metadata=candidate;
        pages.splice(0,i+1);
        break;
      }
    }
    const lengthBeforeTail=pages.reduce((sum,page)=>sum+page.length,0);
    if(lengthBeforeTail%65536===0){
      const tail=await indexedRawMeshletTail(archive,end,metadata,model,lengthBeforeTail);
      if(tail)pages.push(tail);
    }
    const raw=pages.length===1?pages[0]:new Uint8Array(pages.reduce((sum,page)=>sum+page.length,0));
    if(pages.length!==1){
      let at=0;
      for(const page of pages){raw.set(page,at);at+=page.length;}
    }
    const size=metadata.byteLength+raw.byteLength;
    store.sizes.set(sourceOffset,size);store.bytes+=size;
    while(store.bytes>streetBudgets.drawableBytes||store.entries.size>streetBudgets.drawableCount){
      const oldest=[...store.entries.keys()].find(key=>store.sizes.has(key));
      if(oldest===undefined)break;
      store.bytes-=store.sizes.get(oldest)!;store.sizes.delete(oldest);store.entries.delete(oldest);
    }
    return {metadata,gpu:view(raw),sourceOffset};
  })().catch(error=>{store.entries.delete(sourceOffset);throw error;});
  store.entries.set(sourceOffset,read);
  return read;
}

const drawableReferences=new WeakMap<Uint8Array,{source:string;offsets:Map<number,number>}>();
function drawableNameReference(metadata:Uint8Array,drawable:DrawableName){
  if(typeof drawable!=="string"&&drawable.drawable!==undefined){
    const offset=drawable.drawable;
    return Number.isSafeInteger(offset)&&offset>=0&&offset+0x70<=metadata.length?offset+0xa8:-1;
  }
  const name=typeof drawable==="string"?drawable:drawable.name;
  let references=drawableReferences.get(metadata);
  if(!references){
    const data=view(metadata),source=text.decode(metadata);
    const offsets=new Map<number,number>();
    for(let ref=0x98;ref+8<=data.byteLength;ref+=8){
      const offset=data.getUint32(ref,true)-system;
      if(offset>=0&&offset<data.byteLength&&!data.getUint32(ref+4,true)&&!offsets.has(offset))
        offsets.set(offset,ref);
    }
    references={source,offsets};
    drawableReferences.set(metadata,references);
  }
  return references.offsets.get(references.source.indexOf(`${name}.#dr\0`))??-1;
}

const scumDrawable=/(?:^|_)scum(?:_|$)/i;
const waterMicroGeometry=0x7f3a6aa9;
const authoredWaterEffects=new Set([waterMicroGeometry,0x97596162,0x735d2de6,0x27a48605]);

function drawableWaterMaterials(metadata:Uint8Array,drawable:DrawableName,inspectMixed:boolean){
  const reference=drawableNameReference(metadata,drawable);
  if(reference<0)return;
  const data=view(metadata),materials=systemReference(data,reference-0x98,28);
  if(materials<0)return;
  const count=data.getUint16(materials+24,true);
  if(!count||count>512||count>1&&!inspectMixed)return;
  const slots=systemReference(data,materials+16,count*8);
  if(slots<0)return;
  let binding=-1,matched=0;
  for(let i=0;i<count;i++){
    const slot=systemReference(data,slots+i*8,8);
    if(slot<0)return;
    if(authoredWaterEffects.has(data.getUint32(slot,true))){
      if(binding<0)binding=slot;
      matched++;
    }
  }
  // Water-named stations, pipes and decals can use ordinary surface effects.
  return {binding,count,allWater:matched===count};
}

function indexedDescriptor(metadata:Uint8Array,drawable:DrawableName){
  const ref=drawableNameReference(metadata,drawable);
  if(ref<0)return;
  const data=view(metadata);
  const lod=systemReference(data,ref-0x58,12);
  const list=systemReference(data,lod,8);
  const model=systemReference(data,list,40);
  const materials=systemReference(data,ref-0x98,28);
  if(lod<0||model<0||materials<0)return;
  try{
    descriptorParts(data,model+8,data.getUint16(materials+24,true));
    return model+8;
  }catch{return;}
}

function startsWithPositions(page:Uint8Array){
  if(page.length<16)return false;
  const data=view(page),magic=data.getUint32(0,true),channel=data.getUint8(8);
  return magic===0x4042&&(channel===0x21||channel===0x27||channel===0&&data.getUint8(4)===0x26)||
    magic===0x3063&&channel===0x63;
}

async function indexedRawMeshletTail(archive:Archive,offset:number,metadata:Uint8Array,
  drawable:DrawableReference,graphicsLength:number){
  const end=drawable.graphicsRange?.end??archive.file.size;
  if(offset+28>end)return;
  const data=view(metadata),ref=drawableNameReference(metadata,drawable);
  const descriptor=indexedDescriptor(metadata,drawable);
  const materials=systemReference(data,ref-0x98,28);
  const parts=drawable.drawable!==undefined?indexedPartGroup(data,ref)?.parts:
    descriptor!==undefined&&materials>=0?descriptorParts(data,descriptor,data.getUint16(materials+24,true)):undefined;
  if(!parts?.some(part=>{
    const [,index]=partStreamReferences(data,part);
    return data.getBigUint64(index,true)===BigInt(graphics+graphicsLength);
  }))return;
  // Some large pages end with a small meshlet table stored without zlib.
  // Read it only when the model explicitly points at the end of the decoded pages.
  const head=view(await archive.read(offset,28));
  const flags=head.getUint32(0,true),triangles=head.getUint32(4,true),remaps=head.getUint32(8,true);
  if(!hasMeshletTable(flags)||(flags&65535)!==1||!triangles||triangles>126||
    remaps<3||remaps>128||head.getUint32(16,true)!==0)return;
  const bytes=28+4*triangles+2*remaps;
  return offset+bytes<=end?archive.read(offset,bytes):undefined;
}

function matchesIndexedGraphics(metadata:Uint8Array,drawable:DrawableName,pages:Uint8Array[]){
  const data=view(metadata);
  function graphicsWord(ref:number){
    let offset=data.getUint32(ref,true)-graphics;
    if(offset<0||data.getUint32(ref+4,true))return -1;
    for(const page of pages){
      if(offset<page.length)return offset+4<=page.length?view(page).getUint32(offset,true):-1;
      offset-=page.length;
    }
    return -1;
  }
  try{
    let part:number|undefined;
    if(typeof drawable!=="string"&&drawable.drawable!==undefined){
      part=indexedPartGroup(data,drawableNameReference(metadata,drawable))?.parts[0];
    }else{
      const descriptor=indexedDescriptor(metadata,drawable);
      if(descriptor!==undefined)part=pointer(data,pointer(data,descriptor,system,8),system,0x48);
    }
    if(part===undefined)return false;
    const [vertex,index]=partStreamReferences(data,part);
    const magic=graphicsWord(vertex),meshlets=graphicsWord(index);
    return (magic===0x4042||magic===0x3063)&&hasMeshletTable(meshlets)&&(meshlets&65535)>0;
  }catch{return false;}
}

function partStreamReferences(data:DataView,part:number):[number,number]{
  if(!data.getUint32(part+0x44,true)&&data.getUint32(part+0x40,true)>=system){
    const vertices=pointer(data,part+8,system,32);
    const meshlets=pointer(data,part+0x40,system,8);
    const indices=pointer(data,meshlets,system,32);
    return [vertices+0x18,indices+0x18];
  }
  const list=pointer(data,part+8,system,8);
  const vertices=pointer(data,list,system,0x70);
  const object=pointer(data,part+0x18,system,0x28);
  const indices=pointer(data,object+0x20,system,32);
  return [vertices+0x68,indices+0x18];
}

function materialOrdinals(data:DataView,descriptor:number,parts:number[],materialCount:number){
  if(descriptor<0||descriptor+32>data.byteLength)return [];
  const count=data.getUint16(descriptor+8,true);
  if(!count||count>parts.length||data.getUint16(descriptor+10,true)!==count)return [];
  try{
    const geometry=pointer(data,descriptor,system,count*8);
    const slots=pointer(data,descriptor+24,system,count*2);
    const ordinals:number[]=[];
    for(let part=0;part<count;part++){
      if(data.getBigUint64(geometry+part*8,true)!==BigInt(system+parts[part]))return [];
      const ordinal=data.getUint16(slots+part*2,true);
      if(ordinal>=materialCount)return [];
      ordinals.push(ordinal);
    }
    return ordinals;
  }catch{return [];}
}

function descriptorParts(data:DataView,descriptor:number,materials:number,fileDrawable=false){
  if(descriptor<0||descriptor+32>data.byteLength)throw new Error("Invalid gameplay geometry descriptor.");
  const count=data.getUint16(descriptor+8,true);
  const auxiliary=data.getUint16(descriptor+14,true);
  if(!count||count>512||data.getUint16(descriptor+10,true)!==count||
    auxiliary!==count&&!(fileDrawable&&auxiliary===0))
    throw new Error("Invalid gameplay geometry descriptor count.");
  const geometry=pointer(data,descriptor,system,count*8);
  const parts=Array.from({length:count},(_,i)=>pointer(data,geometry+i*8,system,0x48));
  if(materialOrdinals(data,descriptor,parts,materials).length!==count)
    throw new Error("Invalid gameplay geometry material slots.");
  return parts;
}

function indexedPartGroup(data:DataView,reference:number,coarse=false){
  const shader=systemReference(data,reference-0x98,28);
  if(shader<0)return;
  const materials=data.getUint16(shader+24,true);
  for(let level=0;level<4;level++){
    const detail=coarse?3-level:level;
    const lod=systemReference(data,reference-0x58+8*detail,12);
    if(lod<0)continue;
    const count=data.getUint16(lod+8,true);
    if(!count||count>64||data.getUint16(lod+10,true)!==count)continue;
    const list=systemReference(data,lod,count*8);
    if(list<0)continue;
    const parts:number[]=[],ordinals:number[]=[];
    try{
      for(let i=0;i<count;i++){
        const descriptor=pointer(data,list+i*8,system,40)+8;
        const group=descriptorParts(data,descriptor,materials,true);
        parts.push(...group);
        ordinals.push(...materialOrdinals(data,descriptor,group,materials));
      }
      if(parts.length<=512)return {parts,ordinals};
    }catch{ /* Try the next authored level when the higher descriptor is incomplete. */ }
  }
}

function implicitMaterialOrdinals(data:DataView,reference:number,list:number,pieceCount:number,materialCount:number){
  const lod=systemReference(data,reference-0x58,12);
  if(lod<0||data.getUint16(lod+8,true)!==1||data.getUint16(lod+10,true)!==1)return [];
  const models=systemReference(data,lod,8);
  const model=systemReference(data,models,40);
  if(model<0||data.getUint16(model+16,true)!==pieceCount)return [];
  // Older profiles omit the geometry descriptor. Use its slots after verifying
  // that the primary model lists the same parts in the same order.
  const parts=Array.from({length:pieceCount},(_,part)=>systemReference(data,list+8*part,0x48));
  if(parts.some(part=>part<0))return [];
  return materialOrdinals(data,model+8,parts,materialCount);
}

function appendDrawable({metadata,gpu}:Awaited<ReturnType<typeof drawableBlocks>>,drawable:DrawableName,
  expectedCount:number,pieceCount:number,placement:Placement,origin:Vec3,material:number,
  vertices:number[],indices:number[],singleMaterial=false,appearance?:AppearanceBuilder,geometryParts?:number[],
  geometryDescriptor?:number,ground?:boolean,withColors=true,groundFallback?:string){
  const data=view(metadata);
  const ref=drawableNameReference(metadata,drawable);
  if(ref<0)throw new Error("Tunnel drawable name reference is missing.");
  const model=pointer(data,ref-0x98,system,28),count=data.getUint16(model+24,true);
  // The LOD list can hold several material-bearing models at one detail
  // level. The first descriptor alone describes only one piece of the group.
  const authored=!geometryParts&&(appearance?.coarseGeometry||indexedRootShape(drawable)||
    typeof drawable!=="string"&&drawable.drawable!==undefined)?
    indexedPartGroup(data,ref,appearance?.coarseGeometry):undefined;
  if(authored)geometryParts=authored.parts;
  else if(!geometryParts&&geometryDescriptor!==undefined)geometryParts=descriptorParts(data,geometryDescriptor,count);
  if(!pieceCount)pieceCount=geometryParts?.length??data.getUint16(model+26,true);
  if(!count||count>512||!pieceCount||pieceCount>512)throw new Error("Invalid street drawable part count.");
  const rows=pointer(data,model+16,system,(count+(geometryParts?0:pieceCount))*8);
  const pieces=rows+count*8;
  const ordinals=!appearance?[]:authored?authored.ordinals:geometryParts
    ?geometryDescriptor===undefined?[]:materialOrdinals(data,geometryDescriptor,geometryParts,count)
    :implicitMaterialOrdinals(data,ref,pieces,pieceCount,count);
  if(expectedCount&&count!==expectedCount)throw new Error("Unexpected street drawable part count.");
  const hasRoadMaterials=ground===undefined&&Boolean(appearance?.road);
  for(let piece=0;piece<pieceCount;piece++){
    const entry=pieces+8*piece;
    if(!geometryParts&&data.getBigUint64(entry,true)===0n)continue;
    const part=geometryParts?.[piece]??pointer(data,entry,system,0x48);
    const [vertexRef,indexRef]=partStreamReferences(data,part);
    const v=pointer(data,vertexRef,graphics,0x80,gpu.byteLength);
    const i=pointer(data,indexRef,graphics,12,gpu.byteLength);
    const first=indices.length,base=vertices.length/4;
    const ordinal=ordinals[piece]??(geometryParts?undefined:piece);
    const binding=!appearance||ordinal===undefined||ordinal>=count?-1:systemReference(data,rows+ordinal*8,61);
    const effect=binding<0?0:data.getUint32(binding,true);
    const waterPart=appearance?.mixedWater&&authoredWaterEffects.has(effect);
    const surface=material===66&&ground===undefined&&exteriorGlassEffects.has(effect)?77:
      material===66&&ground===undefined&&luminousSurfaceEffects.has(effect)?78:material+(singleMaterial?0:piece);
    appendGeometry(gpu,v,i,waterPart?67:surface,placement,origin,vertices,indices);
    if(appearance){
      const vertexCount=vertices.length/4-base;
      if(waterPart){
        for(let j=0;j<vertexCount;j++)appearance.uv.push(0,0);
        appearance.spans.push({first,count:indices.length-first,texture:null,water:true});
        continue;
      }
      if(appearance.waterScum){
        // These authored scum meshes use slot one's RGBA texture to fade
        // across the footprint. Drawing the whole footprint creates pools.
        const coordinates=materialUVCoordinates(gpu,v,vertexCount,0x0c);
        for(let j=0;j<vertexCount*2;j++)appearance.uv.push(coordinates?.[j]??0);
        appearance.spans.push({first,count:indices.length-first,
          texture:coordinates?appearance.waterScum:null,overlay:true});
        continue;
      }
      const normals=appearance.normals&&normalStream(gpu,v,vertexCount,placement);
      if(normals)appearance.normals?.push({first:base,values:normals});
      const bucket=binding<0?0:data.getUint8(binding+57);
      if(withColors&&ground===false&&effect===fixedUVLandscapeEffect&&bucket===0&&ordinal!==undefined&&groundFallback&&normals){
        const name=typeof drawable==="string"?drawable:drawable.name;
        if(appendSectorTerrainPage(data,gpu,binding,v,base,vertexCount,origin,vertices,indices,first,appearance,
          name,ordinal,part,groundFallback,normals,placement))continue;
      }
      if(withColors&&ground===false&&effect===0x61e09df7&&bucket===0&&ordinal!==undefined){
        const name=typeof drawable==="string"?drawable:drawable.name;
        const flatNormals=!placement.linear&&placement.scale[0]===placement.scale[1]?normals:undefined;
        if(appendDynamicTerrain(data,gpu,binding,v,base,vertexCount,origin,vertices,indices,first,appearance,
          name,ordinal,part,groundFallback,flatNormals,placement))continue;
      }
      let uv=uvStream(gpu,v,vertexCount);
      // prop_batch_slod can resolve opaque diffuse entirely from COLOR0.
      if(withColors&&appearance.foliage&&!uv&&effect===0x6585e65d&&bucket===128){
        const palette=vertexPaletteColors(data,gpu,model,binding,v,vertexCount);
        if(palette){
          for(let j=0;j<vertexCount;j++){
            vertices[(base+j)*4+3]=nativePaletteMaterial;
            appearance.uv.push(0,0);
          }
          (appearance.terrainColors??=[]).push({first:base,values:palette});
          appearance.spans.push({first,count:indices.length-first,texture:null,vertexPalette:true});
          continue;
        }
      }
      const reflectedDiffuse=binding>=0&&(appearance.foliage||reflectedDiffuseEffects.has(effect));
      let texture=withColors&&uv
        ?reflectedDiffuse?reflectedColorBinding(data,binding,0xc8e8c282,0):colorBinding(data,binding)
        :null;
      if(texture&&material===66&&ground===undefined&&!appearance.foliage&&effect===0xbcf03fc1&&bucket===0&&
        placement.tintSelector!==undefined&&reflectedColorBinding(data,binding,0xc8e8c282)===texture){
        const table=systemReference(data,binding+8,8),constants=table<0?-1:systemReference(data,table,0xa0);
        // This standard permutation mixes palette RGB by diffuse alpha.
        // Its secondary material tint is disabled.
        if(constants>=0&&data.getFloat32(constants+0x98,true)===1&&data.getFloat32(constants+0x9c,true)===0){
          const values=vertexPaletteColors(data,gpu,model,binding,v,vertexCount,placement.tintSelector);
          if(values?.every((value,i)=>i%4!==3||value===255)&&values.some(value=>value!==255)){
            for(let j=0;j<vertexCount;j++)vertices[(base+j)*4+3]=standardPaletteMaterial;
            (appearance.terrainColors??=[]).push({first:base,values});
          }
        }
      }
      // grass_batch and grass_batch_wind pass a separate packed RGB tint to the diffuse pass.
      if(texture&&appearance.foliage&&bucket===131&&(effect===0x10d73576||effect===0x3b0cbedb)){
        const tintStrengthOffset=effect===0x10d73576?0x80:0xbc;
        const buffers=systemReference(data,binding+8,8);
        const constants=systemReference(data,buffers,tintStrengthOffset+4);
        const strength=constants<0?0:data.getFloat32(constants+tintStrengthOffset,true);
        const weights=strength>0&&strength<=1?colorChannel(gpu,v,vertexCount,0x30,0):undefined;
        if(weights){
          const tint=new Float32Array(vertexCount*2);
          for(let j=0;j<vertexCount;j++){
            vertices[(base+j)*4+3]=nativePackedTintMaterial;
            tint[j*2]=weights[j]/255;
            tint[j*2+1]=strength;
          }
          (appearance.terrainTintUV??=[]).push({first:base,values:tint});
          appearance.packedVegetationTint=true;
        }
      }
      // The caustics-only variant shares a neutral placeholder between its
      // layers. Its animated detail maps are not the receiver's paint.
      const causticsOnly=bucket===2&&effect===0x617b869f&&texture==="0xaa3eeff23a15dc75"&&
        reflectedColorBinding(data,binding,0x2bb2ede8)===texture;
      if(causticsOnly)texture=null;
      const primaryUV=uvStream(gpu,v,vertexCount,0x0c);
      const staticParallax=effect===0xb217b263;
      const layeredPavement=ground===false&&effect===layeredPavementEffect;
      const staticMaterial=withColors&&singleMaterial&&texture&&bucket===0&&
        (material===66&&ground===undefined&&(effect===0x77d8ab27||staticParallax)||layeredPavement)&&
        staticMaterialLayers(data,gpu,model,binding,v,vertexCount,base,appearance,placement,staticParallax,layeredPavement)||undefined;
      const staticLayers=staticMaterial?.layers;
      if(staticMaterial)uv=staticMaterial.uv;
      if(staticLayers?.normals&&normals){
        const tangent=terrainTangentStream(gpu,v,vertexCount,placement);
        if(tangent)(appearance.terrainTangents??=[]).push({first:base,values:tangent});
      }
      const surfacePalette=withColors&&material===66&&ground===undefined&&texture&&primaryUV&&bucket===0&&
        (effect===dirtEffect||effect===clothDirtEffect)&&
        readDirtPalette(data,gpu,model,binding,v,vertexCount,base,appearance,placement.tintSelector,effect===clothDirtEffect)||undefined;
      if(surfacePalette)uv=primaryUV;
      const room=withColors&&singleMaterial&&material===66&&ground===undefined&&texture&&normals&&
        effect===0x281e9287&&bucket===0&&
        readRoomMaterial(data,gpu,model,binding,v,vertexCount,base,appearance,placement,normals)||undefined;
      const layeredPropDecal=effect===layeredPropDecalEffect&&bucket===130;
      const parallax=effect===0xf4e49239&&bucket===128;
      const parallaxTangent=parallax&&normals?terrainTangentStream(gpu,v,vertexCount,placement):undefined;
      const propLayers=appearance.ordinaryPropLayers&&primaryUV&&
        (effect===0x89c8fe07&&bucket===128||layeredPropDecal||parallaxTangent)&&
        propMaterialLayers(data,gpu,model,binding,v,vertexCount,base,appearance,layeredPropDecal,parallax)||undefined;
      if(propLayers){
        uv=primaryUV;
        if(parallaxTangent)(appearance.terrainTangents??=[]).push({first:base,values:parallaxTangent});
      }
      const propDecal=appearance.ordinaryPropLayers&&effect===propDecalBlendEffect&&bucket===130&&primaryUV&&texture&&
        texture===reflectedColorBinding(data,binding,0xc8e8c282)&&
        propDecalPaletteIsOpaque(data,gpu,model,binding,v,vertexCount);
      // This permutation starts with Layer 1's packed material, which cannot
      // supply the visible decal color while the full blend is unavailable.
      const propDecalDiffuse=appearance.ordinaryPropLayers&&layeredPropDecal&&primaryUV&&
        reflectedColorBinding(data,binding,0x346394ea);
      if(propDecalDiffuse)texture=propDecalDiffuse;
      if(propDecal||propDecalDiffuse)uv=primaryUV;
      const immersedColor=bucket===2&&effect===immersedDecalEffect&&texture==="0xaa3eeff23a15dc75"&&
        reflectedColorBinding(data,binding,0x346394ea);
      const immersedDecal=Boolean(immersedColor&&primaryUV&&reflectedColorBinding(data,binding,0x7d4f12e2)===immersedColor);
      const surfaceDecalBlend=immersedDecal&&material===66&&ground===undefined&&!appearance.ordinaryPropLayers
        ?readSurfaceDecalBlend(data,gpu,binding,v,vertexCount,base,appearance,placement):undefined;
      if(immersedDecal&&immersedColor&&primaryUV){
        // The two color inputs alias the same translucent wear layer. Slot
        // zero is a neutral material input, not the base receiver's paint.
        texture=immersedColor;
        uv=primaryUV;
      }
      // This default diffuse aliases a 4×4 black texture. The actual dirt
      // detail is the second diffuse input and has separate coordinates.
      if(effect===dirtEffect&&texture==="0xb2ea5adfc7f6634f"){
        const detail=reflectedColorBinding(data,binding,0x0df47048);
        const detailUV=detail&&uvStream(gpu,v,vertexCount,0x10);
        if(detailUV){texture=detail;uv=detailUV;}
      }
      const shared=appearance.decalOpacity&&bucket===2?sharedDecalDiffuse(data,binding,texture):undefined;
      // Slot zero in this decal is a packed layer input. Its BodyTex is the
      // color source when present, while the opaque base draws underneath.
      if(texture&&ground===undefined&&bucket===2&&effect===layeredObjectDecalEffect)
        texture=reflectedColorBinding(data,binding,0x346394ea);
      const sharedUV=shared?uvStream(gpu,v,vertexCount,0x0c):null;
      let terrain=withColors&&bucket===0&&primaryUV&&ground!==true
        ?terrainLayers(data,binding,ground===undefined&&effect!==uv3LandscapeEffect,Boolean(groundFallback),placement):undefined;
      const terrainChannels=terrain?.vertexWeightUV||terrain?.vertexBlend?materialVertexChannels(gpu,v,vertexCount):undefined;
      const tintCoordinates=terrain?.tint?.uv===3||terrain?.maskUV===3?materialUVCoordinates(gpu,v,vertexCount,0x38):undefined;
      if(terrain?.vertexBlend&&(!terrainChannels||terrain.maskUV===3&&!tintCoordinates))terrain=undefined;
      if(terrain?.nativeLocalBlend){
        const auxiliary=packedVertexColor(gpu,v,vertexCount,0x34);
        if(!terrainChannels||auxiliary===undefined||packedVertexColor(gpu,v,vertexCount,4)===undefined||
          terrainChannels.weights.some((_,i)=>i%4===2&&gpu.getUint8(auxiliary+i)>=16)){
          terrain.nativeLocalBlend=undefined;terrain.projectedDetail=true;
          terrain.tint=undefined;terrain.vertexTint=undefined;terrain.detail=undefined;
        }
      }
      if(terrain?.vertexBlend&&effect===0x61e09df7){
        // This local layout blends COLOR1 with the mask. A nonzero auxiliary
        // weight would introduce another layer that the four local bindings lack.
        const extra=packedVertexColor(gpu,v,vertexCount,0x34);
        if(!terrainChannels||extra===undefined||packedVertexColor(gpu,v,vertexCount,4)===undefined||
          terrainChannels.weights.some((_,i)=>i%4===2&&gpu.getUint8(extra+i)>=16))terrain=undefined;
      }
      if(terrain?.vertexWeightUV){
        const extra=packedVertexColor(gpu,v,vertexCount,0x34);
        // Opaque COLOR1 makes the texture mask inert. Auxiliary projection uses the high blue nibble.
        if(!terrainChannels||extra===undefined||packedVertexColor(gpu,v,vertexCount,4)===undefined||
          terrain.tint?.uv===3&&!tintCoordinates||
          terrainChannels.weights.some((alpha,i)=>(i%4===3&&alpha!==255)||
            (i%4===2&&gpu.getUint8(extra+i)>=16)))terrain=undefined;
      }
      if(terrain?.nativeLocalBlend){
        for(let i=1;i<5;i++)terrain.textures[i]=terrain.textures[i].replace(":color:",":native-color:");
      }
      if(terrain){
        uv=primaryUV;
      }
      // A rejected layer layout can still use the authored coarse terrain atlas.
      // Slot zero is a height channel on these effects.
      if(ground!==true&&bucket===0&&(layeredGroundEffects.has(effect)||terrain?.projectedDetail))texture=null;
      // The uber blend has a different parameter layout and a packed slot zero.
      if(bucket===0&&(ground===false&&uberGroundEffects.has(effect)||ground===undefined&&effect===uv3LandscapeEffect))texture=null;
      // Slot zero is Lyr1MaterialATex in these passes. The packed
      // roughness and cavity data must never cover the receiver as color.
      const layeredSurface=ground===undefined&&bucket===2&&layeredSurfaceDecals.has(effect)&&
        texture!==null&&reflectedColorBinding(data,binding,0x4d56d7fe)===texture;
      const reflectedDecal=bucket===2&&(reflectedGroundDecals.has(effect)||effect===retroDecalEffect||layeredSurface);
      const layered=bucket===2&&texture&&primaryUV&&(reflectedDecal||appearance.decalBlend&&!layeredSurfaceDecals.has(effect))
        ?twoLayerDecal(data,binding,texture):undefined;
      const retroChannels=layered?.retroBlend&&(hasRoadMaterials||ground===false)
        ?materialVertexChannels(gpu,v,vertexCount):undefined;
      const two=layered?.retroBlend?(retroChannels?layered:undefined):layered;
      const blend=two?colorChannel(gpu,v,vertexCount,0x30,0):undefined;
      const single=hasRoadMaterials&&bucket===2&&texture!==null&&
        roadDiffuseDecals.get(texture)===effect;
      const surfaceOpacity=bucket===2&&(ground===undefined&&surfaceOpacityEffects.has(effect)||ground===false&&effect===0xec8e6107);
      const surfaceDecal=ground===undefined&&bucket===2&&(objectDecalEffects.has(effect)||surfaceOpacity||reflectedDecal||immersedDecal);
      const frontOnlyDecal=material===66&&surfaceDecal;
      const decalTintMask=frontOnlyDecal&&effect===decalBlendEffect&&texture&&primaryUV&&!appearance.ordinaryPropLayers
        ?standardDecalTint(data,gpu,model,binding,v,vertexCount,base,placement.tintSelector??0,appearance):undefined;
      if(decalTintMask)uv=primaryUV;
      const objectDecal=surfaceDecal||ground===undefined&&bucket===3&&objectDirtEffects.has(effect);
      const vertexDecal=single||blend||sharedUV;
      // The layered hull decal exports COLOR0.A and multiplies it by the
      // blended diffuse alpha before the deferred pass writes its opacity.
      const alpha=vertexDecal||surfaceOpacity||immersedDecal||objectDecal&&effect===decalBlendEffect?
        colorChannel(gpu,v,vertexCount,4,3):undefined;
      const decal=propLayers?.dirt?colorChannel(gpu,v,vertexCount,4,3):
        propDecal||propDecalDiffuse?new Uint8Array(vertexCount).fill(255):
        vertexDecal||alpha?.some(value=>value!==255)?alpha:undefined;
      const decalLayers=two&&blend&&decal?two.layers:undefined;
      const decalTintMasks=ground===false&&two?.retroBlend&&decalLayers&&retroChannels
        ?terrainDecalTint(data,gpu,model,binding,v,vertexCount,base,retroChannels.weights,appearance):undefined;
      if(two&&(decalLayers||reflectedDecal)){
        texture=two.primary;
        uv=primaryUV;
      }else if(reflectedDecal)texture=null;
      if(shared&&sharedUV&&decal){
        texture=shared;
        uv=sharedUV;
      }
      const vertexOpacity=Boolean(decal);
      const overlay=causticsOnly||(ground===false&&(bucket===2||bucket===3))||
        objectDecal||vertexOpacity||(ground===undefined&&bucket===2&&texture!==null&&structureDecals.has(texture));
      const noDecalColor=overlay&&bucket===2&&effect===decalBlendEffect&&hasZeroDecalColorOpacity(data,binding)
        ?true:undefined;
      const cutout=withColors&&ground===undefined&&!overlay&&binding>=0&&(data.getUint8(binding+0x3c)&8)!==0;
      // Standalone landscape drawables use open surfaces. Their backs can cross
      // the skyline from inside the bounds of the larger mesh.
      const singleSided=ground===undefined&&material===66&&bucket===0&&singleSidedLandscapeEffects.has(effect);
      // These effects explicitly blend into the ground. Their surface is
      // useful where neither recovered ground LOD covers the same pixels.
      const groundBlend=ground===false&&bucket===2&&(effect===0x42c64b5e||effect===0xec8e6107);
      const fallback=!overlay||groundBlend?groundFallback:undefined;
      const roadMaterial=hasRoadMaterials&&uv&&uv.offset===primaryUV?.offset?roadLayers(data,binding):undefined;
      const roadEffect=effect===0x360e396b||effect===spxUV3LandscapeEffect;
      const groundRoad=withColors&&ground===false&&bucket===0&&primaryUV&&roadEffect&&!terrain;
      const drawableName=typeof drawable==="string"?drawable:drawable.name;
      const elevatedRoad=withColors&&ground===undefined&&material===66&&bucket===0&&primaryUV&&effect===0x360e396b&&
        (elevatedRoadDrawable.test(drawableName)||roadBridgeDrawable(drawableName));
      const channels=roadMaterial||groundRoad||elevatedRoad?materialVertexChannels(gpu,v,vertexCount):undefined;
      // With opaque vertex weights the source's texture-mask branch contributes zero.
      let road=channels&&(groundRoad||elevatedRoad?roadLayers(data,binding,true,
        channels.weights.every((value,j)=>j%4!==3||value===255),Boolean(elevatedRoad),()=>{
          const auxiliary=packedVertexColor(gpu,v,vertexCount,0x34);
          if(auxiliary===undefined)return false;
          for(let j=0;j<vertexCount;j++)if(gpu.getUint8(auxiliary+j*4+2)>>>4)return false;
          return true;
        },Boolean(groundFallback),placement):roadMaterial);
      if(elevatedRoad&&road?.useProjectedColor)road=undefined;
      const roadMaskUV=road?.maskUV===3?materialUVCoordinates(gpu,v,vertexCount,0x38):undefined;
      if(road?.maskUV===3&&!roadMaskUV)road=undefined;
      if(ground!==true&&bucket===0&&roadEffect){
        // Slot zero is a height channel even if this material variant is unsupported.
        texture=null;
        if(road)uv=primaryUV;
      }
      const uvStart=appearance.uv.length;
      for(let j=0;j<vertexCount;j++){
        if(!uv||(!texture&&!road&&!terrain)){appearance.uv.push(0,0);continue;}
        const at=uv.offset+j*uv.stride;
        const u=uv.stride===4?gpu.getInt16(at,true)*uv.scale:gpu.getFloat32(at,true);
        const w=uv.stride===4?gpu.getInt16(at+2,true)*uv.scale:gpu.getFloat32(at+4,true);
        if(!Number.isFinite(u)||!Number.isFinite(w)){texture=null;break;}
        appearance.uv.push(u,w);
      }
      if(appearance.uv.length!==uvStart+vertexCount*2){
        road=undefined;
        terrain=undefined;
        appearance.uv.length=uvStart;
        for(let j=0;j<vertexCount;j++)appearance.uv.push(0,0);
      }
      if(decal&&texture)(appearance.decalOpacity??=[]).push({first:base,values:decal});
      if((terrain?.tint?.uv===3||terrain?.maskUV===3)&&tintCoordinates)
        (appearance.terrainTintUV??=[]).push({first:base,values:tintCoordinates});
      if(road&&roadMaskUV)(appearance.terrainTintUV??=[]).push({first:base,values:roadMaskUV});
      if(terrain?.vertexTint||road?.tint?.surfaceAlpha||road?.localVertexColor){
        const offset=packedVertexColor(gpu,v,vertexCount,4);
        if(offset===undefined){
          if(terrain)terrain.vertexTint=undefined;
          if(road?.tint?.surfaceAlpha)road.tint=undefined;
          if(road?.localVertexColor){
            road.localVertexColor=undefined;
            road.height=undefined;
            road.detail=undefined;
          }
        }else (appearance.terrainColors??=[]).push({first:base,
          values:new Uint8Array(gpu.buffer,gpu.byteOffset+offset,vertexCount*4).slice()});
      }
      if(road?.parallax){
        const tangent=normals&&dynamicTangentStream(gpu,v,vertexCount,placement);
        const fade=colorChannel(gpu,v,vertexCount,0x34,0);
        const sector=roadControlOrigin(vertices,base,vertexCount,origin,appearance.uv,uvStart);
        if(road.localVertexColor&&tangent&&fade&&sector){
          road.parallax.origin=sector;
          (appearance.terrainSecondaryTangents??=[]).push({first:base,values:tangent});
          // Opaque road geometry uses the otherwise idle overlay opacity attribute.
          (appearance.decalOpacity??=[]).push({first:base,values:fade});
        }else road.parallax=undefined;
      }
      if(terrain?.normals){
        const primaryTangent=terrainTangentStream(gpu,v,vertexCount,placement);
        const usesSecondary=(terrain.vertexWeightUV??terrain.layerUV)?.some(Boolean);
        const secondaryTangent=usesSecondary&&primaryTangent&&normals
          ?dynamicTangentStream(gpu,v,vertexCount,placement):undefined;
        if(primaryTangent&&(!terrain.vertexWeightUV&&!usesSecondary||normals&&(!usesSecondary||secondaryTangent))){
          (appearance.terrainTangents??=[]).push({first:base,values:primaryTangent});
          if(secondaryTangent)(appearance.terrainSecondaryTangents??=[]).push({first:base,values:secondaryTangent});
        }else terrain.normals=undefined;
      }
      let bump:string|undefined;
      let bumpStrength:number|undefined;
      if(material===66&&ground===undefined&&!appearance.foliage&&normals&&texture&&!overlay&&!terrain&&!road&&!room&&!propLayers?.parallax&&
        uv?.offset===primaryUV?.offset){
        const normal=reflectedColorBinding(data,binding,0x1e77bf4c);
        if(normal&&normal!=="0x984614f3ca6c6fd5"&&normal!==texture){
          const tangent=terrainTangentStream(gpu,v,vertexCount,placement);
          if(tangent){
            (appearance.terrainTangents??=[]).push({first:base,values:tangent});
            bump=terrainTexturePrefix+"normal:"+normal;
            if(effect===0xbcf03fc1){
              // Standard's first material buffer stores reflected Bumpiness at +0x6c.
              bumpStrength=1;
              const table=systemReference(data,binding+8,8);
              const constants=table<0?-1:systemReference(data,table,0x70);
              if(constants>=0){
                const strength=data.getFloat32(constants+0x6c,true);
                if(Number.isFinite(strength))bumpStrength=strength;
              }
            }
          }
        }
      }
      if(decalLayers&&texture&&blend)(appearance.decalBlend??=[]).push({first:base,values:blend});
      if(retroChannels&&decalLayers&&texture)(appearance.road??=[]).push({first:base,...retroChannels});
      else if((terrain?.vertexWeightUV||terrain?.vertexBlend)&&terrainChannels)(appearance.road??=[]).push({first:base,...terrainChannels});
      else if(road&&channels)(appearance.road??=[]).push({first:base,...channels});
      let textureBounds:Bounds|undefined;
      if(ground===false||terrain||road||ground===undefined&&texture&&!overlay){
        let left=Infinity,bottom=Infinity,low=Infinity,right=-Infinity,top=-Infinity,high=-Infinity;
        for(let j=first;j<indices.length;j++){
          const at=indices[j]*4;
          const x=vertices[at],y=vertices[at+1],z=vertices[at+2];
          left=Math.min(left,x);bottom=Math.min(bottom,y);low=Math.min(low,z);
          right=Math.max(right,x);top=Math.max(top,y);high=Math.max(high,z);
        }
        textureBounds=[left,bottom,low,right,top,high];
      }
      const span=appearance.spans.at(-1);
      if(!road&&!terrain&&!decalLayers&&!surfaceDecalBlend&&!propLayers&&!staticLayers&&!room&&span&&!span.road&&!span.terrain&&!span.decalLayers&&!span.surfaceDecalBlend&&!span.propLayers&&!span.staticLayers&&!span.room&&span.texture===texture&&span.decalTintMask===decalTintMask&&span.surfacePalette===surfacePalette&&span.bump===bump&&span.bumpStrength===bumpStrength&&span.ground===ground&&span.cutout===cutout&&span.overlay===overlay&&span.frontOnlyDecal===frontOnlyDecal&&Boolean(span.singleSided)===singleSided&&span.groundBlend===groundBlend&&span.vertexOpacity===vertexOpacity&&span.noDecalColor===noDecalColor&&span.fallback===fallback){
        span.count+=indices.length-first;
        if(textureBounds&&span.textureBounds)for(let axis=0;axis<3;axis++){
          span.textureBounds[axis]=Math.min(span.textureBounds[axis],textureBounds[axis]);
          span.textureBounds[axis+3]=Math.max(span.textureBounds[axis+3],textureBounds[axis+3]);
        }
      }else appearance.spans.push({first,count:indices.length-first,texture,bump,bumpStrength,ground,cutout,overlay,frontOnlyDecal,singleSided:singleSided||undefined,groundBlend,vertexOpacity,noDecalColor,fallback,textureBounds,road,terrain,decalLayers,retroBlend:decalLayers?two?.retroBlend:undefined,decalTintMasks,decalTintMask,surfacePalette,surfaceDecalBlend,propLayers,staticLayers,room});
    }

  }

}

function roadControlOrigin(vertices:number[],base:number,count:number,origin:Vec3,uv:number[],uvStart:number){
  const x=vertices[base*4]+origin[0],y=vertices[base*4+1]+origin[1];
  const east=512*Math.round(x/512-uv[uvStart]),north=512*Math.round(y/512-1+uv[uvStart+1]);
  // The sector row is absent from the drawable. Recover its grid origin only
  // when packed UV0 independently agrees with the world projection throughout the part.
  for(let i=0;i<count;i++){
    const dx=vertices[(base+i)*4]+origin[0]-east-512*uv[uvStart+i*2];
    const dy=vertices[(base+i)*4+1]+origin[1]-north-512*(1-uv[uvStart+i*2+1]);
    if(!(Math.abs(dx)<.125&&Math.abs(dy)<.125))return;
  }
  return [east,north] as [number,number];
}

function appendSectorTerrainPage(data:DataView,gpu:DataView,binding:number,vertex:number,base:number,count:number,
  origin:Vec3,vertices:number[],indices:number[],first:number,appearance:AppearanceBuilder,
  name:string,ordinal:number,part:number,fallback:string,normals:Int16Array,placement:Placement){
  // This part has verified top-only page inputs across its entire footprint.
  if(name!=="n04_w06_049_hd"||ordinal!==9||part!==0x13fc0)return false;
  const table=systemReference(data,binding+8,16);
  const constants=table<0?-1:systemReference(data,table+8,0x80);
  const auxiliary=packedVertexColor(gpu,vertex,count,0x34);
  if(constants<0||auxiliary===undefined)return false;
  if([0,4,8,12].some(i=>data.getFloat32(constants+0x30+i,true)!==0)||
    [1,1,1,2].some((value,i)=>data.getFloat32(constants+0x70+i*4,true)!==value))return false;
  const bounds=emptyBounds();
  for(let i=0;i<count;i++){
    if(gpu.getUint8(auxiliary+i*4+2)>>>4!==15||normals[i*3+2]<=.7001*32767)return false;
    for(let axis=0;axis<3;axis++){
      const coordinate=vertices[(base+i)*4+axis];
      bounds[axis]=Math.min(bounds[axis],coordinate);
      bounds[axis+3]=Math.max(bounds[axis+3],coordinate);
    }
  }
  const [left,bottom,,right,top]=bounds;
  const source=sectorTerrainPage(name,ordinal,part,[left+origin[0],bottom+origin[1],right+origin[0],top+origin[1]]);
  if(!source)return false;
  for(let i=0;i<count;i++){
    const at=(base+i)*4;
    appearance.uv.push((vertices[at]-left)/(right-left),(vertices[at+1]-bottom)/(top-bottom));
  }
  const tangent=terrainTangentStream(gpu,vertex,count,placement);
  if(tangent)(appearance.terrainTangents??=[]).push({first:base,values:tangent});
  (appearance.dynamic??=[]).push(source);
  appearance.spans.push({first,count:indices.length-first,texture:source.control.id,ground:false,fallback,textureBounds:bounds});
  return true;
}

function appendDynamicTerrain(data:DataView,gpu:DataView,binding:number,vertex:number,base:number,count:number,
  origin:Vec3,vertices:number[],indices:number[],first:number,appearance:AppearanceBuilder,
  name:string,ordinal:number,part:number,fallback:string|undefined,
  normals:Int16Array|undefined,placement:Placement){
  if(count<3||indices.length-first<3)return false;
  const table=systemReference(data,binding+8,16);
  const constants=table<0?-1:systemReference(data,table+8,0x120);
  if(constants<0)return false;
  const values=(offset:number)=>[0,4,8,12].map(i=>data.getFloat32(constants+offset+i,true));
  const control=dynamicTerrainControl(name,ordinal,part,values);
  if(!control)return false;
  const colors=[14,12,9,13].map(slot=>colorBinding(data,binding,slot));
  const heights=[4,0,5,1].map(slot=>colorBinding(data,binding,slot));
  if(!colors.every((v):v is string=>v!==null)||!heights.every((v):v is string=>v!==null))return false;
  const primary=uvStream(gpu,vertex,count,0xc),secondary=uvStream(gpu,vertex,count,0x10);
  const blend=packedVertexColor(gpu,vertex,count,0x30),extra=packedVertexColor(gpu,vertex,count,0x34);
  if(!primary||!secondary||blend===undefined||extra===undefined)return false;
  const textureBounds=emptyBounds();
  let needsMask=false;
  for(let i=0;i<count;i++){
    if(gpu.getUint8(blend+i*4+3)!==255)needsMask=true;
    for(let axis=0;axis<3;axis++){
      const coordinate=vertices[(base+i)*4+axis];
      textureBounds[axis]=Math.min(textureBounds[axis],coordinate);
      textureBounds[axis+3]=Math.max(textureBounds[axis+3],coordinate);
    }
  }
  const bounds:[number,number,number,number]=[textureBounds[0]+origin[0],textureBounds[1]+origin[1],
    textureBounds[3]+origin[0],textureBounds[4]+origin[1]];
  const [x0,y0]=control.sector.origin;
  // Quantized position decoding can put a shared edge a few millionths outside its sector.
  const edgeTolerance=0.0001;
  if(bounds[0]<x0-edgeTolerance||bounds[1]<y0-edgeTolerance||
    bounds[2]>x0+512+edgeTolerance||bounds[3]>y0+512+edgeTolerance)return false;
  const eligible:number[]=[],other:number[]=[];
  let includeAuxiliary=false;
  // Vertices on the same side of this cone keep the triangle in the top
  // projection after normal interpolation and renormalization.
  const flat=.7001*32767;
  for(let i=first;i<indices.length;i+=3){
    const a=indices[i]-base,b=indices[i+1]-base,c=indices[i+2]-base;
    const zero=(gpu.getUint8(extra+a*4+2)|gpu.getUint8(extra+b*4+2)|gpu.getUint8(extra+c*4+2))<16;
    if(zero){
      eligible.push(a,b,c);
      continue;
    }
    if(normals){
      const z0=normals[a*3+2],z1=normals[b*3+2],z2=normals[c*3+2];
      if(Math.min(z0,z1,z2)>=flat||Math.max(z0,z1,z2)<=-flat){
        includeAuxiliary=true;
        eligible.push(a,b,c);
        continue;
      }
    }
    other.push(a,b,c);
  }
  if(!eligible.length)return false;
  const rgba=new Float32Array(count*9),uv:number[]=[];
  const read=(s:NonNullable<typeof primary>,i:number,j:number)=>{
    const at=s.offset+i*s.stride+j*s.stride/2;
    return s.stride===8?gpu.getFloat32(at,true):gpu.getInt16(at,true)*s.scale;
  };
  let localMask:ComposedTerrainSource["localMask"];
  if(needsMask){
    if(!control.authoredTint)return false;
    const key=colorBinding(data,binding,2);
    if(!key)return false;
    const alpha=Uint8Array.from({length:count},(_,i)=>gpu.getUint8(blend+i*4+3));
    let uv:Float32Array|undefined;
    if(control.maskUV==="3,0,1,2"){
      const stream=uvStream(gpu,vertex,count,0x38);
      if(!stream)return false;
      uv=new Float32Array(count*2);
      for(let i=0;i<count;i++){
        uv[i*2]=read(stream,i,0);uv[i*2+1]=read(stream,i,1);
      }
      if(!uv.every(Number.isFinite))return false;
    }
    localMask={key,alpha,uv};
  }
  for(let i=0;i<count;i++){
    const x=(vertices[(base+i)*4]+origin[0]-bounds[0])/(bounds[2]-bounds[0]);
    const y=(vertices[(base+i)*4+1]+origin[1]-bounds[1])/(bounds[3]-bounds[1]);
    const row=[x,y,read(primary,i,0),read(primary,i,1),read(secondary,i,0),read(secondary,i,1),
      gpu.getUint8(blend+i*4)/255,gpu.getUint8(blend+i*4+1)/255,gpu.getUint8(blend+i*4+2)/255];
    if(!row.every(Number.isFinite))return false;
    uv.push(x,y);
    rgba.set(row,i*9);
  }
  const gain=values(0xf0),bias=values(0x100),strength=values(0x110);
  if(![...gain,...bias,...strength].every(Number.isFinite))return false;
  const auxiliary=includeAuxiliary?Uint8Array.from({length:count},(_,i)=>gpu.getUint8(extra+i*4+2)>>>4):undefined;
  const tintStart=packedVertexColor(gpu,vertex,count,4);
  let localTint:ComposedTerrainSource["localTint"];
  if(control.authoredTint){
    if(tintStart===undefined||systemReference(data,table+8,0x1ac)!==constants||
      values(0x130).some(v=>v!==0)||values(0x160).some(v=>v!==0)||
      values(0x190).join()!=="1,0,0,0"||values(0x1a0).join()!=="0,1,1,0")return false;
    const sectorScale=values(0x140),amount=values(0x150),scale=values(0x170),vertexAmount=values(0x180);
    const key=colorBinding(data,binding,16);
    if(!key||![...sectorScale,...scale].every(v=>Number.isFinite(v)&&v>=0)||
      ![...amount,...vertexAmount].every(v=>v>=0&&v<=1))return false;
    const rgb=new Uint8Array(gpu.buffer,gpu.byteOffset+tintStart,count*4).slice();
    localTint={rgb,scale,sector:{key,scale:sectorScale,amount,vertexAmount}};
  }else if(control.layerMask===8&&tintStart!==undefined&&systemReference(data,table+8,0x1ac)===constants&&
    values(0x150).every(v=>v===0)&&values(0x160).every(v=>v===0)&&
    values(0x180).join()==="1,1,1,0"&&values(0x190).join()==="1,0,0,0"&&
    data.getFloat32(constants+0x1a8,true)===1){
    const scale=values(0x170);
    if(scale.every(v=>Number.isFinite(v)&&v>=0)){
      const rgb=new Uint8Array(count*3);
      for(let i=0;i<count;i++)for(let c=0;c<3;c++)rgb[i*3+c]=gpu.getUint8(tintStart+i*4+c);
      localTint={rgb,scale};
    }
  }
  let localNormals:ComposedTerrainSource["localNormals"];
  const normalStrength=values(0x60);
  const primaryFrame=control.primaryMask===15,secondaryFrame=control.primaryMask===0,
    mixedFrames=control.authoredTint&&!primaryFrame&&!secondaryFrame;
  if(normals&&(primaryFrame||secondaryFrame||mixedFrames)&&normalStrength.some(v=>v>0)&&normalStrength.every(v=>v>=0&&v<=4)){
    const keys=[15,10,11,7].map(slot=>colorBinding(data,binding,slot));
    const tangent=keys.some(Boolean)
      ?(secondaryFrame?dynamicTangentStream:terrainTangentStream)(gpu,vertex,count,placement)
      :undefined;
    if(tangent){
      const secondary=mixedFrames?dynamicTangentStream(gpu,vertex,count,placement):undefined;
      if(!mixedFrames||secondary){
        (appearance.terrainTangents??=[]).push({first:base,values:tangent});
        localNormals={keys,strength:normalStrength,frames:secondary?{normals,primary:tangent,secondary}:undefined};
      }
    }
  }
  (appearance.dynamic??=[]).push({control,vertices:rgba,triangles:Uint32Array.from(eligible),bounds,colors,heights,gain,bias,strength,auxiliary,localTint,localNormals,localMask});
  appearance.uv.push(...uv);
  let cursor=first;
  for(const group of [eligible,other])for(const index of group)indices[cursor++]=base+index;
  appearance.spans.push({first,count:eligible.length,texture:control.id,ground:false,fallback,textureBounds});
  if(other.length)appearance.spans.push({first:first+eligible.length,count:other.length,texture:null,ground:false,fallback});
  return true;
}

function uvStream(gpu:DataView,vertex:number,count:number,descriptor?:number){
  const scale=gpu.getFloat32(vertex+0x7c,true);
  let floats:number|undefined;
  for(let offset=descriptor??0x0c;offset<(descriptor===undefined?0x58:descriptor+4);offset+=4){
    const channel=gpu.getUint32(vertex+offset,true);
    if(!channel)break;
    const start=(channel>>>8)*2;
    if(start<0x80+count*8)continue;
    const encoding=channel&255;
    if(encoding===0x28&&Number.isFinite(scale)&&scale>0&&scale<=64&&vertex+start+count*4<=gpu.byteLength)
      return {offset:vertex+start,stride:4,scale:scale/32768};
    if(encoding===0x42&&floats===undefined&&vertex+start+count*8<=gpu.byteLength)
      floats=vertex+start;
  }
  return floats===undefined?null:{offset:floats,stride:8,scale:1};
}

function packedVertexColor(gpu:DataView,vertex:number,count:number,descriptor:number){
  const channel=gpu.getUint32(vertex+descriptor,true),offset=(channel>>>8)*2;
  if((channel&255)!==0x26||offset<0x80+count*8||vertex+offset+count*4>gpu.byteLength)return;
  return vertex+offset;
}

function colorChannel(gpu:DataView,vertex:number,count:number,descriptor:number,component:number){
  const offset=packedVertexColor(gpu,vertex,count,descriptor);
  if(offset!==undefined)return Uint8Array.from({length:count},(_,i)=>gpu.getUint8(offset+i*4+component));
}

function localTintPalette(data:DataView,gpu:DataView,group:number,key:string){
  const start=systemReference(data,group+0x30,8);
  if(start<0)return;
  for(let row=start;row+8<=data.byteLength;row+=8){
    const descriptor=systemReference(data,row,0x40);
    if(descriptor<0)return;
    if(textureDescriptorKey(data,descriptor)!==key)continue;
    const width=data.getUint16(descriptor+0x38,true);
    const shift=8-(width&7);
    const offset=data.getUint32(descriptor+0x18,true)-graphics;
    if((width>>shift)<1||data.getUint16(descriptor+0x3a,true)!==1||
      data.getUint8(descriptor+0x3f)!==29||data.getUint32(descriptor+0x1c,true)||
      offset<0||offset+width*4>gpu.byteLength)return;
    return new Uint8Array(gpu.buffer,gpu.byteOffset+offset,width*4);
  }
}

function readSurfaceDecalBlend(data:DataView,gpu:DataView,binding:number,vertex:number,count:number,
  base:number,appearance:AppearanceBuilder,placement:Placement):SurfaceDecalBlend|undefined{
  const table=systemReference(data,binding+8,8),constants=systemReference(data,table,0x11c);
  if(constants<0||placement.propLayerControl!==255||placement.propDirtControl!==255)return;
  const f=(offset:number)=>data.getFloat32(constants+offset,true);
  // This permutation uses UV0 for layer 0 and control blue, UV1 for layer 1
  // and dirt, and full authored instance weights for both.
  if(f(0x44)!==2||[0x14,0x48,0x4c,0x68,0x78,0x88,0x90,0x98,0xa0,0xb4,0xb8].some(at=>f(at)!==1)||
    [0x6c,0x70,0x74,0x7c,0x84,0x8c,0x94,0x9c,0xc0,0xc4,0x114,0x118].some(at=>f(at)!==0))return;
  // Both packed masks are the verified constant 4×4 texture. This effect
  // multiplies palette strength by one minus mask alpha, which is zero here.
  const opaqueMask="0x59932052cc65cbee";
  if([0x3c4af3d4,0xfa0446c7].some(hash=>reflectedColorBinding(data,binding,hash)!==opaqueMask))return;
  const reciprocal=1/Math.max(.001,f(0x80)**2);
  const control=reflectedColorBinding(data,binding,0x38ebcdb3),dirt=reflectedColorBinding(data,binding,0x7485dafb);
  const coordinates=materialUVCoordinates(gpu,vertex,count,0x10),color=packedVertexColor(gpu,vertex,count,0x30);
  if(!control||!dirt||!coordinates||color===undefined||!Number.isFinite(reciprocal))return;
  const weights=new Uint8Array(gpu.buffer,gpu.byteOffset+color,4*count).slice();
  (appearance.road??=[]).push({first:base,coordinates,weights});
  return {control:terrainTexturePrefix+"layer-control:"+control,dirt:terrainTexturePrefix+"diffuse:"+dirt,reciprocal};
}

function hasZeroDecalColorOpacity(data:DataView,binding:number){
  const buffers=systemReference(data,binding+8,8);
  const constants=systemReference(data,buffers,0xbc);
  // The deferred blend permutation exports base-color opacity scaled by b8.
  // Other material targets can still receive this decal.
  return constants>=0&&data.getFloat32(constants+0xb0,true)===0&&data.getFloat32(constants+0xb8,true)===0;
}

function standardDecalTint(data:DataView,gpu:DataView,group:number,binding:number,vertex:number,
  count:number,base:number,selector:number,appearance:AppearanceBuilder){
  const buffers=systemReference(data,binding+8,8);
  const constants=systemReference(data,buffers,0x98);
  // The basic deferred decal uses mask alpha directly at these settings.
  if(constants<0||data.getFloat32(constants+0x90,true)!==1||data.getFloat32(constants+0x94,true)!==0)return;
  const mask=reflectedColorBinding(data,binding,0x739e3d0d);
  const colors=mask&&vertexPaletteColors(data,gpu,group,binding,vertex,count,selector);
  if(!mask||!colors)return;
  (appearance.terrainColors??=[]).push({first:base,values:colors});
  return terrainTexturePrefix+"material-mask:"+mask;
}

function terrainDecalTint(data:DataView,gpu:DataView,group:number,binding:number,vertex:number,
  count:number,base:number,weights:Uint8Array,appearance:AppearanceBuilder):[string,string]|undefined{
  const buffers=systemReference(data,binding+8,8);
  const constants=buffers<0?-1:systemReference(data,buffers,0x128);
  if(constants<0||data.getFloat32(constants+0x34,true)!==1||data.getFloat32(constants+0x6c,true)!==1||
    weights.some((value,i)=>i%4===1&&value!==0))return;
  const key=reflectedColorBinding(data,binding,0x2c8d7182);
  const mask0=reflectedColorBinding(data,binding,0x3c4af3d4),mask1=reflectedColorBinding(data,binding,0xfa0446c7);
  const palette=key&&localTintPalette(data,gpu,group,key);
  const color=packedVertexColor(gpu,vertex,count,4);
  if(!palette||palette.length<256*4||!mask0||!mask1||color===undefined)return;
  // Static terrain selects palette block zero. The vertex shader converts
  // each RGB value to linear before it interpolates across the triangle.
  const values=new Uint8Array(count*4);
  for(let i=0;i<count;i++){
    const index=gpu.getUint8(color+4*i+2)*4;
    values.set(palette.subarray(index,index+4),i*4);
  }
  (appearance.terrainColors??=[]).push({first:base,values});
  return [terrainTexturePrefix+"material-mask:"+mask0,terrainTexturePrefix+"material-mask:"+mask1];
}

function vertexPaletteColors(data:DataView,gpu:DataView,group:number,binding:number,vertex:number,count:number,selector?:number){
  const key=reflectedColorBinding(data,binding,0x2c8d7182);
  const color=packedVertexColor(gpu,vertex,count,4);
  const palette=key&&localTintPalette(data,gpu,group,key);
  if(!palette||color===undefined)return;
  const width=palette.length/4;
  const shift=8-(width&7);
  const banks=width>>shift;
  // A single variant is independent of the placement's tint selection.
  if(selector===undefined&&banks!==1)return;
  const bank=Math.min(selector??0,banks-1)<<shift;
  const values=new Uint8Array(count*4);
  for(let i=0;i<count;i++){
    const index=bank+gpu.getUint8(color+i*4+2);
    if(index>=width)return;
    values.set(palette.subarray(index*4,index*4+4),i*4);
  }
  return values;
}

function readDirtPalette(data:DataView,gpu:DataView,group:number,binding:number,vertex:number,count:number,
  base:number,appearance:AppearanceBuilder,tintSelector:number|undefined,cloth:boolean):string|true|undefined{
  const table=systemReference(data,binding+8,8);
  const maskOffset=cloth?0xd8:0xe8;
  const constants=table<0?-1:systemReference(data,table,maskOffset+8);
  if(constants<0||data.getFloat32(constants+0x14,true)!==1||data.getFloat32(constants+0x18,true)!==1||
    data.getFloat32(constants+0x1c,true)!==0)return;
  const maskAlpha=data.getFloat32(constants+maskOffset,true);
  if((maskAlpha!==0&&maskAlpha!==1)||data.getFloat32(constants+maskOffset+4,true)!==0)return;
  const mask=maskAlpha===1?reflectedColorBinding(data,binding,0x739e3d0d):undefined;
  if(maskAlpha===1&&!mask)return;
  const values=vertexPaletteColors(data,gpu,group,binding,vertex,count,tintSelector??0);
  if(!values||values.some((value,i)=>i%4===3&&value!==255)||!values.some(value=>value!==255))return;
  (appearance.terrainColors??=[]).push({first:base,values});
  return mask?materialMaskChainPrefix+mask:true;
}

function propDecalPaletteIsOpaque(data:DataView,gpu:DataView,group:number,binding:number,vertex:number,count:number){
  const key=reflectedColorBinding(data,binding,0x2c8d7182);
  const palette=key&&localTintPalette(data,gpu,group,key);
  const color=packedVertexColor(gpu,vertex,count,4);
  if(!palette||color===undefined)return false;
  const width=palette.length/4,shift=8-(width&7),variants=width>>shift;
  const used=new Set<number>();
  for(let i=0;i<count;i++)used.add(gpu.getUint8(color+i*4+2));
  // This effect multiplies diffuse alpha by palette alpha. If every sampled
  // entry is opaque, the diffuse texture supplies the opacity for every placement.
  for(const index of used){
    if(index>=(1<<shift))return false;
    for(let variant=0;variant<variants;variant++)
      if(palette[((variant<<shift)+index)*4+3]!==255)return false;
  }
  return true;
}

function readRoomMaterial(data:DataView,gpu:DataView,group:number,binding:number,vertex:number,count:number,base:number,
  appearance:AppearanceBuilder,placement:Placement,normals:Int16Array):StreetRoomMaterial|undefined{
  if(placement.linear||placement.scale[0]!==placement.scale[1])return;
  const table=systemReference(data,binding+8,8),constants=table<0?-1:systemReference(data,table,0x274);
  if(constants<0)return;
  const f=(offset:number)=>data.getFloat32(constants+offset,true);
  // The verified material uses the authored room dimensions and straight view ray.
  if(f(0x16c)!==1||f(0x18c)!==1)return;
  const parameters=[f(0x148),Math.round(f(0x14c)),f(0x15c),f(0x164)] as const;
  if(!parameters.every(Number.isFinite)||parameters[1]<=0||parameters[3]<=0)return;
  const colorCube=reflectedColorBinding(data,binding,0x17d3b5c2);
  const projected=reflectedColorBinding(data,binding,0x6994ef3f);
  const uv2=materialUVCoordinates(gpu,vertex,count,0x38),uv3=materialUVCoordinates(gpu,vertex,count,0x3c);
  const color=packedVertexColor(gpu,vertex,count,0x34);
  const tangent=dynamicTangentStream(gpu,vertex,count,placement,0x48);
  if(!colorCube||!projected||!uv2||!uv3||color===undefined||!tangent)return;
  const bitangent=new Int16Array(count*4);
  for(let i=0;i<count;i++){
    const at=4*i;
    const [nx,ny,nz]=normals.subarray(3*i,3*i+3);
    const [ux,uy,uz,hand]=tangent.subarray(at,at+4);
    const length=Math.hypot(ux,uy,uz);
    const x=uy*nz-uz*ny,y=uz*nx-ux*nz,z=ux*ny-uy*nx;
    const normal=Math.hypot(x,y,z);
    if(!length||!normal||!hand)return;
    const u=32767/length,v=Math.sign(hand)*32767/normal;
    tangent.set([Math.round(ux*u),Math.round(uy*u),Math.round(uz*u)],at);
    bitangent.set([Math.round(x*v),Math.round(y*v),Math.round(z*v)],at);
  }
  (appearance.road??=[]).push({first:base,coordinates:uv2,
    weights:new Uint8Array(gpu.buffer,gpu.byteOffset+color,count*4).slice()});
  (appearance.terrainTintUV??=[]).push({first:base,values:uv3});
  (appearance.terrainTangents??=[]).push({first:base,values:tangent});
  (appearance.terrainSecondaryTangents??=[]).push({first:base,values:bitangent});
  const room:StreetRoomMaterial={colorCube,projected,parameters};
  if(placement.tintSelector===undefined||placement.propLayerControl!==255||
    [0x18,0x1c,0x3c,0x5c,0x74,0x78,0x90,0x98,0xec].some(at=>f(at)!==1)||
    [0x50,0x94,0x9c,0x100,0x170,0x184,0x220,0x270].some(at=>f(at)!==0)||
    f(0x208)!==24||f(0x20c)!==24||
    reflectedColorBinding(data,binding,0x7485dafb)!=="0x2acfdd44be10c24c")return room;
  const diffuse0=reflectedColorBinding(data,binding,0x346394ea),diffuse1=reflectedColorBinding(data,binding,0x7d4f12e2);
  const b0=reflectedColorBinding(data,binding,0x3c4af3d4),a0=reflectedColorBinding(data,binding,0x2bb2ede8);
  const a1=reflectedColorBinding(data,binding,0x4d56d7fe),paletteKey=reflectedColorBinding(data,binding,0x2c8d7182);
  const palette=paletteKey&&localTintPalette(data,gpu,group,paletteKey);
  const color0=packedVertexColor(gpu,vertex,count,4),color1=packedVertexColor(gpu,vertex,count,0x30);
  if(!diffuse0||!diffuse1||!b0||!a0||!a1||!palette||color0===undefined||color1===undefined)return room;
  const width=palette.length/4,shift=8-(width&7),bank=1<<shift;
  const offset=Math.min(placement.tintSelector,(width>>shift)-1)*bank;
  const colors=new Uint8Array(count*4);
  for(let i=0;i<count;i++){
    const index=gpu.getUint8(color0+4*i+2);
    if(index>=bank||gpu.getUint8(color1+4*i)!==255)return room;
    colors.set(palette.subarray(4*(offset+index),4*(offset+index)+4),4*i);
  }
  const density:[number,number,number]=[Math.max(0,f(0x130)),f(0x13c),Math.abs(f(0x140))];
  const absorption:[number,number,number,number]=[f(0x120),f(0x124),f(0x128),f(0x168)];
  if(![...density,...absorption].every(Number.isFinite)||absorption[3]<=0)return room;
  (appearance.terrainColors??=[]).push({first:base,values:colors});
  room.glass={textures:[diffuse0,diffuse1,b0,a0,a1],density,absorption};
  return room;
}

function staticMaterialLayers(data:DataView,gpu:DataView,group:number,binding:number,vertex:number,count:number,
  base:number,appearance:AppearanceBuilder,{tintSelector,propLayerControl,propDirtControl,scale}:Placement,
  staticParallax:boolean,layeredPavement:boolean){
  const table=systemReference(data,binding+8,8),constants=table<0?-1:systemReference(data,table,0x11c);
  if(constants<0)return;
  const f=(offset:number)=>data.getFloat32(constants+offset,true);
  const sharedWorldUV=!staticParallax&&f(0x14)===1;
  const wall=sharedWorldUV&&f(0x44)===0&&f(0x74)===1;
  if(!sharedWorldUV&&(tintSelector===undefined||propLayerControl===undefined))return;
  // Both permutations select palette A and use control blue. The static PXM
  // permutation reverses the layer UV selectors and has a different CB layout.
  if(layeredPavement){
    if(!sharedWorldUV||[0x10,0x98,0xa0,0xa8,0x100].some(at=>f(at)!==1)||
      [0x90,0x94,0x9c,0xa4,0xac,0x114,0x118].some(at=>f(at)!==0))return;
  }else if(staticParallax){
    if(propLayerControl!==255||f(0x50)!==2||
      [0x10,0x14,0x3c,0x4c,0x54,0x58,0x78,0x98,0xa0,0xa8,0x100].some(at=>f(at)!==1)||
      [0x7c,0x90,0x94,0x9c,0xa4,0xac,0x114,0x118].some(at=>f(at)!==0))return;
  }else if((!wall&&(f(0x14)!==2||f(0x44)!==1))||[0x78,0x80,0x84,0x8c,0x94,0x9c,0x114,0x118].some(at=>f(at)!==0)||
    [0x10,0x34,0x48,0x50,0x54,0x6c,0x88,0x98,0x100].some(at=>f(at)!==1))return;
  const weightPower=f(staticParallax||layeredPavement?0xa0:0x90);
  if(!Number.isFinite(weightPower)||weightPower<=0)return;
  const diffuse0=reflectedColorBinding(data,binding,0x346394ea),diffuse1=reflectedColorBinding(data,binding,0x7d4f12e2);
  const mask0=reflectedColorBinding(data,binding,0x3c4af3d4),mask1=reflectedColorBinding(data,binding,0xfa0446c7);
  const control=reflectedColorBinding(data,binding,0x38ebcdb3),paletteKey=reflectedColorBinding(data,binding,0x2c8d7182);
  if(!diffuse0||!diffuse1||!mask0||!mask1||!control||!paletteKey)return;
  const layer0UV=uvStream(gpu,vertex,count,staticParallax||sharedWorldUV?0x0c:0x10);
  const layer1UV=materialUVCoordinates(gpu,vertex,count,staticParallax?0x10:0x0c);
  const color0=packedVertexColor(gpu,vertex,count,4),color1=packedVertexColor(gpu,vertex,count,0x30);
  const palette=localTintPalette(data,gpu,group,paletteKey);
  if(!layer0UV||!layer1UV||color0===undefined||color1===undefined||!palette)return;
  const width=palette.length/4,shift=8-(width&7),block=1<<shift;
  const offset=Math.min(tintSelector??0,(width>>shift)-1)*block;
  const values=new Uint8Array(count*4);
  for(let i=0;i<count;i++){
    const index=gpu.getUint8(color0+i*4+2);
    if(index>=block)return;
    values.set(palette.subarray((offset+index)*4,(offset+index)*4+3),i*4);
    values[i*4+3]=gpu.getUint8(color1+i*4);
  }
  (appearance.terrainColors??=[]).push({first:base,values});
  const detailTable=scale[0]===scale[1]?systemReference(data,table,0x1ec):-1;
  const layerDetail=(at:number):StaticLayerDetail|undefined=>{
    if(detailTable!==constants||reflectedColorBinding(data,binding,0x0cd27763))return;
    // Identity slice remap with either a fixed slice or a slice from MaterialB.
    const phase=f(at+16);
    const slice=f(at+12);
    if(f(at+8)!==-1||!Number.isInteger(slice)||slice< -1||slice>=32||phase!==0&&phase!==1||
      data.getUint32(constants+at+0x38,true)!==0xe4e4e4e4||
      data.getUint32(constants+at+0x3c,true)!==0xffaa5500||
      data.getUint32(constants+at+0x40,true)!==0)return;
    const u=f(at),v=f(at+4),rotation=f(at+20),strength=f(at+24);
    const placementScale=Math.abs(scale[0]);
    if(![u,v,strength,placementScale].every(value=>Number.isFinite(value)&&value>0)||
      rotation!==0&&rotation!==180)return;
    const sign=rotation===180?-1:1;
    return [u*placementScale*sign,v*placementScale*sign,strength,phase,slice<0?undefined:slice];
  };
  const detail0=layerDetail(0x158),detail1=layerDetail(0x1a8);
  const directDirtUV=wall&&(propDirtControl??255)===255&&f(0xac)===0&&
    [0xa0,0xa8,0xc4,0xc8].every(at=>f(at)===1)&&materialUVCoordinates(gpu,vertex,count,0x10);
  const overlayDirt=!staticParallax&&propDirtControl===255&&
    [0xa4,0xcc,0xd0,0xd4,0xd8].every(at=>f(at)===0)&&[0xa0,0xac,0xb0,0xc4,0xc8].every(at=>f(at)===1);
  const dirtKey=directDirtUV||overlayDirt
    ?reflectedColorBinding(data,binding,0x7485dafb):null;
  const opacity=dirtKey?Uint8Array.from({length:count},(_,i)=>gpu.getUint8(color0+i*4+3)):undefined;
  const dirt=opacity?.some(value=>value>0)?dirtKey??undefined:undefined;
  if(dirt&&opacity)(appearance.decalOpacity??=[]).push({first:base,values:opacity});
  // The direct dirt path shares UV0 across the diffuse layers and uses UV1 for dirt.
  const dirtDirect=Boolean(dirt&&directDirtUV);
  (appearance.terrainTintUV??=[]).push({first:base,values:dirtDirect&&directDirtUV||layer1UV});
  const normal0=layeredPavement&&reflectedColorBinding(data,binding,0x84c69350);
  const normal1=layeredPavement&&reflectedColorBinding(data,binding,0x58b6e707);
  const march=[f(0x24),f(0x28),f(0x60),f(0x64)] as const;
  const parallax=layeredPavement&&march.every(value=>value>0&&value<=.1)?march:undefined;
  const layers:StaticMaterialLayers={textures:[diffuse0,diffuse1,mask0,mask1,control],weightPower,
    layerControl:(propLayerControl??255)/255,detail:detail0||detail1?[detail0,detail1]:undefined,
    normals:normal0&&normal1?[normal0,normal1]:undefined,parallax,dirt,dirtDirect:dirtDirect?true:undefined};
  return {layers,uv:layer0UV};
}

function propMaterialLayers(data:DataView,gpu:DataView,group:number,binding:number,vertex:number,count:number,
  base:number,appearance:AppearanceBuilder,decal:boolean,parallax:boolean):PropMaterialLayers|undefined{
  const table=systemReference(data,binding+8,8);
  const constants=table<0?-1:systemReference(data,table,parallax?0x1ec:0x124);
  if(constants<0)return;
  const f=(offset:number)=>data.getFloat32(constants+offset,true);
  // The supported permutation uses UV0 for both layers and palette A for both masks.
  if(parallax){
    // This effect uses the named detail atlas when its material slot is null.
    // Only the verified UV, palette, detail, and dirt configuration is enabled.
    if([0x20,0x24,0x34,0x38,0x5c,0x6c,0x9c,0xa0,0x110,0x16c,0x18c,0x1bc,0x1dc].some(at=>f(at)!==0)||
      [0x28,0x2c,0x30,0x58,0x64,0x68,0x70,0x74,0x94,0x98,0xd4,0xe4,0x100,0x168,0x1b8,0x1c0].some(at=>f(at)!==1)||
      f(0x158)!==8||f(0x15c)!==4||f(0x1a8)!==10||f(0x1ac)!==5||
      f(0x160)!==-1||f(0x1b0)!==-1||f(0x170)!==.5||f(0xc4)!==Math.fround(.4)||
      f(0xe8)!==Math.fround(-.1)||[0x48,0x84].some(at=>f(at)!==Math.fround(.3))||
      [0x4c,0x88].some(at=>f(at)!==Math.fround(.15))||
      [0x190,0x1e0].some(at=>data.getUint32(constants+at,true)!==0xe4e4e4e4||
        data.getUint32(constants+at+4,true)!==0xffaa5500||data.getUint32(constants+at+8,true)!==0)||
      reflectedColorBinding(data,binding,0x0cd27763))return;
  }else if(decal){
    if([0x20,0xb4,0xbc,0x100].some(at=>f(at)!==0)||
      [0x2c,0x30,0x50,0x5c,0x60,0x64,0x68,0x80,0x84,0xc0,0xe8,0xfc].some(at=>f(at)!==1)||
      f(0xa8)!==Math.fround(.1))return;
  }else if([0x20,0x28,0x94,0xa0,0xa4,0xac,0xbc,0x120].some(at=>f(at)!==0)||
    [0x34,0x38,0x5c,0x68,0x6c,0x70,0x74,0x8c,0x90,0xb4,0xb8,0x110].some(at=>f(at)!==1))return;
  const weightPower=f(decal?0xa0:0xb0);
  if(!Number.isFinite(weightPower)||weightPower<=0)return;
  const diffuse0=reflectedColorBinding(data,binding,0x346394ea),diffuse1=reflectedColorBinding(data,binding,0x7d4f12e2);
  const material0=reflectedColorBinding(data,binding,0x3c4af3d4),material1=reflectedColorBinding(data,binding,0xfa0446c7);
  const control=reflectedColorBinding(data,binding,0x38ebcdb3),paletteKey=reflectedColorBinding(data,binding,0x2c8d7182);
  if(!diffuse0||!diffuse1||!material0||!material1||!control||!paletteKey)return;
  let height:PropMaterialLayers["parallax"];
  if(parallax){
    const a=reflectedColorBinding(data,binding,0x2bb2ede8),b=reflectedColorBinding(data,binding,0x4d56d7fe);
    const march=[f(0x40),f(0x44),f(0x7c),f(0x80)] as const;
    // All mip texels of these two masks stay inside their respective slice bins.
    if(!a||!b||material0!=="0x14a959e0938b6804"||material1!=="0x2dd09139d0156f0b"||
      !march.every(Number.isFinite)||march[0]<=0||march[2]<=0)return;
    height={materials:[a,b],march};
  }
  const dirt=decal||parallax?reflectedColorBinding(data,binding,0x7485dafb):undefined;
  const dirtUV=dirt?materialUVCoordinates(gpu,vertex,count,0x10):undefined;
  if((decal||parallax)&&(!dirt||!dirtUV))return;
  const color0=packedVertexColor(gpu,vertex,count,4),color1=packedVertexColor(gpu,vertex,count,0x30);
  if(color0===undefined||color1===undefined)return;
  const palette=appearance.spans.find(span=>span.propLayers?.paletteKey===paletteKey)?.propLayers?.palette
    ??localTintPalette(data,gpu,group,paletteKey)?.slice();
  if(!palette)return;
  const width=palette.length/4,block=1<<(8-(width&7));
  const attributes=new Uint8Array(count*4);
  const dirtDisplacementBias=parallax?new Uint8Array(count):undefined;
  for(let i=0;i<count;i++){
    const index=gpu.getUint8(color0+i*4+2);
    if(index>=block)return;
    attributes[i*4]=gpu.getUint8(color1+i*4);
    if(decal)attributes[i*4+1]=gpu.getUint8(color1+i*4+1);
    if(parallax){
      attributes[i*4+1]=gpu.getUint8(color1+i*4+2);
      attributes[i*4+3]=gpu.getUint8(color0+i*4+3);
    }
    if(dirtDisplacementBias)dirtDisplacementBias[i]=gpu.getUint8(color1+i*4+1);
    attributes[i*4+2]=index;
  }
  (appearance.terrainColors??=[]).push({first:base,values:attributes});
  // Keep material classification independent of the shared GPU attribute.
  if(dirtDisplacementBias)(appearance.parallaxDirtBias??=[]).push({first:base,values:dirtDisplacementBias});
  if(dirtUV)(appearance.terrainTintUV??=[]).push({first:base,values:dirtUV});
  return {textures:[diffuse0,diffuse1,material0,material1,control],palette,paletteKey,weightPower,dirt:dirt??undefined,parallax:height};
}

function materialUVCoordinates(gpu:DataView,vertex:number,count:number,descriptor:number){
  const uv=uvStream(gpu,vertex,count,descriptor);
  if(!uv)return;
  const values=new Float32Array(count*2);
  for(let i=0;i<values.length;i++){
    const at=uv.offset+i*uv.stride/2;
    const value=uv.stride===8?gpu.getFloat32(at,true):gpu.getInt16(at,true)*uv.scale;
    if(!Number.isFinite(value))return;
    values[i]=value;
  }
  return values;
}

function materialVertexChannels(gpu:DataView,vertex:number,count:number){
  const weightOffset=packedVertexColor(gpu,vertex,count,0x30);
  if(weightOffset===undefined)return;
  const coordinates=materialUVCoordinates(gpu,vertex,count,0x10);
  if(!coordinates)return;
  const weights=new Uint8Array(gpu.buffer,gpu.byteOffset+weightOffset,count*4).slice();
  return {coordinates,weights};
}

function packedNormalOffset(gpu:DataView,vertex:number,count:number){
  const channel=gpu.getUint32(vertex+8,true),offset=vertex+2*(channel>>>8);
  if(gpu.getUint32(vertex,true)!==0x4042||(channel&255)!==0x21||
    offset!==vertex+0x80+8*count||offset+4*count>gpu.byteLength)return;
  return offset;
}

function octahedralDirection(x:number,y:number,out:Float64Array){
  const z=1-Math.abs(x)-Math.abs(y);
  if(z<0){
    const folded=(1-Math.abs(y))*Math.sign(x);
    y=(1-Math.abs(x))*Math.sign(y);
    x=folded;
  }
  out[0]=x;out[1]=y;out[2]=z;
}

function packedNormal(packed:number,out:Float64Array){
  // The high bit selects 10:10 normal plus tangent angle, or an 8:8
  // normal followed by a separate 7:7 octahedral tangent.
  if(packed>>>31)octahedralDirection((packed&1023)/511.5-1,(packed>>>10&1023)/511.5-1,out);
  else octahedralDirection((packed&255)/127.5-1,(packed>>>8&255)/127.5-1,out);
}

function normalStream(gpu:DataView,vertex:number,count:number,placement:Placement){
  const offset=packedNormalOffset(gpu,vertex,count);
  if(offset===undefined)return;
  // The normal uses the inverse transpose of the position's scale and rotation.
  const [a,b,c,d,e,f,g,h,k]=placementNormalMatrix(placement);
  const values=new Int16Array(count*3);
  const direction=new Float64Array(3);
  let previous=-1,n0=0,n1=0,n2=0;
  for(let i=0,at=0;i<count;i++,at+=3){
    const packed=gpu.getUint32(offset+i*4,true);
    const normal=packed&(packed>>>31?0x800fffff:0xffff);
    if(normal!==previous){
      previous=normal;
      packedNormal(packed,direction);
      const x=direction[0],y=direction[1],z=direction[2];
      const nx=a*x+b*y+c*z,ny=d*x+e*y+f*z,nz=g*x+h*y+k*z;
      const factor=32767/Math.sqrt(nx*nx+ny*ny+nz*nz);
      n0=Math.round(nx*factor);n1=Math.round(ny*factor);n2=Math.round(nz*factor);
    }
    values[at]=n0;values[at+1]=n1;values[at+2]=n2;
  }
  return values;
}

const tangentCosines=new Float64Array(1024),tangentSines=new Float64Array(1024);
for(let i=0;i<tangentCosines.length;i++){
  const angle=i*(2*Math.PI/1023)-Math.PI;
  tangentCosines[i]=Math.cos(angle);tangentSines[i]=Math.sin(angle);
}

function terrainTangentStream(gpu:DataView,vertex:number,count:number,placement:Placement){
  const offset=packedNormalOffset(gpu,vertex,count);
  if(offset===undefined||!placement.linear&&placement.scale[0]!==placement.scale[1])return;
  const [a,b,c,d,e,f,g,h,k]=placementMatrix(placement.linear?placement:{...placement,scale:[1,1]},placement.position);
  const values=new Int16Array(count*4);
  const direction=new Float64Array(3);
  let previous=-1,t0=0,t1=0,t2=0,handedness=0;
  for(let i=0,at=0;i<count;i++,at+=4){
    const packed=gpu.getUint32(offset+i*4,true);
    if(packed!==previous){
      previous=packed;
      if(packed>>>31){
        packedNormal(packed,direction);
        let x=direction[0],y=direction[1],z=direction[2];
        const length=Math.sqrt(x*x+y*y+z*z);
        x/=length;y/=length;z/=length;
        const angle=packed>>>20&1023;
        const cosine=tangentCosines[angle],sine=tangentSines[angle],sign=z>=0?1:-1,denominator=z+sign;
        direction[0]=(sign*x*x/denominator-1)*cosine-x*y/denominator*sine;
        direction[1]=sign*x*y/denominator*cosine-(y*y/denominator-sign)*sine;
        direction[2]=sign*x*cosine-y*sine;
      }else{
        octahedralDirection((packed>>>16&127)/63.5-1,(packed>>>23&127)/63.5-1,direction);
      }
      const x=direction[0],y=direction[1],z=direction[2];
      const tx=a*x+b*y+c*z,ty=d*x+e*y+f*z,tz=g*x+h*y+k*z;
      const factor=32767/Math.sqrt(tx*tx+ty*ty+tz*tz);
      t0=Math.round(tx*factor);t1=Math.round(ty*factor);t2=Math.round(tz*factor);
      handedness=(packed>>>30&1)?32767:-32767;
    }
    values[at]=t0;values[at+1]=t1;values[at+2]=t2;values[at+3]=handedness;
  }
  return values;
}

function dynamicTangentStream(gpu:DataView,vertex:number,count:number,placement:Placement,descriptor=0x2c){
  // UV selector 2 uses attr6, exported from the second packed tangent stream.
  const token=gpu.getUint32(vertex+descriptor,true),offset=(token>>>8)*2;
  if((token&255)!==0x27||offset<0x80+count*8||vertex+offset+4*count>gpu.byteLength)return;
  const transform=placedVertex(placement.linear?placement:{...placement,scale:[1,1]},placement.position);
  const values=new Int16Array(count*4);
  for(let i=0;i<count;i++){
    const packed=gpu.getUint32(vertex+offset+i*4,true);
    const [x,y,z]=transform((packed&1023)/511.5-1,(packed>>>10&1023)/511.5-1,(packed>>>20&1023)/511.5-1);
    const length=placement.linear?Math.hypot(x,y,z)||1:1;
    values[i*4]=Math.round(Math.max(-1,Math.min(1,x/length))*32767);
    values[i*4+1]=Math.round(Math.max(-1,Math.min(1,y/length))*32767);
    values[i*4+2]=Math.round(Math.max(-1,Math.min(1,z/length))*32767);
    values[i*4+3]=Math.round(((packed>>>30)/1.5-1)*32767);
  }
  return values;
}

function placedVertex(placement:Placement,anchor:Vec3){
  const [a,b,c,d,e,f,g,h,k,dx,dy,dz]=placementMatrix(placement,anchor);
  return (x:number,y:number,z:number):Vec3=>[a*x+b*y+c*z+dx,d*x+e*y+f*z+dy,g*x+h*y+k*z+dz];
}

function hasMeshletTable(header:number){
  // Wreck and scrap drawables use additional flags with the same meshlet,
  // triangle and remap layout.
  const flags=header>>>16;
  return flags===0x8000||flags===0xc000||(flags&0xff00)===0xe000;
}

function appendGeometry(gpu:DataView,v:number,i:number,piece:number,
  placement:Placement,anchor:Vec3,vertices:number[],indices:number[]){
  const u=(at:number)=>gpu.getUint32(at,true);
  const {count,read}=positionStream(gpu,v);
  const base=vertices.length/4;
  const [a,b,c,d,e,f,g,h,k,dx,dy,dz]=placementMatrix(placement,anchor);
  const point=new Float64Array(3);
  for(let j=0;j<count;j++){
    read(j,point);
    const x=point[0],y=point[1],z=point[2];
    if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(z))throw new Error("Non-finite tunnel vertex.");
    vertices.push(a*x+b*y+c*z+dx,d*x+e*y+f*z+dy,g*x+h*y+k*z+dz,piece);
  }
  const flags=u(i),meshlets=flags&65535,triangles=u(i+4),remaps=u(i+8);
  const triangleStart=i+12+16*meshlets,remapStart=triangleStart+4*triangles;
  if(!hasMeshletTable(flags)||!meshlets||!triangles||remapStart+2*remaps>gpu.byteLength||u(i+16)!==0)
    throw new Error("Invalid tunnel meshlet table.");
  for(let j=0;j<meshlets;j++){
    const packed=u(i+16+j*16),next=j+1<meshlets?u(i+32+j*16):null;
    const t0=packed>>>16,t1=next===null?triangles:next>>>16;
    const v0=packed&65535,v1=next===null?remaps:next&65535;
    if(t0>=t1||t1>triangles||v0>=v1||v1>remaps)throw new Error("Invalid tunnel meshlet range.");
    for(let t=t0;t<t1;t++){
      const triangle=u(triangleStart+4*t);
      const p0=v0+(triangle&127),p1=v0+(triangle>>>7&127),p2=v0+(triangle>>>14&127);
      if(p0>=v1||p1>=v1||p2>=v1)throw new Error("Invalid tunnel triangle.");
      const i0=gpu.getUint16(remapStart+p0*2,true),i1=gpu.getUint16(remapStart+p1*2,true),i2=gpu.getUint16(remapStart+p2*2,true);
      if(i0>=count||i1>=count||i2>=count)throw new Error("Invalid tunnel vertex index.");
      indices.push(base+i0,base+i1,base+i2);
    }
  }
}

function positionStream(gpu:DataView,start:number):{count:number;read:(index:number,point:Float64Array)=>void}{
  const u=(at:number)=>gpu.getUint32(start+at,true);
  const f=(at:number)=>gpu.getFloat32(start+at,true);
  if(u(0)===0x3063&&(u(8)&255)===0x63){
    const end=(u(8)>>>8)*2,count=(end-0x60)/12;
    if(!Number.isInteger(count)||count<=0||start+end>gpu.byteLength)
      throw new Error("Invalid float position stream.");
    return {count,read:(i,point)=>{
      point[0]=f(0x60+i*12);point[1]=f(0x64+i*12);point[2]=f(0x68+i*12);
    }};
  }
  // Some parts omit channel 0x21 and store the position count in channel 0x26.
  const header=u(8)||u(4),count=((header>>>8)-64)/4;
  const alternate=u(8)===0&&(header&255)===0x26&&(
    u(12)===(8*count+64)*256+0x28||
    u(12)===(6*count+64)*256+0x28&&u(16)===(7*count+64)*256+0x28||
    u(12)===(6*count+64)*256+0x28&&u(16)===(7*count+64)*256+0x42&&
      u(24)===(2*count+64)*256+0x26&&u(32)===(3*count+64)*256+0x25&&u(48)===(5*count+64)*256+0x26||
    u(12)===(8*count+64)*256+0x42&&[0x28,0x42].includes(u(16)&255)&&u(16)>>>8===12*count+64);
  if(u(0)!==0x4042||(!alternate&&![0x21,0x27].includes(header&255))||
    !Number.isInteger(count)||count<=0||start+0x80+8*count>gpu.byteLength)
    throw new Error("Invalid gameplay vertex layout.");
  const ox=f(0x60),oy=f(0x64),oz=f(0x68),sx=f(0x70),sy=f(0x74),sz=f(0x78);
  // The selector identifies the authored axis stored in the 16-bit lane.
  const order=u(0x6c);
  if(order>2)throw new Error("Invalid gameplay position axis selector.");
  return {count,read:(i,point)=>{
    const lo=u(0x80+i*8),hi=u(0x84+i*8);
    const a=ox+(lo>>>8)*sx,b=oy+((lo&255)|((hi&65535)<<8))*sy,c=oz+(hi>>>16)*sz;
    point[0]=order===0?c:order===1?b:a;
    point[1]=order===1?c:b;
    point[2]=order===2?c:a;
  }};
}

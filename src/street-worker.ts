import { cachedMeshBytes, loadStreetAsset, loadStreetRegion, loadVegetationGeometry, structureBounds } from "./street-mesh";
import { broadleafCanopyCandidates, canopyAtlasRadius, canopyModel, distantCanopyAtlasCandidates, distantCanopyCandidates, distantCanopyRadius, nearbyVegetationSources, placeVegetation,
  nativePackedPlantCandidates, nativePackedRange, nativeVegetationRadius, readVegetationBatch, readVegetationGraphics, readVegetationHeader, readVegetationSource, scanVegetation, vegetationBatchId, vegetationCandidates, vegetationDistance,
  vegetationUpdateSize, visibleNativeCanopyCandidates,
  type VegetationModel, type VegetationSource } from "./street-vegetation";
import { loadStreetNavigation } from "./street-navigation";
import { StreetNavCatalog } from "./street-nav-catalog";
import { isStreetTexturePack } from "./street-textures";
import type { DynamicTerrainSource } from "./street-dynamic-terrain";
import { StreetMaterialLoader } from "./street-material-loader";
import { streetBudgets } from "./street-capacity";
import { openArchives, type ImportState } from "./recover";
import type { Event, Request } from "./protocol";
import { loadStreetOcean } from "./street-ocean";
import { StreetNavFloor } from "./street-nav-floor";
import { LocalStreetIndex } from "./street-index";
import { StreetAssetCache } from "./street-asset-cache";
import { indexFileName } from "./street-index-bundle";
import { openRpf9Preparer,rpf9ExecutableName } from "./rpf9-prepare";
import { StreetNativeCatalog, type NativeInteriorsQuery,type NativeInteriorsReply,type NativeCatalogOpen, type NativeCatalogQuery, type NativeCatalogCancel,type NativeCatalogCancelNear, type NativeCatalogReply,type NativeWorldCollisionQuery,type NativeWorldCollisionReply,
  type NativeVegetation, type NativeVegetationQuery, type NativeVegetationReply, type NativeVegetationSource,
  type NativePackedModelsQuery, type NativePackedModelsReply } from "./street-native-catalog";
import { readIndexedGraphics, type IndexedVegetation } from "./street-index-scan";
import { prepareStreetGraphics } from "./street-graphics";
import type { VegetationRange } from "./street-vegetation";
import type { StreetAsset, StreetChunk } from "./street-mesh";
import { walkFloor } from "./walk-surface";
import { streetFrustum, streetLoadPriority, streetViewChanged, type StreetStreamView } from "./street-priority";
import { bridgeDeckProxy, bridgeHorizon, streetLodInRange, districtAggregate, lowSkylineHeight, lowSkylineHorizon,
  prefabBridgeSkyline, roadBridgeDrawable, tallSkylineHeight } from "./street-lod";
import { aerialSkylineRadius, skylineRadius } from "./street-grid";
import type { DetailCell } from "./street-grid";
import type { Bounds } from "./native-spatial";
import { simplifySkyline } from "./street-horizon";
import { loadStreetEnvironment } from "./street-environment";
import { withStreetSkyScattering } from "./street-sky-scattering";
import { loadStreetWaterOptics } from "./street-water-optics";
import { readStreetWaterMaterials } from "./street-water-materials";
import { openStreetWaterResources } from "./street-water-resource";
import { buildStreetWaterTileIndex, loadStreetWaterTileRegion } from "./street-water-tiles";
import { streetCloudNoise } from "./street-cloud-noise";
import type {CloudAssetRequest,CloudAssetReply} from "./street-cloud-worker";
import { bakeCanopyAtlas,canopyAtlasModel,canopyAtlasPrefix,nativeCanopyAtlasPrefix,nativeCanopyModel,reconstructNativeCanopy } from "./street-canopy-atlas";
import {packedImpostorBatchInRange,packedImpostorCoverage,packedImpostorView,type ImpostorCoverage} from "./street-packed-impostors";
import { Archive } from "./archive";
import { drawableNameKey } from "./street-drawable-identity";
import { openStreetImposterMetadata, type ImposterAtlasRecord } from "./street-imposter-metadata";
import { imposterAtlasPackPath } from "./texture-pool-blocks";


type HorizonEntry={bounds:Bounds;cost:number;radius:number};

export function createStreetWorker(send:(event:Event,transfer?:Transferable[])=>void){
  let state:Pick<ImportState,"archives"|"packs">|undefined;
  let files:Record<string,File>;
  let assetCache:StreetAssetCache|undefined;
  let closeGraphics:(()=>void)|undefined;
  let materials:StreetMaterialLoader|undefined;
  let navigation:Promise<StreetNavCatalog|undefined>|undefined;
  let environment:ReturnType<typeof loadStreetEnvironment>|undefined;
  let environmentPrepare:ReturnType<typeof openRpf9Preparer>|undefined;
  let waterSourcesRequested=false;
  let cloudNoiseRequested=false;
  let cloudWorker:Worker|undefined;
  let waterTiles: {
    source:Parameters<typeof buildStreetWaterTileIndex>[0];
    members:Parameters<typeof buildStreetWaterTileIndex>[3];
    optics?:NonNullable<Awaited<ReturnType<typeof loadStreetWaterOptics>>>;
    index?:NonNullable<Awaited<ReturnType<typeof buildStreetWaterTileIndex>>>;
    cell?:string;
    timer?:ReturnType<typeof setTimeout>;
  }|undefined;
  let ocean:Promise<Awaited<ReturnType<typeof loadStreetOcean>>|undefined>|undefined;
  let floors=new StreetNavFloor();
  const dynamicTerrain=new Map<string,{mesh:string;source:DynamicTerrainSource}>();
  let streetStructureMaterials=false;
  let streetRegionSerial=0;
  const horizon=new Map<string,HorizonEntry>();
  const residentStructures=new Map<string,Bounds>();
  let streetNavigationSerial=0;
  let vegetationSerial=0;
  let streamView:StreetStreamView|undefined;
  let refreshOuterSkyline:((view:StreetStreamView,settled?:boolean)=>void)|undefined;
  let outerSkylineView:StreetStreamView|undefined;
  let skylineSettleTimer:ReturnType<typeof setTimeout>|undefined;
  let spawnSerial=0;
  const spawnSurfaces=new Map<string,Promise<StreetChunk[]>>();
  let localIndex:LocalStreetIndex|undefined;
  let catalogWorker:Worker|undefined;
  let collisionHandoffWorker:Worker|undefined;
  let terrainCatalog:StreetNativeCatalog|undefined;
  let catalogId=0;
  let interiorRequest:{id:number;eye:StreetStreamView["eye"]}|undefined;
  const residentInteriors=new Set<string>();
  const catalogRequests=new Map<boolean,{id:number;radius:number;queuedAt:number;failed?:()=>void;
    finish:(assets:StreetAsset[])=>void}>();
  const nativeNearRadius=110;
  let plantQuery=0,finishPlants:((result?:NativeVegetation)=>void)|undefined;
  let packedModelQuery=0,finishPackedModels:((models?:Map<bigint,VegetationModel>)=>void)|undefined;
  type PlantArea={point:readonly [number,number];altitude?:number;query:Promise<NativeVegetation|undefined>};
  let nativePlantArea:PlantArea|undefined,nativeCanopyArea:PlantArea|undefined;
  type CatalogArea={file:Blob;point:readonly [number,number];radius:number;near:Promise<StreetAsset[]>;movingUntil:number;
    waitingForWide:boolean;horizon?:{altitude:number;radius:number;assets:Promise<StreetAsset[]>}};
  let catalogArea:CatalogArea|undefined;
  let preparedEntry:{file:Blob;point:CatalogArea["point"];id:number;assets:Promise<StreetAsset[]>;
    status:{failed:boolean}}|undefined;
  let wideJob:CatalogArea|undefined;
  let wideCache:{point:CatalogArea["point"];radius:number;assets:StreetAsset[]}|undefined;
  let wideSettleTimer:ReturnType<typeof setTimeout>|undefined;
  let lastRegion:Extract<Request,{kind:"streetRegion"}>|undefined;
  let lastVegetation:Extract<Request,{kind:"streetVegetation"}>|undefined;
  let nearVegetation:string[]|undefined;
  let scanningRoofs=false;
  let regionBusy=false,vegetationBusy=false,indexChanged=false;
  const regionWaiters=new Set<()=>void>();
  function resumeVegetation(){
    for(const resume of regionWaiters)resume();
    regionWaiters.clear();
  }
  let pendingNativeRefresh:CatalogArea|undefined;
  let refreshNearbyTimer:ReturnType<typeof setTimeout>|undefined;
  function openTerrainCatalog(archive:Archive){
    const executable=files[rpf9ExecutableName],common=files["common.rpf"];
    if(!executable||!common)return;
    return terrainCatalog??=new StreetNativeCatalog(archive.file,executable,common);
  }

  function terrainReader(archive:Archive,active=()=>state?.archives.get("levels.rpf")===archive){
    const catalog=openTerrainCatalog(archive);
    if(!catalog)return;
    return async (point:readonly [number,number],reach:number,detail:number,cells?:readonly DetailCell[])=>
      (await catalog.queryTerrain(point,reach,detail,active,cells)).assets;
  }

  function openNavigation(){
    const executable=files[rpf9ExecutableName];
    if(!executable)return Promise.resolve(undefined);
    return navigation??=openArchives(files,path=>path==="navmeshes.rpf",false).then(({archives})=>{
      const archive=archives.get("navmeshes.rpf");
      return archive&&new StreetNavCatalog(archive,executable);
    });
  }

  function streamWaterTiles(){
    const tiles=waterTiles,point=streamView?.eye??lastRegion?.point;
    if(!tiles||!point||!lastRegion)return;
    if(!tiles.index){
      if(regionBusy||!tiles.optics)return;
      const optics=tiles.optics,cache=assetCache;
      tiles.optics=undefined;
      const current=()=>tiles===waterTiles;
      const id=`optics-v2:${optics.bounds.join(",")}:${optics.tileSize}`;
      void (async()=>{
        const saved=await cache?.get("waterIndex",id);
        if(!current())return;
        tiles.index=saved??await buildStreetWaterTileIndex(tiles.source,optics,current,tiles.members);
        if(!current()||!tiles.index)return;
        if(!saved)cache?.put("waterIndex",id,tiles.index,tiles.index.offsets.byteLength);
        streamWaterTiles();
      })().catch(()=>{});
      return;
    }
    const index=tiles.index,[west,north]=index.bounds;
    const x=Math.floor((point[0]-west)/index.tileSize),y=Math.floor((north-point[1])/index.tileSize);
    const cell=`${x},${y}`;
    if(cell===tiles.cell)return;
    tiles.cell=cell;
    clearTimeout(tiles.timer);
    const timer=setTimeout(()=>{
      const current=()=>tiles===waterTiles&&tiles.cell===cell&&tiles.timer===timer&&Boolean(lastRegion);
      if(!current()){if(waterTiles===tiles&&tiles.timer===timer)tiles.cell=undefined;return;}
      void loadStreetWaterTileRegion(tiles.source,index,[x,y],current).then(optics=>{
        if(!current()){
          if(waterTiles===tiles&&tiles.timer===timer)tiles.cell=undefined;
          return;
        }
        send({kind:"streetWaterTileRegion",optics},optics?[optics.scattering.bytes.buffer,optics.extinction.bytes.buffer]:undefined);
      }).catch(()=>{});
    },180);
    tiles.timer=timer;
  }
  function horizonDistance([x,y]:readonly [number,number],[left,bottom,,right,top]:Bounds){
    return Math.hypot(Math.max(left-x,0,x-right),Math.max(bottom-y,0,y-top));
  }
  function refreshNearby(){
    if((!indexChanged&&!pendingNativeRefresh)||refreshNearbyTimer||!lastRegion||catalogArea?.waitingForWide)return;
    refreshNearbyTimer=setTimeout(()=>{
      refreshNearbyTimer=undefined;
      if(!lastRegion||catalogArea?.waitingForWide)return;
      if(pendingNativeRefresh!==catalogArea)pendingNativeRefresh=undefined;
      const indexReady=indexChanged&&!vegetationBusy;
      if(regionBusy||(!pendingNativeRefresh&&!indexReady)){refreshNearby();return;}
      // Wider native geometry has its own placement coverage. It can install
      // while the destination's canopy and grass batches are still streaming.
      pendingNativeRefresh=undefined;
      if(indexReady)indexChanged=false;
      reader.handle(lastRegion);
      if(indexReady&&lastVegetation?.point)reader.handle({...lastVegetation,lookOnly:undefined});
    },900);
  }
  const vegetationGeometry=new Map<string,ReturnType<typeof loadVegetationGeometry>>();
  function vegetationModel(key:string,archive:Archive,model:VegetationModel,coarse:boolean){
    const cached=vegetationGeometry.get(key);
    if(cached)return cached;
    // Ground, distant, and packed batches can reuse the same drawable
    // throughout the selected folder's lifetime.
    const pending=loadVegetationGeometry(archive,model,true,coarse);
    vegetationGeometry.set(key,pending);
    void pending.catch(()=>{
      if(vegetationGeometry.get(key)===pending)vegetationGeometry.delete(key);
    });
    return pending;
  }
  const canopyAtlases=new Map<string,ReturnType<typeof bakeCanopyAtlas>>();
  const packedAtlasGeometry=new Map<bigint,{model:StreetChunk;texture:string}>();
  const detailedPlants=new Map<string,ImpostorCoverage>();
  let nativeImposters:ReturnType<typeof openStreetImposterMetadata>|undefined;
  let nativeAtlasTable:Promise<Map<bigint,ImposterAtlasRecord>|undefined>|undefined;
  function imposterMetadata(){
    const common=files["common.rpf"],data=files["data.rpf"],exe=files[rpf9ExecutableName];
    if(!common||!data||!exe||!files[imposterAtlasPackPath])return;
    return nativeImposters??=openRpf9Preparer(new Archive(rpf9ExecutableName,exe))
      .then(prepare=>openStreetImposterMetadata(new Archive("common.rpf",common),new Archive("data.rpf",data),prepare));
  }
  function loadNativeCanopy(modelKey:string){
    const metadata=imposterMetadata();
    if(!metadata)return;
    const texture=nativeCanopyAtlasPrefix+modelKey;
    const key=texture.slice(canopyAtlasPrefix.length);
    let cached=canopyAtlases.get(key);
    canopyAtlases.delete(key);
    if(!cached){
      const cache=assetCache,loader=materials;
      nativeAtlasTable??=metadata.then(metadata=>metadata.atlasTable()).catch(()=>undefined);
      const table=nativeAtlasTable;
      cached=(async()=>{
        const record=(await table)?.get(BigInt("0x"+modelKey));
        if(!record)return;
        const geometry=nativeCanopyModel(record,modelKey);
        if(!geometry)return;
        const {textures:ids}=record;
        const cacheKey=`false:${texture}`;
        let image=await cache?.get("texture",cacheKey);
        if(!image){
          const [baseMips,chroma,normal]=await Promise.all([
            loader?.readImposterMips(ids[0],16),loader?.readImposterMips(ids[2],8),
            loader?.readImposterMips(ids[1],8).catch(()=>[])
          ]);
          if(!baseMips?.length||!chroma?.length)return;
          image=reconstructNativeCanopy(baseMips[0],chroma[0],normal?.[0]);
          if(image){
            const authoredMips=[];
            // Advance each channel from its own admitted top level. Chroma
            // can be half-size, and reconstruction samples normalized UVs.
            for(let mip=1;mip<baseMips.length;mip++){
              const level=reconstructNativeCanopy(baseMips[mip],chroma[mip]??chroma.at(-1)!,
                normal?.[mip]??normal?.at(-1));
              if(!level)break;
              authoredMips.push(level);
            }
            if(authoredMips.length)image.authoredMips=authoredMips;
            const bytes=authoredMips.reduce((size,level)=>size+level.rgba.byteLength,image.rgba.byteLength);
            if(cache===assetCache)cache?.put("texture",cacheKey,image,bytes);
          }
        }
        return image?{model:geometry,texture,image}:undefined;
      })().catch(()=>undefined);
    }
    canopyAtlases.set(key,cached);
    if(canopyAtlases.size>96)canopyAtlases.delete(canopyAtlases.keys().next().value!);
    return cached;
  }
  const vegetationHeaders=new Map<number,Promise<{data:DataView;source:VegetationSource}>>();
  function sendStreetRegion(event:Extract<Event,{kind:"streetRegion"|"streetRegionBatch"|"streetNavigation"|"streetVegetation"|"streetInteriors"}>){
    if(event.kind==="streetRegion"||event.kind==="streetRegionBatch")
      event.sentAt=performance.timeOrigin+performance.now();
    if(event.kind==="streetRegion"){
      const wanted=new Set(event.wanted);
      for(const [id,entry] of dynamicTerrain)if(!wanted.has(entry.mesh))dynamicTerrain.delete(id);
      for(const id of residentStructures.keys())if(!wanted.has(id))residentStructures.delete(id);
    }
    send(event,event.meshes.flatMap(mesh=>{
      if((event.kind==="streetRegion"||event.kind==="streetRegionBatch")&&mesh.vegetation===undefined&&
        (mesh.kind==="structure"||mesh.kind==="prop"||mesh.kind==="foliage")){
        const [x,y,z]=mesh.origin,[left,bottom,low,right,top,high]=mesh.bounds;
        residentStructures.set(mesh.id,[left+x,bottom+y,low+z,right+x,top+y,high+z]);
      }
      if(mesh.kind==="terrain"&&!mesh.replaces&&!mesh.visualOnly&&lastRegion&&
        Math.abs(Math.floor(lastRegion.point[0]/128)-mesh.origin[0]/128)<=1&&
        Math.abs(Math.floor(lastRegion.point[1]/128)-mesh.origin[1]/128)<=1)floors.remember(mesh);
      if(mesh.dynamic){
        for(const source of mesh.dynamic)dynamicTerrain.set(source.control.id,{mesh:mesh.id,source});
        delete mesh.dynamic;
      }
      const buffers=[mesh.vertices.buffer,mesh.indices.buffer];
      if(mesh.appearance)buffers.push(mesh.appearance.uv.buffer);
      if(mesh.normals)buffers.push(mesh.normals.buffer);
      if(mesh.road)buffers.push(mesh.road.uv.buffer,mesh.road.weights.buffer);
      if(mesh.terrainColors)buffers.push(mesh.terrainColors.buffer);
      if(mesh.terrainTintUV)buffers.push(mesh.terrainTintUV.buffer);
      if(mesh.terrainTangents)buffers.push(mesh.terrainTangents.buffer);
      if(mesh.terrainSecondaryTangents)buffers.push(mesh.terrainSecondaryTangents.buffer);
      if(mesh.decalOpacity)buffers.push(mesh.decalOpacity.buffer);
      if(mesh.decalBlend)buffers.push(mesh.decalBlend.buffer);
      if(mesh.instances)buffers.push(mesh.instances.poses.buffer);
      if(mesh.instances?.ordinals)buffers.push(mesh.instances.ordinals.buffer);
      if(mesh.instances?.tintSelectors)buffers.push(mesh.instances.tintSelectors.buffer);
      if(mesh.instances?.propLayerControls)buffers.push(mesh.instances.propLayerControls.buffer);
      if(mesh.instances?.propDirtControls)buffers.push(mesh.instances.propDirtControls.buffer);
      if(mesh.collision)buffers.push(mesh.collision.vertices.buffer,mesh.collision.indices.buffer);
      return buffers;
    }));
  }

  function attachIndex(file?:File,refresh=false){
    const levels=state?.archives.get("levels.rpf"),executable=files[rpf9ExecutableName];
    if(!levels||!executable)return;
    localIndex?.close();
    localIndex=new LocalStreetIndex(levels,(status,nearbyChanged)=>{
      send({kind:"streetIndex",status});
      if(files[indexFileName]&&nearbyChanged&&(!status.portable||!status.done||refresh)){indexChanged=true;refreshNearby();}
    },executable,file);
    void localIndex.prepare();
  }

  function ensureNativeCatalog(file:Blob){
    const executable=files[rpf9ExecutableName];
    if(!executable)return;
    if(!catalogWorker){
      try{catalogWorker=new Worker(new URL("./street-scan-worker.js",import.meta.url),{type:"module"});}
      catch{return;}
      const worker=catalogWorker;
      worker.onmessage=({data}:MessageEvent<NativeCatalogReply|NativeVegetationReply|NativePackedModelsReply|NativeInteriorsReply|NativeWorldCollisionReply>)=>{
        if(catalogWorker!==worker)return;
        if("worldCollision" in data){
          const archive=state?.archives.get("levels.rpf");
          if(archive?.file===file)openTerrainCatalog(archive)?.useRegisteredCollisionSources(data.worldCollision);
          return;
        }
        if("interiors" in data){
          if(interiorRequest?.id===data.id){
            if(data.assets)void deliverInteriors(data.id,data.assets,data.collision??[]);
            else interiorRequest=undefined;
          }
          return;
        }
        if("plants" in data){
          if(data.id===plantQuery){finishPlants?.(data.result);finishPlants=undefined;}
          return;
        }
        if("packedModels" in data){
          if(data.id===packedModelQuery){finishPackedModels?.(data.models);finishPackedModels=undefined;}
          return;
        }
        for(const [lane,request] of catalogRequests){
          if(request.id!==data.id)continue;
          catalogRequests.delete(lane);
          if("assets" in data)send({kind:"streetCatalog",radius:request.radius,assets:data.assets.length,bytes:data.bytes,
            queuedAt:request.queuedAt,startedAt:data.startedAt,registrationMs:data.registrationMs,queryMs:data.queryMs});
          else request.failed?.();
          request.finish("assets" in data?data.assets:[]);
          break;
        }
      };
      worker.onerror=event=>{
        event.preventDefault();
        if(catalogWorker!==worker)return;
        worker.terminate();catalogWorker=undefined;
        catalogRequests.get(false)?.failed?.();
        cancelCatalogRequests();
        finishPlants?.();finishPlants=undefined;nativePlantArea=nativeCanopyArea=undefined;
      };
      catalogWorker.postMessage({catalog:"open",file,executable,common:files["common.rpf"]} satisfies NativeCatalogOpen);
    }
    return catalogWorker;
  }

  function requestInteriors(){
    const archive=state?.archives.get("levels.rpf"),eye=streamView?.eye;
    if(!archive||!eye||!lastRegion||lastRegion.karst)return;
    if(interiorRequest&&Math.hypot(...eye.map((v,i)=>v-interiorRequest!.eye[i]))<8)return;
    const worker=ensureNativeCatalog(archive.file);
    if(!worker)return;
    const id=++catalogId;
    interiorRequest={id,eye};
    worker.postMessage({catalog:"interiors",id,eye,radius:32} satisfies NativeInteriorsQuery);
  }

  async function deliverInteriors(id:number,assets:StreetAsset[],collision:StreetChunk[]){
    const archive=state?.archives.get("levels.rpf"),view=streamView;
    if(!archive||!view)return;
    const active=()=>lastRegion&&interiorRequest?.id===id&&state?.archives.get("levels.rpf")===archive;
    if(!active())return;
    const newCollision=collision.filter(mesh=>!residentInteriors.has(mesh.id));
    for(const mesh of newCollision)residentInteriors.add(mesh.id);
    if(newCollision.length)sendStreetRegion({kind:"streetInteriors",serial:lastRegion!.serial,wanted:null,meshes:newCollision});
    const priority=streetLoadPriority(view);
    const pending=assets.filter(asset=>asset.id&&!residentInteriors.has(asset.id)).map(asset=>{
      const [x,y,z]=asset.placement!.position;
      return {asset,score:priority(structureBounds(asset)??[x,y,z,x,y,z])};
    }).sort((a,b)=>a.score-b.score);
    for(let i=0;i<pending.length&&active();i+=streetBudgets.geometryReads){
      const meshes=(await Promise.all(pending.slice(i,i+streetBudgets.geometryReads).map(({asset})=>
        loadStreetAsset(archive,asset,true).catch(()=>undefined)))).flatMap(mesh=>mesh?[mesh]:[]);
      if(!active())return;
      for(const mesh of meshes)residentInteriors.add(mesh.id);
      if(meshes.length)sendStreetRegion({kind:"streetInteriors",serial:lastRegion!.serial,wanted:null,meshes});
    }
    if(!active())return;
    const wanted=new Set(assets.flatMap(({id})=>id&&residentInteriors.has(id)?[id]:[]));
    for(const {id} of collision)wanted.add(id);
    for(const id of residentInteriors)if(!wanted.has(id))residentInteriors.delete(id);
    const complete=assets.every(({id})=>id!==undefined&&wanted.has(id));
    sendStreetRegion({kind:"streetInteriors",serial:lastRegion!.serial,wanted:[...wanted],meshes:[],complete});
  }

  function nativePlants(file:Blob,point:readonly [number,number],altitude?:number){
    const old=altitude===undefined?nativePlantArea:nativeCanopyArea;
    if(old&&old.point[0]===point[0]&&old.point[1]===point[1]&&old.altitude===altitude)return old.query;
    const worker=ensureNativeCatalog(file);
    if(!worker)return;
    finishPlants?.();
    const id=++plantQuery;
    const query=new Promise<NativeVegetation|undefined>(resolve=>{
      finishPlants=resolve;
      worker.postMessage({catalog:"plants",id,point,altitude} satisfies NativeVegetationQuery);
    });
    const area={point,altitude,query};
    if(altitude===undefined)nativePlantArea=area;
    else nativeCanopyArea=area;
    void query.catch(()=>undefined).then(result=>{
      if(result)return;
      if(nativePlantArea===area)nativePlantArea=undefined;
      if(nativeCanopyArea===area)nativeCanopyArea=undefined;
    });
    return query;
  }

  function cancelCatalogRequests(){
    clearTimeout(wideSettleTimer);
    pendingNativeRefresh=undefined;
    wideJob=wideCache=undefined;
    for(const {finish} of catalogRequests.values())finish([]);
    catalogRequests.clear();
    preparedEntry=undefined;
    finishPackedModels?.();finishPackedModels=undefined;
    interiorRequest=undefined;
  }

  function nativePackedModels(file:Blob,keys:bigint[]){
    const worker=ensureNativeCatalog(file);
    if(!worker)return;
    finishPackedModels?.();
    const id=++packedModelQuery;
    return new Promise<Map<bigint,VegetationModel>|undefined>(resolve=>{
      finishPackedModels=resolve;
      worker.postMessage({catalog:"packedModels",id,keys} satisfies NativePackedModelsQuery);
    });
  }

  function nativeCatalog(file:Blob,point:readonly [number,number],radius:number,altitude?:number,wide=false,
    failed?:()=>void){
    const worker=ensureNativeCatalog(file);
    if(!worker)return Promise.resolve([]);
    catalogRequests.get(wide)?.finish([]);
    const id=++catalogId;
    return new Promise<StreetAsset[]>(resolve=>{
      catalogRequests.set(wide,{id,radius,queuedAt:performance.timeOrigin+performance.now(),finish:resolve,failed});
      worker.postMessage({catalog:"query",id,point,radius,altitude,wide:wide?true:undefined} satisfies NativeCatalogQuery);
    });
  }

  function cancelPreparedEntry(){
    const prepared=preparedEntry, request=catalogRequests.get(false);
    preparedEntry=undefined;
    if(!prepared||request?.id!==prepared.id)return;
    catalogRequests.delete(false);
    request.finish([]);
    catalogWorker?.postMessage({catalog:"cancelNear",id:prepared.id} satisfies NativeCatalogCancelNear);
  }

  function takePreparedEntry(file:Blob,point:CatalogArea["point"],radius:number){
    const prepared=preparedEntry;
    if(!prepared)return;
    if(prepared.file===file&&radius===nativeNearRadius&&
      prepared.point[0]===point[0]&&prepared.point[1]===point[1]){
      preparedEntry=undefined;
      const region=lastRegion;
      return prepared.assets.then(assets=>{
        if(prepared.status.failed&&lastRegion===region&&state?.archives.get("levels.rpf")?.file===file&&
          !catalogRequests.has(false))return nativeCatalog(file,point,radius);
        return assets;
      });
    }
    cancelPreparedEntry();
  }

  function nativeStructures(file:Blob,point:readonly [number,number],radius:number,waitForWide:boolean){
    const nearRadius=Math.min(radius,nativeNearRadius);
    const saved=wideCache;
    const savedDistance=saved?Math.hypot(point[0]-saved.point[0],point[1]-saved.point[1]):Infinity;
    const exact=savedDistance===0&&saved?.radius===radius?saved:undefined;
    // Reuse only when the previous circle contains the entire requested near
    // circle. Partial coverage farther out cannot prove absence there.
    const overlap=exact?.assets??(saved&&savedDistance<=saved.radius-nearRadius?saved.assets.filter(({center:[x,y]})=>
      Math.hypot(x-point[0],y-point[1])<=radius):undefined);
    let area=catalogArea;
    if(!area||area.point[0]!==point[0]||area.point[1]!==point[1]||area.radius!==radius){
      clearTimeout(wideSettleTimer);
      const displacement=area?Math.hypot(point[0]-area.point[0],point[1]-area.point[1]):Infinity;
      // Nearby region crossings benefit from finishing a smaller request
      // while the full area would still be several regions behind.
      const movingUntil=displacement>0&&displacement<=128?performance.now()+2500:0;
      const prepared=takePreparedEntry(file,point,nearRadius);
      area={file,point,radius,near:overlap?Promise.resolve(overlap):prepared??nativeCatalog(file,point,nearRadius),
        movingUntil,waitingForWide:!exact&&waitForWide&&radius>nearRadius};
      catalogArea=area;
      if(radius>nearRadius&&!exact)requestWideCatalog(area);
    }
    if(exact)return {assets:exact.assets,wide:true};
    return {assets:overlap??area.near,wide:false};
  }

  function requestWideCatalog(area:CatalogArea){
    void area.near.then(async ()=>{
      if(catalogArea!==area||wideJob||!lastRegion)return;
      const radius=performance.now()<area.movingUntil?Math.min(240,area.radius):area.radius;
      wideJob=area;
      const assets=await nativeCatalog(area.file,area.point,radius,undefined,true);
      if(wideJob!==area)return;
      wideJob=undefined;
      area.waitingForWide=false;
      if(assets.length){
        wideCache={point:area.point,radius,assets};
        if(catalogArea===area){pendingNativeRefresh=area;refreshNearby();}
      }
      if(catalogArea&&catalogArea!==area&&lastRegion)requestWideCatalog(catalogArea);
      else if(radius<area.radius)wideSettleTimer=setTimeout(()=>requestWideCatalog(area),
        Math.max(0,area.movingUntil-performance.now()));
    });
  }

  const reader={
    async roofs(point:readonly [number,number],radius:number,active:()=>boolean){
      if(!localIndex)attachIndex(files[indexFileName]);
      const index=localIndex;
      if(!index)return {assets:[],retry:false};
      scanningRoofs=true;
      if(!lastRegion){
        const archive=state?.archives.get("levels.rpf");
        const ground=archive&&terrainReader(archive,active)?.(point,1,-1);
        index.prioritize(point,[],undefined,ground);
      }
      index.start();
      await index.ready();
      const isRoof=(name:string)=>/(?:^|_)roofs?(?=_|\d|$)/i.test(name)&&
        !/(?:^|_)(?:ladder|rail|ctrl|cln)(?:_|$)/i.test(name);
      const archive=state?.archives.get("levels.rpf");
      const catalog=archive&&openTerrainCatalog(archive);
      const [indexed,native]=await Promise.all([
        index.buildings(point,radius,active,isRoof),
        catalog?.query(point,radius,active).then(result=>result.assets.filter(asset=>isRoof(asset.name)))??[],
      ]);
      const assets=[...new Map([...indexed,...native].map(asset=>[`${asset.instance[0]}:${asset.at}`,asset])).values()];
      return {assets,retry:!index.complete&&!index.failed};
    },
    stopRoofs(){
      scanningRoofs=false;
      if(!lastRegion)localIndex?.pause();
    },
    open(archives:Pick<ImportState,"archives"|"packs">,inputs:Record<string,File>,reloading=false){
      state=archives;
      horizon.clear();
      residentStructures.clear();
      closeGraphics?.();
      const levels=archives.archives.get("levels.rpf");
      closeGraphics=levels&&prepareStreetGraphics(levels);
      assetCache=reloading?undefined:new StreetAssetCache(inputs);
      files=inputs;materials=new StreetMaterialLoader(files,assetCache);navigation=undefined;ocean=undefined;
      environment=undefined;environmentPrepare=undefined;waterSourcesRequested=false;cloudNoiseRequested=false;
      cloudWorker?.terminate();cloudWorker=undefined;
      clearTimeout(waterTiles?.timer);
      waterTiles=undefined;
      floors=new StreetNavFloor();
      dynamicTerrain.clear();
      streetStructureMaterials=Object.keys(inputs).some(isStreetTexturePack);
      vegetationGeometry.clear();
      canopyAtlases.clear();
      packedAtlasGeometry.clear();
      detailedPlants.clear();
      nativeImposters=undefined;
      nativeAtlasTable=undefined;
      vegetationHeaders.clear();
      streamView=undefined;
      residentInteriors.clear();
      refreshOuterSkyline=undefined;
      outerSkylineView=undefined;
      clearTimeout(skylineSettleTimer);
      spawnSurfaces.clear();
      localIndex?.close();
      localIndex=undefined;
      catalogWorker?.terminate();catalogWorker=collisionHandoffWorker=undefined;
      terrainCatalog=undefined;
      finishPlants?.();finishPlants=undefined;nativePlantArea=nativeCanopyArea=undefined;
      catalogArea=undefined;
      cancelCatalogRequests();
      lastRegion=undefined;
      lastVegetation=undefined;
      regionBusy=false;
      resumeVegetation();
      nearVegetation=undefined;
      scanningRoofs=false;
      if(inputs[indexFileName])attachIndex(inputs[indexFileName]);
    },
    handle(request:Request){
      if(request.kind==="streetIndexFile"){
        cancelPreparedEntry();
        files[indexFileName]=request.file;
        attachIndex(request.file,true);
        if(lastRegion||scanningRoofs)localIndex?.start();
        return true;
      }
      if(request.kind==="streetStreamView"){
        streamView=request.view;
        requestInteriors();
        clearTimeout(skylineSettleTimer);
        if(!regionBusy&&refreshOuterSkyline){
          refreshOuterSkyline(streamView);
          const view=streamView;
          skylineSettleTimer=setTimeout(()=>{if(!regionBusy)refreshOuterSkyline?.(view,true);},180);
        }
        streamWaterTiles();
        return true;
      }
      if(request.kind==="streetEnvironment"){
        const currentFiles=files;
        if(request.cloudNoise&&!cloudNoiseRequested){
          cloudNoiseRequested=true;
          setTimeout(()=>{
            if(files!==currentFiles)return;
            const noise=streetCloudNoise();
            send({kind:"streetCloudNoise",noise},[noise.buffer]);
          },100);
        }
        const common=currentFiles["common.rpf"],exe=currentFiles[rpf9ExecutableName];
        if(exe)environmentPrepare??=openRpf9Preparer(new Archive(rpf9ExecutableName,exe));
        const prepare=environmentPrepare;
        environment??=(common&&prepare?prepare
          .then(reader=>loadStreetEnvironment(new Archive("common.rpf",common),reader)).catch(()=>undefined):
          Promise.resolve(undefined));
        void environment.then(environment=>{
          if(files!==currentFiles)return;
          send({kind:"streetEnvironment",environment});
          if(waterSourcesRequested)return;
          waterSourcesRequested=true;
          const textureFile=currentFiles["textures.rpf"];
          if(request.nativeClouds&&environment?.nativeClouds&&textureFile&&exe){
            const names=["cloud_map_lut","weather_gradient",...environment.clouds.flatMap(layer=>layer.maps??[])];
            try{
              const worker=new Worker(new URL("./street-cloud-worker.js",import.meta.url),{type:"module"});
              cloudWorker=worker;
              const finish=()=>{worker.terminate();if(cloudWorker===worker)cloudWorker=undefined;};
              worker.onmessage=({data}:MessageEvent<CloudAssetReply>)=>{
                finish();
                if(files===currentFiles&&data.assets){
                  const {assets}=data;
                  send({kind:"streetCloudAssets",assets},[assets.noise.buffer,...assets.maps.map(map=>map.bytes.buffer)]);
                }
              };
              worker.onerror=finish;
              worker.postMessage({textures:textureFile,exe,names} satisfies CloudAssetRequest);
            }catch{
              cloudWorker?.terminate();cloudWorker=undefined;
            }
          }
          if(request.hdrSky&&environment)void withStreetSkyScattering(environment,()=>files===currentFiles).then(lighting=>{
            if(lighting&&files===currentFiles)send({kind:"streetEnvironment",environment:lighting});
          }).catch(()=>{});
          const grids=environment?.waterGrids,found=state?.archives.get("textures.rpf");
          const textures=found?Promise.resolve(found):openArchives(currentFiles,path=>path==="textures.rpf",false,false)
            .then(({archives})=>archives.get("textures.rpf"));
          if(!prepare)return;
          const resources=Promise.all([textures,prepare]).then(([source,reader])=>
            source&&files===currentFiles?{source,...openStreetWaterResources(source,reader)}:undefined);
          if(grids)void resources.then(async resource=>{
            if(!resource||files!==currentFiles)return;
            const {source,read,tiles}=resource;
            const optics=await loadStreetWaterOptics(read,grids);
            if(!optics||files!==currentFiles)return;
            if(optics.tileSize)waterTiles={source,members:tiles,optics:structuredClone(optics)};
            send({kind:"streetWaterOptics",optics},
              [optics.scattering.bytes.buffer,optics.extinction.bytes.buffer]);
            streamWaterTiles();
          }).catch(()=>{});
          void resources.then(resource=>files===currentFiles?resource?.read("water"):undefined)
            .then(dictionary=>dictionary&&readStreetWaterMaterials(dictionary))
            .then(materials=>{
              if(materials&&files===currentFiles)send({kind:"streetWaterMaterials",materials},
                [...materials.bump,...materials.foam].map(level=>level.bytes.buffer));
            }).catch(()=>{});
        });
        return true;
      }
      if(request.kind==="streetPrepareWorld"){
        const archive=state?.archives.get("levels.rpf");
        const native=archive&&!files[indexFileName]?ensureNativeCatalog(archive.file):undefined;
        if(request.collision&&archive){
          void openTerrainCatalog(archive)?.prepareCollision().catch(()=>{});
          if(native&&collisionHandoffWorker!==native){
            collisionHandoffWorker=native;
            native.postMessage({catalog:"worldCollision"} satisfies NativeWorldCollisionQuery);
          }
        }
        return true;
      }
      if(request.kind==="streetPrepareEntry"){
        const {point}=request;
        if(point===null){cancelPreparedEntry();return true;}
        const archive=state?.archives.get("levels.rpf");
        if(!archive||files[indexFileName]||lastRegion||preparedEntry||catalogRequests.has(false))return true;
        const file=archive.file,status={failed:false};
        const assets=nativeCatalog(file,point,nativeNearRadius,undefined,false,()=>{status.failed=true;});
        const id=catalogRequests.get(false)?.id;
        if(id!==undefined)preparedEntry={file,point,id,assets,status};
        return true;
      }
      if(request.kind==="streetSpawnProbe"){
        const {point,serial,hint}=request,archive=state?.archives.get("levels.rpf");
        spawnSerial=serial;
        if(!archive){send({kind:"streetSpawnProbe",serial,height:null});return true;}
        const [x,y]=point.map(value=>Math.floor(value/128)),key=`${x},${y}`;
        let pending=spawnSurfaces.get(key);
        spawnSurfaces.delete(key);
        if(!pending){
          pending=Promise.allSettled([
            loadStreetRegion(archive,point,[],false,undefined,undefined,undefined,true,
              undefined,undefined,undefined,undefined,undefined,undefined,terrainReader(archive)),
            openTerrainCatalog(archive)?.queryWorldCollision(point,[],()=>state?.archives.get("levels.rpf")===archive,[x,y])??{meshes:[]},
          ]).then(results=>results.flatMap(result=>result.status==="fulfilled"?result.value.meshes:[]));
        }
        spawnSurfaces.set(key,pending);
        if(spawnSurfaces.size>4)spawnSurfaces.delete(spawnSurfaces.keys().next().value!);
        void pending.then(meshes=>{
          if(spawnSerial!==serial||state?.archives.get("levels.rpf")!==archive)return;
          const height=walkFloor(meshes,...point,hint);
          send({kind:"streetSpawnProbe",serial,height:height??null});
        });
        return true;
      }
      if(request.kind==="cancelStreetRegion"){
        streetRegionSerial=Math.max(streetRegionSerial,request.serial);
        lastRegion=undefined;
        streamView=undefined;
        residentInteriors.clear();
        refreshOuterSkyline=undefined;
        outerSkylineView=undefined;
        clearTimeout(skylineSettleTimer);
        regionBusy=false;
        resumeVegetation();
        catalogWorker?.postMessage({catalog:"cancel"} satisfies NativeCatalogCancel);
        finishPlants?.();finishPlants=undefined;nativePlantArea=nativeCanopyArea=undefined;
        catalogArea=undefined;
        cancelCatalogRequests();
        if(!scanningRoofs)localIndex?.pause();
        return true;
      }
      if(request.kind==="streetTexture"){
        const archive=state?.archives.get("levels.rpf");
        const source=dynamicTerrain.get(request.id)?.source;
        if(request.id.startsWith(canopyAtlasPrefix)){
          const texture=request.id.slice(canopyAtlasPrefix.length);
          const baked=canopyAtlases.get(texture)??(request.id.startsWith(nativeCanopyAtlasPrefix)?
            loadNativeCanopy(request.id.slice(nativeCanopyAtlasPrefix.length)):undefined);
          void (async()=>{
            const current=state;
            const resident=(await baked)?.image??await assetCache?.get("texture",`false:${request.id}`);
            if(state!==current)return;
            const image=resident?{...resident,rgba:resident.rgba.slice(),
              authoredMips:resident.authoredMips?.map(mip=>({...mip,rgba:mip.rgba.slice()}))}:null;
            send({kind:"streetTexture",epoch:request.epoch,id:request.id,ground:false,image},
              image?[image.rgba.buffer,...image.authoredMips?.map(mip=>mip.rgba.buffer)??[]]:[]);
          })();
          return true;
        }
        const catalog=archive&&source?openTerrainCatalog(archive):undefined;
        void materials?.read(request,source,catalog?name=>catalog.terrainMaterial(name):undefined)
          .then(({event,transfer})=>send(event,transfer));
        return true;
      }
      if(request.kind==="streetNavigation"){
        const {serial,point,known}=request;
        streetNavigationSerial=serial;
        if(!state||!point)return true;
        const active=()=>streetNavigationSerial===serial;
        void openNavigation().then(async catalog=>{
          if(!active())return;
          if(!catalog){send({kind:"streetNavigation",serial,wanted:known,meshes:[],skipped:0});return;}
          const region=await loadStreetNavigation(catalog,point,known,active);
          if(active())sendStreetRegion({kind:"streetNavigation",serial,...region});
        })
          .catch(()=>{if(active())send({kind:"streetNavigation",serial,wanted:known,meshes:[],skipped:1});});
        return true;
      }
      if(request.kind==="streetVegetation"){
        const {serial,point}=request,archive=state?.archives.get("levels.rpf");
        const priorPoint=lastVegetation?.point;
        const sameCell=point&&priorPoint&&point[0]===priorPoint[0]&&point[1]===priorPoint[1];
        if(!sameCell)nearVegetation=undefined;
        vegetationSerial=serial;
        resumeVegetation();
        lastVegetation=point?request:undefined;
        vegetationBusy=false;
        if(!archive||!point||!streetStructureMaterials)return true;
        const index=files[indexFileName]?localIndex:undefined;
        index?.start();
        vegetationBusy=true;
        send({kind:"streetWork",task:"vegetation",serial});
        const active=()=>vegetationSerial===serial&&state?.archives.get("levels.rpf")===archive;
        const retained=new Set(request.known),wanted:string[]=[];
        const sources=new Map<VegetationSource,Promise<ReturnType<typeof readVegetationGraphics>>>();
        const view=streamView,includeDistant=Boolean(view?.distantCanopy??view?.flightTerrain);
        const near=request.lookOnly&&includeDistant&&nearVegetation?.length&&nearVegetation.every(id=>retained.has(id))?nearVegetation:undefined;
        const plants=near||index?.complete?undefined:nativePlants(archive.file,point);
        void (async()=>{
          await index?.ready();
          let skipped=0,nativeGrassPlaced=0,nativeWoodyPlaced=0;
          const headers=new Map<number,DataView>();
          function plantStorage(source:VegetationSource){
            let storage=sources.get(source);
            if(storage)return storage;
            const {graphicsStart,graphicsSize,graphicsEnd,instanceLayouts}=source as IndexedVegetation&Partial<NativeVegetationSource>;
            const openStorage=async (locator:VegetationSource)=>instanceLayouts instanceof Map?
              readVegetationGraphics(archive!,locator,instanceLayouts):
              readVegetationSource(archive!,locator,source.systemPages?undefined:headers.get(source.system[0]));
            const pages:Uint8Array[]=[];
            storage=source.graphics.length&&source.systemPages?openStorage(source):
              readIndexedGraphics(archive!,graphicsStart,graphicsSize,page=>pages.push(page),graphicsEnd).then(async graphics=>{
                const decoded=await openStorage({...source,graphics:graphics as VegetationRange[]});
                for(const [index,page] of pages.entries())decoded.pages.set(index,Promise.resolve(page));
                return decoded;
              });
            sources.set(source,storage);
            return storage;
          }
          const visible=view&&streetFrustum(view,1.24);
          const onScreen=(bounds:Bounds)=>visible?.(bounds,canopyAtlasRadius)??true;
          const streamPlants=async(distant:boolean)=>{
            const selectionPoint=distant&&view?[view.eye[0],view.eye[1]] as const:point;
            const [native,nearProfiles]=await Promise.all([
              distant&&view?nativePlants(archive.file,selectionPoint,view.eye[2]):plants,
              distant?undefined:index?.foliage(point,false),
            ]);
            const preview=distant&&Boolean(native?.sources.length);
            const profiles=nearProfiles??(preview||!index?.complete?
              {models:[],sources:[],modelIds:new Map<number,number>()}:await index.foliage(point,true));
            if(!active())return;
            const models=[...profiles.models,...native?.models??[]];
            const nativeIds=new Set<string>();
            const decoded:VegetationSource[]=[];
            for(const source of native?.sources??[]){
              for(const batch of source.batches)nativeIds.add(vegetationBatchId(source,batch));
              decoded.push({...source,batches:source.batches.flatMap(batch=>{
                if(preview){
                  const [,,,,,reach,left,bottom,right,top]=batch;
                  const packed=nativePackedRange(batch);
                  if(vegetationDistance(...selectionPoint,left,bottom,right,top)>
                    (packed===undefined?batch[10]??reach:packed+vegetationUpdateSize))return [];
                }
                const row:[...typeof batch]=[...batch];
                row[0]+=profiles.models.length;
                return [row];
              })});
            }
            if(profiles.models.length){
              const ranked=distant?profiles.sources.flatMap(locator=>{
                if(!locator.woody||!locator.woodyModels.some(hash=>canopyModel(profiles.models[profiles.modelIds.get(hash)??-1])))return [];
                const [left,bottom,right,top]=locator.woody;
                const distance=vegetationDistance(...point,left,bottom,right,top);
                const visible=onScreen([left,bottom,-10,right,top,52]);
                return distance>=72&&(visible||distance<=distantCanopyRadius)?
                  [{locator,distance,score:distance+(visible?0:240)}]:[];
              }).sort((a,b)=>a.score-b.score):undefined;
              const locators=ranked?[...ranked.filter(row=>row.distance<=distantCanopyRadius).slice(0,64),
                ...ranked.filter(row=>row.distance>distantCanopyRadius).slice(0,24)].map(({locator})=>locator):
                nearbyVegetationSources(profiles.sources,point);
              for(let start=0;start<locators.length&&active();start+=4){
                await Promise.all(locators.slice(start,start+4).map(async locator=>{
                  const offset=locator.system[0];
                  let cached=vegetationHeaders.get(offset);
                  vegetationHeaders.delete(offset);
                  cached??=readVegetationHeader(archive,locator).then(data=>({
                    data,source:{...locator,batches:scanVegetation(data).batches},
                  }));
                  vegetationHeaders.set(offset,cached);
                  if(vegetationHeaders.size>128)vegetationHeaders.delete(vegetationHeaders.keys().next().value!);
                  try{
                    const {data,source}=await cached;
                    headers.set(offset,data);
                    decoded.push({...source,batches:source.batches.flatMap(row=>{
                      if(nativeIds.has(vegetationBatchId(source,row)))return [];
                      const [hash,...batch]=row;
                      const model=profiles.modelIds.get(hash);
                      return model===undefined?[]:[[model,...batch]];
                    })});
                  }catch{
                    if(vegetationHeaders.get(offset)===cached)vegetationHeaders.delete(offset);
                    skipped++;
                  }
                }));
              }
            }
            if(!active())return;
            const strict=view&&streetFrustum(view);
            const occupied=new Set(wanted);
            const authoredCanopy=preview&&strict?
              visibleNativeCanopyCandidates(decoded,selectionPoint,models,strict,occupied):[];
            for(const {source,batch} of authoredCanopy)occupied.add(vegetationBatchId(source,batch));
            const candidates=distant?distantCanopyCandidates(decoded,selectionPoint,models,onScreen,occupied,
              preview?(source,batch)=>{
                const lod=(source as Partial<NativeVegetationSource>).lods?.get(batch[1]);
                return !!lod&&(lod.wholeBatch&&lod.children===1||lod.instanceSlots);
              }:undefined):
              vegetationCandidates(decoded,point);
            const batches=candidates.map(({source,batch,drawRadius})=>
              ({source,batch,drawRadius,atlas:false,nativeOnly:false}));
            if(distant){
              for(const {source,batch} of candidates)occupied.add(vegetationBatchId(source,batch));
              batches.unshift(...authoredCanopy.map(({source,batch,drawRadius})=>
                ({source,batch,drawRadius,atlas:!(source as Partial<NativeVegetationSource>).woodyDrawable,nativeOnly:false})));
              if(preview&&visible)batches.push(...nativePackedPlantCandidates(decoded,selectionPoint,models,visible,occupied)
                .map(({source,batch,drawRadius})=>({source,batch,drawRadius,atlas:false,nativeOnly:false})));
              const atlases=distantCanopyAtlasCandidates(decoded,selectionPoint,models,onScreen,occupied,
                preview&&view?.fov&&strict?{fov:view.fov,aspect:view.aspect,onScreen:bounds=>strict(bounds,canopyAtlasRadius)}:undefined);
              batches.push(...atlases.map(({source,batch,drawRadius})=>({source,batch,drawRadius,atlas:true,nativeOnly:false})));
              if(preview&&files[imposterAtlasPackPath]){
                for(const {source,batch} of atlases)occupied.add(vegetationBatchId(source,batch));
                // Wider views already cover more of the regular scenery.
                const coverage=Math.min(1,Math.tan(Math.PI/10)/Math.tan((view?.fov??50)*Math.PI/360))**2;
                const treeBudget=Math.max(4,Math.round(16*coverage));
                const shrubBudget=Math.max(2,Math.round(6*coverage));
                batches.push(...broadleafCanopyCandidates(decoded,selectionPoint,models,onScreen,occupied,treeBudget)
                  .map(({source,batch,drawRadius})=>({source,batch,drawRadius,atlas:true,nativeOnly:true})));
                batches.push(...broadleafCanopyCandidates(decoded,selectionPoint,models,onScreen,occupied,shrubBudget,true)
                  .map(({source,batch,drawRadius})=>({source,batch,drawRadius,atlas:true,nativeOnly:true})));
              }
            }
            const meshes:Awaited<ReturnType<typeof loadVegetationGeometry>>[]=[];
            const concurrency=streetBudgets.materialReads;
            const packedBatches=distant&&view?native?.packedImpostors?.flatMap(source=>source.batches.flatMap(batch=>
              packedImpostorBatchInRange(batch,view.eye)?[{source,batch}]:[]))??[]:[];
            let ordinaryPlaced=false;
            const preparePacked=async ()=>{
              const decoded:PromiseSettledResult<Awaited<ReturnType<typeof readVegetationBatch>>>[]=[];
              for(let start=0;start<packedBatches.length&&active();){
                // Leave archive capacity for ordinary drawables until their
                // placement loop finishes, then use the full read window.
                const reads=ordinaryPlaced?concurrency:streetBudgets.geometryReads;
                const window=packedBatches.slice(start,start+reads);
                decoded.push(...await Promise.allSettled(window.map(async ({source,batch})=>
                  readVegetationBatch(batch,await plantStorage(source),batch[0]))));
                start+=window.length;
              }
              return decoded;
            };
            let preparedPacked:ReturnType<typeof preparePacked>|undefined;
            const prepareDrawable=async ({batch,source,atlas,nativeOnly}:typeof batches[number])=>{
              const model=models[batch[0]];
              const nativeSource=source as Partial<NativeVegetationSource>;
              const packed=nativePackedRange(batch);
              const coarse=distant&&packed===undefined&&!nativeSource.woodyDrawable;
              const modelKey=`${model.streams[0][0]}:${model.drawable??model.hash}:${model.geometryDescriptor??""}${coarse?":coarse":""}`;
              const canopyKey=preview&&atlas?drawableNameKey(model.name):undefined;
              const nativeAtlas=canopyKey?await loadNativeCanopy(canopyKey):undefined;
              if(!active())return;
              if(nativeOnly&&!nativeAtlas)return;
              let mesh=nativeAtlas?.model??await vegetationModel(modelKey,archive,model,coarse);
              if(!active())return;
              if(canopyKey&&nativeAtlas&&/^veg_crop_/i.test(model.name)){
                const registry=await imposterMetadata()?.then(metadata=>metadata.treeRegistry()).catch(()=>undefined);
                if(!active())return;
                const coverage=registry?.coverage.get(BigInt("0x"+canopyKey));
                if(coverage){
                  // Native crop cards use the tangent attribute for the two
                  // projection spans and the two material coverage parameters.
                  const width=nativeAtlas.image.width/2,height=nativeAtlas.image.height;
                  const size=Math.max(width,height);
                  const shape=[width/size,height/size,...coverage].map(value=>Math.round(value*32767));
                  mesh={...mesh,cropCanopy:true,terrainTangents:Int16Array.from([...shape,...shape,...shape,...shape])};
                }
              }
              if(atlas&&!nativeAtlas){
                const key=`v1:${modelKey}`;
                let baked=canopyAtlases.get(key);
                canopyAtlases.delete(key);
                if(!baked){
                  const original=mesh,cache=assetCache,loader=materials,texture=canopyAtlasPrefix+key;
                  baked=(async()=>{
                    const image=await cache?.get("texture",`false:${texture}`);
                    if(image){
                      const model=canopyAtlasModel(original,key);
                      if(model)return {model,texture,image};
                    }
                    const result=await bakeCanopyAtlas(original,key,async id=>{
                      const texture=await loader?.read({kind:"streetTexture",epoch:0,id,ground:false});
                      return texture?.event.image??null;
                    });
                    if(result&&cache===assetCache)cache?.put("texture",`false:${texture}`,result.image,result.image.rgba.byteLength);
                    return result;
                  })().catch(()=>undefined);
                }
                canopyAtlases.set(key,baked);
                if(canopyAtlases.size>96)canopyAtlases.delete(canopyAtlases.keys().next().value!);
                const loaded=await baked;
                if(!active())return;
                if(!loaded)return;
                mesh=loaded.model;
              }
              return {mesh,model,modelKey,nativeAtlas};
            };
            let pending:{id:string;drawable?:Promise<Awaited<ReturnType<typeof prepareDrawable>>|null>}[]=[];
            for(const [done,{batch,source,drawRadius,atlas}] of batches.entries()){
              if(!active())return;
              // Overlap independent drawable reads while installing batches in selection order.
              if(done%concurrency===0)pending=batches.slice(done,done+concurrency).map(job=>{
                const id=vegetationBatchId(job.source,job.batch)+(job.atlas?":atlas:far":distant?":far":"");
                return {id,drawable:retained.has(id)?undefined:prepareDrawable(job).catch(()=>null)};
              });
              if(done%4===0)send({kind:"streetWork",task:"vegetation",serial,done,total:batches.length});
              const {id,drawable}=pending[done%concurrency];
              if(!drawable){wanted.push(id);continue;}
              const prepared=await drawable;
              if(!active())return;
              if(prepared===null){skipped++;continue;}
              if(!prepared)continue;
              const {mesh,model,modelKey,nativeAtlas}=prepared;
              const nativeSource=source as Partial<NativeVegetationSource>;
              const lod=nativeSource.lods?.get(batch[1]);
              const parent=lod?.parent;
              try{
                const packedShrub=batch[4]&&/^veg_bush_/i.test(model.name);
                const fullDensity=batch[12]!==undefined;
                const limit=fullDensity?batch[3]:atlas?96:distant?
                  Math.max(1,Math.min(batch[4]?128:32,Math.floor(48000/mesh.indices.length))):undefined;
                const radius=preview?Math.min(drawRadius,nativeVegetationRadius(batch)):drawRadius;
                const placed=await placeVegetation(structuredClone(mesh),model,batch,await plantStorage(source),id,radius,limit,!distant||preview);
                if(!active())return;
                if(fullDensity&&(!batch[4]||packedShrub)&&placed.instances){
                  const poses=placed.instances.poses,positions=new Float32Array(poses.length/16*3);
                  for(let from=0,to=0;from<poses.length;from+=16,to+=3)
                    for(let axis=0;axis<3;axis++)positions[to+axis]=poses[from+axis]+placed.origin[axis];
                  detailedPlants.set(id,{positions,radius:placed.vegetationFadeStart??radius,
                    model:BigInt("0x"+drawableNameKey(model.name))});
                }
                if(lod&&!batch[4]&&(!distant||preview)){
                  const fallback=lod.children>0&&(lod.instanceSlots||lod.wholeBatch&&lod.children===1);
                  if(fallback||parent)placed.vegetationLod={key:`${lod.map}:${lod.ordinal}`,count:batch[3],level:lod.level,
                    parent:(!distant||nativeSource.woodyDrawable)&&parent?`${parent.map}:${parent.ordinal}`:undefined,
                    parentInstance:parent?.instance,parentIndices:parent?.indices,
                    fallback:fallback?true:undefined,instanceSlots:lod.instanceSlots?true:undefined};
                }
                if(batch[12]!==undefined){
                  if(batch[4])nativeGrassPlaced+=placed.instances?.ids?.length??0;
                  else nativeWoodyPlaced+=placed.instances?.ids?.length??0;
                }
                placed.geometryKey=nativeAtlas?nativeAtlas.texture:`plant:${modelKey}${atlas?":atlas":""}`;
                meshes.push(placed);
                wanted.push(id);
                if(meshes.length>=4){
                  sendStreetRegion({kind:"streetVegetation",serial,wanted:null,meshes:meshes.splice(0),skipped});
                  // Give the ordinary drawables the first delivery window.
                  // Packed coverage still uses all ordinary batches below.
                  if(packedBatches.length&&!preparedPacked)
                    preparedPacked=imposterMetadata()?.then(preparePacked,()=>[]);
                }
              }catch{skipped++;}
            }
            ordinaryPlaced=true;
            if(distant&&view&&native?.packedImpostors?.length){
              const registry=await imposterMetadata()?.then(metadata=>Promise.all([
                metadata.treeRegistry(),metadata.atlasTable(),metadata.slodModels()
              ])).catch(()=>undefined);
              if(registry&&active()){
                const [{tags},atlases,models]=registry;
                const detailed=wanted.flatMap(id=>{
                  const coverage=detailedPlants.get(id);
                  return coverage?[coverage]:[];
                });
                const packed=packedImpostorView(view,tags,atlases,models,packedImpostorCoverage(detailed));
                // Keep the authored radial set resident through a turn. The
                // renderer culls its tiles against the live camera each frame.
                const decoded=await (preparedPacked??preparePacked());
                if(!active())return;
                // Keep stable tile, pose and model insertion order.
                let yieldAt=performance.now()+16;
                for(const [index,result] of decoded.entries()){
                  if(performance.now()>=yieldAt){
                    await new Promise<void>(done=>setTimeout(done,0));
                    if(!active())return;
                    yieldAt=performance.now()+16;
                  }
                  if(result.status==="rejected"){skipped++;continue;}
                  try{packed.append(packedBatches[index].batch,result.value);}catch{skipped++;}
                }
                decoded.length=0;
                const groups=packed.models();
                const packedAtlases=new Map<bigint,Promise<{model:StreetChunk;texture:string}|undefined>>();
                const missing:typeof groups=[];
                // Publish ready groups in view priority while subsequent
                // atlas reads are still in progress.
                for(let start=0;start<groups.length&&active();start+=concurrency){
                  const window=groups.slice(start,start+concurrency);
                  const ready=await Promise.all(window.map(({key})=>{
                    const geometry=packedAtlasGeometry.get(key);
                    if(geometry)return geometry;
                    let pending=packedAtlases.get(key);
                    if(!pending){
                      pending=Promise.resolve(loadNativeCanopy(key.toString(16).padStart(16,"0")))
                        .then(atlas=>atlas&&{model:atlas.model,texture:atlas.texture});
                      packedAtlases.set(key,pending);
                    }
                    return pending;
                  }));
                  if(!active())return;
                  for(const [index,{tag,key}] of window.entries()){
                    const atlas=ready[index];
                    if(!atlas){missing.push({tag,key});continue;}
                    // The atlas pixels have their own residency and lifetime.
                    // Reuse the verified mesh without reading the image again.
                    packedAtlasGeometry.set(key,atlas);
                    const id=`packed-impostor:${key.toString(16).padStart(16,"0")}:${tag}`;
                    meshes.push({...packed.mesh(tag,structuredClone(atlas.model),id),geometryKey:atlas.texture});
                    wanted.push(id);
                  }
                  if(meshes.length>=4)sendStreetRegion({kind:"streetVegetation",serial,wanted:null,meshes:meshes.splice(0),skipped});
                }
                if(!active())return;
                const replacements=missing.length?await nativePackedModels(archive.file,[...new Set(missing.map(row=>row.key))]):undefined;
                for(const {tag,key} of missing){
                  if(!active())return;
                  const model=replacements?.get(key);
                  if(!model)continue;
                  const modelKey=key.toString(16).padStart(16,"0"),geometryKey=`packed-drawable:${modelKey}`;
                  try{
                    const mesh=await vegetationModel(geometryKey,archive,model,true);
                    if(!active())return;
                    const id=`packed-impostor:${modelKey}:${tag}`;
                    meshes.push({...packed.mesh(tag,structuredClone(mesh),id,true),geometryKey,visualOnly:true});
                    wanted.push(id);
                  }catch{
                    skipped++;
                  }
                }
              }
            }
            return meshes;
          };
          if(near)wanted.push(...near);
          else{
            const nearMeshes=await streamPlants(false);
            if(!active())return;
            nearVegetation=[...wanted];
            const nearby=new Set(wanted);
            const initial=includeDistant?[...wanted,...request.known.filter(id=>id.startsWith("packed-impostor:")||
              id.endsWith(":far")&&!nearby.has(id.replace(/(?::atlas)?:far$/,"")))]:[...wanted];
            lastVegetation={...request,known:initial};
            sendStreetRegion({kind:"streetVegetation",serial,wanted:initial,meshes:nearMeshes??[],skipped,
              nativeGrass:nativeGrassPlaced,nativeWoody:nativeWoodyPlaced});
          }
          if(!includeDistant||!active())return;
          // Nearby placements can stream with geometry. The much wider
          // canopy pass should leave the archive queue to the current region.
          while(regionBusy&&active())await new Promise<void>(resolve=>regionWaiters.add(resolve));
          if(!active())return;
          const distantMeshes=await streamPlants(true);
          if(!active())return;
          if(sameCell){
            // Keep a small reserve for turning back. Only one draw variant
            // may survive for each authored vegetation batch.
            const base=(id:string)=>id.replace(/(?::atlas)?:far$/,"");
            const selected=new Set(wanted.map(base));
            let reserve=16;
            for(const id of request.known){
              if(!id.endsWith(":far"))continue;
              const batch=base(id);
              if(selected.has(batch))continue;
              wanted.push(id);
              selected.add(batch);
              if(!--reserve)break;
            }
          }
          const current=new Set(wanted);
          for(const id of detailedPlants.keys())if(!current.has(id))detailedPlants.delete(id);
          lastVegetation={...request,known:wanted};
          sendStreetRegion({kind:"streetVegetation",serial,wanted,meshes:distantMeshes??[],skipped});
        })().catch(()=>{
          if(active())sendStreetRegion({kind:"streetVegetation",serial,wanted:[...new Set([...request.known,...wanted])],meshes:[],skipped:1});
        })
          .finally(()=>{if(active()){vegetationBusy=false;refreshNearby();}});
        return true;
      }
      if(request.kind==="streetRegion"){
        const archive=state?.archives.get("levels.rpf"),serial=request.serial;
        if(!archive)return true;
        if(lastRegion?.serial!==serial)outerSkylineView=undefined;
        streetRegionSerial=serial;
        lastRegion=request;
        requestInteriors();
        refreshOuterSkyline=undefined;
        clearTimeout(skylineSettleTimer);
        regionBusy=true;
        send({kind:"streetWork",task:"region",serial});
        const index=!request.karst&&files[indexFileName]?localIndex:undefined;
        const active=()=>streetRegionSerial===serial&&state?.archives.get("levels.rpf")===archive;
        const readTerrain=terrainReader(archive,active);
        const prioritize=(ground?:Promise<StreetAsset[]>)=>
          index?.prioritize(request.point,[],streamView?.eye[2],ground);
        if(!readTerrain)prioritize();
        let discoveryStarted=false;
        const startDiscovery=()=>{
          if(!index||discoveryStarted||!active())return;
          discoveryStarted=true;
          index.start();
        };
        const loaded=new Set(request.known);
        const updateBridgeLods=(assets:StreetAsset[])=>{
          const links:Extract<Event,{kind:"streetBridgeLods"}>["links"]=[];
          for(const asset of assets)
            if(asset.id&&loaded.has(asset.id)&&asset.placementLod?.distance&&roadBridgeDrawable(asset.name))
              links.push([asset.id,asset.placementLod]);
          if(links.length&&active())send({kind:"streetBridgeLods",serial,links});
        };
        void (async()=>{
          const sea=request.karst?undefined:ocean??=openArchives(files,path=>path==="common.rpf"||path==="textures.rpf",false,false)
            .then(({archives})=>{
              const common=archives.get("common.rpf"),textures=archives.get("textures.rpf");
              return common&&textures?loadStreetOcean(common,textures):undefined;
            }).catch(()=>undefined);
          const overviewTask=sea?.then(surface=>{
            if(!surface||!active())return [];
            const overview=surface.terrain(request.point,loaded);
            const water=surface.water(request.point,loaded);
            const seabed=surface.seabed(request.point,loaded);
            overview.meshes.push(...water.meshes,...seabed.meshes);
            overview.wanted.push(...water.wanted,...seabed.wanted);
            if(overview.meshes.length){
              for(const mesh of overview.meshes)loaded.add(mesh.id);
              sendStreetRegion({kind:"streetRegionBatch",serial,meshes:overview.meshes});
            }
            return overview.wanted;
          }).catch(()=>[]);
          let nativeRadius:number|undefined;
          let pendingWideRadius:number|undefined;
          let nativeHorizon:Promise<StreetAsset[]>|undefined;
          let floorTask:Promise<Awaited<ReturnType<StreetNavFloor["load"]>>|undefined>|undefined;
          const collisionTask=(openTerrainCatalog(archive)?.queryWorldCollision(request.point,request.known,active)
            ??Promise.resolve(null)).catch(()=>null).then(collision=>{
              if(active()&&collision?.meshes.length){
                sendStreetRegion({kind:"streetRegionBatch",serial,meshes:collision.meshes});
                for(const mesh of collision.meshes)loaded.add(mesh.id);
              }
              return collision;
            });
          let cancelHorizon=false;
          const horizonActive=()=>active()&&!cancelHorizon;
          const loadHorizon=async (nearbyOwns:(id:string)=>boolean|Promise<boolean>)=>{
            const [bridges,skylineFallback,native]=await Promise.all([
              index?.bridges(request.point,bridgeHorizon,active).catch(()=>[])??[],
              index?.skyline(request.point,skylineRadius,active).catch(()=>[])??[],
              nativeHorizon??[]
            ]);
            if(!horizonActive())return;
            updateBridgeLods(native);
            const nativeIds=new Set(native.flatMap(({id})=>id?[id]:[]));
            let wanted=new Set<string>();
            const visible=streamView&&streetFrustum(streamView,1.25);
            const allowLow=streamView?.flightTerrain;
            const bridgeProxy=(asset:StreetAsset)=>bridgeDeckProxy(asset.name)&&
              (asset.kind!=="skyline"||!!asset.placementLod?.distance);
            const rank=(assets:StreetAsset[],bridge:boolean,aerialAssets?:ReadonlySet<string>)=>assets.flatMap(asset=>{
              const bounds=structureBounds(asset);
              if(!bounds||!asset.id||wanted.has(asset.id)||bridge&&asset.kind==="skyline"&&!bridgeProxy(asset))return [];
              const distance=horizonDistance(request.point,bounds);
              const height=bounds[5]-Math.max(0,bounds[2]);
              const aerial=Boolean(aerialAssets?.has(asset.id));
              const lodDistance=asset.placementLod?.distance;
              const authoredBridge=aerial&&lodDistance&&prefabBridgeSkyline(asset.name);
              if(authoredBridge&&streamView&&!streetLodInRange(bounds,streamView.eye,lodDistance))return [];
              const low=!bridge&&!authoredBridge&&height<tallSkylineHeight;
              const outer=aerial&&distance>skylineRadius;
              const radius=bridge?bridgeHorizon:low?lowSkylineHorizon:outer?aerialSkylineRadius:skylineRadius;
              if(distance>radius||!bridge&&distance<400)return [];
              if(low&&(!allowLow||height<lowSkylineHeight))return [];
              const width=Math.max(bounds[3]-bounds[0],bounds[4]-bounds[1]);
              const extent=bridge||authoredBridge?width:low?Math.sqrt(Math.min(width,180)*height):height;
              const importance=extent/Math.max(distance,1)*(districtAggregate.test(asset.name)?.65:1)*
                (!outer&&visible?.(bounds,radius)?1.35:1);
              return [{asset,bounds,id:asset.id,importance,bridge,low,outer,radius}];
            }).sort((a,b)=>b.importance-a.importance);
            const retained=new Map<string,HorizonEntry>(),families=new Set<string>();
            const sectorCosts=new Float64Array(12),lowSectorCosts=new Float64Array(12),batch:StreetChunk[]=[];
            const bridgeFamilies=new Map<StreetAsset,string>();
            const familyOf=(asset:StreetAsset,bridge:boolean)=>{
              const linked=bridge&&bridgeFamilies.get(asset);
              if(linked)return linked;
              const name=asset.name.replace(/(_slod)\d+$/i,"$1");
              // The same skyline drawable can have several authored placements.
              if(bridge||prefabBridgeSkyline(asset.name)||asset.placementLod||asset.id&&nativeIds.has(asset.id))
                return [name,...asset.center.map(value=>Math.round(value/3))].join(":");
              return name;
            };
            const readSkyline=async (asset:StreetAsset,id:string,bridge:boolean)=>{
              const key=bridge?`bridge-v3:${id}`:`horizon-v4:${id}`;
              const cached=await assetCache?.get("mesh",key);
              let mesh=cached??await loadStreetAsset(archive,asset,true);
              if(asset.placementLod?.distance)mesh.placementLod=asset.placementLod;
              if(!cached){
                mesh=bridge?{...mesh,drawDistance:bridgeHorizon}:simplifySkyline(mesh,1.1);
                if(horizonActive())assetCache?.put("mesh",key,mesh,cachedMeshBytes(mesh));
              }
              return {mesh,cost:mesh.indices.length/3+(mesh.appearance?.spans.length??0)*200};
            };
            const flush=()=>{
              if(batch.length&&horizonActive())sendStreetRegion({kind:"streetRegionBatch",serial,meshes:batch.splice(0)});
            };
            const stream=async (ranked:ReturnType<typeof rank>,limit:number,onOwnershipWait?:()=>void)=>{
              let count=0,limitedCount=0;
              for(const {asset,bounds,id,bridge,low,outer,radius} of ranked){
                if(!horizonActive())break;
                const limited=bridge||!nativeIds.has(id);
                if(limited&&limitedCount>=limit)continue;
                const owns=nearbyOwns(id);
                if(typeof owns!=="boolean")onOwnershipWait?.();
                if(await owns)continue;
                if(!horizonActive())break;
                const family=familyOf(asset,bridge);
                if(families.has(family))continue;
                const angle=Math.atan2((bounds[1]+bounds[4])*.5-request.point[1],(bounds[0]+bounds[3])*.5-request.point[0]);
                const sector=Math.floor((angle+Math.PI)*sectorCosts.length/(2*Math.PI))%sectorCosts.length;
                const costs=low?lowSectorCosts:sectorCosts;
                const checkSector=limited&&!bridge&&!outer;
                if(checkSector&&costs[sector]>=(low?22000:59000))continue;
                try{
                  let cost=horizon.get(id)?.cost??0,mesh:StreetChunk|undefined;
                  if(!loaded.has(id)){
                    ({mesh,cost}=await readSkyline(asset,id,bridge));
                    if(!horizonActive())return;
                    if(low||radius>skylineRadius)mesh={...mesh,drawDistance:radius};
                  }
                  if(checkSector&&cost+costs[sector]>(low?34000:95000)&&(low||costs[sector]!==0))continue;
                  const entry={bounds,cost,radius};
                  if(mesh){
                    horizon.set(id,entry);
                    loaded.add(id);
                    batch.push(mesh);
                    if(count===0||batch.length>=4)flush();
                  }
                  if(checkSector)costs[sector]+=cost;
                  retained.set(id,entry);
                  families.add(family);
                  wanted.add(id);
                  count++;
                  if(limited)limitedCount++;
                }catch{ /* Other authored proxies can still provide skyline coverage. */ }
              }
              flush();
            };
            const merge=(authored:StreetAsset[],fallback:StreetAsset[])=>{
              const known=new Set(authored.map(asset=>asset.id));
              return [...authored,...fallback.filter(asset=>!known.has(asset.id))];
            };
            let decks=rank(merge(native.filter(bridgeProxy),bridges),true);
            const eye=streamView?.eye;
            if(eye){
              const placements=new Map<string,StreetAsset>(decks.flatMap(({asset})=>{
                const lod=asset.placementLod;
                return lod?[[`${lod.map}:${lod.ordinal}`,asset] as const]:[];
              }));
              for(const {asset} of decks){
                const lod=asset.placementLod;
                if(!lod?.parent||!/_lod\d*$/i.test(asset.name))continue;
                const parent=placements.get(lod.parent.join(":"));
                if(parent?.placementLod?.children===1&&parent.placementLod.level>lod.level&&
                  asset.name.replace(/_lod\d*$/i,"_slod")===parent.name.replace(/_slod\d*$/i,"_slod"))
                  bridgeFamilies.set(asset,familyOf(parent,true));
              }
              const decksByFamily=new Map<string,typeof decks>();
              for(const entry of decks){
                const family=familyOf(entry.asset,true);
                const grouped=decksByFamily.get(family);
                if(!grouped){
                  decksByFamily.set(family,[entry]);
                  continue;
                }
                const first=grouped[0];
                const lod=entry.asset.placementLod;
                const firstLod=first.asset.placementLod;
                if(lod?.distance&&streetLodInRange(entry.bounds,eye,lod.distance)&&
                  (!firstLod?.distance||!streetLodInRange(first.bounds,eye,firstLod.distance)||lod.level<firstLod.level))
                  grouped.unshift(entry);
                else grouped.push(entry);
              }
              // Try each deck's available alternatives before advancing to the next bridge.
              decks=[...decksByFamily.values()].flat();
            }
            const aerialAssets=allowLow?nativeIds:undefined;
            const skyline=rank(merge(native.filter(asset=>asset.kind==="skyline"&&!bridgeProxy(asset)),skylineFallback),false,aerialAssets);
            const visibleFirst=(entries:typeof skyline)=>{
              if(!visible||index)return entries;
              // Move whole families so delivery order cannot change which LOD wins.
              const visibleFamilies=new Set(entries.filter(({bounds,radius})=>visible(bounds,radius))
                .map(({asset})=>familyOf(asset,false)));
              return entries.map(entry=>({entry,visible:visibleFamilies.has(familyOf(entry.asset,false))}))
                .sort((a,b)=>Number(b.visible)-Number(a.visible)).map(({entry})=>entry);
            };
            const inner=visibleFirst(skyline.filter(entry=>!entry.low&&!entry.outer));
            let earlySkyline:Promise<void>|undefined;
            await stream(decks,24,()=>{
              if(earlySkyline||index||!visible||!horizonActive())return;
              // A conditional deck can wait for the nearby region. Other
              // visible families can stream without competing for its LOD.
              const deckFamilies=new Set(decks.map(({asset})=>familyOf(asset,true)));
              const visibleFamilies=new Set(inner.filter(({bounds,radius})=>visible(bounds,radius))
                .map(({asset})=>familyOf(asset,false)));
              earlySkyline=stream(inner.filter(({asset})=>{
                const family=familyOf(asset,false);
                return visibleFamilies.has(family)&&!deckFamilies.has(family);
              }),Infinity);
              void earlySkyline.catch(()=>{});
            });
            await earlySkyline;
            if(!horizonActive())return;
            await stream(inner,64);
            if(allowLow&&horizonActive())await stream(visibleFirst(skyline.filter(entry=>entry.low)),18);
            const outer=skyline.filter(entry=>entry.outer);
            const baseFamilies=new Set(families),initialSkylineView=outerSkylineView??streamView;
            if(allowLow&&horizonActive()&&initialSkylineView){
              const inView=streetFrustum(initialSkylineView,1.25);
              await stream(outer.filter(entry=>inView(entry.bounds,entry.radius)),Infinity);
            }
            return (region:Awaited<ReturnType<typeof loadStreetRegion>>)=>{
              if(!horizonActive())return;
              updateBridgeLods(native);
              const regionIds=new Set(region.wanted);
              const outer=skyline.filter(entry=>entry.outer&&!regionIds.has(entry.id));
              for(const id of wanted)regionIds.add(id);
              wanted=regionIds;
              if(outer.length){
                const candidateIds=new Set(outer.map(({id})=>id));
                for(const [id,entry] of horizon){
                  if(entry.radius!==aerialSkylineRadius||retained.has(id)||!loaded.has(id)||!candidateIds.has(id))continue;
                  retained.set(id,entry);wanted.add(id);
                }
              }
              horizon.clear();
              for(const [id,entry] of retained)horizon.set(id,entry);
              sendStreetRegion({kind:"streetRegion",serial,wanted:[...wanted],meshes:[],skipped:region.skipped,
                nativeHorizon:nativeHorizon?native.length:undefined});
              lastRegion={...request,known:[...wanted].filter(id=>loaded.has(id))};
              if(initialSkylineView&&outer.length){
                outerSkylineView=initialSkylineView;
                let updating=false,settledView:StreetStreamView|undefined;
                const update=(view:StreetStreamView,settled=false)=>{
                  if(!view.flightTerrain||!outerSkylineView||view===outerSkylineView||
                    !settled&&!streetViewChanged(view,outerSkylineView))return;
                  if(updating){if(settled)settledView=view;return;}
                  updating=true;
                  const current=()=>active()&&refreshOuterSkyline===update;
                  void (async()=>{
                    const visible=streetFrustum(view,1.25),next=new Map<string,HorizonEntry>();
                    const meshes:StreetChunk[]=[],usedFamilies=new Set(baseFamilies);
                    for(const {id,asset,bounds,radius} of outer){
                      const family=familyOf(asset,false);
                      if(usedFamilies.has(family)||!visible(bounds,radius))continue;
                      try{
                        const existing=retained.get(id);
                        const result=existing?undefined:await readSkyline(asset,id,false);
                        if(!current())return;
                        const entry=existing??{bounds,cost:result!.cost,radius};
                        usedFamilies.add(family);
                        next.set(id,entry);
                        if(result)meshes.push({...result.mesh,drawDistance:radius});
                      }catch{ /* Continue with other visible proxies. */ }
                    }
                    if(!current())return;
                    outerSkylineView=view;
                    // Retain admitted chunks for this region. The renderer culls them against every camera frame.
                    if(!meshes.length)return;
                    for(const [id,entry] of next){retained.set(id,entry);horizon.set(id,entry);loaded.add(id);wanted.add(id);}
                    lastRegion={...request,known:[...wanted].filter(id=>loaded.has(id))};
                    sendStreetRegion({kind:"streetRegion",serial,wanted:[...wanted],meshes,skipped:region.skipped});
                  })().finally(()=>{
                    updating=false;
                    const settled=settledView===streamView;
                    settledView=undefined;
                    if(current()&&!regionBusy&&streamView)update(streamView,settled);
                  });
                };
                refreshOuterSkyline=update;
              }
            }
          };
          let earlyHorizon:ReturnType<typeof loadHorizon>|undefined;
          const regionTask=loadStreetRegion(archive,request.point,request.known,streetStructureMaterials,
            meshes=>{if(active()){
              sendStreetRegion({kind:"streetRegionBatch",serial,meshes});
              for(const mesh of meshes)loaded.add(mesh.id);
              startDiscovery();
            }},active,
            async (point,radius)=>{
              await index?.ready();
              if(!active())return [];
              if(request.karst)return (await openTerrainCatalog(archive)?.query(point,radius,active))?.assets??[];
              const restrictInitial=Boolean(index?.hasRestoredSegments&&!index.complete&&!request.known.length);
              const authored=nativeStructures(archive.file,point,radius,restrictInitial);
              const wide=authored?.wide;
              const nearRadius=Math.min(radius,nativeNearRadius);
              if(!index&&!wide&&radius>nearRadius)pendingWideRadius=radius;
              const regionalRadius=restrictInitial&&!wide?nearRadius:radius;
              const [nearby,native]=await Promise.all([index?.buildings(point,regionalRadius,active,undefined,true)??[],authored?.assets??[]]);
              if(!active())return [];
              if(native.length)nativeRadius=wide?radius:nearRadius;
              // Keep the first plan small even when IndexedDB has restored a much wider region.
              // Retain the full coverage on subsequent plans, when chunks may already be resident.
              const regional=!native.length&&regionalRadius<radius?
                await index?.buildings(point,radius,active,undefined,true)??[]:nearby;
              if(!active())return [];
              updateBridgeLods(native);
              const area=catalogArea,altitude=streamView?.eye[2];
              if(wide&&active()&&area&&altitude!==undefined){
                const radius=streamView?.flightTerrain?aerialSkylineRadius:skylineRadius;
                if(!area.horizon||area.horizon.radius!==radius||Math.abs(area.horizon.altitude-altitude)>16)
                  area.horizon={altitude,radius,assets:nativeCatalog(archive.file,point,radius,altitude)};
                nativeHorizon=area.horizon.assets;
              }
              const seen=new Set(native.map(asset=>asset.id));
              return [...native,...regional.filter(asset=>!seen.has(asset.id))];
            },false,(phase,done,total)=>{
              if(active())send({kind:"streetWork",task:"region",serial,phase,done,total,
                sentAt:performance.timeOrigin+performance.now()});
            },()=>streamView,boxes=>{
              if(active())send({kind:"streetPending",serial,boxes});
            },assetCache,()=>{
              startDiscovery();
              if(!active()||request.karst||!files["navmeshes.rpf"])return;
              floorTask=openNavigation().then(async nav=>{
                if(!nav||!active())return;
                const floor=await floors.load(nav,request.point,request.known,active);
                if(active()&&floor.meshes.length){
                  sendStreetRegion({kind:"streetRegionBatch",serial,meshes:floor.meshes});
                  for(const mesh of floor.meshes)loaded.add(mesh.id);
                }
                return floor;
              }).catch(()=>undefined);
            },index?(point,radius)=>index.foreground(point,radius,active):undefined,
            readTerrain?(point,reach,detail,cells)=>{
              const ground=readTerrain(point,reach,detail,cells);
              if(detail>=0)prioritize(ground);
              return ground;
            }:undefined,nativePlan);
          function nativePlan(planned:ReadonlySet<string>,conditional:ReadonlySet<string>){
            if(!nativeHorizon||index||!streetStructureMaterials)return;
            earlyHorizon=loadHorizon(id=>conditional.has(id)?
              regionTask.then(region=>region.wanted.includes(id)):planned.has(id));
            void earlyHorizon.catch(()=>{});
          }
          void regionTask.catch(()=>{cancelHorizon=true;});
          const region=await regionTask;
          startDiscovery();
          const collision=await collisionTask;
          if(collision)region.wanted.push(...collision.wanted);
          const floor=await floorTask;
          if(floor)region.wanted.push(...floor.wanted);
          region.wanted.push(...(await overviewTask??[]));
          if(active()){
            const nearby=new Set(region.wanted);
            // The first native pass has no placement coverage outside its near radius.
            // Keep overlapping residents until the wide pass can replace or retire them.
            if(pendingWideRadius!==undefined){
              for(const id of loaded){
                const bounds=residentStructures.get(id);
                if(!bounds)continue;
                const distance=horizonDistance(request.point,bounds);
                if(distance>nativeNearRadius&&distance<=pendingWideRadius)nearby.add(id);
              }
            }
            for(const [id,{bounds,radius}] of horizon)
              if(loaded.has(id)&&horizonDistance(request.point,bounds)<=radius)nearby.add(id);
            sendStreetRegion({kind:"streetRegion",serial,...region,wanted:[...nearby],nativeRadius});
            for(const mesh of region.meshes)loaded.add(mesh.id);
            for(const id of loaded)if(!nearby.has(id))loaded.delete(id);
            lastRegion={...request,known:[...nearby].filter(id=>loaded.has(id))};
            if(request.karst||!streetStructureMaterials||!active()||pendingWideRadius!==undefined)return;
            if(!earlyHorizon){
              const regionIds=new Set(region.wanted);
              earlyHorizon=loadHorizon(id=>regionIds.has(id));
            }
            const finish=await earlyHorizon;
            finish?.(region);
          }
        })()
          .catch(error=>{
            if(active()){
              startDiscovery();
              const wanted=[...loaded];
              lastRegion={...request,known:wanted};
              send({kind:"streetRegion",serial,wanted,meshes:[],skipped:0,error:(error as Error).message});
            }
          }).finally(()=>{if(active()){
            regionBusy=false;
            resumeVegetation();
            if(streamView)refreshOuterSkyline?.(streamView);
            refreshNearby();streamWaterTiles();
          }});
        return true;
      }
      return false;
    },
  };
  return reader;
}

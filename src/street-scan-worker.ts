import { Archive } from "./archive";
import { openStreetIndexCache, readStreetCheckpoints, saveStreetIndexBundle } from "./street-index-cache";
import { packStreetIndex } from "./street-index-pack";
import { indexedGraphicsPages, type IndexedGraphicsRange, type ScanScope, type ScanSegment } from "./street-index-scan";
import { StreetRpf9 } from "./street-rpf9";
import { StreetNativeCatalog, placeInteriorAssets, type NativeInteriorsQuery,type NativeInteriorsReply,type NativeCatalogOpen, type NativeCatalogQuery, type NativeCatalogCancel, type NativeCatalogCancelNear, type NativeCatalogReply,type NativeWorldCollisionQuery,type NativeWorldCollisionReply,
  type NativeVegetationQuery, type NativeVegetationReply, type NativePackedModelsQuery, type NativePackedModelsReply } from "./street-native-catalog";

export type ScanRequest={file:Blob;segment:number;scope:ScanScope;executable:Blob;point?:readonly [number,number]};
export type ScanReply={result:ScanSegment}|{error:string};
export type PackRequest={pack:true;file:Blob;key:string;total:number};
export type PackReply={file:Blob}|{done:number;total:number}|{error:string};
export type GraphicsRequest={graphics:true;file:Blob;offset:number;range?:IndexedGraphicsRange;job:number};
export type GraphicsReply={job:number}&({pages:Uint8Array[];end:number}|{error:string});

const worker=self as unknown as DedicatedWorkerGlobalScope;
let archive:Archive|undefined;
let directory:StreetRpf9|undefined;
let catalog:StreetNativeCatalog|undefined;
let catalogQuery=0;
let wideCatalogQuery=0;
let plantQuery=0;
let packedModelsQuery=0;
let interiorQuery=0;

async function pack({file,key,total}:PackRequest){
  const db=await openStreetIndexCache();
  try{
    const packed=await packStreetIndex(new Archive("levels.rpf",file),total,readStreetCheckpoints(db,key,total),
      (done,total)=>worker.postMessage({done,total} satisfies PackReply));
    if(packed.failedMaps)throw new Error("Some placement maps could not be read when saving the index.");
    await saveStreetIndexBundle(db,"spatial",key,packed.file);
    worker.postMessage({file:packed.file} satisfies PackReply);
  }finally{db.close();}
}

worker.onmessage=({data}:MessageEvent<ScanRequest|PackRequest|GraphicsRequest|NativeCatalogOpen|NativeCatalogQuery|NativeCatalogCancel|NativeCatalogCancelNear|NativeVegetationQuery|NativePackedModelsQuery|NativeInteriorsQuery|NativeWorldCollisionQuery>)=>{
  if("catalog" in data){
    if(data.catalog==="open"){
      catalog=new StreetNativeCatalog(data.file,data.executable,data.common,true);
      void catalog.prepare().catch(()=>{});
    }else if(data.catalog==="worldCollision"&&catalog){
      const source=catalog;
      void source.takeRegisteredCollisionSources().then(worldCollision=>{
        if(catalog===source&&worldCollision?.length)worker.postMessage({worldCollision} satisfies NativeWorldCollisionReply);
      }).catch(()=>{});
    }else if(data.catalog==="cancel"){
      catalogQuery=0;
      wideCatalogQuery=0;
      plantQuery=0;
      packedModelsQuery=0;
      interiorQuery=0;
    }else if(data.catalog==="cancelNear"){
      if(catalogQuery===data.id)catalogQuery=0;
    }else if(data.catalog==="interiors"&&catalog){
      const source=catalog;
      interiorQuery=data.id;
      const active=()=>catalog===source&&interiorQuery===data.id;
      void source.queryInteriors(data.eye,data.radius,active).then(({interiors})=>{
        if(active())worker.postMessage({interiors:true,id:data.id,assets:interiors.flatMap(placeInteriorAssets),
          collision:interiors.flatMap(({collision})=>collision?[collision]:[])} satisfies NativeInteriorsReply);
      }).catch(()=>{
        if(active())worker.postMessage({interiors:true,id:data.id} satisfies NativeInteriorsReply);
      });
    }else if(data.catalog==="plants"&&catalog){
      plantQuery=data.id;
      const active=()=>plantQuery===data.id;
      const query=data.altitude===undefined?catalog.queryPlants(data.point,active):
        catalog.queryCanopyPreview([...data.point,data.altitude],active,true);
      void query.then(result=>{
        if(active())worker.postMessage({plants:true,id:data.id,result} satisfies NativeVegetationReply);
      }).catch(()=>{
        if(active())worker.postMessage({plants:true,id:data.id} satisfies NativeVegetationReply);
      });
    }else if(data.catalog==="packedModels"&&catalog){
      packedModelsQuery=data.id;
      const active=()=>packedModelsQuery===data.id&&!!catalog;
      void catalog.queryPackedModels(data.keys,active).catch(()=>new Map()).then(models=>{
        if(active())worker.postMessage({packedModels:true,id:data.id,models} satisfies NativePackedModelsReply);
      });
    }else if(catalog){
      if(data.catalog!=="query")return;
      if(data.wide)wideCatalogQuery=data.id;
      else catalogQuery=data.id;
      const started=performance.now();
      const active=()=>(data.wide?wideCatalogQuery:catalogQuery)===data.id;
      const query=data.altitude===undefined?catalog.query(data.point,data.radius,active):
        catalog.queryHorizon([...data.point,data.altitude],data.radius,active);
      void query.then(result=>{
        if(active())worker.postMessage({catalog:true,id:data.id,...result,startedAt:performance.timeOrigin+started,
          queryMs:performance.now()-started} satisfies NativeCatalogReply);
      }).catch((error:Error)=>{
        if(active())worker.postMessage({catalog:true,id:data.id,error:error.message} satisfies NativeCatalogReply);
      });
    }
    return;
  }
  if("pack" in data){
    void pack(data).catch(error=>worker.postMessage({error:(error as Error).message} satisfies PackReply));
    return;
  }
  archive??=new Archive("levels.rpf",data.file);
  if("graphics" in data){
    void indexedGraphicsPages(archive,data.offset,data.range).then(({pages,end})=>{
      worker.postMessage({job:data.job,pages,end} satisfies GraphicsReply,pages.map(page=>page.buffer as ArrayBuffer));
    }).catch(error=>worker.postMessage({job:data.job,error:(error as Error).message} satisfies GraphicsReply));
    return;
  }
  directory??=new StreetRpf9(archive,data.executable);
  void directory.readSegment(data.segment,data.scope,()=>true,data.point)
    .then(result=>worker.postMessage({result} satisfies ScanReply),
      error=>worker.postMessage({error:(error as Error).message} satisfies ScanReply));
};

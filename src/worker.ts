import { indexFileName } from "./street-index-bundle";
import { rpf9ExecutableName, verifyRpf9Executable } from "./rpf9-prepare";
import { openArchives, recover, cellKey, ImportFailure, loadWorld, pauseArchive, imageryArchive, buildName, optionalArchives, CELL, type ImportState, type Sector } from "./recover";
import { overviewLayers } from "./layers";
import { loadDistricts, loadEnglish } from "./districts";
import { loadPlaces } from "./places";
import { loadNativeMap } from "./native-map";
import { bc1, bitmap, readMip, sample, type Image } from "./texture";
import { describe, score, type Features } from "./matching";
import type { Event, Request } from "./protocol";
import type { LayerName } from "./board";

const worker=self as unknown as DedicatedWorkerGlobalScope;
const send=(event:Event,transfer:Transferable[]=[])=>worker.postMessage(event,transfer);
const yieldTask=()=>new Promise<void>(done=>setTimeout(done,0));
const stamp=()=>performance.now();
let state:ImportState|undefined;
let importedAt=0, ranking=0;
let folder:Record<string,File>;
let imagery:Promise<void>|undefined;
let street:Promise<ReturnType<typeof import("./street-worker").createStreetWorker>>|undefined;
let materials:Promise<import("./street-material-loader").StreetMaterialLoader>|undefined;
let english:ReturnType<typeof loadEnglish>|undefined;
let overview:Promise<ReturnType<typeof overviewLayers>>|undefined;
const openedLayers=new Map<string,ReturnType<typeof openLayerArchive>>();
const layers=new Set<LayerName>();
const featureCache=new Map<string,Features|null>();
const sectors=new Map<string,Sector>();
const sectorChoices=new Map<string,Promise<{id:string;mask:number}|null>>();
const roofSectors=new Map<string,Promise<Image|null>>();
const rejectedRoofs=new Set<string>();
let roofSerial=0,roofRefresh:ReturnType<typeof setTimeout>|undefined;

function bytesRead() {
  return state?[...state.archives.values()].reduce((sum,archive)=>sum+archive.bytesRead,0):0;
}

async function pixels(id:string,side:number) {
  const texture=state?.atlas.textures[id];
  if(!texture) return null;
  const pack=state!.packs.get(texture.pack);
  if(!pack) return null;
  const mip=await readMip(pack,texture,side);
  return mip ? {image:bc1(mip.data,mip.side,mip.side),width:mip.side,offset:mip.offset,stream:mip.stream}:null;
}

function signature(image:Image,col:number,row:number) {
  const grid=12;
  const values=new Float32Array(grid*grid*3);
  for(let y=0;y<grid;y++) for(let x=0;x<grid;x++)
    values.set(sample(image,col*grid+x,row*grid+y,4*grid),(y*grid+x)*3);
  return values;
}

function normalize(input:Float32Array) {
  const means=[0,0,0];
  for(let i=0;i<input.length;i++) means[i%3]+=input[i]/(input.length/3);
  const centered=input.map((value,i)=>value-means[i%3]);
  const length=Math.max(1e-6,Math.sqrt(centered.reduce((s,v)=>s+v*v,0)));
  return centered.map(v=>v/length);
}

async function chooseSector(sector:Sector) {
  const baseline=await pixels(sector.id,128);
  if(!baseline) return null;
  const reference=Array.from({length:16},(_,i)=>signature(baseline.image,i%4,i>>2));
  const templates=reference.map(normalize);
  let choice:{id:string;mask:number}|null=null,coverage=0;
  for(const id of sector.alternatives) {
    const candidate=await pixels(id,256);
    if(!candidate||candidate.width<256) continue;
    let mask=0,strong=0,consistent=0,count=0;
    for(let i=0;i<16;i++) {
      const crop=signature(candidate.image,i%4,i>>2);
      const a=normalize(crop);
      const scores=templates.map(b=>b.reduce((s,v,j)=>s+v*a[j],0));
      const error=crop.reduce((s,v,j)=>s+Math.abs(v-reference[i][j]),0)/crop.length;
      if(scores[i]>=Math.max(...scores)-.01) {
        consistent++;
        if(scores[i]>=.9&&error<=6) strong++;
        if(scores[i]>=.80&&error<=8) {mask|=1<<i;count++;}
      }
    }
    if(strong>=6&&consistent>=10&&count>coverage) {choice={id,mask};coverage=count;}
  }
  return choice;
}

async function sectorTile(id:string,side:number) {
  const sector=sectors.get(id);
  if(!sector||side<=512||!sector.alternatives.length) return pixels(id,Math.min(side,512));
  let choices=sectorChoices.get(id);
  if(!choices) {choices=chooseSector(sector);sectorChoices.set(id,choices);}
  const choice=await choices;
  if(!choice) return pixels(id,512);
  const [base,detail]=await Promise.all([pixels(id,512),pixels(choice.id,1024)]);
  if(!base||!detail||detail.width<=base.width) return base;
  const {image}=detail;
  const size=image.width,part=size/4;
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    if(choice.mask&(1<<(Math.floor(y/part)*4+Math.floor(x/part)))) continue;
    const to=(y*size+x)*4;
    const from=(Math.floor(y*base.width/size)*base.width+Math.floor(x*base.width/size))*4;
    image.rgba.set(base.image.rgba.subarray(from,from+4),to);
  }
  return detail;
}

async function imageRequest(request:Extract<Request,{kind:"tile"|"sector"}>) {
  const done=request.kind==="sector"?await sectorTile(request.id,request.side):await pixels(request.id,request.side);
  if(!done) {send({kind:"tile",key:request.key});return;}
  const image=await bitmap(done.image,request.side);
  send({kind:"tile",key:request.key,image,info:{width:done.width,stream:done.stream,offset:done.offset}},[image]);
}

async function initialOverview() {
  if(!state) return;
  const {cells,sectors,world}=state.atlas,[west,north,w,h]=world;
  const pitch=8;
  const recovered=new OffscreenCanvas(w*pitch,h*pitch);
  const fallback=new OffscreenCanvas(w*pitch,h*pitch);
  const r=recovered.getContext("2d")!,f=fallback.getContext("2d")!;
  const slab=new OffscreenCanvas(256,256),ctx=slab.getContext("2d")!;
  const occupied=new Map(cells.map(cell=>[cellKey(cell.x,cell.y),cell]));
  const covered=new Set<string>();
  function publish() {
    return Promise.all([["atlas",recovered],["coarse",fallback]].map(async ([name,canvas])=>{
      const image=await createImageBitmap(canvas as OffscreenCanvas);
      send({kind:"overview",name:name as "atlas"|"coarse",image,rect:world},[image]);
    }));
  }
  for(let start=0;start<sectors.length;start+=16) {
    const batch=sectors.slice(start,start+16);
    const images=await Promise.all(batch.map(sector=>pixels(sector.id,128)));
    for(let i=0;i<batch.length;i++) {
      const decoded=images[i];
      if(!decoded)continue;
      const sector=batch[i],side=decoded.width/4,img=decoded.image;
      slab.width=img.width;slab.height=img.height;
      ctx.putImageData(new ImageData(img.rgba,img.width,img.height),0,0);
      for(let dy=0;dy<4;dy++) for(let dx=0;dx<4;dx++) {
        const x=sector.x+dx,y=sector.y+dy,key=cellKey(x,y);
        covered.add(key);
        const tile=occupied.get(key);
        const dest=!tile||tile.recovery==="edges"?f:r;
        dest.drawImage(slab,dx*side,dy*side,side,side,(x-west)*pitch,(y-north)*pitch,pitch,pitch);
      }
    }
    if(start%128===0) await publish();
    await yieldTask();
  }
  const isolated=cells.filter(cell=>cell.recovery==="edges"||!covered.has(cellKey(cell.x,cell.y)));
  for(let i=0;i<isolated.length;i+=12) {
    const batch=isolated.slice(i,i+12);
    const images=await Promise.all(batch.map(cell=>pixels(cell.id,128)));
    for(let j=0;j<batch.length;j++) {
      const decoded=images[j];
      if(!decoded) continue;
      const {x,y}=batch[j],img=decoded.image;
      slab.width=img.width;slab.height=img.height;
      ctx.putImageData(new ImageData(img.rgba,img.width,img.height),0,0);
      r.drawImage(slab,(x-west)*pitch,(y-north)*pitch,pitch,pitch);
    }
    await yieldTask();
  }
  await publish();
}

async function getFeatures(id:string) {
  if(featureCache.has(id)) return featureCache.get(id)??null;
  const data=await pixels(id,128);
  const result=data?describe(data.image):null;
  featureCache.set(id,result);
  return result;
}

async function rank(request:Extract<Request,{kind:"rank"}>) {
  const serial=++ranking;
  if(!state) return;
  const neighbors:{direction:number;features:Features}[]=[];
  for(const {id,direction} of request.neighbors){
    const features=await getFeatures(id);
    if(features) neighbors.push({features,direction});
  }
  const {catalog}=state.atlas;
  if(!neighbors.length&&!request.points.length){
    send({kind:"rank",serial:request.serial,ids:[],done:catalog.length,total:catalog.length});
    return;
  }
  const result:{id:string;cost:number}[]=[];
  for(let start=0;start<catalog.length;start+=24) {
    if(serial!==ranking) return;
    const batch=catalog.slice(start,start+24);
    const all=await Promise.all(batch.map(getFeatures));
    batch.forEach((id,i)=>{
      const features=all[i];
      if(features) result.push({id,cost:score(features,neighbors,request.points)});
    });
    const done=start+batch.length;
    if(start%480===0||done===catalog.length) {
      result.sort((a,b)=>a.cost-b.cost||a.id.localeCompare(b.id));
      result.length=Math.min(512,result.length);
      send({kind:"rank",serial:request.serial,ids:result.map(candidate=>candidate.id),done,total:catalog.length});
    }
    await yieldTask();
  }
}

async function start(files:Record<string,File>) {
  importedAt=stamp();
  folder=files;
  await verifyRpf9Executable(files[rpf9ExecutableName]);
  const base=await openArchives(files,pauseArchive);
  const world=await loadWorld(base.archives.get("common.rpf")!);
  state={...base,atlas:{build:buildName,world,cells:[],sectors:[],catalog:[],textures:Object.create(null),
    optional:optionalArchives.filter(path=>fileAvailable(path))}};
  send({kind:"ready",atlas:state.atlas,issues:state.issues,bytes:bytesRead(),milliseconds:stamp()-importedAt,
    navigation:fileAvailable("navmeshes.rpf")});
}

function fileAvailable(path:string){return Boolean(folder?.[path]);}

async function openLayerArchive(path:string){
  const prior=state?.archives.get(path);
  if(prior)return prior;
  const opened=await openArchives(folder,p=>p===path,false);
  const archive=opened.archives.get(path);
  if(!archive)throw new Error(opened.issues[0]?.detail??`${path} is unavailable.`);
  state?.archives.set(path,archive);
  return archive;
}

async function loadImagery(){
  if(!state)return;
  const start=stamp();
  const opened=await openArchives(folder,imageryArchive);
  for(const [path,archive] of state.archives)opened.archives.set(path,archive);
  const recovered=await recover(opened,state.atlas.world,(label,done,total)=>send({kind:"progress",label,done,total}),folder[rpf9ExecutableName]);
  state.atlas={...recovered.atlas,optional:state.atlas.optional};
  for(const [path,archive] of recovered.archives)state.archives.set(path,archive);
  state.packs=recovered.packs;
  for(const sector of state.atlas.sectors)sectors.set(sector.id,sector);
  send({kind:"imageryReady",atlas:state.atlas,issues:recovered.issues,bytes:bytesRead(),milliseconds:stamp()-start});
  void initialOverview().then(()=>send({kind:"background",message:"Satellite overview ready",bytes:bytesRead(),
    elapsed:stamp()-importedAt,done:true})).catch(error=>send({kind:"background",path:"levels.rpf",
    message:(error as Error).message,bytes:bytesRead(),elapsed:stamp()-importedAt}));
}

function roofSector(id:string){
  const task=roofSectors.get(id)??pixels(id,512).then(result=>result?.image??null);
  roofSectors.delete(id);
  roofSectors.set(id,task);
  if(roofSectors.size>8)roofSectors.delete(roofSectors.keys().next().value!);
  return task;
}

async function loadRoofs({serial,rect,known}:Extract<Request,{kind:"roofRegion"}>){
  roofSerial=serial;
  clearTimeout(roofRefresh);
  if(!rect){void street?.then(reader=>reader.stopRoofs());return;}
  if(!state||!imagery)return;
  await imagery;
  if(roofSerial!==serial)return;
  const atlas=state.atlas,archive=state.archives.get("levels.rpf")!;
  const [x,y,w,h]=rect,left=x*CELL,right=(x+w)*CELL,bottom=-(y+h)*CELL,top=-y*CELL;
  const centerX=(left+right)/2,centerY=(bottom+top)/2;
  const reader=await (street??=prepareStreet(folder));
  const [{assets:rows,retry},{roofImagery}]=await Promise.all([
    reader.roofs([centerX,centerY],Math.hypot(w*CELL,h*CELL)/2+2*CELL,()=>roofSerial===serial),
    import("./roof-imagery"),
  ]);
  const existing=new Set(known);
  const nearby=rows.filter(asset=>{
    const [cx,cy]=asset.center;
    const [x0,y0,,x1,y1]=asset.coverage??[cx-2*CELL,cy-2*CELL,0,cx+2*CELL,cy+2*CELL];
    const id=asset.id??asset.name;
    return !existing.has(id)&&!rejectedRoofs.has(id)&&x0<right&&x1>left&&y0<top&&y1>bottom;
  }).sort((a,b)=>Math.hypot(a.center[0]-centerX,a.center[1]-centerY)-Math.hypot(b.center[0]-centerX,b.center[1]-centerY));
  for(const asset of nearby){
    if(roofSerial!==serial)return;
    const id=asset.id??asset.name;
    const result=await roofImagery(archive,asset,atlas.sectors,roofSector).catch(()=>null);
    if(!result)rejectedRoofs.add(id);
    else if(roofSerial===serial){
      existing.add(id);
      send({kind:"roofImage",serial,id,...result},[result.image]);
    }
    else result.image.close();
    await yieldTask();
  }
  if(retry&&roofSerial===serial)roofRefresh=setTimeout(()=>{
    void loadRoofs({kind:"roofRegion",serial,rect,known:[...existing]}).catch(error=>{
      if(roofSerial===serial)send({kind:"layerFailure",name:"roofs",message:(error as Error).message});
    });
  },8000);
}

async function requestLayer(name:LayerName){
  if(!state||layers.has(name))return;
  layers.add(name);
  const common=state.archives.get("common.rpf")!,levels=state.archives.get("levels.rpf")!;
  try{
    if(name==="districts"||name==="places"||name==="road-names"){
      let opened=openedLayers.get("data.rpf");
      if(!opened&&fileAvailable("data.rpf")){
        opened=openLayerArchive("data.rpf");openedLayers.set("data.rpf",opened);
      }
      const data=await opened?.catch(()=>undefined);
      if(data)english??=loadEnglish(data);
      if(name==="districts")send({kind:"districts",...await loadDistricts(levels,common,data,english)});
      else if(!english)throw new Error(name==="road-names"?"Road names require data.rpf.":"Places requires data.rpf.");
      else if(name==="places")send({kind:"places",places:await loadPlaces(common,english)});
      else {
        const {loadRoadNames}=await import("./road-names");
        const {rpf9ExecutableName}=await import("./rpf9-prepare");
        const roads=await loadRoadNames(levels,common,folder[rpf9ExecutableName],english);
        if(!roads.length)throw new Error("No road names matched the local road graph.");
        send({kind:"roadNames",roads});
      }
      return;
    }
    if(name==="height"||name==="surface"||name==="roads"||name==="cartography"||name==="lights"){
      const world=state.atlas.world;
      const read=await (overview??=openLayerArchive("textures.rpf").then(archive=>overviewLayers(archive,world)));
      const layer=await read(name);
      send({kind:"layer",...layer},"elevation" in layer?[layer.image,layer.elevation.buffer]:[layer.image]);
    }
  }catch(error){send({kind:"layerFailure",name,message:(error as Error).message});}
}

async function prepareStreet(files:Record<string,File>,reloading=false){
  const [{rpf9ExecutableName,verifyRpf9Executable},{createStreetWorker},opened]=await Promise.all([
    import("./rpf9-prepare"),import("./street-worker"),
    state??openArchives(files,path=>path==="levels.rpf")]);
  await verifyRpf9Executable(files[rpf9ExecutableName]);
  if(!opened.archives.has("levels.rpf"))throw new Error("levels.rpf is unavailable.");
  const reader=createStreetWorker(send);
  reader.open(opened,files,reloading);
  return reader;
}

worker.onmessage=(event:MessageEvent<Request>)=>{
  const request=event.data;
  if(request.kind==="streetMaterialsImport"){
    materials=Promise.all([import("./street-material-loader"),import("./street-asset-cache")])
      .then(([{StreetMaterialLoader},{StreetAssetCache}])=>new StreetMaterialLoader(request.files,
        request.reloading?undefined:new StreetAssetCache(request.files)));
    void materials.then(loader=>loader.prepare()).catch(()=>{});
    return;
  }
  if(request.kind==="streetTexture"&&materials){
    void materials.then(loader=>loader.read(request)).then(({event,transfer})=>send(event,transfer))
      .catch(()=>send({...request,image:null}));
    return;
  }
  if(request.kind==="streetIndexFile"){
    if(folder)folder[indexFileName]=request.file;
    void street?.then(reader=>reader.handle(request)).catch(()=>{});
    return;
  }
  if(request.kind==="streetImport"){
    street=prepareStreet(request.files,request.reloading);
    void street.then(()=>send({kind:"streetImported"})).catch(error=>send({kind:"streetFailure",message:(error as Error).message}));
    return;
  }
  if(request.kind.startsWith("street")||request.kind==="cancelStreetRegion"){
    if(request.kind==="cancelStreetRegion"&&!street)return;
    street??=prepareStreet(folder);
    void street.then(reader=>reader.handle(request)).catch(error=>{
      if(request.kind==="streetRegion")send({kind:"streetRegion",serial:request.serial,wanted:request.known,meshes:[],
        skipped:0,error:(error as Error).message});
      else if(request.kind==="streetSpawnProbe")send({kind:"streetSpawnProbe",serial:request.serial,height:null});
      else send({kind:"streetFailure",message:(error as Error).message});
    });
    return;
  }
  if(request.kind==="imagery"){
    imagery??=loadImagery();
    void imagery.catch(error=>send({kind:"imageryFailure",message:(error as Error).message,
      issues:error instanceof ImportFailure?error.issues:undefined}));
    return;
  }
  if(request.kind==="mapLayer"){void requestLayer(request.name);return;}
  if(request.kind==="roofRegion"){
    void loadRoofs(request).catch(error=>{
      if(roofSerial===request.serial)send({kind:"layerFailure",name:"roofs",message:(error as Error).message});
    });
    return;
  }
  if(request.kind==="cancelRank"){ranking++;return;}
  if(request.kind==="nativeMap"){
    const archive=state?.archives.get("levels.rpf");
    if(!archive){send({kind:"nativeFailure",message:"levels.rpf is unavailable."});return;}
    void loadNativeMap(archive,(done,total)=>send({kind:"nativeProgress",done,total})).then(scene=>{
      send({kind:"nativeMap",scene},[scene.vertices,scene.indices.buffer]);
    }).catch(error=>send({kind:"nativeFailure",message:(error as Error).message}));
    return;
  }
  const job=request.kind==="import"?start(request.files):request.kind==="rank"?rank(request):
    request.kind==="tile"||request.kind==="sector"?imageRequest(request):null;
  if(!job)return;
  void job.catch(error=>{
    if(request.kind==="tile"||request.kind==="sector"){
      send({kind:"tile",key:request.key});
      return;
    }
    send({kind:"failure",message:(error as Error).message,issues:error instanceof ImportFailure?error.issues:undefined});
  });
};

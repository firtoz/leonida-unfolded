import { sidebarStorageKey as sidebarKey, editsStorageKey as editsKey, layersStorageKey as layerKey,
  devSnapshotStorageKey as devSnapshotKey } from "./app-storage-constants";
import { RoadNames } from "./road-names";
import { StreetFpsChart } from "./street-fps-chart";
import { rememberDevFiles, reopenDevFiles } from "./dev-file-session";
import { Board, defaults, Images, layerNames, type LayerName } from "./board";
import { inputProfile, cellKey, CELL, type Atlas, type Issue, type Rect } from "./recover";
import { accept, dropped, rpf9ExecutableName } from "./inputs";
import { indexFileName } from "./street-index-bundle";
import { verifyRpf9Executable } from "./rpf9-prepare";
import { parseEdits, serialize } from "./edits";
import { hex } from "./archive";
import { DistrictView } from "./district-view";
import { TerrainView, type TerrainSource } from "./terrain-view";
import { StreetView, type StreetPose, type StreetSpawn } from "./street-view";
import { formatStreetDestination, maximumStreetPitch, parseStreetDestination } from "./street-destination";
import type { StreetChunk } from "./street-mesh";
import type { Event, MatchSide, Request, SketchPoint } from "./protocol";
import { LoadingOverlay } from "./loading-overlay";
import { pickWalkSurface, type Point3 } from "./walk-surface";
import type { NativeScene } from "./native-map";
import { NativeStreetImagery } from "./native-street-imagery";
import type { StreetStreamView } from "./street-priority";
import { dynamicTerrainPrefix } from "./street-terrain-material";
import { streetBudgets } from "./street-capacity";
import type { StreetEnvironment } from "./street-environment";
import type { StreetCloudAssets } from "./street-cloud-assets";
import type { StreetWaterOptics } from "./street-water-optics";
import type { StreetWaterMaterials } from "./street-water-materials";
import { canopyAtlasPrefix } from "./street-canopy-atlas";

const get=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const button=(id:string)=>get<HTMLButtonElement>(id);
const input=(id:string)=>get<HTMLInputElement>(id);
const canvas=get<HTMLCanvasElement>("map");
const districts=new DistrictView(get("district-overlay"),get("road-overlay"),get("district-hover"),
  (point,preview)=>board?.placeThumbnail(point,preview)??false);
const terrainCanvas=get<HTMLCanvasElement>("terrain-mesh");
const terrainButton=button("show-terrain"),terrainTilt=input("terrain-tilt"),terrainWater=input("terrain-water");
const terrainRelief=get<HTMLSelectElement>("terrain-relief");
const terrainStatus=get("terrain-status");
const streetDialog=get<HTMLDialogElement>("street-view");
const streetControls=get<HTMLDialogElement>("street-controls");
const streetControlsButton=button("street-controls-open");
const streetControlsKey="terrain-atlas.explore-controls-seen";
const skipExploreControls=new URLSearchParams(location.search).get("skipExploreControls")==="1";
let streetControlsSeen=false;
let controlsCollapse:HTMLElement|undefined;
try{streetControlsSeen=localStorage.getItem(streetControlsKey)==="true";}catch{}
const streetStatus=get("street-status"),streetRoadName=get("street-road-name"),mapRoadName=get("map-road-name");
const mapPlayer=get("map-player");
let pausedLocation:ReturnType<StreetView["destination"]>|null=null;
let streetRoadTimer=0,streetRoadCandidate:string|undefined,streetRoadPosition:Point3|null=null;
function setRoadChip(label:HTMLElement,name?:string){
  label.textContent=name??"";
  label.hidden=!name;
}
function resetStreetRoadName(){
  clearTimeout(streetRoadTimer);streetRoadTimer=0;
  streetRoadPosition=null;streetRoadCandidate=undefined;
  setRoadChip(streetRoadName);
}
function updateStreetRoadName(x:number,y:number,z:number){
  const roads=board?.opacity["road-names"]?districts.roads:null;
  if(!roads){if(streetRoadPosition)resetStreetRoadName();return;}
  const point:Point3=[x,y,z],previous=streetRoadPosition;
  streetRoadPosition=point;
  const current=streetRoadName.textContent||undefined;
  const jump=!previous||Math.hypot(x-previous[0],y-previous[1],z-previous[2])>40;
  const name=roads.near(x,y,z,jump?undefined:current);
  if(jump){
    clearTimeout(streetRoadTimer);streetRoadTimer=0;
    setRoadChip(streetRoadName,name);
  }else if(name!==streetRoadCandidate){
    clearTimeout(streetRoadTimer);streetRoadTimer=0;
    if(name!==current)streetRoadTimer=window.setTimeout(()=>{
      streetRoadTimer=0;
      setRoadChip(streetRoadName,name);
    },name?180:320);
  }
  streetRoadCandidate=name;
}
function updateMapRoadName(){
  const name=pausedLocation&&board?.opacity["road-names"]?districts.roads?.near(...pausedLocation.position):undefined;
  if(mapRoadName.textContent!==(name??""))setRoadChip(mapRoadName,name);
}
const streetDestination=get<HTMLFormElement>("street-destination"),streetXYZ=input("street-xyz");
let street:StreetView|null=null;
let streetEnvironment:StreetEnvironment|undefined,requestedStreetEnvironment=false;
let streetCloudNoise:Uint8Array<ArrayBuffer>|undefined;
let streetCloudAssets:StreetCloudAssets|undefined;
let streetWaterOptics:StreetWaterOptics|undefined;
let streetWaterTileRegion:StreetWaterOptics|undefined;
let streetWaterMaterials:StreetWaterMaterials|undefined;
let StreetViewType=StreetView;
let streetTextureEpoch=0;
let streetWorker:Worker|null=null,pendingStreetWorker:Worker|null=null;
let materialWorker:Worker|null=null;
let separateMaterials=streetBudgets.materialReads>=6;
let materialReload=false;
let reloadingStreet=false,streetBatches:StreetChunk[]=[];
let deferredMapMode:"browse"|"match"|null=null;
let mapBehindStreet=false;
let pendingStreetPose:{pose:StreetPose;navigation:boolean}|null=null;
let worldEntry:[number,number,number]|null=null,worldSerial=0,navigationSerial=0,vegetationSerial=0;
let karstYaw:number|undefined;
let terrainSource:TerrainSource|null=null,terrain:TerrainView|null=null;
let nativeLoading=false,nativeReady=false,raised=false,first3D=true;
let nativeScene:NativeScene|null=null;
const nativeImageryCache=new WeakMap<NativeScene,NativeStreetImagery>();
let placingWalk=false,walkCursor:readonly [number,number]|null=null,walkFrame=0,walkTimer=0,walkSerial=0;
let walkEntryPrepared=false;
let walkTarget:{point:Point3;structure?:boolean;blocked?:string;height?:number|null}|null=null;
let walkConfirmed=false,pickedSpawn:StreetSpawn|undefined;
let explorerDrag:{id:number;x:number;y:number;active:boolean}|null=null;
let explorerDropTimer=0,skipExplorerClick=false;
const exploreButton=button("walk-here"),explorerGhost=get("explorer-ghost"),walkMarker=get("walk-preview");
const reducedMotion=matchMedia("(prefers-reduced-motion: reduce)");
const flightSpawnClearance=12;
const workspace=get("workspace"),landing=get("landing"),sidebar=get("sidebar"),gallery=get("gallery");
const compactMap=matchMedia("(max-width: 700px)");
const sidebarSections=["layers","places","customize"] as const;
type SidebarSection=(typeof sidebarSections)[number];
const optionalSidebarItems=["places","coordinates","inspection","files"] as const;
type SidebarItem=(typeof optionalSidebarItems)[number];
type SidebarPreferences=Partial<Record<SidebarItem,boolean>> & {open?:boolean;exploreOpen?:boolean;section?:SidebarSection};
let sidebarPreferences:SidebarPreferences={};
try{
  const stored=JSON.parse(localStorage.getItem(sidebarKey)??"null") as SidebarPreferences|null;
  if(stored){
    for(const item of optionalSidebarItems)if(typeof stored[item]==="boolean")sidebarPreferences[item]=stored[item];
    if(typeof stored.open==="boolean")sidebarPreferences.open=stored.open;
    if(typeof stored.exploreOpen==="boolean")sidebarPreferences.exploreOpen=stored.exploreOpen;
    if(stored.section&&sidebarSections.includes(stored.section))sidebarPreferences.section=stored.section;
  }
}catch{}
const sidebarTabs=[...sidebar.querySelectorAll<HTMLButtonElement>("button[data-sidebar-tab]")];
let sidebarSection:SidebarSection=sidebarPreferences.section??"layers";
function saveSidebar(){
  try{localStorage.setItem(sidebarKey,JSON.stringify(sidebarPreferences));}catch{}
}
function setSidebarOpen(open:boolean){
  sidebar.hidden=!open;
  button("toggle-sidebar").setAttribute("aria-expanded",String(open));
}
const streetSidebar=get("street-sidebar"),streetSidebarButton=button("toggle-street-sidebar");
function setStreetSidebarOpen(open:boolean){
  streetSidebar.hidden=!open;
  streetSidebarButton.setAttribute("aria-expanded",String(open));
}
setStreetSidebarOpen(sidebarPreferences.exploreOpen??(sidebarPreferences.open??!compactMap.matches));
streetSidebarButton.onclick=()=>{
  sidebarPreferences.exploreOpen=streetSidebar.hidden;
  setStreetSidebarOpen(sidebarPreferences.exploreOpen);
  saveSidebar();
};
function showSidebarSection(section:SidebarSection){
  sidebarSection=section==="places"&&!sidebarPreferences.places?"layers":section;
  for(const tab of sidebarTabs){
    const selected=tab.dataset.sidebarTab===sidebarSection;
    tab.setAttribute("aria-pressed",String(selected));
    get(tab.getAttribute("aria-controls")!).hidden=!selected;
  }
}
function refreshSidebarOptions(){
  for(const item of optionalSidebarItems){
    const enabled=Boolean(sidebarPreferences[item]);
    input(`pref-${item}`).checked=enabled;
    get(item==="places"?"show-places":`sidebar-${item}`).hidden=!enabled;
  }
  showSidebarSection(sidebarSection);
}
refreshSidebarOptions();
for(const tab of sidebarTabs)tab.onclick=()=>{
  showSidebarSection(tab.dataset.sidebarTab as SidebarSection);
  sidebarPreferences.section=sidebarSection;
  saveSidebar();
};
for(const item of optionalSidebarItems)input(`pref-${item}`).onchange=event=>{
  sidebarPreferences[item]=(event.currentTarget as HTMLInputElement).checked;
  if(item==="inspection"&&!sidebarPreferences.inspection&&board){
    sketch=false;
    sampling=false;
    board.markers=false;
    button("show-markers").setAttribute("aria-pressed","false");
    inspect();board.draw();
  }
  refreshSidebarOptions();
  saveSidebar();
};
const loading=new LoadingOverlay(get("load-overlay"),get("load-jobs"));
const pendingTextures=new Set<string>();
let files:Record<string,File>=Object.create(null);
let fpsInputReady=false;
let worker:Worker|null=null,board:Board|null=null,atlas:Atlas|null=null;
let images:Images|null=null,readyEvent:Extract<Event,{kind:"ready"}>|null=null;
let imageryRequest:Promise<boolean>|null=null,finishImagery:((ok:boolean)=>void)|null=null;
let imageryFailure=false,imageryMilliseconds:number|undefined;
const requestedLayers=new Set<LayerName>();
let roofRegion="",roofSerial=0,roofTimer=0;
let issueRows:Issue[]=[];
let selectedMode:"browse"|"match"|null=null,results:string[]=[],rendered=0;
let districtFrame=0;
let serial=0,sketch=false,sampling=false,rankTimer=0,importToken=0;
let history:Map<string,string>[]=[];
let drag:{id:number;startX:number;startY:number;x:number;y:number;moved:boolean;rotate:boolean;stroke?:SketchPoint[]}|null=null;
const thumbnailCanvases=new Map<string,Set<HTMLCanvasElement>>();
const locale=(n:number)=>n.toLocaleString();
const mib=(n:number)=>(n/1048576).toFixed(1)+" MiB";
const sizeFormat=new Intl.NumberFormat(undefined,{maximumFractionDigits:1});
function indexSize(bytes:number){
  for(const [limit,unit] of [[1e9,"GB"],[1e6,"MB"],[1e3,"KB"]] as const)
    if(bytes>=limit)return `${sizeFormat.format(bytes/limit)} ${unit}`;
  return `${locale(bytes)} B`;
}
function selectedIndex(){
  const label=get("world-index-size"),file=files[indexFileName];
  label.hidden=!file;
  label.textContent=file?`Selected world index · ${indexSize(file.size)}`:"";
}
const seconds=(n:number)=>(n/1000).toFixed(1)+" s";
const sidebarWidth=()=>sidebar.hidden||compactMap.matches?0:sidebar.offsetWidth+24;
const notice=(text:string)=>{get("notice").textContent=text;};
function updateTextureLoading(){
  if(pendingTextures.size)loading.set("textures","Nearby textures",{detail:`${locale(pendingTextures.size)} pending`});
  else loading.clear("textures");
}
function nextStreetTextureEpoch(){
  streetTextureEpoch++;
  pendingTextures.clear();
  updateTextureLoading();
}
const textureJob=(id:string,ground:boolean)=>`${ground}:${id}`;
const send=(message:Request)=>{
  const target=message.kind==="streetTexture"&&streetWorker&&separateMaterials&&
    !message.id.startsWith(dynamicTerrainPrefix)&&!message.id.startsWith(canopyAtlasPrefix)
    ?startMaterialWorker():message.kind.startsWith("street")||message.kind==="cancelStreetRegion"?streetWorker??worker:worker;
  if(!target)return;
  switch(message.kind){
    case "nativeMap":loading.set("native","Pause-map geometry");break;
    case "imagery":loading.set("imagery","Satellite tile index");break;
    case "mapLayer":loading.set(`layer:${message.name}`,layerNames[message.name]);break;
    case "streetRegion":loading.clear("region-detail");break;
    case "cancelStreetRegion":loading.clear("region","region-detail","vegetation","navigation");break;
    case "streetVegetation":if(!message.point)loading.clear("vegetation");break;
    case "streetNavigation":
      if(message.point)loading.set("navigation","Nearby navigation");
      else loading.clear("navigation");
      break;
    case "streetTexture":
      pendingTextures.add(textureJob(message.id,message.ground));
      updateTextureLoading();
      break;
  }
  target.postMessage(message);
};
function makeWorker(){return new Worker(new URL("./worker.js",import.meta.url),{type:"module"});}

const executableRequirement=document.createElement("li");
executableRequirement.textContent=`${rpf9ExecutableName} (required for all game views)`;
get("file-list").append(executableRequirement);

for(const item of inputProfile){
  const li=document.createElement("li");
  li.textContent=`${item.path}${item.required?(item.path.endsWith(".ttpf")?" (satellite tiles)":" (pause map)"):" (optional)"}`;
  get("file-list").append(li);
}

function showIssues(target:string,issues:Issue[]){
  const list=get(target);
  list.replaceChildren();
  for(const {path,detail} of issues){
    const li=document.createElement("li");
    li.textContent=detail.startsWith(path)?detail:`${path} — ${detail}`;
    list.append(li);
  }
  list.hidden=!list.childElementCount;
}
function status(label:string,done?:number,total?:number){
  get("progress-panel").hidden=false;
  get("progress-label").textContent=label;
  const progress=get<HTMLProgressElement>("progress");
  if(done===undefined||total===undefined){progress.removeAttribute("value");return;}
  progress.max=Math.max(1,total);progress.value=done;
}
function importFailure(message:string,issues:Issue[]=[]){
  get("progress-panel").hidden=true;
  const error=get("import-error");
  error.textContent=message;error.hidden=false;
  showIssues("issues",issues);
}
function changedInputs(){
  setWalkPlacement(false);nativeScene=null;
  fpsInputReady=false;
  showFpsAvailability("Add the matching Xbox Series executable.");
  selectedIndex();
  loading.reset();loading.attach(workspace);pendingTextures.clear();
  importToken++;worker?.terminate();worker=null;
  streetWorker?.terminate();streetWorker=null;pendingStreetWorker?.terminate();pendingStreetWorker=null;
  streetEnvironment=undefined;streetCloudNoise=undefined;streetCloudAssets=undefined;
  streetWaterOptics=undefined;streetWaterTileRegion=undefined;
  streetWaterMaterials=undefined;requestedStreetEnvironment=false;
  materialWorker?.terminate();materialWorker=null;materialReload=false;
  reloadingStreet=false;streetBatches=[];pendingStreetPose=null;
  mapBehindStreet=false;deferredMapMode=null;
  terrain?.dispose();terrain=null;terrainSource=null;terrainButton.disabled=true;
  if(streetControls.open)streetControls.close();
  if(streetDialog.open)streetDialog.close();
  if(street)releaseStreet();
  worldEntry=null;worldSerial++;
  nativeLoading=false;nativeReady=false;raised=false;first3D=true;terrainTilt.value="0";
  canvas.classList.remove("projected");terrainCanvas.hidden=true;
  terrainMessage("");
  districts.districts=[];districts.mapLabels=[];districts.places=[];districts.roads=null;districts.cursor=null;drawDistricts();
  board?.dispose();board=null;atlas=null;images=null;readyEvent=null;
  finishImagery?.(false);finishImagery=null;imageryRequest=null;imageryFailure=false;imageryMilliseconds=undefined;
  requestedLayers.clear();
  clearTimeout(roofTimer);roofRegion="";roofSerial++;
  selectedMode=null;serial++;clearTimeout(rankTimer);history=[];
  sketch=false;sampling=false;drag=null;
  canvas.classList.remove("drawing","sampling","dragging");
  clearGallery();
  landing.hidden=false;workspace.hidden=true;
}
function showFpsAvailability(message:string){
  for(const id of ["walk-here","walk-karst","show-street"]){
    const control=button(id);
    control.disabled=!fpsInputReady;
    control.title=message||(control===exploreButton?"Drag the explorer onto the map or click to choose a spot":"");
  }
  const label=get("fps-requirement");
  label.textContent=message;
  label.hidden=fpsInputReady;
}
async function importFiles(list:File[]){
  const existing=Object.keys(files).length;
  accept(list,files);
  if(!Object.keys(files).some(path=>path!==indexFileName&&path!==rpf9ExecutableName)){
    importFailure("I couldn’t find an archive with a supported filename in that selection.");
    return;
  }
  if(import.meta.hot)rememberDevFiles(files);
  changedInputs();
  const token=importToken;
  get("import-error").hidden=true;
  get("issues").hidden=true;
  status("Checking the Xbox Series executable");
  try {
    await verifyRpf9Executable(files[rpf9ExecutableName]);
  }catch(error){
    if(importToken===token)importFailure((error as Error).message);
    return;
  }
  if(importToken!==token)return;
  fpsInputReady=true;
  showFpsAvailability("");
  status("Checking archive files");
  const source=makeWorker();
  worker=source;
  source.onmessage=(message:MessageEvent<Event>)=>{if(importToken===token)handle(message.data);};
  source.onerror=(error)=>{
    if(importToken!==token)return;
    loading.reset();pendingTextures.clear();
    const message=error.message||"The browser could not start the terrain worker.";
    if(readyEvent)notice(message);else importFailure(message);
  };
  send({kind:"import",files});
  if(!existing) get("progress-panel").scrollIntoView({block:"nearest"});
}
button("choose-folder").onclick=()=>input("folder").click();
button("choose-files").onclick=()=>input("files").click();
for(const id of ["folder","files"])input(id).onchange=()=>{
  const selected=Array.from(input(id).files??[]);
  input(id).value="";
  if(selected.length)void importFiles(selected);
};
button("choose-world-index").onclick=()=>input("world-index-file").click();
input("world-index-file").onchange=()=>{
  const picker=input("world-index-file"),file=picker.files?.[0];
  picker.value="";
  if(!file)return;
  files[indexFileName]=file;
  if(import.meta.hot)rememberDevFiles(files);
  selectedIndex();
  const message={kind:"streetIndexFile",file} satisfies Request;
  for(const target of new Set([worker,streetWorker,pendingStreetWorker]))target?.postMessage(message);
};
button("change-files").onclick=()=>{
  files=Object.create(null);
  if(import.meta.hot){
    sessionStorage.removeItem(devSnapshotKey);
    pendingSnapshot=null;
    rememberDevFiles(null);
  }
  changedInputs();get("import-error").hidden=true;get("issues").hidden=true;
  get("progress-panel").hidden=true;button("choose-folder").focus();
};
const drop=get("drop");
for(const type of ["dragenter","dragover"]){
  drop.addEventListener(type,event=>{event.preventDefault();drop.classList.add("over");});
}
drop.addEventListener("dragleave",event=>{if(!drop.contains(event.relatedTarget as Node))drop.classList.remove("over");});
window.addEventListener("dragover",event=>event.preventDefault());
window.addEventListener("drop",async event=>{
  event.preventDefault();drop.classList.remove("over");
  if(landing.hidden||!event.dataTransfer)return;
  try {
    status("Reading the selected folder");
    await importFiles(await dropped(event.dataTransfer));
  }catch(error){importFailure((error as Error).message);}
});

function updateStats(background?:Extract<Event,{kind:"background"}>){
  if(!readyEvent)return;
  const {bytes,milliseconds}=readyEvent;
  get("import-stats").textContent=`Imported in ${seconds(milliseconds)} · ${mib(bytes)} read`+
    (imageryMilliseconds===undefined?"":` · satellite index ${seconds(imageryMilliseconds)}`)+
    (background?.done?` · overview ${seconds(background.elapsed)} · ${mib(background.bytes)} total`:"");
}
function handle(event:Event){
  switch(event.kind){
    case "progress":
      if(board)loading.set("imagery","Satellite tile index",{
        detail:`${Math.round(100*event.done/Math.max(1,event.total))}%`,done:event.done,total:event.total});
      else status(event.label,event.done,event.total);
      break;
    case "failure":
      if(board){notice(event.message);break;}
      importFailure(event.message,event.issues);break;
    case "ready":{
      atlas=event.atlas;readyEvent=event;issueRows=event.issues;
      images=new Images(worker!,key=>{
        updateThumbnails(key);
        if(streetDialog.open)street?.refreshImagery();
        else board?.draw();
      });
      board=new Board(canvas,atlas,images,scale=>get("scale").textContent=`${Math.round(scale)} px / cell`);
      board.afterPaint=drawDistricts;
      board.projectDraw=()=>terrain?.draw();
      board.requestRoofs=requestRoofs;
      terrainButton.disabled=false;
      let saved:Partial<Record<LayerName,number>>={};
      try{
        const settings=JSON.parse(localStorage.getItem(layerKey)??"{}");
        if(settings&&typeof settings==="object")saved=settings;
      }catch(error){notice((error as Error).message);}
      for(const name of Object.keys(defaults) as LayerName[]){
        const n=saved[name];
        if(typeof n==="number"&&Number.isFinite(n))board.opacity[name]=Math.min(100,Math.max(0,n));
      }
      landing.hidden=true;workspace.hidden=false;
      setSidebarOpen(sidebarPreferences.open??!compactMap.matches);
      initializeLayers();updateWarnings();updateStats();inspect();
      get("counts").textContent="Satellite tiles load on demand";
      get("progress-panel").hidden=true;
      if(board.opacity.native)raisePauseMap();
      fitMap();syncProjection();canvas.focus({preventScroll:true});
      if(files["levels.rpf"])startStreetWorker();
      if(import.meta.hot)restoreViewer();
      break;
    }
    case "imageryReady":{
      loading.clear("imagery");
      if(!board||!atlas)break;
      loading.set("overview","Satellite overview");
      board.installAtlas(event.atlas);
      try{
        const edits=localStorage.getItem(editsKey);
        if(edits)board.fills=parseEdits(JSON.parse(edits),atlas,true);
      }catch(error){notice((error as Error).message);}
      issueRows.push(...event.issues);updateWarnings();
      get("counts").textContent=`${locale(atlas.cells.length)} recovered cells`;
      imageryMilliseconds=event.milliseconds;updateStats();
      finishImagery?.(true);finishImagery=null;
      inspect();board.draw();street?.refreshImagery();
      break;
    }
    case "imageryFailure":
      loading.clear("imagery","overview");
      imageryFailure=true;
      finishImagery?.(false);finishImagery=null;
      issueRows.push(...event.issues??[]);updateWarnings();
      get("counts").textContent="Satellite tiles unavailable";
      notice(event.message);inspect();break;
    case "roofImage":
      if(board&&event.serial===roofSerial)board.roofImage(event.id,event.image,event.rect);
      else event.image.close();
      break;
    case "layerFailure":
      loading.clear(`layer:${event.name}`);
      updateAvailable(event.name,false);
      notice(event.message);break;
    case "tile":images?.finish(event);break;
    case "layer":
      loading.clear(`layer:${event.name}`);
      board?.raster(event.name,event.image,event.rect);
      if(event.name==="roads")terrain?.installRoads(event.image,event.rect);
      if("elevation" in event){terrainSource=event;terrain?.installHeight(event);syncProjection();}
      drawLayerCards();
      updateAvailable(event.name,true);break;
    case "overview":board?.raster(event.name,event.image,event.rect);drawLayerCards();break;
    case "districts":
      loading.clear("layer:districts");
      districts.districts=event.districts;
      districts.mapLabels=event.mapLabels;
      updateAvailable("districts",event.districts.length>0);
      drawDistricts();
      break;
    case "places":
      loading.clear("layer:places");
      districts.places=event.places;
      updateAvailable("places",event.places.length>0);
      drawDistricts();
      break;
    case "roadNames":
      loading.clear("layer:road-names");
      districts.roads=new RoadNames(event.roads);
      drawDistricts();street?.refreshRoadName();updateMapRoadName();
      break;
    case "nativeProgress":
      loading.set("native","Pause-map geometry",{
        detail:`${Math.round(100*event.done/Math.max(1,event.total))}%`,done:event.done,total:event.total});
      break;
    case "nativeMap":
      loading.clear("native");
      nativeLoading=false;
      nativeScene=event.scene;
      street?.refreshImagery();
      if(terrain){
        try{
          terrain.installNative(event.scene);
          nativeReady=true;syncProjection();
        }catch(error){nativeFailed((error as Error).message);}
      }
      break;
    case "streetSpawnProbe":
      if(placingWalk&&walkTarget&&event.serial===walkSerial){
        walkTarget.height=walkTarget.structure&&event.height!==null&&Math.abs(event.height-walkTarget.point[2])>3
          ?null:event.height;
        renderWalkPreview();
        if(walkConfirmed)confirmWalk();
      }
      break;
    case "nativeFailure":loading.clear("native");nativeFailed(event.message);break;
    case "streetFailure":
      loading.clear("region","region-detail","vegetation","navigation");
      if(streetDialog.open)streetStatus.textContent=event.message;
      break;
    case "streetEnvironment":
      streetEnvironment=event.environment;
      updateStreetLighting();
      break;
    case "streetCloudNoise":
      streetCloudNoise=event.noise;
      street?.setCloudNoise(event.noise);
      break;
    case "streetCloudAssets":
      streetCloudAssets=event.assets;
      street?.setNativeClouds(event.assets);
      break;
    case "streetWaterOptics":
      streetWaterOptics=event.optics;
      street?.setWaterOptics(streetWaterOptics);
      break;
    case "streetWaterTileRegion":
      streetWaterTileRegion=event.optics;
      street?.setWaterTileRegion(streetWaterTileRegion);
      break;
    case "streetWaterMaterials":
      streetWaterMaterials=event.materials;
      street?.setWaterMaterials(streetWaterMaterials);
      break;
    case "streetRegion":
      if(worldEntry&&event.serial===worldSerial){
        loading.clear("region","region-detail");
        if(reloadingStreet){
          reloadingStreet=false;
          if(event.error)notice(event.error);
          else{
            nextStreetTextureEpoch();
            street?.refreshTextures();
            street?.installRegion(event.wanted,[...streetBatches,...event.meshes]);
          }
          streetBatches=[];
        }else street?.installRegion(event.wanted,event.meshes,event.error);
      }
      break;
    case "streetRegionBatch":
      if(worldEntry&&event.serial===worldSerial){
        if(reloadingStreet)streetBatches.push(...event.meshes);
        else street?.installRegion(null,event.meshes);
      }
      break;
    case "streetInteriors":
      if(worldEntry&&event.serial===worldSerial)street?.installInteriors(event.wanted,event.meshes,event.complete===true);
      break;
    case "streetPending":
      if(worldEntry&&event.serial===worldSerial)street?.installPending(event.boxes);
      break;
    case "streetBridgeLods":
      if(worldEntry&&event.serial===worldSerial)street?.installBridgeLods(event.links);
      break;
    case "streetTexture":
      if(event.epoch===streetTextureEpoch){
        pendingTextures.delete(textureJob(event.id,event.ground));
        updateTextureLoading();
        street?.installTexture(event.id,event.image,event.ground,event.compressed,event.cube,event.roadHeight);
      }
      break;
    case "streetNavigation":
      if(worldEntry&&event.serial===navigationSerial){
        loading.clear("navigation");
        street?.installNavigation(event.wanted,event.meshes);
      }
      break;
    case "streetVegetation":
      if(worldEntry&&event.serial===vegetationSerial){
        if(event.wanted!==null)loading.clear("vegetation");
        street?.installVegetation(event.wanted,event.meshes);
      }
      break;
    case "streetWork":{
      const {task,serial,done,total}=event;
      if(streetDialog.open&&serial===(task==="region"?worldSerial:vegetationSerial)){
        const phase=event.task==="region"?event.phase:undefined;
        if(phase==="detail"){
          if(total&&done!==undefined&&done<total)loading.set("region-detail","Terrain detail",{
            done,total,detail:`${locale(done)} / ${locale(total)}`,
          });
          else loading.clear("region-detail");
          break;
        }
        const stage=phase==="base"?"Terrain":phase==="remaining"?"Objects and terrain":"";
        loading.set(task,task==="region"?"Nearby geometry":"Nearby vegetation",{
          done,total,detail:total&&done!==undefined?[stage,`${locale(done)} / ${locale(total)}`].filter(Boolean).join(" · "):
            task==="region"?(phase==="planning"?"Finding nearby objects":"Preparing"):undefined});
      }
      break;
    }
    case "streetIndex":{
      const {scanned,total,persistent,running,done,error,savedBytes,savedSegments,estimatedSize,portable,portableError,packing}=event.status;
      const size=savedSegments?`${estimatedSize?"≈ ":""}${indexSize(savedBytes)}`:"";
      const label=get("world-index-size");
      label.hidden=!size&&!portableError;
      label.textContent=[size?`${portable?"Portable":"Saved"} world index · ${size}`:"",
        portableError?`${portableError} Reading the game archives.`:""].filter(Boolean).join(" ");
      if(portableError&&streetDialog.open)loading.set("index-file","Saved world index",{detail:portableError,paused:true});
      else loading.clear("index-file");
      if(packing)loading.set("world-index","Saving nearby-load index",packing);
      else if(done||!running&&!error)loading.clear("world-index");
      else loading.set("world-index","World index",{done:scanned,total,paused:!!error,
        detail:error?"Paused":`${locale(scanned)} / ${locale(total)}${size?` · ${size} saved`:persistent?"":" · this session"}`});
      break;
    }
    case "background":
      loading.clear("overview");
      if(event.done)updateStats(event);
      else{issueRows.push({path:event.path??"textures.rpf",required:false,detail:event.message});updateWarnings();}
      break;
    case "rank":
      if(event.serial!==serial||selectedMode!=="match")break;
      get("match-status").textContent=event.done===event.total
        ? `${locale(event.total)} candidates checked`:`Matching ${locale(event.done)} / ${locale(event.total)}`;
      populate(event.ids);
      break;
  }
}
function updateWarnings(){
  showIssues("optional-issues",issueRows);
  get("file-warning-title").textContent=`Optional inputs · ${issueRows.length} unavailable`;
  get("file-warnings").hidden=!issueRows.length;
}
const availableLayers=new Set<LayerName>();
const previousOpacity=new Map<LayerName,number>();
const presetLayers=["native","height","surface","atlas","coarse","cartography"] as const;
const presetButtons=[...document.querySelectorAll<HTMLButtonElement>("button[data-preset]")];

function ensureImagery(){
  if(!imageryRequest){
    imageryRequest=new Promise(resolve=>{finishImagery=resolve;});
    get("counts").textContent="Reading satellite tile index";
    send({kind:"imagery"});
    inspect();
  }
  return imageryRequest;
}
function loadVisibleLayers(){
  if(!board||mapBehindStreet||streetDialog.open||pendingSnapshot?.street)return;
  const {opacity}=board;
  if(opacity.atlas||opacity.coarse||opacity.roofs)void ensureImagery();
  if(!opacity.roofs)requestRoofs(null);
  for(const name of ["height","surface","roads","lights","cartography","districts","places","road-names"] as const){
    const requested=opacity[name]||name==="height"&&raised&&!opacity.native;
    if(!requested||!availableLayers.has(name)||requestedLayers.has(name))continue;
    requestedLayers.add(name);send({kind:"mapLayer",name});
  }
}
function requestRoofs(view:Rect|null){
  if(view&&(mapBehindStreet||streetDialog.open||pendingSnapshot?.street))return;
  if(!view){
    if(roofRegion){
      clearTimeout(roofTimer);roofRegion="";
      send({kind:"roofRegion",serial:++roofSerial,rect:null,known:[]});
    }
    return;
  }
  const [x,y,w,h]=view;
  const left=4*Math.floor(x/4),top=4*Math.floor(y/4);
  const rect:Rect=[left,top,4*Math.ceil((x+w)/4)-left,4*Math.ceil((y+h)/4)-top];
  const key=rect.join(",");
  if(roofRegion===key)return;
  roofRegion=key;
  clearTimeout(roofTimer);
  roofTimer=window.setTimeout(()=>{
    if(board?.opacity.roofs)send({kind:"roofRegion",serial:++roofSerial,rect,known:[...board.roofImages.keys()]});
  },120);
}
button("load-imagery").onclick=()=>choosePreset("photo");

function initializeLayers(){
  if(!board)return;
  availableLayers.clear();previousOpacity.clear();
  const layers=get("layers"),moreLayers=get("more-layers");
  layers.replaceChildren();moreLayers.replaceChildren();
  for(const name of Object.keys(layerNames) as LayerName[]){
    const row=document.createElement("div");row.className="layer";row.id=`layer-${name}`;
    const control=document.createElement("input");
    const binary=name==="roofs"||name==="native"||name==="districts"||name==="places"||name==="road-names";
    control.type=binary?"checkbox":"range";control.min="0";control.max="100";
    control.setAttribute("aria-label",binary?layerNames[name]:`${layerNames[name]} opacity`);
    control.oninput=()=>setLayer(name,binary?Number(control.checked)*100:Number(control.value));
    const out=document.createElement("output");
    const toggle=document.createElement("button");toggle.type="button";toggle.textContent=layerNames[name];
    toggle.className="layer-toggle";
    toggle.onclick=()=>setLayer(name,board?.opacity[name]?0:previousOpacity.get(name)??100);
    row.append(toggle,control,out);
    (name==="places"||name==="roads"||name==="districts"||name==="road-names"?layers:moreLayers).append(row);
    const optional=atlas?.optional??[];
    updateAvailable(name,["atlas","coarse","manual","native","districts","roofs"].includes(name)||
      (name==="places"||name==="road-names"?optional.includes("data.rpf"):optional.includes("textures.rpf")));
  }
  refreshLayers();
  drawLayerCards();
}

function refreshLayers(){
  if(!board)return;
  for(const name of Object.keys(layerNames) as LayerName[]){
    const row=get(`layer-${name}`);
    const control=row.querySelector("input")!,toggle=row.querySelector("button")!;
    const value=board.opacity[name];
    toggle.setAttribute("aria-pressed",String(value>0));
    control.value=String(value);control.checked=value>0;
    row.querySelector("output")!.value=control.type==="checkbox"?(value?"On":"Off"):`${value}%`;
  }
  const o=board.opacity;
  const preset=o.native?"native":o.atlas||o.coarse?"photo":o.height?"height":"";
  for(const button of presetButtons){
    button.setAttribute("aria-pressed",String(button.dataset.preset===preset));
    button.disabled=button.dataset.preset==="height"&&!availableLayers.has("height");
  }
}
function updateAvailable(name:LayerName,available:boolean){
  const row=get(`layer-${name}`);
  if(!row)return;
  if(available)availableLayers.add(name);else availableLayers.delete(name);
  row.querySelector("input")!.disabled=!available;
  row.querySelector("button")!.disabled=!available;
  row.classList.toggle("unavailable",!available);
  if(name==="road-names")row.title=available?"Shows nearby road names while exploring":"Requires data.rpf from the selected game folder";
  if(name==="height")for(const button of presetButtons){
    if(button.dataset.preset==="height")button.disabled=!available;
  }
}
function saveLayers(){
  if(!board)return;
  try{localStorage.setItem(layerKey,JSON.stringify(board.opacity));}catch{}
  refreshLayers();
}
function setLayer(name:LayerName,value:number){
  if(!board)return;
  if(board.opacity[name])previousOpacity.set(name,board.opacity[name]);
  board.opacity[name]=value;
  if(name==="native"&&value)raisePauseMap();
  syncProjection();saveLayers();board.draw();
  if(name==="road-names")updateMapRoadName();
}
function raisePauseMap(){
  if(!raised&&!Number(terrainTilt.value))terrainTilt.value="41";
  raised=true;
  first3D=false;
}
function choosePreset(name:string){
  if(!board)return;
  for(const layer of presetLayers){
    if(board.opacity[layer])previousOpacity.set(layer,board.opacity[layer]);
    board.opacity[layer]=0;
  }
  if(name==="native"){board.opacity.native=100;raisePauseMap();}
  if(name==="height")board.opacity.height=100;
  if(name==="photo"){board.opacity.atlas=100;board.opacity.coarse=100;board.opacity.height=100;}
  syncProjection();saveLayers();board.draw();
}
function drawLayerCards(){
  const names:Record<string,LayerName>={photo:"atlas",native:"cartography",height:"height"};
  for(const button of presetButtons){
    const preview=button.querySelector("canvas")!;
    const image=board?.rasters.get(names[button.dataset.preset!])?.image;
    const ctx=preview.getContext("2d")!;
    ctx.clearRect(0,0,preview.width,preview.height);
    if(!image)continue;
    const w=image.width*.45,h=Math.min(image.height,w*preview.height/preview.width);
    ctx.drawImage(image,(image.width-w)*.54,(image.height-h)*.6,w,h,0,0,preview.width,preview.height);
  }
}
for(const card of presetButtons)card.onclick=()=>choosePreset(card.dataset.preset!);
sidebar.addEventListener("keydown",event=>{
  if(event.key!=="Escape")return;
  event.stopPropagation();
  button("toggle-sidebar").click();
  button("toggle-sidebar").focus();
});

function selectedKey(){
  return board?.selected?cellKey(...board.selected):null;
}
function inspect(){
  if(!board||!atlas)return;
  const imageryReady=atlas.cells.length>0;
  const openImagery=button("load-imagery");
  openImagery.hidden=imageryReady||imageryFailure;
  openImagery.disabled=Boolean(finishImagery);
  const key=selectedKey();
  const fixed=key?board.tiles.get(key):undefined;
  const fill=key?board.fills.get(key):undefined;
  const selection=get("selection"),description=get("selection-description"),provenance=get("provenance");
  const editable=imageryReady&&key!==null&&board.canEdit(key);
  get("edit-tools").hidden=!editable;
  button("undo").disabled=!history.length;
  button("place").disabled=!board.preview||!editable;
  button("place").textContent=fill?"Replace fill":"Place preview";
  button("remove").disabled=!fill;
  get("source-details").hidden=!fixed;
  get("sketch-tools").hidden=!sketch;
  button("sketch").setAttribute("aria-pressed",String(sketch));
  button("sample").setAttribute("aria-pressed",String(sampling));
  canvas.classList.toggle("drawing",sketch);canvas.classList.toggle("sampling",sampling);
  if(!key||!board.selected){
    selection.textContent="Select a cell";
    description.textContent=imageryReady?"Click the map to inspect a texture or fill a gap.":"Click the map to select a cell.";
    return;
  }
  const [x,y]=board.selected;
  selection.textContent=fill?"Manual fill":fixed?"Recovered tile":imageryReady?"Editable gap":"Selected cell";
  description.textContent=`Cell (${x}, ${-y-1})${board.sectors.has(key)&&!fixed&&!fill?" · sector imagery":""}`;
  if(fixed){
    const texture=atlas.textures[fixed.id];
    const mip=images?.get(images.key(fixed.id,1024))?.info;
    provenance.textContent=[
      fixed.id,texture.pack,`ETPF descriptor ${texture.index} · ${hex(texture.descriptorOffset)}`,
      `World XY · (${x*CELL}, ${(-y-1)*CELL}) to (${(x+1)*CELL}, ${-y*CELL})`,
      fixed.recovery==="seams"?"Placement verified against four neighboring edges":
        fixed.recovery==="seams-and-sector"?"Placement verified against neighboring edges and the sector image":
        fixed.recovery==="edges"?"Placement verified against neighboring edges. Lower Recovered tiles opacity to compare with sector imagery.":
        fixed.recovery==="sector"?"Placement verified against the sector image":"",
      ...fixed.meshes.map(m=>`${m.name}\nlevels.rpf ${hex(m.offset)} · binding ${hex(m.bindingOffset)}`),
      fixed.boundsOffset!==undefined?`Sector bounds · levels.rpf ${hex(fixed.boundsOffset)}`:"",
      mip?`Readable mip ${mip.width} px · row ${mip.stream} · ${hex(mip.offset)}`:"",
    ].filter(Boolean).join("\n");
  }
  if(board.preview)description.textContent+=" · Preview active";
}
function select(x:number,y:number){
  if(!board||!board.contains(x,y))return;
  if(board.selected?.[0]===x&&board.selected[1]===y)return;
  board.selected=[x,y];board.preview=null;board.strokes=[];
  sketch=false;sampling=false;clearTimeout(rankTimer);serial++;send({kind:"cancelRank"});
  selectedMode=null;clearGallery();get("match-status").textContent="";
  inspect();board.draw();
}
get<HTMLFormElement>("go-to-cell").onsubmit=event=>{
  event.preventDefault();
  if(!board)return;
  const value=input("cell-search").value.trim().replaceAll("−","-");
  const match=value.replace(/^\((.*)\)$/,"$1").trim().match(/^([+-]?\d+)(?:\s*,\s*|\s+)([+-]?\d+)$/);
  if(!match){notice("Enter the east and north cell coordinates, such as −23, 47.");return;}
  const x=Number(match[1]),y=-Number(match[2])-1;
  if(!board.contains(x,y)){notice("That cell is outside the map.");return;}
  select(x,y);centerMap(x,y);notice("");
};
get<HTMLFormElement>("find").onsubmit=async event=>{
  event.preventDefault();
  if(!board||!atlas)return;
  const value=input("texture-search").value.trim().toLowerCase();
  if(!/^(?:0x)?[0-9a-f]{1,16}$/.test(value)){notice("Enter a hexadecimal texture ID.");return;}
  if(!await ensureImagery()||!atlas||!board)return;
  const id="0x"+value.replace(/^0x/,"").padStart(16,"0");
  const tile=atlas.cells.find(cell=>cell.id===id);
  if(tile){select(tile.x,tile.y);centerMap(tile.x,tile.y);notice("");return;}
  if(!Object.hasOwn(atlas.textures,id)){notice("That texture ID was not found in the selected files.");return;}
  const key=selectedKey();
  if(key&&board.canEdit(key)){stage(id);notice("Texture previewed in the selected cell.");}
  else notice("The texture is available. Select a gap to preview it.");
};
function terrainMessage(message:string){
  terrainStatus.textContent=message;
  terrainStatus.hidden=!message;
}
function syncProjection(force=false){
  if(!board)return;
  const tilt=Number(terrainTilt.value),native=Boolean(board.opacity.native);
  const projected=force||raised||tilt>0||Boolean(terrain?.angle)||native;
  if(projected){
    if(!terrain){
      try{
        const current=board;
        terrain=new TerrainView(terrainCanvas,current.atlas.world,(rect,density,scale)=>
          current.project(rect,density,scale,Boolean(current.opacity.native)&&nativeReady));
        terrain.afterPaint=drawDistricts;
        if(terrainSource)terrain.installHeight(terrainSource);
        const roads=board.rasters.get("roads");
        if(roads)terrain.installRoads(roads.image,roads.rect);
      }catch(error){
        raised=false;terrainTilt.value="0";board.opacity.native=0;
        if(!board.opacity.atlas&&!board.opacity.height){board.opacity.atlas=100;board.opacity.coarse=100;}
        terrainMessage((error as Error).message);refreshLayers();
        loadVisibleLayers();board.draw();
        terrainButton.setAttribute("aria-pressed","false");
        return;
      }
    }
    if(!board.projected)terrain.open(board.mapPoint(canvas.clientWidth/2,canvas.clientHeight/2),board.scale);
    terrain.raised=raised;terrain.tilt=tilt;
    terrain.relief=Number(terrainRelief.value);
    terrain.waterEffects=terrainWater.checked;
    terrain.showNative=native&&nativeReady;
    terrain.roadOpacity=board.opacity.roads;
  }else if(board.projected&&terrain){
    board.scale=terrain.scale;
    board.x=terrain.center[0]-canvas.clientWidth/(2*board.scale);
    board.y=terrain.center[1]-canvas.clientHeight/(2*board.scale);
  }
  board.projected=projected;
  terrainCanvas.hidden=!projected;
  canvas.classList.toggle("projected",projected);
  terrainButton.setAttribute("aria-pressed",String(raised));
  terrainButton.textContent=raised?"2D":"3D";
  terrainButton.title=raised?"Flatten the terrain and keep the camera angle":"Raise the map into 3D";
  terrainRelief.disabled=!raised;
  terrainWater.disabled=!raised||native||!terrainSource;
  if(mapBehindStreet||pendingSnapshot?.street)return;
  if(native){
    if(nativeReady)terrainMessage("Native geometry · viewer colors");
    else if(!nativeLoading){
      nativeLoading=true;terrainMessage("Reading pause-map geometry");send({kind:"nativeMap"});
    }
  }else terrainMessage("");
  loadVisibleLayers();board.draw();updateScale();
}

function nativeFailed(message:string){
  nativeLoading=false;nativeReady=false;
  if(board?.opacity.native){choosePreset("photo");terrainMessage(message);}
}
function fitMap(){
  if(!board)return;
  board.fit(sidebarWidth());
  if(board.projected&&terrain){
    const center=board.mapPoint(canvas.clientWidth/2,canvas.clientHeight/2);
    terrain.open(center,board.scale*(terrain.tilt>10?.86:1));
  }
  updateScale();
}
function centerMap(x:number,y:number,minScale=92){
  if(!board)return;
  if(board.projected&&terrain){
    // Put the selected cell in the visible area alongside the inspector.
    terrain.open([x+.5,y+.5],Math.max(minScale,terrain.scale));
    terrain.pan(canvas.clientWidth/2,canvas.clientHeight/2,(canvas.clientWidth-sidebarWidth())/2,canvas.clientHeight/2);
  }else board.center(x,y,sidebarWidth(),minScale);
  updateScale();
}
function updateScale(){
  if(board)get("scale").textContent=`${Math.round(board.projected&&terrain?terrain.scale:board.scale)} px / cell`;
}
function mapPoint(x:number,y:number){
  return board?.projected?terrain?.mapPoint(x,y):board?.mapPoint(x,y);
}
function setWalkPlacement(active:boolean,fromDrag=false,committing=false){
  if(walkEntryPrepared){
    if(!committing)send({kind:"streetPrepareEntry",point:null});
    walkEntryPrepared=false;
  }
  placingWalk=active;
  walkCursor=null;walkTarget=null;walkConfirmed=false;
  cancelAnimationFrame(walkFrame);walkFrame=0;
  clearTimeout(walkTimer);walkSerial++;
  clearTimeout(explorerDropTimer);explorerDropTimer=0;
  walkMarker.classList.remove("is-dropping");
  if(!active)endExplorerDrag();
  exploreButton.setAttribute("aria-pressed",String(active));
  canvas.classList.toggle("placing-walk",active);
  get("walk-preview").hidden=true;
  get("walk-status").hidden=!active;
  if(active){
    startStreetWorker();
    send({kind:"streetPrepareWorld",collision:true});
    canvas.focus({preventScroll:true});
    districts.cursor=null;drawDistricts();
    if(fromDrag){renderWalkPreview();return;}
    const selected=board?.selected;
    const anchor=selected?[selected[0]+.5,selected[1]+.5] as const:null;
    if(anchor&&board){
      if(board.projected&&terrain){
        const surface=nativeScene&&terrain.showNative?pickWalkSurface(nativeScene,{
          origin:[...anchor,1000],direction:[0,0,-1],minimum:0}):undefined;
        const screen=terrain.projectAnchor(anchor,surface?surface.point[2]*CELL:undefined);
        if(screen&&screen.x>=0&&screen.y>=0&&screen.x<canvas.clientWidth-sidebarWidth()&&screen.y<canvas.clientHeight)
          walkCursor=[screen.x,screen.y];
      }else walkCursor=[(anchor[0]-board.x)*board.scale,(anchor[1]-board.y)*board.scale];
    }
    walkCursor??=[(canvas.clientWidth-sidebarWidth())/2,canvas.clientHeight/2];
    sampleWalkPreview();
  }
}
function renderWalkPreview(){
  const marker=walkMarker,status=get("walk-status"),target=walkTarget;
  marker.hidden=!placingWalk||!target||!walkCursor;
  if(walkCursor){
    marker.style.left=`${walkCursor[0]}px`;
    marker.style.top=`${walkCursor[1]}px`;
  }
  marker.dataset.state=target?.blocked?"blocked":target?.height===null?"flight":typeof target?.height==="number"?"ready":"checking";
  const dragging=explorerDrag?.active;
  const action=dragging?"Release":"Click";
  const message=target?.blocked??(explorerDropTimer?"Opening explorer…":typeof target?.height==="number"
    ?`${action} to start walking`
    :target?.height===null?`${action} to start flying`
    :target?"Checking walking surface…":dragging?"Drag onto the map to explore":"Click a spot to spawn · Esc to cancel");
  if(status.textContent!==message)status.textContent=message;
}
function sampleWalkPreview(){
  if(!placingWalk||!walkCursor||!board||!atlas||walkConfirmed||explorerDropTimer)return;
  const [x,y]=walkCursor;
  const position=mapPoint(x,y);
  const ray=board.projected?terrain?.walkRay(x,y):position?
    {origin:[...position,1000] as Point3,direction:[0,0,-1] as Point3,minimum:0}:null;
  const useNative=!!nativeScene&&(!board.projected||terrain?.showNative);
  const hit=ray&&nativeScene&&useNative?pickWalkSurface(nativeScene,ray):undefined;
  const at=hit?.point??(position?[...position,0] as Point3:null);
  const [left,top,width,height]=atlas.world;
  const blocked=!at||at[0]<left||at[0]>=left+width||at[1]<top||at[1]>=top+height?"Choose a spot inside the map":undefined;
  const flight=hit?!hit.walkable:useNative;
  const point:Point3=at?[at[0]*CELL,-at[1]*CELL,at[2]*CELL]:[0,0,0];
  if(walkTarget&&walkTarget.blocked===blocked&&Math.hypot(...point.map((value,i)=>value-walkTarget!.point[i]))<.015){
    renderWalkPreview();
    return;
  }
  clearTimeout(walkTimer);
  const serial=++walkSerial;
  walkTarget={point,structure:hit?.structure,blocked,height:flight?null:undefined};
  renderWalkPreview();
  if(!blocked&&!flight)walkTimer=window.setTimeout(()=>send({kind:"streetSpawnProbe",serial,point:[point[0],point[1]],
    hint:hit?point[2]:undefined}),130);
}
function queueWalkPreview(){
  if(placingWalk&&walkCursor&&!drag&&!walkFrame)walkFrame=requestAnimationFrame(()=>{
    walkFrame=0;sampleWalkPreview();
  });
}
function prepareWalkEntry(point:Point3){
  // The picked position is stable once confirmed. Ordinary hover only
  // requests the existing ground-height probe, never the asset catalog.
  if(street||walkEntryPrepared||files[indexFileName])return;
  walkEntryPrepared=true;
  send({kind:"streetPrepareEntry",point:[point[0],point[1]]});
}
function confirmWalk(){
  if(explorerDropTimer)return;
  const target=walkTarget;
  if(!target||target.blocked)return;
  walkConfirmed=true;
  prepareWalkEntry(target.point);
  if(target.height===undefined)return;
  const [x,y,z]=target.point;
  setWalkPlacement(false,false,true);
  if(target.height===null)openStreetWorld([x,y,z+flightSpawnClearance],undefined,{flying:true});
  else openStreetWorld([x,y,target.height],undefined,{matchHeight:true});
}
function drawMapPlayer(project:(point:readonly [number,number])=>readonly [number,number]|null){
  if(!pausedLocation||!board){mapPlayer.hidden=true;return;}
  const [x,y]=pausedLocation.position;
  const position=[x/CELL,-y/CELL] as const;
  const anchor=project(position);
  const viewport=canvas.clientWidth-sidebarWidth();
  mapPlayer.hidden=!anchor||anchor[0]<0||anchor[0]>viewport||anchor[1]<0||anchor[1]>canvas.clientHeight;
  if(mapPlayer.hidden||!anchor)return;
  const radians=(pausedLocation.heading??0)*Math.PI/180;
  const ahead=project([position[0]+Math.sin(radians)*.2,position[1]-Math.cos(radians)*.2]);
  const heading=ahead?Math.atan2(ahead[0]-anchor[0],anchor[1]-ahead[1])*180/Math.PI:radians*180/Math.PI;
  mapPlayer.style.left=`${anchor[0]}px`;
  mapPlayer.style.top=`${anchor[1]}px`;
  mapPlayer.style.setProperty("--map-player-heading",`${heading}deg`);
}
let mapMotionTimer=0,districtHoverTimer=0;
function clearDistrictHover(){
  clearTimeout(districtHoverTimer);
  districts.cursor=null;
  districts.hideTooltip();
}
function mapMotion(){
  clearDistrictHover();
  clearTimeout(mapMotionTimer);
  mapMotionTimer=window.setTimeout(()=>{
    mapMotionTimer=0;
    if(!drag?.moved&&!workspace.hidden&&!streetDialog.open)drawDistricts();
  },120);
}
function drawDistricts(){
  if(districtFrame){cancelAnimationFrame(districtFrame);districtFrame=0;}
  if(document.hidden)return;
  const current=board;
  const perspective=current?.projected?terrain:null;
  const anchor=perspective?.anchorProjection();
  const project=(p:readonly [number,number])=>{
    if(anchor){
      const projected=anchor(p);
      return projected?[projected.x,projected.y] as const:null;
    }
    return current?[(p[0]-current.x)*current.scale,(p[1]-current.y)*current.scale] as const:null;
  };
  const view=perspective?[...perspective.center,perspective.scale,perspective.angle,perspective.tilt,perspective.raised,
    perspective.relief,perspective.showNative,perspective.sceneRevision].join(","):
    [current?.x,current?.y,current?.scale].join(",");
  const labelProjection=perspective?.anchorProjection(true);
  const fade=districts.draw(Boolean(current?.opacity.districts&&districts.districts.length),
    Boolean(current?.opacity.places&&districts.places.length),Boolean(current?.opacity["road-names"]),
    perspective?.scale??current?.scale??0,
    project,([x,y])=>mapPoint(x,y)??null,
    Boolean(mapMotionTimer||drag?.moved),
    `${view}:${current?.opacity.districts??0}:${districts.districts.length}:${districts.mapLabels.length}`,
    labelProjection??(world=>{
      const point=project(world);
      return point?{x:point[0],y:point[1],depth:0}:null;
    }),points=>perspective?.visibleAnchors(points)??points.map(()=>true));
  drawMapPlayer(project);
  if(fade)districtFrame=requestAnimationFrame(drawDistricts);
  queueWalkPreview();
}
document.addEventListener("visibilitychange",()=>{
  if(document.hidden){
    cancelAnimationFrame(districtFrame);districtFrame=0;
    clearTimeout(mapMotionTimer);mapMotionTimer=0;
    clearDistrictHover();
    board?.cancelDraw();
    terrain?.cancelDraw();
    drag=null;canvas.classList.remove("dragging");
    if(explorerDrag?.active)setWalkPlacement(false);
    return;
  }
  if(!streetDialog.open)board?.draw();
});
canvas.onpointerleave=()=>{
  if(explorerDrag?.active)return;
  clearDistrictHover();
  if(placingWalk&&!walkConfirmed&&!explorerDropTimer){
    walkCursor=null;walkTarget=null;clearTimeout(walkTimer);walkSerial++;renderWalkPreview();
  }
};
function panMap(dx:number,dy:number,x=canvas.clientWidth/2,y=canvas.clientHeight/2){
  mapMotion();
  if(board?.projected&&terrain)terrain.pan(x-dx,y-dy,x,y);else board?.pan(dx,dy);
}
button("fit").onclick=fitMap;
terrainButton.onclick=()=>{
  if(!board)return;
  raised=!raised;
  if(raised&&first3D){
    first3D=false;
    if(!Number(terrainTilt.value))terrainTilt.value="41";
    choosePreset("native");
  }else syncProjection();
  canvas.focus({preventScroll:true});
};
terrainTilt.oninput=()=>syncProjection();
terrainRelief.onchange=()=>syncProjection();
terrainWater.oninput=()=>syncProjection();
button("reset-angle").onclick=()=>{
  if(terrain)terrain.angle=0;
  terrainTilt.value="0";syncProjection();
};
terrainCanvas.addEventListener("webglcontextlost",event=>{
  event.preventDefault();
  raised=false;terrainTilt.value="0";
  if(terrain)terrain.angle=0;
  if(board?.opacity.native)choosePreset("photo");
  else syncProjection();
  terrain?.dispose();terrain=null;nativeReady=false;
  terrainButton.disabled=true;
  terrainMessage("WebGL lost its graphics context.");
});
terrainCanvas.addEventListener("webglcontextrestored",()=>{terrainButton.disabled=!board;});
const zoom=(factor:number,x=(canvas.clientWidth-sidebarWidth())/2,y=canvas.clientHeight/2)=>{
  if(!board)return;
  mapMotion();
  if(board?.projected&&terrain)terrain.zoom(factor,x,y);else board?.zoom(factor,x,y);
  updateScale();
};
button("zoom-in").onclick=()=>zoom(1.6);
button("zoom-out").onclick=()=>zoom(1/1.6);
button("toggle-sidebar").onclick=()=>{
  const open=sidebar.hidden;
  setSidebarOpen(open);
  sidebarPreferences.open=open;
  saveSidebar();
};
button("show-markers").onclick=()=>{
  if(!board)return;
  if(!atlas?.cells.length)void ensureImagery();
  board.markers=!board.markers;button("show-markers").setAttribute("aria-pressed",String(board.markers));board.draw();
};
canvas.onwheel=event=>{
  if(!board)return;
  event.preventDefault();
  const factor=event.deltaMode===1?16:event.deltaMode===2?160:1;
  zoom(Math.exp(-Math.max(-240,Math.min(240,event.deltaY*factor))*.002),event.offsetX,event.offsetY);
};
canvas.addEventListener("wheel",()=>{}, {passive:false});

function ink() {
  const color=input("ink").value.slice(1);
  return [0,2,4].map(offset=>parseInt(color.slice(offset,offset+2),16)) as [number,number,number];
}
function point(x:number,y:number):SketchPoint|null {
  if(!board?.selected)return null;
  const at=mapPoint(x,y);
  if(!at)return null;
  const [wx,wy]=at;
  const px=wx-board.selected[0],py=wy-board.selected[1];
  return px>=0&&py>=0&&px<=1&&py<=1
    ? {x:px,y:py,color:get<HTMLSelectElement>("sketch-mode").value==="color"?ink():undefined}:null;
}
canvas.onpointerdown=event=>{
  if(!board||event.button!==0)return;
  canvas.focus({preventScroll:true});
  const {offsetX:x,offsetY:y,pointerId:id}=event;
  if(!placingWalk&&!event.shiftKey&&(sampling||sketch&&event.ctrlKey)){
    const value=(board.projected&&terrain?terrain.color(x,y):board.color(x,y)).map(c=>c.toString(16).padStart(2,"0")).join("");
    input("ink").value="#"+value;
    get<HTMLSelectElement>("sketch-mode").value="color";
    sampling=false;inspect();return;
  }
  clearDistrictHover();
  drag={id,startX:x,startY:y,x,y,moved:false,rotate:event.shiftKey};
  const start=!placingWalk&&sketch&&!event.shiftKey?point(x,y):null;
  if(start){drag.stroke=[start];board.strokes.push(drag.stroke);board.draw();}
  canvas.setPointerCapture(id);
};
canvas.onpointermove=event=>{
  if(!board||explorerDrag?.active)return;
  const {offsetX:x,offsetY:y}=event;
  const at=mapPoint(x,y);
  if(!placingWalk&&!drag&&!sketch&&!sampling&&(board.opacity.districts||board.opacity.places||board.opacity["road-names"])){
    clearDistrictHover();
    districtHoverTimer=window.setTimeout(()=>{
      if(drag||mapMotionTimer||placingWalk)return;
      districts.cursor=[x,y];
      drawDistricts();
    },140);
  }
  if(placingWalk&&!walkConfirmed&&!explorerDropTimer){
    walkCursor=[x,y];
    if(drag&&Math.hypot(x-drag.startX,y-drag.startY)>4)get("walk-preview").hidden=true;
    else queueWalkPreview();
  }
  get("position").textContent=at?`XY ${Math.round(at[0]*CELL)}, ${Math.round(-at[1]*CELL)}`:"";
  if(!drag||drag.id!==event.pointerId)return;
  if(drag.stroke){
    const p=point(x,y);
    if(p&&drag.stroke.length<1024){
      const prev=drag.stroke.at(-1)!;
      if(Math.hypot(p.x-prev.x,p.y-prev.y)>.004){drag.stroke.push(p);board.draw();scheduleRank();}
    }
  }else {
    drag.moved||=Math.hypot(x-drag.startX,y-drag.startY)>4;
    if(drag.moved){
      canvas.classList.add("dragging");
      if(drag.rotate||event.shiftKey){
        mapMotion();
        if(!board.projected)syncProjection(true);
        if(terrain){
          terrain.rotate(x-drag.x,y-drag.y);
          terrainTilt.value=terrain.tilt.toFixed(2);
          syncProjection();
        }
      }else panMap(x-drag.x,y-drag.y,x,y);
    }
  }
  drag.x=x;drag.y=y;
};
canvas.onpointerup=event=>{
  if(!board||drag?.id!==event.pointerId)return;
  if(drag.stroke)scheduleRank();
  else if(!drag.moved){
    if(placingWalk&&!walkConfirmed&&!explorerDropTimer){
      walkCursor=[event.offsetX,event.offsetY];sampleWalkPreview();confirmWalk();
    }else if(!placingWalk){
      const at=mapPoint(event.offsetX,event.offsetY);
      if(at)select(Math.floor(at[0]),Math.floor(at[1]));
    }
  }
  if(drag.moved)mapMotion();
  drag=null;canvas.classList.remove("dragging");
  queueWalkPreview();
};
canvas.onpointercancel=()=>{
  if(drag?.moved)mapMotion();
  drag=null;canvas.classList.remove("dragging");
};
canvas.onkeydown=event=>{
  if(!board)return;
  const shifts:Record<string,[number,number]>={ArrowLeft:[100,0],ArrowRight:[-100,0],ArrowUp:[0,100],ArrowDown:[0,-100]};
  if(shifts[event.key])panMap(...shifts[event.key]);
  else if(event.key==="+"||event.key==="=")zoom(1.6);
  else if(event.key==="-")zoom(1/1.6);
  else if(event.key==="Enter"){
    if(placingWalk){sampleWalkPreview();confirmWalk();}
    else commit();
  }
  else if(event.key==="Escape"){
    if(placingWalk){setWalkPlacement(false);event.preventDefault();return;}
    if(pausedLocation){resumeStreet();event.preventDefault();return;}
    if(sketch||sampling){sketch=false;sampling=false;}
    else{board.preview=null;board.selected=null;board.strokes=[];}
    inspect();board.draw();
  }else return;
  event.preventDefault();
};

const lazyThumbs=new IntersectionObserver(entries=>{
  for(const item of entries){
    if(!item.isIntersecting||!images)continue;
    const target=item.target as HTMLCanvasElement;
    const id=target.dataset.id!;
    lazyThumbs.unobserve(target);
    const {key,entry}=images.thumbnail(id);
    if(entry)target.getContext("2d")!.drawImage(entry.image,0,0,target.width,target.height);
    else {
      let group=thumbnailCanvases.get(key);
      if(!group)thumbnailCanvases.set(key,group=new Set());
      group.add(target);
    }
  }
},{root:gallery,rootMargin:"120px"});
const lazyPages=new IntersectionObserver(entries=>{
  if(entries.some(entry=>entry.isIntersecting))appendPage();
},{root:gallery,rootMargin:"90px"});
function updateThumbnails(key:string){
  const entry=images?.get(key);
  for(const c of thumbnailCanvases.get(key)??[]){
    if(entry&&c.isConnected)c.getContext("2d")!.drawImage(entry.image,0,0,c.width,c.height);
    else if(c.isConnected)c.parentElement?.remove();
  }
  thumbnailCanvases.delete(key);
  if(board?.selected&&key.startsWith("tile:")&&key.endsWith(":1024"))inspect();
}
function clearGallery(){
  images?.clearGallery();
  lazyThumbs.disconnect();lazyPages.disconnect();
  thumbnailCanvases.clear();
  gallery.replaceChildren();rendered=0;results=[];
}
function populate(ids:string[]){
  if(ids.length===results.length&&ids.every((id,i)=>id===results[i]))return;
  const scroll=gallery.scrollTop;
  clearGallery();results=ids;appendPage();
  gallery.scrollTop=scroll;
}
function appendPage(){
  lazyPages.disconnect();
  gallery.querySelector(".sentinel")?.remove();
  for(const id of results.slice(rendered,rendered+36)){
    const tile=document.createElement("button");
    const art=document.createElement("canvas");
    art.width=96;art.height=96;art.dataset.id=id;
    tile.title=id;tile.setAttribute("aria-label",`Preview texture ${id}`);
    tile.setAttribute("aria-pressed",String(board?.preview===id));
    tile.dataset.id=id;tile.append(art,id.slice(-10));tile.onclick=()=>stage(id);
    gallery.append(tile);lazyThumbs.observe(art);rendered++;
  }
  if(rendered<results.length){
    const sentinel=document.createElement("span");sentinel.className="sentinel";
    gallery.append(sentinel);lazyPages.observe(sentinel);
  }
}
function stage(id:string){
  const key=selectedKey();
  if(!board||!key||!board.canEdit(key))return;
  board.preview=id;
  for(const tile of gallery.querySelectorAll("button"))tile.setAttribute("aria-pressed",String(tile.dataset.id===id));
  inspect();board.draw();
}
button("browse").onclick=()=>{
  if(!atlas||!board?.selected)return;
  clearTimeout(rankTimer);serial++;send({kind:"cancelRank"});
  selectedMode="browse";get("match-status").textContent=`${locale(atlas.catalog.length)} candidates`;
  populate(atlas.catalog);
};
function runRank(){
  if(!board?.selected)return;
  const key=selectedKey()!;
  if(!board.canEdit(key))return;
  selectedMode="match";
  const [x,y]=board.selected,neighbors:MatchSide[]=[];
  const offsets=[[0,-1],[1,0],[0,1],[-1,0]];
  for(const [direction,[dx,dy]] of offsets.entries()){
    const neighbor=cellKey(x+dx,y+dy);
    const id=board.fills.get(neighbor)??board.tiles.get(neighbor)?.id;
    if(id)neighbors.push({id,direction:direction as MatchSide["direction"]});
  }
  const every=board.strokes.flat(),step=Math.max(1,Math.ceil(every.length/180));
  const points=every.filter((_,i)=>i%step===0);
  if(!neighbors.length&&!points.length){get("match-status").textContent="Draw a sketch or choose a gap next to a detailed tile.";return;}
  get("match-status").textContent="Comparing local tile imagery";
  send({kind:"rank",serial:++serial,neighbors,points});
}
function scheduleRank(){
  clearTimeout(rankTimer);
  rankTimer=window.setTimeout(runRank,200);
}
button("match").onclick=runRank;
button("sketch").onclick=()=>{sketch=!sketch;sampling=false;inspect();canvas.focus();};
button("sample").onclick=()=>{sampling=!sampling;inspect();canvas.focus();};
button("clear-sketch").onclick=()=>{if(board){board.strokes=[];board.draw();if(selectedMode==="match")scheduleRank();}};

function save(){
  if(!board||!atlas)return;
  try{localStorage.setItem(editsKey,JSON.stringify(serialize(atlas.build,board.fills)));}
  catch{notice("Browser storage is unavailable. Local edits could not be saved.");}
}
function remember(){
  if(!board)return;
  history.push(new Map(board.fills));
  if(history.length>40)history.shift();
}
function commit(){
  const key=selectedKey();
  if(!board||!key||!board.preview||!board.canEdit(key))return;
  remember();board.fills.set(key,board.preview);board.preview=null;
  notice("Fill saved in this browser.");save();inspect();board.draw();
}
button("place").onclick=commit;
button("remove").onclick=()=>{
  const key=selectedKey();
  if(!board||!key||!board.fills.has(key))return;
  remember();board.fills.delete(key);board.preview=null;save();inspect();board.draw();
};
button("undo").onclick=()=>{
  const previous=history.pop();
  if(!board||!previous)return;
  board.fills=previous;board.preview=null;save();inspect();board.draw();
};
button("import-edits").onclick=()=>input("edits").click();
input("edits").onchange=async()=>{
  const file=input("edits").files?.[0];
  input("edits").value="";
  const current=board,currentAtlas=atlas;
  if(!file||!current||!currentAtlas)return;
  try{
    if(!await ensureImagery()||board!==current)return;
    if(file.size>4*1024*1024)throw new Error("The edits file exceeds 4 MiB.");
    const next=parseEdits(JSON.parse(await file.text()),currentAtlas);
    if(board!==current)return;
    remember();current.fills=next;current.preview=null;
    notice(`Imported ${locale(next.size)} manual fills. Undo restores your previous edits.`);
    save();inspect();current.draw();
  }catch(error){notice((error as Error).message);}
};

function mountStreet(){
  if(street||!worldEntry)return;
  nextStreetTextureEpoch();
  const exe=files[rpf9ExecutableName],common=files["common.rpf"],textures=files["textures.rpf"];
  const source={
    origin:worldEntry,karstYaw,pickedSpawn,ocean:exe&&common&&textures?{exe,common,textures}:undefined,
    request:(point:readonly [number,number],known:string[])=>{
      if(reloadingStreet){streetBatches=[];known=[];}
      street?.installPending([]);
      send({kind:"streetRegion",serial:++worldSerial,point,known,karst:karstYaw!==undefined?true:undefined});
    },
    streamView:(view:StreetStreamView)=>send({kind:"streetStreamView",view}),
    requestTexture:(id:string,ground:boolean,compression?:number)=>send({kind:"streetTexture",epoch:streetTextureEpoch,id,ground,compression}),
    requestNavigation:(point:readonly [number,number],known:string[])=>
      send({kind:"streetNavigation",serial:++navigationSerial,point,known}),
    requestVegetation:(point:readonly [number,number],known:string[],lookOnly?:true)=>
      send({kind:"streetVegetation",serial:++vegetationSerial,point,known,lookOnly}),
  };
  try{
    const current=board;
    street=new StreetViewType(get("street-canvas"),source,streetStatus,
      {bearing:get("street-bearing"),minimap:get("street-minimap"),marker:get("street-minimap-marker"),fps:fpsChart,flight:button("street-flight"),roadName:updateStreetRoadName},
      current?(canvas,rect,useOverview)=>{
        let overview:NativeStreetImagery|undefined;
        if(useOverview&&nativeScene){
          overview=nativeImageryCache.get(nativeScene);
          if(!overview)nativeImageryCache.set(nativeScene,overview=new NativeStreetImagery(nativeScene));
        }
        if(!current.atlas.cells.length&&!overview)return false;
        current.streetImagery(canvas,rect,overview);return true;
      }:undefined);
    updateStreetLighting();
    if(worldEntry&&separateMaterials)startMaterialWorker();
    button("street-reset").disabled=false;
    button("street-flight").disabled=false;
    button("street-go-to").disabled=false;
    button("street-copy-view").disabled=false;
    button("street-navigation").hidden=!(worldEntry&&readyEvent?.navigation);
    if(pendingStreetPose){
      street.restorePose(pendingStreetPose.pose);
      if(pendingStreetPose.navigation&&!button("street-navigation").hidden)button("street-navigation").click();
      pendingStreetPose=null;
    }
  }catch(error){
    streetStatus.textContent=(error as Error).message;
  }
}

function startStreetWorker(){
  if(streetWorker||!fpsInputReady)return;
  const source=makeWorker();
  streetWorker=source;
  source.onmessage=({data}:MessageEvent<Event>)=>{if(streetWorker===source)handle(data);};
  source.onerror=event=>{
    if(streetWorker!==source)return;
    streetWorker=null;source.terminate();
    streetStatus.textContent=event.message||"The first-person worker could not start.";
    loading.clear("region","region-detail","vegetation","textures");
  };
  source.postMessage({kind:"streetImport",files} satisfies Request);
  // Let native directory registration overlap time spent on the pause map.
  source.postMessage({kind:"streetPrepareWorld"} satisfies Request);
}

function startMaterialWorker(){
  if(materialWorker)return materialWorker;
  const source=makeWorker();
  materialWorker=source;
  source.onmessage=({data}:MessageEvent<Event>)=>{if(materialWorker===source)handle(data);};
  source.onerror=()=>{
    if(materialWorker!==source)return;
    materialWorker=null;separateMaterials=false;source.terminate();
    for(const key of pendingTextures){
      const split=key.indexOf(":"),id=key.slice(split+1);
      if(!id.startsWith(dynamicTerrainPrefix))
        streetWorker?.postMessage({kind:"streetTexture",id,ground:key.startsWith("true:"),epoch:streetTextureEpoch} satisfies Request);
    }
  };
  source.postMessage({kind:"streetMaterialsImport",files,reloading:materialReload?true:undefined} satisfies Request);
  return source;
}

button("show-street").onclick=()=>{
  openStreetWorld([-5192.376,5980.863,113.949],undefined,{matchHeight:false},"Roadside tunnel");
};
function endExplorerDrag(){
  const id=explorerDrag?.id;
  explorerDrag=null;
  exploreButton.classList.remove("is-grabbed");
  walkMarker.classList.remove("is-grabbed");
  explorerGhost.hidden=true;
  if(id!==undefined&&exploreButton.hasPointerCapture(id))exploreButton.releasePointerCapture(id);
}
function moveExplorer(event:PointerEvent,immediate=false){
  const {clientX,clientY}=event;
  if(document.elementFromPoint(clientX,clientY)!==canvas){
    if(walkCursor){
      walkCursor=null;walkTarget=null;clearTimeout(walkTimer);walkSerial++;
      renderWalkPreview();
    }
    explorerGhost.style.left=`${clientX}px`;
    explorerGhost.style.top=`${clientY}px`;
    explorerGhost.hidden=false;
    return;
  }
  explorerGhost.hidden=true;
  const rect=canvas.getBoundingClientRect();
  walkCursor=[clientX-rect.left,clientY-rect.top];
  if(immediate)sampleWalkPreview();
  else queueWalkPreview();
}
exploreButton.onpointerdown=event=>{
  if(!board||!event.isPrimary||event.button!==0)return;
  skipExplorerClick=false;
  explorerDrag={id:event.pointerId,x:event.clientX,y:event.clientY,active:false};
  exploreButton.setPointerCapture(event.pointerId);
};
window.addEventListener("pointermove",event=>{
  if(explorerDrag?.id!==event.pointerId)return;
  if(!explorerDrag.active){
    if(Math.hypot(event.clientX-explorerDrag.x,event.clientY-explorerDrag.y)<6)return;
    explorerDrag.active=true;skipExplorerClick=true;
    setWalkPlacement(true,true);
    exploreButton.classList.add("is-grabbed");
    walkMarker.classList.add("is-grabbed");
  }
  moveExplorer(event);
},true);
window.addEventListener("pointerup",event=>{
  if(explorerDrag?.id!==event.pointerId)return;
  if(!explorerDrag.active){endExplorerDrag();return;}
  moveExplorer(event,true);
  endExplorerDrag();
  if(!walkTarget||walkTarget.blocked){setWalkPlacement(false);return;}
  prepareWalkEntry(walkTarget.point);
  if(reducedMotion.matches){confirmWalk();return;}
  walkMarker.classList.add("is-dropping");
  explorerDropTimer=window.setTimeout(()=>{
    explorerDropTimer=0;
    confirmWalk();
    if(placingWalk)renderWalkPreview();
  },180);
  renderWalkPreview();
},true);
function cancelExplorerDrag(event:PointerEvent){
  if(explorerDrag?.id!==event.pointerId)return;
  if(explorerDrag.active)setWalkPlacement(false);
  else endExplorerDrag();
}
window.addEventListener("pointercancel",cancelExplorerDrag,true);
exploreButton.onlostpointercapture=cancelExplorerDrag;
exploreButton.onclick=event=>{
  if(event.detail&&skipExplorerClick){skipExplorerClick=false;return;}
  if(board)setWalkPlacement(!placingWalk);
};
button("walk-karst").onclick=()=>{
  if(board)openStreetWorld([-4467.083333333333,2793.625,1.8156414487554382],-Math.PI/8);
};
function openStreetWorld(origin:[number,number,number],yaw?:number,anchor?:StreetSpawn,title=yaw===undefined?"Explore":"Selkie Hole caves"){
  if(!fpsInputReady)return;
  if(pausedLocation)releaseStreet();
  if(placingWalk)setWalkPlacement(false);
  startStreetWorker();
  worldEntry=origin;karstYaw=yaw;pickedSpawn=anchor;
  get("street-title").textContent=title;
  get("street-source").textContent=yaw===undefined?"Gameplay drawables · Original ground textures where available":
    "Gameplay drawables · Original collision where available";
  if(!streetDialog.open){
    loading.attach(get("street-loading-host"));
    streetDialog.showModal();
  }
  streetStatus.textContent="Reading gameplay terrain";
  resetStreetRoadName();
  mountStreet();
  if(street&&!skipExploreControls&&!streetControlsSeen&&!streetControls.open)showStreetControls();
}

function showStreetControls(){
  if(!streetDialog.open||streetControls.open)return;
  controlsCollapse?.remove();
  streetControls.showModal();
}
function closeStreetControls(){
  if(!streetControls.open)return;
  const firstVisit=!streetControlsSeen;
  const from=streetControls.getBoundingClientRect();
  streetControlsSeen=true;
  try{localStorage.setItem(streetControlsKey,"true");}catch{}
  streetControls.close();
  if(firstVisit)get("street-canvas").focus({preventScroll:true});
  if(reducedMotion.matches||!streetDialog.open||!from.width)return;

  const to=streetControlsButton.getBoundingClientRect();
  const effect=document.createElement("div");
  effect.className="street-controls-collapse";
  effect.setAttribute("aria-hidden","true");
  controlsCollapse=effect;
  streetDialog.append(effect);
  const pose=(rect:DOMRect,width=rect.width,height=rect.height)=>({
    width:`${width}px`,height:`${height}px`,
    transform:`translate(${rect.left+(rect.width-width)/2}px,${rect.top+(rect.height-height)/2}px)`,
  });
  const animation=effect.animate([
    {...pose(from),borderRadius:".85rem",opacity:1,easing:"ease-in"},
    {...pose(from,22,22),borderRadius:"50%",offset:.32,opacity:1,easing:"ease-in-out"},
    {...pose(to,22,22),borderRadius:"50%",offset:.88,opacity:1,easing:"ease-out"},
    {...pose(to,12,12),borderRadius:"50%",opacity:0},
  ],{duration:1000,fill:"both"});
  const cleanup=()=>{
    effect.remove();
    if(controlsCollapse===effect)controlsCollapse=undefined;
  };
  void animation.finished.then(cleanup,cleanup);
}
streetControlsButton.onclick=showStreetControls;
button("street-controls-close").onclick=closeStreetControls;
streetControls.addEventListener("cancel",event=>{
  event.preventDefault();
  event.stopPropagation();
  closeStreetControls();
});
function showStreetDestination(open:boolean){
  streetDestination.hidden=!open;
  button("street-go-to").setAttribute("aria-expanded",String(open));
  if(open){streetXYZ.focus();streetXYZ.select();}
}
button("street-go-to").onclick=()=>showStreetDestination(streetDestination.hidden);
button("street-copy-view").onclick=async()=>{
  if(!street)return;
  const control=button("street-copy-view"),value=formatStreetDestination(street.destination());
  try{
    await navigator.clipboard.writeText(value);
    control.textContent="Copied";
    window.setTimeout(()=>{control.textContent="Copy view";},1200);
  }catch{
    streetXYZ.value=value;
    streetXYZ.setCustomValidity("");showStreetDestination(true);
  }
};
streetXYZ.oninput=()=>streetXYZ.setCustomValidity("");
streetDestination.onkeydown=event=>{
  if(event.key!=="Escape")return;
  event.preventDefault();
  showStreetDestination(false);
  get("street-canvas").focus();
};
streetDestination.onsubmit=event=>{
  event.preventDefault();
  if(!street||!atlas)return;
  const destination=parseStreetDestination(streetXYZ.value);
  if(!destination){streetXYZ.setCustomValidity("Enter X, Y, Z, optionally followed by heading, pitch, and vertical FOV (20–105°).");streetXYZ.reportValidity();return;}
  const {position:[x,y,z],heading,pitch,fov}=destination;
  const [left,top,width,height]=atlas.world;
  const error=x<left*CELL||x>(left+width)*CELL||-y<top*CELL||-y>(top+height)*CELL?"Enter X and Y within the world map.":
    Math.abs(z)>1e6?"Enter a Z coordinate between -1,000,000 and 1,000,000.":"";
  if(error){streetXYZ.setCustomValidity(error);streetXYZ.reportValidity();return;}
  const pose=street.savePose();
  if(heading!==undefined)pose.yaw=(90-heading%360)*Math.PI/180;
  if(pitch!==undefined)pose.pitch=Math.max(-maximumStreetPitch,Math.min(maximumStreetPitch,pitch*Math.PI/180));
  if(fov!==undefined)pose.fov=fov;
  if(street.relocate([x,y,z],pose.yaw,pose.pitch,pose.fov)){
    showStreetDestination(false);
    get("street-canvas").focus();
    return;
  }
  const navigation=button("street-navigation");
  pendingStreetPose={pose:{...pose,position:[0,0,0],airborne:false,verticalSpeed:0,hasFloor:true,entry:null,destination:undefined},
    navigation:navigation.getAttribute("aria-pressed")==="true"};
  navigation.setAttribute("aria-pressed","false");
  send({kind:"cancelStreetRegion",serial:++worldSerial});
  send({kind:"streetVegetation",serial:++vegetationSerial,point:null,known:[]});
  navigationSerial++;reloadingStreet=false;streetBatches=[];
  street.dispose();street=null;
  showStreetDestination(false);
  openStreetWorld([x,y,z]);
};
const fpsChart=new StreetFpsChart(get("street-fps"),get("street-fps-idle"));
const showFps=input("street-show-fps"),sidebarFps=input("pref-fps");
try{showFps.checked=localStorage.getItem("terrain-atlas.show-fps")!=="false";}catch{}
sidebarFps.checked=showFps.checked;
fpsChart.setEnabled(showFps.checked);
function setFpsPreference(enabled:boolean){
  showFps.checked=sidebarFps.checked=enabled;
  fpsChart.setEnabled(enabled);
  try{localStorage.setItem("terrain-atlas.show-fps",String(enabled));}catch{}
}
showFps.onchange=()=>setFpsPreference(showFps.checked);
sidebarFps.onchange=()=>setFpsPreference(sidebarFps.checked);
function updateStreetLighting(){
  const enabled=button("street-lighting").getAttribute("aria-pressed")==="true";
  const slider=input("street-time"), minute=slider.valueAsNumber;
  const cloudSlider=input("street-cloud-cover"),cloudCover=cloudSlider.valueAsNumber;
  const clock=`${String(Math.floor(minute/60)).padStart(2,"0")}:${String(minute%60).padStart(2,"0")}`;
  get("street-clock").hidden=!enabled;
  get("street-clouds").hidden=!enabled;
  get("street-time-label").textContent=clock;
  get("street-cloud-label").textContent=`${cloudCover}%`;
  slider.setAttribute("aria-valuetext",clock);
  cloudSlider.setAttribute("aria-valuetext",`${cloudCover} percent`);
  street?.setLighting(enabled,minute,cloudCover/100,streetEnvironment);
  if(streetCloudNoise)street?.setCloudNoise(streetCloudNoise);
  if(enabled&&streetCloudAssets)street?.setNativeClouds(streetCloudAssets);
  if(streetWaterOptics)street?.setWaterOptics(streetWaterOptics);
  if(streetWaterTileRegion)street?.setWaterTileRegion(streetWaterTileRegion);
  if(streetWaterMaterials)street?.setWaterMaterials(streetWaterMaterials);
  if(street&&enabled&&worldEntry&&!requestedStreetEnvironment){
    requestedStreetEnvironment=true;
    send({kind:"streetEnvironment",cloudNoise:street.supportsCloudNoise?true:undefined,hdrSky:street.supportsHdrSky?true:undefined,
      nativeClouds:street.supportsNativeClouds?true:undefined});
  }
}
button("street-lighting").onclick=()=>{
  const control=button("street-lighting");
  control.setAttribute("aria-pressed",String(control.getAttribute("aria-pressed")!=="true"));
  updateStreetLighting();
};
input("street-time").oninput=updateStreetLighting;
input("street-cloud-cover").oninput=updateStreetLighting;
button("street-reset").onclick=()=>street?.reset();
button("street-flight").onclick=()=>{
  street?.toggleFlight();
  get("street-canvas").focus();
};
button("street-navigation").onclick=()=>{
  const control=button("street-navigation");
  const enabled=control.getAttribute("aria-pressed")!=="true";
  control.setAttribute("aria-pressed",String(enabled));
  if(!enabled)send({kind:"streetNavigation",serial:++navigationSerial,point:null,known:[]});
  street?.setNavigation(enabled);
};
function clearPausedLocation(){
  pausedLocation=null;
  mapPlayer.hidden=true;
  button("resume-street").hidden=true;
  button("map-recenter").hidden=true;
  button("walk-here").classList.add("primary");
  updateMapRoadName();
}
function centerOnExplorer(minScale=0){
  if(!pausedLocation)return;
  const [x,y]=pausedLocation.position;
  centerMap(x/CELL-.5,-y/CELL-.5,minScale);
}
function pauseStreet(center=true){
  if(!street||!board||!streetDialog.open)return;
  pausedLocation=street.destination();
  resetStreetRoadName();
  street.setPaused(true);
  if(streetControls.open)streetControls.close();
  streetDialog.close();
  loading.attach(workspace);
  loading.clear("region","region-detail","vegetation","navigation","textures");
  mapBehindStreet=false;
  button("resume-street").hidden=false;
  button("map-recenter").hidden=false;
  button("walk-here").classList.remove("primary");
  updateMapRoadName();
  loadVisibleLayers();
  if(center)centerOnExplorer(56);
  drawDistricts();
  canvas.focus({preventScroll:true});
}
function resumeStreet(){
  if(!street||!pausedLocation)return;
  if(placingWalk)setWalkPlacement(false);
  clearPausedLocation();
  streetDialog.showModal();
  loading.attach(get("street-loading-host"));
  updateTextureLoading();
  street.setPaused(false);
}
button("street-close").onclick=()=>pauseStreet();
button("resume-street").onclick=resumeStreet;
button("map-recenter").onclick=()=>centerOnExplorer();
streetDialog.addEventListener("cancel",event=>{
  if(!street||!board)return;
  event.preventDefault();
  if(!streetDestination.hidden){showStreetDestination(false);get("street-canvas").focus();return;}
  pauseStreet();
});
workspace.addEventListener("keydown",event=>{
  if(event.key==="Escape"&&pausedLocation&&!event.defaultPrevented){
    event.preventDefault();
    resumeStreet();
  }
});
streetDialog.addEventListener("close",()=>{
  if(!pausedLocation&&!streetDialog.open&&street)releaseStreet();
});
function releaseStreet(){
  controlsCollapse?.remove();
  controlsCollapse=undefined;
  clearPausedLocation();
  loading.attach(workspace);
  loading.clear("region","vegetation","navigation");
  worldSerial++;reloadingStreet=false;streetBatches=[];pendingStreetPose=null;
  if(worldEntry)send({kind:"cancelStreetRegion",serial:worldSerial});
  if(worldEntry)send({kind:"streetVegetation",serial:++vegetationSerial,point:null,known:[]});
  if(button("street-navigation").getAttribute("aria-pressed")==="true")
    send({kind:"streetNavigation",serial:++navigationSerial,point:null,known:[]});
  button("street-navigation").setAttribute("aria-pressed","false");
  button("street-navigation").hidden=true;
  nextStreetTextureEpoch();
  street?.dispose();street=null;
  button("street-reset").disabled=true;
  button("street-flight").disabled=true;
  button("street-flight").setAttribute("aria-pressed","false");
  button("street-go-to").disabled=true;
  button("street-copy-view").disabled=true;
  showStreetDestination(false);
  const mapMode=deferredMapMode;
  deferredMapMode=null;mapBehindStreet=false;
  if(board){
    syncProjection(board.projected);
    if(mapMode)void ensureImagery().then(ok=>{if(ok)button(mapMode).click();});
  }
}

type ViewerSnapshot={
  build:string;
  map:{x:number;y:number;scale:number;selected:[number,number]|null;preview:string|null;strokes:SketchPoint[][];
    markers:boolean;mode:"browse"|"match"|null;sketch:boolean;sidebarHidden:boolean;sidebarSection:SidebarSection;
    cellSearch:string;textureSearch:string};
  terrain:{center:TerrainView["center"];scale:number;angle:number}|null;
  raised:boolean;tilt:string;relief:string;water:boolean;
  street:{origin:[number,number,number]|null;karstYaw:number|undefined;pickedSpawn?:StreetSpawn;pose:StreetPose;navigation:boolean;paused?:boolean}|null;
};
let pendingSnapshot:ViewerSnapshot|null=null;

function saveViewer(){
  if(!board||!atlas)return;
  const snapshot:ViewerSnapshot={
    build:atlas.build,
    map:{x:board.x,y:board.y,scale:board.scale,selected:board.selected,preview:board.preview,strokes:board.strokes,
      markers:board.markers,mode:selectedMode??deferredMapMode,sketch,sidebarHidden:sidebar.hidden,sidebarSection,
      cellSearch:input("cell-search").value,textureSearch:input("texture-search").value},
    terrain:board.projected&&terrain?{center:terrain.center,angle:terrain.angle,scale:terrain.scale}:null,
    raised,tilt:terrainTilt.value,relief:terrainRelief.value,water:terrainWater.checked,
    street:street?{origin:worldEntry,karstYaw,pickedSpawn,pose:street.savePose(),paused:Boolean(pausedLocation),
      navigation:button("street-navigation").getAttribute("aria-pressed")==="true"}:null,
  };
  try{sessionStorage.setItem(devSnapshotKey,JSON.stringify(snapshot));}catch{}
}

function restoreViewer(){
  const snapshot=pendingSnapshot;
  if(!snapshot||!board)return;
  pendingSnapshot=null;
  if(snapshot.build!==board.atlas.build){syncProjection();return;}
  const {map}=snapshot;
  mapBehindStreet=!!snapshot.street&&!snapshot.street.paused;
  const selected=map.selected;
  if(selected&&board.contains(...selected))select(...selected);
  input("cell-search").value=map.cellSearch??"";
  input("texture-search").value=map.textureSearch??"";
  board.x=map.x;board.y=map.y;board.scale=map.scale;
  board.preview=map.preview;board.strokes=map.strokes;
  board.markers=map.markers;button("show-markers").setAttribute("aria-pressed",String(map.markers));
  setSidebarOpen(!map.sidebarHidden);
  sketch=map.sketch;canvas.classList.toggle("drawing",sketch);
  raised=snapshot.raised;terrainTilt.value=snapshot.tilt;
  terrainRelief.value=snapshot.relief;terrainWater.checked=snapshot.water;
  syncProjection(Boolean(snapshot.terrain));
  if(snapshot.terrain&&terrain){
    terrain.center=snapshot.terrain.center;terrain.scale=snapshot.terrain.scale;terrain.angle=snapshot.terrain.angle;
    terrain.draw();
  }
  showSidebarSection(map.sidebarSection??sidebarSection);
  if(map.mode==="browse"||map.mode==="match"){
    const mode=map.mode;
    if(mapBehindStreet)deferredMapMode=mode;
    else void ensureImagery().then(ok=>{if(ok)button(mode).click();});
  }
  inspect();updateScale();board.draw();
  if(snapshot.street){
    const saved=snapshot.street;
    pendingStreetPose={pose:saved.pose,navigation:saved.navigation};
    if(saved.origin)openStreetWorld(saved.origin,saved.karstYaw,saved.pickedSpawn);
    else button("show-street").click();
    if(saved.paused)pauseStreet(false);
  }
}

function reloadStreetWorker(){
  if(!readyEvent||!fpsInputReady)return;
  pendingStreetWorker?.terminate();
  const next=makeWorker();
  pendingStreetWorker=next;
  const fail=(message:string)=>{
    if(pendingStreetWorker!==next)return;
    pendingStreetWorker=null;next.terminate();notice(message);
  };
  next.onerror=event=>fail(event.message||"The updated first-person worker could not start.");
  next.onmessage=({data}:MessageEvent<Event>)=>{
    if(pendingStreetWorker===next){
      if(data.kind==="streetFailure"){fail(data.message);return;}
      if(data.kind!=="streetImported")return;
      pendingStreetWorker=null;streetWorker?.terminate();streetWorker=next;
      materialWorker?.terminate();materialWorker=null;materialReload=true;
      if(streetDialog.open&&street){
        reloadingStreet=true;street.refreshAssets();
      }
      return;
    }
    if(streetWorker===next)handle(data);
  };
  next.postMessage({kind:"streetImport",files,reloading:true} satisfies Request);
}

if(import.meta.hot){
  import.meta.hot.accept("./street-view",updated=>{
    if(!updated)return;
    StreetViewType=updated.StreetView;
    if(!street)return;
    const previous=Object.getPrototypeOf(street);
    Object.setPrototypeOf(street,StreetViewType.prototype);
    try{street.refreshRenderer();}
    catch(error){
      Object.setPrototypeOf(street,previous);
      console.error(error);
    }
  });
  import.meta.hot.on("terrain:street-worker",reloadStreetWorker);
  import.meta.hot.on("vite:beforeFullReload",saveViewer);
  window.addEventListener("pagehide",saveViewer);
  try{pendingSnapshot=JSON.parse(sessionStorage.getItem(devSnapshotKey)??"null");}catch{}
  if(pendingSnapshot)void reopenDevFiles()?.then(saved=>{
    if(saved&&!Object.keys(files).length)return importFiles(Object.values(saved));
  }).catch(()=>{});
}

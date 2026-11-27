import {StreetOcclusionReview} from "./street-occlusion-review";
import {beginOpaque,chooseOpaque,endOpaque,registerOpaqueMesh} from "./street-opaque-program";
import {rendererReview} from "./street-renderer-review";
import type { InstanceTile, PropMaterialLayers, StaticMaterialLayers, StreetChunk, StreetRoomMaterial } from "./street-mesh";
import { streetInteriorCubePrefix, streetRoomCubeUnit, type StreetCubeTexture } from "./street-cube-texture";
import { skylineRadius } from "./street-grid";
import type { Bounds } from "./native-spatial";
import { authoredControlPrefix, authoredDiffusePrefix, detailAtlasSlicePrefix, dynamicTerrainPrefix, materialMaskChainPrefix, roomGlassTexturePrefix, streetBlueNoiseId, terrainDetailUnits, terrainTexturePrefix, type StreetBlockTexture, type StreetTextureImage, type TerrainLayers } from "./street-terrain-material";
import { roadDetailFarDepth, roadControlPrefix, roadHeightPrefix, roadSurfacePrefix, roadTintPrefix, roadSurfaceTintPrefix, roadWeightPrefix, roadHeightBlueAlpha, type RoadHeightMip, type RoadLayers } from "./street-road-material";
import { sameVegetationAffinesByOrdinal, uncoveredVegetationRanges, vegetationDistance, vegetationUpdateSize } from "./street-vegetation";
import { aerialSkylineRadius, flightTerrainAltitude, flightTerrainRadius, oceanRadius,
  overviewTerrainRadius, overviewTerrainTileSize, streetNearPlane } from "./street-grid";
import { maximumWalkSlope } from "./walk-surface";
import {streetDistance,streetFrustum,streetHorizon,streetRegionSize,streetScreenBounds,streetViewChanged,type StreetPendingBox,type StreetStreamView} from "./street-priority";
import { interiorApertureIntersects, isInsideAuthoredInterior, packInteriorClip, trackInteriorCamera, visibleInteriorRooms, type InteriorCamera } from "./street-interior";
import { poseRoller } from "./street-roller";
import {closeMaterialPrefix,compressedMaterialFormats,compressedRoadColorFormats,streetBudgets} from "./street-capacity";
import {authoredLodParent,streetLodInRange,clonedPrefabName,districtAggregate,lowSkylineHorizon,roadBridgeDrawable,sameStreetLodPlacement,
  sameStreetPropBatch,streetLodVariant,streetPropLodVariant,terrainSectorLod} from "./street-lod";
import {defaultStreetFov,streetProjection} from "./street-destination";
import {StreetWaterReflection} from "./street-water-reflection";
import type {StreetOceanWaves} from "./street-ocean-waves";
import {createStreetWaveTexture} from "./street-water-spectrum";
import type {StreetWaterOptics} from "./street-water-optics";
import {uploadStreetWaterMips,type StreetWaterMaterials} from "./street-water-materials";
import {canopyAtlasPrefix,nativeCanopyAtlasPrefix,nativeCanopyMaterial} from "./street-canopy-atlas";
import {StreetSceneDepth} from "./street-scene-depth";
import {StreetContactShadows} from "./street-contact-shadows";
import {StreetFrameSnapshot} from "./street-frame-snapshot";
import type {StreetLighting} from "./street-lighting";
import {hiddenExteriorFoliage,indoorFoliageRoom,visibleIndoorFoliage,type IndoorFoliageRoom} from "./street-indoor-foliage";

type VisibilityCell={key:string;bounds:Bounds;count:number;horizon:number;visible:boolean;contained:boolean};
type TextureCandidate={id:string;overlay?:boolean};
type Chunk = { mesh:StreetChunk; bounds:Bounds; tiles?:InstanceTile[]; textureBounds?:Map<string,Bounds>;visibilityCell?:VisibilityCell;
  terrainLayers?:{terrain:TerrainLayers;bounds?:Bounds}[]; groundRoads?:{road:RoadLayers;bounds:Bounds}[];
  groundDemand?:TextureCandidate[];materialDemand?:TextureCandidate[];
  spanBounds?:(Bounds|undefined)[]; lod?:ReturnType<typeof streetLodVariant>;lodParent?:string;
  drawOrder:number; drawRank:number; drawDistance:number };
type InstanceRange = Pick<InstanceTile,"first"|"count">;
type VisibilityPlan = {camera:StreetStreamView;flightTerrain:boolean;visible:Chunk[];fallbackTerrain:Set<Chunk>;
  interiorClips:Map<Chunk,Float32Array>;indoorFoliage?:IndoorFoliageRoom;
  aggregateFallback:Set<Chunk>;instanceRanges:Map<Chunk,InstanceRange[]>;replacements:Map<Chunk,Chunk[]>;
  bridgeFallbacks:Map<Chunk,Chunk>;bridgeParents:Set<Chunk>;skylineChildren:Map<Chunk,Chunk[]>;
  skylineCoverage:Map<Chunk,{read:number;write:number}>;pairedCanopyChildren:Set<Chunk>};
type TexturePlan = {wanted:Set<string>;queue:string[];foregroundRoad:string[]};
type Face = { a:number; b:number; c:number; bounds:Bounds; groundBlend?:boolean };
type CollisionIndex = { buckets:Map<string,Face[]>; wide:Face[]; side:number };
type SharedGeometry={key:string;vertices:WebGLBuffer;indices:WebGLBuffer;uv?:WebGLBuffer;normals?:WebGLBuffer;
  references:number;bytes:number;visibleFrame:number};
type Resident = { vao:WebGLVertexArrayObject; vertices:WebGLBuffer; indices:WebGLBuffer; uv?:WebGLBuffer;
  normals?:WebGLBuffer; terrainColors?:WebGLBuffer; terrainTintUV?:WebGLBuffer; terrainTangents?:WebGLBuffer; terrainSecondaryTangents?:WebGLBuffer; roadUV?:WebGLBuffer; roadWeights?:WebGLBuffer; decalOpacity?:WebGLBuffer; decalBlend?:WebGLBuffer; poses?:WebGLBuffer; instances:number; instanceMode:number; instanceStart:number; count:number; frame:number; bytes:number; shadowMaterials?:string[]; shadowOnly?:true;
  indexType:number;indexBytes:2|4;shared?:SharedGeometry;instanceExtras?:true;
  propInstances?:WebGLBuffer;propPalettes?:Map<string,WebGLTexture>;propDirtControls?:true };
export {streetHorizon} from "./street-priority";
const chunkSize=128;
const overviewCellsPerSide=overviewTerrainTileSize/chunkSize;
const meshHorizon=(mesh:StreetChunk)=>mesh.vegetation??mesh.drawDistance??(mesh.kind==="skyline"?skylineRadius:
  mesh.overview?overviewTerrainRadius:mesh.id.startsWith("ocean:")?oceanRadius:mesh.kind==="terrain"?flightTerrainRadius:streetHorizon);
const collisionSide=8;
const groundTextureLimit=streetBudgets.groundTextures;
const closeMaterialLimit=streetBudgets.materialSide===512?8:0;
const dynamicTextureLimit=24;
const terrainWeightPrefix=terrainTexturePrefix+"weights:";
const terrainTintPrefix=terrainTexturePrefix+"tint:";
const propLayerRoles=["diffuse","diffuse","material-mask","material-mask","color"] as const;
function propLayerTextures(layers:PropMaterialLayers){
  const diffuse=layers.parallax?authoredDiffusePrefix:terrainTexturePrefix+"diffuse:";
  const control=layers.parallax?authoredControlPrefix:terrainTexturePrefix+"color:";
  const mask=terrainTexturePrefix+"material-mask:";
  const ids=layers.textures.map((key,index)=>(index<2?diffuse:index===4?control:mask)+key);
  if(layers.dirt)ids.push(diffuse+layers.dirt);
  if(layers.parallax)ids.push(detailAtlasSlicePrefix+"7",detailAtlasSlicePrefix+"4",streetBlueNoiseId,
    ...layers.parallax.materials.map(key=>terrainTexturePrefix+"material-a:"+key));
  return ids;
}
function staticLayerTextures(layers:StaticMaterialLayers){
  return layers.textures.map((key,index)=>(index<2?terrainTexturePrefix+"diffuse:":
    index===4?terrainTexturePrefix+"layer-control:":materialMaskChainPrefix)+key);
}
const roomGlassRoles=["diffuse","room-glass","material-mask","material-mask","material-mask"] as const;
function roomGlassTextures(glass:NonNullable<StreetRoomMaterial["glass"]>){
  return glass.textures.map((key,index)=>terrainTexturePrefix+roomGlassRoles[index]+":"+key);
}
const terrainTintLimit=2;
const terrainNormalPrefix=terrainTexturePrefix+"normal:";
const terrainNormalLimit=8;
const largestTerrainWeight=2048*2048;
const terrainWeightBudget=2*largestTerrainWeight+1024*1024;
const terrainTextureBudget=64*1024*1024;
const canopyTextureLimit=40;
const compareKeys=(a:string,b:string)=>a<b?-1:a>b?1:0;
const comparePriority=(a:number,b:number)=>Math.fround(a)-Math.fround(b);
function samePackedFoliage(before:StreetChunk,after:StreetChunk,worldOrigin:readonly [number,number,number]){
  if(!before.packedSlodCenter||!after.packedSlodCenter||!before.geometryKey||
    before.geometryKey!==after.geometryKey||before.vegetation!==after.vegetation||
    before.origin.some((value,index)=>value!==after.origin[index])||
    before.packedSlodCenter.some((value,index)=>value!==after.packedSlodCenter![index]))return false;
  const a=before.instances,b=after.instances;
  if(!a?.tiles||!b?.tiles||a.poses.length!==b.poses.length||a.tiles.length!==b.tiles.length)return false;
  for(let i=0;i<a.tiles.length;i++){
    const old=a.tiles[i],fresh=b.tiles[i];
    if(old.first!==fresh.first||old.count!==fresh.count||
      old.bounds.some((value,axis)=>value!==fresh.bounds[axis]))return false;
  }
  // The installed buffer has already been rebased by locate().
  const [dx,dy,dz]=after.origin.map((value,axis)=>value-worldOrigin[axis]);
  for(let at=0;at<a.poses.length;at+=16){
    if(a.poses[at]!==Math.fround(b.poses[at]+dx)||
      a.poses[at+1]!==Math.fround(b.poses[at+1]+dy)||
      a.poses[at+2]!==Math.fround(b.poses[at+2]+dz))return false;
    for(let component=3;component<16;component++)if(a.poses[at+component]!==b.poses[at+component])return false;
  }
  return true;
}
function textureOrder(scores:ReadonlyMap<string,number>,limit=Infinity,descending=false){
  return [...scores].sort(([a,x],[b,y])=>
    (descending?comparePriority(y,x):comparePriority(x,y))||compareKeys(a,b)).slice(0,limit).map(([id])=>id);
}
const terrainCoverage=0x1,groundReceiver=0x2,objectReceiver=0x4,aggregateReceiver=0x8;
const surfaceReceiver=groundReceiver|objectReceiver;
const terrainReceiver=terrainCoverage|groundReceiver;
const surfaceStencil=terrainCoverage|surfaceReceiver|aggregateReceiver;
const waterStencil=0x10;
const skylineCoverageBits=[0x20,0x40,0x80];
export const streetWaterBackdropUnit=18;
const matrixAttributes=[[2,3,0],[3,3,12],[4,3,24],[5,3,36]];
const matrixExtraAttributes=[...matrixAttributes,[15,4,48]];
const rigidAttributes=[[2,3,0],[3,4,12],[4,2,28]];
const canopyShadowCaster=(mesh:StreetChunk)=>mesh.kind==="foliage"&&!mesh.packedSlodCenter&&
  Boolean(mesh.appearance?.spans[0]?.texture?.startsWith(nativeCanopyAtlasPrefix));
const shadowCaster=(mesh:StreetChunk)=>!mesh.interior&&(canopyShadowCaster(mesh)||
  !mesh.visualOnly&&!mesh.overview&&!mesh.id.endsWith(":lod")&&
    (mesh.kind==="terrain"||mesh.kind==="structure"||mesh.kind==="road"||mesh.kind==="foliage"||mesh.kind==="prop"));
const distantShadowCaster=(mesh:StreetChunk)=>!mesh.interior&&(canopyShadowCaster(mesh)||
  (mesh.kind==="structure"||mesh.kind==="skyline")&&mesh.bounds[5]-mesh.bounds[2]>=7);

export class StreetWorld {
  shadowRevision=0;
  private lightingMaterials=false;
  private shadowMaterials?:Map<string,number>;
  private flightTerrain=false;
  private distantCanopy=false;
  private readonly chunks=new Map<string,Chunk>();
  private readonly navigation=new Map<string,Chunk>();
  private readonly cache=new Map<Chunk,Resident>();
  private readonly sharedGeometry=new Map<string,SharedGeometry>();
  private readonly canopyTransformMatches=new WeakMap<Chunk,WeakMap<Chunk,boolean>>();
  private readonly collision=new Map<Chunk,CollisionIndex>();
  private readonly textures=new Map<string,WebGLTexture|null>();
  private readonly closeTextures=new Map<string,WebGLTexture|null>();
  private readonly canopyTextures=new Map<string,WebGLTexture|null>();
  private readonly canopyPending=new Set<string>();
  private canopyWanted=new Set<string>();
  private closeWanted=new Set<string>();
  private closeGroundWanted=new Set<string>();
  private closeForegroundWanted=new Set<string>();
  private readonly closeRequested=new Set<string>();
  private readonly detailNormals=new Map<WebGLTexture,WebGLTexture>();
  private readonly alphaTextures=new WeakSet<WebGLTexture>();
  private readonly compressedRoadHeights=new WeakSet<WebGLTexture>();
  private readonly roadColorLuminance=new WeakMap<WebGLTexture,number>();
  private readonly pending=new Set<string>();
  private readonly foregroundRoadPending=new Set<string>();
  private readonly groundTextures=new Map<string,WebGLTexture|null>();
  private readonly groundPending=new Set<string>();
  private readonly terrainTextures=new Map<string,WebGLTexture>();
  private readonly materialMaskSlices=new Map<string,number|null>();
  private readonly terrainTextureSizes=new Map<string,number>();
  private terrainTextureBytes=0;
  private readonly terrainPending=new Set<string>();
  private readonly terrainMissing=new Set<string>();
  private readonly terrainWeightSizes=new Map<string,number>();
  private terrainWanted=new Set<string>();
  private layeredMaterialWanted=new Set<string>();
  private groundPlan?:TexturePlan;
  private materialPlan?:TexturePlan;
  private textureView?:{x:number;y:number;z:number;yaw:number;pitch:number;aspect:number;fov:number;time:number;readyParents:Set<Chunk>};
  private textureSelectionDirty=false;
  private readonly anisotropy:EXT_texture_filter_anisotropic|null;
  private readonly groundAnisotropy:number;
  private wrappingTerrainMask?:WebGLSampler;
  private terrainDetailSupported?:boolean;
  private readonly gpuMaterialFormats:Record<StreetBlockTexture["format"],number|undefined>;
  private readonly roomGlassCompression?:number;
  private readonly materialCompression:number;
  private readonly roadColorCompression:number;
  private readonly gpuRoadColorFormats:Record<StreetBlockTexture["format"],number|undefined>;
  private waterBackdropSupported?:boolean;
  private waterBackdrop?:{texture:WebGLTexture;width:number;height:number};
  private waveTexture?:WebGLTexture;
  private waterOptics?:{source:StreetWaterOptics;scattering?:WebGLTexture;extinction?:WebGLTexture};
  private waterTileRegion?:StreetWorld["waterOptics"];
  private waterMaterials?:{source:StreetWaterMaterials;bump?:WebGLTexture;foam?:WebGLTexture};
  private waterQuery?:{key:string;query:WebGLQuery};
  private waterVisibility?:{key:string;visible:boolean};
  private readonly waterReflection:StreetWaterReflection;
  private readonly sceneDepth:StreetSceneDepth;
  private readonly contactShadows:StreetContactShadows;
  private readonly roomTexturesSupported:boolean;
  private frameSnapshot?:StreetFrameSnapshot;
  private waterFrame?:{depth:WebGLTexture;draw:()=>boolean};
  private reflectionMaterials=0;
  private canopySampleCoverage?:boolean;
  private meshBytes=0;
  private frame=0;
  private region="";
  private navigationRegion="";
  private vegetationRegion="";
  private canopyView?:StreetStreamView;
  private showNavigation=false;
  private streamCamera?:StreetStreamView;
  private visibilityPlan?:VisibilityPlan;
  private interiorCamera=new Map<string,InteriorCamera>();
  private interiorComplete=false;
  private readonly rollers=new Map<string,Chunk>();
  private readonly openRollers=new Set<string>();
  private readonly rollerMotion=new Map<string,{closed:Float32Array;fraction:number;from:number;to:number;started:number;duration:number}>();
  private readonly openRollerBounds=new WeakMap<Float32Array,Bounds|null>();
  private attachedLodFamilies?:{skyline:Map<Chunk,Chunk[]>;bridges:Map<Chunk,Chunk[]>};
  private occlusionReview?:StreetOcclusionReview;
  private occlusionRevision=0;
  private occlusionLighting?:StreetLighting;
  private visibilityCells?:Map<string,VisibilityCell>;
  private pendingBoxes=new Map<string,Bounds>();
  private boxBuffers?:{vao:WebGLVertexArrayObject;vertices:WebGLBuffer};
  loading=true;
  error="";

  constructor(private readonly gl:WebGL2RenderingContext,readonly origin:readonly [number,number,number],
    private request:(point:readonly [number,number],known:string[])=>void,
    private requestTexture:(id:string,ground:boolean,compression?:number)=>void,
    private requestNavigation?: (point:readonly [number,number],known:string[])=>void,
    private readonly karstWalk=false,
    private requestVegetation?: (point:readonly [number,number],known:string[],lookOnly?:true)=>void,
    private reportView?: (view:StreetStreamView)=>void,
    private readonly oceanWaves?:StreetOceanWaves){
    this.waterReflection=new StreetWaterReflection(gl);
    this.sceneDepth=new StreetSceneDepth(gl);
    this.contactShadows=new StreetContactShadows(gl);
    const srgbS3tc=gl.getExtension("WEBGL_compressed_texture_s3tc_srgb");
    this.roomTexturesSupported=Boolean(srgbS3tc)&&
      gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)>streetRoomCubeUnit;
    this.anisotropy=gl.getExtension("EXT_texture_filter_anisotropic");
    this.groundAnisotropy=this.anisotropy
      ?Math.min(8,gl.getParameter(this.anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)):1;
    const bptc=gl.getExtension("EXT_texture_compression_bptc");
    this.roomGlassCompression=bptc?.COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT;
    this.gpuMaterialFormats={
      bc1:gl.getExtension("WEBGL_compressed_texture_s3tc")?.COMPRESSED_RGBA_S3TC_DXT1_EXT,
      bc7:bptc?.COMPRESSED_RGBA_BPTC_UNORM_EXT,
    };
    this.materialCompression=(this.gpuMaterialFormats.bc1?compressedMaterialFormats.bc1:0)|
      (this.gpuMaterialFormats.bc7?compressedMaterialFormats.bc7:0);
    this.gpuRoadColorFormats={bc1:srgbS3tc?.COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT,bc7:this.roomGlassCompression};
    this.roadColorCompression=(this.gpuRoadColorFormats.bc1?compressedRoadColorFormats.bc1:0)|
      (this.gpuRoadColorFormats.bc7?compressedRoadColorFormats.bc7:0);
  }

  update(x:number,y:number,refresh=false,camera?:StreetStreamView,moving=false){
    const point=[this.origin[0]+x,this.origin[1]+y] as const;
    const navKey=point.map(value=>Math.floor(value/chunkSize)).join(",");
    if(this.showNavigation&&(refresh||navKey!==this.navigationRegion)){
      this.navigationRegion=navKey;
      this.requestNavigation?.(point,refresh?[]:[...this.navigation.keys()]);
    }
    const priorCanopy=this.distantCanopy;
    if(camera){
      const altitude=camera.eye[2]+this.origin[2];
      this.flightTerrain=altitude>=flightTerrainAltitude-(this.flightTerrain?8:0);
      this.distantCanopy=true;
    }
    const key=point.map(value=>Math.floor(value/streetRegionSize)).join(",")+(this.flightTerrain?":flight":"");
    const vegetationCell=point.map(value=>Math.floor(value/vegetationUpdateSize));
    const vegetationKey=vegetationCell.join(",")+(this.distantCanopy?":extended":"");
    const vegetationCellChanged=Boolean(this.requestVegetation&&vegetationKey!==this.vegetationRegion);
    const previous=this.streamCamera;
    const canopyView=this.canopyView;
    const canopyViewChanged=Boolean(camera&&canopyView&&this.distantCanopy&&
      (Math.abs((camera.farPlane??0)-(canopyView.farPlane??0))>=8||
        streetViewChanged(camera,canopyView)||Math.abs(camera.eye[2]-canopyView.eye[2])>=8));
    if(camera&&(!previous||refresh||key!==this.region||priorCanopy!==this.distantCanopy||canopyViewChanged||vegetationCellChanged||
      camera.aspect!==previous.aspect||camera.fov!==previous.fov||
      Math.abs(camera.yaw-previous.yaw)+Math.abs(camera.pitch-previous.pitch)>.18||
      streetDistance([...previous.eye,...previous.eye],camera.eye)>64)){
      this.streamCamera=camera;
      const eye=camera.eye.map((value,i)=>value+this.origin[i]) as [number,number,number];
      this.reportView?.({...camera,eye,flightTerrain:this.flightTerrain,distantCanopy:this.distantCanopy});
    }else if(refresh&&previous){
      const eye=previous.eye.map((value,i)=>value+this.origin[i]) as [number,number,number];
      this.reportView?.({...previous,eye,flightTerrain:this.flightTerrain,distantCanopy:this.distantCanopy});
    }
    if(refresh||key!==this.region){
      this.region=key;this.loading=true;this.error="";
      this.request(point,refresh?[]:[...this.chunks].filter(([,chunk])=>!chunk.mesh.interior&&chunk.mesh.vegetation===undefined).map(([id])=>id));
    }
    const lookOnly=!refresh&&vegetationKey===this.vegetationRegion&&canopyViewChanged;
    // A turn changes the distant canopy selection, while the nearby
    // placements still belong to the same cell. Keep the current selection
    // through the turn and start one replacement once the camera settles.
    if(this.requestVegetation&&(refresh||vegetationCellChanged||canopyViewChanged&&(!lookOnly||!moving))){
      this.vegetationRegion=vegetationKey;
      this.canopyView=this.distantCanopy?camera??previous:undefined;
      const [left,bottom]=vegetationCell.map(value=>(value+.5)*vegetationUpdateSize);
      this.requestVegetation([left,bottom],
        refresh?[]:[...this.chunks].filter(([,chunk])=>chunk.mesh.vegetation!==undefined).map(([id])=>id),
        lookOnly?true:undefined);
    }
  }

  installPending(boxes:StreetPendingBox[]){
    if(!this.loading)return false;
    const next=new Map<string,Bounds>();
    const [x,y,z]=this.origin;
    for(const {id,bounds:[x0,y0,z0,x1,y1,z1]} of boxes)
      if(!this.chunks.has(id))next.set(id,[x0-x,y0-y,z0-z,x1-x,y1-y,z1-z]);
    const inView=this.streamCamera&&streetFrustum(this.streamCamera);
    const changed=[...this.pendingBoxes].some(([id,bounds])=>!next.has(id)&&(!inView||inView(bounds)))||
      [...next].some(([id,bounds])=>(!inView||inView(bounds))&&
        bounds.some((value,i)=>value!==this.pendingBoxes.get(id)?.[i]));
    this.pendingBoxes=next;
    return changed;
  }

  hasOverviewGround(x:number,y:number){
    const worldX=this.origin[0]+x,worldY=this.origin[1]+y;
    const base=`${Math.floor(worldX/chunkSize)},${Math.floor(worldY/chunkSize)}`;
    if(this.chunks.has(base)||this.chunks.has(`${base}:detail`))return false;
    const tile=`overview:${Math.floor(worldX/overviewTerrainTileSize)},${Math.floor(worldY/overviewTerrainTileSize)}`;
    return this.chunks.has(tile);
  }

  paintMinimap(ctx:CanvasRenderingContext2D,x:number,y:number,span:number){
    const {width,height}=ctx.canvas;
    const left=x-span/2,top=y+span/2;
    ctx.fillStyle="#161f2b";ctx.fillRect(0,0,width,height);
    const colors={terrain:"#3a4943",water:"#234d61",road:"#969080",structure:"#6d6776"} as const;
    const boxes:Record<keyof typeof colors,Bounds[]>={terrain:[],water:[],road:[],structure:[]};
    for(const {mesh,bounds} of this.chunks.values()){
      const {kind}=mesh;
      if(kind!=="terrain"&&kind!=="water"&&kind!=="road"&&kind!=="structure"||mesh.replaces||mesh.visualOnly)continue;
      const [x0,y0,,x1,y1]=bounds;
      if(x0>left+span||x1<left||y0>top||y1<top-span)continue;
      if(kind!=="terrain"&&Math.min(x1-x0,y1-y0)>span/2)continue;
      boxes[kind].push(bounds);
    }
    for(const kind of ["terrain","water","road","structure"] as const){
      ctx.fillStyle=colors[kind];
      for(const [x0,y0,,x1,y1] of boxes[kind]){
        ctx.fillRect((x0-left)*width/span,(top-y1)*height/span,(x1-x0)*width/span,(y1-y0)*height/span);
      }
    }
  }

  private addVisibilityCell(chunk:Chunk){
    const {mesh,bounds}=chunk,[left,bottom,,right,top]=bounds;
    if(mesh.kind==="collision"||right-left>192||top-bottom>192)return;
    const key=`${Math.floor((left+right)/192)},${Math.floor((bottom+top)/192)}`;
    const cells=this.visibilityCells??=new Map();
    let cell=cells.get(key);
    const horizon=meshHorizon(mesh);
    if(!cell){
      cell={key,bounds:[...bounds],count:0,horizon,visible:false,contained:false};
      cells.set(key,cell);
    }else{
      for(let i=0;i<3;i++){
        cell.bounds[i]=Math.min(cell.bounds[i],bounds[i]);
        cell.bounds[i+3]=Math.max(cell.bounds[i+3],bounds[i+3]);
      }
      cell.horizon=Math.max(horizon,cell.horizon);
    }
    cell.count++;
    chunk.visibilityCell=cell;
  }

  private removeVisibilityCell(chunk:Chunk){
    const cell=chunk.visibilityCell;
    if(cell&&!--cell.count)this.visibilityCells?.delete(cell.key);
  }

  private locate(mesh:StreetChunk):Chunk{
    const [dx,dy,dz]=mesh.origin.map((value,i)=>value-this.origin[i]);
    const {vertices,bounds,instances}=mesh;
    const positions=instances?.poses??vertices,stride=instances?.affine?16:instances?9:4;
    for(let i=0;i<positions.length;i+=stride){
      positions[i]+=dx;positions[i+1]+=dy;positions[i+2]+=dz;
    }
    const collision=mesh.collision?.vertices;
    if(collision)for(let i=0;i<collision.length;i+=3){
      collision[i]+=dx;collision[i+1]+=dy;collision[i+2]+=dz;
    }
    const local=([x0,y0,z0,x1,y1,z1]:Bounds):Bounds=>[x0+dx,y0+dy,z0+dz,x1+dx,y1+dy,z1+dz];
    let textureBounds:Map<string,Bounds>|undefined,terrainLayers:Chunk["terrainLayers"],groundRoads:Chunk["groundRoads"];
    let groundDemand:TextureCandidate[]|undefined,materialDemand:TextureCandidate[]|undefined;
    for(const span of mesh.appearance?.spans??[]){
      if(span.texture?.startsWith(dynamicTerrainPrefix)&&span.textureBounds)
        (textureBounds??=new Map()).set(span.texture,local(span.textureBounds));
      if(span.terrain)(terrainLayers??=[]).push({terrain:span.terrain,bounds:span.textureBounds&&local(span.textureBounds)});
      if(span.road?.primaryLayers&&span.textureBounds)(groundRoads??=[]).push({road:span.road,bounds:local(span.textureBounds)});
      // Resolve regular texture sources once, keeping authored span order.
      const ground=span.ground??(mesh.kind==="terrain");
      const groundId=ground?span.texture:span.fallback;
      const materialId=ground?undefined:span.texture;
      if(groundId&&!groundId.startsWith(dynamicTerrainPrefix)&&!groundId.startsWith(canopyAtlasPrefix))
        (groundDemand??=[]).push({id:groundId,overlay:span.overlay});
      if(materialId&&!materialId.startsWith(dynamicTerrainPrefix)&&!materialId.startsWith(canopyAtlasPrefix))
        (materialDemand??=[]).push({id:materialId,overlay:span.overlay});
    }
    return {mesh,bounds:local(bounds),tiles:instances?.tiles?.map(tile=>({...tile,bounds:local(tile.bounds)})),textureBounds,terrainLayers,groundRoads,
      groundDemand,materialDemand,
      drawOrder:0,drawRank:0,drawDistance:0,
      spanBounds:!instances?mesh.appearance?.spans.map(span=>span.textureBounds&&local(span.textureBounds)):undefined,
      lodParent:mesh.modelName?authoredLodParent(mesh.modelName):undefined,
      lod:!mesh.modelName?undefined:instances&&mesh.kind==="prop"&&!instances.affine?
        streetPropLodVariant(mesh.modelName):!instances&&mesh.kind!=="skyline"&&mesh.kind!=="terrain"?
          streetLodVariant(mesh.modelName):undefined};
  }

  setNavigation(enabled:boolean){
    this.showNavigation=enabled;
    this.navigationRegion="";
    if(!enabled)this.installNavigation([],[]);
  }

  installNavigation(wanted:string[],meshes:StreetChunk[]){
    this.visibilityPlan=undefined;
    if(this.showNavigation)for(const mesh of meshes){
      const previous=this.navigation.get(mesh.id);
      const gpu=previous&&this.cache.get(previous);
      if(gpu){this.release(gpu);this.cache.delete(previous);}
      this.navigation.set(mesh.id,this.locate(mesh));
    }
    const keep=new Set(this.showNavigation?wanted:[]);
    for(const [id,chunk] of this.navigation){
      if(keep.has(id))continue;
      const gpu=this.cache.get(chunk);
      if(gpu){this.release(gpu);this.cache.delete(chunk);}
      this.navigation.delete(id);
    }
  }

  installInteriors(wanted:string[]|null,meshes:StreetChunk[],complete:boolean){
    const wasComplete=this.interiorComplete;
    this.interiorComplete=wanted!==null&&complete;
    return this.install(wanted,meshes,undefined,"interior")||wasComplete!==this.interiorComplete;
  }

  install(wanted:string[]|null,meshes:StreetChunk[],error?:string,lane:"region"|"vegetation"|"interior"="region"){
    if(this.occlusionReview)this.occlusionRevision++;
    if(wanted!==null)this.visibilityPlan=undefined;
    const camera=this.streamCamera,inView=camera&&streetFrustum(camera,1.18);
    let redraw=wanted!==null;
    for(const mesh of meshes){
      this.pendingBoxes.delete(mesh.id);
      const previous=this.chunks.get(mesh.id);
      // Packed selections can be refreshed by a turn or nearby cell change
      // even when this group's authored instances are identical.
      if(previous&&samePackedFoliage(previous.mesh,mesh,this.origin))continue;
      this.visibilityPlan=undefined;
      if(mesh.placementLod||previous?.mesh.placementLod)this.attachedLodFamilies=undefined;
      if(previous){
        this.removeVisibilityCell(previous);
        const gpu=this.cache.get(previous);
        if(gpu){this.release(gpu);this.cache.delete(previous);}
        this.collision.delete(previous);
      }
      const chunk=this.locate(mesh);
      this.addVisibilityCell(chunk);
      this.chunks.set(mesh.id,chunk);
      const priorMotion=this.rollerMotion.get(mesh.id);
      this.rollerMotion.delete(mesh.id);
      if(mesh.roller&&!mesh.instances){
        this.rollers.set(mesh.id,chunk);
        const target=Number(this.openRollers.has(mesh.id));
        if(priorMotion||target){
          const closed=mesh.vertices.slice();
          const state=priorMotion?{...priorMotion,closed}:{closed,fraction:target,from:target,to:target,started:0,duration:0};
          this.rollerMotion.set(mesh.id,state);
          this.applyRoller(chunk,closed,state.fraction);
        }
      }else this.rollers.delete(mesh.id);
      if(!redraw){
        const horizon=meshHorizon(mesh);
        redraw=!inView||mesh.kind!=="collision"&&
          (inView(chunk.bounds,horizon)||!!previous&&inView(previous.bounds,horizon));
      }
    }
    if(lane==="region"&&wanted!==null&&this.loading)redraw=true;
    if(redraw)this.textureSelectionDirty=true;
    if(wanted===null)return redraw;
    if(lane==="region"){this.loading=false;this.error=error??"";this.pendingBoxes.clear();}
    const keep=new Set(wanted);
    for(const [key,chunk] of this.chunks){
      const owner=chunk.mesh.interior?"interior":chunk.mesh.vegetation!==undefined?"vegetation":"region";
      if(keep.has(key)||owner!==lane)continue;
      const alternate=key.endsWith(":lod")?key.slice(0,-4):`${key}:lod`;
      if(lane==="region"&&keep.has(alternate)&&!this.chunks.has(alternate))continue;
      const gpu=this.cache.get(chunk);
      if(gpu){this.release(gpu);this.cache.delete(chunk);}
      this.collision.delete(chunk);
      this.removeVisibilityCell(chunk);
      this.chunks.delete(key);
      this.rollers.delete(key);
      this.rollerMotion.delete(key);
      if(chunk.mesh.placementLod)this.attachedLodFamilies=undefined;
    }
    return redraw;
  }

  resetInteriorCamera(){
    if(!this.interiorCamera.size)return;
    this.interiorCamera.clear();
    this.visibilityPlan=undefined;
  }

  rollerButton(view:StreetStreamView){
    const {eye:[x,y,z],yaw,pitch,aspect,fov}=view;
    const cos=Math.cos(yaw),sin=Math.sin(yaw),ct=Math.cos(pitch),st=Math.sin(pitch),scale=streetProjection(fov);
    let nearest=12;
    let result:{id:string;x:number;y:number;open:boolean}|undefined;
    for(const [id,{mesh}] of this.rollers){
      const {anchor,travel,up}=mesh.roller!;
      const dx=anchor[0]-this.origin[0]-x+up[0]*travel*.5;
      const dy=anchor[1]-this.origin[1]-y+up[1]*travel*.5;
      const dz=anchor[2]-this.origin[2]-z+up[2]*travel*.5;
      const distance=Math.hypot(dx,dy,dz),ahead=dx*cos+dy*sin,depth=ahead*ct+dz*st;
      if(distance>=nearest||depth<=streetNearPlane)continue;
      const sx=(dx*sin-dy*cos)*scale/(depth*aspect),sy=(dz*ct-ahead*st)*scale/depth;
      if(Math.abs(sx)>.88||Math.abs(sy)>.84||this.rollerOccluded(id,[x,y,z],[dx,dy,dz]))continue;
      nearest=distance;
      result={id,x:(sx+1)*50,y:(1-sy)*50,open:this.rollerMotion.get(id)?.to===1};
    }
    return result;
  }

  toggleRoller(id:string,now:number,duration:number){
    const chunk=this.rollers.get(id);
    if(!chunk)return false;
    const prior=this.rollerMotion.get(id),fraction=prior?.fraction??0,to=prior?.to===1?0:1;
    if(to)this.openRollers.add(id);
    else this.openRollers.delete(id);
    this.rollerMotion.set(id,{closed:prior?.closed??chunk.mesh.vertices.slice(),fraction,from:fraction,to,started:now,
      duration:duration*Math.abs(to-fraction)});
    return true;
  }

  private applyRoller({mesh}:Chunk,closed:Float32Array,fraction:number){
    const roller=mesh.roller!;
    const anchor=roller.anchor.map((n,i)=>n-this.origin[i]) as [number,number,number];
    poseRoller(roller,anchor,closed,mesh.vertices,fraction);
  }

  updateRollers(now:number){
    let moving=false;
    for(const [id,state] of this.rollerMotion){
      const chunk=this.rollers.get(id)!;
      const {mesh}=chunk;
      const t=state.duration?Math.max(0,Math.min(1,(now-state.started)/state.duration)):1;
      moving||=t<1;
      const fraction=state.from+(state.to-state.from)*t*t*(3-2*t);
      if(state.fraction===fraction)continue;
      state.fraction=fraction;
      this.applyRoller(chunk,state.closed,fraction);
      this.collision.delete(chunk);
      const gpu=this.cache.get(chunk);
      if(gpu){
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER,gpu.vertices);
        this.gl.bufferSubData(this.gl.ARRAY_BUFFER,0,mesh.vertices);
      }
      this.shadowRevision++;
    }
    return moving;
  }

  private rollerOutsideView(camera:StreetStreamView){
    let visible:ReturnType<typeof streetFrustum>|undefined;
    for(const [id,state] of this.rollerMotion){
      if(state.fraction===0&&state.to===0)continue;
      // Retain the conservative fallback for an animating roller. For a
      // fully open roller, check both its original occluder and current mesh.
      if(state.fraction!==1||state.to!==1)return false;
      const vertices=this.rollers.get(id)?.mesh.vertices;
      if(!vertices?.length||vertices.length!==state.closed.length)return false;
      let bounds=this.openRollerBounds.get(state.closed);
      if(bounds===undefined){
        const closedAndOpen:Bounds=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
        for(let at=0;at<vertices.length;at+=4)for(let axis=0;axis<3;axis++){
          const closed=state.closed[at+axis],open=vertices[at+axis];
          closedAndOpen[axis]=Math.min(closedAndOpen[axis],closed-1/16,open-1/16);
          closedAndOpen[axis+3]=Math.max(closedAndOpen[axis+3],closed+1/16,open+1/16);
        }
        bounds=closedAndOpen.every(Number.isFinite)?closedAndOpen:null;
        this.openRollerBounds.set(state.closed,bounds);
      }
      visible??=streetFrustum(camera,1.015);
      if(!bounds||visible(bounds,Infinity))return false;
    }
    return true;
  }

  private rollerOccluded(id:string,[x,y,z]:readonly [number,number,number],[dx,dy,dz]:readonly [number,number,number]){
    const left=Math.min(x,x+dx),right=Math.max(x,x+dx),bottom=Math.min(y,y+dy),top=Math.max(y,y+dy);
    const low=Math.min(z,z+dz),high=Math.max(z,z+dz);
    for(const chunk of this.chunks.values()){
      const {mesh,bounds:[a,b,c,d,e,f]}=chunk;
      if(mesh.id===id||mesh.instances||mesh.visualOnly||mesh.kind!=="structure"&&mesh.kind!=="terrain"&&mesh.kind!=="collision"||
        a>right||d<left||b>top||e<bottom||c>high||f<low)continue;
      for(const face of this.collisionFaces(chunk,left,bottom,right,top)){
        if(face.groundBlend||face.bounds[2]>high||face.bounds[5]<low)continue;
        const p=this.vertex(chunk,face.a),q=this.vertex(chunk,face.b),r=this.vertex(chunk,face.c);
        const [ux,uy,uz]=q.map((n,i)=>n-p[i]),[vx,vy,vz]=r.map((n,i)=>n-p[i]);
        const cx=dy*vz-dz*vy,cy=dz*vx-dx*vz,cz=dx*vy-dy*vx;
        const divisor=ux*cx+uy*cy+uz*cz;
        if(Math.abs(divisor)<1e-9)continue;
        const tx=x-p[0],ty=y-p[1],tz=z-p[2];
        const u=(tx*cx+ty*cy+tz*cz)/divisor;
        if(u<0||u>1)continue;
        const ex=ty*uz-tz*uy,ey=tz*ux-tx*uz,ez=tx*uy-ty*ux;
        const v=(dx*ex+dy*ey+dz*ez)/divisor;
        if(v<0||u+v>1)continue;
        const t=(vx*ex+vy*ey+vz*ez)/divisor;
        if(t>.002&&t<.98)return true;
      }
    }
    return false;
  }

  installBridgeLods(links:[string,NonNullable<StreetChunk["placementLod"]>][]){
    let changed=false;
    for(const [id,link] of links){
      const mesh=this.chunks.get(id)?.mesh;
      if(!mesh||mesh.placementLod?.distance===link.distance)continue;
      mesh.placementLod=link;
      changed=true;
    }
    if(changed){
      this.visibilityPlan=undefined;
      this.attachedLodFamilies=undefined;
      this.textureSelectionDirty=true;
    }
    return changed;
  }

  refreshTextures(){
    if(this.occlusionReview)this.occlusionRevision++;
    this.shadowRevision++;
    this.reflectionMaterials++;
    this.textureView=undefined;
    for(const texture of this.textures.values())if(texture)this.deleteMaterialTexture(texture);
    for(const texture of this.closeTextures.values())if(texture)this.gl.deleteTexture(texture);
    for(const texture of this.groundTextures.values())if(texture)this.gl.deleteTexture(texture);
    for(const texture of this.terrainTextures.values())this.gl.deleteTexture(texture);
    for(const texture of this.canopyTextures.values())if(texture)this.gl.deleteTexture(texture);
    this.textures.clear();this.pending.clear();this.foregroundRoadPending.clear();
    this.closeTextures.clear();this.closeWanted.clear();this.closeGroundWanted.clear();this.closeRequested.clear();
    this.canopyTextures.clear();this.canopyPending.clear();this.canopyWanted.clear();
    this.groundTextures.clear();this.groundPending.clear();
    this.terrainTextures.clear();this.terrainPending.clear();this.terrainMissing.clear();this.terrainWeightSizes.clear();
    this.terrainTextureSizes.clear();this.terrainTextureBytes=0;
  }

  setLighting(enabled:boolean){
    if(this.lightingMaterials===enabled)return;
    this.lightingMaterials=enabled;
    this.textureSelectionDirty=true;
  }

  setWaterOptics(source:StreetWaterOptics){
    if(this.waterOptics?.source===source)return false;
    this.deleteWaterOptics(this.waterOptics);
    this.waterOptics=this.uploadWaterOptics(source);
    return Boolean(this.waterOptics.scattering&&this.waterOptics.extinction);
  }

  setWaterTileRegion(source?:StreetWaterOptics){
    if(this.waterTileRegion?.source===source)return false;
    this.deleteWaterOptics(this.waterTileRegion);
    this.waterTileRegion=source?this.uploadWaterOptics(source):undefined;
    return true;
  }

  private deleteWaterOptics(optics:StreetWorld["waterOptics"]){
    if(optics?.scattering)this.gl.deleteTexture(optics.scattering);
    if(optics?.extinction)this.gl.deleteTexture(optics.extinction);
  }

  private uploadWaterOptics(source:StreetWaterOptics){
    const {gl}=this;
    const format=gl.getExtension("EXT_texture_compression_bptc")?.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT;
    if(!format)return {source};
    const upload=({width,height,bytes}:StreetWaterOptics["scattering"])=>{
      const texture=gl.createTexture();
      if(!texture)return;
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.compressedTexImage2D(gl.TEXTURE_2D,0,format,width,height,0,bytes);
      return texture;
    };
    gl.activeTexture(gl.TEXTURE2);
    const scattering=upload(source.scattering),extinction=upload(source.extinction);
    gl.activeTexture(gl.TEXTURE1);
    return {source,scattering,extinction};
  }

  setWaterMaterials(source:StreetWaterMaterials){
    if(this.waterMaterials?.source===source)return false;
    const {gl}=this;
    if(this.waterMaterials?.bump)gl.deleteTexture(this.waterMaterials.bump);
    if(this.waterMaterials?.foam)gl.deleteTexture(this.waterMaterials.foam);
    const bc3=gl.getExtension("WEBGL_compressed_texture_s3tc")?.COMPRESSED_RGBA_S3TC_DXT5_EXT;
    const bc7=this.gpuMaterialFormats.bc7;
    gl.activeTexture(gl.TEXTURE11);
    const bump=uploadStreetWaterMips(gl,source.bump,bc3);
    gl.activeTexture(gl.TEXTURE4);
    const foam=uploadStreetWaterMips(gl,source.foam,bc7);
    gl.activeTexture(gl.TEXTURE1);
    this.waterMaterials={source,bump,foam};
    return Boolean(bump||foam);
  }

  private deleteMaterialTexture(texture:WebGLTexture){
    const normal=this.detailNormals.get(texture);
    if(normal){this.gl.deleteTexture(normal);this.detailNormals.delete(texture);}
    this.gl.deleteTexture(texture);
  }

  private trimTerrainTextures(){
    if(this.loading||this.terrainTextureBytes<=terrainTextureBudget)return;
    for(const [id,texture] of this.terrainTextures){
      if(this.terrainWanted.has(id))continue;
      this.gl.deleteTexture(texture);
      this.terrainTextures.delete(id);
      this.terrainTextureBytes-=this.terrainTextureSizes.get(id)??0;
      this.terrainTextureSizes.delete(id);
      if(this.terrainTextureBytes<=terrainTextureBudget)break;
    }
  }

  installTexture(id:string,image:StreetTextureImage|null,ground:boolean,compressed?:StreetBlockTexture,cube?:StreetCubeTexture,roadHeightMips?:RoadHeightMip[]){
    if(this.occlusionReview)this.occlusionRevision++;
    if(!ground&&(image||compressed)&&this.shadowMaterials?.has(id))this.shadowRevision++;
    if(!ground&&(image||compressed)&&id.startsWith("0x"))this.reflectionMaterials++;
    if(id.startsWith(streetInteriorCubePrefix)){
      if(!this.terrainPending.delete(id))return;
      const gl=this.gl;
      const format=cube?.format==="bc1-srgb"?
        gl.getExtension("WEBGL_compressed_texture_s3tc_srgb")?.COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT:
        gl.getExtension("EXT_texture_compression_bptc")?.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT;
      const texture=cube&&format!==undefined?gl.createTexture():null;
      if(!cube||!texture||format===undefined){this.terrainMissing.add(id);this.textureSelectionDirty=true;return;}
      gl.activeTexture(gl.TEXTURE0+streetRoomCubeUnit);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP,texture);
      let size=0;
      for(const [level,{side,blocks}] of cube.levels.entries()){
        const stride=blocks.length/6;
        for(let face=0;face<6;face++)
          gl.compressedTexImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X+face,level,format,side,side,0,
            blocks.subarray(face*stride,(face+1)*stride));
        size+=blocks.byteLength;
      }
      gl.texParameteri(gl.TEXTURE_CUBE_MAP,gl.TEXTURE_MAX_LEVEL,cube.levels.length-1);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP,gl.TEXTURE_WRAP_R,gl.CLAMP_TO_EDGE);
      gl.activeTexture(gl.TEXTURE1);
      this.terrainTextures.set(id,texture);
      this.terrainTextureSizes.set(id,size);
      this.terrainTextureBytes+=size;
      this.trimTerrainTextures();
      return;
    }
    if(id.startsWith(terrainTexturePrefix)){
      if(!this.terrainPending.delete(id))return;
      const roomGlass=id.startsWith(roomGlassTexturePrefix);
      if(roomGlass&&compressed?.format==="bc7"&&this.roomGlassCompression!==undefined){
        const {gl}=this;
        const texture=gl.createTexture();
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D,texture);
        let bytes=0;
        for(const [level,{width,height,blocks}] of compressed.levels.entries()){
          gl.compressedTexImage2D(gl.TEXTURE_2D,level,this.roomGlassCompression,width,height,0,blocks);
          bytes+=blocks.byteLength;
        }
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAX_LEVEL,compressed.levels.length-1);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
        this.terrainTextures.set(id,texture);
        this.terrainTextureSizes.set(id,bytes);this.terrainTextureBytes+=bytes;
        this.trimTerrainTextures();
        return;
      }
      if(!image){this.terrainMissing.add(id);this.textureSelectionDirty=true;return;}
      if(id.startsWith(materialMaskChainPrefix)&&!this.materialMaskSlices.has(id)){
        const slice=Math.min(15,Math.floor(image.rgba[1]*16/255));
        // Linear filtering and generated mips cannot leave a shared slice bin.
        // Keep a margin for rounding to the next RGBA8 value.
        const low=Math.ceil(slice*255/16),high=slice===15?255:Math.ceil((slice+1)*255/16)-1;
        const withinSlice=[image,...image.authoredMips??[]].every(({rgba})=>{
          for(let i=1;i<rgba.length;i+=4)if(rgba[i]<low||rgba[i]>high)return false;
          return rgba.length>0;
        });
        this.materialMaskSlices.set(id,withinSlice?slice:null);
        if(withinSlice)this.textureSelectionDirty=true;
      }
      if(id.startsWith(terrainWeightPrefix)){
        const pixels=image.width*image.height;
        if(this.loading&&pixels!==(this.terrainWeightSizes.get(id)??largestTerrainWeight))this.textureSelectionDirty=true;
        this.terrainWeightSizes.set(id,pixels);
      }
      const {gl}=this;
      const texture=gl.createTexture();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D,texture);
      const normal=id.startsWith(terrainNormalPrefix);
      const twoChannels=normal||id.startsWith(terrainTexturePrefix+"height:");
      const tint=id.startsWith(terrainTintPrefix);
      const diffuse=id.startsWith(terrainTexturePrefix+"diffuse:")||id.startsWith(terrainTexturePrefix+"native-color:")||id.startsWith(authoredDiffusePrefix);
      const format=tint||diffuse||roomGlass?gl.SRGB8_ALPHA8:gl.RGBA8;
      const uploadLevel=(level:number,{width,height,rgba}:StreetTextureImage)=>{
        if(twoChannels){
          const packed=new Uint8Array(width*height*2);
          const channel=normal?0:2;
          for(let i=0;i<packed.length;i+=2){
            packed[i]=rgba[i*2+channel];
            packed[i+1]=rgba[i*2+channel+1];
          }
          gl.texImage2D(gl.TEXTURE_2D,level,gl.RG8,width,height,0,gl.RG,gl.UNSIGNED_BYTE,packed);
        }else gl.texImage2D(gl.TEXTURE_2D,level,format,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
      };
      if(twoChannels)gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
      uploadLevel(0,image);
      if(tint||id.startsWith(terrainWeightPrefix)){
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      }
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,image.baseLevelOnly?gl.LINEAR:gl.LINEAR_MIPMAP_LINEAR);
      if(this.anisotropy&&(diffuse||id.startsWith(terrainTexturePrefix+"color:")||id.startsWith(detailAtlasSlicePrefix)))
        gl.texParameterf(gl.TEXTURE_2D,this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(4,this.groundAnisotropy));
      const mips=image.authoredMips??[];
      const authoredChain=roomGlass||mips.length>0||image.baseLevelOnly||id===streetBlueNoiseId;
      if(authoredChain)gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAX_LEVEL,mips.length);
      else gl.generateMipmap(gl.TEXTURE_2D);
      for(const [level,mip] of mips.entries())uploadLevel(level+1,mip);
      if(twoChannels)gl.pixelStorei(gl.UNPACK_ALIGNMENT,4);
      this.terrainTextures.set(id,texture);
      const bytes=authoredChain?mips.reduce((size,mip)=>size+mip.width*mip.height,image.width*image.height)*(twoChannels?2:4):
        Math.ceil(image.width*image.height*(twoChannels?2:4)*4/3);
      this.terrainTextureSizes.set(id,bytes);this.terrainTextureBytes+=bytes;
      this.trimTerrainTextures();
      return;
    }
    const close=id.startsWith(closeMaterialPrefix),canopy=id.startsWith(canopyAtlasPrefix);
    const key=close?id.slice(closeMaterialPrefix.length):id;
    const roadColor=key.startsWith(roadSurfacePrefix);
    const textures=canopy?this.canopyTextures:close?this.closeTextures:ground?this.groundTextures:this.textures;
    if(close){
      if(!this.closeRequested.delete(key))return;
      if(!this.closeWanted.has(key))return;
    }else if(!(canopy?this.canopyPending:ground?this.groundPending:this.pending).delete(id))return;
    if(!ground&&!close&&!canopy&&this.foregroundRoadPending.delete(id)&&!this.foregroundRoadPending.size)
      this.textureSelectionDirty=true;
    const {gl}=this;
    if(roadHeightMips?.length){
      const texture=gl.createTexture();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
      for(const [level,{width,height,channels}] of roadHeightMips.entries())
        gl.texImage2D(gl.TEXTURE_2D,level,gl.RG8,width,height,0,gl.RG,gl.UNSIGNED_BYTE,channels);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT,4);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAX_LEVEL,roadHeightMips.length-1);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
      textures.set(key,texture);
      return;
    }
    const roadLuminance=compressed?.roadColorLuminance;
    const compressedFormat=compressed?(roadLuminance===undefined?this.gpuMaterialFormats:this.gpuRoadColorFormats)[compressed.format]:undefined;
    if(compressed&&compressedFormat){
      const texture=gl.createTexture();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D,texture);
      for(const [level,{width,height,blocks}] of compressed.levels.entries())
        gl.compressedTexImage2D(gl.TEXTURE_2D,level,compressedFormat,width,height,0,blocks);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAX_LEVEL,compressed.levels.length-1);
      const mask=id.startsWith(roadWeightPrefix);
      const height=id.startsWith(roadHeightPrefix);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,mask?gl.LINEAR:gl.LINEAR_MIPMAP_LINEAR);
      if(!mask&&!height&&this.anisotropy)gl.texParameterf(gl.TEXTURE_2D,this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(4,this.groundAnisotropy));
      if(height)this.compressedRoadHeights.add(texture);
      if(roadLuminance!==undefined)this.roadColorLuminance.set(texture,roadLuminance);
      const resident=this.textures.get(key);
      if(compressed.alphaCutout||resident&&this.alphaTextures.has(resident))this.alphaTextures.add(texture);
      textures.set(key,texture);
      return;
    }
    if(image&&id.startsWith(dynamicTerrainPrefix)){
      const limit=gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if(image.width>limit||image.height>limit)image=null;
    }
    if(!image){
      // Keep failed lookups until an explicit texture refresh. The number of
      // resident textures can exceed the old cap in dense views, which made
      // the queue repeatedly retry visible materials it had already checked.
      textures.set(key,null);this.textureSelectionDirty=true;return;
    }
    const texture=gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D,texture);
    const roadHeight=id.startsWith(roadHeightPrefix);
    if(roadHeight){
      const channels=roadHeightBlueAlpha(image.rgba);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RG8,image.width,image.height,0,gl.RG,gl.UNSIGNED_BYTE,channels);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT,4);
    }else if(id.startsWith(roadControlPrefix)){
      const red=new Uint8Array(image.width*image.height);
      for(let i=0;i<red.length;i++)red[i]=image.rgba[i*4];
      gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.R8,image.width,image.height,0,gl.RED,gl.UNSIGNED_BYTE,red);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT,4);
    }else{
      const srgb=id.startsWith(roadTintPrefix)||id.startsWith(roadSurfaceTintPrefix);
      gl.texImage2D(gl.TEXTURE_2D,0,srgb?gl.SRGB8_ALPHA8:gl.RGBA8,image.width,image.height,0,gl.RGBA,gl.UNSIGNED_BYTE,image.rgba);
    }
    if(canopy||id.startsWith(roadTintPrefix)||id.startsWith(roadControlPrefix)){
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    }
    const refinedRoadColor=close&&roadColor;
    const authoredMips=ground||refinedRoadColor||id.startsWith(nativeCanopyAtlasPrefix)?image.authoredMips:undefined;
    if(ground&&authoredMips?.length)gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAX_LEVEL,authoredMips.length);
    if(id.startsWith(nativeCanopyAtlasPrefix))
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAX_LEVEL,authoredMips?.length??
        Math.max(0,Math.floor(Math.log2(Math.min(image.width,image.height)/16))));
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,image.baseLevelOnly?gl.LINEAR:gl.LINEAR_MIPMAP_LINEAR);
    if(image.baseLevelOnly)gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAX_LEVEL,0);
    if(!roadHeight&&!image.baseLevelOnly&&this.anisotropy)
      gl.texParameterf(gl.TEXTURE_2D,this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,
        ground&&!roadColor?this.groundAnisotropy:Math.min(4,this.groundAnisotropy));
    if(image.alphaCutout)this.alphaTextures.add(texture);
    if(authoredMips?.length){
      const tail=authoredMips.at(-1)!;
      // Projected roads still use a 1×1 color reference. Keep the generated
      // tail below the last authored level for that approximation.
      if(refinedRoadColor&&Math.max(tail.width,tail.height)>1)gl.generateMipmap(gl.TEXTURE_2D);
      for(const [index,mip] of authoredMips.entries())
        gl.texImage2D(gl.TEXTURE_2D,index+1,gl.RGBA8,mip.width,mip.height,0,gl.RGBA,gl.UNSIGNED_BYTE,mip.rgba);
    }else if(!image.baseLevelOnly)gl.generateMipmap(gl.TEXTURE_2D);
    textures.set(key,texture);
    if(!close&&!canopy&&!ground&&image.detailNormal?.length===image.width*image.height*2){
      const normal=gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D,normal);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RG8,image.width,image.height,0,gl.RG,gl.UNSIGNED_BYTE,image.detailNormal);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT,4);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.detailNormals.set(texture,normal);
    }
  }

  private prepareTextures(visible:Chunk[],camera:StreetStreamView,inView:(bounds:Bounds,horizon:number)=>boolean,
    fallbackAtlases:readonly string[]){
    const [x,y,z]=camera.eye;
    const distance=([left,bottom,,right,top]:Bounds)=>
      Math.max(0,left-x,x-right)**2+Math.max(0,bottom-y,y-top)**2;
    const ordered=visible.map(chunk=>({chunk,range:distance(chunk.bounds)}))
      .sort((a,b)=>Number(a.chunk.mesh.kind==="skyline")-Number(b.chunk.mesh.kind==="skyline")||
        comparePriority(a.range,b.range)||compareKeys(a.chunk.mesh.id,b.chunk.mesh.id))
      .map(({chunk})=>chunk);
    this.canopyWanted=new Set();
    for(const {mesh} of ordered){
      if(mesh.vegetation===undefined)continue;
      for(const {texture} of mesh.appearance?.spans??[])
        if(texture?.startsWith(canopyAtlasPrefix))this.canopyWanted.add(texture);
    }
    // Fill the visible queue first, then retain the textures for resident
    // packed groups so a quick turn can use their atlases immediately.
    for(const {mesh} of this.chunks.values()){
      if(!mesh.packedSlodCenter)continue;
      for(const {texture} of mesh.appearance?.spans??[])
        if(texture?.startsWith(canopyAtlasPrefix))this.canopyWanted.add(texture);
    }
    const dynamic=new Map<string,number>();
    for(const {textureBounds} of ordered){
      if(!textureBounds)continue;
      for(const [id,bounds] of textureBounds){
        if(this.textures.get(id)===null||!inView(bounds,streetHorizon))continue;
        const near=distance(bounds);
        if(near<(dynamic.get(id)??Infinity))dynamic.set(id,near);
      }
    }
    const nearbyDynamic=textureOrder(dynamic,dynamicTextureLimit);
    const groundRoads=visible.flatMap(chunk=>chunk.groundRoads??[])
      .filter(({bounds})=>inView(bounds,streetHorizon))
      .sort((a,b)=>comparePriority(distance(a.bounds),distance(b.bounds))||compareKeys(a.road.textures[0],b.road.textures[0]));
    this.groundPlan=this.planTextureSet(ordered,true,[]);
    const materials=new Map<string,number>(),nearbyMaterials=new Map<string,number>(),nearbyGroundMaterials=new Map<string,number>(),decals=new Map<string,number>();
    const visibleFacades=new Map<string,number>(),visiblePanels=new Map<string,number>(),closeMaterials=new Map<string,number>();
    const skylineCloseMaterials=new Map<string,number>();
    const nearbyProps:{range:number;surface:string;other:string[]}[]=[];
    const skylineMaterials=new Map<string,number>(),lowSkylineMaterials=new Map<string,number>(),waterDecals=new Map<string,number>();
    const objectNormals=new Map<string,number>();
    const layeredMaterials:{ids:string[];score:number}[]=[];
    const onScreen=streetFrustum(camera);
    function materialScore(bounds:Bounds,range:number,visible:boolean){
      const [x0,y0,z0,x1,y1,z1]=bounds;
      const dx=x1-x0,dy=y1-y0,dz=z1-z0;
      return Math.max(dx*dy,dx*dz,dy*dz)/(25+range)*(visible?1+.9/(1+range/1024):.12);
    }
    const roadDetailVisible=streetFrustum(camera,1,roadDetailFarDepth);
    for(const {road,bounds} of groundRoads){
      if(road.detail&&roadDetailVisible(bounds))
        layeredMaterials.push({ids:[...new Set(road.detail.textures)],score:materialScore(bounds,streetDistance(bounds,camera.eye),true)});
    }
    for(const {mesh,bounds,spanBounds} of visible){
      if(mesh.kind==="skyline"){
        const selected=mesh.drawDistance===lowSkylineHorizon?lowSkylineMaterials:skylineMaterials;
        for(const [i,{texture,overlay,ground}] of (mesh.appearance?.spans??[]).entries()){
          if(!texture||overlay||ground||this.textures.get(texture)===null)continue;
          const extent=spanBounds?.[i]??bounds;
          if(!onScreen(extent,meshHorizon(mesh)))continue;
          const score=materialScore(extent,streetDistance(extent,camera.eye),true);
          selected.set(texture,Math.max(score,selected.get(texture)??0));
          // A skyline drawable can be the only authored shell for a large
          // object. Let its atlas compete with nearby opaque surfaces.
          if(selected===skylineMaterials)
            skylineCloseMaterials.set(texture,Math.max(score,skylineCloseMaterials.get(texture)??0));
        }
        continue;
      }
      if(mesh.kind==="water"){
        if(!onScreen(bounds))continue;
        const range=streetDistance(bounds,camera.eye);
        for(const {texture,overlay} of mesh.appearance?.spans??[])
          if(overlay&&texture&&this.textures.get(texture)!==null&&range<(waterDecals.get(texture)??Infinity))
            waterDecals.set(texture,range);
        continue;
      }
      if(mesh.kind==="terrain"){
        for(const [i,{texture,ground,overlay,fallback,decalTintMasks}] of (mesh.appearance?.spans??[]).entries()){
          const extent=spanBounds?.[i]??bounds;
          const range=streetDistance(extent,camera.eye);
          if(decalTintMasks&&onScreen(extent,streetHorizon))
            layeredMaterials.push({ids:decalTintMasks,score:materialScore(extent,range,true)});
          if(!mesh.replaces||!texture||ground!==false||overlay||!fallback||texture.startsWith(dynamicTerrainPrefix)||
            this.textures.get(texture)===null)continue;
          if(range<24**2&&range<(nearbyGroundMaterials.get(texture)??Infinity)&&onScreen(extent,streetHorizon))
            nearbyGroundMaterials.set(texture,range);
        }
        continue;
      }
      if(mesh.kind!=="structure"&&mesh.kind!=="prop")continue;
      const horizon=meshHorizon(mesh);
      const objectRange=streetDistance(bounds,camera.eye),objectInFrame=onScreen(bounds,horizon);
      const objectScore=materialScore(bounds,objectRange,objectInFrame);
      let propRange=Infinity;
      if(mesh.kind==="prop"&&mesh.instances&&!mesh.instances.affine&&objectRange<32**2){
        const {poses}=mesh.instances;
        for(let at=0;at<poses.length;at+=9){
          const px=poses[at],py=poses[at+1],pz=poses[at+2];
          const range=(px-x)**2+(py-y)**2+(pz-z)**2;
          if(range<32**2&&range<propRange&&onScreen([px-1,py-1,pz-1,px+1,py+1,pz+1],horizon))propRange=range;
        }
      }
      let propSurface:string|undefined,propSurfaceCount=0;
      const propTextures=Number.isFinite(propRange)?new Set<string>():undefined;
      for(const [index,{texture,bump,overlay,ground,count,noDecalColor,propLayers:authored,staticLayers,room,decalTintMask,surfaceDecalBlend}] of (mesh.appearance?.spans??[]).entries()){
        if(noDecalColor)continue;
        const extent=spanBounds?.[index];
        if((authored||staticLayers||room||decalTintMask||surfaceDecalBlend)&&(extent?onScreen(extent,horizon):objectInFrame)){
          if(authored&&mesh.instances?.propLayerControls&&(!authored.dirt||mesh.instances.propDirtControls))
            layeredMaterials.push({ids:propLayerTextures(authored),score:objectScore});
          if(staticLayers){
            const ids=staticLayerTextures(staticLayers);
            layeredMaterials.push({ids,score:objectScore});
            if(staticLayers.dirt)layeredMaterials.push({ids:[authoredDiffusePrefix+staticLayers.dirt],score:objectScore});
            for(const [index,detail] of (staticLayers.detail??[]).entries()){
              const slice=detail?this.materialMaskSlices.get(ids[index+2]):undefined;
              if(slice!=null&&detail){
                const atlas=detailAtlasSlicePrefix+slice;
                layeredMaterials.push({ids:detail[3]?[atlas,streetBlueNoiseId]:[atlas],score:objectScore});
              }
            }
          }
          if(decalTintMask)layeredMaterials.push({ids:[decalTintMask],score:objectScore});
          if(surfaceDecalBlend)layeredMaterials.push({ids:[surfaceDecalBlend.control,surfaceDecalBlend.dirt],score:objectScore});
          if(room&&this.roomTexturesSupported){
            layeredMaterials.push({ids:[streetInteriorCubePrefix+room.colorCube,terrainTexturePrefix+"diffuse:"+room.projected],score:objectScore});
            if(room.glass)layeredMaterials.push({ids:roomGlassTextures(room.glass),score:objectScore});
          }
        }
        if(texture&&!ground&&!texture.startsWith(dynamicTerrainPrefix)&&this.textures.get(texture)!==null){
          const range=extent?streetDistance(extent,camera.eye):objectRange,inFrame=extent?onScreen(extent,horizon):objectInFrame;
          const score=(extent?materialScore(extent,range,inFrame)+objectScore*.08:objectScore)*
            (mesh.kind==="prop"?.45:1);
          propTextures?.add(texture);
          if(overlay){
            if(inFrame)decals.set(texture,Math.max(score,decals.get(texture)??0));
            continue;
          }
          if(mesh.kind==="structure"&&inFrame&&range<32**2){
            nearbyMaterials.set(texture,Math.min(range,nearbyMaterials.get(texture)??Infinity));
          }
          if(inFrame&&(mesh.kind==="structure"?range<32**2:propTextures!==undefined))
            closeMaterials.set(texture,Math.max(score,closeMaterials.get(texture)??0));
          if(mesh.kind==="structure"&&inFrame&&range<128**2)
            visibleFacades.set(texture,Math.max(score,visibleFacades.get(texture)??0));
          if(mesh.kind==="structure"&&inFrame&&extent&&range>=32**2){
            const dx=extent[3]-extent[0],dy=extent[4]-extent[1],height=extent[5]-extent[2];
            // Thin upright faces such as signs are easy to lose in the area
            // ranking for entire buildings, even when their artwork is visible.
            if(height>0&&Math.min(dx,dy)<=.5*Math.min(height,Math.max(dx,dy))){
              const screen=streetScreenBounds(extent,camera);
              if(screen){
                const [left,bottom,right,top]=screen;
                const width=Math.max(0,Math.min(1,right)-Math.max(-1,left));
                const screenHeight=Math.max(0,Math.min(1,top)-Math.max(-1,bottom));
                const area=width*screenHeight;
                if(area>=.0005&&area<=.04)visiblePanels.set(texture,Math.max(area,visiblePanels.get(texture)??0));
              }
            }
          }
          if(propTextures){
            if(count>propSurfaceCount||count===propSurfaceCount&&propSurface!==undefined&&texture<propSurface){
              propSurface=texture;propSurfaceCount=count;
            }
          }
          if(this.lightingMaterials&&bump&&inFrame&&(!this.loading||range<128**2)&&range<(objectNormals.get(bump)??Infinity))
            objectNormals.set(bump,range);
          materials.set(texture,Math.max(score,materials.get(texture)??0));
        }
      }
      if(propSurface&&propTextures){
        propTextures.delete(propSurface);
        nearbyProps.push({range:propRange,surface:propSurface,other:[...propTextures]});
      }
    }
    // Keep small nearby facade pieces from losing every slot to larger roofs and walls.
    const nearLimit=Math.floor(streetBudgets.materialTextures*.16);
    const nearby=textureOrder(nearbyMaterials,nearLimit);
    nearbyProps.sort((a,b)=>comparePriority(a.range,b.range)||compareKeys(a.surface,b.surface));
    const propBudget=Math.min(64,Math.floor(streetBudgets.materialTextures*.26));
    // Give each close prop a useful surface before fetching secondary spans.
    const propSurfaces=[...new Set(nearbyProps.map(prop=>prop.surface))].slice(0,Math.ceil(propBudget*.6));
    const props=[...new Set([...propSurfaces,...nearbyProps.flatMap(prop=>prop.other)])].slice(0,propBudget);
    if(closeMaterialLimit){
      const readable=(id:string)=>this.closeTextures.get(id)!==null;
      const roadUpgrades=new Set<string>();
      for(const {road,bounds} of groundRoads){
        if(distance(bounds)>=32**2)break;
        if(!onScreen(bounds,streetHorizon))continue;
        for(const id of road.textures.slice(road.vertexOnly?0:1))
          if(id.startsWith(roadSurfacePrefix)&&readable(id))roadUpgrades.add(id);
      }
      const upgrades=this.loading?[...this.closeWanted].filter(id=>!this.closeGroundWanted.has(id)):
        textureOrder(closeMaterials,Infinity,true).filter(readable);
      this.closeForegroundWanted=new Set(textureOrder(closeMaterials,closeMaterialLimit,true).filter(readable));
      const skylineUpgrades=this.loading?[]:textureOrder(skylineCloseMaterials,Infinity,true).filter(readable).slice(0,closeMaterialLimit);
      const directGround=textureOrder(nearbyGroundMaterials).filter(readable);
      this.closeGroundWanted=new Set([...roadUpgrades,...directGround]);
      this.closeWanted=new Set([...this.closeGroundWanted,...this.closeForegroundWanted,...upgrades,...skylineUpgrades]);
    }
    for(const [id,texture] of this.closeTextures)if(texture&&!this.closeWanted.has(id)){
      this.gl.deleteTexture(texture);
      this.closeTextures.delete(id);
    }
    const byArea=textureOrder(materials,Infinity,true);
    const baseBudget=Math.max(nearby.length,Math.floor(streetBudgets.materialTextures*.55)-props.length);
    const base=[...new Set([...nearby,...byArea])].slice(0,baseBudget);
    const visibleDecals=textureOrder(decals,16,true);
    const visibleWaterDecals=textureOrder(waterDecals,6);
    // Aerial views expose many more of the authored skyline atlases. Give
    // them part of the existing fallback allowance after nearby loads settle.
    const standardSkylineLimit=Math.min(24,Math.floor(streetBudgets.materialTextures/12));
    const aerialSkylineAllowance=this.flightTerrain&&streetBudgets.materialSide>=512?
      Math.floor(streetBudgets.materialTextures/10):0;
    const skylineLimit=this.loading?8:standardSkylineLimit+aerialSkylineAllowance;
    const skyline=textureOrder(skylineMaterials,skylineLimit,true);
    const lowSkyline=textureOrder(lowSkylineMaterials,this.loading?0:4,true);
    const nearestGround=textureOrder(nearbyGroundMaterials,4);
    const primary=new Set([...fallbackAtlases,...base.slice(0,4),...nearestGround,...base.slice(4,8),...props,
      ...base.slice(8,16),...visibleDecals,...visibleWaterDecals,...base.slice(16),...skyline,...lowSkyline]);
    // Share the added allowance between visible panels and nearby facades.
    const visibleLimit=Math.floor(streetBudgets.materialTextures/8);
    const panels=textureOrder(visiblePanels,Infinity,true).filter(id=>!primary.has(id)).slice(0,Math.floor(visibleLimit/2));
    for(const id of panels)primary.add(id);
    for(const id of textureOrder(visibleFacades,Infinity,true).filter(id=>!primary.has(id))
      .slice(0,visibleLimit-panels.length))primary.add(id);
    this.materialPlan=this.planTextureSet(ordered,false,nearbyDynamic,groundRoads,[...primary]);
    // A long tunnel can have several visible material groups at different depths.
    const layers:{terrain:TerrainLayers;near:number;center:number}[]=[];
    for(const chunk of visible){
      for(const {terrain,bounds} of chunk.terrainLayers??[]){
        if(bounds&&!inView(bounds,streetHorizon))continue;
        const extent=bounds??chunk.bounds;
        const [x0,y0,z0,x1,y1,z1]=extent;
        if(terrain.detail&&roadDetailVisible(extent)){
          this.terrainDetailSupported??=this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS)>terrainDetailUnits[3];
          if(this.terrainDetailSupported)
            layeredMaterials.push({ids:[...new Set(terrain.detail.textures)],score:materialScore(extent,streetDistance(extent,camera.eye),true)});
        }
        layers.push({terrain,near:distance(extent)+Math.max(0,z0-z,z-z1)**2,
          center:(x-(x0+x1)/2)**2+(y-(y0+y1)/2)**2+(z-(z0+z1)/2)**2});
      }
    }
    layers.sort((a,b)=>comparePriority(a.near,b.near)||comparePriority(a.center,b.center)||
      compareKeys(a.terrain.textures[0],b.terrain.textures[0]));
    const visibleObjectNormals=textureOrder(objectNormals);
    layeredMaterials.sort((a,b)=>comparePriority(b.score,a.score)||compareKeys(a.ids[0],b.ids[0]));
    this.prepareTerrainTextures(layers,visibleObjectNormals,layeredMaterials);
  }

  private prepareTerrainTextures(ordered:readonly {terrain:TerrainLayers}[],objectNormals:readonly string[],
    layeredMaterials:readonly {ids:string[]}[]){
    const wanted=new Set<string>(),masks=new Set<string>(),tints=new Set<string>(),normals=new Set<string>();
    let weightPixels=0;
    for(const {terrain} of ordered){
      const tint=terrain.tint?.texture;
      const required=(terrain.vertexWeightUV||terrain.nativeLocalBlend)&&tint?[...terrain.textures,tint]:terrain.textures;
      if(required.some(id=>this.terrainMissing.has(id)))continue;
      const mask=terrain.vertexWeightUV?undefined:terrain.textures[0];
      const extra=!mask||masks.has(mask)?0:this.terrainWeightSizes.get(mask)??largestTerrainWeight;
      if(this.loading&&(weightPixels+extra>terrainWeightBudget||
        wanted.size+required.filter(id=>!wanted.has(id)).length>27))continue;
      if(mask)masks.add(mask);
      weightPixels+=extra;
      for(const id of required)wanted.add(id);
      if(tint&&!terrain.vertexWeightUV&&(!this.loading||tints.size<terrainTintLimit)&&!this.terrainMissing.has(tint))tints.add(tint);
      const normal=terrain.normals;
      normal?.textures.forEach((id,i)=>{
        if((!this.loading||normals.size<terrainNormalLimit)&&normal.strength[i]>0&&!this.terrainMissing.has(id))
          normals.add(id);
      });
    }
    for(const tint of tints)wanted.add(tint);
    for(const normal of normals)wanted.add(normal);
    let added=0;
    for(const id of objectNormals){
      if(this.loading&&added>=8)break;
      if(!wanted.has(id)&&!this.terrainMissing.has(id)){wanted.add(id);added++;}
    }
    const layeredWanted=new Set<string>();
    for(const {ids} of layeredMaterials){
      if(ids.some(id=>this.terrainMissing.has(id))||
        this.loading&&layeredWanted.size+ids.filter(id=>!layeredWanted.has(id)).length>32)continue;
      for(const id of ids)layeredWanted.add(id);
    }
    for(const id of layeredWanted)wanted.add(id);
    this.terrainWanted=wanted;
    this.layeredMaterialWanted=layeredWanted;
    this.trimTerrainTextures();
  }

  private requestTerrainTextures(){
    if(this.terrainPending.size>=streetBudgets.terrainReads)return;
    // Finish visible material groups alongside the ground queue, so terrain
    // layers and optional normals cannot delay every input to an opaque surface.
    if(![...this.terrainPending].some(id=>this.layeredMaterialWanted.has(id))){
      for(const id of this.layeredMaterialWanted){
        if(this.terrainTextures.has(id))continue;
        this.requestTerrainTexture(id);
        break;
      }
    }
    for(const id of this.terrainWanted){
      if(this.terrainPending.size>=streetBudgets.terrainReads)break;
      if(this.terrainTextures.has(id)||this.terrainPending.has(id))continue;
      this.requestTerrainTexture(id);
    }
  }
  private requestTerrainTexture(id:string){
    this.terrainPending.add(id);
    const compression=this.roomGlassCompression!==undefined&&id.startsWith(roomGlassTexturePrefix)?
      compressedMaterialFormats.bc7:undefined;
    this.requestTexture(id,false,compression);
  }
  private requestCanopyTextures(){
    if(this.loading||this.canopyPending.size>=4)return;
    const limit=Math.max(canopyTextureLimit,this.canopyWanted.size);
    for(const [key,texture] of this.canopyTextures){
      if(this.canopyTextures.size+this.canopyPending.size<limit)break;
      if(this.canopyWanted.has(key))continue;
      if(texture)this.gl.deleteTexture(texture);
      if(texture&&this.shadowMaterials?.has(key))this.shadowRevision++;
      this.canopyTextures.delete(key);
    }
    for(const id of this.canopyWanted){
      if(this.canopyPending.size>=4||this.canopyTextures.size+this.canopyPending.size>=limit)break;
      if(this.canopyTextures.has(id)||this.canopyPending.has(id))continue;
      this.canopyPending.add(id);
      this.requestTexture(id,false);
    }
  }
  private planTextureSet(ordered:Chunk[],ground:boolean,dynamic:string[],groundRoads:NonNullable<Chunk["groundRoads"]>=[],
    primary:string[]=[]):TexturePlan{
    const textures=ground?this.groundTextures:this.textures;
    const pending=ground?this.groundPending:this.pending;
    const foliageMaterials=new Set<string>();
    if(!ground)for(const {mesh} of ordered){
      if(mesh.vegetation===undefined)continue;
      for(const {texture} of mesh.appearance?.spans??[]){
        if(texture&&!texture.startsWith(canopyAtlasPrefix)&&textures.get(texture)!==null)foliageMaterials.add(texture);
      }
    }
    // Keep foreground work ahead of other materials during initial loading.
    // Once the scene is ready, let its actual texture demand drive residency.
    const bounded=this.loading;
    const limit=!bounded?Infinity:ground?groundTextureLimit:streetBudgets.materialTextures+foliageMaterials.size;
    const wanted=new Set([...primary,...dynamic]);
    const wantLimit=limit-dynamic.length;
    const detailTextures=new Set<string>();
    let nearestRoad:string[]=[];
    const hasStructures=!ground&&ordered.some(({mesh})=>mesh.kind!=="terrain"&&mesh.appearance);
    if(!ground){
      for(const {mesh} of ordered){
        if(mesh.kind!=="road"&&!mesh.decalBlend)continue;
        for(const {road,texture,overlay,decalLayers} of mesh.appearance?.spans??[]){
          if(overlay&&texture&&(mesh.kind==="road"||decalLayers)&&wanted.size<wantLimit&&textures.get(texture)!==null)
            wanted.add(texture);
          if(decalLayers)for(const id of decalLayers)
            if(id&&wanted.size<wantLimit&&textures.get(id)!==null)wanted.add(id);
          if(!road||road.textures.some(id=>textures.get(id)===null))continue;
          for(const id of road.textures)if(wanted.size<wantLimit)wanted.add(id);
        }
      }
      for(const {road} of groundRoads){
        const keys=new Set(road.textures);
        const heights=road.height?.textures??[];
        if(!road.localVertexColor||!heights.some(id=>id&&textures.get(id)===null))
          for(const height of heights)if(height)keys.add(height);
        if(road.tint&&(!road.tint.surfaceAlpha||textures.get(road.tint.texture)!==null))keys.add(road.tint.texture);
        const mask=road.textures[0];
        if(road.useProjectedColor&&!road.vertexOnly&&textures.get(mask)===null)keys.delete(mask);
        if([...keys].some(id=>textures.get(id)===null))continue;
        if(bounded&&wanted.size+[...keys].filter(id=>!wanted.has(id)).length>wantLimit)continue;
        for(const id of keys)wanted.add(id);
        // A complete or already-requested group cannot benefit from priority.
        // Keep advancing to the next visible group as its neighbors finish.
        if(!nearestRoad.length){
          const control=road.parallax?.texture;
          const needsControl=control!==undefined&&!textures.has(control)&&!pending.has(control)&&
            (wanted.has(control)||wanted.size<wantLimit);
          if(needsControl||[...keys].some(id=>!textures.has(id)&&!pending.has(id))){
            nearestRoad=[...keys];
            if(needsControl){
              wanted.add(control);
              nearestRoad.push(control);
            }
          }
        }
      }
      for(const {road} of groundRoads){
        const control=road.parallax?.texture;
        if(control&&textures.get(control)!==null&&wanted.size<wantLimit)wanted.add(control);
      }
      for(const id of foliageMaterials)wanted.add(id);
    }
    let terrainOverlays=0,objectOverlays=0;
    for(const {mesh,groundDemand,materialDemand} of ordered){
      if(bounded&&mesh.replaces&&hasStructures&&detailTextures.size>=64)continue;
      const terrain=mesh.kind==="terrain";
      for(const {id,overlay} of (ground?groundDemand:materialDemand)??[]){
        // A detailed ground cell can have dozens of overlays. Keep a separate
        // allowance so its materials don't crowd out nearby structure decals.
        if(bounded&&overlay&&(terrain?terrainOverlays>=24:objectOverlays>=24))continue;
        if(wanted.size<wantLimit&&!wanted.has(id)&&textures.get(id)!==null){
          wanted.add(id);
          if(mesh.replaces&&!ground)detailTextures.add(id);
          if(overlay){if(terrain)terrainOverlays++;else objectOverlays++;}
        }
        if(wanted.size===wantLimit)break;
        if(bounded&&mesh.replaces&&hasStructures&&detailTextures.size>=64)break;
      }
      if(wanted.size===wantLimit)break;
    }
    const requests=[...wanted].filter(id=>!id.startsWith(dynamicTerrainPrefix)&&!textures.has(id)&&!pending.has(id));
    const detailRequests=requests.filter(id=>detailTextures.has(id));
    const otherRequests=requests.filter(id=>!detailTextures.has(id));
    // Let structures and terrain make progress even when one tile has dozens of layers.
    const priority=new Set([...primary.slice(0,8),...nearestRoad,...primary.slice(8)]);
    const queue=[...priority].filter(id=>!textures.has(id)&&!pending.has(id));
    for(const id of dynamic)if(!textures.has(id))queue.push(id);
    for(let i=0;i<Math.max(detailRequests.length,otherRequests.length);i++){
      if(otherRequests[i]&&!priority.has(otherRequests[i]))queue.push(otherRequests[i]);
      if(detailRequests[i])queue.push(detailRequests[i]);
    }
    return {wanted,queue,foregroundRoad:nearestRoad};
  }

  private requestTextureSet(ground:boolean,plan:TexturePlan){
    const pending=ground?this.groundPending:this.pending;
    const parallel=ground?streetBudgets.groundReads:streetBudgets.materialReads;
    const textures=ground?this.groundTextures:this.textures;
    const compression=(id:string)=>{
      if(ground)return;
      const format=id.startsWith(roadHeightPrefix)?compressedMaterialFormats.bc1|compressedMaterialFormats.bc7:
        id.startsWith("0x")||id.startsWith(roadWeightPrefix)?compressedMaterialFormats.bc1:0;
      return (this.materialCompression&format)||undefined;
    };
    // A road needs its full material group before it can draw. Give the first
    // visible group its own admission while the region is still receiving meshes.
    if(!ground&&this.loading&&!this.foregroundRoadPending.size){
      for(const id of plan.foregroundRoad){
        if(pending.has(id)||textures.has(id))continue;
        pending.add(id);
        this.foregroundRoadPending.add(id);
        this.requestTexture(id,false,compression(id));
      }
    }
    const scheduled=()=>pending.size-(ground?0:this.foregroundRoadPending.size);
    if(scheduled()>=parallel)return;
    let dynamicPending=[...pending].some(id=>id.startsWith(dynamicTerrainPrefix));
    for(const id of plan.queue){
      if(scheduled()>=parallel)break;
      if(pending.has(id)||textures.has(id))continue;
      const dynamic=id.startsWith(dynamicTerrainPrefix);
      if(dynamic&&dynamicPending)continue;
      pending.add(id);
      dynamicPending||=dynamic;
      this.requestTexture(id,ground,compression(id));
    }
  }

  refillTextureSlots(){
    if(this.textureSelectionDirty)return;
    this.requestPlannedTextures();
  }

  private requestPlannedTextures(){
    if(this.groundPlan)this.requestTextureSet(true,this.groundPlan);
    if(this.materialPlan)this.requestTextureSet(false,this.materialPlan);
    this.requestTerrainTextures();
    this.requestCanopyTextures();
  }

  private superseded(mesh:StreetChunk){
    return mesh.kind==="terrain"&&!mesh.replaces&&this.chunks.has(`${mesh.id}:detail`);
  }

  private vertex(chunk:Chunk,index:number){
    const collision=chunk.mesh.collision;
    const vertices=collision?.vertices??chunk.mesh.vertices,at=index*(collision?3:4);
    return [vertices[at],vertices[at+1],vertices[at+2]] as const;
  }

  private upload(chunk:Chunk):Resident{
    const {gl}=this,mesh=chunk.mesh,{vertices,instances}=mesh;
    const instanceCount=instances?instances.poses.length/(instances.affine?16:9):0;
    // 0xffff is reserved for fixed primitive restart in WebGL2.
    const compact=mesh.indices.BYTES_PER_ELEMENT===2||vertices.length<=0xffff*4;
    const geometryKey=instances&&mesh.geometryKey?[mesh.geometryKey,vertices.length,mesh.indices.length,
      Number(compact),mesh.appearance?.uv.length??0,mesh.normals?.length??0].join(":"):undefined;
    let shared=geometryKey?this.sharedGeometry.get(geometryKey):undefined;
    let shadowMaterials:string[]|undefined;
    if(shadowCaster(mesh)||distantShadowCaster(mesh)){
      this.shadowRevision++;
      shadowMaterials=[...new Set(mesh.appearance?.spans.flatMap(span=>
        span.texture&&!span.overlay&&!span.water&&(span.cutout||mesh.kind==="foliage")?[span.texture]:[]))];
      const references=this.shadowMaterials??=new Map();
      for(const id of shadowMaterials)references.set(id,(references.get(id)??0)+1);
    }
    const vao=gl.createVertexArray(),vertexBuffer=shared?.vertices??gl.createBuffer(),indexBuffer=shared?.indices??gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,vertexBuffer);
    if(!shared)gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.STATIC_DRAW);
    gl.vertexAttribPointer(0,4,gl.FLOAT,false,16,0);
    gl.enableVertexAttribArray(0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indexBuffer);
    if(!shared)gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,compact&&mesh.indices.BYTES_PER_ELEMENT===4?new Uint16Array(mesh.indices):mesh.indices,gl.STATIC_DRAW);
    let uv:WebGLBuffer|undefined;
    if(chunk.mesh.appearance){
      uv=shared?.uv??gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER,uv);
      if(!shared)gl.bufferData(gl.ARRAY_BUFFER,chunk.mesh.appearance.uv,gl.STATIC_DRAW);
      gl.vertexAttribPointer(1,2,gl.FLOAT,false,8,0);
      gl.enableVertexAttribArray(1);
    }
    let normals:WebGLBuffer|undefined;
    if(chunk.mesh.normals){
      normals=shared?.normals??gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER,normals);
      if(!shared)gl.bufferData(gl.ARRAY_BUFFER,chunk.mesh.normals,gl.STATIC_DRAW);
      gl.vertexAttribPointer(6,3,gl.SHORT,true,6,0);
      gl.enableVertexAttribArray(6);
    }
    let terrainColors:WebGLBuffer|undefined;
    if(chunk.mesh.terrainColors){
      terrainColors=gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER,terrainColors);
      gl.bufferData(gl.ARRAY_BUFFER,chunk.mesh.terrainColors,gl.STATIC_DRAW);
      gl.vertexAttribPointer(11,4,gl.UNSIGNED_BYTE,true,4,0);
      gl.enableVertexAttribArray(11);
    }
    let terrainTintUV:WebGLBuffer|undefined;
    if(chunk.mesh.terrainTintUV){
      terrainTintUV=gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER,terrainTintUV);
      gl.bufferData(gl.ARRAY_BUFFER,chunk.mesh.terrainTintUV,gl.STATIC_DRAW);
      gl.vertexAttribPointer(13,2,gl.FLOAT,false,8,0);
      gl.enableVertexAttribArray(13);
    }
    let terrainTangents:WebGLBuffer|undefined;
    if(chunk.mesh.terrainTangents){
      terrainTangents=gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER,terrainTangents);
      gl.bufferData(gl.ARRAY_BUFFER,chunk.mesh.terrainTangents,gl.STATIC_DRAW);
      gl.vertexAttribPointer(12,4,gl.SHORT,true,8,0);
      gl.enableVertexAttribArray(12);
    }
    let terrainSecondaryTangents:WebGLBuffer|undefined;
    if(chunk.mesh.terrainSecondaryTangents){
      terrainSecondaryTangents=gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER,terrainSecondaryTangents);
      gl.bufferData(gl.ARRAY_BUFFER,chunk.mesh.terrainSecondaryTangents,gl.STATIC_DRAW);
      gl.vertexAttribPointer(14,4,gl.SHORT,true,8,0);
      gl.enableVertexAttribArray(14);
    }
    let roadUV:WebGLBuffer|undefined,roadWeights:WebGLBuffer|undefined;
    if(chunk.mesh.road){
      roadUV=gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER,roadUV);
      gl.bufferData(gl.ARRAY_BUFFER,chunk.mesh.road.uv,gl.STATIC_DRAW);
      gl.vertexAttribPointer(7,2,gl.FLOAT,false,8,0);
      gl.enableVertexAttribArray(7);
      roadWeights=gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER,roadWeights);
      gl.bufferData(gl.ARRAY_BUFFER,chunk.mesh.road.weights,gl.STATIC_DRAW);
      gl.vertexAttribPointer(8,4,gl.UNSIGNED_BYTE,true,4,0);
      gl.enableVertexAttribArray(8);
    }
    let decalOpacity:WebGLBuffer|undefined;
    if(chunk.mesh.decalOpacity){
      decalOpacity=gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER,decalOpacity);
      gl.bufferData(gl.ARRAY_BUFFER,chunk.mesh.decalOpacity,gl.STATIC_DRAW);
      gl.vertexAttribPointer(9,1,gl.UNSIGNED_BYTE,true,1,0);
      gl.enableVertexAttribArray(9);
    }
    let decalBlend:WebGLBuffer|undefined;
    if(chunk.mesh.decalBlend){
      decalBlend=gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER,decalBlend);
      gl.bufferData(gl.ARRAY_BUFFER,chunk.mesh.decalBlend,gl.STATIC_DRAW);
      gl.vertexAttribPointer(10,1,gl.UNSIGNED_BYTE,true,1,0);
      gl.enableVertexAttribArray(10);
    }
    let poses:WebGLBuffer|undefined,propInstances:WebGLBuffer|undefined;
    let propPalettes:Map<string,WebGLTexture>|undefined,propBytes=0,propDirtControls:true|undefined;
    const instanceExtras=instances?.affine&&(mesh.packedSlodCenter||mesh.packedVegetationTint)?true:undefined;
    if(instances){
      poses=gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER,poses);
      gl.bufferData(gl.ARRAY_BUFFER,instances.poses,gl.STATIC_DRAW);
      const attributes=instanceExtras?matrixExtraAttributes:instances.affine?matrixAttributes:rigidAttributes;
      for(const [attribute,size,offset] of attributes){
        gl.enableVertexAttribArray(attribute);
        gl.vertexAttribPointer(attribute,size,gl.FLOAT,false,instances.affine?64:36,offset);
        gl.vertexAttribDivisor(attribute,1);
      }
      const selectors=instances.tintSelectors,controls=instances.propLayerControls;
      if(!instances.affine&&selectors?.length===instanceCount&&controls?.length===instanceCount){
        const dirt=instances.propDirtControls;
        propDirtControls=dirt?.length===selectors.length?true:undefined;
        const data=new Uint8Array(selectors.length*3);
        for(let index=0;index<selectors.length;index++){
          data[index*3]=selectors[index];
          data[index*3+1]=controls[index];
          data[index*3+2]=dirt?.[index]??0;
        }
        propInstances=gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER,propInstances);
        gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);
        gl.enableVertexAttribArray(15);
        gl.vertexAttribPointer(15,3,gl.UNSIGNED_BYTE,false,3,0);
        gl.vertexAttribDivisor(15,1);
        propBytes=data.byteLength;
        propPalettes=new Map();
        gl.activeTexture(gl.TEXTURE7);
        for(const span of mesh.appearance?.spans??[]){
          const layers=span.propLayers;
          if(!layers||propPalettes.has(layers.paletteKey))continue;
          const texture=gl.createTexture();
          const pitch=Math.min(layers.palette.length/4,1024);
          const height=Math.ceil(layers.palette.length/(4*pitch));
          const image=height===1?layers.palette:new Uint8Array(pitch*height*4);
          if(height>1)image.set(layers.palette);
          gl.bindTexture(gl.TEXTURE_2D,texture);
          gl.texImage2D(gl.TEXTURE_2D,0,gl.SRGB8_ALPHA8,pitch,height,0,gl.RGBA,gl.UNSIGNED_BYTE,image);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
          propPalettes.set(layers.paletteKey,texture);
          propBytes+=image.byteLength;
        }
        gl.activeTexture(gl.TEXTURE1);
      }
    }
    if(rendererReview.opaque)registerOpaqueMesh(vao,vertices);
    const geometryBytes=vertices.byteLength+mesh.indices.length*(compact?2:4)+(mesh.appearance?.uv.byteLength??0)+(mesh.normals?.byteLength??0);
    if(geometryKey&&!shared){
      shared={key:geometryKey,vertices:vertexBuffer,indices:indexBuffer,uv,normals,
        bytes:geometryBytes,references:0,visibleFrame:-1};
      this.sharedGeometry.set(geometryKey,shared);
      this.meshBytes+=geometryBytes;
    }
    if(shared)shared.references++;
    const bytes=propBytes+(shared?0:geometryBytes)+[mesh.terrainColors,mesh.terrainTintUV,
      mesh.terrainTangents,mesh.terrainSecondaryTangents,mesh.road?.uv,mesh.road?.weights,mesh.decalOpacity,
      mesh.decalBlend,instances?.poses].reduce((sum,buffer)=>sum+(buffer?.byteLength??0),0);
    this.meshBytes+=bytes;
    return {vao,vertices:vertexBuffer,indices:indexBuffer,uv,normals,terrainColors,terrainTintUV,terrainTangents,terrainSecondaryTangents,roadUV,roadWeights,decalOpacity,decalBlend,poses,instances:instanceCount,
      instanceMode:instances?.affine?2:instances?1:0,instanceStart:0,instanceExtras,propInstances,propPalettes,propDirtControls,
      count:mesh.indices.length,indexType:compact?gl.UNSIGNED_SHORT:gl.UNSIGNED_INT,indexBytes:compact?2:4,
      frame:this.frame,bytes,shadowMaterials,shared};
  }

  private drawTriangles(gpu:Resident,first:number,count:number,ranges?:InstanceRange[]){
    const {gl}=this;
    if(this.occlusionReview){
      const selected=this.occlusionReview.filter(gpu,ranges);
      if(selected===null)return;
      ranges=selected;
    }
    if(rendererReview.opaque)chooseOpaque(gl,gpu.vao);
    const start=first*gpu.indexBytes;
    if(!gpu.instances){
      gl.drawElements(gl.TRIANGLES,count,gpu.indexType,start);
      return;
    }
    if(!ranges&&gpu.instanceStart===0){
      gl.drawElementsInstanced(gl.TRIANGLES,count,gpu.indexType,start,gpu.instances);
      return;
    }
    const affine=gpu.instanceMode===2,stride=affine?64:36;
    let posesBound=false;
    for(const range of ranges??[{first:0,count:gpu.instances}]){
      if(gpu.instanceStart!==range.first){
        if(!posesBound){gl.bindBuffer(gl.ARRAY_BUFFER,gpu.poses!);posesBound=true;}
        for(const [attribute,size,offset] of gpu.instanceExtras?matrixExtraAttributes:affine?matrixAttributes:rigidAttributes)
          gl.vertexAttribPointer(attribute,size,gl.FLOAT,false,stride,offset+stride*range.first);
        if(gpu.propInstances){
          gl.bindBuffer(gl.ARRAY_BUFFER,gpu.propInstances);
          gl.vertexAttribPointer(15,3,gl.UNSIGNED_BYTE,false,3,range.first*3);
          posesBound=false;
        }
        gpu.instanceStart=range.first;
      }
      gl.drawElementsInstanced(gl.TRIANGLES,count,gpu.indexType,start,range.count);
    }
  }

  private captureWaterBackdrop(pitch:number,fov:number,uniform:(name:string)=>WebGLUniformLocation|null){
    const {gl}=this,width=gl.drawingBufferWidth;
    const horizon=(.5-.5*Math.tan(pitch)*streetProjection(fov))*gl.drawingBufferHeight;
    // Ocean surface fragments sit below the horizon. Leave a small edge for filtering.
    const height=Math.min(gl.drawingBufferHeight,Math.max(0,Math.ceil(horizon+4)));
    this.waterBackdropSupported??=gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)>streetWaterBackdropUnit;
    if(!this.waterBackdropSupported||!width||!height)return 0;
    gl.activeTexture(gl.TEXTURE0+streetWaterBackdropUnit);
    if(!this.waterBackdrop||this.waterBackdrop.width<width||this.waterBackdrop.height<height){
      const texture=gl.createTexture();
      if(!texture){gl.activeTexture(gl.TEXTURE1);return 0;}
      const previous=this.waterBackdrop;
      const capacityX=Math.max(width,previous?.width??0),capacityY=Math.max(height,previous?.height??0);
      gl.bindTexture(gl.TEXTURE_2D,texture);
      const format=gl.getContextAttributes()?.alpha?gl.RGBA8:gl.RGB8;
      gl.texStorage2D(gl.TEXTURE_2D,1,format,capacityX,capacityY);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      if(previous)gl.deleteTexture(previous.texture);
      this.waterBackdrop={texture,width:capacityX,height:capacityY};
    }else gl.bindTexture(gl.TEXTURE_2D,this.waterBackdrop.texture);
    gl.copyTexSubImage2D(gl.TEXTURE_2D,0,0,0,0,0,width,height);
    gl.uniform1i(uniform("waterBackdrop"),streetWaterBackdropUnit);
    gl.uniform2f(uniform("waterViewport"),width,height);
    gl.activeTexture(gl.TEXTURE1);
    return height;
  }

  private beginWaterVisibility(key:string){
    const {gl}=this,pending=this.waterQuery;
    if(pending&&gl.getQueryParameter(pending.query,gl.QUERY_RESULT_AVAILABLE)){
      this.waterVisibility={key:pending.key,visible:Boolean(gl.getQueryParameter(pending.query,gl.QUERY_RESULT))};
      gl.deleteQuery(pending.query);
      this.waterQuery=undefined;
    }
    if(!key||this.waterQuery||this.waterVisibility?.key===key)return false;
    const query=gl.createQuery();
    if(!query)return false;
    this.waterQuery={key,query};
    gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE,query);
    return true;
  }

  private readonly reprojectShadow=new WeakMap<StreetChunk,boolean>();
  paintShadows(center:StreetStreamView["eye"],inside:(bounds:Bounds)=>boolean,settled:boolean,
    uniform:(name:string)=>WebGLUniformLocation|null,distant=false,
    bindFixed?:()=>typeof uniform){
    const {gl}=this,alpha=uniform("alphaLayer"),instanced=uniform("instanced");
    const vegetationRange=uniform("vegetationRange");
    let canopyRange=0;
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.activeTexture(gl.TEXTURE1);
    if(settled&&!this.loading){
      const start=performance.now();
      let extraCount=0,extraBytes=0;
      for(const gpu of this.cache.values())if(gpu.shadowOnly){extraCount++;extraBytes+=gpu.bytes;}
      const nearby=extraCount<24&&extraBytes<12*1024*1024?[...this.chunks.values()].filter(chunk=>{
        const {mesh,bounds}=chunk;
        return mesh.kind==="structure"&&shadowCaster(mesh)&&!this.cache.has(chunk)&&
          bounds[5]-bounds[2]>5&&mesh.vertices.byteLength*3+mesh.indices.byteLength<2*1024*1024&&inside(bounds);
      }).sort((a,b)=>streetDistance(a.bounds,center)-streetDistance(b.bounds,center)):[];
      // A building can cast into view even when its own camera bounds are outside.
      for(const chunk of nearby.slice(0,Math.min(4,24-extraCount))){
        const gpu=this.upload(chunk);
        gpu.shadowOnly=true;
        this.cache.set(chunk,gpu);
        extraBytes+=gpu.bytes;
        if(extraBytes>=12*1024*1024||performance.now()-start>1.5)break;
      }
    }
    let instanceMode=0,lastMask:WebGLTexture|null=null,masked=false;
    let defer=false,currentRange=0;
    const ordinary:{gpu:Resident;first:number;count:number;mask:WebGLTexture|null;ranges?:InstanceRange[];fade:number}[]=[];
    const draw=(gpu:Resident,first:number,count:number,mask:WebGLTexture|null,ranges?:InstanceRange[])=>{
      if(defer){ordinary.push({gpu,first,count,mask,ranges,fade:currentRange});return;}
      if(masked!==Boolean(mask)){
        masked=Boolean(mask);
        gl.uniform1i(alpha,masked?2:0);
      }
      if(mask&&mask!==lastMask){gl.bindTexture(gl.TEXTURE_2D,mask);lastMask=mask;}
      this.drawTriangles(gpu,first,count,ranges);
    };
    for(const [chunk,gpu] of this.cache){
      const {mesh,bounds}=chunk;
      if(!(distant?distantShadowCaster(mesh):shadowCaster(mesh))||!inside(bounds))continue;
      if(mesh.kind==="prop"&&this.visibilityPlan?.replacements.get(chunk)?.some(candidate=>this.cache.has(candidate)))continue;
      let ranges:InstanceRange[]|undefined;
      if(chunk.tiles){
        ranges=[];
        for(const {bounds,first,count} of chunk.tiles){
          if(!inside(bounds))continue;
          const previous=ranges.at(-1);
          if(previous&&previous.first+previous.count===first)previous.count+=count;
          else ranges.push({first,count});
        }
        if(!ranges.length)continue;
        if(ranges.length===1&&ranges[0].count===gpu.instances)ranges=undefined;
      }
      if(bindFixed){
        let reproject=this.reprojectShadow.get(mesh);
        if(reproject===undefined){
          reproject=false;
          for(let i=3;i<mesh.vertices.length;i+=4)if(mesh.vertices[i]===nativeCanopyMaterial){reproject=true;break;}
          this.reprojectShadow.set(mesh,reproject);
        }
        defer=!reproject;
      }
      const range=canopyShadowCaster(mesh)||mesh.vegetationFadeStart!==undefined?mesh.vegetation??0:0;
      currentRange=range;
      if(!defer){
        gl.bindVertexArray(gpu.vao);
        if(range!==canopyRange){
          gl.uniform3f(vegetationRange,range,range,0);
          canopyRange=range;
        }
        if(instanceMode!==gpu.instanceMode){
          instanceMode=gpu.instanceMode;
          gl.uniform1i(instanced,instanceMode);
        }
      }
      const spans=mesh.appearance?.spans;
      if(!spans){
        if(mesh.kind!=="foliage")draw(gpu,0,gpu.count,null,ranges);
        continue;
      }
      let first=0,count=0;
      for(const span of spans){
        if(span.overlay||span.water)continue;
        if(span.cutout||mesh.kind==="foliage"&&!span.vertexPalette){
          if(count){draw(gpu,first,count,null,ranges);count=0;}
          const texture=span.texture&&(this.canopyTextures.get(span.texture)??this.textures.get(span.texture));
          if(texture)draw(gpu,span.first,span.count,texture,ranges);
        }else{
          if(count&&first+count!==span.first){draw(gpu,first,count,null,ranges);count=0;}
          if(!count)first=span.first;
          count+=span.count;
        }
      }
      if(count)draw(gpu,first,count,null,ranges);
    }
    gl.uniform1i(alpha,0);
    gl.uniform1i(instanced,0);
    if(canopyRange)gl.uniform3f(vegetationRange,0,0,0);
    if(bindFixed&&ordinary.length){
      const locations=bindFixed();
      const alpha=locations("alphaLayer"),instanced=locations("instanced"),vegetation=locations("vegetationRange");
      let mode=-1,range=-1,cutout:WebGLTexture|null|undefined,vao:WebGLVertexArrayObject|undefined;
      for(const {gpu,first,count,mask,ranges,fade} of ordinary){
        if(vao!==gpu.vao){vao=gpu.vao;gl.bindVertexArray(vao);}
        if(mode!==gpu.instanceMode){mode=gpu.instanceMode;gl.uniform1i(instanced,mode);}
        if(range!==fade){range=fade;gl.uniform3f(vegetation,range,range,0);}
        if(cutout!==mask){
          if(cutout===undefined||Boolean(cutout)!==Boolean(mask))gl.uniform1i(alpha,mask?2:0);
          cutout=mask;
          if(mask)gl.bindTexture(gl.TEXTURE_2D,mask);
        }
        this.drawTriangles(gpu,first,count,ranges);
      }
    }
  }

  private paintWaterReflection(camera:StreetStreamView,plane:number,visible:Chunk[],uniform:(name:string)=>WebGLUniformLocation|null){
    const {gl}=this;
    const inView=streetFrustum(camera,1.12);
    const candidates=visible.filter(({mesh,bounds})=>bounds[5]>plane+.1&&
      (mesh.kind==="structure"||mesh.kind==="skyline"||mesh.kind==="road"&&bounds[5]>plane+2)&&
      inView([bounds[0],bounds[1],2*plane-bounds[5],bounds[3],bounds[4],2*plane-Math.max(plane,bounds[2])],580))
      .sort((a,b)=>a.drawDistance-b.drawDistance);
    let remainingIndices=780000,remainingDraws=220;
    let lastTexture:WebGLTexture|null=null,masked=false;
    gl.uniform1i(uniform("instanced"),0);
    gl.uniform1i(uniform("useMaterial"),0);
    gl.uniform1i(uniform("alphaLayer"),0);
    for(const chunk of candidates){
      const gpu=this.cache.get(chunk);
      if(!gpu||gpu.frame!==this.frame||gpu.instances)continue;
      const spans=chunk.mesh.appearance?.spans;
      if(!spans?.length)continue;
      gl.bindVertexArray(gpu.vao);
      for(const span of spans){
        if(span.overlay||span.water||span.terrain||span.count>remainingIndices)continue;
        const texture=span.texture?this.textures.get(span.texture)??null:null;
        if(span.cutout&&!texture)continue;
        if(texture!==lastTexture){
          if(texture)gl.bindTexture(gl.TEXTURE_2D,texture);
          if(Boolean(texture)!==Boolean(lastTexture))gl.uniform1i(uniform("useMaterial"),Number(Boolean(texture)));
          lastTexture=texture;
        }
        if(masked!==Boolean(span.cutout)){
          masked=Boolean(span.cutout);
          gl.uniform1i(uniform("alphaLayer"),masked?2:0);
        }
        this.drawTriangles(gpu,span.first,span.count);
        remainingIndices-=span.count;
        if(--remainingDraws<=0)return;
      }
    }
  }

  private buildAttachedLodFamilies(){
    const attached=new Map<string,Chunk|null>(),bridgeIds=new Map<string,Chunk|null>();
    for(const chunk of this.chunks.values()){
      const {mesh}=chunk,lod=mesh.placementLod;
      if(!lod)continue;
      const key=`${lod.map}:${lod.ordinal}`;
      attached.set(key,attached.has(key)?null:chunk);
      if(!mesh.instances&&lod.distance&&roadBridgeDrawable(mesh.modelName??""))
        bridgeIds.set(key,bridgeIds.has(key)?null:chunk);
    }
    const skyline=new Map<Chunk,Chunk[]>(),bridges=new Map<Chunk,Chunk[]>();
    for(const [ids,families] of [[attached,skyline],[bridgeIds,bridges]] as const){
      for(const child of ids.values()){
        const link=child?.mesh.placementLod;
        if(!child||!link?.parent)continue;
        const parent=ids.get(link.parent.join(":")),parentLink=parent?.mesh.placementLod;
        if(!parent||!parentLink?.children||link.level>=parentLink.level)continue;
        if(families===skyline&&(child.mesh.kind!=="skyline"||parentLink.children<=1))continue;
        const siblings=families.get(parent);
        if(siblings)siblings.push(child);
        else families.set(parent,[child]);
      }
    }
    return {skyline,bridges};
  }

  private visibleChunks(camera:StreetStreamView,inView:ReturnType<typeof streetFrustum>,hasStencil:boolean):VisibilityPlan{
    const prior=this.visibilityPlan,{eye:[x,y,z],yaw,pitch,aspect,fov}=camera;
    if(prior&&prior.flightTerrain===this.flightTerrain&&prior.camera.yaw===yaw&&prior.camera.pitch===pitch&&
      prior.camera.aspect===aspect&&prior.camera.fov===fov&&prior.camera.farPlane===camera.farPlane&&
      prior.camera.eye[0]===x&&prior.camera.eye[1]===y&&prior.camera.eye[2]===z)return prior;
    const visible:Chunk[]=[],fallbackTerrain=new Set<Chunk>(),aggregateFallback=new Set<Chunk>();
    const indexedDetailCells=new Set<string>();
    const instanceRanges=new Map<Chunk,InstanceRange[]>();
    const packedInView=streetFrustum(camera,1,camera.farPlane);
    const interiorRooms=new Map<string,ReturnType<typeof visibleInteriorRooms>>();
    const interiorCamera=new Map<string,InteriorCamera>();
    const indoorRooms:(IndoorFoliageRoom|undefined)[]=[];
    const clipsByMembership=new Map<string,Float32Array|undefined>(),interiorClips=new Map<Chunk,Float32Array>();
    const worldCamera={...camera,eye:[x+this.origin[0],y+this.origin[1],z+this.origin[2]] as const};
    for(const cell of this.visibilityCells?.values()??[]){
      cell.visible=inView(cell.bounds,cell.horizon);
      cell.contained=cell.visible&&inView.contains(cell.bounds);
    }
    for(const collection of [this.chunks,this.navigation])for(const chunk of collection.values()){
      const {mesh}=chunk;
      const scene=mesh.interior?.scene;
      if(scene&&!interiorCamera.has(scene.id))
        interiorCamera.set(scene.id,trackInteriorCamera(scene,worldCamera.eye,this.interiorCamera.get(scene.id)));
      const cell=chunk.visibilityCell;
      if(chunk.mesh.kind==="collision"||cell&&!cell.visible)continue;
      const [left,bottom,,right,top]=chunk.bounds;
      const lodDistance=mesh.placementLod?.distance;
      if(mesh.kind==="skyline"&&mesh.drawDistance===aerialSkylineRadius&&lodDistance&&
        !streetLodInRange(chunk.bounds,camera.eye,lodDistance))continue;
      const districtProxy=hasStencil&&mesh.kind==="skyline"&&(mesh.aggregate||districtAggregate.test(mesh.modelName??""));
      if(!districtProxy&&mesh.kind==="skyline"&&left>x-streetHorizon&&right<x+streetHorizon&&
        bottom>y-streetHorizon&&top<y+streetHorizon&&
        !(mesh.placementLod?.distance&&roadBridgeDrawable(mesh.modelName??"")))continue;
      // Authored multi-child SLODs include campus and terminal shells whose
      // names do not follow the district convention. Near the camera they
      // fill gaps in coverage behind the same stencil as district proxies.
      const authoredShell=hasStencil&&mesh.kind==="skyline"&&mesh.placementLod&&
        mesh.placementLod.level>=2&&mesh.placementLod.children>1&&
        streetDistance(chunk.bounds,camera.eye)<streetHorizon**2;
      const radius=mesh.vegetation??mesh.drawDistance;
      const horizon=mesh.kind==="terrain"&&!mesh.overview&&!this.flightTerrain?streetHorizon:meshHorizon(mesh);
      if(cell?.contained){
        if(left>x+horizon||right<x-horizon||bottom>y+horizon||top<y-horizon)continue;
      }else if(!inView(chunk.bounds,horizon))continue;
      if(mesh.interior){
        const {scene,rooms}=mesh.interior;
        let selected=interiorRooms.get(scene.id);
        if(!selected){
          const tracked=interiorCamera.get(scene.id);
          selected=visibleInteriorRooms(scene,worldCamera,tracked?.rooms);
          interiorRooms.set(scene.id,selected);
          if(tracked?.rooms.length&&!tracked.rooms.includes(0))
            indoorRooms.push(isInsideAuthoredInterior(scene,worldCamera.eye,tracked.rooms)
              ?indoorFoliageRoom(scene,selected.get(0)??[],this.origin):undefined);
        }
        const screen=streetScreenBounds(chunk.bounds,camera);
        const openings=(rooms.length?rooms:[...selected.keys()].filter(room=>room!==0)).flatMap(room=>selected.get(room)??[]);
        if(!openings.some(opening=>!screen||interiorApertureIntersects(opening,screen)))continue;
        const key=`${scene.id}:${rooms.join(",")}`;
        if(!clipsByMembership.has(key))clipsByMembership.set(key,packInteriorClip(openings));
        const clip=clipsByMembership.get(key);
        if(clip)interiorClips.set(chunk,clip);
      }
      const rigidProp=mesh.kind==="prop"&&!mesh.instances?.affine;
      if(chunk.tiles&&(!rigidProp||!cell?.contained&&!inView.contains(chunk.bounds))){
        const ranges:InstanceRange[]=[];
        const tileInView=mesh.packedSlodCenter?packedInView:inView;
        // Rigid props keep the batch's distance and LOD policy. Their
        // tighter bounds only discard instances outside the view.
        for(const tile of chunk.tiles){
          if(!tileInView(tile.bounds,rigidProp?Infinity:horizon)||!rigidProp&&radius!==undefined&&
            vegetationDistance(x,y,tile.bounds[0],tile.bounds[1],tile.bounds[3],tile.bounds[4])>radius)continue;
          const prior=ranges.at(-1);
          if(prior&&prior.first+prior.count===tile.first)prior.count+=tile.count;
          else ranges.push({first:tile.first,count:tile.count});
        }
        if(!ranges.length&&!rigidProp)continue;
        instanceRanges.set(chunk,ranges);
      }
      if(mesh.indexedTerrain&&mesh.replaces)indexedDetailCells.add(mesh.replaces);
      else if(mesh.indexedTerrain||this.superseded(mesh))fallbackTerrain.add(chunk);
      if(hasStencil&&mesh.kind==="skyline"&&terrainSectorLod.test(mesh.modelName??""))fallbackTerrain.add(chunk);
      if(districtProxy||authoredShell)aggregateFallback.add(chunk);
      chunk.drawDistance=streetDistance(chunk.bounds,camera.eye);
      visible.push(chunk);
    }
    if(indexedDetailCells.size)for(const chunk of visible){
      const mesh=chunk.mesh;
      if(mesh.kind==="terrain"&&!mesh.indexedTerrain&&indexedDetailCells.has(mesh.replaces??mesh.id))
        fallbackTerrain.add(chunk);
    }
    const variants=new Map<string,Chunk[]>();
    for(const chunk of visible)if(chunk.lod?.rank)variants.set(chunk.lod.name,[]);
    for(const chunk of visible)if(chunk.lod)variants.get(chunk.lod.name)?.push(chunk);
    const replacements=new Map<Chunk,Chunk[]>();
    for(const group of variants.values())for(const coarse of group){
      if(!coarse.lod?.rank)continue;
      const better=group.filter(candidate=>{
        if(candidate.lod!.rank>=coarse.lod!.rank||candidate.mesh.kind!==coarse.mesh.kind)return false;
        if(!coarse.mesh.instances&&!candidate.mesh.instances)
          return sameStreetLodPlacement(coarse.mesh.origin,candidate.mesh.origin,coarse.bounds,candidate.bounds);
        if(!coarse.mesh.instances||!candidate.mesh.instances||candidate.mesh.indices.length<=coarse.mesh.indices.length)return false;
        const sameBounds=coarse.bounds.every((value,i)=>Math.abs(value-candidate.bounds[i])<=.8);
        return sameBounds&&sameStreetPropBatch(coarse.mesh.instances.poses,candidate.mesh.instances.poses);
      });
      if(better.length)replacements.set(coarse,better);
    }
    // A cloned prefab can have an authored parent but no link to the
    // instanced detail draw. Its name and pivot identify the same placement.
    const clonedPrefabs=new Map<string,Chunk[]>();
    for(const chunk of visible){
      const {modelName,placementLod}=chunk.mesh;
      if(!modelName||placementLod?.children!==1)continue;
      const name=clonedPrefabName(modelName);
      if(!name)continue;
      const clones=clonedPrefabs.get(name);
      if(clones)clones.push(chunk);
      else clonedPrefabs.set(name,[chunk]);
    }
    for(const detail of visible){
      const {mesh}=detail,instances=mesh.instances;
      if(mesh.kind!=="prop"||!instances||instances.affine||!mesh.modelName)continue;
      const clones=clonedPrefabs.get(mesh.modelName);
      if(!clones)continue;
      const ranges=instanceRanges.get(detail)??[{first:0,count:instances.poses.length/9}];
      for(const clone of clones){
        const [px,py,pz]=clone.mesh.origin.map((value,axis)=>value-this.origin[axis]);
        const matched=ranges.some(({first,count})=>{
          for(let i=first;i<first+count;i++){
            const at=i*9;
            if(Math.hypot(instances.poses[at]-px,instances.poses[at+1]-py,instances.poses[at+2]-pz)<.025)return true;
          }
          return false;
        });
        if(matched)replacements.set(clone,[detail]);
      }
    }
    const placementIds=new Map<string,Chunk|null>();
    for(const chunk of visible){
      const link=chunk.mesh.placementLod;
      if(!link)continue;
      const key=`${link.map}:${link.ordinal}`;
      placementIds.set(key,placementIds.has(key)?null:chunk);
    }
    for(const child of placementIds.values()){
      const link=child?.mesh.placementLod;
      if(!link?.parent||link.level===5)continue;
      const parent=placementIds.get(link.parent.join(":"));
      const parentLink=parent?.mesh.placementLod;
      // A multi-child parent may still cover unresolved pieces. Suppress only
      // an unambiguous single-child replacement in the same draw category.
      if(child&&parent&&parentLink?.children===1&&link.level<parentLink.level&&child.mesh.kind===parent.mesh.kind)
        replacements.set(parent,[child]);
    }
    const skylineChildren=new Map<Chunk,Chunk[]>();
    const skylineCoverage:VisibilityPlan["skylineCoverage"]=new Map();
    const visibleSet=new Set(visible);
    const families=this.attachedLodFamilies??=this.buildAttachedLodFamilies();
    if(aggregateFallback.size){
      // Off-screen siblings may be attached. Include their identities when
      // proving completeness, but require a draw only for selected children.
      const incomplete:Chunk[]=[];
      const parents=new Map<Chunk,Chunk>();
      for(const [parent,children] of families.skyline){
        if(!aggregateFallback.has(parent))continue;
        const needed=children.filter(child=>visibleSet.has(child));
        const expected=parent.mesh.placementLod!.children;
        if(children.length<=expected)for(const child of needed)parents.set(child,parent);
        if(children.length!==expected||!needed.length||
          children.some(child=>!visibleSet.has(child)&&inView(child.bounds,Infinity))){
          if(needed.length&&children.length<=expected)incomplete.push(parent);
        }else skylineChildren.set(parent,needed);
      }
      incomplete.sort((a,b)=>comparePriority(a.drawDistance,b.drawDistance)||compareKeys(a.mesh.id,b.mesh.id));
      if(incomplete.length<=skylineCoverageBits.length){
        for(const [i,parent] of incomplete.entries())skylineCoverage.set(parent,{read:skylineCoverageBits[i],write:0});
      }else{
        // Include every descendant that could write a branch's bit, even if
        // its geometry extends beyond the parent mesh.
        const footprints=new Map(incomplete.map(parent=>[parent,[...parent.bounds] as Bounds]));
        for(const child of parents.keys())for(let parent=parents.get(child);parent;parent=parents.get(parent)){
          const footprint=footprints.get(parent);
          if(!footprint)continue;
          for(let axis=0;axis<3;axis++){
            footprint[axis]=Math.min(footprint[axis],child.bounds[axis]);
            footprint[axis+3]=Math.max(footprint[axis+3],child.bounds[axis+3]);
          }
        }
        type ScreenBounds=NonNullable<ReturnType<typeof streetScreenBounds>>;
        const lanes=skylineCoverageBits.map(bit=>({bit,boxes:[] as (ScreenBounds|undefined)[]}));
        for(const parent of incomplete){
          const box=streetScreenBounds(footprints.get(parent)!,camera);
          // A small NDC gap keeps floating-point and edge rasterization from
          // turning adjacent bounding rectangles into shared samples.
          const gap=.002;
          const lane=lanes.find(({boxes})=>boxes.every(other=>box&&other&&
            (box[2]+gap<other[0]||other[2]+gap<box[0]||box[3]+gap<other[1]||other[3]+gap<box[1])));
          if(!lane)continue;
          lane.boxes.push(box);
          skylineCoverage.set(parent,{read:lane.bit,write:0});
        }
      }
      if(skylineCoverage.size)for(const child of parents.keys()){
        let write=0;
        for(let parent=parents.get(child);parent;parent=parents.get(parent))
          write|=skylineCoverage.get(parent)?.read??0;
        if(write)skylineCoverage.set(child,{read:skylineCoverage.get(child)?.read??0,write});
      }
    }
    const canopyParents=new Map<string,Chunk|null>(),pairedCanopyChildren=new Set<Chunk>();
    for(const chunk of visible){
      const lod=chunk.mesh.vegetationLod;
      if(lod?.fallback)canopyParents.set(lod.key,canopyParents.has(lod.key)?null:chunk);
    }
    for(const child of visible){
      const lod=child.mesh.vegetationLod;
      if(!lod?.parent)continue;
      const parent=canopyParents.get(lod.parent),ranges=instanceRanges.get(child);
      const parentLod=parent?.mesh.vegetationLod;
      if(!parent||!parentLod||lod.level>=parentLod.level)continue;
      if(parentLod.instanceSlots){
        if(lod.parentIndices!==undefined||lod.parentInstance!==undefined&&lod.parentInstance>=0)
          replacements.set(parent,[...(replacements.get(parent)??[]),child]);
        continue;
      }
      if(lod.parentInstance!==-1||parentLod.count!==lod.count)continue;
      // Equal authored transforms let the whole-batch link hand off individual
      // ordinals while the remaining instances still need the fallback.
      // Placement transforms are fixed once a chunk is installed. A new
      // chunk identity invalidates this comparison on either side.
      let matches=this.canopyTransformMatches.get(child);
      if(!matches){
        matches=new WeakMap();
        this.canopyTransformMatches.set(child,matches);
      }
      let paired=matches.get(parent);
      if(paired===undefined){
        paired=sameVegetationAffinesByOrdinal(parent.mesh.instances,child.mesh.instances,lod.count);
        matches.set(parent,paired);
      }
      if(paired){
        pairedCanopyChildren.add(child);
        replacements.set(parent,[...(replacements.get(parent)??[]),child]);
        continue;
      }
      if(ranges?.length!==1||ranges[0].first!==0||ranges[0].count!==lod.count)continue;
      const [left,bottom,low,right,top,high]=child.bounds;
      const fullCoverage=child.mesh.vegetationFadeStart??child.mesh.vegetation??0;
      if(Math.hypot(Math.max(Math.abs(left-x),Math.abs(right-x)),
        Math.max(Math.abs(bottom-y),Math.abs(top-y)),Math.max(Math.abs(low-z),Math.abs(high-z)))<=fullCoverage){
        // Conflicting links leave the fallback in place.
        replacements.set(parent,[...(replacements.get(parent)??[]),child]);
      }
    }
    const bridgeFallbacks=new Map<Chunk,Chunk>(),bridgeParents=new Set<Chunk>();
    for(const [parent,children] of families.bridges){
      if(!visibleSet.has(parent))continue;
      bridgeParents.add(parent);
      const lod=parent.mesh.placementLod!;
      replacements.delete(parent);
      const selected:Chunk[]=[];
      for(const child of children){
        if(!visibleSet.has(child))continue;
        if(streetLodInRange(child.bounds,camera.eye,child.mesh.placementLod!.distance!))selected.push(child);
        else if(streetLodInRange(parent.bounds,camera.eye,lod.distance!))bridgeFallbacks.set(child,parent);
      }
      if(children.length===lod.children&&selected.length)replacements.set(parent,selected);
    }
    this.interiorCamera=interiorCamera;
    const indoorFoliage=indoorRooms.length===1?indoorRooms[0]:undefined;
    return this.visibilityPlan={camera,indoorFoliage,flightTerrain:this.flightTerrain,visible,fallbackTerrain,aggregateFallback,
      instanceRanges,replacements,bridgeFallbacks,bridgeParents,skylineChildren,skylineCoverage,pairedCanopyChildren,interiorClips};
  }

  replayWater(width:number,height:number,program:WebGLProgram){
    const snapshot=this.waterFrame;
    if(!snapshot||!this.frameSnapshot?.restore(width,height,snapshot.depth,program))return null;
    return snapshot.draw();
  }

  paint(camera:StreetStreamView,moving:boolean,lighting:StreetLighting|undefined,
    useMaterial:WebGLUniformLocation|null,alphaLayer:WebGLUniformLocation|null,groundAtlas:WebGLUniformLocation|null,
    instanced:WebGLUniformLocation|null,uniform:(name:string)=>WebGLUniformLocation|null,program:WebGLProgram,
    allowWaterReplay:boolean,drawSky?:()=>void,redraw?:()=>void){
    this.waterFrame=undefined;
    this.frame++;
    const {eye,aspect,yaw,pitch,fov=defaultStreetFov}=camera,[x,y,z]=eye,inView=streetFrustum(camera);
    const {gl}=this;
    gl.activeTexture(gl.TEXTURE1);
    const canopySampleCoverage=this.canopySampleCoverage??=gl.getParameter(gl.SAMPLES)>1;
    gl.uniform1i(uniform("canopySampleCoverage"),Number(canopySampleCoverage));
    let draws=0,uploads=0,textured=0,groundDraws=0,detailDraws=0,navigationDraws=0,roadDraws=0,roadDecals=0,terrainDraws=0,vegetationDraws=0;
    let last:WebGLTexture|null=null;
    let normalTexture:WebGLTexture|undefined;
    let normalStrength:number|undefined;
    const bumpiness=uniform("detailNormalBumpiness");
    const useDetailNormal=(normal?:WebGLTexture,strength?:number)=>{
      if(normalStrength!==strength){
        normalStrength=strength;
        gl.uniform2f(bumpiness,Number(strength!==undefined),strength??1);
      }
      if(normalTexture!==normal){
        normalTexture=normal;
        gl.uniform1i(uniform("hasDetailNormal"),Number(Boolean(normal)));
        if(normal){
          gl.activeTexture(gl.TEXTURE12);
          gl.bindTexture(gl.TEXTURE_2D,normal);
          gl.activeTexture(gl.TEXTURE1);
        }
      }
    };
    let projection:Chunk|null=null;
    let cutout=false;
    let drawBatch=0;
    const vegetationRange=uniform("vegetationRange");
    const packedSlodUniform=uniform("packedSlodCenter");
    let packedSlodCenter:StreetChunk["packedSlodCenter"];
    let fadeStart=0,fadeEnd=0,linearFade=0;
    const cropChildRange=uniform("cropChildRange");
    let cropFadeStart=0,cropFadeEnd=0;
    const hasStencil=Boolean(gl.getContextAttributes()?.stencil);
    const visibility=this.visibleChunks(camera,inView,hasStencil);
    let portalClip:Float32Array|undefined,clipScaleSet=false;
    const useInteriorClip=(edges?:Float32Array)=>{
      if(portalClip===edges)return;
      portalClip=edges;
      if(edges){
        if(!clipScaleSet){
          gl.uniform2f(uniform("interiorClipScale"),2/gl.drawingBufferWidth,2/gl.drawingBufferHeight);
          clipScaleSet=true;
        }
        gl.uniform4fv(uniform("interiorClipEdges[0]"),edges);
      }
      gl.uniform1i(uniform("interiorClipEdgeCount"),(edges?.length??0)/4);
    };
    // Keep draw order independent of visibility order. Texture priority and
    // prefab matching use the same enumeration on every repaint.
    const {fallbackTerrain,aggregateFallback,replacements,bridgeFallbacks,bridgeParents,skylineChildren,skylineCoverage,pairedCanopyChildren}=visibility;
    const visible=visibility.visible.filter(chunk=>{
      const parent=bridgeFallbacks.get(chunk);
      return !parent||!this.cache.has(parent);
    });
    let instanceRanges=visibility.instanceRanges;
    const room=visibility.indoorFoliage;
    // A streamed or moving shell can expose areas beyond authored apertures.
    // Wait for its structural draws to be resident before pruning foliage.
    const roomReady=room&&this.interiorComplete&&!this.loading&&
      this.rollerOutsideView(camera)&&
      visible.some(chunk=>chunk.mesh.interior?.scene.id===room.scene.id&&chunk.mesh.kind==="structure")&&
      !visible.some(chunk=>chunk.mesh.interior?.scene.id===room.scene.id&&chunk.mesh.kind==="structure"&&!this.cache.has(chunk));
    const hiddenFoliage=roomReady?hiddenExteriorFoliage(room,camera,gl.drawingBufferWidth,gl.drawingBufferHeight):undefined;
    const propState=uniform("propLayerState");
    const parallaxMarch=uniform("propParallaxMarch");
    const staticLayerState=uniform("staticLayerState");
    const staticLayerDirt=uniform("staticLayerDirt");
    const staticDetailUniforms=[uniform("staticDetail0"),uniform("staticDetail1")];
    const roomState=this.roomTexturesSupported?uniform("roomState"):null;
    const roomHasProjection=roomState?uniform("roomHasProjection"):null;
    const roomDensity=roomState?uniform("roomDensity"):null,roomAbsorption=roomState?uniform("roomAbsorption"):null;
    const readyPropMaterial=(gpu:Resident,authored:PropMaterialLayers)=>{
      if(authored.dirt&&!gpu.propDirtControls)return;
      const palette=gpu.propPalettes?.get(authored.paletteKey);
      if(!palette)return;
      const layers=propLayerTextures(authored).map(id=>this.terrainTextures.get(id));
      if(layers.every(layer=>layer!==undefined))
        return {palette,layers,width:authored.palette.length/4,reciprocal:1/Math.max(.001,authored.weightPower**2),
          parallax:authored.parallax?.march};
    };
    const bindPropMaterial=({palette,layers,width,reciprocal,parallax}:NonNullable<ReturnType<typeof readyPropMaterial>>)=>{
      for(const [index,texture] of layers.entries()){
        gl.activeTexture(gl.TEXTURE0+(index<5?index+2:index+3));
        gl.bindTexture(gl.TEXTURE_2D,texture);
      }
      gl.activeTexture(gl.TEXTURE7);
      gl.bindTexture(gl.TEXTURE_2D,palette);
      gl.activeTexture(gl.TEXTURE1);
      gl.uniform2f(propState,width,reciprocal);
      if(parallax)gl.uniform4f(parallaxMarch,...parallax);
    };
    type Overlay={gpu:Resident;first:number;count:number;texture:WebGLTexture;road:boolean;groundOnly:boolean;frontOnly?:boolean;
      clip?:Float32Array;
      layers?:[WebGLTexture,WebGLTexture?];retroBlend?:number;tintMasks?:[WebGLTexture,WebGLTexture];ranges?:InstanceRange[];
      tintMask?:WebGLTexture;surfaceBlend?:{control:WebGLTexture;dirt:WebGLTexture;reciprocal:number};
      propMaterial?:ReturnType<typeof readyPropMaterial>};
    const overlays:Overlay[]=[],waterOverlays:Overlay[]=[];
    const water:{gpu:Resident;first:number;count:number;ranges?:InstanceRange[];ocean:boolean;clip?:Float32Array}[]=[];
    let animateWater=false;
    const queueWater=(chunk:Chunk,gpu:Resident,first:number,count:number,ranges?:InstanceRange[])=>{
      water.push({gpu,first,count,ranges,ocean:chunk.mesh.id.startsWith("ocean:"),clip:visibility.interiorClips.get(chunk)});
      if(chunk.drawDistance<240**2)animateWater=true;
    };
    const fills:{gpu:Resident;chunk:Chunk;first:number;count:number;texture:WebGLTexture|null}[]=[];
    const coveredOverviewCells=new Map<string,number>();
    const childNames=new Set(visible.flatMap(({lodParent})=>lodParent?[lodParent]:[]));
    const fallbackParents=new Map<string,Chunk[]>();
    const readyParents=new Set<Chunk>(), fallbackAtlases=new Set<string>();
    if(childNames.size){
      const candidates=visible.filter(chunk=>aggregateFallback.has(chunk)&&childNames.has(chunk.mesh.modelName??"")&&
        streetDistance(chunk.bounds,eye)<streetHorizon**2)
        .sort((a,b)=>comparePriority(streetDistance(a.bounds,eye),streetDistance(b.bounds,eye))||compareKeys(a.mesh.id,b.mesh.id));
      for(const parent of candidates){
        const keys=parent.mesh.appearance?.spans.flatMap(span=>span.texture&&!span.overlay?[span.texture]:[])??[];
        if(!keys.length)continue;
        // Keep the priority slots tied to the authored keys. A failed key
        // is already recorded in the texture cache and won't be requested again.
        for(const id of keys)if(fallbackAtlases.size<16)fallbackAtlases.add(id);
        if(!keys.every(id=>this.textures.get(id)))continue;
        readyParents.add(parent);
        const name=parent.mesh.modelName!;
        const group=fallbackParents.get(name)??[];
        group.push(parent);
        fallbackParents.set(name,group);
      }
    }
    const coveredClones=new Set<Chunk>(),prefabClones=new Map<string,Array<StreetChunk["origin"]>>();
    for(const chunk of visible){
      const {lodParent,bounds:[left,bottom,low,right,top,high],mesh}=chunk;
      if(!lodParent||!/_lod_cln$/i.test(mesh.modelName??""))continue;
      if(!fallbackParents.get(lodParent)?.some(({bounds:b})=>
        left>=b[0]-.5&&bottom>=b[1]-.5&&low>=b[2]-.5&&right<=b[3]+.5&&top<=b[4]+.5&&high<=b[5]+.5))continue;
      coveredClones.add(chunk);
      const name=clonedPrefabName(mesh.modelName!);
      if(!name)continue;
      const positions=prefabClones.get(name)??[];
      positions.push(mesh.origin);
      prefabClones.set(name,positions);
    }
    const coveredPrefabs=new Set<Chunk>();
    if(prefabClones.size)for(const chunk of visible){
      const {mesh}=chunk,instances=mesh.instances;
      if(mesh.kind!=="prop"||!instances||instances.affine)continue;
      const name=mesh.modelName??mesh.id.split(":",3)[1];
      const clones=prefabClones.get(name);
      if(!clones)continue;
      const ranges:InstanceRange[]=[];
      const candidates=instanceRanges.get(chunk)??[{first:0,count:instances.poses.length/9}];
      let suppressed=false;
      for(const {first,count} of candidates)for(let i=first;i<first+count;i++){
        const at=i*9;
        if(clones.some(origin=>Math.hypot(instances.poses[at]+this.origin[0]-origin[0],
          instances.poses[at+1]+this.origin[1]-origin[1],instances.poses[at+2]+this.origin[2]-origin[2])<.025)){
          suppressed=true;continue;
        }
        const prior=ranges.at(-1);
        if(prior&&prior.first+prior.count===i)prior.count++;
        else ranges.push({first:i,count:1});
      }
      if(!ranges.length)coveredPrefabs.add(chunk);
      else if(suppressed){
        if(instanceRanges===visibility.instanceRanges)instanceRanges=new Map(instanceRanges);
        instanceRanges.set(chunk,ranges);
      }
    }
    const time=performance.now(),previous=this.textureView;
    const changed=previous&&(x!==previous.x||y!==previous.y||z!==previous.z||yaw!==previous.yaw||pitch!==previous.pitch);
    if(previous&&fov!==previous.fov)this.textureSelectionDirty=true;
    if(previous&&(readyParents.size!==previous.readyParents.size||
      [...readyParents].some(parent=>!previous.readyParents.has(parent))))this.textureSelectionDirty=true;
    // Camera culling runs every frame. Streaming priority can follow on a
    // slower cadence while completed downloads refill the current queues.
    // Small continuous FOV changes share the streaming cadence. The
    // padded frustum covers them while the latest priority plan is pending.
    if(!previous||aspect!==previous.aspect||Math.abs(fov-previous.fov)>2||
      (previous.x-x)**2+(previous.y-y)**2+(previous.z-z)**2>64||
      Math.abs(previous.yaw-yaw)+Math.abs(previous.pitch-pitch)>.35||
      time-previous.time>=100&&(changed||this.textureSelectionDirty)){
      const preload=streetFrustum(camera,1.18);
      const approaching=[...this.chunks.values()].filter(({mesh,bounds})=>
        (mesh.kind==="structure"||mesh.kind==="prop")&&!inView(bounds)&&preload(bounds));
      this.prepareTextures([...visible.filter(chunk=>(chunk.mesh.vegetationLod?.fallback||!replacements.has(chunk))&&
        !coveredClones.has(chunk)&&!coveredPrefabs.has(chunk)),
        ...approaching],camera,preload,[...fallbackAtlases]);
      this.textureView={x,y,z,yaw,pitch,aspect,fov,time,readyParents};
      this.textureSelectionDirty=false;
    }
    this.requestPlannedTextures();
    // Give visible ground and the closest foreground materials a refinement
    // slot while the remaining region and skyline are still streaming.
    for(const id of this.closeWanted){
      const ground=this.closeGroundWanted.has(id),road=id.startsWith(roadSurfacePrefix);
      if(!ground&&!this.closeForegroundWanted.has(id)&&(this.loading||this.pending.size>=2))break;
      if(this.closeTextures.has(id)||this.closeRequested.has(id)||!this.textures.get(id))continue;
      // Allow the four authored layers of a road to refine together.
      if(this.closeRequested.size>=(road?4:1))break;
      this.closeRequested.add(id);
      // Projected roads sample the coarsest mip as their color reference.
      // Generate the complete chain from the larger authored color image.
      this.requestTexture(closeMaterialPrefix+id,ground,road?this.roadColorCompression:ground?0:this.materialCompression);
    }
    const reviewCoarse=rendererReview.lod?new Set<Chunk>():undefined;
    if(reviewCoarse){
      for(const [parent,children] of replacements){
        if(children.length!==1||!parent.mesh.vegetationLod?.fallback||
          !this.cache.has(parent)||coveredClones.has(parent)||coveredPrefabs.has(parent))continue;
        const child=children[0];
        if(!pairedCanopyChildren.has(child)||parent.mesh.indices.length>=child.mesh.indices.length||
          streetDistance(child.bounds,eye)<64**2)continue;
        const ranges=instanceRanges.get(parent),placements=parent.mesh.instances?.ordinals?.length;
        if(!placements||ranges&&(ranges.length!==1||ranges[0].first!==0||ranges[0].count!==placements))continue;
        const [left,bottom,low,right,top,high]=parent.bounds;
        const fullOpacity=parent.mesh.vegetationFadeStart??parent.mesh.vegetation??0;
        if(Math.hypot(Math.max(Math.abs(left-x),Math.abs(right-x)),Math.max(Math.abs(bottom-y),Math.abs(top-y)),
          Math.max(Math.abs(low-z),Math.abs(high-z)))>fullOpacity)continue;
        const spans=parent.mesh.appearance?.spans;
        if(!spans?.length||spans.some(span=>span.overlay||span.water||span.fallback||
          (!span.vertexPalette||span.cutout)&&(!span.texture||!(span.texture.startsWith(canopyAtlasPrefix)?
            this.canopyTextures.get(span.texture):this.closeTextures.get(span.texture)||this.textures.get(span.texture)))))continue;
        const box=streetScreenBounds(child.bounds,camera);
        const coarseBox=streetScreenBounds(parent.bounds,camera);
        if(!box||!coarseBox)continue;
        const width=(Math.max(box[2],coarseBox[2])-Math.min(box[0],coarseBox[0]))*gl.drawingBufferWidth*.5;
        const height=(Math.max(box[3],coarseBox[3])-Math.min(box[1],coarseBox[1]))*gl.drawingBufferHeight*.5;
        if(Math.max(width,height)<=24)reviewCoarse.add(child);
      }
    }
    const runOcclusion=(rendererReview.occlusion||rendererReview.foliageOcclusion)&&!reviewCoarse?.size;
    const canSampleOcclusion=runOcclusion&&!moving&&!this.loading&&!this.pendingBoxes.size&&
      !visibility.indoorFoliage&&![...this.rollerMotion.values()].some(state=>state.fraction!==0||state.to!==0);
    if(runOcclusion)this.occlusionReview??=new StreetOcclusionReview(gl);
    if(this.occlusionReview){
      if(this.occlusionLighting!==lighting){this.occlusionLighting=lighting;this.occlusionRevision++;}
      const foliage=rendererReview.occlusion?undefined:new Set<Resident>();
      if(foliage&&canSampleOcclusion)for(const chunk of visible){
        const gpu=chunk.mesh.kind==="foliage"&&this.cache.get(chunk);
        if(gpu)foliage.add(gpu);
      }
      this.occlusionReview.begin(camera,this.occlusionRevision+this.shadowRevision,canSampleOcclusion,foliage);
    }
    if(rendererReview.opaque)beginOpaque(gl);
    // Upload replacements before spending the per-frame budget on other meshes.
    for(const chunk of visible){
      const {mesh}=chunk,replaced=replacements.has(chunk);
      const lateSkyline=skylineChildren.has(chunk)||Boolean(skylineCoverage.get(chunk)?.read);
      const pass=mesh.overview?6:lateSkyline?5:mesh.kind==="skyline"?(readyParents.has(chunk)?3:4):mesh.indexedTerrain?(mesh.replaces?-1:3):
        replaced?2:Number(fallbackTerrain.has(chunk));
      chunk.drawOrder=2*pass+Number(!mesh.replaces);
      chunk.drawRank=replaced||lateSkyline?(mesh.vegetationLod?.level??mesh.placementLod?.level??chunk.lod?.rank??0):0;
    }
    visible.sort((a,b)=>a.drawOrder-b.drawOrder||a.drawRank-b.drawRank||a.drawDistance-b.drawDistance);
    const stencil=hasStencil&&(aggregateFallback.size>0||fallbackTerrain.size>0||visible.some(({mesh})=>
      mesh.kind==="terrain"||mesh.kind==="water"||mesh.appearance?.spans.some(span=>span.water)));
    if(stencil){
      gl.stencilMask(0xff);
      gl.clear(gl.STENCIL_BUFFER_BIT);
    }
    let skyline=false,stencilSurface=-1,stencilFallback=false,stencilLod=false,settling=false,culling=false;
    let stencilRead=0,stencilWrite=0;
    let foliageLighting=false;
    const useFoliageLighting=(enabled:boolean)=>{
      if(foliageLighting===enabled)return;
      foliageLighting=enabled;
      gl.uniform1i(uniform("foliageLighting"),Number(enabled));
    };
    const cullBackFaces=(enabled:boolean)=>{
      if(culling===enabled)return;
      culling=enabled;
      if(enabled)gl.enable(gl.CULL_FACE);
      else gl.disable(gl.CULL_FACE);
    };
    let uploadTime=0,visibleCount=0,visibleBytes=0;
    const replacedBridges=new Set<Chunk>();
    const bridgesCoveredThisFrame=new Set<Chunk>();
    const drawableSkyline=new Set<Chunk>();
    const drawableCanopy=new Map<Chunk,{missing:Set<string>;ranges:InstanceRange[]}>();
    for(const chunk of visible){
      if(reviewCoarse?.has(chunk))continue;
      const lodFill=readyParents.has(chunk);
      const [left,bottom,,right,top]=chunk.bounds;
      const parents=chunk.lodParent&&fallbackParents.get(chunk.lodParent);
      // Authored cloned LOD parts can cover the same surface as their parent
      // with slightly different depth. Keep one representation once the
      // complete parent atlas is ready and covers the cloned part.
      if(coveredClones.has(chunk)||coveredPrefabs.has(chunk))continue;
      const fallbackBridge=bridgeFallbacks.get(chunk);
      const bridgeParent=fallbackBridge?.mesh.placementLod?.children===1?fallbackBridge:undefined;
      if(bridgeParent&&(this.cache.get(bridgeParent)?.frame===this.frame||replacedBridges.has(bridgeParent)))continue;
      const parentReady=parents&&parents.some(({bounds:b})=>
        left<=b[3]&&right>=b[0]&&bottom<=b[4]&&top>=b[1]);
      const children=replacements.get(chunk);
      let cropStart=0,cropEnd=0;
      let ranges=instanceRanges.get(chunk);
      if(ranges?.length===0)continue;
      if(skylineChildren.get(chunk)?.every(child=>drawableSkyline.has(child))){
        drawableSkyline.add(chunk);
        continue;
      }
      if(bridgeParents.has(chunk)){
        if(children?.every(detail=>this.cache.get(detail)?.frame===this.frame||replacedBridges.has(detail))){
          replacedBridges.add(chunk);
          continue;
        }
      }else if(chunk.mesh.vegetationLod?.fallback){
        // A coarse preview can use the same materials as the detail mesh.
        // A missing shared texture gives the preview no additional coverage.
        const ready=(child:Chunk)=>{
          const detail=drawableCanopy.get(child);
          return detail&&[...detail.missing].every(id=>chunk.mesh.appearance?.spans.some(span=>
            !span.overlay&&!span.ground&&!span.fallback&&span.texture===id))?detail:undefined;
        };
        const paired=children?.length===1&&pairedCanopyChildren.has(children[0]);
        if((chunk.mesh.vegetationLod.instanceSlots||paired)&&ranges&&children?.length&&chunk.mesh.instances?.ordinals){
          const covered=new Set<number>();
          let allCovered=false;
          for(const child of children){
            const detail=ready(child),lod=child.mesh.vegetationLod!,instances=child.mesh.instances;
            if(!detail||!instances?.affine||!instances.ordinals)continue;
            const indices=lod.parentIndices;
            if(indices?.length&&indices.length!==lod.count)continue;
            const threshold=child.mesh.vegetationFadeStart??child.mesh.vegetation??0;
            if(paired&&chunk.mesh.cropCanopy&&!detail.missing.size&&child.mesh.vegetationFadeStart!==undefined){
              cropStart=threshold;
              cropEnd=child.mesh.vegetation??0;
            }
            let fullyDrawn=0;
            for(const {first,count} of detail.ranges)for(let index=first;index<first+count;index++){
              const at=index*16;
              if(Math.hypot(instances.poses[at]-x,instances.poses[at+1]-y,instances.poses[at+2]-z)>threshold)continue;
              fullyDrawn++;
              const ordinal=instances.ordinals[index];
              const selected=paired?ordinal:indices?.[ordinal];
              if(selected!==undefined&&selected>=0)covered.add(selected);
            }
            if(!paired&&fullyDrawn===lod.count){
              if(indices?.length===0)allCovered=true;
              else if(!indices&&lod.parentInstance!==undefined)covered.add(lod.parentInstance);
            }
          }
          if(allCovered)continue;
          if(covered.size){
            ranges=uncoveredVegetationRanges(ranges,chunk.mesh.instances.ordinals,covered);
            if(!ranges.length)continue;
          }
        }else if(!paired&&!chunk.mesh.vegetationLod.instanceSlots&&children?.length===1&&ready(children[0]))continue;
      }else if(children?.some(detail=>this.cache.get(detail)?.frame===this.frame))continue;
      const ground=chunk.mesh.kind==="terrain";
      const foliage=chunk.mesh.kind==="foliage";
      const fallback=fallbackTerrain.has(chunk);
      if((fallback||chunk.mesh.overview)&&!stencil)continue;
      let gpu=this.cache.get(chunk);
      if(!gpu){
        if(uploads>=streetBudgets.uploadCount||uploads&&uploadTime>=streetBudgets.uploadMilliseconds){
          settling=true;continue;
        }
        const started=performance.now();
        gpu=this.upload(chunk);this.cache.set(chunk,gpu);uploads++;
        uploadTime+=performance.now()-started;
      }
      if(bridgesCoveredThisFrame.has(chunk)){
        // The child already drew while this fallback was uploading. Switch
        // on the next frame, when the fallback is resident at selection time.
        replacedBridges.add(chunk);
        settling=true;
        continue;
      }
      if(bridgeParent)bridgesCoveredThisFrame.add(bridgeParent);
      gpu.frame=this.frame;
      gpu.shadowOnly=undefined;
      visibleCount++;visibleBytes+=gpu.bytes;
      if(gpu.shared&&gpu.shared.visibleFrame!==this.frame){
        gpu.shared.visibleFrame=this.frame;
        visibleBytes+=gpu.shared.bytes;
      }
      if(chunk.mesh.overview){
        fills.push({gpu,chunk,first:0,count:gpu.count,texture:null});
        continue;
      }
      if(chunk.mesh.kind==="water"&&!chunk.mesh.appearance?.spans.some(span=>span.overlay)){
        queueWater(chunk,gpu,0,gpu.count,ranges);
        draws++;
        continue;
      }
      // Foliage occludes by depth. Building receivers keep priority over district proxies.
      const interiorClip=visibility.interiorClips.get(chunk);
      useInteriorClip(interiorClip);
      const surface=foliage||chunk.mesh.kind==="navigation"?0:
        lodFill?objectReceiver:aggregateFallback.has(chunk)?aggregateReceiver:ground||fallback?terrainReceiver:
        chunk.mesh.kind==="road"?groundReceiver:objectReceiver;
      const coverage=skylineCoverage.get(chunk),read=coverage?.read??0,write=coverage?.write??0;
      if(stencil&&(surface!==stencilSurface||fallback!==stencilFallback||lodFill!==stencilLod||
        read!==stencilRead||write!==stencilWrite)){
        stencilSurface=surface;stencilFallback=fallback;stencilLod=lodFill;
        stencilRead=read;stencilWrite=write;
        if(surface){
          gl.enable(gl.STENCIL_TEST);
          if(lodFill){
            // Attachment meshes can sit behind the parent shell. A stencil
            // bit only records coverage; depth decides which shell is visible.
            gl.stencilMask(surfaceReceiver|write);
            gl.stencilFunc(read?gl.EQUAL:gl.ALWAYS,objectReceiver|write,read);
          }else if(surface===aggregateReceiver){
            // A district proxy can contain surfaces with no detailed drawable.
            // Keep these visible while giving any loaded building priority.
            gl.stencilMask(aggregateReceiver|write);
            gl.stencilFunc(gl.EQUAL,aggregateReceiver|write,objectReceiver|read);
          }else{
            gl.stencilMask((surface&terrainCoverage?surfaceStencil:surfaceReceiver)|write);
            gl.stencilFunc(fallback?gl.NOTEQUAL:gl.ALWAYS,surface|write,terrainCoverage);
          }
          gl.stencilOp(gl.KEEP,gl.KEEP,gl.REPLACE);
        }else gl.disable(gl.STENCIL_TEST);
      }
      const offsetSkyline=chunk.mesh.kind==="skyline"&&!lodFill;
      if(offsetSkyline!==skyline){
        skyline=offsetSkyline;
        if(skyline){
          gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(2,2);
        }else gl.disable(gl.POLYGON_OFFSET_FILL);
      }
      gl.bindVertexArray(gpu.vao);
      useFoliageLighting(foliage&&this.lightingMaterials);
      if(packedSlodCenter!==chunk.mesh.packedSlodCenter){
        packedSlodCenter=chunk.mesh.packedSlodCenter;
        if(packedSlodCenter)gl.uniform4f(packedSlodUniform,...packedSlodCenter,1);
        else gl.uniform4f(packedSlodUniform,0,0,0,0);
      }
      const from=chunk.mesh.vegetationFadeStart??0;
      const to=chunk.mesh.vegetationFadeStart===undefined?0:chunk.mesh.vegetation??0;
      const linear=Number(Boolean(chunk.mesh.vegetationLinearFade));
      if(from!==fadeStart||to!==fadeEnd||linear!==linearFade){
        gl.uniform3f(vegetationRange,from,to,linear);
        fadeStart=from;fadeEnd=to;linearFade=linear;
      }
      if(cropStart!==cropFadeStart||cropEnd!==cropFadeEnd){
        gl.uniform2f(cropChildRange,cropStart,cropEnd);
        cropFadeStart=cropStart;cropFadeEnd=cropEnd;
      }
      if(drawBatch!==gpu.instanceMode){
        drawBatch=gpu.instanceMode;
        gl.uniform1i(instanced,drawBatch);
      }
      if(chunk.mesh.kind==="navigation"){
        useDetailNormal();
        if(rendererReview.opaque)chooseOpaque(gl,gpu.vao);
        gl.drawElements(gl.LINES,gpu.count,gpu.indexType,0);
        navigationDraws++;
        continue;
      }
      const colorRanges=hiddenFoliage&&foliage&&gpu.instances&&!chunk.mesh.interior&&!chunk.mesh.packedSlodCenter&&
        !chunk.mesh.vegetationLod?.fallback&&!chunk.mesh.appearance?.spans.some(span=>span.texture?.startsWith(nativeCanopyAtlasPrefix))
        ?visibleIndoorFoliage(ranges,chunk.tiles,chunk.bounds,gpu.instances,hiddenFoliage):ranges;
      const priorVegetationDraws=vegetationDraws;
      const missingCanopyMaterials=chunk.mesh.vegetationLod?.parent?new Set<string>():undefined;
      const coverSamples=canopySampleCoverage&&foliage&&
        chunk.mesh.appearance?.spans[0]?.texture?.startsWith(nativeCanopyAtlasPrefix);
      // A nearby coarse exterior shell is a fallback for views from
      // outside. Its reverse faces must not enclose a camera inside it.
      const insideProxy=aggregateFallback.has(chunk)&&!gpu.instances&&
        eye.every((value,axis)=>value>=chunk.bounds[axis]&&value<=chunk.bounds[axis+3]);
      let drawnOpaque=false,missingCoverage=false;
      const draw=(first:number,count:number,texture:WebGLTexture|null,projected=false,masked=false,singleSided=false,
        bump?:WebGLTexture|false,vertexPalette=false,bumpStrength?:number)=>{
        const alphaMasked=masked||foliage&&!vertexPalette;
        if(!count)return;
        if(alphaMasked&&!texture){missingCoverage=true;return;}
        // Ordinary vegetation meshes also contain opaque bark and branch materials.
        if(masked&&foliage&&texture&&chunk.mesh.vegetation===undefined&&!this.alphaTextures.has(texture))return;
        if(cutout!==alphaMasked){
          cutout=alphaMasked;
          gl.uniform1i(alphaLayer,cutout?2:0);
        }
        const next=projected?chunk:null;
        if(projection!==next){
          const [ox,oy]=chunk.mesh.origin;
          gl.uniform3f(groundAtlas,ox-this.origin[0],oy-this.origin[1],Number(projected));
          projection=next;
        }
        if(last!==texture){
          if(Boolean(last)!==Boolean(texture))gl.uniform1i(useMaterial,Number(Boolean(texture)));
          if(texture)gl.bindTexture(gl.TEXTURE_2D,texture);
          last=texture;
        }
        useDetailNormal(bump===false?undefined:bump??(texture&&gpu.terrainTangents?this.detailNormals.get(texture):undefined),bumpStrength);
        cullBackFaces(insideProxy||singleSided&&!gpu.instanceMode);
        if(coverSamples)gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
        this.drawTriangles(gpu,first,count,colorRanges);
        drawnOpaque=true;
        if(coverSamples)gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
        if(chunk.mesh.vegetation!==undefined)vegetationDraws+=colorRanges?.length??1;
        if(texture){
          if(ground)groundDraws++;
          else textured++;
        }
      };
      const spans=chunk.mesh.appearance?.spans;
      if(!spans)draw(0,gpu.count,null);
      else{
        let first=0,count=0,current:WebGLTexture|null=null,projected=false,masked=false,singleSided=false;
        let currentBump:WebGLTexture|undefined;
        let currentBumpStrength:number|undefined;
        const flush=()=>{
          draw(first,count,current,projected,masked,singleSided,currentBump,false,currentBumpStrength);
          count=0;
        };
        // A contained cell encloses its member chunks, so its plane test
        // also proves containment for the individual chunk.
        const cullSpans=chunk.spanBounds&&(spans.length<4||!chunk.visibilityCell?.contained&&!inView.contains(chunk.bounds));
        for(let spanIndex=0;spanIndex<spans.length;spanIndex++){
          const span=spans[spanIndex];
          const spanBounds=cullSpans&&chunk.spanBounds?.[spanIndex];
          if(spanBounds&&!inView(spanBounds,Infinity)){
            flush();
            continue;
          }
          if(span.vertexPalette){
            flush();
            draw(span.first,span.count,null,false,false,false,undefined,true);
            continue;
          }
          if(span.water){
            flush();
            queueWater(chunk,gpu,span.first,span.count,ranges);
            continue;
          }
          if(span.terrain){
            const layers=span.terrain.textures.map(id=>this.terrainTextures.get(id));
            const tint=span.terrain.tint,tintTexture=tint&&this.terrainTextures.get(tint.texture);
            const atlas=span.terrain.projectedDetail&&span.fallback&&this.groundTextures.get(span.fallback);
            if((!span.terrain.projectedDetail||atlas)&&layers.every(layer=>layer)&&(!(span.terrain.vertexWeightUV||span.terrain.nativeLocalBlend)||!tint||tintTexture)){
              flush();
              useDetailNormal();
              const vertexWeightUV=span.terrain.vertexWeightUV;
              for(const [i,layer] of layers.entries()){
                gl.activeTexture(gl.TEXTURE2+i+Number(Boolean(vertexWeightUV)));
                gl.bindTexture(gl.TEXTURE_2D,layer!);
              }
              gl.activeTexture(gl.TEXTURE1);
              gl.uniform1i(uniform("terrainEnabled"),1);
              gl.uniform1i(uniform("terrainProjectedDetail"),Number(Boolean(atlas)));
              gl.uniform1i(uniform("terrainHasHeightLayers"),Number(layers.length===(vertexWeightUV?8:9)));
              const nativeBlend=Boolean(span.terrain.nativeLocalBlend);
              gl.uniform1i(uniform("terrainNativeLocalBlend"),Number(nativeBlend));
              if(this.terrainDetailSupported){
                const detail=span.terrain.detail;
                const maps=detail?.textures.map(id=>this.terrainTextures.get(id));
                const ready=Boolean(detail&&maps?.every(Boolean));
                gl.uniform1i(uniform("terrainLocalDetail"),Number(ready));
                if(ready&&detail&&maps){
                  for(const [lane,map] of maps.entries()){
                    gl.activeTexture(gl.TEXTURE0+terrainDetailUnits[lane]);
                    gl.bindTexture(gl.TEXTURE_2D,map!);
                  }
                  gl.activeTexture(gl.TEXTURE1);
                  gl.uniform4f(uniform("terrainDetailU"),...detail.u);
                  gl.uniform4f(uniform("terrainDetailV"),...detail.v);
                  gl.uniform4f(uniform("terrainDetailStrength"),...detail.strength);
                }
              }
              const wrapMask=nativeBlend&&span.terrain.maskUV===3;
              if(wrapMask){
                if(!this.wrappingTerrainMask){
                  this.wrappingTerrainMask=gl.createSampler();
                  gl.samplerParameteri(this.wrappingTerrainMask,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
                  gl.samplerParameteri(this.wrappingTerrainMask,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
                }
                gl.bindSampler(2,this.wrappingTerrainMask);
              }
              gl.uniform1i(uniform("terrainUsesVertexWeights"),vertexWeightUV?1:0);
              gl.uniform1i(uniform("terrainBlendsVertexWeights"),span.terrain.vertexBlend?1:0);
              gl.uniform1i(uniform("terrainMaskUV3"),span.terrain.maskUV===3?1:0);
              gl.uniform4f(uniform("terrainSecondaryLayers"),...(vertexWeightUV??span.terrain.layerUV??[0,0,0,0]));
              gl.uniform4f(uniform("roadPrimary"),...span.terrain.primary);
              gl.uniform4f(uniform("roadPowers"),...span.terrain.powers);
              gl.uniform4f(uniform("terrainHeightGain"),...span.terrain.heightGain);
              gl.uniform4f(uniform("terrainHeightBias"),...span.terrain.heightBias);
              const normal=span.terrain.normals;
              const normalMaps=gpu.terrainTangents&&normal?.textures.map((id,i)=>
                normal.strength[i]>0?this.terrainTextures.get(id):undefined);
              const hasNormalMaps=Boolean(normalMaps&&normalMaps.some(Boolean));
              gl.uniform1i(uniform("terrainHasNormals"),hasNormalMaps?1:0);
              if(hasNormalMaps&&normal&&normalMaps){
                for(const [i,map] of normalMaps.entries()){
                  if(!map)continue;
                  gl.activeTexture(gl.TEXTURE12+i);
                  gl.bindTexture(gl.TEXTURE_2D,map);
                }
                gl.activeTexture(gl.TEXTURE1);
                gl.uniform4iv(uniform("terrainNormalAvailable"),normalMaps.map(map=>map?1:0));
                gl.uniform4f(uniform("terrainNormalStrength"),...normal.strength);
              }
              const vertexTint=span.terrain.vertexTint;
              gl.uniform1i(uniform("terrainHasVertexTint"),vertexTint&&gpu.terrainColors?1:0);
              if(vertexTint&&gpu.terrainColors){
                gl.uniform1i(uniform("terrainVertexTintBeforeSector"),vertexTint.beforeSector?1:0);
                gl.uniform1i(uniform("terrainVertexTintUsesAlpha"),vertexTint.maskAlpha?1:0);
                gl.uniform4f(uniform("terrainVertexTintInvertAlpha"),...vertexTint.invertAlpha);
                gl.uniform4f(uniform("terrainVertexTintMode"),...vertexTint.mode);
                gl.uniform4f(uniform("terrainVertexTintScale"),...vertexTint.scale);
                gl.uniform4f(uniform("terrainVertexTintAmount"),...vertexTint.amount);
              }
              gl.uniform1i(uniform("terrainHasTint"),tintTexture?1:0);
              if(tint&&tintTexture){
                gl.activeTexture(gl.TEXTURE11);
                gl.bindTexture(gl.TEXTURE_2D,tintTexture);
                gl.activeTexture(gl.TEXTURE1);
                gl.uniform1i(uniform("terrainTintUVMode"),tint.uv??1);
                gl.uniform1i(uniform("terrainTintInset"),tint.inset?1:0);
                gl.uniform1i(uniform("terrainTintUsesAlpha"),tint.maskAlpha?1:0);
                gl.uniform4f(uniform("terrainTintMode"),...tint.mode);
                gl.uniform4f(uniform("terrainTintScale"),...tint.scale);
                gl.uniform4f(uniform("terrainTintAmount"),...tint.amount);
              }
              if(atlas)draw(span.first,span.count,atlas,true,false,Boolean(span.singleSided),false);
              else{
                cullBackFaces(Boolean(span.singleSided)&&!gpu.instanceMode);
                this.drawTriangles(gpu,span.first,span.count,ranges);
              }
              if(wrapMask)gl.bindSampler(2,null);
              gl.uniform1i(uniform("terrainEnabled"),0);
              terrainDraws++;
              continue;
            }
          }
          if(span.road&&gpu.roadWeights&&!span.overlay){
            const road=span.road;
            const layers=road.textures.slice(road.vertexOnly?0:1).map(id=>this.closeTextures.get(id)??this.textures.get(id));
            const mask=road.vertexOnly?undefined:this.textures.get(road.textures[0]);
            const heights=road.height?.textures.map(id=>id?this.textures.get(id):null);
            const authoredLocal=Boolean(road.localVertexColor&&gpu.terrainColors&&(road.vertexOnly||mask)&&heights?.every(Boolean));
            const projected=road.useProjectedColor&&!authoredLocal;
            const atlas=projected&&span.fallback?this.groundTextures.get(span.fallback):undefined;
            const height=road.localVertexColor&&!authoredLocal?undefined:road.height;
            const tint=road.tint,tintTexture=tint&&this.textures.get(tint.texture);
            if(layers.every(layer=>layer)&&(road.vertexOnly||mask||atlas)&&(!projected||atlas)&&
              (!tint||tint.surfaceAlpha||tintTexture)&&(!height||height.textures.every((id,i)=>!id||heights?.[i]))){
              flush();
              useDetailNormal();
              if(mask){
                gl.activeTexture(gl.TEXTURE2);
                gl.bindTexture(gl.TEXTURE_2D,mask);
              }
              for(const [i,layer] of layers.entries()){
                gl.activeTexture(gl.TEXTURE3+i);
                gl.bindTexture(gl.TEXTURE_2D,layer!);
              }
              const [red,green,blue,residual]=layers.map(texture=>this.roadColorLuminance.get(texture!)??-1);
              gl.uniform4f(uniform("roadColorReference"),red,green,blue,residual);
              if(height&&heights){
                for(const [i,map] of heights.entries()){
                  gl.activeTexture(gl.TEXTURE7+i);
                  gl.bindTexture(gl.TEXTURE_2D,map??layers.at(-1)!);
                }
                gl.uniform4f(uniform("terrainHeightGain"),...height.gain);
                gl.uniform4f(uniform("terrainHeightBias"),...height.cutoff);
                const [red,green,blue,residual]=heights.map(map=>Number(Boolean(map&&this.compressedRoadHeights.has(map))));
                gl.uniform4f(uniform("roadHeightChannels"),red,green,blue,residual);
              }
              if(tint&&tintTexture){
                gl.activeTexture(gl.TEXTURE11);
                gl.bindTexture(gl.TEXTURE_2D,tintTexture);
                gl.uniform4f(uniform("terrainTintScale"),...tint.scale);
                gl.uniform4f(uniform("terrainTintAmount"),...tint.amount);
                if(tint.vertexAmount)gl.uniform4f(uniform("roadVertexTintAmount"),...tint.vertexAmount);
              }
              const parallax=authoredLocal&&road.parallax;
              const control=parallax&&gpu.normals&&gpu.terrainSecondaryTangents&&gpu.decalOpacity&&this.textures.get(parallax.texture);
              if(parallax&&control){
                // This road variant does not use the sector tint sampler.
                gl.activeTexture(gl.TEXTURE11);
                gl.bindTexture(gl.TEXTURE_2D,control);
                gl.uniform2f(uniform("roadControlOrigin"),parallax.origin[0]-this.origin[0],parallax.origin[1]-this.origin[1]);
                gl.uniform4f(uniform("roadParallaxStrength"),...parallax.strength);
                gl.uniform4f(uniform("roadParallaxCenter"),...parallax.center);
                gl.uniform4f(uniform("roadParallaxRefine"),...parallax.refine);
                gl.uniform1i(uniform("roadHasParallax"),1);
              }
              const detail=road.detail;
              const detailMaps=detail?.textures.map(id=>this.terrainTextures.get(id));
              const hasDetail=Boolean((!road.localVertexColor||authoredLocal)&&detailMaps?.every(map=>map!==undefined));
              if(detail&&detailMaps&&hasDetail){
                // The road pass borrows the terrain-normal units for its color detail.
                for(const [i,map] of detailMaps.entries()){
                  gl.activeTexture(gl.TEXTURE12+i);
                  gl.bindTexture(gl.TEXTURE_2D,map!);
                }
                gl.uniform4f(uniform("roadDetailU"),...detail.u);
                gl.uniform4f(uniform("roadDetailV"),...detail.v);
                gl.uniform4f(uniform("roadDetailStrength"),...detail.strength);
              }
              gl.activeTexture(gl.TEXTURE1);
              if(atlas){
                const [ox,oy]=chunk.mesh.origin;
                gl.uniform3f(groundAtlas,ox-this.origin[0],oy-this.origin[1],1);
                projection=chunk;
                if(last!==atlas)gl.bindTexture(gl.TEXTURE_2D,atlas);
                if(!last)gl.uniform1i(useMaterial,1);
                last=atlas;
              }
              gl.uniform1i(uniform("roadEnabled"),1);
              gl.uniform1i(uniform("roadVertexOnly"),mask?0:1);
              gl.uniform1i(uniform("roadMaskUV3"),road.maskUV===3?1:0);
              gl.uniform1f(uniform("roadProjectedDetail"),atlas?road.vertexOnly||mask?1:-1:0);
              gl.uniform1i(uniform("roadUsesHeight"),height?1:0);
              gl.uniform1i(uniform("roadAuthoredHeight"),height?.authored?1:0);
              gl.uniform1i(uniform("terrainHasTint"),tintTexture&&!tint?.surfaceAlpha?1:0);
              gl.uniform1i(uniform("roadSurfaceTint"),tintTexture&&tint?.vertexAmount?1:0);
              gl.uniform1i(uniform("roadLocalVertexColor"),authoredLocal?1:0);
              gl.uniform1i(uniform("roadHasDetail"),hasDetail?1:0);
              gl.uniform4f(uniform("roadPrimary"),...span.road.primary);
              gl.uniform4f(uniform("roadSecondary"),...span.road.secondary);
              gl.uniform4f(uniform("roadPrimaryLayers"),...(span.road.primaryLayers??[1,0,0,0]));
              gl.uniform4f(uniform("roadPowers"),...span.road.powers);
              cullBackFaces(Boolean(span.singleSided)&&!gpu.instanceMode);
              this.drawTriangles(gpu,span.first,span.count,ranges);
              if(control)gl.uniform1i(uniform("roadHasParallax"),0);
              gl.uniform1i(uniform("roadEnabled"),0);
              textured++;roadDraws++;
              continue;
            }
          }
          const textures=(span.ground??ground)?this.groundTextures:this.textures;
          const primary=span.texture?(span.texture.startsWith(canopyAtlasPrefix)?this.canopyTextures.get(span.texture):
            (!(span.ground??ground)&&!span.overlay?this.closeTextures.get(span.texture):undefined)??textures.get(span.texture))??null:null;
          if(roomState&&span.room&&!span.overlay){
            const cube=this.terrainTextures.get(streetInteriorCubePrefix+span.room.colorCube);
            const projection=this.terrainTextures.get(terrainTexturePrefix+"diffuse:"+span.room.projected);
            // The authored room cube can stand on its own while the
            // projected layer is loading or unavailable.
            if(cube){
              flush();
              gl.activeTexture(gl.TEXTURE0+streetRoomCubeUnit);
              gl.bindTexture(gl.TEXTURE_CUBE_MAP,cube);
              gl.uniform1i(roomHasProjection,Number(Boolean(projection)));
              if(projection){
                gl.activeTexture(gl.TEXTURE2);
                gl.bindTexture(gl.TEXTURE_2D,projection);
              }
              const glass=span.room.glass;
              const layers=glass&&roomGlassTextures(glass).map(id=>this.terrainTextures.get(id));
              if(glass&&layers?.every(layer=>layer!==undefined)){
                for(const [index,map] of layers.entries()){
                  gl.activeTexture(gl.TEXTURE3+index);
                  gl.bindTexture(gl.TEXTURE_2D,map);
                }
                gl.uniform3f(roomDensity,...glass.density);
                gl.uniform4f(roomAbsorption,...glass.absorption);
              }
              gl.activeTexture(gl.TEXTURE1);
              gl.uniform4f(roomState,...span.room.parameters);
              draw(span.first,span.count,primary,false,false,Boolean(span.singleSided));
              gl.uniform4f(roomState,0,0,0,0);
              gl.uniform4f(roomAbsorption,0,0,0,0);
              continue;
            }
          }
          if(span.staticLayers&&!span.overlay){
            const authored=span.staticLayers,ids=staticLayerTextures(authored);
            const layers=ids.map(id=>this.terrainTextures.get(id));
            if(layers.every(layer=>layer!==undefined)){
              flush();
              for(const [index,texture] of layers.entries()){
                gl.activeTexture(gl.TEXTURE2+index);
                gl.bindTexture(gl.TEXTURE_2D,texture);
              }
              for(const [index,location] of staticDetailUniforms.entries()){
                const detail=authored.detail?.[index];
                const slice=detail?this.materialMaskSlices.get(ids[index+2]):undefined;
                const texture=slice!=null?this.terrainTextures.get(detailAtlasSlicePrefix+slice):undefined;
                const noise=detail?.[3]?this.terrainTextures.get(streetBlueNoiseId):undefined;
                if(detail&&texture&&(!detail[3]||noise)){
                  gl.activeTexture(gl.TEXTURE7+index);
                  gl.bindTexture(gl.TEXTURE_2D,texture);
                  if(noise){
                    gl.activeTexture(gl.TEXTURE11);
                    gl.bindTexture(gl.TEXTURE_2D,noise);
                  }
                  gl.uniform4f(location,...detail);
                }else gl.uniform4f(location,0,0,0,0);
              }
              const dirt=authored.dirt&&gpu.decalOpacity&&this.terrainTextures.get(authoredDiffusePrefix+authored.dirt);
              if(dirt){
                gl.activeTexture(gl.TEXTURE9);
                gl.bindTexture(gl.TEXTURE_2D,dirt);
              }
              gl.uniform1i(staticLayerDirt,Number(Boolean(dirt)));
              gl.activeTexture(gl.TEXTURE1);
              gl.uniform2f(staticLayerState,1/Math.max(.001,authored.weightPower**2),authored.layerControl);
              draw(span.first,span.count,primary,false,Boolean(span.cutout),Boolean(span.singleSided));
              gl.uniform2f(staticLayerState,0,0);
              continue;
            }
          }
          if(span.propLayers&&gpu.propPalettes&&!span.overlay){
            const propMaterial=readyPropMaterial(gpu,span.propLayers);
            if(propMaterial){
              flush();
              bindPropMaterial(propMaterial);
              draw(span.first,span.count,primary,false,Boolean(span.cutout),Boolean(span.singleSided),
                propMaterial.parallax?false:undefined);
              if(propMaterial.parallax)gl.uniform4f(parallaxMarch,0,0,0,0);
              gl.uniform2f(propState,0,0);
              continue;
            }
          }
          if(span.overlay){
            if(span.noDecalColor)continue;
            flush();
            if(stencil&&span.groundBlend)fills.push({gpu,chunk,first:span.first,count:span.count,
              texture:span.fallback?this.groundTextures.get(span.fallback)??null:null});
            if(primary&&(span.vertexOpacity||this.alphaTextures.has(primary))){
              const [secondId,controlId]=span.decalLayers??[];
              const secondary=secondId&&this.textures.get(secondId),control=controlId&&this.textures.get(controlId);
              const layers:[WebGLTexture,WebGLTexture?]|undefined=secondary&&(!controlId||control)
                ?[secondary,control||undefined]:undefined;
              if(span.retroBlend&&!layers)continue;
              const tintMasks=span.decalTintMasks?.map(id=>this.terrainTextures.get(id));
              const blend=span.surfaceDecalBlend;
              const blendControl=blend&&this.terrainTextures.get(blend.control),dirt=blend&&this.terrainTextures.get(blend.dirt);
              (chunk.mesh.kind==="water"?waterOverlays:overlays).push({gpu,first:span.first,count:span.count,texture:primary,
                clip:interiorClip,
                road:chunk.mesh.kind==="road"||Boolean(span.decalLayers),groundOnly:ground,
                frontOnly:span.frontOnlyDecal,layers,retroBlend:span.retroBlend,ranges,
                tintMasks:tintMasks?.[0]&&tintMasks[1]?[tintMasks[0],tintMasks[1]]:undefined,
                tintMask:span.decalTintMask?this.terrainTextures.get(span.decalTintMask)??undefined:undefined,
                surfaceBlend:blend&&blendControl&&dirt?{control:blendControl,dirt,reciprocal:blend.reciprocal}:undefined,
                propMaterial:span.propLayers?.dirt?readyPropMaterial(gpu,span.propLayers):undefined});
            }
            continue;
          }
          const replacement=span.fallback&&!primary?this.groundTextures.get(span.fallback)??null:null;
          const texture=primary??replacement;
          if(foliage&&span.count&&span.texture&&!texture)missingCanopyMaterials?.add(span.texture);
          if(parentReady&&span.texture&&!texture){
            flush();
            missingCoverage=true;
            continue;
          }
          if(chunk.mesh.indexedTerrain==="replacement"&&!texture){
            flush();
            continue;
          }
          const alphaMasked=Boolean(span.cutout)&&!replacement;
          const bump=this.lightingMaterials&&primary&&gpu.terrainTangents&&span.bump?this.terrainTextures.get(span.bump):undefined;
          const strength=bump?span.bumpStrength:undefined;
          // Skipped decal spans can leave gaps in the opaque index ranges.
          if(!count||first+count!==span.first||current!==texture||currentBump!==bump||currentBumpStrength!==strength||
            projected!==Boolean(replacement)||masked!==alphaMasked||singleSided!==Boolean(span.singleSided)){
            flush();
            first=span.first;current=texture;currentBump=bump;currentBumpStrength=strength;
            projected=Boolean(replacement);masked=alphaMasked;singleSided=Boolean(span.singleSided);
          }
          count+=span.count;
        }
        flush();
      }
      if(chunk.mesh.kind==="skyline"&&drawnOpaque&&!missingCoverage)drawableSkyline.add(chunk);
      if(missingCanopyMaterials&&ranges&&vegetationDraws>priorVegetationDraws)
        drawableCanopy.set(chunk,{missing:missingCanopyMaterials,ranges});
      draws++;
      if(chunk.mesh.replaces){
        detailDraws++;
        if(chunk.mesh.id===`${chunk.mesh.replaces}:detail`){
          const [x,y]=chunk.mesh.origin;
          const tileX=Math.floor(x/overviewTerrainTileSize),tileY=Math.floor(y/overviewTerrainTileSize);
          const col=x/chunkSize-tileX*overviewCellsPerSide,row=y/chunkSize-tileY*overviewCellsPerSide;
          const tile=`overview:${tileX},${tileY}`,bit=1<<(row*overviewCellsPerSide+col);
          coveredOverviewCells.set(tile,(coveredOverviewCells.get(tile)??0)|bit);
        }
      }
    }
    useInteriorClip();
    cullBackFaces(false);
    useFoliageLighting(false);
    if(packedSlodCenter)gl.uniform4f(packedSlodUniform,0,0,0,0);
    if(stencil)gl.disable(gl.STENCIL_TEST);
    if(skyline)gl.disable(gl.POLYGON_OFFSET_FILL);
    if(fills.length){
      useDetailNormal();
      gl.uniform1i(alphaLayer,0);gl.uniform1i(instanced,0);
      gl.enable(gl.STENCIL_TEST);
      gl.stencilMask(terrainReceiver);
      gl.stencilFunc(gl.EQUAL,0,surfaceStencil);
      gl.stencilOp(gl.KEEP,gl.KEEP,gl.INVERT);
      const fillOrder=(chunk:Chunk)=>chunk.mesh.overview?(chunk.mesh.id.startsWith("seabed:")?3:2):Number(Boolean(chunk.mesh.visualOnly));
      fills.sort((a,b)=>fillOrder(a.chunk)-fillOrder(b.chunk));
      const coveredCellsUniform=uniform("overviewCoveredCells");
      let coveredCells=0;
      for(const {gpu,chunk,first,count,texture} of fills){
        // Coarse land fills distant gaps from above. Detailed terrain owns its
        // cells in world space, even where its silhouette leaves sky visible.
        cullBackFaces(chunk.mesh.id.startsWith("overview:"));
        const covered=coveredOverviewCells.get(chunk.mesh.id)??0;
        if(covered!==coveredCells){
          gl.uniform1ui(coveredCellsUniform,covered);
          coveredCells=covered;
        }
        useInteriorClip(visibility.interiorClips.get(chunk));
        const [ox,oy]=chunk.mesh.origin;
        gl.bindVertexArray(gpu.vao);
        gl.uniform1i(useMaterial,Number(Boolean(texture)));
        gl.uniform3f(groundAtlas,ox-this.origin[0],oy-this.origin[1],Number(Boolean(texture)));
        if(texture)gl.bindTexture(gl.TEXTURE_2D,texture);
        this.drawTriangles(gpu,first,count);
        if(texture)groundDraws++;
      }
      if(coveredCells)gl.uniform1ui(coveredCellsUniform,0);
      cullBackFaces(false);
      useInteriorClip();
      gl.disable(gl.STENCIL_TEST);
    }
    const drawOverlays=(overlays:Overlay[],countDraws=true)=>{
      if(!overlays.length)return;
      useDetailNormal();
      gl.uniform1i(useMaterial,1);gl.uniform1i(alphaLayer,1);
      gl.uniform3f(groundAtlas,0,0,0);
      gl.uniform1i(instanced,0);
      gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(-1,-1);
      let groundStencil=false;
      if(stencil){
        gl.stencilMask(0);
        gl.stencilFunc(gl.EQUAL,groundReceiver,groundReceiver);
      }
      for(const {gpu,first,count,texture,road,groundOnly,frontOnly,layers,retroBlend,tintMasks,tintMask,ranges,surfaceBlend,propMaterial,clip} of overlays){
        useInteriorClip(clip);
        if(stencil&&groundStencil!==groundOnly){
          groundStencil=groundOnly;
          if(groundStencil)gl.enable(gl.STENCIL_TEST);
          else gl.disable(gl.STENCIL_TEST);
        }
        gl.bindVertexArray(gpu.vao);
        gl.bindTexture(gl.TEXTURE_2D,texture);
        if(layers||tintMask||surfaceBlend){
          gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,layers?.[0]??tintMask??surfaceBlend?.control??null);
          const secondary=layers?.[1]??surfaceBlend?.dirt;
          if(secondary){gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,secondary);}
          gl.activeTexture(gl.TEXTURE1);
        }
        gl.uniform1i(uniform("twoLayerDecal"),Number(Boolean(layers)));
        gl.uniform1i(uniform("hasDecalControl"),Number(Boolean(layers?.[1])));
        gl.uniform1i(uniform("frontOnlyDecal"),Number(Boolean(frontOnly)));
        gl.uniform1f(uniform("retroBlend"),retroBlend??0);
        if(tintMasks){
          gl.activeTexture(gl.TEXTURE4);gl.bindTexture(gl.TEXTURE_2D,tintMasks[0]);
          gl.activeTexture(gl.TEXTURE5);gl.bindTexture(gl.TEXTURE_2D,tintMasks[1]);
          gl.activeTexture(gl.TEXTURE1);
        }
        gl.uniform1i(uniform("decalPaletteEnabled"),Number(Boolean(tintMasks||tintMask)));
        if(tintMask)gl.uniform1i(uniform("standardDecalTintEnabled"),1);
        if(surfaceBlend)gl.uniform1f(uniform("surfaceDecalReciprocal"),surfaceBlend.reciprocal);
        gl.uniform1i(instanced,gpu.instanceMode);
        if(propMaterial)bindPropMaterial(propMaterial);
        this.drawTriangles(gpu,first,count,ranges);
        if(propMaterial)gl.uniform2f(propState,0,0);
        if(tintMasks||tintMask)gl.uniform1i(uniform("decalPaletteEnabled"),0);
        if(tintMask)gl.uniform1i(uniform("standardDecalTintEnabled"),0);
        if(surfaceBlend)gl.uniform1f(uniform("surfaceDecalReciprocal"),0);
        if(countDraws){
          if(road)roadDecals++;
          else groundDraws++;
        }
      }
      useInteriorClip();
      if(groundStencil)gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.depthMask(true);gl.disable(gl.BLEND);
    };
    // Shade only sky samples left uncovered by the opaque pass, before
    // decals and water can blend against or sample the background.
    if(rendererReview.opaque)endOpaque(gl);
    this.occlusionReview?.end(camera,visible,this.cache,canSampleOcclusion&&!settling&&!uploads,redraw);
    drawSky?.();
    drawOverlays(overlays);
    let depthTexture:WebGLTexture|undefined;
    const readSceneDepth=(rows?:number)=>depthTexture??=this.sceneDepth.capture(rows);
    if(lighting&&!this.loading)this.contactShadows.paint(camera,lighting,this.shadowRevision,moving,program,readSceneDepth);
    const waveWind=lighting?.oceanBeaufort;
    const ocean=z+this.origin[2]>.3&&water.some(entry=>entry.ocean);
    const aerialBackdrop=ocean&&!animateWater&&this.flightTerrain;
    const nativeOcean=aerialBackdrop&&waveWind!==undefined&&this.oceanWaves?.available;
    const waterView=(animateWater||nativeOcean)&&!moving?[...eye,yaw,pitch,aspect,fov,this.shadowRevision].join(","):"";
    const cacheWater=allowWaterReplay&&waterView&&!this.loading&&!settling&&!this.pendingBoxes.size&&
      !waterOverlays.some(overlay=>overlay.groundOnly)&&this.waterVisibility?.key===waterView&&this.waterVisibility.visible;
    const opaqueFrame=cacheWater?(this.frameSnapshot??=new StreetFrameSnapshot(gl)).capture(program):undefined;
    if(opaqueFrame)readSceneDepth();
    const drawWaterPass=(replaying=false)=>{
      const backdrop=uniform("hasWaterBackdrop");
      const hasOceanWaves=Boolean(nativeOcean&&this.oceanWaves?.bind(performance.now(),waveWind!,allowWaterReplay,uniform));
      gl.uniform1i(uniform("hasOceanWaves"),Number(hasOceanWaves));
      const reflection=uniform("hasWaterReflection");
      const seaLevel=-this.origin[2];
      gl.uniform1f(uniform("waterReflectionPlane"),seaLevel);
      gl.uniform1i(reflection,Number(ocean&&animateWater&&lighting&&!this.loading&&z-seaLevel<45&&this.waterReflection.update(camera,
        `${this.shadowRevision}:${this.reflectionMaterials}`,lighting,time,moving,uniform,
        ()=>this.paintWaterReflection(camera,seaLevel,visible,uniform))));
      let captured=0;
      // Aerial shallows still need the wet-seabed composite when their water
      // is outside the near animation range.
      if(ocean&&(animateWater||aerialBackdrop)&&this.lightingMaterials){
        if(opaqueFrame&&this.waterBackdropSupported){
          gl.activeTexture(gl.TEXTURE0+streetWaterBackdropUnit);
          gl.bindTexture(gl.TEXTURE_2D,opaqueFrame.texture);
          gl.uniform1i(uniform("waterBackdrop"),streetWaterBackdropUnit);
          gl.uniform2f(uniform("waterViewport"),opaqueFrame.width,opaqueFrame.height);
          gl.activeTexture(gl.TEXTURE1);
          captured=opaqueFrame.height;
        }else if(!replaying)captured=this.captureWaterBackdrop(pitch,fov,uniform);
      }
      const depth=captured?readSceneDepth(captured):undefined;
      gl.uniform1i(backdrop,Number(captured>0&&(!aerialBackdrop||Boolean(depth))));
      gl.uniform1i(uniform("waterBackdropNeedsBottom"),Number(aerialBackdrop));
      gl.uniform1i(uniform("hasWaterSceneDepth"),Number(Boolean(depth)));
      if(depth){
        gl.activeTexture(gl.TEXTURE5);gl.bindTexture(gl.TEXTURE_2D,depth);
        gl.activeTexture(gl.TEXTURE1);
      }
      useDetailNormal();
      const waveTexture=uniform("hasWaveTexture");
      const waveMaterials=this.lightingMaterials?this.waterMaterials:undefined;
      if(this.lightingMaterials){
        gl.activeTexture(gl.TEXTURE11);
        if(!waveMaterials?.bump)this.waveTexture??=createStreetWaveTexture(gl);
        const bump=waveMaterials?.bump??this.waveTexture;
        if(bump)gl.bindTexture(gl.TEXTURE_2D,bump);
        if(waveMaterials?.foam){
          gl.activeTexture(gl.TEXTURE4);gl.bindTexture(gl.TEXTURE_2D,waveMaterials.foam);
        }
        gl.activeTexture(gl.TEXTURE1);
      }
      gl.uniform1i(waveTexture,Number(this.lightingMaterials&&Boolean(waveMaterials?.bump||this.waveTexture)));
      gl.uniform1i(uniform("hasAuthoredWaterBump"),Number(Boolean(waveMaterials?.bump)));
      gl.uniform1i(uniform("hasWaterFoam"),Number(Boolean(waveMaterials?.foam)));
      const optics=this.lightingMaterials?this.waterOptics:undefined;
      gl.uniform1i(uniform("hasWaterOptics"),Number(Boolean(optics?.scattering&&optics?.extinction)));
      if(optics?.scattering&&optics.extinction){
        gl.uniform4fv(uniform("waterOpticsBounds"),optics.source.bounds);
        gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,optics.scattering);
        gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,optics.extinction);
        gl.activeTexture(gl.TEXTURE1);
      }
      const region=optics?this.waterTileRegion:undefined;
      gl.uniform1i(uniform("hasWaterTileRegion"),Number(Boolean(region?.scattering&&region?.extinction)));
      if(region?.scattering&&region.extinction){
        gl.uniform4fv(uniform("waterTileBounds"),region.source.bounds);
        gl.activeTexture(gl.TEXTURE6);gl.bindTexture(gl.TEXTURE_2D,region.scattering);
        gl.activeTexture(gl.TEXTURE7);gl.bindTexture(gl.TEXTURE_2D,region.extinction);
        gl.activeTexture(gl.TEXTURE1);
      }
      gl.uniform1i(useMaterial,0);
      gl.uniform1i(alphaLayer,0);
      gl.uniform1i(uniform("frontOnlyDecal"),0);
      const drawWater=({gpu,first,count,ranges,clip}:typeof water[number])=>{
        useInteriorClip(clip);
        gl.bindVertexArray(gpu.vao);
        gl.uniform1i(instanced,gpu.instanceMode);
        this.drawTriangles(gpu,first,count,ranges);
      };
      // Resolve the closest surface first so overlapping ocean and authored
      // water do not each tint the same background.
      const depthOnly=uniform("waterDepthOnly");
      gl.uniform1i(depthOnly,1);
      gl.colorMask(false,false,false,false);
      for(const entry of water)drawWater(entry);
      gl.colorMask(true,true,true,true);
      gl.uniform1i(depthOnly,0);
      gl.depthFunc(gl.EQUAL);
      gl.depthMask(false);
      if(stencil){
        gl.enable(gl.STENCIL_TEST);
        gl.stencilMask(waterStencil);
        gl.stencilFunc(gl.EQUAL,0,waterStencil);
        gl.stencilOp(gl.KEEP,gl.KEEP,gl.INVERT);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
      const checking=this.beginWaterVisibility(waterView);
      for(const entry of water)if(!entry.ocean)drawWater(entry);
      for(const entry of water)if(entry.ocean)drawWater(entry);
      useInteriorClip();
      if(checking)gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
      gl.disable(gl.BLEND);
      if(stencil)gl.disable(gl.STENCIL_TEST);
      gl.depthMask(true);
      gl.depthFunc(gl.LESS);
      gl.uniform1i(backdrop,0);
      gl.uniform1i(reflection,0);
      gl.uniform1i(uniform("hasOceanWaves"),0);
    };
    if(fadeEnd)gl.uniform3f(vegetationRange,0,0,0);
    if(cropFadeEnd)gl.uniform2f(cropChildRange,0,0);
    if(water.length)drawWaterPass();
    drawOverlays(waterOverlays);
    if(opaqueFrame&&depthTexture){
      this.waterFrame={depth:depthTexture,draw:()=>{
        drawWaterPass(true);
        drawOverlays(waterOverlays,false);
        return this.waterVisibility?.key!==waterView||this.waterVisibility.visible;
      }};
    }
    this.paintPending(inView,eye,uniform);
    this.trimMeshCache(visibleCount,visibleBytes);
    // A water chunk can intersect the camera bounds while a building covers
    // every water pixel. Skip the idle animation cost until the view changes.
    const animated=Boolean((animateWater||nativeOcean&&this.oceanWaves?.available)&&
      !(waterView&&this.waterVisibility?.key===waterView&&!this.waterVisibility.visible));
    const textureDelay=this.textureSelectionDirty?Math.max(1,100-(time-(this.textureView?.time??time))):undefined;
    return {draws,textured,groundDraws,detailDraws,navigationDraws,roadDraws,roadDecals,terrainDraws,vegetationDraws,settling,textureDelay,animateWater:animated};
  }

  private trimMeshCache(visibleCount:number,visibleBytes:number){
    // Visible meshes already occupy the buffer budget. Give recent offscreen
    // meshes a separate allowance so small turns reuse their buffers.
    const count=visibleCount+streetBudgets.residentMeshes;
    const bytes=visibleBytes+streetBudgets.residentMeshBytes;
    if(this.cache.size<=count&&this.meshBytes<=bytes)return;
    const offscreen=[...this.cache].filter(([,gpu])=>gpu.frame!==this.frame)
      .sort(([,a],[,b])=>a.frame-b.frame);
    for(const [chunk,gpu] of offscreen){
      this.release(gpu);this.cache.delete(chunk);
      if(this.cache.size<=count&&this.meshBytes<=bytes)break;
    }
  }

  private paintPending(inView:ReturnType<typeof streetFrustum>,eye:StreetStreamView["eye"],
    uniform:(name:string)=>WebGLUniformLocation|null){
    const bounds=[...this.pendingBoxes.values()].filter(box=>inView(box))
      .sort((a,b)=>streetDistance(a,eye)-streetDistance(b,eye)).slice(0,16);
    if(!bounds.length)return;
    const {gl}=this,vertices:number[]=[];
    for(const box of bounds)for(let axis=0;axis<3;axis++)for(let corner=0;corner<8;corner++){
      if(corner&(1<<axis))continue;
      for(const c of [corner,corner|(1<<axis)])vertices.push(box[c&1?3:0],box[c&2?4:1],box[c&4?5:2],72);
    }
    if(!this.boxBuffers){
      const vao=gl.createVertexArray(),buffer=gl.createBuffer();
      this.boxBuffers={vao,vertices:buffer};
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0,4,gl.FLOAT,false,16,0);
    }
    gl.bindVertexArray(this.boxBuffers.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.boxBuffers.vertices);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(vertices),gl.STREAM_DRAW);
    gl.uniform1i(uniform("instanced"),0);
    gl.uniform1i(uniform("alphaLayer"),0);
    gl.uniform1i(uniform("frontOnlyDecal"),0);
    gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.drawArrays(gl.LINES,0,vertices.length/4);
    gl.depthMask(true);gl.disable(gl.BLEND);
  }

  private faces(chunk:Chunk):CollisionIndex{
    const cached=this.collision.get(chunk);
    if(cached)return cached;
    const collision=chunk.mesh.collision;
    const indices=collision?.indices??chunk.mesh.indices,buckets=new Map<string,Face[]>(),wide:Face[]=[];
    const side=chunk.mesh.interior&&chunk.mesh.kind==="collision"?1:collisionSide;
    const spans=collision?[]:chunk.mesh.appearance?.spans??[];
    let spanIndex=0;
    for(let i=0;i<indices.length;i+=3){
      while(spanIndex<spans.length&&i>=spans[spanIndex].first+spans[spanIndex].count)spanIndex++;
      const span=spans[spanIndex];
      if(span?.water||span?.overlay&&!span.groundBlend)continue;
      const a=indices[i],b=indices[i+1],c=indices[i+2];
      const av=this.vertex(chunk,a),bv=this.vertex(chunk,b),cv=this.vertex(chunk,c);
      const bounds=[
        Math.min(av[0],bv[0],cv[0]),Math.min(av[1],bv[1],cv[1]),Math.min(av[2],bv[2],cv[2]),
        Math.max(av[0],bv[0],cv[0]),Math.max(av[1],bv[1],cv[1]),Math.max(av[2],bv[2],cv[2]),
      ] as Bounds;
      const face={a,b,c,bounds,groundBlend:span?.groundBlend};
      const [left,top,,right,bottom]=bounds.map(value=>Math.floor(value/side));
      if((right-left+1)*(bottom-top+1)>64){wide.push(face);continue;}
      for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++){
        const key=`${x},${y}`,bucket=buckets.get(key);
        if(bucket)bucket.push(face);
        else buckets.set(key,[face]);
      }
    }
    if(this.collision.size===24)this.collision.delete(this.collision.keys().next().value!);
    const index={buckets,wide,side};
    this.collision.set(chunk,index);
    return index;
  }

  private *collisionFaces(chunk:Chunk,minX:number,minY:number,maxX=minX,maxY=minY){
    const {buckets,wide,side}=this.faces(chunk);
    const left=Math.floor(minX/side),right=Math.floor(maxX/side);
    const top=Math.floor(minY/side),bottom=Math.floor(maxY/side);
    for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++)
      yield* buckets.get(`${x},${y}`)??[];
    yield* wide;
  }

  floor(x:number,y:number,previous?:number,karstOnly=false){
    return this.findFloor(x,y,previous,karstOnly,false);
  }

  floorBelow(x:number,y:number,height:number){
    return this.findFloor(x,y,height,false,true);
  }

  stepFloor(fromX:number,fromY:number,x:number,y:number,height:number){
    const floor=this.floor(x,y,height);
    if(floor!==null||this.karstWalk)return floor;
    const distance=Math.hypot(x-fromX,y-fromY);
    if(!distance)return null;
    const dx=(x-fromX)/distance,dy=(y-fromY)/distance;
    const edge=(direction:number)=>{
      for(let probe=1;probe<=6;probe++){
        const offset=direction*probe*.1;
        const surface=this.floor(x+dx*offset,y+dy*offset,height);
        if(surface!==null)return {probe,surface};
      }
    };
    // The player's footprint can straddle two same-level surfaces at a seam.
    const behind=edge(-1),ahead=edge(1);
    if(!behind||!ahead||behind.probe+ahead.probe>7||Math.abs(ahead.surface-behind.surface)>.15||
      Math.abs(ahead.surface-height)>.18||Math.abs(behind.surface-height)>.18)return null;
    return (behind.surface*ahead.probe+ahead.surface*behind.probe)/(behind.probe+ahead.probe);
  }

  private findFloor(x:number,y:number,previous:number|undefined,karstOnly:boolean,descending:boolean){
    const ceiling=previous===undefined?Infinity:previous+(descending?0:.64);
    let best=-Infinity,original=-Infinity,road=-Infinity,coarse=-Infinity,blend=-Infinity;
    for(const chunk of this.chunks.values()){
      const {mesh}=chunk;
      if(mesh.visualOnly)continue;
      const native=mesh.kind==="collision";
      const roadMesh=mesh.kind==="road";
      const lowerDetail=this.superseded(mesh);
      let highest=native?original:roadMesh?road:lowerDetail?coarse:best;
      const karstFloor=this.karstWalk&&!mesh.collision&&mesh.normals&&mesh.id.startsWith("lo_slv_01_karst_tunnel_");
      if(karstOnly&&!karstFloor&&!native)continue;
      if(mesh.kind!=="terrain"&&mesh.kind!=="road"&&!mesh.collision&&!karstFloor)continue;
      if(lowerDetail&&this.karstWalk)continue;
      const [x0,y0,z0,x1,y1]=chunk.bounds;
      if(x<x0||x>x1||y<y0||y>y1||z0>ceiling)continue;
      for(const face of this.collisionFaces(chunk,x,y)){
        if(karstFloor&&Math.min(mesh.normals![face.a*3+2],mesh.normals![face.b*3+2],mesh.normals![face.c*3+2])<.6*32767)continue;
        const [x0,y0,z0,x1,y1,z1]=face.bounds;
        if(face.groundBlend&&this.karstWalk||x<x0||x>x1||y<y0||y>y1||z0>ceiling||z1<=(face.groundBlend?blend:highest))continue;
        const height=this.faceHeight(chunk,face,x,y,true);
        if(height===null||height>ceiling)continue;
        if(face.groundBlend)blend=Math.max(blend,height);
        else highest=Math.max(highest,height);
      }
      if(native)original=highest;
      else if(roadMesh)road=highest;
      else if(lowerDetail)coarse=highest;
      else best=highest;
    }
    const underlay=Number.isFinite(coarse)?coarse:Number.isFinite(blend)?blend:null;
    if(descending){
      const landing=Math.max(original,road,best);
      return Number.isFinite(landing)?landing:underlay;
    }
    if(Number.isFinite(original)&&(previous===undefined||original>=previous-.8)){
      // A lower collision surface can be exposed through a gap at a deck edge.
      // Keep the nearby authored deck when it continues the current road level.
      if(!this.karstWalk&&previous!==undefined&&road-original>.15&&
        Math.abs(road-previous)<Math.abs(original-previous))return road;
      return original;
    }
    const fallback=Math.max(best,road);
    return Number.isFinite(fallback)?fallback:underlay;
  }

  private faceHeight(chunk:Chunk,face:Face,x:number,y:number,walkable=false){
    const [ax,ay,az]=this.vertex(chunk,face.a),[bx,by,bz]=this.vertex(chunk,face.b),[cx,cy,cz]=this.vertex(chunk,face.c);
    const ux=bx-ax,uy=by-ay,vx=cx-ax,vy=cy-ay,det=ux*vy-uy*vx;
    if(Math.abs(det)<1e-6)return null;
    const u=((x-ax)*vy-(y-ay)*vx)/det,v=(ux*(y-ay)-uy*(x-ax))/det;
    if(u<-.001||v<-.001||u+v>1.001)return null;
    const dz1=bz-az,dz2=cz-az;
    if(walkable&&Math.hypot(dz1*vy-dz2*uy,ux*dz2-vx*dz1)>Math.abs(det)*maximumWalkSlope)return null;
    return az+u*dz1+v*dz2;
  }

  ceiling(x:number,y:number,from:number,to:number){
    let lowest=Infinity;
    for(const chunk of this.chunks.values()){
      const {mesh,bounds:[x0,y0,z0,x1,y1,z1]}=chunk;
      if(mesh.visualOnly)continue;
      if(!mesh.collision&&mesh.kind!=="structure"&&mesh.kind!=="road"&&mesh.kind!=="terrain")continue;
      if(x<x0||x>x1||y<y0||y>y1||z0>to||z1<from||this.superseded(mesh))continue;
      for(const face of this.collisionFaces(chunk,x,y)){
        if(face.groundBlend)continue;
        const [fx0,fy0,fz0,fx1,fy1,fz1]=face.bounds;
        if(x<fx0||x>fx1||y<fy0||y>fy1||fz0>to||fz1<from||fz0>=lowest)continue;
        const height=this.faceHeight(chunk,face,x,y);
        if(height!==null&&height>=from&&height<=to&&height<lowest)lowest=height;
      }
    }
    return Number.isFinite(lowest)?lowest:null;
  }

  spawn(minimumHeight=-Infinity){
    const directions=Array.from({length:8},(_,i)=>Math.PI/4*i);
    let fallback:{x:number;y:number;z:number;yaw:number}|null=null;
    for(const radius of [0,6,16,30]){
      for(const heading of radius?directions:[0]){
        const x=Math.cos(heading)*radius,y=Math.sin(heading)*radius;
        const z=this.floor(x,y);
        if(z===null||z<minimumHeight)continue;
        for(const yaw of directions){
          const dx=Math.cos(yaw),dy=Math.sin(yaw);
          const next=this.floor(x+dx*2,y+dy*2,z);
          if(next===null||Math.abs(next-z)>.8||this.blocked(x,y,x+dx*2,y+dy*2,z))continue;
          fallback??={x,y,z,yaw};
          const far=this.floor(x+dx*8,y+dy*8);
          if(far!==null&&Math.abs(far-z)<3&&!this.blocked(x,y,x+dx*14,y+dy*14,z))
            return {x,y,z,yaw};
        }
      }
    }
    return fallback;
  }

  blocked(x:number,y:number,nx:number,ny:number,z:number){
    const dx=nx-x,dy=ny-y;
    const authored=this.karstWalk&&[...this.chunks.values()].some(({mesh,bounds:[x0,y0,z0,x1,y1,z1]})=>
      mesh.kind==="collision"&&Math.min(x,nx)>=x0&&Math.max(x,nx)<=x1&&Math.min(y,ny)>=y0&&Math.max(y,ny)<=y1&&z+.64>=z0&&z-.8<=z1);
    for(const chunk of this.chunks.values()){
      if(chunk.mesh.kind!=="structure"&&chunk.mesh.kind!=="collision")continue;
      if(authored&&chunk.mesh.id.startsWith("lo_slv_01_karst_tunnel_"))continue;
      const [x0,y0,z0,x1,y1,z1]=chunk.bounds;
      if(Math.max(x,nx)<x0||Math.min(x,nx)>x1||Math.max(y,ny)<y0||Math.min(y,ny)>y1||z+1.4<z0||z+.35>z1)continue;
      for(const face of this.collisionFaces(chunk,Math.min(x,nx),Math.min(y,ny),Math.max(x,nx),Math.max(y,ny))){
        const [x0,y0,z0,x1,y1,z1]=face.bounds;
        if(Math.max(x,nx)<x0||Math.min(x,nx)>x1||Math.max(y,ny)<y0||Math.min(y,ny)>y1||z+1.4<z0||z+.35>z1)continue;
        const [ax,ay,az]=this.vertex(chunk,face.a),[bx,by,bz]=this.vertex(chunk,face.b),[cx,cy,cz]=this.vertex(chunk,face.c);
        const edges=[[bx-ax,by-ay,bz-az],[cx-ax,cy-ay,cz-az]];
        const [u,v]=edges;
        const cross=[dy*v[2],-dx*v[2],dx*v[1]-dy*v[0]];
        const det=u[0]*cross[0]+u[1]*cross[1]+u[2]*cross[2];
        if(Math.abs(det)<1e-7)continue;
        const s=x-ax,t=y-ay;
        for(const base of [.45,1.35]){
          const w=z+base-az;
          const a=(s*cross[0]+t*cross[1]+w*cross[2])/det;
          if(a<0||a>1)continue;
          const q=[t*u[2]-w*u[1],w*u[0]-s*u[2],s*u[1]-t*u[0]];
          const b=(dx*q[0]+dy*q[1])/det;
          const at=(v[0]*q[0]+v[1]*q[1]+v[2]*q[2])/det;
          if(b>=0&&a+b<=1&&at>=0&&at<=1)return true;
        }
      }
    }
    return false;
  }

  private release(gpu:Resident){
    this.meshBytes-=gpu.bytes;
    if(gpu.shadowMaterials){
      this.shadowRevision++;
      for(const id of gpu.shadowMaterials){
        const count=this.shadowMaterials?.get(id)??0;
        if(count>1)this.shadowMaterials?.set(id,count-1);
        else this.shadowMaterials?.delete(id);
      }
    }
    this.gl.deleteVertexArray(gpu.vao);
    if(!gpu.shared||!--gpu.shared.references){
      this.gl.deleteBuffer(gpu.vertices);this.gl.deleteBuffer(gpu.indices);
      if(gpu.uv)this.gl.deleteBuffer(gpu.uv);
      if(gpu.normals)this.gl.deleteBuffer(gpu.normals);
      if(gpu.shared){
        this.sharedGeometry.delete(gpu.shared.key);
        this.meshBytes-=gpu.shared.bytes;
      }
    }
    if(gpu.terrainColors)this.gl.deleteBuffer(gpu.terrainColors);
    if(gpu.terrainTintUV)this.gl.deleteBuffer(gpu.terrainTintUV);
    if(gpu.terrainTangents)this.gl.deleteBuffer(gpu.terrainTangents);
    if(gpu.terrainSecondaryTangents)this.gl.deleteBuffer(gpu.terrainSecondaryTangents);
    if(gpu.roadUV)this.gl.deleteBuffer(gpu.roadUV);
    if(gpu.roadWeights)this.gl.deleteBuffer(gpu.roadWeights);
    if(gpu.decalOpacity)this.gl.deleteBuffer(gpu.decalOpacity);
    if(gpu.decalBlend)this.gl.deleteBuffer(gpu.decalBlend);
    if(gpu.poses)this.gl.deleteBuffer(gpu.poses);
    if(gpu.propInstances)this.gl.deleteBuffer(gpu.propInstances);
    for(const texture of gpu.propPalettes?.values()??[])this.gl.deleteTexture(texture);
  }

  dispose(){
    if(this.wrappingTerrainMask)this.gl.deleteSampler(this.wrappingTerrainMask);
    this.occlusionReview?.dispose();
    if(this.boxBuffers){this.gl.deleteVertexArray(this.boxBuffers.vao);this.gl.deleteBuffer(this.boxBuffers.vertices);}
    if(this.waterBackdrop)this.gl.deleteTexture(this.waterBackdrop.texture);
    if(this.waveTexture)this.gl.deleteTexture(this.waveTexture);
    this.deleteWaterOptics(this.waterOptics);
    this.deleteWaterOptics(this.waterTileRegion);
    if(this.waterMaterials?.bump)this.gl.deleteTexture(this.waterMaterials.bump);
    if(this.waterMaterials?.foam)this.gl.deleteTexture(this.waterMaterials.foam);
    if(this.waterQuery)this.gl.deleteQuery(this.waterQuery.query);
    this.waterReflection.dispose();
    this.oceanWaves?.dispose();
    this.sceneDepth.dispose();
    this.contactShadows.dispose();
    this.frameSnapshot?.dispose();
    for(const gpu of this.cache.values())this.release(gpu);
    for(const texture of this.textures.values())if(texture)this.deleteMaterialTexture(texture);
    for(const texture of this.closeTextures.values())if(texture)this.gl.deleteTexture(texture);
    for(const texture of this.canopyTextures.values())if(texture)this.gl.deleteTexture(texture);
    for(const texture of this.groundTextures.values())if(texture)this.gl.deleteTexture(texture);
    for(const texture of this.terrainTextures.values())this.gl.deleteTexture(texture);
  }
}

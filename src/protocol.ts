import type { Atlas, Issue, Rect } from "./recover";
import type { OverviewLayer } from "./layers";
import type { District, MapLabel } from "./districts";
import type { Place } from "./places";
import type { NamedRoad } from "./road-names";
import type { NativeScene } from "./native-map";
import type { StreetChunk, StreetGeometryPhase } from "./street-mesh";
import type {StreetBlockTexture,StreetTextureImage} from "./street-terrain-material";
import type {RoadHeightMip} from "./street-road-material";
import type {PlacementProbeStats} from "./street-placement-probe";
import type {LayerName} from "./board";
import type {StreetIndexStatus} from "./street-index";
import type {StreetPendingBox, StreetStreamView} from "./street-priority";
import type {StreetEnvironment} from "./street-environment";
import type {StreetWaterOptics} from "./street-water-optics";
import type {StreetCloudAssets} from "./street-cloud-assets";
import type {StreetWaterMaterials} from "./street-water-materials";

export type SketchPoint = { x:number;y:number;color?:[number,number,number] };
export type MatchSide = { id:string; direction:0|1|2|3 };
export type TileInfo = { width:number; stream:number; offset:number };
export type Request =
  | { kind:"import"; files:Record<string,File> }
  | { kind:"streetImport"; files:Record<string,File>; reloading?:true }
  | { kind:"streetMaterialsImport"; files:Record<string,File>; reloading?:true }
  | { kind:"streetIndexFile"; file:File }
  | { kind:"streetEnvironment"; cloudNoise?:true; hdrSky?:true; nativeClouds?:true }
  | { kind:"imagery" }
  | { kind:"mapLayer"; name:LayerName }
  | { kind:"roofRegion"; serial:number; rect:Rect|null; known:string[] }
  | { kind:"tile"; key:string; id:string; side:number }
  | { kind:"sector"; key:string; id:string; side:number }
  | { kind:"rank"; serial:number; neighbors:MatchSide[]; points:SketchPoint[] }
  | { kind:"cancelRank" }
  | { kind:"nativeMap" }
  | { kind:"streetPrepareWorld"; collision?:true }
  | { kind:"streetSpawnProbe"; serial:number; point:readonly [number,number]; hint?:number }
  | { kind:"streetPrepareEntry"; point:readonly [number,number]|null }
  | { kind:"streetStreamView"; view:StreetStreamView }
  | { kind:"cancelStreetRegion"; serial:number }
  | { kind:"streetTexture"; epoch:number; id:string; ground:boolean; compression?:number }
  | { kind:"streetNavigation"; serial:number; point:readonly [number,number]|null; known:string[] }
  | { kind:"streetVegetation"; serial:number; point:readonly [number,number]|null; known:string[]; lookOnly?:true }
  | { kind:"streetRegion"; serial:number; point:readonly [number,number]; known:string[]; karst?:true };
export type Event =
  | { kind:"progress"; label:string; done:number; total:number }
  | { kind:"ready"; atlas:Atlas; issues:Issue[]; bytes:number; milliseconds:number; navigation:boolean }
  | { kind:"imageryReady"; atlas:Atlas; issues:Issue[]; bytes:number; milliseconds:number }
  | { kind:"imageryFailure"; message:string; issues?:Issue[] }
  | { kind:"roofImage"; serial:number; id:string; rect:Rect; image:ImageBitmap; score:number }
  | { kind:"layerFailure"; name:LayerName; message:string }
  | { kind:"failure"; message:string; issues?:Issue[] }
  | { kind:"tile"; key:string; image?:ImageBitmap; info?:TileInfo }
  | ({ kind:"layer" } & OverviewLayer)
  | { kind:"overview"; name:"atlas"|"coarse"; image:ImageBitmap; rect:Rect }
  | { kind:"background"; message:string; bytes:number; elapsed:number; done?:boolean; path?:string }
  | { kind:"districts"; districts:District[]; mapLabels:MapLabel[] }
  | { kind:"places"; places:Place[] }
  | { kind:"roadNames"; roads:NamedRoad[] }
  | { kind:"nativeProgress"; done:number; total:number }
  | { kind:"nativeMap"; scene:NativeScene }
  | { kind:"nativeMapEntries"; buildings:number; vertices:Uint32Array<ArrayBuffer> }
  | { kind:"nativeFailure"; message:string }
  | { kind:"streetSpawnProbe"; serial:number; height:number|null }
  | { kind:"streetImported" }
  | { kind:"streetCatalog"; radius:number; assets:number; bytes:number;
      queuedAt:number;startedAt:number;registrationMs:number;queryMs:number }
  | { kind:"streetEnvironment"; environment?:StreetEnvironment }
  | { kind:"streetCloudNoise"; noise:Uint8Array<ArrayBuffer> }
  | { kind:"streetCloudAssets"; assets:StreetCloudAssets }
  | { kind:"streetWaterOptics"; optics:StreetWaterOptics }
  | { kind:"streetWaterTileRegion"; optics?:StreetWaterOptics }
  | { kind:"streetWaterMaterials"; materials:StreetWaterMaterials }
  | { kind:"streetIndex"; status:StreetIndexStatus }
  | { kind:"streetWork"; task:"region"; serial:number; phase?:StreetGeometryPhase; done?:number; total?:number; sentAt?:number }
  | { kind:"streetWork"; task:"vegetation"; serial:number; done?:number; total?:number }
  | { kind:"streetFailure"; message:string }
  | { kind:"streetTexture"; epoch:number; id:string; ground:boolean; image:StreetTextureImage|null;
      compressed?:StreetBlockTexture; cube?:StreetCubeTexture; roadHeight?:RoadHeightMip[]; cached?:true }
  | { kind:"streetRegion"; serial:number; wanted:string[]; meshes:StreetChunk[]; skipped:number; error?:string; placementProbe?:PlacementProbeStats; sentAt?:number; nativeRadius?:number; nativeHorizon?:number }
  | { kind:"streetRegionBatch"; serial:number; meshes:StreetChunk[]; sentAt?:number }
  | { kind:"streetInteriors"; serial:number; wanted:string[]|null; meshes:StreetChunk[]; complete?:boolean }
  | { kind:"streetBridgeLods"; serial:number; links:[string,NonNullable<StreetChunk["placementLod"]>][] }
  | { kind:"streetPending"; serial:number; boxes:StreetPendingBox[] }
  | { kind:"streetNavigation"; serial:number; wanted:string[]; meshes:StreetChunk[]; skipped:number }
  | { kind:"streetVegetation"; serial:number; wanted:string[]|null; meshes:StreetChunk[]; skipped:number; nativeGrass?:number; nativeWoody?:number }
  | { kind:"rank"; serial:number; ids:string[]; done:number; total:number };
import type { StreetCubeTexture } from "./street-cube-texture";

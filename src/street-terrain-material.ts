import type {Image} from "./texture";
import type {RoadLayers} from "./street-road-material";

export type StreetTextureImage=Image&{detailNormal?:Uint8Array<ArrayBuffer>;alphaCutout?:boolean;authoredMips?:Image[];baseLevelOnly?:true};
export type StreetBlockTexture={
  format:"bc1"|"bc7";
  levels:{width:number;height:number;blocks:Uint8Array<ArrayBuffer>}[];
  alphaCutout?:boolean;
  roadColorLuminance?:number;
};

type Vec4=[number,number,number,number];

export type TerrainLayers={
  textures:string[];
  primary:Vec4;
  // Fully authored COLOR1. Each component selects the secondary UV for that layer.
  vertexWeightUV?:Vec4;
  layerUV?:Vec4;
  vertexBlend?:true;
  projectedDetail?:true;
  nativeLocalBlend?:true;
  detail?:RoadLayers["detail"];
  maskUV?:3;
  heightGain:Vec4;
  heightBias:Vec4;
  powers:Vec4;
  normals?:{textures:string[];strength:Vec4};
  tint?:{texture:string;uv?:2|3;inset:boolean;maskAlpha:boolean;mode:Vec4;scale:Vec4;amount:Vec4};
  vertexTint?:{beforeSector:boolean;maskAlpha:boolean;invertAlpha:Vec4;mode:Vec4;scale:Vec4;amount:Vec4};
};

export const dynamicTerrainPrefix="dynamic-terrain:";
export const terrainTexturePrefix="terrain-layer:";
export const roomGlassTexturePrefix=terrainTexturePrefix+"room-glass:";
// The first lane reuses the water backdrop sampler during the opaque pass.
export const terrainDetailUnits=[18,29,30,31] as const;
export const detailAtlasSlicePrefix=terrainTexturePrefix+"detail-atlas:";
export const materialMaskChainPrefix=terrainTexturePrefix+"material-mask-chain:";
export const authoredDiffusePrefix=terrainTexturePrefix+"diffuse-chain:";
export const authoredControlPrefix=terrainTexturePrefix+"control-chain:";
export const streetBlueNoiseId=terrainTexturePrefix+"blue-noise-64";
export const standardPaletteMaterial=83;
export const waterScumTexturePrefix="water-scum:";

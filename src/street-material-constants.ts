export const vertexBlendedGroundEffect=0x61e09df7;
export const sectorBlendedGroundEffect=0x388f8fb6;
export const uberGroundEffect=0x4a579bbf;
export const dpmUberGroundEffect=0x61fad45c;
export const layerOneMaterialABindingHash=0x2bb2ede8;
export const layerTwoMaterialABindingHash=0x4d56d7fe;
export const dirtBindingHash=0x7485dafb;
export const detailArrayBindingHash=0x0cd27763;
export const normalBindingHash=0x1e77bf4c;
export const signGlyphBindingHash=0xcdab98a0;
export const waterCausticsTexture="0xaa3eeff23a15dc75";

export const projectedRoadEffect=0x360e396b;
export const standardDecalEffect=0xe0b4c573;
export const layeredGroundEffect=0xcd8ceb5e;
export const emissiveLightmapEffect=0xf5ba53da;
export const emissivePaletteEffect=0xf119f925;
export const windDecalEffect=0x8d44f1d6;
export const standardPaletteEffect=0xbcf03fc1;
export const groundSurfaceDecalEffect=0x42c64b5e;
export const diffuseBindingHash=0xc8e8c282;
export const materialBBindingHash=0x739e3d0d;
export const tintPaletteBindingHash=0x2c8d7182;
export const layerOneDiffuseBindingHash=0x346394ea;
export const layerTwoDiffuseBindingHash=0x7d4f12e2;
export const layerOneMaterialBBindingHash=0x3c4af3d4;
export const layerTwoMaterialBBindingHash=0xfa0446c7;
export const layerControlBindingHash=0x38ebcdb3;
export const opaqueMaterialBTexture="0x59932052cc65cbee";

// Standard object decal and dirt passes composite over an opaque base material.
export const decalBlendEffect=0xd41ddcc3;
export const propDecalBlendEffect=0xc8fd534c;
export const layeredPropDecalEffect=0x990e2a3c;
export const layeredObjectDecalEffect=0x274d56ce; // standard_2lyr_decal
export const retroDecalEffect=0x0b3ca885; // standard_2lyr_retroreflection_decal_blend
export const immersedDecalEffect=0x4431c5c3;
export const layeredSurfaceDecals=new Set([immersedDecalEffect,0xb637d50d]);
export const standardAlphaEffect=0xe3ba3129;
export const exteriorGlassEffects=new Set([0x298c4c0f,0x653582a4,standardAlphaEffect]);
export const luminousSurfaceEffects=new Set([0xfaec4fc8,0x3a09c775,0x3bc8ac60,0x60643f2e]);
export const dirtEffect=0x512937b5; // standard_dirt
export const pxmGroundDirtEffect=0xe7aeb297; // standard_dirt_pxm_ground
export const standardGroundEffect=0xade06b0c; // standard_ground
export const twoSidedDirtEffect=0xe49bee73; // standard_doublesided_dirt
export const clothDirtEffect=0x68e93cdf; // standard_dirt_secmo
export const batchDirtEffect=0xfb0d7769; // prop_batch_dirt
export const windClothEffect=0xebb2331a; // prop_batch_um_wind
export const dualLayerPropEffect=0x89c8fe07; // prop_2lyr_batch
export const retroreflectionDirtEffect=0x0ab44d8e; // standard_retroreflection_dirt
export const layeredPavementEffect=0x1251cae5; // standard_2lyr_pxm_ground
export const signBackingEffect=0x7f04a63a;
export const signGlyphEffect=0x9eedd8db;
export const layeredSignGlyphEffect=0x3e933acd;
export const layeredRoadSignEffect=0xb9c159da;
export const propSignGlyphEffect=0x6161fc0c; // prop_batch_decal_blend_text
export const runtimeSignEffect=0x8e0475a1; // signs
export const tintedClothEffect=0x05e643cb;
// Foliage materials also occur on standalone drawables such as planters and driftwood.
export const reflectedDiffuseEffects=new Set([0x28d751f1,0x578bb142,0x40be6a4d]);
export const groundBlendDecalEffect=0xec8e6107;
export const surfaceOpacityEffects=new Set([0x0ca0d9a0,groundBlendDecalEffect]);
export const objectDecalEffects=new Set([
  decalBlendEffect,layeredObjectDecalEffect,0x037206ee,
  0xcb0ad158, // Cloth lettering uses diffuse alpha coverage.
  standardDecalEffect, // standard_decal
  0xea9cce3a, // standard_pxm_decal
  0x5ee453cc, // standard_decal_ground
]);
export const objectDirtEffects=new Set([0xc18881f1,0xaf83d7c6,0x5d3b9bfa,0xcbe2712d]);
export const layeredGroundEffects=new Set([vertexBlendedGroundEffect,0x0ad54cb9,sectorBlendedGroundEffect]);
export const mixedProjectedGroundEffect=0x6f968246;
export const uv3LandscapeEffect=0x27e5c49d; // standard_uber_4lyr_pxm_hbb_uv3
export const spxUV3LandscapeEffect=0x76fcff28; // standard_uber_4lyr_spx_dm_hbb_uv3
export const fixedUVLandscapeEffect=0xb21f1ba5; // standard_uber_4lyr_pxm_hbb_fixuv1
export const singleSidedLandscapeEffects=new Set([projectedRoadEffect,uv3LandscapeEffect,0x0ad54cb9,spxUV3LandscapeEffect]);
export const uberGroundEffects=new Set([
  uberGroundEffect, // standard_uber_4lyr_pxm_hbb
  uv3LandscapeEffect,
  fixedUVLandscapeEffect,
  dpmUberGroundEffect, // standard_uber_4lyr_dpm_dfm_dm_hbb
  0xf8e1f225, // standard_uber_4lyr_dfm_dm_hbb_uv3
  0x40497278, // standard_uber_4lyr_dpm_dfm_dm_hbb_uv3
]);
export const reflectedGroundDecals=new Set([0xde6b843d,groundSurfaceDecalEffect]);
// These road decals have a readable DiffuseTex and a verified COLOR0 opacity channel.
export const roadDiffuseDecals=new Map([
  ["0x64d60e6f640d72cd",groundBlendDecalEffect],
  ["0x67285ccaf7a007e1",0x0ca0d9a0],
  ["0xf43aa4d9144dd323",0x0ca0d9a0],
  ["0x2599e2e9ad7685cd",0x70746df0],
]);

// The renderer submits these values to the GLSL surfacePaletteMode uniform.
export const surfacePaletteMode={disabled:0,mask:1,full:2,constant:3} as const;

export const groundBlendDecalLayout={
  primaryTintWeight:0x90,
  alternateTintWeight:0x94,
  alternateTintRed:0xa0,
  alternateTintGreen:0xa4,
  alternateTintBlue:0xa8,
  opacityScale:0xb8,
  opacityExponent:0xc8,
  primaryDetailSlice:0xe8,
  secondaryDetailSlice:0xec,
  byteLength:0xf0,
  disabledDetailSlice:24,
} as const;

export const layerProjectionBindingSlots=[[2,0xc075f9b6],[9,0x32b9df09],[12,0xd883aa9e],[13,0x3d10f3b7],[14,0xce7b968e]] as const;

// Cache version changes invalidate persisted data. Keep independent formats separate.
export const streetMeshCacheVersions={
  detailedTerrain:62,
  overviewTerrain:7,
  materialObject:55,
  object:32,
  instanceTint:5,
  instanceBounds:1,
  roller:1,
  signFont:2,
  affineCanopy:2,
} as const;

export const decodedStreetDatabaseVersion=1;
export const decodedStreetNamespaceVersion=1;
export const streetIndexDatabaseVersion=1;

// Version 9 bundles retain authored sign labels on their placement rows.
export const indexScanVersion=9;
export const unversionedIndexScanVersion=5;
export const legacyIndexScanVersions=[8,6,unversionedIndexScanVersion] as const;

export const streetTextureCacheVersions={
  nativeCanopyAtlas:5,
  waterOptics:2,
  roadHeightBlocks:2,
  roadHeightRG:3,
  roadColorBlocks:1,
  groundAuthoredMips:1,
  materialRGBA:3,
  closeColorBlocks:1,
  dynamicTerrainPage:3,
} as const;

export const streetProxyCacheVersions={bridge:3,horizon:4} as const;

export const streetIndexBundleHeader={
  magic:"TAIDX001",
  lengthOffset:8,
  byteLength:12,
} as const;

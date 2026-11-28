export const pauseMapBuildingMaterial="buildings_std";
export const pauseMapVertexLayout={strideBytes:16,colorOffsetBytes:12} as const;

export const pauseMapBuildingPalette={
  ordinary:[155,172,193],
  exteriorEntry:[72,107,154],
} as const;

export const pauseMapEntryMatching={
  cellMeters:64,
  insetMeters:1,
  roofHeightToleranceMeters:0.5,
} as const;

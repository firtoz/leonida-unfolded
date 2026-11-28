export const streetShadowMap={
  nearDefaultSize:2048,
  nearHighSize:3072,
  distantSize:1024,
  highTierMemoryGiB:8,
  highTierThreads:8,
  nearSamplerUnit:16,
  distantSamplerUnit:22,
  groundExtentMeters:140,
  centerSnapMeters:8,
  transitionMs:180,
} as const;

export const streetShadowReceiver={
  nearNormalOffsetMeters:0.035,
  nearFacingBiasTexels:0.18,
  nearGrazingBiasTexels:1.1,
  nearBlendInnerUv:0.015,
  nearBlendOuterUv:0.08,
  distantNormalOffsetMeters:0.11,
  distantGrazingDepthBias:0.0015,
  distantFacingDepthBias:0.00065,
} as const;

export const streetAmbientOcclusion={
  reachMeters:0.85,
  maxRadiusPixels:64,
  directionCount:8,
  ringCount:2,
  ringSpacing:0.42,
  minimumHeightMeters:0.022,
  footprintHeightScale:1.25,
  fadeStartMeters:18,
  fadeEndMeters:36,
  strength:0.3,
} as const;

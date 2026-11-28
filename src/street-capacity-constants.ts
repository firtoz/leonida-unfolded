const bytesPerMiB=1024*1024;

export const streetDeviceDefaults={threads:4,memoryGiB:4} as const;
export const streetDeviceTierThresholds={fullSceneMemoryGiB:4,midTierReadThreads:6,highTierThreads:12} as const;

export const streetQualityTiers={
  cachedStructures:[96,640,1024],
  decodedCacheBytes:[384*bytesPerMiB,768*bytesPerMiB,768*bytesPerMiB],
  decodedCacheWriteBytes:[20*bytesPerMiB,32*bytesPerMiB,32*bytesPerMiB],
  decodedMeshEntryBytes:[8*bytesPerMiB,16*bytesPerMiB,16*bytesPerMiB],
  drawableBytes:[96*bytesPerMiB,144*bytesPerMiB,224*bytesPerMiB],
  drawableCount:[64,96,144],
  residentMeshes:[96,256,384],
  residentMeshBytes:[24*bytesPerMiB,64*bytesPerMiB,96*bytesPerMiB],
  materialTextures:[128,232,320],
  groundTextures:[16,24,32],
  detailCells:[5,7,9],
  materialSide:[256,512,512],
} as const;

export const streetScheduleTiers={
  scanWorkers:[1,2,4],
  geometryReads:[1,3,6],
  midTierLowThreadGeometryReads:2,
  materialReads:[4,6,8],
  groundReads:[2,3,4],
  terrainReads:[2,2,3],
  uploadCount:[8,16,24],
  uploadMilliseconds:[3,4,5],
} as const;

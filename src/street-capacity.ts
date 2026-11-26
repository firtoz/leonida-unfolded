type BrowserCapacity = {hardwareConcurrency?:number;deviceMemory?:number};

export function streetCapacity(device:BrowserCapacity){
  const threads=device.hardwareConcurrency??4;
  const memory=device.deviceMemory??4;
  // Browsers can mask core count independently across sessions. Keep the
  // full scene tier for capable devices and the middle tier for unknown memory.
  const quality=device.deviceMemory===undefined?1:memory>=4?2:0;
  const schedule=memory>=4?(threads>=12?2:1):0;
  return {
    scanWorkers:[1,2,4][schedule],
    geometryReads:schedule===1&&threads<6?2:[1,3,6][schedule],
    cachedStructures:[96,640,1024][quality],
    decodedCacheBytes:[384,768,768][quality]*1024*1024,
    decodedCacheWriteBytes:[20,32,32][quality]*1024*1024,
    decodedMeshEntryBytes:[8,16,16][quality]*1024*1024,
    drawableBytes:[96,144,224][quality]*1024*1024,
    drawableCount:[64,96,144][quality],
    residentMeshes:[96,256,384][quality],
    residentMeshBytes:[24,64,96][quality]*1024*1024,
    materialTextures:[128,232,320][quality],
    groundTextures:[16,24,32][quality],
    materialReads:[4,6,8][schedule],
    groundReads:[2,3,4][schedule],
    terrainReads:[2,2,3][schedule],
    detailCells:[5,7,9][quality],
    materialSide:quality>=1?512:256,
    uploadCount:[8,16,24][schedule],
    uploadMilliseconds:[3,4,5][schedule],
  };
}

export const streetBudgets=streetCapacity(typeof navigator==="undefined"?{}:navigator);
export const closeMaterialPrefix="close-material:";
export const compressedMaterialFormats={bc1:1,bc7:2} as const;
export const compressedRoadColorFormats={bc1:4,bc7:8} as const;

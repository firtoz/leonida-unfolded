import { streetDeviceDefaults, streetDeviceTierThresholds, streetQualityTiers, streetScheduleTiers } from "./street-capacity-constants";
import { streetShadowMap } from "./street-shadow-constants";

type BrowserCapacity = {hardwareConcurrency?:number;deviceMemory?:number};

export function streetCapacity(device:BrowserCapacity){
  const threads=device.hardwareConcurrency??streetDeviceDefaults.threads;
  const memory=device.deviceMemory??streetDeviceDefaults.memoryGiB;
  // Browsers can mask core count independently across sessions. Keep the
  // full scene tier for capable devices and the middle tier for unknown memory.
  const quality=device.deviceMemory===undefined?1:memory>=streetDeviceTierThresholds.fullSceneMemoryGiB?2:0;
  const schedule=memory>=streetDeviceTierThresholds.fullSceneMemoryGiB?(threads>=streetDeviceTierThresholds.highTierThreads?2:1):0;
  return {
    scanWorkers:streetScheduleTiers.scanWorkers[schedule],
    geometryReads:schedule===1&&threads<streetDeviceTierThresholds.midTierReadThreads?
      streetScheduleTiers.midTierLowThreadGeometryReads:streetScheduleTiers.geometryReads[schedule],
    cachedStructures:streetQualityTiers.cachedStructures[quality],
    decodedCacheBytes:streetQualityTiers.decodedCacheBytes[quality],
    decodedCacheWriteBytes:streetQualityTiers.decodedCacheWriteBytes[quality],
    decodedMeshEntryBytes:streetQualityTiers.decodedMeshEntryBytes[quality],
    drawableBytes:streetQualityTiers.drawableBytes[quality],
    drawableCount:streetQualityTiers.drawableCount[quality],
    residentMeshes:streetQualityTiers.residentMeshes[quality],
    residentMeshBytes:streetQualityTiers.residentMeshBytes[quality],
    materialTextures:streetQualityTiers.materialTextures[quality],
    groundTextures:streetQualityTiers.groundTextures[quality],
    materialReads:streetScheduleTiers.materialReads[schedule],
    groundReads:streetScheduleTiers.groundReads[schedule],
    terrainReads:streetScheduleTiers.terrainReads[schedule],
    detailCells:streetQualityTiers.detailCells[quality],
    materialSide:streetQualityTiers.materialSide[quality],
    nearShadowSize:memory>=streetShadowMap.highTierMemoryGiB&&threads>=streetShadowMap.highTierThreads?
      streetShadowMap.nearHighSize:streetShadowMap.nearDefaultSize,
    uploadCount:streetScheduleTiers.uploadCount[schedule],
    uploadMilliseconds:streetScheduleTiers.uploadMilliseconds[schedule],
  };
}

export const streetBudgets=streetCapacity(typeof navigator==="undefined"?{}:navigator);
export const closeMaterialPrefix="close-material:";
export const compressedMaterialFormats={bc1:1,bc7:2} as const;
export const compressedRoadColorFormats={bc1:4,bc7:8} as const;

export type DetailCell=readonly [number,number];
export const detailCellSize=8;
export const oceanRadius=3600;
export const overviewTerrainRadius=3200;
export const flightTerrainRadius=840;
export const flightTerrainAltitude=52;
export const skylineRadius=3200;
// Authored daytime far_clip in the clear, scattered and mixed weather presets.
export const streetFarPlane=10000;
export const aerialSkylineRadius=5000;
export const streetNearPlane=.24;
export const overviewTerrainTileSize=512;

export function detailShardKey([column,row]:DetailCell){
  return `${Math.floor(column/detailCellSize)}_${Math.floor(row/detailCellSize)}`;
}

export function terrainSectorBounds(north:string,east:string):readonly [number,number,number,number]{
  const index=(key:string,negative:string)=>{
    const value=Number(key.slice(1));
    return key[0]===negative?-value:value-1;
  };
  const x=index(east,"w")*512,y=index(north,"s")*512;
  return [x,y,x+512,y+512];
}

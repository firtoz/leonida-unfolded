export const readableRoadMasks=new Set([
  "0xb11725aab8e6d7f7","0xa6dcaa392defc75d","0x94d956c40ec4818d","0x8fe1923a1292d897",
]);
export const roadDecalControl="0x3afee8bacbdbc1d6";
export const retroDecalControls=new Set(["0xbb415f79decfa9cb","0x6d4a52f89b2db258"]);
export const roadWeightPrefix="road-weights:";
export const elevatedRoadWeightPrefix=roadWeightPrefix+"elevated:";
export const projectedRoadWeightPrefix=roadWeightPrefix+"projected:";
export const roadHeightPrefix="road-height:";
export const roadControlPrefix="road-control:";
export const roadSurfacePrefix="road-surface:";
export const roadTintPrefix="road-tint:";
export const roadSurfaceTintPrefix="road-surface-tint:";
export const roadDetailFarDepth=15;
export type RoadHeightMip={width:number;height:number;channels:Uint8Array<ArrayBuffer>};
export function roadHeightBlueAlpha(rgba:Uint8ClampedArray){
  const channels=new Uint8Array(rgba.length/2);
  for(let i=0,at=2;i<channels.length;i+=2,at+=4){
    channels[i]=rgba[at];
    channels[i+1]=rgba[at+1];
  }
  return channels;
}
export type DecalLayers=[secondaryColor:string,control?:string];

export type RoadLayers={
  textures:[mask:string,red:string,green:string,blue:string,residual:string]|[red:string,green:string,blue:string,residual:string];
  vertexOnly?:true;
  maskUV?:3;
  useProjectedColor?:true;
  localVertexColor?:true;
  primaryLayers?:[number,number,number,number];
  primary:[number,number,number,number];
  secondary:[number,number,number,number];
  powers:[number,number,number,number];
  height?:{textures:[string|null,string|null,string|null,string|null];gain:RoadLayers["primary"];cutoff:RoadLayers["primary"];authored?:true};
  tint?:{texture:string;scale:RoadLayers["primary"];amount:RoadLayers["primary"];surfaceAlpha?:true;vertexAmount?:RoadLayers["primary"]};
  detail?:{textures:[string,string,string,string];u:RoadLayers["primary"];v:RoadLayers["primary"];strength:RoadLayers["primary"]};
  parallax?:{texture:string;origin:[number,number];strength:RoadLayers["primary"];center:RoadLayers["primary"];refine:RoadLayers["primary"]};
};

export type RoadVertices={
  uv:Float32Array<ArrayBuffer>;
  weights:Uint8Array<ArrayBuffer>;
};

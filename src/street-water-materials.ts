import { findTextureDescriptor } from "./layers";
import { linearBc16 } from "./texture";
import type { WaterDictionary } from "./street-water-resource";

type WaterMip={side:number;bytes:Uint8Array<ArrayBuffer>};
export type StreetWaterMaterials={bump:WaterMip[];foam:WaterMip[]};
const tileBytes=4096;

function unpackWaterMips(metadata:Uint8Array,graphics:Uint8Array,name:string,format:number,maxSide:number){
  const {width,height,format:actual,depth,dimension,layout,start,elements}=findTextureDescriptor(metadata,name);
  if(width!==height||width<64||width>1024||(width&(width-1))!==0||actual!==format||
    depth!==1||dimension!==1||layout!==5||start<0||start+elements*16>graphics.length)return;
  // The smallest mips share a tile. The separately padded 64 px and larger
  // levels follow it in increasing size.
  const levels:WaterMip[]=[];
  let offset=start+tileBytes;
  for(let side=64;side<=width;side*=2){
    const end=offset+side**2;
    if(end>start+elements*16)return;
    if(side<=maxSide)levels.unshift({side,bytes:linearBc16(graphics.subarray(offset,end),side,side)});
    offset=end;
  }
  return offset===start+elements*16?levels:undefined;
}

export function readStreetWaterMaterials({metadata,graphics}:WaterDictionary):StreetWaterMaterials|undefined{
  const bump=unpackWaterMips(metadata,graphics,"waterbump",77,256);
  const foam=unpackWaterMips(metadata,graphics,"waterfoam",98,512);
  if(bump?.length&&foam?.length)return {bump,foam};
}

export function uploadStreetWaterMips(gl:WebGL2RenderingContext,levels:WaterMip[],format:number|undefined){
  if(format===undefined)return;
  const texture=gl.createTexture();
  if(!texture)return;
  gl.bindTexture(gl.TEXTURE_2D,texture);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAX_LEVEL,levels.length-1);
  for(const [level,{side,bytes}] of levels.entries())
    gl.compressedTexImage2D(gl.TEXTURE_2D,level,format,side,side,0,bytes);
  return texture;
}

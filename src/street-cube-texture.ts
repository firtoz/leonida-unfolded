import { blockOffset, readTextureChunk, textureChunkSize, type Pack, type Texture } from "./texture";
import { packedMipBlockOrigin } from "./texture-pool-blocks";

export const streetInteriorCubePrefix="interior-cube:";
export const streetRoomCubeUnit=26;

export type StreetCubeTexture={
  format:"bc1-srgb"|"bc6h-unsigned";
  // Each level stores six faces in archive order, with linear block rows.
  levels:{side:number;blocks:Uint8Array<ArrayBuffer>}[];
};

function linearCubeFaces(bytes:Uint8Array,side:number,blockBytes:8|16,stride:number,offset:number,x0=0,y0=0){
  const columns=Math.ceil(side/4),faceBytes=columns*columns*blockBytes;
  const blocks=new Uint8Array(faceBytes*6);
  for(let face=0;face<6;face++){
    const origin=face*stride+offset;
    for(let y=0;y<columns;y++)for(let x=0;x<columns;x++){
      const source=origin+blockOffset(x+x0,y+y0,columns,blockBytes);
      const target=face*faceBytes+(y*columns+x)*blockBytes;
      blocks.set(bytes.subarray(source,source+blockBytes),target);
    }
  }
  return {side,blocks};
}

export async function readStreetCube(pack:Pack,texture:Texture):Promise<StreetCubeTexture|null>{
  const {width,height,start,end,tileMode,surface}=texture;
  if(tileMode!==12||surface?.dimension!==2||surface.depth!==6||width!==height||
    width<128||end-start!==Math.log2(width/64)+1||
    surface.mipLevels<end-start||surface.mipLevels>Math.log2(width)+1)return null;
  const format=surface.format===72?"bc1-srgb":surface.format===95?"bc6h-unsigned":undefined;
  if(!format)return null;
  const blockBytes=format==="bc1-srgb"?8:16;
  // Each face starts with a 4 KiB packed tail. BC6H stores its 64²
  // level in the next page because that level occupies a full page.
  // Larger rows contain an accumulated mip chain for each of the six faces.
  let lowerFaceBytes=blockBytes===8?4096:8192;
  const packedSize=lowerFaceBytes*6;
  if(textureChunkSize(pack,start)!==packedSize)return null;
  const tail=await readTextureChunk(pack,start,packedSize);
  if(!tail)return null;
  const levels:StreetCubeTexture["levels"]=[];
  const firstPackedSide=blockBytes===8?64:32;
  const smallestSide=width/2**(surface.mipLevels-1);
  for(let side=smallestSide;side<=firstPackedSide;side*=2){
    const [x,y]=packedMipBlockOrigin(7-Math.log2(firstPackedSide/side),blockBytes);
    levels.push(linearCubeFaces(tail,side,blockBytes,lowerFaceBytes,0,x,y));
  }
  if(blockBytes===16)levels.push(linearCubeFaces(tail,64,blockBytes,lowerFaceBytes,4096));
  for(let row=start+1,side=128;row<end;row++,side*=2){
    const columns=side/4,faceBytes=columns*columns*blockBytes;
    const stride=lowerFaceBytes+faceBytes,total=stride*6;
    const chunkBytes=textureChunkSize(pack,row);
    if(chunkBytes!==total&&chunkBytes!==Math.ceil(total/65536)*65536)return null;
    const bytes=await readTextureChunk(pack,row,chunkBytes);
    if(!bytes||bytes.subarray(total).some(byte=>byte!==0))return null;
    levels.push(linearCubeFaces(bytes,side,blockBytes,stride,lowerFaceBytes));
    lowerFaceBytes=stride;
  }
  return {format,levels:levels.reverse()};
}

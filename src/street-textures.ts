import { opaqueMaterialBTexture } from "./street-material-constants";
import { inflate, view, type Archive } from "./archive";
import { decodeBcpackBc1 } from "./bcpack";
import { readableRoadMasks, retroDecalControls, roadDecalControl, roadWeightPrefix, elevatedRoadWeightPrefix, projectedRoadWeightPrefix, roadHeightPrefix, roadControlPrefix, roadSurfacePrefix, roadTintPrefix, roadSurfaceTintPrefix, roadHeightBlueAlpha, type RoadHeightMip } from "./street-road-material";
import { streetSignFontPack, streetSignFontTexture } from "./street-sign-font";
import { detailAtlasSlicePrefix, roomGlassTexturePrefix, signGlyphPrefix, terrainTexturePrefix, waterScumTexturePrefix, type StreetBlockTexture, type StreetTextureImage } from "./street-terrain-material";
import { closeMaterialPrefix, compressedMaterialFormats, compressedRoadColorFormats, streetBudgets } from "./street-capacity";
import { bc1, blockOffset, loadPack, readMip, readTextureChunk, textureChunkSize, type Image, type Pack, type Texture } from "./texture";
import { detailAtlasPackPath, imposterAtlasPackPath, poolBlockFormat, readImposterBc1Mips, readImposterBc7Mips, readPoolBc1, readPoolBc1BlockChain, readPoolBc1Chain, readPoolBc4Top, readPoolBc16, readPoolBc7ArraySlice, readPoolBc7Chain, wideBc1Offset } from "./texture-pool-blocks";
import { readStreetCube } from "./street-cube-texture";

type ColorDecoder = {
  memory:WebAssembly.Memory;
  input:()=>number;
  output:()=>number;
  decode_bc3:(width:number,height:number)=>void;
  decode_bc7:(width:number,height:number)=>void;
};

let decoder:Promise<ColorDecoder>|undefined;
const bc7Order=Uint8Array.from({length:256},(_,i)=>{
  const x=i%16,y=i>>4;
  return (x&1)|((y&1)<<1)|((x&2)<<1)|((y&6)<<2)|((x&4)<<3)|((y&8)<<3)|((x&8)<<4);
});
const bc7LinearOrder=Uint8Array.from({length:256},(_,i)=>{
  const x=i%16,y=i>>4;
  return (y&3)|((x&3)<<2)|((y&4)<<2)|((x&4)<<3)|((y&8)<<3)|((x&8)<<4);
});
const bc7Tile64KOffsets=Uint16Array.from({length:4096},(_,block)=>{
  const order=[0,6,1,7,8,2,9,3,10,4,11,5];
  let address=0;
  for(let i=0;i<order.length;i++)address|=(block>>order[i]&1)<<i;
  return address*16;
});
const rgbaTile64KOffsets=Uint16Array.from({length:16384},(_,texel)=>{
  const order=[0,1,7,8,9,2,10,3,11,4,12,5,13,6];
  let address=0;
  for(let i=0;i<order.length;i++)address|=(texel>>order[i]&1)<<i;
  return address*4;
});

async function colorDecoder(){
  const response=await fetch(new URL("./night-decode.wasm",import.meta.url));
  if(!response.ok)throw new Error("Material decoder could not load");
  const {instance}=await WebAssembly.instantiate(await response.arrayBuffer());
  return instance.exports as unknown as ColorDecoder;
}

async function decodeMaterialBlocks(tiled:Uint8Array,width:number,height:number,mode:number,linear=mode===0x319||mode===0x318):Promise<Image>{
  const wasm=await (decoder??=colorDecoder());
  const memory=new Uint8Array(wasm.memory.buffer),offset=wasm.input();
  const columns=width/4,rows=height/4,tilePitch=Math.ceil(columns/16);
  const order=linear?bc7LinearOrder:bc7Order;
  const mappedTiles=!linear&&(width===height&&[64,128,256,512].includes(width)||
    mode===0x273&&height===2*width&&[64,128,256].includes(width)||
    mode===0x31b&&width===512&&height===128&&tiled.byteLength===131072);
  for(let y=0;y<rows;y++)for(let x=0;x<columns;x++){
    const tileX=x>>4,tileY=y>>4;
    const tile=(mappedTiles
      ?(tileY&1)|((tileX&1)<<1)|((tileY&2)<<1)|((tileX&2)<<2)|((tileX&4)<<2)|((tileY&4)<<3)
      :tileY*tilePitch+tileX)*4096;
    const source=tile+16*order[(y%16)*16+x%16];
    memory.set(tiled.subarray(source,source+16),offset+(y*columns+x)*16);
  }
  if(mode===0x273)wasm.decode_bc3(width,height);
  else wasm.decode_bc7(width,height);
  return {width,height,rgba:new Uint8ClampedArray(memory.slice(wasm.output(),wasm.output()+width*height*4).buffer)};
}

function supportedColor(mode:number){
  return [0x23b,0x240,0x241,0x243,0x273,0x318,0x319,0x31b].includes(mode);
}

function halfColor({width,height,rgba}:Image):Image{
  const w=width/2,h=height/2,out=new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const src=(2*y*width+2*x)*4,dst=(y*w+x)*4;
    for(let c=0;c<4;c++)out[dst+c]=(rgba[src+c]+rgba[src+4+c]+rgba[src+width*4+c]+rgba[src+width*4+4+c])/4;
  }
  return {width:w,height:h,rgba:out};
}

async function readColor(pack:Pack,texture:Texture,surface=false):Promise<Image|null>{
  const target=surface?512:streetBudgets.materialSide;
  const format=poolBlockFormat(texture);
  if(format===1&&texture.pack===imposterAtlasPackPath)return readPoolBc1(pack,texture,target,true);
  if(format===3||format===7){
    const source=await readPoolBc16(pack,texture,target,format);
    if(source)return decodePoolColor(source,format);
  }
  return (await readKnownColor(pack,texture,surface))??readPoolBc1(pack,texture,target,true);
}

async function decodePoolColor({width,height,blocks}:NonNullable<Awaited<ReturnType<typeof readPoolBc16>>>,format:3|7):Promise<Image>{
  const wasm=await (decoder??=colorDecoder());
  const paddedWidth=Math.ceil(width/4)*4,paddedHeight=Math.ceil(height/4)*4;
  const memory=new Uint8Array(wasm.memory.buffer);
  memory.set(blocks,wasm.input());
  if(format===3)wasm.decode_bc3(paddedWidth,paddedHeight);
  else wasm.decode_bc7(paddedWidth,paddedHeight);
  const rgba=new Uint8ClampedArray(width*height*4),start=wasm.output();
  for(let y=0;y<height;y++)rgba.set(memory.subarray(start+y*paddedWidth*4,start+(y*paddedWidth+width)*4),y*width*4);
  return {width,height,rgba};
}

async function decodeBc7Level(level:NonNullable<Awaited<ReturnType<typeof readPoolBc16>>>):Promise<Image>{
  // The WASM scratch buffer accepts at most 512 texels along either axis.
  const side=512;
  const {width,height,blocks}=level;
  if(width<=side&&height<=side)return decodePoolColor(level,7);
  const rgba=new Uint8ClampedArray(width*height*4),pitch=Math.ceil(width/4)*16;
  for(let y=0;y<height;y+=side)for(let x=0;x<width;x+=side){
    const w=Math.min(side,width-x),h=Math.min(side,height-y);
    const stride=Math.ceil(w/4)*16,rows=Math.ceil(h/4);
    const tile=new Uint8Array(stride*rows);
    for(let row=0;row<rows;row++){
      const offset=(y/4+row)*pitch+x/4*16;
      tile.set(blocks.subarray(offset,offset+stride),row*stride);
    }
    const image=await decodePoolColor({width:w,height:h,blocks:tile},7);
    for(let row=0;row<h;row++)rgba.set(image.rgba.subarray(row*w*4,(row+1)*w*4),((y+row)*width+x)*4);
  }
  return {width,height,rgba};
}

function decodePoolBc5({width,height,blocks}:NonNullable<Awaited<ReturnType<typeof readPoolBc16>>>):Image{
  return decodePoolBcChannels({width,height,blocks},2);
}

function decodePoolBcChannels({width,height,blocks}:{width:number;height:number;blocks:Uint8Array},channels:1|2):Image{
  const rgba=new Uint8ClampedArray(width*height*4),across=Math.ceil(width/4),data=view(blocks);
  const palette=new Uint8Array(8);
  for(let by=0;by<Math.ceil(height/4);by++)for(let bx=0;bx<across;bx++)for(let channel=0;channel<channels;channel++){
    const at=((by*across+bx)*channels+channel)*8,high=blocks[at],low=blocks[at+1],steps=high>low?7:5;
    palette[0]=high;palette[1]=low;
    for(let step=1;step<steps;step++){
      const value=((steps-step)*high+step*low)/steps;
      palette[step+1]=channels===1?Math.round(value):value;
    }
    if(steps===5){palette[6]=0;palette[7]=255;}
    for(let half=0;half<2;half++){
      const offset=at+2+half*3,indices=data.getUint16(offset,true)|blocks[offset+2]<<16;
      for(let i=0;i<8;i++){
        const x=bx*4+(i&3),y=by*4+2*half+(i>>2);
        if(x>=width||y>=height)continue;
        const pixel=(y*width+x)*4;
        rgba[pixel+channel]=palette[(indices>>(3*i))&7];
        rgba[pixel+3]=255;
      }
    }
  }
  return {width,height,rgba};
}

async function readKnownColor(pack:Pack,texture:Texture,surface=false):Promise<Image|null>{
  const block16=texture.mode===0x31b||texture.mode===0x319||texture.mode===0x273;
  if(!supportedColor(texture.mode))return null;
  if(texture.mode===0x240)return (await readKnownGroundColor(pack,texture,true))??
    (texture.surface?.mipLevels===1?null:readPackedBc1(pack,texture));
  if(texture.mode===0x241&&texture.tileMode===0&&texture.mipCount===1&&
    texture.width===512&&texture.height===512&&texture.end===texture.start+1){
    const size=512*512/2;
    if(textureChunkSize(pack,texture.start)!==size)return null;
    const raw=await readTextureChunk(pack,texture.start,size);
    return raw?bc1Tiles64K(raw,512,512,true):null;
  }
  if(texture.mode===0x243&&texture.tileMode===0&&texture.width===1024&&texture.height===2048){
    const {start,end}=texture,row=end-3;
    // The 256×512 mip uses two pages with half of each page padded.
    if(end===start+4&&textureChunkSize(pack,row)===131072&&
      textureChunkSize(pack,row+1)===262144&&textureChunkSize(pack,row+2)===1048576){
      const raw=await readTextureChunk(pack,row,131072).catch(()=>null);
      if(raw)return bc1Tiles64K(raw,256,512,true);
    }
  }
  if(texture.mode===0x318){
    const {width,height,start,end}=texture;
    if(end!==start+1)return null;
    const standard=height===64&&(width===64||width===128);
    const bytes=standard?width*height*2:textureChunkSize(pack,start);
    if(!standard&&(texture.tileMode!==1||texture.surface?.format!==99||texture.surface.dimension!==1||texture.surface.depth!==1||
      width<4||height<4||width>64||height>64||width%4||height%4||
      (bytes!==4096&&bytes!==8192)))return null;
    const raw=await readTextureChunk(pack,start,bytes);
    if(raw?.length!==bytes)return null;
    // Compact BC7 stores the top tile in the second half of the mip row.
    const top=raw.subarray(bytes/2);
    if(!standard)for(let y=0;y<height/4;y++)for(let x=0;x<width/4;x++){
      const block=16*bc7LinearOrder[y*16+x];
      if(block+16>top.length||!top[block])return null;
    }
    return decodeMaterialBlocks(top,width,height,texture.mode);
  }
  const linearBc3=texture.mode===0x273&&texture.width===2*texture.height&&texture.width<=1024&&
    (texture.tileMode===2||texture.tileMode===3);
  if(texture.mode===0x273&&texture.width!==texture.height&&
    !(texture.width===256&&texture.height===512)&&!linearBc3)return null;
  if(texture.mode===0x31b&&texture.width===2048&&texture.height===512){
    // The 512×128 level occupies 8×4 tiles, including two padded tile rows.
    const size=131072;
    for(let row=texture.end-1;row>texture.start;row--){
      if(textureChunkSize(pack,row)!==size)continue;
      try{
        const raw=await readTextureChunk(pack,row,size);
        if(raw)return decodeMaterialBlocks(raw,512,128,texture.mode);
      }catch{
        // Try the standard levels below if this packed mip is unreadable.
      }
    }
  }
  // Mode 0x243 can store complete 512×256 BC1 pages instead of a 4 KiB layout.
  const bc1Pages=texture.mode===0x243&&texture.tileMode===0&&texture.width>=512&&texture.height>=256;
  const linearBc7=texture.mode===0x319||texture.mode===0x31b&&(texture.tileMode===2||texture.tileMode===3);
  const limit=surface||bc1Pages||texture.mode===0x241||linearBc7?512:streetBudgets.materialSide;
  // Use separate mip streams. A small-mip tail can have the same padded size
  // as a standalone level, so try later streams first for each size.
  const levels:{width:number;height:number}[]=[];
  let larger:{width:number;height:number}|undefined;
  for(let width=texture.width,height=texture.height;width>=4&&height>=4;width>>=1,height>>=1){
    if(width>512||height>512||width%4||height%4)continue;
    if(width>limit||height>limit){larger={width,height};continue;}
    if(width<Math.min(texture.width,64)&&height<Math.min(texture.height,64))break;
    levels.push({width,height});
  }
  if(larger)levels.push(larger);
  for(const level of levels){
    const {width,height}=level;
    if(bc1Pages&&(width%512||height%256))continue;
    const size=Math.ceil(width/(block16?64:128))*Math.ceil(height/64)*4096;
    for(let row=texture.end-1;row>texture.start;row--){
      if(textureChunkSize(pack,row)!==size)continue;
      try{
        const raw=await readTextureChunk(pack,row,size);
        if(raw){
          const image=block16?await decodeMaterialBlocks(raw,width,height,texture.mode,linearBc7||linearBc3):
            bc1Pages?bc1Tiles64K(raw,width,height,true):bc1(raw,width,height,true);
          return level===larger?halfColor(image):image;
        }
      }catch{
        // A missing or unreadable texture falls back to the viewer material.
      }
    }
  }
  // A tiled road color can have BCPack intermediate levels and a readable
  // standalone top level. Decode the latter at a bounded resident size.
  if(surface&&bc1Pages&&texture.width===2048&&texture.height===2048){
    const size=2048*2048/2,row=texture.end-1;
    if(textureChunkSize(pack,row)===size){
      const raw=await readTextureChunk(pack,row,size);
      if(raw)return halfColor(halfColor(bc1Tiles64K(raw,2048,2048,true)));
    }
  }
  // Only use packed BC1 fallback as colour when the descriptor declares sRGB.
  // Linear tail controls include masks with independent colour channels.
  return (texture.mode>>3)===72?readPackedBc1(pack,texture):null;
}

function packedBc1Layout(pack:Pack,texture:Texture){
  if(![1,2,3].includes(texture.tileMode)||texture.mipCount<2)return;
  const levels=[];
  for(let i=0;i<texture.mipCount;i++){
    const width=Math.max(1,texture.width>>i),height=Math.max(1,texture.height>>i);
    const columns=Math.ceil(width/4),rows=Math.ceil(height/4);
    const compact=columns<=16&&rows<=16&&texture.mipCount-i<=8;
    levels.push({width,height,columns,rows,compact});
  }
  const firstCompact=levels.findIndex(level=>level.compact);
  if(firstCompact<0)return;
  const layout=levels.map((level,i)=>({
    ...level,
    size:level.compact?4096:Math.ceil(level.columns/32)*Math.ceil(level.rows/16)*4096,
    address:0,index:i,
  }));
  let address=4096;
  for(let i=firstCompact-1;i>=0;i--){
    layout[i].address=address;
    address+=layout[i].size;
  }
  const start=pack.addresses[texture.start];
  const end=pack.addresses[texture.end]??pack.eofAddress;
  if(start+address!==end)return;
  return layout.map(({compact,index,...level})=>{
    const n=7-(index-firstCompact),offset=n===7?2048:n*256;
    return {...level,compact,address:start+level.address,
      x:compact?8*((offset>>9&1)|(offset>>10&2)):0,
      y:compact?4*((offset>>8&1)|(offset>>9&2)):0,
    };
  });
}

async function readPackedBc1(pack:Pack,texture:Texture):Promise<Image|null>{
  const layout=packedBc1Layout(pack,texture);
  if(!layout)return null;
  for(const {width,height,columns,rows,address,size,x,y,compact} of layout){
    if(width>512||height>512)continue;
    if(compact&&(x+columns>32||y+rows>16))continue;
    const mipEnd=address+size;
    for(let row=texture.start;row<texture.end;row++){
      const chunkStart=pack.addresses[row],chunkSize=textureChunkSize(pack,row);
      if(chunkStart>address||chunkStart+chunkSize<mipEnd)continue;
      try{
        const data=await readTextureChunk(pack,row,512*1024);
        if(!data)break;
        const at=address-chunkStart;
        return bc1(data.subarray(at,at+size),width,height,true,x,y);
      }catch{
        break;
      }
    }
  }
  return null;
}

function bc1Tiles64K(raw:Uint8Array,width:number,height:number,keepAlpha=false,blockX=0){
  // A 64 KiB BC1 tile contains 128 by 64 blocks.
  const columns=width/4,rows=height/4,pitch=Math.ceil(columns/128);
  const tiled4k=new Uint8Array(Math.ceil(columns/32)*Math.ceil(rows/16)*4096);
  for(let y=0;y<rows;y++)for(let x=0;x<columns;x++){
    const source=wideBc1Offset(x+blockX,y,pitch);
    tiled4k.set(raw.subarray(source,source+8),blockOffset(x,y,columns,8));
  }
  return bc1(tiled4k,width,height,keepAlpha);
}

function packedWideWeights({width,height,mode,tileMode,start,end,mipCount}:Texture){
  const square=width===height&&(width===1024||width===2048);
  const rectangular=height===2048&&(width===512||width===1024)&&mipCount===1;
  return mode===0x239&&tileMode===0&&end===start+1&&(square||rectangular);
}

async function readWideWeightBlocks(pack:Pack,texture:Texture){
  if(!packedWideWeights(texture))return null;
  const {width,height,start}=texture;
  const size=width*height/2;
  return textureChunkSize(pack,start)===size?readTextureChunk(pack,start,size,decodeBcpackBc1):null;
}

async function readRoadMask(pack:Pack,texture:Texture):Promise<Image|null>{
  const {width,height,mode,start,end}=texture;
  const large=mode===0x239&&(width===512||width===1024)&&height===2048;
  if(!large&&!(mode===0x23b&&width===256&&height===1024))return null;
  const size=width*height/2;
  for(let row=end-1;row>=start;row--){
    if(textureChunkSize(pack,row)!==size)continue;
    const raw=await readTextureChunk(pack,row,size);
    if(!raw||raw.length!==size)continue;
    return large?bc1Tiles64K(raw,width,height):bc1(raw,width,height);
  }
  return null;
}

async function readTiledBc7(pack:Pack,row:number,width:number,height:number,offset=0):Promise<Image|null>{
  const side=256,tileSize=65536;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<=0||height<=0||
    width>2048||height>2048||width%side||height%side)return null;
  const size=width*height;
  const chunkSize=size+offset;
  if(textureChunkSize(pack,row)!==chunkSize)return null;
  const chunk=await readTextureChunk(pack,row,chunkSize);
  if(!chunk||chunk.length!==chunkSize)return null;
  return decodeBc7Tiles64K(chunk.subarray(offset),width,height);
}

async function decodeBc7Tiles64K(tiled:Uint8Array,width:number,height:number,blockX=0):Promise<Image>{
  const side=256,tileSize=65536;
  const wasm=await (decoder??=colorDecoder());
  const memory=new Uint8Array(wasm.memory.buffer),input=wasm.input(),output=wasm.output();
  const rgba=new Uint8ClampedArray(width*height*4);
  // Decode one tile or the compact mip inside it to fit the WASM scratch buffers.
  for(let y=0;y<height;y+=side)for(let x=0;x<width;x+=side){
    const tile=y/side*(width/side)+x/side;
    const w=Math.min(side,width-x),h=Math.min(side,height-y),columns=w/4;
    for(let by=0;by<h/4;by++)for(let bx=0;bx<columns;bx++){
      const address=tile*tileSize+bc7Tile64KOffsets[by*64+bx+blockX];
      memory.set(tiled.subarray(address,address+16),input+(by*columns+bx)*16);
    }
    wasm.decode_bc7(w,h);
    for(let line=0;line<h;line++){
      const start=output+4*w*line;
      rgba.set(memory.subarray(start,start+4*w),4*((y+line)*width+x));
    }
  }
  return {width,height,rgba};
}

async function readRgbaTiles64K(pack:Pack,row:number,side:number):Promise<Image|null>{
  const size=side*side*4;
  if(textureChunkSize(pack,row)!==size)return null;
  const raw=await readTextureChunk(pack,row,size);
  if(!raw)return null;
  const rgba=new Uint8ClampedArray(size);
  const pitch=side/128;
  for(let y=0;y<side;y++)for(let x=0;x<side;x++){
    const tile=(y>>7)*pitch+(x>>7);
    const source=tile*65536+rgbaTile64KOffsets[(y&127)*128+(x&127)];
    const dest=(y*side+x)*4;
    rgba[dest]=raw[source];
    rgba[dest+1]=raw[source+1];
    rgba[dest+2]=raw[source+2];
    rgba[dest+3]=raw[source+3];
  }
  return {width:side,height:side,rgba};
}

function glyphCoverage(distance:number){
  const edge=Math.max(0,Math.min(1,(distance-120)/16));
  return 255*edge*edge*(3-2*edge);
}

async function readSignGlyph(pack:Pack,texture:Texture):Promise<StreetTextureImage|null>{
  const {width,height,mode,tileMode,start,end,surface}=texture;
  if(!surface||surface.dimension!==1||surface.depth!==1||surface.mipLevels!==1||end!==start+1)return null;
  if(surface.format===80){
    const level=await readPoolBc4Top(pack,texture);
    if(!level)return null;
    const {rgba}=decodePoolBcChannels(level,1);
    for(let at=0;at<rgba.length;at+=4){
      rgba[at+3]=glyphCoverage(rgba[at]);
      rgba[at]=rgba[at+1]=rgba[at+2]=255;
    }
    return {width,height,rgba,alphaCutout:true};
  }
  if(surface.format!==28)return null;
  const layout=mode===0xe0&&tileMode===1
    ?width===128&&height===64?[[0,1,5,7,9,10,11],[2,3,4,6,8,12]]:
      width===64&&(height===64||height===128)
        ?[[0,1,5,7,9,10],[2,3,4,6,8,11,...(height===128?[12]:[])]]:undefined
    :mode===0xe1&&tileMode===0&&width===height&&(width===256||width===512)
      ?[[0,1,4,7,9,11,13,14,...(width===512?[16]:[])],
        [2,3,5,6,8,10,12,15,...(height===512?[17]:[])]]:undefined;
  if(!layout)return null;
  const size=width*height*4;
  if(textureChunkSize(pack,start)!==size)return null;
  const raw=await readTextureChunk(pack,start,size);
  if(!raw)return null;
  const offsets=(length:number,bits:number[])=>Uint32Array.from({length},(_,coordinate)=>
    bits.reduce((offset,bit,index)=>offset|((coordinate>>index)&1)<<bit,0));
  const columns=offsets(width,layout[0]),rows=offsets(height,layout[1]);
  const rgba=new Uint8ClampedArray(size).fill(255);
  // The RGB channels carry the same signed distance. Convert it to coverage
  // before mip generation so small signs keep the average glyph opacity.
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const distance=raw[(rows[y]|columns[x])*4];
    rgba[(y*width+x)*4+3]=glyphCoverage(distance);
  }
  return {width,height,rgba,alphaCutout:true};
}

export async function readTerrainLayerInput(
  pack:Pack,texture:Texture,role:"weights"|"height"|"normal"|"indices",
):Promise<Image|null>{
  const {mode,width,height,start,end,tileMode}=texture;
  if(role==="normal"&&texture.surface?.format===71&&texture.surface.dimension===1&&texture.surface.depth===1){
    // Authored linear BC1 bump maps store tangent X and Y in red and green.
    return readColor(pack,texture);
  }
  if(role==="normal"&&texture.surface?.format===98){
    const source=await readPoolBc16(pack,texture,Math.max(width,height),7);
    return source?decodeBc7Level(source):null;
  }
  if(role==="normal"&&poolBlockFormat(texture)===5){
    const source=await readPoolBc16(pack,texture,512,5);
    return source?decodePoolBc5(source):null;
  }
  if(role==="weights"&&width===4&&height===4&&tileMode===1&&texture.mipCount===2&&end===start+1&&
    (mode===0x208||mode===0x240)&&textureChunkSize(pack,start)===4096){
    const raw=await readTextureChunk(pack,start,4096);
    if(!raw)return null;
    if(mode===0x240)return bc1(raw,4,4,true);
    const rgba=new Uint8ClampedArray(4*4*4);
    for(let y=0;y<4;y++)for(let x=0;x<4;x++){
      const to=(y*4+x)*4;
      rgba[to]=raw[y*16+x];
      rgba[to+3]=255;
    }
    return {width,height,rgba};
  }
  if(role==="weights"&&mode===0x239&&tileMode===0&&end===start+1){
    const raw=await readWideWeightBlocks(pack,texture);
    return raw?bc1Tiles64K(raw,width,height):null;
  }
  if(role==="height"&&mode===0x313&&tileMode===0&&width!==height&&
    width%256===0&&height%256===0&&textureChunkSize(pack,end-1)===width*height){
    // Standalone rectangular BC7 mips follow the compact tail. Verify the
    // adjacent half-size page against both dimensions before choosing it.
    if(Math.max(width,height)>1024&&width%512===0&&height%512===0&&
      end-start>1&&textureChunkSize(pack,end-2)===width*height/4)
      return readTiledBc7(pack,end-2,width/2,height/2);
    return readTiledBc7(pack,end-1,width,height);
  }
  if(role==="height"&&width!==height&&mode===0x23b&&tileMode===3&&
    texture.surface?.format===71&&texture.surface.dimension===1&&texture.surface.depth===1)
    return readPoolBc1(pack,texture,Math.max(width,height),true);
  if(width!==height||(tileMode!==0&&mode!==0x23b))return null;
  if(role==="indices")
    return mode===0xe1&&width===1024&&end===start+1?readRgbaTiles64K(pack,start,width):null;
  if(role==="weights")
    return mode===0x311&&width===2048&&end===start+1?readTiledBc7(pack,start,width,height):null;
  if(mode===0xe3&&width===512&&end===start+4){
    const row=start+2;
    if(pack.addresses[row]-pack.addresses[start]!==131072)return null;
    return readRgbaTiles64K(pack,row,256);
  }
  if(role==="height"&&mode===0xe3&&width===1024&&end===start+4){
    // The compact tail is followed by separate 256², 512² and 1024² RGBA levels.
    const row=start+1;
    if(textureChunkSize(pack,start)!==131072||textureChunkSize(pack,row+1)!==512*512*4||
      textureChunkSize(pack,row+2)!==1024*1024*4)return null;
    return readRgbaTiles64K(pack,row,256);
  }
  if(mode===0x313&&[1024,2048].includes(width)){
    // The 2048² layout can store the tail and 256² mip in one stream.
    if(width===2048&&texture.mipCount===8&&end===start+4){
      const image=await readTiledBc7(pack,start,256,256,65536);
      if(image)return image;
    }
    // The top level and separate intermediate levels follow the compact tail.
    let offset=65536;
    for(let side=256;side<=Math.min(width,role==="normal"?512:width);side*=2){
      const row=pack.addresses.indexOf(pack.addresses[start]+offset,start);
      if(row>start&&row<end){
        const image=await readTiledBc7(pack,row,side,side);
        if(image)return image;
      }
      offset+=side*side;
    }
    // The terrain descriptor's legacy mipCount field is the packed count plus one.
    if(width===1024&&texture.mipCount===7&&end===start+4&&textureChunkSize(pack,start)===65536){
      const tail=await readTextureChunk(pack,start,65536);
      if(tail)return decodeBc7Tiles64K(tail,128,128,32);
    }
  }
  if(mode===0x23b&&tileMode===0&&width===2048&&texture.mipCount===8&&end===start+4&&
    textureChunkSize(pack,start)===65536){
    const tail=await readTextureChunk(pack,start,65536);
    if(tail)return bc1Tiles64K(tail,256,256,true,64);
  }
  if(mode===0x23b&&tileMode===2){
    // Some layered height maps store every level in BCPack. Read the separate
    // 512² mip when its address follows the compact tail and 256² mip.
    const middle=start+2,middleBytes=512*512/2;
    if(width===1024&&texture.mipCount===7&&end===start+4&&
      pack.codecs[middle]===4&&pack.addresses[middle]-pack.addresses[start]===12288+32768&&
      textureChunkSize(pack,middle)===middleBytes){
      const data=await readTextureChunk(pack,middle,middleBytes,decodeBcpackBc1);
      if(data)return bc1(data,512,512,true);
    }
    const row=end-1,size=width*height/2;
    if((width===1024||width===2048)&&textureChunkSize(pack,row)===size){
      const raw=await readTextureChunk(pack,row,size);
      if(raw){
        let image=bc1(raw,width,height,true);
        while(image.width>512)image=halfColor(image);
        return image;
      }
    }
    return readPackedBc1(pack,texture);
  }
  return null;
}

async function readDecalControl(pack:Pack,texture:Texture):Promise<Image|null>{
  if(retroDecalControls.has(texture.id)){
    // The 1024² linear BC1 top level is stored after the smaller mips in its own stream.
    const {mode,width,height,start,end}=texture;
    const row=end-1,size=524288;
    if(mode!==0x23b||width!==1024||height!==1024||row<=start||
      pack.addresses[row]-pack.addresses[start]!==176128||textureChunkSize(pack,row)!==size)return null;
    const raw=await readTextureChunk(pack,row,size);
    return raw?.length===size?bc1(raw,width,height,true):null;
  }
  const tileSize=65536,side=256;
  if(texture.mode!==0x313||texture.width!==1024||texture.height!==1024||
    texture.end<texture.start+2||pack.addresses[texture.start+1]!==pack.addresses[texture.start]+tileSize)return null;
  // The separate 256×256 BC7 mip occupies one 64 KiB tile of 64×64 blocks.
  return readTiledBc7(pack,texture.start+1,side,side);
}

function findTexture({descriptors}:Pack,id:string){
  let start=0,end=descriptors.length;
  while(start<end){
    const middle=(start+end)>>>1;
    if(descriptors[middle].id<id)start=middle+1;
    else end=middle;
  }
  const texture=descriptors[start];
  return texture?.id===id?texture:undefined;
}

async function authoredTerrainMips(pack:Pack,texture:Texture):Promise<StreetTextureImage|null>{
  if(texture.surface?.mipLevels===undefined)return null;
  let levels:Image[]|null=null;
  if(poolBlockFormat(texture)===1)levels=await readPoolBc1Chain(pack,texture);
  else if(texture.surface.format===98){
    const blocks=await readPoolBc7Chain(pack,texture,98);
    if(blocks){
      levels=[];
      for(const level of blocks)levels.push(await decodeBc7Level(level));
    }
  }
  if(!levels?.length)return null;
  const [base,...authoredMips]=levels;
  return authoredMips.length?{...base,authoredMips}:{...base,baseLevelOnly:true};
}

async function groundColor(pack:Pack,texture:Texture,keepAlpha=false):Promise<Image|null>{
  return (await readPoolBc1(pack,texture,keepAlpha?512:1024,keepAlpha))??readKnownGroundColor(pack,texture,keepAlpha);
}

async function readKnownGroundColor(pack:Pack,texture:Texture,keepAlpha:boolean):Promise<Image|null>{
  if(texture.width!==texture.height)return null;
  if(texture.mode===0x243){
    const mip=await readMip(pack,texture,1024);
    return mip?bc1(mip.data,mip.side,mip.side):null;
  }
  if(texture.mode!==0x240||texture.width!==128||texture.end!==texture.start+1)return null;
  const row=texture.start;
  const size=12288,bytes=await readTextureChunk(pack,row,size);
  // The first page packs the small mips. The last two pages contain the top level.
  return bytes?.length===size?bc1(bytes.subarray(4096),128,128,keepAlpha):null;
}

function closeColorFormat(texture:Texture){
  const {mode,width,height,tileMode,mipCount,start,end}=texture;
  if(Math.max(width,height)!==1024||Math.min(width,height)<128||mipCount<2||end<=start+1)return;
  if(mode===0x31b&&width===1024&&(tileMode===0&&height===1024||tileMode===2&&height===512))return "bc7";
  if((mode===0x243||mode===0x23b)&&(tileMode===2||tileMode===3)&&width%128===0&&height%64===0)return "bc1";
}

async function readCloseColor(pack:Pack,texture:Texture):Promise<Image|null>{
  const {width,height,end}=texture,format=closeColorFormat(texture);
  if(!format)return null;
  const row=end-1;
  if(format==="bc7"){
    if(texture.tileMode===0)return readTiledBc7(pack,row,width,height);
    return readWideBc7(pack,texture);
  }
  const size=width*height/2;
  if(textureChunkSize(pack,row)!==size)return null;
  const raw=await readTextureChunk(pack,row,size);
  return raw?bc1(raw,width,height,true):null;
}

async function readWideBc7(pack:Pack,{width,height,end,mode}:Texture):Promise<Image|null>{
  const size=width*height,row=end-1;
  if(textureChunkSize(pack,row)!==size)return null;
  const tiled=await readTextureChunk(pack,row,size);
  if(!tiled)return null;
  const slice=512,rgba=new Uint8ClampedArray(size*4);
  // Decode two 512-pixel columns for the existing WASM scratch size.
  for(let left=0;left<width;left+=slice){
    const tiles=new Uint8Array(slice*height),tileRowBytes=slice*64;
    for(let y=0;y<height/64;y++){
      const from=y*width*64+left*64;
      tiles.set(tiled.subarray(from,from+tileRowBytes),y*tileRowBytes);
    }
    const column=await decodeMaterialBlocks(tiles,slice,height,mode,true);
    for(let y=0;y<height;y++)
      rgba.set(column.rgba.subarray(y*slice*4,(y+1)*slice*4),(y*width+left)*4);
  }
  return {width,height,rgba};
}

async function readCompressedCloseColor(pack:Pack,texture:Texture,supported:number):Promise<StreetBlockTexture|null>{
  const format=closeColorFormat(texture);
  if(!format||!(supported&compressedMaterialFormats[format]))return null;
  const levels:StreetBlockTexture["levels"]=[];
  const blockBytes=format==="bc1"?8:16;
  const linearBc7=format==="bc7"&&texture.tileMode===2;
  for(let level=0;level<3;level++){
    const width=texture.width>>level,height=texture.height>>level,row=texture.end-level-1;
    const columns=width/4,rows=height/4,size=columns*rows*blockBytes;
    const aligned=format==="bc1"?width%128===0&&height%64===0:
      linearBc7?width%64===0&&height%64===0:width%256===0&&height%256===0;
    if(row<=texture.start||!aligned||textureChunkSize(pack,row)!==size)break;
    const tiled=await readTextureChunk(pack,row,size);
    if(!tiled)break;
    // WebGL expects the original BC blocks in row order. Repack the Xbox tiles
    // without decoding to RGBA or replacing the authored mip levels.
    const blocks=new Uint8Array(size);
    for(let y=0;y<rows;y++)for(let x=0;x<columns;x++){
      const at=format==="bc1"?blockOffset(x,y,columns,8):
        linearBc7?((y>>4)*(columns>>4)+(x>>4))*4096+16*bc7LinearOrder[(y&15)*16+(x&15)]:
        ((y>>6)*(columns>>6)+(x>>6))*65536+bc7Tile64KOffsets[(y&63)*64+(x&63)];
      blocks.set(tiled.subarray(at,at+blockBytes),(y*columns+x)*blockBytes);
    }
    levels.push({width,height,blocks});
  }
  return levels.length>=2?{format,levels}:null;
}

function bc1AlphaCutout(blocks:Uint8Array){
  const data=view(blocks);
  let clear=false,visible=false;
  for(let at=0;at<blocks.length;at+=8){
    if(data.getUint16(at,true)<=data.getUint16(at+2,true)){
      const indices=data.getUint32(at+4,true);
      const transparency=indices&(indices>>>1)&0x55555555;
      clear||=transparency!==0;
      visible||=transparency!==0x55555555;
    }else visible=true;
    if(clear&&visible)return true;
  }
  return false;
}

async function readCompressedBaseColor(pack:Pack,texture:Texture):Promise<StreetBlockTexture|null>{
  const {width,height,mode,tileMode,start,end}=texture;
  if(mode!==0x243||tileMode!==2&&tileMode!==3||
    ![256,512,1024].includes(width)||![256,512,1024].includes(height))return null;
  const preferred=Math.min(Math.max(width,height),streetBudgets.materialSide);
  const layout=packedBc1Layout(pack,texture)?.filter(mip=>mip.width<=preferred&&mip.height<=preferred);
  if(!layout?.length||Math.max(layout[0].width,layout[0].height)!==preferred||
    Math.max(layout.at(-1)!.width,layout.at(-1)!.height)>16)return null;
  const levels:StreetBlockTexture["levels"]=[];
  const data=new Map<number,Uint8Array>();
  for(const mip of layout){
    const {width,height,columns,rows,address,size,x:originX,y:originY,compact}=mip;
    if(compact&&(originX+columns>32||originY+rows>16))return null;
    let row=start;
    while(row<end&&pack.addresses[row]+textureChunkSize(pack,row)<address+size)row++;
    if(row===end||pack.addresses[row]>address||!levels.length&&(row===start||textureChunkSize(pack,row)!==size))return null;
    let bytes=data.get(row);
    if(!bytes){
      const raw=await readTextureChunk(pack,row,512*1024);
      if(!raw)return null;
      bytes=raw;data.set(row,bytes);
    }
    const startInPage=address-pack.addresses[row];
    const tiled=bytes.subarray(startInPage,startInPage+size),blocks=new Uint8Array(columns*rows*8);
    for(let y=0;y<rows;y++)for(let x=0;x<columns;x++){
      const at=blockOffset(x+originX,y+originY,columns,8);
      blocks.set(tiled.subarray(at,at+8),(y*columns+x)*8);
    }
    levels.push({width,height,blocks});
  }
  return {format:"bc1",levels,alphaCutout:bc1AlphaCutout(levels[0].blocks)};
}

export function isStreetTexturePack(path:string){
  return path.startsWith("data/ttdb/maps/")||path.startsWith("data/ttdb/props/")||path.startsWith("data/ttdb/interiors/");
}

const compactMaskPackPath="data/ttdb/weapons/ttdb_weapons.ttpf";
const compactMaskKeys=new Set(["0x3fb347dace547ef9","0xa73870c6f65968be",opaqueMaterialBTexture]);

// Five consecutive zlib pages of the EDUP texture alias table in the optional archive.
const duplicateTexturePages=[
  [0xb6ca000,0xd1cf],[0xb6d71d0,0xd26d],[0xb6e4440,0xd1ad],[0xb6f15f0,0xd076],[0xb6fe670,0xf753],
] as const;
async function textureAliases(archive:Archive){
  const [base]=duplicateTexturePages[0], [end,length]=duplicateTexturePages.at(-1)!;
  const raw=await archive.read(base,end+length-base);
  const table=new Uint8Array(duplicateTexturePages.length*65536);
  for(const [page,[offset,stored]] of duplicateTexturePages.entries()){
    const content=inflate(raw.subarray(offset-base,offset-base+stored),65536);
    if(content.length!==65536)return;
    table.set(content,page*65536);
  }
  const meta=view(table),count=meta.getUint32(4,true);
  if(meta.getUint32(0,false)!==0x45445550||count!==17431||8+16*count>table.length)return;
  const aliases=new Map<string,string>();
  let previous=0n;
  const id=(key:bigint)=>"0x"+key.toString(16).padStart(16,"0");
  for(let i=0;i<count;i++){
    const at=8+i*16,alias=meta.getBigUint64(at,true),target=meta.getBigUint64(at+8,true);
    if(alias<=previous||!target)return;
    aliases.set(id(alias),id(target));
    previous=alias;
  }
  return aliases;
}

export class StreetTextures {
  private readonly sourcePacks=new Map<Archive,Promise<Pack|null>>();
  private readonly routes=new Map<Archive,{shard:number;mask:number}>();
  private readonly materialSources:Archive[];
  private readonly terrainSources:Archive[];
  private aliases?:ReturnType<typeof textureAliases>;
  constructor(private readonly archives:Map<string,Archive>,terrainPacks:Map<string,Pack>,profiled?:ReadonlySet<Archive>,
    private readonly verify?:(archive:Archive)=>Promise<void>){
    const sources=[...archives.values()];
    this.terrainSources=[...Array.from(terrainPacks.values(),pack=>pack.source),...sources.filter(archive=>
      archive.path.startsWith("data/ttdb/terrain/")&&!terrainPacks.has(archive.path))];
    this.materialSources=[...sources.filter(archive=>isStreetTexturePack(archive.path)),...this.terrainSources];
    for(const pack of terrainPacks.values())this.sourcePacks.set(pack.source,Promise.resolve(pack));
    // The build's fingerprinted numbered packs follow the native ID mask.
    // Additional user-supplied packs keep the ordinary catalog lookup.
    for(const source of profiled??[]){
      const suffix=/_(\d+)_(\d+)\.ttpf$/.exec(source.path);
      if(!suffix)continue;
      const shard=Number(suffix[1]),mask=Number(suffix[2]);
      if(mask>0&&mask<=255&&shard<=mask&&(mask&(mask+1))===0)this.routes.set(source,{shard,mask});
    }
  }

  private async aliasFor(key:string){
    const archive=this.archives.get("textures.rpf");
    if(!archive)return;
    this.aliases??=(async()=>{await this.verify?.(archive);return textureAliases(archive);})().catch(()=>undefined);
    return (await this.aliases)?.get(key);
  }

  private pack(source:Archive){
    let pack=this.sourcePacks.get(source);
    if(!pack){
      pack=(async()=>{await this.verify?.(source);return loadPack(source);})().catch(()=>null);
      this.sourcePacks.set(source,pack);
    }
    return pack;
  }

  private candidatePacks(key:string,ground=false){
    const lowByte=/^0x[0-9a-f]{16}$/.test(key)?Number.parseInt(key.slice(-2),16):undefined;
    const sources=ground?this.terrainSources:this.materialSources;
    const candidates=sources.filter(source=>{
      const route=this.routes.get(source);
      return !route||lowByte===undefined||(lowByte&route.mask)===route.shard;
    });
    return Promise.all(candidates.map(source=>this.pack(source)));
  }

  private async findSource(key:string){
    let fallback:{pack:Pack;texture:Texture}|undefined;
    // ETPF stores IDs in sorted order. Reuse the parsed pack tables instead
    // of allocating a second world-wide index before the first texture.
    for(const pack of await this.candidatePacks(key)){
      if(!pack)continue;
      const texture=findTexture(pack,key);
      if(!texture)continue;
      if(supportedColor(texture.mode)||key===roadDecalControl)return {pack,texture};
      if(!fallback&&(readableRoadMasks.has(key)||
        texture.surface?.dimension===1&&texture.surface.depth===1&&poolBlockFormat(texture)!==undefined||
        [0x239,0x311,0x313,0xe0,0xe1,0xe3].includes(texture.mode)))fallback={pack,texture};
    }
    return fallback;
  }

  async interiorCube(key:string){
    const read=async(id:string)=>{
      for(const pack of await this.candidatePacks(id)){
        if(!pack)continue;
        const texture=findTexture(pack,id);
        if(texture?.surface?.dimension!==2)continue;
        const cube=await readStreetCube(pack,texture);
        if(cube)return cube;
      }
      return null;
    };
    const direct=await read(key);
    if(direct)return direct;
    const alias=await this.aliasFor(key);
    return alias&&alias!==key?read(alias):null;
  }

  private async findSourceWithAlias(key:string){
    const direct=await this.findSource(key);
    if(direct)return direct;
    const alias=await this.aliasFor(key);
    return alias?this.findSource(alias):undefined;
  }

  private async closeColorSource(id:string){
    const key=id.slice(closeMaterialPrefix.length);
    return this.findSourceWithAlias(key.startsWith(roadSurfacePrefix)?key.slice(roadSurfacePrefix.length):key);
  }

  async compressedCloseColor(id:string,supported:number){
    const source=await this.closeColorSource(id);
    return source?readCompressedCloseColor(source.pack,source.texture,supported):null;
  }

  async compressedRoadColor(id:string,supported:number):Promise<StreetBlockTexture|null>{
    const source=await this.closeColorSource(id);
    if(!source)return null;
    const {pack,texture}=source;
    if(Math.max(texture.width,texture.height)<=512)return null;
    const format=texture.surface?.format===72?"bc1":texture.surface?.format===99?"bc7":undefined;
    if(!format||!(supported&compressedRoadColorFormats[format]))return null;
    let levels:StreetBlockTexture["levels"],tail:Image;
    if(format==="bc1"){
      const chain=await readPoolBc1BlockChain(pack,texture);
      if(!chain)return null;
      ({levels,tail}=chain);
    }else{
      const chain=await readPoolBc7Chain(pack,texture);
      if(!chain?.length)return null;
      levels=chain;
      tail=await decodeBc7Level(chain.at(-1)!);
    }
    const sums=[0,0,0];
    for(let at=0;at<tail.rgba.length;at+=4){
      sums[0]+=tail.rgba[at];sums[1]+=tail.rgba[at+1];sums[2]+=tail.rgba[at+2];
    }
    // The browser's projected-road approximation needs a constant reference.
    const flux=sums.map(sum=>{
      const srgb=sum/(255*tail.width*tail.height);
      return srgb<=.04045?srgb/12.92:((srgb+.055)/1.055)**2.4;
    });
    return {format,levels,roadColorLuminance:.2126*flux[0]+.7152*flux[1]+.0722*flux[2]};
  }

  async compressedRoomGlass(id:string):Promise<StreetBlockTexture|null>{
    const source=await this.findSourceWithAlias(id.slice(roomGlassTexturePrefix.length));
    if(!source)return null;
    const levels=await readPoolBc7Chain(source.pack,source.texture);
    return levels?{format:"bc7",levels}:null;
  }

  async compressedRoadHeight(id:string,supported:number):Promise<StreetBlockTexture|null>{
    const source=await this.findSourceWithAlias(id.slice(roadHeightPrefix.length));
    if(!source)return null;
    const {pack,texture}=source;
    if(texture.surface?.format===71&&(supported&compressedMaterialFormats.bc1)){
      const chain=await readPoolBc1BlockChain(pack,texture,71);
      return chain?{format:"bc1",levels:chain.levels}:null;
    }
    if(!(supported&compressedMaterialFormats.bc7))return null;
    const levels=await readPoolBc7Chain(pack,texture,98,true);
    return levels?.length?{format:"bc7",levels}:null;
  }

  async roadHeightMips(id:string):Promise<RoadHeightMip[]|null>{
    const source=await this.findSourceWithAlias(id.slice(roadHeightPrefix.length));
    if(!source)return null;
    const {pack,texture}=source;
    if(texture.surface?.format===71){
      const levels=await readPoolBc1Chain(pack,texture);
      return levels?.map(({width,height,rgba})=>({width,height,channels:roadHeightBlueAlpha(rgba)}))??null;
    }
    const chain=await readPoolBc7Chain(pack,texture,98,true);
    if(!chain?.length)return null;
    // The blend uses blue for height and alpha for tint coverage.
    const levels:RoadHeightMip[]=[];
    for(const mip of chain){
      const {width,height,rgba}=await decodeBc7Level(mip);
      levels.push({width,height,channels:roadHeightBlueAlpha(rgba)});
    }
    return levels;
  }

  async compressedBaseColor(id:string){
    if(id.startsWith(roadWeightPrefix)){
      const key=id.slice(roadWeightPrefix.length);
      if(!/^0x[0-9a-f]{16}$/.test(key))return null;
      const source=await this.findSourceWithAlias(key);
      if(!source)return null;
      const {pack,texture}=source,{width,height,surface}=texture;
      if(surface?.format!==71||surface.dimension!==1||surface.depth!==1||surface.mipLevels!==1)return null;
      const raw=await readWideWeightBlocks(pack,texture);
      if(!raw)return null;
      const columns=width/4,rows=height/4,pitch=Math.ceil(columns/128);
      const blocks=new Uint8Array(raw.length);
      for(let y=0;y<rows;y++)for(let x=0;x<columns;x++){
        const at=wideBc1Offset(x,y,pitch);
        blocks.set(raw.subarray(at,at+8),(y*columns+x)*8);
      }
      return {format:"bc1",levels:[{width,height,blocks}]} satisfies StreetBlockTexture;
    }
    if(!/^0x[0-9a-f]{16}$/.test(id)||readableRoadMasks.has(id)||id===roadDecalControl||retroDecalControls.has(id))return null;
    const source=await this.findSourceWithAlias(id);
    return source?readCompressedBaseColor(source.pack,source.texture):null;
  }

  async imposterMips(key:bigint,minimum:number){
    const archive=this.archives.get(imposterAtlasPackPath);
    const pack=archive&&await this.pack(archive);
    if(!pack)return [];
    const texture=findTexture(pack,"0x"+key.toString(16).padStart(16,"0"));
    if(!texture)return [];
    const target=streetBudgets.materialSide;
    const images=await readImposterBc1Mips(pack,texture,target,minimum);
    for await(const level of readImposterBc7Mips(pack,texture,target,minimum))images.push(await decodeBc7Level(level));
    if(images.length)return images;
    const image=await readColor(pack,texture);
    return image?[image]:[];
  }

  async image(id:string,ground:boolean,terrainMips=true):Promise<StreetTextureImage|null>{
    if(id.startsWith(signGlyphPrefix)){
      const key=id.slice(signGlyphPrefix.length);
      if(key===streetSignFontTexture){
        const archive=this.archives.get(streetSignFontPack),pack=archive&&await this.pack(archive);
        const texture=pack&&findTexture(pack,key);
        return pack&&texture?readSignGlyph(pack,texture):null;
      }
      const source=await this.findSourceWithAlias(key);
      return source?readSignGlyph(source.pack,source.texture):null;
    }
    if(id.startsWith(detailAtlasSlicePrefix)){
      const index=id.slice(detailAtlasSlicePrefix.length);
      const archive=this.archives.get(detailAtlasPackPath);
      if(!archive||!/^\d{1,2}$/.test(index))return null;
      const pack=await this.pack(archive);
      if(!pack)return null;
      const descriptor=findTexture(pack,"0x682239aa6044d0fa");
      const blocks=descriptor&&await readPoolBc7ArraySlice(pack,descriptor,Number(index));
      if(!blocks)return null;
      const levels=[];
      for(const level of blocks)levels.push(await decodeBc7Level(level));
      const [base,...authoredMips]=levels;
      return {...base,authoredMips};
    }
    if(id.startsWith(closeMaterialPrefix)){
      const source=await this.closeColorSource(id);
      if(!source)return null;
      const {pack,texture}=source;
      if(ground||id.startsWith(closeMaterialPrefix+roadSurfacePrefix)){
        const target=Math.max(texture.width,texture.height);
        if(target<=512)return null;
        if(id.startsWith(closeMaterialPrefix+roadSurfacePrefix)){
          let levels:Image[]|null=null;
          if(texture.surface?.format===72)levels=await readPoolBc1Chain(pack,texture);
          else if(texture.surface?.format===99){
            const blocks=await readPoolBc7Chain(pack,texture);
            if(blocks){
              levels=[];
              for(const level of blocks)levels.push(await decodeBc7Level(level));
            }
          }
          if(levels?.length){
            const [base,...authoredMips]=levels;
            return {...base,authoredMips};
          }
        }
        if(poolBlockFormat(texture)===1){
          const image=await readPoolBc1(pack,texture,target,true);
          if(image&&Math.max(image.width,image.height)===target)return image;
        }
      }
      return readCloseColor(pack,texture);
    }
    if(id.startsWith(waterScumTexturePrefix)){
      const source=await this.findSourceWithAlias(id.slice(waterScumTexturePrefix.length));
      if(!source)return null;
      const {pack,texture}=source;
      // BC7 water decal images use the same packed mip layout as terrain inputs.
      return texture.mode===0x313?readTerrainLayerInput(pack,texture,"height"):readColor(pack,texture);
    }
    const roadWeight=id.startsWith(roadWeightPrefix);
    const elevatedWeight=id.startsWith(elevatedRoadWeightPrefix);
    const projectedWeight=id.startsWith(projectedRoadWeightPrefix);
    if(id.startsWith(roadControlPrefix)){
      const key=id.slice(roadControlPrefix.length);
      for(const pack of await this.candidatePacks(key)){
        if(!pack)continue;
        const texture=findTexture(pack,key);
        if(!texture)continue;
        const level=await readPoolBc4Top(pack,texture);
        if(level)return {...decodePoolBcChannels(level,1),baseLevelOnly:true};
      }
      return null;
    }
    if(id.startsWith(roadHeightPrefix))return this.image(terrainTexturePrefix+"height:"+id.slice(roadHeightPrefix.length),false,false);
    if(id.startsWith(roadTintPrefix))return this.image(terrainTexturePrefix+"tint:"+id.slice(roadTintPrefix.length),false);
    if(id.startsWith(roadSurfaceTintPrefix)){
      const source=await this.findSourceWithAlias(id.slice(roadSurfaceTintPrefix.length));
      if(!source)return null;
      const {pack,texture}=source,{width,height,surface}=texture;
      if(surface?.format!==72||surface.dimension!==1||surface.depth!==1)return null;
      const levels=await readPoolBc1Chain(pack,texture);
      if(!levels?.length||levels[0].width!==width||levels[0].height!==height)return null;
      const [base,...authoredMips]=levels;
      return authoredMips.length?{...base,authoredMips}:{...base,baseLevelOnly:true};
    }
    const surface=id.startsWith(roadSurfacePrefix);
    if(surface)id=id.slice(roadSurfacePrefix.length);
    if(roadWeight||id.startsWith(terrainTexturePrefix)){
      const weightPrefix=elevatedWeight?elevatedRoadWeightPrefix:projectedWeight?projectedRoadWeightPrefix:roadWeightPrefix;
      const [role,key]=roadWeight?["weights",id.slice(weightPrefix.length)]:id.slice(terrainTexturePrefix.length).split(":");
      const maskChain=role==="material-mask-chain";
      const materialMask=maskChain||role==="material-mask";
      let source=await this.findSource(key);
      let resolvedKey=key;
      if(!source&&!compactMaskKeys.has(key)){
        const alias=await this.aliasFor(key);
        if(alias){
          resolvedKey=alias;
          source=await this.findSource(alias);
        }
      }
      if(!source&&(role==="weights"||materialMask||role==="layer-control")&&compactMaskKeys.has(resolvedKey)){
        const archive=this.archives.get(compactMaskPackPath);
        if(archive){
          const pack=await this.pack(archive);
          const texture=pack&&findTexture(pack,resolvedKey);
          if(pack&&texture)source={pack,texture};
        }
      }
      if(!source)return null;
      // Packed rectangular BC1 weights also occur on locally colored roads.
      if(roadWeight&&!elevatedWeight&&!projectedWeight&&source.texture.width!==source.texture.height&&
        !packedWideWeights(source.texture))return null;
      if(elevatedWeight){
        const {texture,pack}=source;
        const {width,height,mode,tileMode,mipCount,start,end}=texture,row=start+2;
        if(mode===0x23b&&tileMode===2&&width===512&&height===1024&&mipCount===6&&end===start+4&&
          pack.addresses[row]-pack.addresses[start]===28672&&textureChunkSize(pack,row)===65536){
          const data=await readTextureChunk(pack,row,65536,decodeBcpackBc1);
          return data?bc1(data,256,512):null;
        }
        // Some elevated decks bind the same complete rectangular mask as
        // standalone road materials.
        if(readableRoadMasks.has(resolvedKey)){
          const image=await readRoadMask(pack,texture);
          if(image)return image;
        }
      }
      if(role==="layer-control"){
        const {pack,texture}=source;
        if(texture.surface?.format!==65)return readColor(pack,texture);
        const image=await readTerrainLayerInput(pack,texture,"weights");
        if(!image)return null;
        // An A8 view exposes zero in RGB and the authored byte in alpha.
        for(let i=0;i<image.rgba.length;i+=4){
          image.rgba[i+3]=image.rgba[i];
          image.rgba[i]=0;
        }
        return image;
      }
      if(role==="color"||role==="native-color"){
        const {pack,texture}=source;
        return (await authoredTerrainMips(pack,texture))??readColor(pack,texture);
      }
      if(role==="material-a"||role==="control-chain"||role==="diffuse-chain"){
        const {pack,texture}=source;
        let chain:Image[]|null=null;
        if(role==="diffuse-chain"&&texture.surface?.format===99){
          const levels=await readPoolBc7Chain(pack,texture);
          if(levels){
            chain=[];
            for(const level of levels)chain.push(await decodeBc7Level(level));
          }
        }else if(texture.surface?.format===(role==="diffuse-chain"?72:71)){
          chain=await readPoolBc1Chain(pack,texture);
        }
        if(!chain)return readColor(pack,texture);
        const [base,...authoredMips]=chain;
        return {...base,authoredMips};
      }
      if(role==="room-glass"){
        const {pack,texture}=source;
        const chain=await readPoolBc7Chain(pack,texture);
        if(!chain)return null;
        const levels=[];
        for(const level of chain)levels.push(await decodeBc7Level(level));
        const [base,...authoredMips]=levels;
        return base?{...base,authoredMips}:null;
      }
      if(materialMask){
        const {pack,texture}=source;
        const {mode,tileMode,width,height,start,end,surface}=texture;
        if(surface?.dimension!==1||surface.depth!==1)return null;
        if(surface.format===71&&mode===0x238&&tileMode===1&&width===4&&height===4&&end===start+1&&
          textureChunkSize(pack,start)===4096){
          const bytes=await readTextureChunk(pack,start,4096);
          return bytes?bc1(bytes,width,height,true):null;
        }
        if(surface.format===71)return readColor(pack,texture);
        if(surface.format!==98)return null;
        const size=width*height;
        const legacyPagedMask=mode===0x313&&tileMode===2&&[512,1024].includes(width)&&
          [512,1024].includes(height)&&end===start+4&&textureChunkSize(pack,start+1)===size/16&&
          textureChunkSize(pack,start+2)===size/4&&textureChunkSize(pack,start+3)===size;
        if(maskChain||legacyPagedMask&&width!==height&&surface.mipLevels===8){
          const chain=await readPoolBc7Chain(pack,texture,98);
          if(chain){
            const levels=[];
            for(const level of chain)levels.push(await decodeBc7Level(level));
            const [base,...authoredMips]=levels;
            return {...base,authoredMips};
          }
        }
        if(legacyPagedMask){
          const bytes=await readTextureChunk(pack,start+2,size/4);
          if(bytes)return decodeMaterialBlocks(bytes,width/2,height/2,mode,true);
        }
        if(mode===0x313){
          const image=await readTerrainLayerInput(pack,texture,"height");
          if(image)return image;
        }
        // Linear BC7 masks also use the standard packed mip layout.
        const blocks=await readPoolBc16(pack,texture,512,7);
        return blocks?decodePoolColor(blocks,7):null;
      }
      if(role==="diffuse"){
        const {pack,texture}=source;
        const image=await readColor(pack,texture);
        if(image)return image;
        // Some BC1 assets use BCPack for every lower level but store the top mip separately.
        if(texture.mode===0x243&&texture.tileMode===2&&texture.width===1024&&
          texture.height===1024&&texture.mipCount===7){
          const mip=await readMip(pack,texture,1024);
          if(mip?.side===1024)return bc1(mip.data,1024,1024,true);
        }
        return null;
      }
      if(role==="tint"){
        const {mode,tileMode,width,height,mipCount}=source.texture;
        if(mode===0x241&&tileMode===0&&width===height&&mipCount===1&&
          (width===512||width===1024)){
          const {start,end}=source.texture,size=width*height/2;
          if(end!==start+1||textureChunkSize(source.pack,start)!==size)return null;
          const bytes=await readTextureChunk(source.pack,start,size);
          if(!bytes)return null;
          const image=bc1Tiles64K(bytes,width,height,true);
          return width===512?image:halfColor(image);
        }
        if(mode===0x243&&tileMode===2&&width===1024&&height===1024&&mipCount===7){
          const mip=await readMip(source.pack,source.texture,512);
          if(mip?.side===512)return bc1(mip.data,512,512,true);
        }
        if(mode===0x243&&tileMode===2&&mipCount===6&&
          Math.min(width,height)===512&&Math.max(width,height)===1024)
          return readPoolBc1(source.pack,source.texture,512,true);
        return null;
      }
      if(role==="tint-correction"){
        const {mode,tileMode,width,height,mipCount,start,end}=source.texture;
        if(mode!==0x243||tileMode!==3||width!==512||height!==512||mipCount!==6||end!==start+4||
          textureChunkSize(source.pack,start)!==4096)return null;
        const mip=await readMip(source.pack,source.texture,512);
        if(mip)return bc1(mip.data,mip.side,mip.side,true);
        const tail=await readTextureChunk(source.pack,start,4096);
        // The 64² level occupies the right half of the first 128×64 BC1 tile.
        return tail?bc1(tail,64,64,true,16,0):null;
      }
      if(role==="normal")return (await authoredTerrainMips(source.pack,source.texture))??
        readTerrainLayerInput(source.pack,source.texture,"normal");
      if(role==="weights"||role==="height"||role==="indices"){
        const {pack,texture}=source;
        const mips=terrainMips&&(role==="height"||role==="weights"&&!roadWeight)?await authoredTerrainMips(pack,texture):null;
        if(mips)return mips;
        const image=await readTerrainLayerInput(pack,texture,role);
        if(role==="weights"&&image&&texture.surface?.mipLevels===1&&image.width===texture.width&&image.height===texture.height)
          return {...image,baseLevelOnly:true};
        return image;
      }
      return null;
    }
    if(ground){
      for(const pack of await this.candidatePacks(id,true)){
        if(!pack)continue;
        const texture=findTexture(pack,id);
        if(!texture)continue;
        const image=(await authoredTerrainMips(pack,texture))??await groundColor(pack,texture);
        if(image)return image;
      }
      return null;
    }
    const decal=id===roadDecalControl||retroDecalControls.has(id),mask=readableRoadMasks.has(id);
    const current=await (decal||mask?this.findSource(id):this.findSourceWithAlias(id));
    if(!current)return null;
    if(decal)return readDecalControl(current.pack,current.texture);
    if(mask)return readRoadMask(current.pack,current.texture);
    return readColor(current.pack,current.texture,surface);
  }
}

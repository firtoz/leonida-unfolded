import { decodeBcpackBc1 } from "./bcpack";
import { decodeBcpackColor } from "./bcpack-color";
import { bc1, blockOffset, readTextureChunk, textureChunkSize, type Image, type Pack, type Texture } from "./texture";

const page = 4096;
const blockBytes = 8;
export const imposterAtlasPackPath="data/ttdb/props/octa_imposters.ttpf";
export const detailAtlasPackPath="data/ttdb/graphics/ttdb_graphics.ttpf";
const wideBitOrder = [0,7,1,2,8,9,3,10,4,11,5,12,6];
const wideTileOffsets = Uint16Array.from({length:8192}, (_, block) => {
  return blockBytes * wideBitOrder.reduce((offset, bit, i) => offset | ((block >> bit & 1) << i), 0);
});

export function wideBc1Offset(x:number,y:number,pitch:number){
  return ((y>>6)*pitch+(x>>7))*65536+wideTileOffsets[(y&63)*128+(x&127)];
}

export function poolBlockFormat(texture:Texture){
  switch(texture.surface?.format){
    case 71: case 72: return 1;
    case 77: case 78: return 3;
    case 83: return 5;
    case 98: case 99:
      if(texture.pack===imposterAtlasPackPath)return 7;
  }
}

export function packedMipBlockOrigin(entry:number,blockBytes:8|16){
  const address=entry>6?16<<entry:entry<<8;
  let x=0,y=0;
  for(let bit=0;bit<6;bit++){
    x|=(address>>(9+2*bit)&1)<<bit;
    y|=(address>>(8+2*bit)&1)<<bit;
  }
  return [x*(blockBytes===8?8:4),y*4] as const;
}

function poolBlockLayout(pack:Pack, texture:Texture, codec:1|3|4|5|7){
  const {surface,width,height,tileMode,start,end}=texture;
  if(!surface||surface.dimension!==1||surface.depth!==1||
    tileMode>3||end<=start)return;
  const count=surface.mipLevels;
  if(count<1||count>Math.floor(Math.log2(Math.max(width,height)))+1)return;
  const wide=tileMode===0,tileBytes=wide?65536:page;
  const bytes=codec===1||codec===4?8:16;
  const tileWidth=(wide?1024:256)/bytes,tileHeight=wide?64:16,maxTail=wide?12:8;
  const levels=[];
  let firstTail=count;
  // Schedule in GPU block units. Odd source dimensions can reserve more
  // blocks than the logical dimensions of an individual mip.
  for(let i=0;i<count;i++){
    const divisor=4*2**i;
    const columns=Math.ceil(width/divisor),rows=Math.ceil(height/divisor);
    if(count>1&&columns<=tileWidth/2&&rows<=tileHeight&&count-i<=maxTail)firstTail=Math.min(firstTail,i);
    const tail=i>=firstTail;
    const size=tail?tileBytes:Math.ceil(columns/tileWidth)*Math.ceil(rows/tileHeight)*tileBytes;
    let x=0,y=0;
    if(tail){
      [x,y]=packedMipBlockOrigin(maxTail-1-(i-firstTail),bytes);
      if(x+columns>tileWidth||y+rows>tileHeight)return;
    }
    levels.push({width:Math.max(1,width>>i),height:Math.max(1,height>>i),columns,
      offset:0,size,x,y});
  }
  let size=firstTail<count?tileBytes:0;
  for(let i=firstTail-1;i>=0;i--){levels[i].offset=size;size+=levels[i].size;}
  const base=pack.addresses[start],limit=pack.addresses[end]??pack.eofAddress;
  return limit-base===size?{levels,base,wide}:undefined;
}

async function* readPoolMips(pack:Pack,texture:Texture,target:number,codec:1|3|4|5|7,minimum=1){
  const layout=poolBlockLayout(pack,texture,codec);
  if(!layout)return;
  const {levels,base,wide}=layout;
  const chunks=new Map<number,Promise<Uint8Array|null>>();
  for(const level of levels){
    const {width,height,columns,x,y,size,offset}=level;
    if(Math.max(width,height)>target)continue;
    if(Math.min(width,height)<minimum)break;
    const begin=base+offset,end=begin+size;
    let raw:Uint8Array|undefined,copied=0;
    const reads=[];
    for(let row=texture.start;row<texture.end;row++){
      const address=pack.addresses[row],length=textureChunkSize(pack,row);
      const from=Math.max(address,begin),to=Math.min(address+length,end);
      if(from>=to)continue;
      let chunk=chunks.get(row);
      if(!chunk){
        const decode=codec===1?decodeBcpackBc1:codec===7||codec===4?undefined:
          (data:Uint8Array,length:number)=>decodeBcpackColor(data,length,codec);
        chunk=readTextureChunk(pack,row,2*1024*1024,decode,codec*4).catch(()=>null);
        chunks.set(row,chunk);
      }
      reads.push({address,length,from,to,chunk});
    }
    for(const {address,length,from,to,chunk} of reads){
      const bytes=await chunk;
      if(!bytes)break;
      if(address===begin&&length===size){raw=bytes;copied=size;break;}
      raw??=new Uint8Array(size);
      raw.set(bytes.subarray(from-address,to-address),from-begin);
      copied+=to-from;
    }
    if(raw&&copied===size)yield {raw,width,height,columns,x,y,wide};
  }
}

async function readPoolMip(pack:Pack,texture:Texture,target:number,codec:1|3|4|5|7){
  for await(const level of readPoolMips(pack,texture,target,codec))return level;
  return null;
}

export async function readPoolBc4Top(pack:Pack,texture:Texture){
  if(texture.surface?.format!==80)return null;
  const level=await readPoolMip(pack,texture,Math.max(texture.width,texture.height),4);
  if(!level||level.width!==texture.width||level.height!==texture.height)return null;
  const {width,height,raw,columns,x,y,wide}=level;
  const across=Math.ceil(width/4),rows=Math.ceil(height/4);
  const blocks=new Uint8Array(across*rows*8);
  for(let by=0;by<rows;by++)for(let bx=0;bx<across;bx++){
    const at=wide?wideBc1Offset(x+bx,y+by,Math.ceil(columns/128)):blockOffset(x+bx,y+by,columns,8);
    blocks.set(raw.subarray(at,at+8),(by*across+bx)*8);
  }
  return {width,height,blocks};
}

export async function readPoolBc1(pack:Pack,texture:Texture,target:number,keepAlpha:boolean){
  if(poolBlockFormat(texture)!==1)return null;
  const level=await readPoolMip(pack,texture,target,1);
  return level?decodePoolBc1(level,keepAlpha):null;
}

export async function readPoolBc1Chain(pack:Pack,texture:Texture){
  if(poolBlockFormat(texture)!==1||!texture.surface)return null;
  const levels:Image[]=[];
  let {width,height}=texture;
  for await(const level of readPoolMips(pack,texture,Math.max(width,height),1)){
    if(level.width!==width||level.height!==height)return null;
    levels.push(decodePoolBc1(level,true));
    width=Math.max(1,width>>1);
    height=Math.max(1,height>>1);
  }
  return levels.length===texture.surface.mipLevels?levels:null;
}

export async function readPoolBc1BlockChain(pack:Pack,texture:Texture,format:71|72=72){
  if(texture.surface?.format!==format)return null;
  const levels=[];
  let tail:Image|undefined;
  let {width,height}=texture;
  for await(const level of readPoolMips(pack,texture,Math.max(width,height),1)){
    if(level.width!==width||level.height!==height)return null;
    const {raw,columns,x,y,wide}=level;
    const across=Math.ceil(width/4),rows=Math.ceil(height/4),pitch=Math.ceil(columns/128);
    const blocks=new Uint8Array(across*rows*blockBytes);
    for(let row=0;row<rows;row++)for(let col=0;col<across;col++){
      const at=wide?wideBc1Offset(x+col,y+row,pitch):blockOffset(x+col,y+row,columns,blockBytes);
      blocks.set(raw.subarray(at,at+blockBytes),(row*across+col)*blockBytes);
    }
    levels.push({width,height,blocks});
    if(levels.length===texture.surface.mipLevels)tail=decodePoolBc1(level,true);
    width=Math.max(1,width>>1);height=Math.max(1,height>>1);
  }
  return tail?{levels,tail}:null;
}

export async function readImposterBc1Mips(pack:Pack,texture:Texture,target:number,minimum:number){
  const images:Image[]=[];
  if(poolBlockFormat(texture)!==1)return images;
  for await(const level of readPoolMips(pack,texture,target,1,minimum)){
    const previous=images.at(-1);
    if(previous&&(level.width!==previous.width/2||level.height!==previous.height/2))break;
    images.push(decodePoolBc1(level,true));
  }
  return images;
}

function decodePoolBc1(level:NonNullable<Awaited<ReturnType<typeof readPoolMip>>>,keepAlpha:boolean){
  const {raw,width,height,columns,x,y,wide}=level;
  const blockColumns=Math.ceil(width/4),blockRows=Math.ceil(height/4);
  if(!wide&&Math.ceil(blockColumns/32)===Math.ceil(columns/32))return bc1(raw,width,height,keepAlpha,x,y);
  const tiled=new Uint8Array(Math.ceil(blockColumns/32)*Math.ceil(blockRows/16)*page);
  const widePitch=Math.ceil(columns/128);
  for(let by=0;by<blockRows;by++)for(let bx=0;bx<blockColumns;bx++){
    const sx=x+bx,sy=y+by;
    const from=wide?wideBc1Offset(sx,sy,widePitch):blockOffset(sx,sy,columns,blockBytes);
    tiled.set(raw.subarray(from,from+blockBytes),blockOffset(bx,by,blockColumns,blockBytes));
  }
  return bc1(tiled,width,height,keepAlpha);
}

const wideBc16Order=[0,6,1,7,8,2,9,3,10,4,11,5];
const wideBc16Offsets=Uint16Array.from({length:4096},(_,block)=>
  16*wideBc16Order.reduce((offset,bit,i)=>offset|((block>>bit&1)<<i),0));

export async function readPoolBc16(pack:Pack,texture:Texture,target:number,codec:3|5|7){
  if(poolBlockFormat(texture)!==codec&&!(codec===7&&texture.surface?.format===98))return null;
  const level=await readPoolMip(pack,texture,target,codec);
  if(!level)return null;
  return linearPoolBc16(level);
}

export async function* readImposterBc7Mips(pack:Pack,texture:Texture,target:number,minimum:number){
  if(poolBlockFormat(texture)!==7)return;
  let previous:Awaited<ReturnType<typeof readPoolMip>>=null;
  for await(const level of readPoolMips(pack,texture,target,7,minimum)){
    if(previous&&(level.width!==previous.width/2||level.height!==previous.height/2))break;
    yield linearPoolBc16(level);
    previous=level;
  }
}

export async function readPoolBc7Chain(pack:Pack,texture:Texture,format:98|99=99,allowPartial=false){
  if(texture.surface?.format!==format||texture.surface.dimension!==1||texture.surface.depth!==1)return null;
  const levels=[];
  let width=texture.width,height=texture.height;
  for await(const level of readPoolMips(pack,texture,Math.max(width,height),7)){
    if(level.width!==width||level.height!==height){
      if(!allowPartial)return null;
      // A missing row must not shift the original scale of later mips.
      if(levels.length)break;
      width=level.width;height=level.height;
    }
    levels.push(linearPoolBc16(level));
    width=Math.max(1,width>>1);height=Math.max(1,height>>1);
  }
  return levels.length&&(allowPartial||levels.length===texture.surface.mipLevels)?levels:null;
}

export async function readPoolBc7ArraySlice(pack:Pack,texture:Texture,slice:number){
  const {surface,start,end,tileMode,width,height}=texture;
  if(surface?.format!==98||surface.dimension!==1||surface.depth<=1||surface.mipLevels!==10||
    width!==512||height!==512||tileMode!==0||end-start!==3*surface.depth||
    !Number.isInteger(slice)||slice<0||slice>=surface.depth)return null;
  const rows=[start+2*surface.depth+slice,start+surface.depth+slice,start+slice];
  const sizes=[512**2,256**2,65536];
  if(rows.some((row,index)=>textureChunkSize(pack,row)!==sizes[index]))return null;
  const [top,middle,tail]=await Promise.all(rows.map((row,index)=>readTextureChunk(pack,row,sizes[index])));
  if(!top||!middle||!tail)return null;
  return Array.from({length:surface.mipLevels},(_,mip)=>{
    const side=width>>mip;
    const [x,y]=mip<2?[0,0]:packedMipBlockOrigin(13-mip,16);
    return linearPoolBc16({raw:mip===0?top:mip===1?middle:tail,width:side,height:side,
      columns:mip===0?128:64,x,y,wide:true});
  });
}

function linearPoolBc16(level:{raw:Uint8Array;width:number;height:number;columns:number;x:number;y:number;wide:boolean}){
  const {raw,width,height,columns,x,y,wide}=level;
  const across=Math.ceil(width/4),down=Math.ceil(height/4),pitch=Math.ceil(columns/64);
  const blocks=new Uint8Array(across*down*16);
  for(let by=0;by<down;by++)for(let bx=0;bx<across;bx++){
    const sx=x+bx,sy=y+by;
    const from=wide?((sy>>6)*pitch+(sx>>6))*65536+wideBc16Offsets[(sy&63)*64+(sx&63)]:
      blockOffset(sx,sy,columns,16);
    blocks.set(raw.subarray(from,from+16),(by*across+bx)*16);
  }
  return {width,height,blocks};
}

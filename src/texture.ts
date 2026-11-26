import { Archive, inflate, text, view } from "./archive";

export type Texture = {
  id: string; pack: string; index: number; descriptorOffset: number;
  width: number; height: number; mode: number; start: number; end: number;
  mipCount: number; tileMode: number;
  surface?: { format: number; dimension: number; depth: number; mipLevels: number };
};
export type Mip = { side: number; stream: number; offset: number; data: Uint8Array };
export type Image = { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> };
export type Pack = {
  source: Archive; descriptors: Texture[]; offsets: number[]; addresses: number[]; eofAddress: number;
  codecs: Uint8Array; padding: Uint16Array;
};

export async function loadPack(source: Archive): Promise<Pack> {
  const header = await source.read(0,32);
  const h = view(header);
  const count = h.getUint32(4,true);
  if (text.decode(header.subarray(0,4)) !== "RDS5" || count < 3 || count > 2 ** 21)
    throw new Error(`${source.path}: invalid RDS5 stream table`);
  const firstOffset = Number(h.getBigUint64(24,true) & 0xffffffn)*256;
  if (firstOffset < 24+(count-1)*8 || firstOffset > 16*1024*1024)
    throw new Error(`${source.path}: stream table exceeds the header`);
  const bytes = await source.read(0,firstOffset);
  const info = view(bytes);
  const offsets: number[] = [], addresses: number[] = [];
  const codecs=new Uint8Array(count-2),padding=new Uint16Array(count-2);
  for (let i = 0; i < count-1; i++) {
    const word = info.getBigUint64(24+8*i,true);
    const offset = Number(word&0xffffffn)*256;
    const address = Number((word>>30n)&0x3fffffn)*4096;
    if (i && (offset <= offsets[i-1] || address <= addresses[i-1]))
      throw new Error(`${source.path}: unordered stream row ${i}`);
    offsets.push(offset);
    addresses.push(address);
    if(i<codecs.length){
      codecs[i]=Number(word>>24n&63n);
      padding[i]=Number(word>>52n);
    }
  }
  if (offsets.at(-1) !== source.file.size) throw new Error(`${source.path}: wrong end-of-file sentinel`);
  const eofAddress = addresses.pop()!;
  const from = 24+(count-1)*8;
  const aligned = Math.ceil(from/256)*256;
  const at = aligned+16<=bytes.length&&info.getUint32(aligned,false)===0x45545046&&info.getUint32(aligned+4,true)===0x27a
    ? aligned : from+text.decode(bytes.subarray(from)).indexOf("ETPF");
  if (at < from || at+16 > bytes.length || info.getUint32(at+4,true) !== 0x27a)
    throw new Error(`${source.path}: ETPF texture table missing`);
  const textures = info.getUint32(at+8,true);
  const start = at+16, ids = start+textures*16;
  if (!textures || start+textures*32+info.getUint32(at+12,true) > bytes.length)
    throw new Error(`${source.path}: invalid ETPF table length`);
  const descriptors: Texture[] = [];
  let stream = 0, priorId = -1n;
  for (let index = 0; index < textures; index++) {
    const descriptorOffset = start+index*16;
    const bits = info.getUint32(descriptorOffset,true);
    const layout = info.getUint32(descriptorOffset+4,true);
    const page = (info.getUint32(descriptorOffset+8,true)&0x1fffff)*4096;
    while (stream < addresses.length && addresses[stream] < page) stream++;
    const key = info.getBigUint64(ids+index*8,true);
    const previous = descriptors.at(-1);
    if (key <= priorId || stream === addresses.length || addresses[stream]!==page ||
        (previous && stream <= previous.start))
      throw new Error(`${source.path}: invalid ETPF descriptor ${index}`);
    if (previous) previous.end = stream;
    descriptors.push({
      id: "0x"+key.toString(16).padStart(16,"0"),
      pack: source.path,index,descriptorOffset,width:(bits&16383)+1,height:((bits>>>14)&16383)+1,
      mode:layout&4095,start:stream,end:addresses.length,
      mipCount:(bits>>>28)+1,tileMode:info.getUint8(descriptorOffset+7)&15,
      surface:{format:(layout>>>3)&127,dimension:(layout>>>21)&3,
        depth:((layout>>>10)&2047)+1,mipLevels:(bits>>>28)+(layout&7)},
    });
    priorId = key;
  }
  return { source,descriptors,offsets,addresses,eofAddress,codecs,padding };
}

export function textureChunkSize(pack:Pack,row:number){
  return (pack.addresses[row+1]??pack.eofAddress)-pack.addresses[row];
}

const textureReadCap=1024*1024;
type TextureRead={
  start:number;end:number;next:number;
  resolve:(bytes:Uint8Array<ArrayBuffer>)=>void;reject:(error:unknown)=>void;
};
const pendingTextureReads=new WeakMap<Pack,TextureRead[]>();

async function readTextureGroup(source:Archive,group:TextureRead[],start:number,end:number){
  if(group.length>1){
    try{
      const bytes=await source.read(start,end-start);
      // Give each caller its own backing buffer, as with an individual archive read.
      for(const request of group)request.resolve(bytes.slice(request.start-start,request.end-start));
      return;
    }catch{
      // A failed merged range should not make an independently readable row fail.
    }
  }
  await Promise.all(group.map(({start,end,resolve,reject})=>source.read(start,end-start).then(resolve,reject)));
}

function flushTextureReads(pack:Pack,requests:TextureRead[]){
  pendingTextureReads.delete(pack);
  requests.sort((a,b)=>a.start-b.start);
  for(let i=0;i<requests.length;){
    const first=i,{start}=requests[i];
    let {end,next}=requests[i++];
    while(i<requests.length){
      const request=requests[i];
      // Merge only requested neighbors, skipping at most the preceding row's
      // 256-byte alignment padding. Never pull intervening texture data.
      const adjacent=request.start===next&&request.start-end<256;
      if((request.start>end&&!adjacent)||Math.max(end,request.end)-start>textureReadCap)break;
      end=Math.max(end,request.end);
      next=Math.max(next,request.next);
      i++;
    }
    void readTextureGroup(pack.source,requests.slice(first,i),start,end);
  }
}

function readStoredTexture(pack:Pack,row:number,start:number,length:number){
  if(length>=textureReadCap)return pack.source.read(start,length);
  let requests=pendingTextureReads.get(pack);
  if(!requests){
    const batch:TextureRead[]=[];
    pendingTextureReads.set(pack,batch);
    // Worker messages arrive in separate tasks. Give the current texture
    // request burst a chance to join the same pack read.
    setTimeout(()=>flushTextureReads(pack,batch),0);
    requests=batch;
  }
  return new Promise<Uint8Array<ArrayBuffer>>((resolve,reject)=>
    requests.push({start,end:start+length,next:pack.offsets[row+1],resolve,reject}));
}

export async function readTextureChunk(pack:Pack,row:number,limit:number,
  decodePacked?:(bytes:Uint8Array,size:number)=>Uint8Array|null|Promise<Uint8Array|null>,packedCodec=4):Promise<Uint8Array|null>{
  const codec=pack.codecs[row],start=pack.offsets[row],size=textureChunkSize(pack,row);
  const length=pack.offsets[row+1]-start-pack.padding[row];
  if((codec!==0x20&&codec!==0&&!(codec===packedCodec&&decodePacked))||size<=0||size>limit||length<=0||length>size+1024)return null;
  const bytes=await readStoredTexture(pack,row,start,length);
  const data=codec===0x20?inflate(bytes,size):codec===0?bytes:await decodePacked?.(bytes,size);
  return data?.length===size?data:null;
}

export function mipRecords(pack: Pack, texture: Texture) {
  const rows: Omit<Mip,"data">[] = [];
  for (let stream=texture.start; stream<texture.end; stream++) {
    const offset = pack.offsets[stream];
    const delta = textureChunkSize(pack,stream);
    const length = pack.offsets[stream+1]-offset;
    for (const side of [128,256,512,1024]) {
      const expected = side*side/2;
      if (expected===delta && length-pack.padding[stream]<=expected+1024)
        rows.push({side,stream,offset});
    }
  }
  return rows;
}

export async function readMip(pack: Pack, texture: Texture, target: number): Promise<Mip | null> {
  const rows = mipRecords(pack,texture);
  rows.sort((a,b) => Number(a.side>target)-Number(b.side>target) ||
    (a.side<=target ? b.side-a.side : a.side-b.side));
  for (const row of rows) {
    const size = row.side*row.side/2;
    try {
      const data=await readTextureChunk(pack,row.stream,size);
      if(data)return {...row,data};
    } catch {
      // Test other mips in this descriptor when an individual stream is unreadable.
    }
  }
  return null;
}

export function blockOffset(x: number, y: number, columns: number, elementSize: 2 | 8 | 16) {
  const tileWidth = elementSize===2 ? 64 : elementSize===8 ? 32 : 16;
  const tileHeight = elementSize===2 ? 32 : 16;
  const order = elementSize===2 ? r16Order : elementSize===8 ? bc1Order : bc6Order;
  const pitch = Math.ceil(columns/tileWidth);
  return (Math.floor(y/tileHeight)*pitch+Math.floor(x/tileWidth))*4096 +
    order[(y%tileHeight)*tileWidth+x%tileWidth]*elementSize;
}

export function linearBc16(bytes:Uint8Array,width:number,height:number){
  const columns=width/4,rows=height/4,linear=new Uint8Array(columns*rows*16);
  for(let y=0;y<rows;y++)for(let x=0;x<columns;x++){
    const source=blockOffset(x,y,columns,16);
    linear.set(bytes.subarray(source,source+16),(y*columns+x)*16);
  }
  return linear;
}

function bitOrder(width: number,height: number,pattern: string) {
  const positions = pattern.split(" ").map(term => [term.startsWith("x"), Number(term[1])] as const);
  return Uint16Array.from({length:width*height}, (_,i) => positions.reduce((out,[x,shift],bit) =>
    out|(((((x ? i%width : Math.floor(i/width))>>shift)&1)<<bit)),0));
}
const r16Order = bitOrder(64,32,"x0 x1 x2 y0 y1 y2 x3 y3 x4 y4 x5");
const bc1Order = bitOrder(32,16,"x0 y0 y1 x1 x2 y2 x3 y3 x4");
const bc6Order = bitOrder(16,16,"y0 y1 x0 x1 y2 x2 y3 x3");

function unpack565(n: number, palette: Uint8Array, i: number) {
  const r = (n>>11)&31, g = (n>>5)&63, b = n&31;
  palette[i]=(r<<3)|(r>>2);
  palette[i+1]=(g<<2)|(g>>4);
  palette[i+2]=(b<<3)|(b>>2);
}

export function bc1(tiled: Uint8Array, width: number, height: number, keepAlpha=false, originX=0, originY=0): Image {
  const input = view(tiled);
  const rgba = new Uint8ClampedArray(width*height*4);
  const columns=Math.ceil(width/4),rows=Math.ceil(height/4);
  const palette = new Uint8Array(12);
  for (let by=0;by<rows;by++) for (let bx=0;bx<columns;bx++) {
    const at = blockOffset(bx+originX,by+originY,columns,8);
    const c0 = input.getUint16(at,true), c1 = input.getUint16(at+2,true), mask = input.getUint32(at+4,true);
    unpack565(c0,palette,0);
    unpack565(c1,palette,3);
    for (let c=0;c<3;c++) {
      const a = palette[c], b = palette[c+3];
      palette[c+6] = c0>c1 ? (2*a+b)/3 : (a+b)/2;
      palette[c+9] = c0>c1 ? (a+2*b)/3 : 0;
    }
    for (let y=0;y<4&&by*4+y<height;y++) for (let x=0;x<4&&bx*4+x<width;x++) {
      const from = 3*((mask>>>(2*(y*4+x)))&3);
      const to = ((by*4+y)*width+bx*4+x)*4;
      rgba[to]=palette[from];rgba[to+1]=palette[from+1];rgba[to+2]=palette[from+2];
      rgba[to+3]=keepAlpha&&c0<=c1&&from===9?0:255;
    }
  }
  return {width,height,rgba};
}

export function sample(image: Image, x: number, y: number, size: number) {
  const sx = Math.floor(x*image.width/size), ex = Math.max(sx+1,Math.floor((x+1)*image.width/size));
  const sy = Math.floor(y*image.height/size), ey = Math.max(sy+1,Math.floor((y+1)*image.height/size));
  let r=0,g=0,b=0;
  for (let j=sy;j<ey;j++) for(let i=sx;i<ex;i++) {
    const at = (j*image.width+i)*4;
    r+=image.rgba[at];g+=image.rgba[at+1];b+=image.rgba[at+2];
  }
  const div=(ey-sy)*(ex-sx);
  return [r/div,g/div,b/div];
}

export async function bitmap(image: Image, maxSide=image.width) {
  const pixels = new ImageData(image.rgba,image.width,image.height);
  if (image.width<=maxSide) return createImageBitmap(pixels);
  return createImageBitmap(pixels,{
    resizeWidth:maxSide,resizeHeight:Math.round(image.height*maxSide/image.width),resizeQuality:"high",
  });
}

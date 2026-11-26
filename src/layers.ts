import { Archive, text, view } from "./archive";
import type { Rect } from "./recover";
import { readAdjacentResource, scanSmallReadableResources } from "./readable-resources";
import { bc1, bitmap, blockOffset, type Image } from "./texture";

export type OverviewLayer = { image: ImageBitmap; rect: Rect } & (
  { name: "surface"|"roads"|"lights" } |
  { name: "height"|"cartography"; elevation: Uint16Array<ArrayBuffer> }
);
const maxResource=64*1024*1024;
const clip=(n:number,min=0,max=1)=>Math.max(min,Math.min(max,n));

export function findTextureDescriptor(metadata:Uint8Array,name:string) {
  if(metadata.length<0x3a)throw new Error("textures.rpf: truncated texture dictionary");
  const data=view(metadata);
  const table=data.getUint32(0x30,true)-0x50000000;
  const count=data.getUint16(0x38,true);
  if(table<0||table+count*8>metadata.length) throw new Error("textures.rpf: invalid texture dictionary");
  for(let i=0;i<count;i++) {
    const descriptor=data.getUint32(table+i*8,true)-0x50000000;
    if(descriptor<0||descriptor+0x41>metadata.length) throw new Error("textures.rpf: invalid texture pointer");
    const pointer=data.getUint32(descriptor+0x30,true)-0x50000000+8;
    const end=metadata.indexOf(0,pointer);
    if(pointer<0||end<0||text.decode(metadata.subarray(pointer,end))!==name) continue;
    return {
      width:data.getUint16(descriptor+0x38,true),height:data.getUint16(descriptor+0x3a,true),
      format:data.getUint8(descriptor+0x3f),depth:data.getUint16(descriptor+0x3c,true),
      dimension:data.getUint8(descriptor+0x3e),layout:data.getUint8(descriptor+0x40),
      start:data.getUint32(descriptor+0x18,true)-0x60000000,elements:data.getUint32(descriptor+8,true),
    };
  }
  throw new Error(`textures.rpf: ${name} missing`);
}

export function textureSurface(metadata:Uint8Array, graphics:Uint8Array,name:string,format:number) {
  const {width,height,format:fmt,depth,dimension,layout,start,elements}=findTextureDescriptor(metadata,name);
  const size=fmt===56?2:fmt===71?8:16,block=fmt===56?1:4;
  if(fmt!==format||depth!==1||dimension!==1||layout!==5||!width||!height||width>2048||height>2048)
    throw new Error(`textures.rpf: unexpected layout for ${name}`);
  const tw=size===2?64:size===8?32:16,th=size===2?32:16;
  const length=Math.ceil(width/(tw*block))*Math.ceil(height/(th*block))*4096;
  const stop=start+elements*size;
  if(start<0||stop>graphics.length||stop-start<length)throw new Error(`textures.rpf: incomplete surface for ${name}`);
  return {width,height,bytes:graphics.subarray(stop-length,stop)};
}
type Surface = ReturnType<typeof textureSurface>;

function r16(surface:Surface) {
  const {width,height,bytes}=surface,data=view(bytes);
  const samples=new Uint16Array(width*height);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++)
    samples[y*width+x]=data.getUint16(blockOffset(x,y,width,2),true);
  return samples;
}

function gray(image:Image) {
  const values=new Uint8Array(image.width*image.height);
  for(let i=0;i<values.length;i++) values[i]=Math.round(
    (image.rgba[i*4]*299+image.rgba[i*4+1]*587+image.rgba[i*4+2]*114)/1000);
  return values;
}

type NightDecoder = {
  memory:WebAssembly.Memory; input:()=>number; output:()=>number; decode_night:(width:number,height:number)=>void;
};
async function nightMap(surface:Surface) {
  const response=await fetch(new URL("./night-decode.wasm",import.meta.url));
  if(!response.ok) throw new Error("Night-light decoder could not load");
  const {instance}=await WebAssembly.instantiate(await response.arrayBuffer());
  const wasm=instance.exports as unknown as NightDecoder;
  const memory=new Uint8Array(wasm.memory.buffer);
  const {width,height,bytes}=surface,columns=width/4;
  if(width!==1024||height!==2048) throw new Error("Unexpected night-light dimensions");
  const start=wasm.input();
  for(let y=0;y<height/4;y++) for(let x=0;x<columns;x++) {
    const at=blockOffset(x,y,columns,16);
    memory.set(bytes.subarray(at,at+16),start+(y*columns+x)*16);
  }
  wasm.decode_night(width,height);
  return memory.slice(wasm.output(),wasm.output()+width*height);
}

function blur(input:ArrayLike<number>,width:number,height:number,radius:number) {
  const extent=Math.ceil(radius*2.5);
  const kernel=Float32Array.from({length:extent*2+1},(_,i)=>Math.exp(-(((i-extent)/radius)**2)/2));
  const weight=kernel.reduce((a,b)=>a+b,0);
  const horizontal=new Float32Array(width*height),result=new Float32Array(width*height);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    let value=0;
    for(let d=-extent;d<=extent;d++) value+=kernel[d+extent]*input[y*width+clip(x+d,0,width-1)];
    horizontal[y*width+x]=value/weight;
  }
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    let value=0;
    for(let d=-extent;d<=extent;d++) value+=kernel[d+extent]*horizontal[clip(y+d,0,height-1)*width+x];
    result[y*width+x]=value/weight;
  }
  return result;
}

const levels=[0,24000,27700,28100,28300,29300,32000,41000,65535];
const palette=[[10,22,35],[10,28,46],[22,55,76],[34,79,99],[83,112,94],
  [125,144,107],[161,151,111],[195,181,144],[239,227,197]];

function relief(samples:Uint16Array,width:number,height:number):Image {
  const rgba=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const i=y*width+x,z=samples[i];
    let k=1;
    while(k<levels.length-1&&z>levels[k]) k++;
    const t=(z-levels[k-1])/(levels[k]-levels[k-1]);
    const dx=(samples[y*width+Math.min(x+1,width-1)]-samples[y*width+Math.max(x-1,0)])/(x===0||x===width-1?1:2);
    const dy=(samples[Math.min(y+1,height-1)*width+x]-samples[Math.max(y-1,0)*width+x])/(y===0||y===height-1?1:2);
    const shade=1+clip((dy-dx)/330,-.28,.25);
    for(let c=0;c<3;c++) rgba[i*4+c]=(palette[k-1][c]*(1-t)+palette[k][c]*t)*shade;
    rgba[i*4+3]=255;
  }
  return {width,height,rgba};
}

function surfaceDetail(base:Uint16Array,surface:Uint16Array,ground:Image):Image {
  const {width,height}=ground;
  const diff=Uint16Array.from(surface,(z,i)=>Math.max(0,z-base[i]));
  const coarse=Uint8Array.from(diff,z=>Math.min(255,z/15));
  const background=blur(coarse,width,height,5.5);
  const rgba=new Uint8ClampedArray(width*height*4),tint=[247,222,169],bias=[2,5,8];
  for(let i=0;i<diff.length;i++) {
    const weight=.86*clip((.88*diff[i]-.57*background[i]*15-37)/1050)**.61*clip((base[i]-25500)/1900);
    for(let c=0;c<3;c++) rgba[i*4+c]=(ground.rgba[i*4+c]*.77+bias[c])*(1-weight)+tint[c]*weight;
    rgba[i*4+3]=255;
  }
  return {width,height,rgba};
}

function signalLayer(width:number,height:number,color:number[],alpha:(i:number)=>number):Image {
  const rgba=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<width*height;i++) {
    const at=i*4;
    rgba[at]=color[0];rgba[at+1]=color[1];rgba[at+2]=color[2];rgba[at+3]=alpha(i);
  }
  return {width,height,rgba};
}

const mapBands=[0,24800,27300,28020,28120,28230,28650,30800,36000,65535];
const mapColors=[
  [29,56,86],[39,87,115],[52,128,151],[93,166,169],[206,196,151],
  [210,201,156],[159,175,133],[125,153,116],[157,167,123],[205,195,153],
];
const roadInk=[249,239,213];

function cartography(elevation:Uint16Array,width:number,height:number,roads:Image):Image {
  const rgba=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++){
    // Both rasters have the same world bounds. Interpolate at their pixel centers.
    const ry=clip((y+.5)*roads.height/height-.5,0,roads.height-1);
    const north=Math.floor(ry),south=Math.min(north+1,roads.height-1),ty=ry-north;
    for(let x=0;x<width;x++){
      const i=y*width+x,z=elevation[i];
      let band=1;
      while(band<mapBands.length-1&&z>mapBands[band]) band++;
      const t=(z-mapBands[band-1])/(mapBands[band]-mapBands[band-1]);
      const rx=clip((x+.5)*roads.width/width-.5,0,roads.width-1);
      const west=Math.floor(rx),east=Math.min(west+1,roads.width-1),tx=rx-west;
      const a=roads.rgba[(north*roads.width+west)*4+3]*(1-tx)+roads.rgba[(north*roads.width+east)*4+3]*tx;
      const b=roads.rgba[(south*roads.width+west)*4+3]*(1-tx)+roads.rgba[(south*roads.width+east)*4+3]*tx;
      const ink=.93*clip(((a*(1-ty)+b*ty)/255-.07)/.71)*clip((z-26100)/1600);
      for(let c=0;c<3;c++){
        const ground=mapColors[band-1][c]*(1-t)+mapColors[band][c]*t;
        rgba[i*4+c]=ground*(1-ink)+roadInk[c]*ink;
      }
      rgba[i*4+3]=255;
    }
  }
  return {width,height,rgba};
}

type OverviewDictionaries = {
  environment?: {bytes:Uint8Array;next:number};
  height: {bytes:Uint8Array;next:number}[];
};

async function findOverviewDictionaries(archive:Archive):Promise<OverviewDictionaries> {
  const result:OverviewDictionaries={height:[]};
  for await(const page of scanSmallReadableResources(archive,64*1024,true)){
    const nameTable=text.decode(page.bytes);
    if(nameTable.includes("heightmap\0")){
      try{
        const descriptor=findTextureDescriptor(page.bytes,"heightmap");
        if(descriptor.format===56&&descriptor.layout===5)result.height.push(page);
      }catch{}
    }
    if(nameTable.includes("puddle_control\0")&&nameTable.includes("light_pollution_map\0")){
      try{
        findTextureDescriptor(page.bytes,"puddle_control");
        findTextureDescriptor(page.bytes,"light_pollution_map");
        result.environment=page;
      }catch{}
    }
    if(result.environment&&result.height.length===2)return result;
  }
  return result;
}

const localOverview=new WeakMap<Blob,Promise<OverviewDictionaries>>();
function overviewDictionaries(archive:Archive) {
  let existing=localOverview.get(archive.file);
  if(!existing){
    existing=findOverviewDictionaries(archive).catch(error=>{
      localOverview.delete(archive.file);
      throw error;
    });
    localOverview.set(archive.file,existing);
  }
  return existing;
}

async function readHeightSurface(archive:Archive,index:number) {
  const {height}=await overviewDictionaries(archive);
  const page=height[index];
  if(!page)throw new Error("textures.rpf: overview height dictionary is unavailable");
  return textureSurface(page.bytes,await readAdjacentResource(archive,page.next,8*1024*1024),"heightmap",56);
}

export async function readOverviewElevation(archive:Archive) {
  const surface=await readHeightSurface(archive,0);
  return {elevation:r16(surface),width:surface.width,height:surface.height};
}

export function overviewLayers(archive:Archive,world:Rect) {
  const readBase=async()=>{
    const {elevation,width,height}=await readOverviewElevation(archive);
    return {elevation,ground:relief(elevation,width,height)};
  };
  let base:ReturnType<typeof readBase>|undefined;
  const readDictionary=async ()=>{
    const {environment}=await overviewDictionaries(archive);
    if(!environment)throw new Error("textures.rpf: overview lighting and road dictionary is unavailable");
    return [environment.bytes,await readAdjacentResource(archive,environment.next,maxResource)] as const;
  };
  let dictionary:ReturnType<typeof readDictionary>|undefined;
  const readRoads=async()=>{
    const [metadata,graphics]=await (dictionary??=readDictionary());
    const road=textureSurface(metadata,graphics,"puddle_control",71);
    const grayscale=gray(bc1(road.bytes,road.width,road.height));
    const narrow=blur(grayscale,road.width,road.height,.65),broad=blur(grayscale,road.width,road.height,5);
    return signalLayer(road.width,road.height,[93,241,241],i=>
      Math.max(0,255*clip((narrow[i]-.85*broad[i]-3)/78)**.8-11)*255/244);
  };
  let roads:ReturnType<typeof readRoads>|undefined;
  return async (name:OverviewLayer["name"]):Promise<OverviewLayer>=>{
    if(name==="roads")return {name,image:await bitmap(await (roads??=readRoads())),rect:world};
    if(name==="lights"){
      const [metadata,graphics]=await (dictionary??=readDictionary());
      const light=textureSurface(metadata,graphics,"light_pollution_map",95);
      const lights=await nightMap(light);
      const [x,y,w,h]=world;
      return {name,image:await bitmap(signalLayer(light.width,light.height,[255,183,84],i=>
        255*(Math.max(0,lights[i]-2)/253)**.38)),rect:[x+w*.04055,y-h*.30682,w*.87669,h*1.23438]};
    }
    const {elevation,ground}=await (base??=readBase());
    if(name==="height")return {name,image:await bitmap(ground),rect:world,elevation:elevation.slice()};
    if(name==="cartography"){
      const road=await (roads??=readRoads());
      return {name,image:await bitmap(cartography(elevation,ground.width,ground.height,road)),
        rect:world,elevation:elevation.slice()};
    }
    const detail=await readHeightSurface(archive,1);
    if(detail.width!==ground.width||detail.height!==ground.height)throw new Error("textures.rpf: surface layer extent differs");
    return {name,image:await bitmap(surfaceDetail(elevation,r16(detail),ground)),rect:world};
  };
}

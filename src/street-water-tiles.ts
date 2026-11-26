import type { Archive } from "./archive";
import { findTextureDescriptor } from "./layers";
import { readCarvedZlib } from "./street-index-scan";
import { linearBc16 } from "./texture";
import { makeProgram } from "./view-gl";
import type { OpticsSurface, StreetWaterOptics } from "./street-water-optics";
import { waterTileGraphicsBytes, type WaterTileDictionary } from "./street-water-resource";

const tileSide=128;
const mapBytes=tileSide*tileSide;
type Resource={metadata:number;offset:number};
type WaterTileSource=(current:()=>boolean)=>AsyncIterable<WaterTileDictionary>;
export type StreetWaterTileIndex={bounds:StreetWaterOptics["bounds"];tileSize:number;offsets:Float64Array};
type Match={ordinal:number;cell:number};

export async function readStreetWaterTileMembers(list:WaterTileSource,current:()=>boolean){
  const tiles:Resource[]=[];
  const valid=(value:ReturnType<typeof findTextureDescriptor>)=>
    value.elements*16===mapBytes&&value.width===tileSide&&value.height===tileSide&&
    value.depth===1&&value.dimension===1&&value.format===95&&value.layout===5;
  for await(const {metadata,offset,graphicsOffset} of list(current)){
    try{
      const extinction=findTextureDescriptor(metadata,"waterfog2");
      const scattering=findTextureDescriptor(metadata,"waterfog");
      if(valid(extinction)&&valid(scattering)&&extinction.start+scattering.start===mapBytes&&
        (extinction.start===0||extinction.start===mapBytes))
        tiles.push({metadata:offset,offset:graphicsOffset*(extinction.start===0?1:-1)});
    }catch{
      // A dictionary matching the page dimensions may bind different textures.
    }
  }
  return tiles;
}

async function readTile(archive:Archive,signedOffset:number){
  const offset=Math.abs(signedOffset);
  const bytes=await archive.read(offset,Math.min(48*1024,archive.file.size-offset));
  const page=readCarvedZlib(bytes,waterTileGraphicsBytes);
  if(!page||page.bytes.length!==waterTileGraphicsBytes)return;
  const first=linearBc16(page.bytes.subarray(0,mapBytes),tileSide,tileSide);
  const second=linearBc16(page.bytes.subarray(mapBytes),tileSide,tileSide);
  return signedOffset>0?{extinction:first,scattering:second}:{extinction:second,scattering:first};
}

export function inferWaterTileOrder(resources:readonly Resource[],cells:number,matches:readonly Match[]){
  // Local tiles form consecutive archive runs whose order is independently
  // checked against spatial fingerprints from both global textures.
  if(resources.some((resource,i)=>i>0&&(resource.metadata<=resources[i-1].metadata||
    resource.metadata-resources[i-1].metadata>64*1024)))return;
  const runs=new Map<number,number[]>();
  for(const {ordinal,cell} of matches){
    const delta=cell-ordinal,previous=runs.get(delta)??[];
    previous.push(ordinal);
    runs.set(delta,previous);
  }
  const ranked=[...runs].filter(([,hits])=>hits.length>=3).sort((a,b)=>b[1].length-a[1].length);
  const primary=ranked[0];
  if(!primary||primary[0]<0||primary[1].length<6||
    Math.max(...primary[1])-Math.min(...primary[1])<resources.length*.35)return;
  const offsets=new Float64Array(cells);
  const last=Math.min(resources.length,cells-primary[0]);
  for(let i=0;i<last;i++)offsets[i+primary[0]]=resources[i].offset;
  if(last<resources.length){
    const secondary=ranked.find(([delta,hits])=>delta!==primary[0]&&hits.every(i=>i>=last)&&
      last+delta>=0&&last+delta<primary[0]);
    if(secondary){
      for(let i=last;i<resources.length&&i+secondary[0]<primary[0];i++)offsets[i+secondary[0]]=resources[i].offset;
    }
  }
  return offsets;
}

function channelsDistance(a:Float32Array,ia:number,b:Float32Array,ib:number){
  let sum=0;
  for(let c=0;c<48;c++)sum+=(a[ia+c]-b[ib+c])**2;
  return Math.sqrt(sum/48);
}

function features(pixels:Float32Array,columns:number,rows:number){
  const output=new Float32Array(columns*rows*48);
  for(let row=0;row<rows;row++)for(let col=0;col<columns;col++)for(let y=0;y<4;y++)for(let x=0;x<4;x++){
    const source=((row*4+y)*columns*4+col*4+x)*4;
    const target=(row*columns+col)*48+(y*4+x)*3;
    output.set(pixels.subarray(source,source+3),target);
  }
  return output;
}

const vertex=`#version 300 es
void main(){
  vec2 uv=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));
  gl_Position=vec4(2.0*uv-1.0,0.0,1.0);
}`;
const fragment=`#version 300 es
precision highp float;
uniform highp sampler2D source;
uniform int stepSize;
out vec4 color;
void main(){
  ivec2 start=ivec2(gl_FragCoord.xy)*stepSize*4;
  vec3 sum=vec3(0.0);
  for(int y=0;y<4;y++)for(int x=0;x<4;x++){
    vec3 value=texelFetch(source,start+ivec2(x,y)*stepSize+stepSize/2,0).rgb;
    sum+=log(1.0+300.0*clamp(value,0.0,1.5));
  }
  color=vec4(sum/16.0,1.0);
}`;

function fingerprints(inputs:{source:OpticsSurface;columns:number;rows:number}[]){
  if(typeof OffscreenCanvas==="undefined")return;
  const gl=new OffscreenCanvas(1,1).getContext("webgl2",{antialias:false,depth:false});
  if(!gl)return;
  try{
    const bc=gl.getExtension("EXT_texture_compression_bptc");
    if(!bc||!gl.getExtension("EXT_color_buffer_float"))return;
    const program=makeProgram(gl,vertex,fragment),framebuffer=gl.createFramebuffer();
    const source=gl.createTexture(),target=gl.createTexture();
    gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
    gl.useProgram(program);
    const step=gl.getUniformLocation(program,"stepSize");
    const results=[];
    for(const {source:surface,columns,rows} of inputs){
      const width=columns*4,height=rows*4;
      const scale=surface.width/width;
      if(scale!==surface.height/height||scale%4!==0)return;
      gl.bindTexture(gl.TEXTURE_2D,target);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,width,height,0,gl.RGBA,gl.FLOAT,null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,target,0);
      if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)return;
      gl.bindTexture(gl.TEXTURE_2D,source);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
      gl.compressedTexImage2D(gl.TEXTURE_2D,0,bc.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT,
        surface.width,surface.height,0,surface.bytes);
      gl.uniform1i(step,scale/4);
      gl.viewport(0,0,width,height);
      gl.drawArrays(gl.TRIANGLES,0,3);
      const pixels=new Float32Array(width*height*4);
      gl.readPixels(0,0,width,height,gl.RGBA,gl.FLOAT,pixels);
      if(gl.getError()!==gl.NO_ERROR)return;
      results.push(features(pixels,columns,rows));
    }
    return results;
  }finally{gl.getExtension("WEBGL_lose_context")?.loseContext();}
}

function placeTile(bytes:Uint8Array,atlas:Uint8Array,pitch:number,col:number,row:number){
  const blockRows=tileSide/4,slice=blockRows*16;
  for(let y=0;y<blockRows;y++)
    atlas.set(bytes.subarray(y*slice,(y+1)*slice),((row*blockRows+y)*pitch+col)*slice);
}

export async function buildStreetWaterTileIndex(archive:Archive,optics:StreetWaterOptics,current:()=>boolean,
  list:WaterTileSource):Promise<StreetWaterTileIndex|undefined>{
  const {bounds,tileSize}=optics;
  if(!tileSize||typeof OffscreenCanvas==="undefined")return;
  const columns=bounds[2]/tileSize,rows=bounds[3]/tileSize,cells=columns*rows;
  if(!Number.isInteger(columns)||!Number.isInteger(rows)||cells<1||cells>8192)return;
  const resources=await readStreetWaterTileMembers(list,current);
  if(!current()||resources.length<48||resources.length>cells)return;
  const groups=48,probeColumns=8,probeRows=Math.ceil(groups/probeColumns);
  const picks:number[]=[];
  const width=probeColumns*tileSide,height=probeRows*tileSide;
  const probeExtinction=new Uint8Array(width*height),probeScattering=new Uint8Array(width*height);
  for(let group=0;group<groups&&current();group++){
    const from=Math.floor(group*resources.length/groups),to=Math.floor((group+1)*resources.length/groups);
    let selected=from,size=0;
    for(let i=from;i<to;i++){
      const span=(resources[i+1]?.metadata??resources[i].metadata+4096)-resources[i].metadata;
      if(span>size){size=span;selected=i;}
    }
    const tile=await readTile(archive,resources[selected].offset);
    if(!tile)continue;
    const col=picks.length%probeColumns,row=Math.floor(picks.length/probeColumns);
    picks.push(selected);
    placeTile(tile.extinction,probeExtinction,probeColumns,col,row);
    placeTile(tile.scattering,probeScattering,probeColumns,col,row);
  }
  if(!current()||picks.length<6)return;
  const measured=fingerprints([{source:optics.extinction,columns,rows},{source:optics.scattering,columns,rows},
    {source:{width,height,bytes:probeExtinction},columns:probeColumns,rows:probeRows},
    {source:{width,height,bytes:probeScattering},columns:probeColumns,rows:probeRows}]);
  if(!measured)return;
  const [extinction,scattering,probeExt,probeScatter]=measured;
  const matches:Match[]=[];
  for(const [i,ordinal] of picks.entries()){
    let best=Infinity,second=Infinity,cell=0;
    for(let candidate=0;candidate<cells;candidate++){
      const distance=channelsDistance(probeExt,i*48,extinction,candidate*48);
      if(distance<best){second=best;best=distance;cell=candidate;}
      else if(distance<second)second=distance;
    }
    if(best<.16&&second>best*2.4&&channelsDistance(probeScatter,i*48,scattering,cell*48)<.16)
      matches.push({ordinal,cell});
  }
  const offsets=inferWaterTileOrder(resources,cells,matches);
  if(offsets)return {bounds,tileSize,offsets};
}

export async function loadStreetWaterTileRegion(archive:Archive,index:StreetWaterTileIndex,
  [centerX,centerY]:readonly [number,number],active:()=>boolean):Promise<StreetWaterOptics|undefined>{
  const {bounds,tileSize,offsets}=index,columns=bounds[2]/tileSize,rows=bounds[3]/tileSize;
  const radius=2,side=radius*2+1;
  const width=side*tileSide,height=width;
  const scatter=new Uint8Array(width*height),extinct=new Uint8Array(width*height);
  const left=centerX-radius,top=centerY-radius;
  let count=0;
  for(let row=0;row<side&&active();row++)for(let col=0;col<side&&active();col++){
    const x=left+col,y=top+row;
    const offset=x>=0&&y>=0&&x<columns&&y<rows?offsets[y*columns+x]:0;
    if(!offset)continue;
    const tile=await readTile(archive,offset);
    if(!tile)continue;
    placeTile(tile.extinction,extinct,side,col,row);
    placeTile(tile.scattering,scatter,side,col,row);
    count++;
  }
  if(!active()||!count)return;
  return {bounds:[bounds[0]+left*tileSize,bounds[1]-top*tileSize,side*tileSize,side*tileSize],tileSize,
    scattering:{width,height,bytes:scatter},extinction:{width,height,bytes:extinct}};
}

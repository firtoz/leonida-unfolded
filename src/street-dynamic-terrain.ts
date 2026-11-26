import {view} from "./archive";
import type {Image} from "./texture";
import {dynamicTerrainPrefix,terrainTexturePrefix,type StreetTextureImage} from "./street-terrain-material";
import { terrainSectorBounds } from "./street-grid";

type Control={
  id:string;sector:{origin:readonly [number,number]};layerMask:number;primaryMask:number;
  authoredTint?:true;maskUV:string;
};

export function dynamicTerrainControl(drawable:string,ordinal:number,part:number,values:(offset:number)=>number[]):Control|undefined{
  const match=/^([ns]\d{2})_([ew]\d{2})_\d{3}_hd$/.exec(drawable);
  if(!match||values(0x10).join()!=="1,1,0,0")return;
  const primary=values(0).join(),selectors=values(0x20),coefficients=values(0x30);
  const maskUV=values(0x70).join();
  if(selectors.some(value=>value!==1&&value!==2)||coefficients.some(value=>value!==0&&value!==1))return;
  const primaryMask=selectors.reduce((mask,value,i)=>value===1?mask|(1<<i):mask,0);
  const layerMask=coefficients.reduce((mask,value,i)=>value===1?mask|(1<<i):mask,0);
  const compact=primary==="128,128,0,0";
  const localTint=compact&&(maskUV==="1,0,1,2"||maskUV==="3,0,1,2");
  const thirdLayer=compact&&maskUV==="3,0,2,0"&&layerMask===4&&
    (primaryMask===15||primaryMask===4);
  const planar=primary==="128,128,128,128"&&maskUV==="1,0,1,2"&&layerMask===8&&primaryMask===0;
  if(!layerMask||!(localTint||thirdLayer||planar))return;
  const [x,y]=terrainSectorBounds(match[1],match[2]);
  return {
    id:`${dynamicTerrainPrefix}${drawable}:${ordinal}:${part.toString(16).padStart(6,"0")}`,
    sector:{origin:[x,y]},layerMask,primaryMask,maskUV,authoredTint:localTint?true:undefined,
  };
}

type TerrainPageSource={
  control:{id:string;sector:{origin:readonly [number,number]}};
  bounds:[number,number,number,number];
  sectorOnly:true;
};

export type ComposedTerrainSource={
  control:Control;
  vertices:Float32Array;
  triangles:Uint32Array;
  bounds:[number,number,number,number];
  sectorOnly?:never;
  colors:string[];
  heights:string[];
  gain:number[];
  bias:number[];
  strength:number[];
  localMask?:{key:string;alpha:Uint8Array;uv?:Float32Array};
  auxiliary?:Uint8Array;
  localTint?:{rgb:Uint8Array;scale:number[];sector?:{
    key:string;scale:number[];amount:number[];vertexAmount:number[];
  }};
  localNormals?:{keys:(string|null)[];strength:number[];frames?:{
    normals:Int16Array;primary:Int16Array;secondary:Int16Array;
  }};
};
export function sectorTerrainPage(drawable:string,ordinal:number,part:number,
  bounds:TerrainPageSource["bounds"]):TerrainPageSource|undefined{
  const match=/^([ns]\d{2})_([ew]\d{2})_\d{3}_hd$/.exec(drawable);
  if(!match)return;
  const [x,y,right,top]=terrainSectorBounds(match[1],match[2]);
  const [left,bottom,end,north]=bounds;
  if(!bounds.every(Number.isFinite)||!(end>left&&north>bottom)||
    left<x-.0001||bottom<y-.0001||end>right+.0001||north>top+.0001)return;
  return {sectorOnly:true,bounds,control:{
    id:`${dynamicTerrainPrefix}${drawable}:page-v3:${ordinal}:${part.toString(16)}`,
    sector:{origin:[x,y]},
  }};
}

export type DynamicTerrainSource=ComposedTerrainSource|TerrainPageSource;
type Input=(id:string)=>Promise<StreetTextureImage|null>;
export type TerrainSectorReader=(name:string)=>Promise<Uint8Array|undefined>;
const side=512;
const toLinear=(c:number)=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4;
const linear=Float32Array.from({length:256},(_,v)=>toLinear(v/255));
const unorm=Float32Array.from({length:256},(_,v)=>v/255);

function readSector(bytes:Uint8Array){
  const data=view(bytes);
  if(data.byteLength<0x50||data.getUint32(0,false)!==0x5053494e||data.getUint32(8,true)!==0x318ebf00)return;
  const schema=data.getUint32(4,false),count=data.getUint32(12,true)/8;
  if(!Number.isInteger(count)||count<=0||count>65536||schema<0x78||schema>=data.byteLength-3||data.getUint32(schema,false)!==0x4c534348)return;
  const coefficients=schema-192-128*count,coverageEnd=0x50+8*count;
  const padding=coefficients-coverageEnd-40*count;
  if(padding!==0&&padding!==16)return;
  const table=coverageEnd+padding/2;
  const key=(offset:number)=>"0x"+data.getBigUint64(offset,true).toString(16).padStart(16,"0");
  const index=key(schema-0x70),weights=key(schema-0x78);
  const rows=Array.from({length:count},(_,i)=>{
    const offset=coefficients+i*128;
    const selector=data.getFloat32(offset+16,true);
    // Both deferred samplers use the fixed planar transform for selector 2.
    const [sx,sy,ox,oy]=selector===2?[64,64,0,0]:[0,4,8,12].map(x=>data.getFloat32(offset+x,true));
    const [gain,bias,strength]=[32,36,40].map(x=>data.getFloat32(offset+x,true));
    const [tintAmount,tintGain,correctionAmount,correctionGain]=[20,24,48,52].map(x=>data.getFloat32(offset+x,true));
    const tint=Number.isFinite(tintAmount)&&Number.isFinite(tintGain)&&Number.isFinite(correctionAmount)&&
      Number.isFinite(correctionGain)&&(tintAmount!==0||correctionAmount!==0)
      ?{tintAmount,tintGain,correctionAmount,correctionGain}:undefined;
    const normalGain=data.getFloat32(offset+28,true),pageAlphaGain=data.getFloat32(offset+44,true),surfaceGain=data.getFloat32(offset+80,true);
    return {sx,sy,ox,oy,selector,gain,bias,strength,tint,normalGain,pageAlphaGain,surfaceGain,color:key(table+i*40+16),normal:key(table+i*40+24),height:key(table+i*40+32)};
  });
  return {index,weights,rows,tint:key(schema-0x58),correction:key(schema-0x60)};
}

async function loadSectorInputs(name:string,input:Input,read:TerrainSectorReader){
  const bytes=await read(name);
  const sector=bytes&&readSector(bytes);
  if(!sector)return null;
  const index=await input(terrainTexturePrefix+"indices:"+sector.index);
  const weightMap=await input(terrainTexturePrefix+"weights:"+sector.weights);
  if(index?.width!==1024||index.height!==1024||weightMap?.width!==2048||weightMap.height!==2048)return null;
  return {sector,index,weightMap,input};
}

const materialCacheBytes=16*1024*1024;
function cacheSectorMaterials(input:Input):Input{
  const images=new Map<string,Promise<Image|null>>();
  let retained=0;
  return id=>{
    const existing=images.get(id);
    if(existing)return existing;
    // Missing inputs are stable for the current file selection. Successful inputs
    // are retained only while this sector is live and within its image budget.
    const pending=input(id).then(image=>{
      if(image){
        const bytes=image.rgba.byteLength+(image.authoredMips?.reduce((total,mip)=>total+mip.rgba.byteLength,0)??0);
        if(retained+bytes>materialCacheBytes)images.delete(id);
        else retained+=bytes;
      }
      return image;
    },error=>{
      images.delete(id);
      throw error;
    });
    images.set(id,pending);
    return pending;
  };
}

export class DynamicTerrainSectorCache {
  private readonly entries=new Map<string,ReturnType<typeof loadSectorInputs>>();

  read(name:string,input:Input,read:TerrainSectorReader){
    const existing=this.entries.get(name);
    if(existing){
      this.entries.delete(name);
      this.entries.set(name,existing);
      return existing;
    }
    const inputs=loadSectorInputs(name,input,read).then(data=>data&&{
      ...data,input:cacheSectorMaterials(input),
    });
    this.entries.set(name,inputs);
    // Each of the two recent sectors holds 20 MiB of maps and up to 16 MiB of materials.
    if(this.entries.size>2)this.entries.delete(this.entries.keys().next().value!);
    const discard=()=>{if(this.entries.get(name)===inputs)this.entries.delete(name);};
    void inputs.then(data=>{if(!data)discard();},discard);
    return inputs;
  }

  clear(){this.entries.clear();}
}

function raster(source:ComposedTerrainSource,keepFrames:boolean){
  const {vertices,triangles,auxiliary,localTint,localMask}=source;
  const attributes=new Float32Array(side*side*7),covered=new Uint8Array(side*side);
  const auxiliaryWeights=auxiliary?new Float32Array(side*side):undefined;
  const colorStride=localTint?.sector?4:3;
  const colors=localTint?new Float32Array(side*side*colorStride):undefined;
  const frameFaces=keepFrames?new Uint32Array(side*side):undefined;
  const frameBary=keepFrames?new Float32Array(side*side*2):undefined;
  const maskAlpha=localMask?new Float32Array(side*side):undefined;
  const maskUV=localMask?.uv?new Float32Array(side*side*2):undefined;
  for(let at=0;at<triangles.length;at+=3){
    const ia=triangles[at],ib=triangles[at+1],ic=triangles[at+2];
    const a=ia*9,b=ib*9,c=ic*9;
    const x=vertices[a]*side-.5,y=vertices[a+1]*side-.5;
    const bx=vertices[b]*side-.5-x,by=vertices[b+1]*side-.5-y;
    const cx=vertices[c]*side-.5-x,cy=vertices[c+1]*side-.5-y;
    const det=bx*cy-by*cx;
    if(Math.abs(det)<1e-8)continue;
    const n0=auxiliary?.[ia]??0;
    const n1=(auxiliary?.[ib]??0)-n0,n2=(auxiliary?.[ic]??0)-n0;
    for(let py=Math.max(0,Math.ceil(Math.min(y,y+by,y+cy)));py<=Math.min(side-1,Math.floor(Math.max(y,y+by,y+cy)));py++){
      for(let px=Math.max(0,Math.ceil(Math.min(x,x+bx,x+cx)));px<=Math.min(side-1,Math.floor(Math.max(x,x+bx,x+cx)));px++){
        const u=((px-x)*cy-(py-y)*cx)/det,v=(bx*(py-y)-by*(px-x))/det;
        if(u<0||v<0||u+v>1)continue;
        const i=py*side+px;
        covered[i]=1;
        if(frameFaces&&frameBary){
          frameFaces[i]=at;
          frameBary[i*2]=u;
          frameBary[i*2+1]=v;
        }
        if(auxiliaryWeights)auxiliaryWeights[i]=(n0+u*n1+v*n2)/15;
        if(localMask&&maskAlpha){
          const {alpha,uv}=localMask;
          maskAlpha[i]=(alpha[ia]+u*(alpha[ib]-alpha[ia])+v*(alpha[ic]-alpha[ia]))/255;
          if(uv&&maskUV)for(let lane=0;lane<2;lane++){
            const base=uv[ia*2+lane];
            maskUV[i*2+lane]=base+u*(uv[ib*2+lane]-base)+v*(uv[ic*2+lane]-base);
          }
        }
        if(colors&&localTint)for(let lane=0;lane<colorStride;lane++){
          const base=localTint.rgb[ia*colorStride+lane];
          colors[i*colorStride+lane]=(base+u*(localTint.rgb[ib*colorStride+lane]-base)+v*(localTint.rgb[ic*colorStride+lane]-base))/255;
        }
        for(let lane=0;lane<7;lane++){
          const base=vertices[a+2+lane];
          attributes[i*7+lane]=base+u*(vertices[b+2+lane]-base)+v*(vertices[c+2+lane]-base);
        }
      }
    }
  }
  return {attributes,covered,auxiliaryWeights,colors,colorStride,frameFaces,frameBary,maskAlpha,maskUV};
}

type MixedFrames=NonNullable<NonNullable<ComposedTerrainSource["localNormals"]>["frames"]>;
function directionAt(values:Int16Array,stride:number,a:number,b:number,c:number,u:number,v:number,out:number[]){
  for(let i=0;i<stride;i++)
    out[i]=values[a+i]+u*(values[b+i]-values[a+i])+v*(values[c+i]-values[a+i]);
}

function mixedFrameAt(frames:MixedFrames,triangles:Uint32Array,at:number,u:number,v:number,
  normal:number[],primary:number[],secondary:number[],rotation:number[]){
  const a=triangles[at],b=triangles[at+1],c=triangles[at+2];
  directionAt(frames.normals,3,a*3,b*3,c*3,u,v,normal);
  directionAt(frames.primary,4,a*4,b*4,c*4,u,v,primary);
  directionAt(frames.secondary,4,a*4,b*4,c*4,u,v,secondary);
  const nx=normal[0],ny=normal[1],nz=normal[2],length=Math.sqrt(nx*nx+ny*ny+nz*nz);
  if(length<.001||!primary[3]||!secondary[3])return false;
  const x=nx/length,y=ny/length,z=nz/length;
  const pd=primary[0]*x+primary[1]*y+primary[2]*z;
  const sd=secondary[0]*x+secondary[1]*y+secondary[2]*z;
  const p=primary[0]-pd*x,q=primary[1]-pd*y,r=primary[2]-pd*z;
  const s=secondary[0]-sd*x,t=secondary[1]-sd*y,w=secondary[2]-sd*z;
  const primarySq=p*p+q*q+r*r,secondarySq=s*s+t*t+w*w;
  if(primarySq<.000001||secondarySq<.000001)return false;
  const scale=1/Math.sqrt(primarySq*secondarySq);
  rotation[0]=(p*s+q*t+r*w)*scale;
  rotation[1]=Math.sign(primary[3])*((q*z-r*y)*s+(r*x-p*z)*t+(p*y-q*x)*w)*scale;
  rotation[2]=Math.sign(primary[3])*Math.sign(secondary[3]);
  return true;
}

const unit=(x:number)=>Math.min(1,Math.max(0,x));
function point(image:Image,u:number,v:number){
  const x=Math.min(image.width-1,Math.max(0,Math.floor(u*image.width)));
  const y=Math.min(image.height-1,Math.max(0,Math.floor(v*image.height)));
  return (y*image.width+x)*4;
}
function corners(index:Image,weights:Image,u:number,v:number,ids:number[],result:number[]){
  const d=1/4096;
  const ax=point(index,u-d,v-d),bx=point(index,u+d,v-d),cx=point(index,u-d,v+d),dx=point(index,u+d,v+d);
  const aw=point(weights,u-d,v-d),bw=point(weights,u+d,v-d),cw=point(weights,u-d,v+d),dw=point(weights,u+d,v+d);
  const x=u*2048-.5-Math.floor(u*2048-.5),y=v*2048-.5-Math.floor(v*2048-.5);
  const bytes=weights.rgba,keys=index.rgba;
  const weight=(at:number,i:number)=>i<3?bytes[at+i]/255:unit(1-(bytes[at]+bytes[at+1]+bytes[at+2])/255);
  for(let i=0;i<4;i++){
    ids[i]=keys[ax+i];
    const a=weight(aw,i),c=weight(cw,i);
    const top=keys[ax+i]===keys[bx+i]?a+x*(weight(bw,i)-a):a;
    const bottom=keys[cx+i]===keys[dx+i]?c+x*(weight(dw,i)-c):c;
    result[i]=keys[ax+i]===keys[cx+i]?top+y*(bottom-top):top;
  }
}

function samplePacked({width,height,rgba}:Image,u:number,v:number,channel=2){
  const x=u*width-.5,y=v*height-.5,ix=Math.floor(x),iy=Math.floor(y);
  const x0=(ix%width+width)%width,y0=(iy%height+height)%height;
  const x1=(x0+1)%width,y1=(y0+1)%height;
  const a=rgba[(y0*width+x0)*4+channel]/255,b=rgba[(y1*width+x0)*4+channel]/255;
  const top=a+(rgba[(y0*width+x1)*4+channel]/255-a)*(x-ix);
  const bottom=b+(rgba[(y1*width+x1)*4+channel]/255-b)*(x-ix);
  return top+(bottom-top)*(y-iy);
}

function addColor({width,height,rgba}:Image,u:number,v:number,weight:number,result:number[],transfer=linear){
  const x=u*width-.5,y=v*height-.5,ix=Math.floor(x),iy=Math.floor(y);
  const x0=(ix%width+width)%width,y0=(iy%height+height)%height;
  const x1=(x0+1)%width,y1=(y0+1)%height;
  const ax=(y0*width+x0)*4,bx=(y0*width+x1)*4,cx=(y1*width+x0)*4,dx=(y1*width+x1)*4;
  for(let c=0;c<3;c++){
    const a=transfer[rgba[ax+c]],b=transfer[rgba[cx+c]];
    const top=a+(transfer[rgba[bx+c]]-a)*(x-ix),bottom=b+(transfer[rgba[dx+c]]-b)*(x-ix);
    result[c]+=weight*(top+(bottom-top)*(y-iy));
  }
}

function mixLocalMask(image:Image,attributes:Float32Array,covered:Uint8Array,alpha:Float32Array,uv?:Float32Array){
  const residual=new Float32Array(covered.length),sample=[0,0,0];
  for(let p=0;p<covered.length;p++){
    if(!covered[p])continue;
    const at=p*7,r=attributes[at+4],g=attributes[at+5],b=attributes[at+6],a=alpha[p];
    const vertexResidual=unit(1-r-g-b);
    if(a===1){
      residual[p]=vertexResidual;
      continue;
    }
    sample.fill(0);
    addColor(image,uv?.[p*2]??attributes[at],uv?.[p*2+1]??attributes[at+1],1,sample,unorm);
    const maskResidual=unit(1-sample[0]-sample[1]-sample[2]);
    for(let i=0;i<3;i++)attributes[at+4+i]=sample[i]+a*(attributes[at+4+i]-sample[i]);
    // The shader clamps the two residuals independently before interpolation.
    residual[p]=maskResidual+a*(vertexResidual-maskResidual);
  }
  return residual;
}

const luminance=(rgb:number[])=>.2125*rgb[0]+.7154*rgb[1]+.0721*rgb[2];
function mixTint(rgb:number[],tint:number[],gain:number,amount:number){
  const light=luminance(rgb)*gain;
  for(let c=0;c<3;c++)rgb[c]+=amount*(tint[c]*light-rgb[c]);
}
function sharpen(values:number[],powers:number[],auxiliary?:number){
  const peak=Math.max(values[0],values[1],values[2],values[3],auxiliary??0,.00001);
  // Local terrain has a fifth powered lane, even when its authored weight is zero.
  const powered=auxiliary===undefined?0:(auxiliary/peak)**10-.001;
  let total=powered;
  for(let i=0;i<4;i++){
    values[i]=(values[i]/peak)**powers[i]-.001;
    total+=values[i];
  }
  total=Math.max(total,.00001);
  for(let i=0;i<4;i++)values[i]=unit(values[i]/total);
  return unit(powered/total);
}
function display(c:number){
  return 255*unit(c<=.0031308?c*12.92:1.055*c**(1/2.4)-.055);
}
const exponent=(strength:number)=>20-19*unit((strength-.2)*1.754386);

function extendEdges(rgba:Uint8ClampedArray,covered:Uint8Array,detailNormal?:Uint8Array){
  // Supply neighboring colors outside the triangles so mip filtering cannot sample black.
  const queue=new Uint32Array(covered.length);
  let tail=0;
  for(let p=0;p<covered.length;p++)if(covered[p])queue[tail++]=p;
  const visit=(p:number,next:number)=>{
    if(covered[next])return;
    rgba.copyWithin(next*4,p*4,p*4+4);
    detailNormal?.copyWithin(next*2,p*2,p*2+2);
    covered[next]=1;
    queue[tail++]=next;
  };
  for(let head=0;head<tail;head++){
    const p=queue[head],x=p%side;
    if(x>0)visit(p,p-1);
    if(x<side-1)visit(p,p+1);
    if(p>=side)visit(p,p-side);
    if(p+side<covered.length)visit(p,p+side);
  }
}

type SectorInputs=NonNullable<Awaited<ReturnType<typeof loadSectorInputs>>>;

type SectorMips={base:Image;next?:Image;blend:number};

function sectorMips(image:StreetTextureImage,du:number,dv:number):SectorMips{
  const mips=image.authoredMips;
  if(!mips?.length||!du&&!dv)return {base:image,blend:0};
  const level=Math.min(mips.length,Math.max(0,Math.log2(Math.max(image.width*du,image.height*dv))));
  const first=Math.floor(level);
  return {base:first?mips[first-1]:image,next:mips[first],blend:level-first};
}

function sampleSectorChannel(mips:SectorMips,u:number,v:number,channel:number){
  const sample=samplePacked(mips.base,u,v,channel);
  return mips.next&&mips.blend>0?sample+(samplePacked(mips.next,u,v,channel)-sample)*mips.blend:sample;
}

function addSectorColor(mips:SectorMips,u:number,v:number,weight:number,out:number[]){
  addColor(mips.base,u,v,weight*(1-mips.blend),out);
  if(mips.next&&mips.blend>0)addColor(mips.next,u,v,weight*mips.blend,out);
}

async function readSectorLayers(inputs:SectorInputs,needed:Set<number>,footprint?:readonly [number,number]){
  const {sector}=inputs;
  const read=(role:string,key:string)=>inputs.input(terrainTexturePrefix+role+":"+key);
  const material=new Map<number,{color:SectorMips;height:SectorMips;normal?:SectorMips}>();
  for(const id of needed){
    const row=sector.rows[id];
    if(!row||(row.selector!==1&&row.selector!==2)||![row.sx,row.sy,row.ox,row.oy,row.gain,row.bias,row.strength].every(Number.isFinite))continue;
    const [color,height,normal]=await Promise.all([
      read("color",row.color),read("height",row.height),
      footprint&&row.normalGain>0?read("normal",row.normal):null,
    ]);
    if(!color||!height||footprint&&row.normalGain!==0&&!normal)continue;
    const du=Math.abs(row.sx)*(footprint?.[0]??0),dv=Math.abs(row.sy)*(footprint?.[1]??0);
    material.set(id,{color:sectorMips(color,du,dv),height:sectorMips(height,du,dv),
      normal:normal?sectorMips(normal,du,dv):undefined});
  }
  const hasTint=[...material.keys()].some(id=>sector.rows[id].tint);
  const [tintMap,correctionMap]=hasTint?await Promise.all([
    read("tint",sector.tint),read("tint-correction",sector.correction),
  ]):[];
  return {material,tintMap,correctionMap,hasTint,authoredPage:Boolean(footprint)};
}

function sectorPageScratch(ids=[0,0,0,0],weights=[0,0,0,0]){
  return {ids,weights,powers:[0,0,0,0],native:[0,0,0],tint:[0,0,0],correction:[0,0,0],rowColor:[0,0,0],normal:[0,0]};
}

function sampleSectorPage(sector:SectorInputs["sector"],layers:Awaited<ReturnType<typeof readSectorLayers>>,
  u:number,v:number,needsHeight:boolean,scratch:ReturnType<typeof sectorPageScratch>){
  const {material,tintMap,correctionMap}=layers;
  const {ids,weights,powers,native,tint,correction,rowColor,normal}=scratch;
  let surfaceGain=0,auxiliaryInputs=true;
  for(let i=0;i<4;i++){
    const row=sector.rows[ids[i]],item=material.get(ids[i]);
    powers[i]=row?exponent(row.strength):1;
    if(!weights[i])continue;
    if(needsHeight){
      if(row&&Number.isFinite(row.surfaceGain)&&Number.isFinite(row.pageAlphaGain))
        surfaceGain+=weights[i]*row.surfaceGain;
      else auxiliaryInputs=false;
    }
    if(!row||!item)continue;
    const h=sampleSectorChannel(item.height,u*row.sx+row.ox,v*row.sy+row.oy,2);
    weights[i]=unit(weights[i]*Math.max(.01,(h-row.bias)*row.gain));
  }
  sharpen(weights,powers);
  if((!needsHeight||auxiliaryInputs)&&ids.every((id,i)=>weights[i]<=.001||material.has(id))){
    native.fill(0);normal.fill(0);
    let sampledTint=false,pageAlpha=0;
    for(let i=0;i<4;i++){
      const row=sector.rows[ids[i]],item=material.get(ids[i]);
      if(!item||weights[i]<=0)continue;
      const rowU=u*row.sx+row.ox,rowV=v*row.sy+row.oy;
      const useTint=row.tint&&tintMap&&correctionMap;
      const alpha=needsHeight||useTint?sampleSectorChannel(item.height,rowU,rowV,3):0;
      if(needsHeight)pageAlpha+=weights[i]*alpha*row.pageAlphaGain;
      if(layers.authoredPage)for(let c=0;c<2;c++){
        const channel=item.normal?sampleSectorChannel(item.normal,rowU,rowV,c):.5;
        normal[c]+=weights[i]*(.5+(channel-.5)*row.normalGain);
      }
      if(!row.tint||!tintMap||!correctionMap){
        addSectorColor(item.color,rowU,rowV,weights[i],native);
        continue;
      }
      if(!sampledTint){
        tint.fill(0);correction.fill(0);
        addColor(tintMap,u*(508/512)+2/512,v*(508/512)+2/512,1,tint,layers.authoredPage?linear:unorm);
        // Both page inputs have sRGB views. The writer also applies a
        // transfer to correction after the texture sample.
        addColor(correctionMap,u*(504/512)+4/512,v*(504/512)+4/512,1,correction,layers.authoredPage?linear:unorm);
        for(let c=0;c<3;c++)correction[c]=toLinear(correction[c]);
        sampledTint=true;
      }
      const {tintAmount,tintGain,correctionAmount,correctionGain}=row.tint;
      rowColor.fill(0);
      addSectorColor(item.color,rowU,rowV,1,rowColor);
      mixTint(rowColor,correction,correctionGain,correctionAmount*(tintAmount>0?1-alpha:alpha));
      mixTint(rowColor,tint,tintGain,tintAmount*alpha);
      for(let c=0;c<3;c++)native[c]+=weights[i]*rowColor[c];
    }
    return {pageAlpha,surfaceGain};
  }
}

async function bakeSectorTerrainPage(source:TerrainPageSource,inputs:SectorInputs):Promise<StreetTextureImage|null>{
  const {sector,index,weightMap}=inputs;
  const [left,bottom,right,top]=source.bounds;
  const [x,y]=source.control.sector.origin;
  const needed=new Set<number>(),scratch=sectorPageScratch();
  const {ids,weights,native,normal}=scratch;
  // Preserve close detail in the sector crop independently of its aspect ratio.
  const samplesPerMetre=64;
  const width=Math.ceil((right-left)*samplesPerMetre);
  const height=Math.ceil((top-bottom)*samplesPerMetre);
  const u=Float64Array.from({length:width},(_,column)=>(left+((column+.5)/width)*(right-left)-x)/512);
  const v=Float64Array.from({length:height},(_,row)=>1-(bottom+((row+.5)/height)*(top-bottom)-y)/512);
  for(const north of v)for(const east of u){
    corners(index,weightMap,east,north,ids,weights);
    for(let i=0;i<4;i++)if(weights[i]>0)needed.add(ids[i]);
  }
  const layers=await readSectorLayers(inputs,needed,[(right-left)/(width*512),(top-bottom)/(height*512)]);
  if(layers.material.size!==needed.size||layers.hasTint&&(!layers.tintMap||!layers.correctionMap))return null;
  const rgba=new Uint8ClampedArray(width*height*4),detailNormal=new Uint8Array(width*height*2);
  for(let row=0,p=0;row<height;row++)for(let col=0;col<width;col++,p++){
    corners(index,weightMap,u[col],v[row],ids,weights);
    // With full auxiliary coverage, the positive height floor gives
    // the sector lane unit weight. Only the page RGB and XY are consumed.
    if(!sampleSectorPage(sector,layers,u[col],v[row],false,scratch))return null;
    for(let i=0;i<3;i++)rgba[p*4+i]=display(native[i]);
    rgba[p*4+3]=255;
    for(let i=0;i<2;i++)detailNormal[p*2+i]=Math.round(unit(normal[i])*255);
  }
  return {width,height,rgba,detailNormal};
}

export async function bakeDynamicTerrain(source:DynamicTerrainSource,input:Input,readSector:TerrainSectorReader,
  cache:DynamicTerrainSectorCache):Promise<StreetTextureImage|null>{
  // Derive the sector from the material ID so cached meshes use the same lookup.
  const name=source.control.id.slice(dynamicTerrainPrefix.length,dynamicTerrainPrefix.length+7);
  const inputs=await cache.read(name,input,readSector);
  if(!inputs)return null;
  if(source.sectorOnly)return bakeSectorTerrainPage(source,inputs);
  const {control}=source;
  const {sector,index,weightMap}=inputs;
  const read=(role:string,key:string)=>inputs.input(terrainTexturePrefix+role+":"+key);
  const localColors:Image[]=[],localHeights:Image[]=[];
  for(let i=0;i<4;i++){
    const color=await read("color",source.colors[i]),height=await read("height",source.heights[i]);
    if(!color||!height)return null;
    localColors.push(color);
    localHeights.push(height);
  }
  const localSector=source.localTint?.sector;
  const localTintImage=localSector?await read("tint",localSector.key):undefined;
  if(localSector&&!localTintImage)return null;
  const localMaskImage=source.localMask
    ?source.localMask.key===sector.weights?weightMap:await read("weights",source.localMask.key)
    :undefined;
  if(source.localMask&&!localMaskImage)return null;
  const normalStrength=source.localNormals?.strength;
  const normalMaps=source.localNormals&&normalStrength?await Promise.all(source.localNormals.keys.map((key,i)=>
    key&&normalStrength[i]>0?read("normal",key).catch(()=>null):null)):[];
  const frames=source.localNormals?.frames;
  const {attributes,covered,auxiliaryWeights,colors,colorStride,frameFaces,frameBary,maskAlpha,maskUV}=
    raster(source,Boolean(frames&&normalMaps.some((map,i)=>map&&(control.primaryMask&(1<<i))===0)));
  if(!covered.some(Boolean))return null;
  const maskResidual=localMaskImage&&maskAlpha?mixLocalMask(localMaskImage,attributes,covered,maskAlpha,maskUV):undefined;
  const [left,bottom,right,top]=source.bounds;
  const [x,y]=control.sector.origin;
  const sectorU=Float64Array.from({length:side},(_,column)=>(left+((column+.5)/side)*(right-left)-x)/512);
  const sectorV=Float64Array.from({length:side},(_,row)=>1-(bottom+((row+.5)/side)*(top-bottom)-y)/512);
  const selected=(i:number)=>(control.layerMask>>>i)&1;
  const [red,green,blue,residual]=[0,1,2,3].map(selected);
  const authoredWeight=(at:number,p:number)=>{
    const r=attributes[at+4],g=attributes[at+5],b=attributes[at+6];
    return red*r+green*g+blue*b+residual*(maskResidual?.[p]??unit(1-r-g-b));
  };
  const sectorWeight=(local:number[])=>red*local[0]+green*local[1]+blue*local[2]+residual*local[3];
  const ids=[0,0,0,0],weights=[0,0,0,0],needed=new Set<number>();
  for(let p=0;p<covered.length;p++){
    if(!covered[p]||!(authoredWeight(p*7,p)>.01||(auxiliaryWeights?.[p]??0)>0))continue;
    corners(index,weightMap,sectorU[p%side],sectorV[Math.floor(p/side)],ids,weights);
    for(let i=0;i<4;i++)if(weights[i]>0)needed.add(ids[i]);
  }
  const layers=await readSectorLayers(inputs,needed);
  const {material}=layers;
  const rgba=new Uint8ClampedArray(side*side*4),localPowers=source.strength.map(exponent);
  const scratch=sectorPageScratch(ids,weights);
  const {native,rowColor}=scratch;
  const local=[0,0,0,0],base=[0,0,0],vertexTint=[0,0,0];
  const localTintSample=[0,0,0],tintScale=source.localTint?.scale;
  const detailNormal=normalMaps.some(Boolean)?new Uint8Array(side*side*2):undefined;
  const rowNormal=[0,0,0],normalFrame=[0,0,0],primaryFrame=[0,0,0,0],secondaryFrame=[0,0,0,0],rotation=[0,0,0];
  for(let p=0;p<covered.length;p++){
    if(!covered[p])continue;
    const at=p*7,up=attributes[at]*128,vp=attributes[at+1]*128,us=attributes[at+2],vs=attributes[at+3];
    const r=attributes[at+4],g=attributes[at+5],b=attributes[at+6];
    local[0]=r;local[1]=g;local[2]=b;local[3]=maskResidual?.[p]??unit(1-r-g-b);
    for(let i=0;i<4;i++){
      const primary=(control.primaryMask&(1<<i))!==0;
      const h=samplePacked(localHeights[i],primary?up:us,primary?vp:vs);
      local[i]=unit(local[i]*Math.max(.01,(h-source.bias[i])*source.gain[i]));
    }
    const auxiliary=auxiliaryWeights?.[p]??0;
    let auxiliaryWeight=0,sectorReady=false;
    if(!auxiliary)sharpen(local,localPowers,0);
    if(material.size&&(auxiliary>0||(authoredWeight(at,p)>.01&&sectorWeight(local)>0))){
      const u=sectorU[p%side],v=sectorV[Math.floor(p/side)];
      corners(index,weightMap,u,v,ids,weights);
      const page=sampleSectorPage(sector,layers,u,v,auxiliary>0,scratch);
      if(page){
        const {pageAlpha,surfaceGain}=page;
        sectorReady=true;
        if(auxiliary){
          // In the top projection the page writer's normal/alpha target
          // supplies the B channel for the deferred auxiliary height.
          const midpoint=126/255;
          const height=Math.max(.01,unit(midpoint+(pageAlpha-midpoint)*surfaceGain));
          const localFade=unit(1-5*(auxiliary-.8));
          for(let i=0;i<4;i++)local[i]*=localFade;
          auxiliaryWeight=sharpen(local,localPowers,auxiliary*height);
        }
      }
    }
    if(auxiliary&&!sectorReady)sharpen(local,localPowers,0);
    base.fill(0);
    let nx=0,ny=0,nz=0;
    if(colors&&tintScale)
      for(let c=0;c<3;c++)vertexTint[c]=toLinear(colors[p*colorStride+c]);
    let sampledLocalTint=false;
    let mixedFrameValid:boolean|undefined;
    for(let i=0;i<4;i++){
      if(local[i]<=0||sectorReady&&selected(i))continue;
      const primary=(control.primaryMask&(1<<i))!==0;
      const u=primary?up:us,v=primary?vp:vs;
      if(detailNormal&&normalStrength){
        const map=normalMaps[i];
        if(map){
          rowNormal.fill(0);
          addColor(map,u,v,1,rowNormal,unorm);
          const x=(2*rowNormal[0]-1)*normalStrength[i],y=(2*rowNormal[1]-1)*normalStrength[i];
          const z=Math.sqrt(Math.max(.0001,1-x*x-y*y));
          const weight=local[i]/Math.sqrt(x*x+y*y+z*z);
          if(frames&&!primary&&frameFaces&&frameBary){
            mixedFrameValid??=mixedFrameAt(frames,source.triangles,frameFaces[p],frameBary[p*2],frameBary[p*2+1],
              normalFrame,primaryFrame,secondaryFrame,rotation);
            if(mixedFrameValid){
              const [cos,sin,handedness]=rotation;
              nx+=(cos*x-sin*y*handedness)*weight;
              ny+=(sin*x+cos*y*handedness)*weight;
              nz+=z*weight;
            }else nz+=local[i];
          }else{
            nx+=x*weight;ny+=y*weight;nz+=z*weight;
          }
        }else nz+=local[i];
      }
      if(colors&&tintScale&&(i<3||localSector)){
        rowColor.fill(0);
        addColor(localColors[i],u,v,1,rowColor);
        const alpha=samplePacked(localHeights[i],u,v,3);
        const sectorAmount=localSector?.amount[i]??0;
        const vertexAmount=localSector?.vertexAmount[i]??1;
        mixTint(rowColor,vertexTint,tintScale[i],vertexAmount*(sectorAmount>0?1-alpha:alpha));
        if(localSector&&localTintImage&&sectorAmount>0){
          if(!sampledLocalTint){
            localTintSample.fill(0);
            const edge=0.5/512;
            const u=Math.max(edge,Math.min(1-edge,attributes[at]*(508/512)+2/512));
            const v=Math.max(edge,Math.min(1-edge,attributes[at+1]*(508/512)+2/512));
            addColor(localTintImage,u,v,1,localTintSample);
            sampledLocalTint=true;
          }
          mixTint(rowColor,localTintSample,localSector.scale[i],sectorAmount*alpha*(1-colors[p*colorStride+3]));
        }
        for(let c=0;c<3;c++)base[c]+=local[i]*rowColor[c];
      }else addColor(localColors[i],u,v,local[i],base);
    }
    if(sectorReady){
      const amount=unit(sectorWeight(local)+auxiliaryWeight);
      nz+=amount;
      for(let c=0;c<3;c++)base[c]+=amount*native[c];
    }
    for(let c=0;c<3;c++)rgba[p*4+c]=display(base[c]);
    rgba[p*4+3]=255;
    if(detailNormal){
      // Preserve the authored mesh normal for missing maps and sector weight.
      const scale=127/Math.max(Math.sqrt(nx*nx+ny*ny+nz*nz),.00001);
      detailNormal[p*2]=Math.round(128+nx*scale);
      detailNormal[p*2+1]=Math.round(128+ny*scale);
    }
  }
  extendEdges(rgba,covered,detailNormal);
  return {width:side,height:side,rgba,detailNormal};
}

import type { Archive } from "./archive";
import { CELL, type Rect, type Sector } from "./recover";
import { loadStreetAsset, type StreetAsset } from "./street-mesh";
import type { Image } from "./texture";

type Point=[number,number];
const sectorSize=4*CELL;
const minArea=64, padding=6;

function hull(points:Point[]){
  const ordered=points.sort(([x,y],[u,v])=>x-u||y-v);
  function half(source:Point[]){
    const result:Point[]=[];
    for(const p of source){
      while(result.length>=2){
        const a=result[result.length-2],b=result[result.length-1];
        if((b[0]-a[0])*(p[1]-a[1])>(b[1]-a[1])*(p[0]-a[0]))break;
        result.pop();
      }
      result.push(p);
    }
    return result.slice(0,-1);
  }
  return [...half(ordered),...half(ordered.reverse())];
}

function outline(ctx:OffscreenCanvasRenderingContext2D,polygon:Point[],x:number,y:number){
  ctx.beginPath();
  ctx.moveTo(polygon[0][0]-x,polygon[0][1]-y);
  for(let i=1;i<polygon.length;i++)ctx.lineTo(polygon[i][0]-x,polygon[i][1]-y);
  ctx.closePath();
}

function colors(pixels:Uint8ClampedArray,mask:Uint8ClampedArray){
  const histogram=new Map<number,number>();
  for(let i=0;i<pixels.length;i+=4){
    if(mask[i+3]<128||pixels[i+3]<128)continue;
    const key=((pixels[i]>>4)<<8)|((pixels[i+1]>>4)<<4)|(pixels[i+2]>>4);
    histogram.set(key,(histogram.get(key)??0)+1);
  }
  const result:number[][]=[];
  for(const [key] of [...histogram].sort((a,b)=>b[1]-a[1])){
    const color=[((key>>8)&15)*16+8,((key>>4)&15)*16+8,(key&15)*16+8];
    if(result.some(other=>color.every((value,i)=>Math.abs(value-other[i])<28)))continue;
    result.push(color);
    if(result.length===4)break;
  }
  return result;
}

function overlap(pixels:Uint8ClampedArray,mask:Uint8ClampedArray,width:number,height:number,area:number,color:number[]){
  const count=width*height,remaining=new Uint8Array(count),queue=new Uint32Array(count);
  const [r,g,b]=color;
  for(let i=0;i<count;i++){
    const j=i*4;
    if(pixels[j+3]>=128&&Math.max(Math.abs(pixels[j]-r),Math.abs(pixels[j+1]-g),Math.abs(pixels[j+2]-b))<=36)
      remaining[i]=1;
  }
  let best=0,end=0;
  const push=(index:number)=>{
    if(remaining[index]){remaining[index]=0;queue[end++]=index;}
  };
  for(let seed=0;seed<count;seed++){
    if(!remaining[seed])continue;
    let hits=0;
    end=0;push(seed);
    for(let start=0;start<end;start++){
      const i=queue[start],x=i%width;
      if(mask[i*4+3]>=128)hits++;
      if(x>0)push(i-1);
      if(x<width-1)push(i+1);
      push(i-width);push(i+width);
    }
    best=Math.max(best,hits/(area+end-hits));
  }
  return best;
}

export async function roofImagery(archive:Archive,asset:StreetAsset,sectors:Sector[],load:(id:string)=>Promise<Image|null>){
  const mesh=await loadStreetAsset(archive,asset,true);
  const [wx,wy]=mesh.origin;
  const candidates=mesh.appearance?.spans.flatMap(span=>{
    if(span.overlay||span.count<3)return [];
    const points:Point[]=[],seen=new Set<number>();
    for(let i=span.first;i<span.first+span.count;i++){
      const index=mesh.indices[i];
      if(seen.has(index))continue;
      seen.add(index);
      points.push([wx+mesh.vertices[index*4],-wy-mesh.vertices[index*4+1]]);
    }
    const polygon=hull(points);
    if(polygon.length<3)return [];
    const xs=polygon.map(p=>p[0]),ys=polygon.map(p=>p[1]);
    const x=Math.floor(Math.min(...xs))-padding,y=Math.floor(Math.min(...ys))-padding;
    const width=Math.ceil(Math.max(...xs))+padding-x,height=Math.ceil(Math.max(...ys))+padding-y;
    if(width>sectorSize||height>sectorSize||(width-2*padding)*(height-2*padding)<minArea)return [];
    return [{polygon,x,y,width,height}];
  })??[];
  let best:{canvas:OffscreenCanvas;rect:Rect;score:number}|undefined;
  for(const {polygon,x,y,width,height} of candidates){
    const sources=sectors.filter(sector=>{
      const sx=sector.x*CELL,sy=sector.y*CELL;
      return sx<x+width&&sx+sectorSize>x&&sy<y+height&&sy+sectorSize>y;
    });
    if(!sources.length)continue;
    const source=new OffscreenCanvas(width,height),ctx=source.getContext("2d",{willReadFrequently:true})!;
    for(const sector of sources){
      const image=await load(sector.id);
      if(image?.width===sectorSize&&image.height===sectorSize)
        ctx.putImageData(new ImageData(image.rgba,image.width,image.height),sector.x*CELL-x,sector.y*CELL-y);
    }
    const canvas=new OffscreenCanvas(width,height),out=canvas.getContext("2d",{willReadFrequently:true})!;
    outline(out,polygon,x,y);out.fill();
    const mask=out.getImageData(0,0,width,height).data;
    let area=0;
    for(let i=3;i<mask.length;i+=4)if(mask[i]>=128)area++;
    if(area<minArea)continue;
    const image=ctx.getImageData(0,0,width,height).data;
    const candidates=colors(image,mask);
    const score=candidates.reduce((best,color)=>Math.max(best,overlap(image,mask,width,height,area,color)),0);
    if(score<.60||best&&score<=best.score)continue;
    out.globalCompositeOperation="source-in";
    out.drawImage(source,0,0);
    best={canvas,rect:[x/CELL,y/CELL,width/CELL,height/CELL],score};
  }
  if(!best)return null;
  const {canvas,...placement}=best;
  return {...placement,image:await createImageBitmap(canvas)};
}

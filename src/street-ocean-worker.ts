import {Archive} from "./archive";
import {drawableNameKey} from "./street-drawable-identity";
import {findTextureDescriptor} from "./layers";
import {readRpf9PackedMember} from "./rpf9-boot";
import {openRpf9Preparer} from "./rpf9-prepare";
import {openStreetWaterResources} from "./street-water-resource";

const N=256,count=N*N;
const half= (globalThis as typeof globalThis&{Float16Array?:new (source:Float32Array)=>{buffer:ArrayBuffer}}).Float16Array;

export type StreetOceanSource={exe:File;common:File;textures:File};
export type StreetOceanRequest={source:StreetOceanSource}|{beaufort:number;ticks:number};
export type StreetOceanReply={ready:true}|{error:true}|{
  lengths:[number,number,number];beaufort:number;ticks:number;
  pixels:Float32Array<ArrayBuffer>|Uint16Array<ArrayBuffer>;
};

function assert(value:unknown):asserts value{
  if(!value)throw new Error("Invalid ocean spectrum source");
}
const reversed=Uint16Array.from({length:N},(_,i)=>{
  let value=0;
  for(let bit=1;bit<N;bit*=2){value=(value<<1)|(i&1);i>>=1;}
  return value;
});
const butterflies=Array.from({length:Math.log2(N)},(_,level)=>{
  const span=2<<level,half=span/2;
  return {span,half,cos:Float64Array.from({length:half},(_,lane)=>Math.cos(2*Math.PI*lane/span)),
    sin:Float64Array.from({length:half},(_,lane)=>Math.sin(2*Math.PI*lane/span))};
});
function inverseFFT(real:Float64Array,imag:Float64Array){
  for(let i=1;i<N;i++){
    const j=reversed[i];
    if(i>=j)continue;
    const r=real[j],im=imag[j];
    real[j]=real[i];imag[j]=imag[i];
    real[i]=r;imag[i]=im;
  }
  for(const {span,half,cos,sin} of butterflies)for(let lane=0;lane<half;lane++){
    const c=cos[lane],s=sin[lane];
    for(let a=lane;a<N;a+=span){
      const b=a+half,tr=real[b]*c-imag[b]*s,ti=real[b]*s+imag[b]*c;
      real[b]=real[a]-tr;imag[b]=imag[a]-ti;
      real[a]+=tr;imag[a]+=ti;
    }
  }
}
function seededMask(x:number,y:number){
  const mul=(a:number,b:number,c:number)=>(Math.imul(a&0xffffff, b&0xffffff)+c)>>>0;
  const m=0xc083c5,seed=0x3c6ef35f;
  let a=mul(m,x,seed), b=mul(m,y,seed);
  a=mul(m,b,a);
  b=mul(m,a,b);
  a=(a^(a>>>12))>>>0;
  b=(b^(b>>>12))>>>0;
  a=mul(m,b,a);
  return ((a&0xffffff)^(a>>>12))>=0xc00000;
}

async function openSpectrum({exe:executable,common:inputCommon,textures:inputTextures}:StreetOceanSource){
  const exe=new Archive(executable.name,executable),common=new Archive(inputCommon.name,inputCommon),
   textures=new Archive(inputTextures.name,inputTextures);
  const prepare=await openRpf9Preparer(exe);
  const [directory,water]=await Promise.all([
    prepare(common,0,common.file.size),openStreetWaterResources(textures,prepare).read("water"),
  ]);
  if(!water)throw Error("No authored water dictionary");
  const hashes=Array.from({length:6},(_,band)=>{
    const path="data/water/oceanwavesimparams"+band+".meta";
    return {path,key:BigInt("0x"+drawableNameKey(path))};
  });
  const slots=new Map<bigint,number>();
  for(let i=0;i<directory.layout.entryCount;i++){
    const member=directory.member(i);
    if(member?.nameKey!==undefined&&hashes.some(({key})=>member.nameKey===key))slots.set(member.nameKey,i);
  }
  const banks=await Promise.all(hashes.map(async ({path,key})=>{
    const slot=slots.get(key);
    if(slot===undefined)throw Error("Missing ocean parameter bank "+path);
    const member=directory.member(slot)!;
    assert(member.type===0xff&&member.logicalBytes<=7000);
    const bytes=await readRpf9PackedMember(common,directory,slot,prepare.processMember);
    const xml=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
    const rows=[...xml.matchAll(/<Item>([\s\S]*?)<\/Item>/g)].map(([,row])=>
      Object.fromEntries([...row.matchAll(/<([A-Za-z0-9_]+) value="([^"]+)"\s*\/>/g)].map(([,field,val])=>{
        const value=Number(val);
        assert(Number.isFinite(value));
        return [field,value];
      })));
    assert(rows.length===13);
    return rows;
  }));
  // The matching executable uses this section mapping for the traced constants.
  const readFloat=async(rva:number)=>{
    const b=await exe.read(rva-0x1200,4);
    return new DataView(b.buffer,b.byteOffset,b.byteLength).getFloat32(0,true);
  };
  const rvas={
    initialBeaufort:0x6159bd4, initialFetchInput:0x6159c58, tau:0x5fc6f84, minWind:0x6159ec4,
    gravityTimesFetchGain:0x6168ea8, peakConstant:0x6168eac, peakExponent:0x615d960,
    alphaExponent:0x6168eb0, alphaConstant:0x6168eb4, directionality0:0x6168c50, directionality1:0x6168c54,
  };
  const compiled=Object.fromEntries(await Promise.all(Object.entries(rvas).map(async ([key,rva])=>[key,await readFloat(rva)]))) as Record<keyof typeof rvas,number>;
  assert(compiled.initialBeaufort===2);
  assert(compiled.initialFetchInput===100);
  const f32=(n:number)=>Math.fround(n);
  const asFloat=(bits:number)=>{
    const raw=new DataView(new ArrayBuffer(4));
    raw.setUint32(0,bits,true);
    return raw.getFloat32(0,true);
  };
  const swizzle32=["x0","x1","y0","y1","y2","x2","y3","x3","y4","x4"];
  function tiledOffset(x:number,y:number,width:number){
    const page=(y>>5)*(width>>5)+(x>>5);
    const element=swizzle32.reduce((sum,axis,bit)=>
      sum+((((axis[0]==="x"?x:y)>>Number(axis[1]))&1)<<bit),0);
    return (page*1024+element)*4;
  }
  const noiseDesc=findTextureDescriptor(water.metadata,"ocean_sim_gaussian_noise");
  assert(noiseDesc.format===41&&noiseDesc.width===N&&noiseDesc.height===N&&noiseDesc.layout===5&&noiseDesc.elements===count);
  const noiseTiled=water.graphics.subarray(noiseDesc.start,noiseDesc.start+count*4);
  assert(noiseTiled.length===count*4);
  const noiseView=new DataView(noiseTiled.buffer,noiseTiled.byteOffset,noiseTiled.byteLength);
  const noiseLinear=new Float32Array(count);
  for(let y=0;y<N;y++)for(let x=0;x<N;x++){
    const offset=tiledOffset(x,y,N);
    noiseLinear[y*N+x]=noiseView.getFloat32(offset,true);
  }
  assert(noiseLinear.every(Number.isFinite));

  return (beaufort:number)=>{
    const a=banks[0][Math.floor(beaufort)],b=banks[0][Math.ceil(beaufort)];
    const referenceRow={fWindSpeed:a.fWindSpeed+(b.fWindSpeed-a.fWindSpeed)*(beaufort%1),fWindHeading:a.fWindHeading};
    assert(a.fWindHeading===b.fWindHeading);
    const lengths:[number,number,number]=[banks[0],banks[1],banks[2]].map(bank=>bank[compiled.initialBeaufort].Lx) as [number,number,number];
    assert(lengths.every(length=>Number.isFinite(length)&&length>0));
    const steps=lengths.map(length=>f32(compiled.tau/length));
    const directionality=[compiled.directionality0,compiled.directionality1,compiled.directionality0];
    const gravity=asFloat(0x411cf5c3);
    const conversion=asFloat(0x3a83126f);
    const wind=Math.max(compiled.minWind,referenceRow.fWindSpeed);
    const fetchTerm=Math.abs(f32(f32(1/wind)**2*f32(compiled.initialFetchInput*compiled.gravityTimesFetchGain)));
    const omegaPeak=f32(f32(compiled.peakConstant/wind)*f32(fetchTerm**compiled.peakExponent));
    const spectralAmplitude=f32(f32(fetchTerm**compiled.alphaExponent)*compiled.alphaConstant);
    assert(referenceRow.fWindHeading===0&&Number.isFinite(wind));
    const resonance=[asFloat(0x41649249),asFloat(0x4131c71c)];
    const peakSpread=asFloat(0xbf38aa3b),peakScale=asFloat(0x3fdc79c4);
    const longWaveScale=asFloat(0xbfe6d4ca),azimuthFloor=asFloat(0x3e22f983),azimuthGain=asFloat(0x3f22f983);

    const real=new Float64Array(count),imag=new Float64Array(count),colReal=new Float64Array(N),colImag=new Float64Array(N);
    const bands=lengths.map((_,band)=>{
      const step=steps[band],lower=band?Math.max(step,steps[band-1]*(band===1?asFloat(0x424fdf3b):64)):step;
      const upper=step*[asFloat(0x424fdf3b),64,128][band];
      const h0r=new Float64Array(count),h0i=new Float64Array(count);
      const frequencies=Float64Array.from({length:count},(_,i)=>Math.sqrt(gravity*Math.max(1e-6,step*Math.hypot(i%N-128,Math.floor(i/N)-128))));
      for(let y=0;y<N;y++)for(let x=0;x<N;x++){
        const kx=step*(x-128),ky=step*(y-128),k=Math.hypot(kx,ky);
        if(k<lower||k>upper||!seededMask(x,y))continue;
        const omega=Math.sqrt(gravity*k);
        const ratio=omega/Math.abs(omegaPeak),d=(ratio-1)*resonance[Number(ratio>=1)];
        const peakGain=2**(peakScale*2**(peakSpread*d*d));
        const longWaveCutoff=2**(longWaveScale*(omegaPeak/omega)**4);
        const dot=Math.max(0,Math.min(1,ky/k));
        const azimuth=azimuthFloor+directionality[band]*(azimuthGain*dot**2-azimuthFloor);
        const amp=step*Math.sqrt(spectralAmplitude**2*gravity/omega**6*longWaveCutoff*peakGain*azimuth/k);
        const i=y*N+x;
        h0r[i]=noiseLinear[i]*amp;
        h0i[i]=noiseLinear[x*N+y]*amp;
      }

      const gradientScale=f32(1/f32(compiled.tau/f32(N*step)));
      return (ticks:number,frame:Float32Array)=>{
        for(let y=0;y<N;y++)for(let x=0;x<N;x++){
          const mirror=(x===0||y===0)?-1:(N-y)*N+(N-x);
          const i=y*N+x;
          const mirrorRe=mirror<0?0:h0r[mirror],mirrorIm=mirror<0?0:h0i[mirror];
          const omega=frequencies[i];
          const angle=ticks*conversion*omega,c=Math.cos(angle),s=Math.sin(angle);
          real[i]=(h0r[i]+mirrorRe)*c-(h0i[i]+mirrorIm)*s;
          imag[i]=(h0r[i]-mirrorRe)*s+(h0i[i]-mirrorIm)*c;
        }
        for(let y=0;y<N;y++)inverseFFT(real.subarray(y*N,(y+1)*N),imag.subarray(y*N,(y+1)*N));
        for(let x=0;x<N;x++){
          for(let y=0;y<N;y++){
            colReal[y]=real[y*N+x];colImag[y]=imag[y*N+x];
          }
          inverseFFT(colReal,colImag);
          for(let y=0;y<N;y++)real[y*N+x]=((x+y)&1)?-colReal[y]:colReal[y];
        }
        for(let y=0;y<N;y++)for(let x=0;x<N;x++){
          const h=real[y*N+x],dy=.5*gradientScale*(real[((y+1)&255)*N+x]-real[((y-1)&255)*N+x]);
          const dx=.5*gradientScale*(real[y*N+((x+1)&255)]-real[y*N+((x-1)&255)]);
          const at=(band*count+y*N+x)*4;
          frame[at]=dx;frame[at+1]=dy;frame[at+2]=dy*dy;frame[at+3]=h;
        }

      };
    });

    return {lengths,frame(ticks:number){
      const output=new Float32Array(count*4*bands.length);
      for(const update of bands)update(ticks,output);
      return half?new Uint16Array(new half(output).buffer):output;
    }};
  };
}

const worker=self as DedicatedWorkerGlobalScope;
let source:Awaited<ReturnType<typeof openSpectrum>>|undefined;
let spectrum:ReturnType<NonNullable<typeof source>>|undefined;
let wind=-1;
worker.onmessage=async ({data}:MessageEvent<StreetOceanRequest>)=>{
  try{
    if("source" in data){
      source=await openSpectrum(data.source);
      spectrum=undefined;
      worker.postMessage({ready:true} satisfies StreetOceanReply);
      return;
    }
    if(!source)return;
    const {beaufort,ticks}=data;
    assert(Number.isFinite(beaufort)&&beaufort>=0&&beaufort<=12&&Number.isFinite(ticks)&&ticks>=0);
    if(!spectrum||beaufort!==wind){spectrum=source(beaufort);wind=beaufort;}
    const pixels=spectrum.frame(ticks);
    worker.postMessage({lengths:spectrum.lengths,beaufort,ticks,pixels} satisfies StreetOceanReply,[pixels.buffer]);
  }catch{
    worker.postMessage({error:true} satisfies StreetOceanReply);
  }
};

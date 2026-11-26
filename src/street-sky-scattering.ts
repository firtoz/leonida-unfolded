import type { StreetAtmosphere, StreetEnvironment } from "./street-environment";

export const streetSkyScatteringAltitudes=16;
const solarSamples=[-.12,-.06,0,.10,.25,.45,.65,.80,.95,1];
const altitudeStride=streetSkyScatteringAltitudes*3;
const elevationSamples=12,azimuthSamples=8,raySamples=24;
const directions=Array.from({length:elevationSamples*azimuthSamples},(_,i)=>{
  const z=2*(Math.floor(i/azimuthSamples)+.5)/elevationSamples-1;
  const azimuth=(i%azimuthSamples+.5)*2*Math.PI/azimuthSamples;
  return [Math.sqrt(1-z*z)*Math.cos(azimuth),z] as const;
});

function scatteringSlice(atmosphere:StreetAtmosphere,radius:number,sunZ:number,output:Float32Array,offset:number){
  const {height,rayleigh,mie,absorption}=atmosphere;
  const sunX=Math.sqrt(1-sunZ*sunZ),g=absorption[3];
  for(let k=0;k<streetSkyScatteringAltitudes;k++){
    const altitude=height*(k/(streetSkyScatteringAltitudes-1))**2;
    const origin=radius+altitude,originSquared=origin*origin;
    const source=[0,0,0],returns=[0,0,0];
    for(const [x,z] of directions){
      const alignment=x*sunX+z*sunZ;
      const line=originSquared*(z*z-1);
      const ground=line+radius*radius;
      const end=z<0&&ground>0?-origin*z-Math.sqrt(ground):
        -origin*z+Math.sqrt(line+(radius+height)**2);
      const pRay=3*(1+alignment*alignment)/(16*Math.PI);
      const pMie=3*(1-g*g)*(1+alignment*alignment)/
        (8*Math.PI*(2+g*g)*Math.max(.001,1+g*g-2*g*alignment)**1.5);
      let start=0,columnRay=0,columnMie=0;
      for(let sample=1;sample<=raySamples;sample++){
        const next=end*(sample/raySamples)**2,mid=(start+next)*.5,step=next-start;
        const pointRadius=Math.sqrt(originSquared+mid*mid+2*origin*z*mid);
        const h=Math.max(0,pointRadius-radius);
        const densityRay=Math.exp(-h/rayleigh[3]),densityMie=Math.exp(-h/mie[3]);
        const localRay=densityRay*step,localMie=densityMie*step;
        const solarCosine=(origin*sunZ+mid*alignment)/pointRadius;
        const lit=solarCosine>-Math.sqrt(2*h/radius);
        const airMass=(scale:number)=>2/(Math.max(0,solarCosine)+Math.sqrt(solarCosine**2+2*scale/radius));
        const solarRay=lit?densityRay*rayleigh[3]*airMass(rayleigh[3]):0;
        const solarMie=lit?densityMie*mie[3]*airMass(mie[3]):0;
        for(let channel=0;channel<3;channel++){
          const aerosol=mie[channel]+absorption[channel];
          const view=Math.exp(-rayleigh[channel]*(columnRay+localRay*.5)-aerosol*(columnMie+localMie*.5));
          const ray=rayleigh[channel]*localRay,particle=mie[channel]*localMie;
          returns[channel]+=view*(ray+particle);
          if(lit){
            const sun=Math.exp(-rayleigh[channel]*solarRay-aerosol*solarMie);
            source[channel]+=view*sun*(pRay*ray+pMie*particle);
          }
        }
        columnRay+=localRay;columnMie+=localMie;start=next;
      }
    }
    // Solve the isotropic series using the angular-average source and return.
    for(let channel=0;channel<3;channel++)
      output[offset+k*3+channel]=source[channel]/Math.max(.1*directions.length,directions.length-returns[channel]);
  }
}

export async function withStreetSkyScattering(environment:StreetEnvironment,current:()=>boolean){
  const tables=new Map<string,Float32Array>();
  const clouds=[];
  for(const layer of environment.clouds){
    const {atmosphere,planetRadius}=layer;
    if(!atmosphere){clouds.push(layer);continue;}
    const key=JSON.stringify([planetRadius,atmosphere]);
    let scatterTable=tables.get(key);
    if(!scatterTable){
      scatterTable=new Float32Array(solarSamples.length*altitudeStride);
      for(const [slot,sunZ] of solarSamples.entries()){
        // Let file reads and current region requests run between the slices.
        await new Promise<void>(resolve=>setTimeout(resolve,0));
        if(!current())return;
        scatteringSlice(atmosphere,planetRadius,sunZ,scatterTable,slot*altitudeStride);
      }
      tables.set(key,scatterTable);
    }
    clouds.push({...layer,scatterTable});
  }
  return {...environment,clouds};
}

export function sampleStreetSkyScattering(lower:Float32Array,upper:Float32Array,weatherMix:number,sunZ:number){
  const after=solarSamples.findIndex(z=>z>=sunZ);
  const upperIndex=after<0?solarSamples.length-1:after,lowerIndex=Math.max(0,upperIndex-1);
  const solarMix=lowerIndex===upperIndex?0:(sunZ-solarSamples[lowerIndex])/(solarSamples[upperIndex]-solarSamples[lowerIndex]);
  const start=lowerIndex*altitudeStride,end=upperIndex*altitudeStride;
  const result=new Float32Array(altitudeStride);
  for(let i=0;i<result.length;i++){
    const a=lower[start+i]+(lower[end+i]-lower[start+i])*solarMix;
    const b=upper[start+i]+(upper[end+i]-upper[start+i])*solarMix;
    result[i]=a+(b-a)*weatherMix;
  }
  return result;
}

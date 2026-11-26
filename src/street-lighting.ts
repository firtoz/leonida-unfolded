import type { StreetAtmosphere, StreetCloudLayer, StreetEnvironment } from "./street-environment";
import { sampleStreetSkyScattering } from "./street-sky-scattering";
import { streetFarPlane } from "./street-grid";

type RGB=readonly [number,number,number];

function blend(a:RGB,b:RGB,t:number):RGB{
  return [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t];
}

function smooth(a:number,b:number,x:number){
  const t=Math.max(0,Math.min(1,(x-a)/(b-a)));
  return t*t*(3-2*t);
}

function sampleCloudLayer(layer:StreetCloudLayer,minute:number,clock:StreetEnvironment["clock"]){
  const timed=clock.length===layer.base.length&&clock.length>1;
  const endIndex=timed?clock.findIndex(key=>key.minute>minute):-1;
  const index=timed?(endIndex<0?clock.length-1:endIndex-1):0;
  const next=timed?(index+1)%clock.length:0;
  const start=clock[index],end=clock[index+1];
  const progress=timed?(minute-start.minute)/((end?.minute??1440)-start.minute):0;
  const time=start?.quartic?(progress<.5?8*progress**4:1-8*(1-progress)**4):progress;
  const at=(values:number[])=>values[index]+(values[next]-values[index])*time;
  return {base:at(layer.base),top:at(layer.top),density:layer.density,
    sun:timed&&layer.sun?layer.sun.map(at) as [number,number,number,number]:undefined,
    ambientSky:timed&&layer.ambientSky?layer.ambientSky.map(at):undefined,
    farClip:timed&&layer.farClip?at(layer.farClip):undefined,
    fog:layer.fog?.map(at),water:layer.water?.map(at),shadowAlpha:layer.shadowAlpha&&at(layer.shadowAlpha),
    windShear:layer.windShear?at(layer.windShear):0};
}

function solarDirection(minute:number,path:StreetEnvironment["solarPath"]):RGB{
  if(path&&Number.isFinite(minute)){
    const time=(minute%1440+1440)%1440;
    const end=path.knots.findIndex(([at])=>at>time);
    const [start,a]=path.knots[end-1],[finish,b]=path.knots[end];
    const theta=Math.PI*(a+(b-a)*(time-start)/(finish-start));
    const orbit=-Math.cos(theta);
    return [Math.sin(theta),Math.cos(path.roll)*orbit,Math.sin(path.roll)*orbit];
  }
  // Approximate the sun's southern arc at 26° N before the authored settings arrive.
  const zenith=.454, hourAngle=(minute/60-12)*Math.PI/12;
  return [-Math.sin(hourAngle),-Math.cos(hourAngle)*Math.sin(zenith),Math.cos(hourAngle)*Math.cos(zenith)];
}

export function streetLighting(minute:number,cloudCover=.55,environment?:StreetEnvironment){
  const sunDirection=solarDirection(minute,environment?.solarPath);
  const z=sunDirection[2];
  const daylight=smooth(-.19,.2,z);
  const noon=smooth(.02,.6,z);
  const twilight=smooth(-.26,-.035,z)*(1-noon);
  const clear=1-smooth(0,.55,cloudCover);
  const direct=smooth(-.025,.25,z)*1.42;
  let sunlight=blend([direct,direct*.49,direct*.23],[direct,direct*.93,direct*.79],noon);
  const cloudLayers=environment?.clouds??[];
  const high=cloudLayers.findIndex(layer=>layer.cover>=cloudCover);
  const upper=cloudLayers[high]??cloudLayers.at(-1);
  const lower=cloudLayers[high-1]??upper;
  const ratio=upper&&lower&&upper!==lower?(cloudCover-lower.cover)/(upper.cover-lower.cover):0;
  const cloudLayer=[.70,2.25,1,6371];
  const contactShadow=ratio<.5?lower?.contactShadow:upper?.contactShadow;
  let fogProfile=[.00016,100,600];
  let waveStrength=1,rippleSpeed=1;
  let oceanBeaufort:number|undefined;
  let cloudShadowAlpha=.65;
  let cloudType=cloudCover;
  let atmosphere:StreetAtmosphere|undefined;
  let skyScatter:Float32Array|undefined;
  let ambientSkyGain:RGB=[1,1,1];
  let farClip:number|undefined;
  let shear:readonly [number,number]=[0,0];
  if(upper&&lower&&environment){
    const time=(minute%1440+1440)%1440;
    const near=sampleCloudLayer(lower,time,environment.clock),far=sampleCloudLayer(upper,time,environment.clock);
    cloudLayer[0]=near.base+(far.base-near.base)*ratio;
    cloudLayer[1]=near.top+(far.top-near.top)*ratio;
    cloudLayer[2]=near.density+(far.density-near.density)*ratio;
    cloudLayer[3]=upper.planetRadius;
    if(lower.wind&&upper.wind){
      const {wind:a}=lower,{wind:b}=upper;
      const mix=(x:number,y:number)=>x+(y-x)*ratio;
      const turn=b.angle-a.angle;
      const angle=a.angle+Math.atan2(Math.sin(turn),Math.cos(turn))*ratio;
      const heightMix=Math.max(0,Math.min(1,cloudLayer[0]*1000/mix(a.falloff,b.falloff)));
      const bottom=mix(a.bottom,b.bottom),top=mix(a.top,b.top);
      const speed=bottom+(top-bottom)*heightMix;
      const scale=mix(near.windShear,far.windShear)*speed/32000;
      // The native sheet shear offsets the map lookup against the wind direction.
      shear=[Math.sin(angle)*scale,Math.cos(angle)*scale];
    }
    if(lower.profile!==undefined&&upper.profile!==undefined)
      cloudType=lower.profile+(upper.profile-lower.profile)*ratio;
    if(near.fog&&far.fog)fogProfile=near.fog.map((value,i)=>value+(far.fog![i]-value)*ratio);
    if(near.shadowAlpha!==undefined&&far.shadowAlpha!==undefined)
      cloudShadowAlpha=near.shadowAlpha+(far.shadowAlpha-near.shadowAlpha)*ratio;
    if(near.water&&far.water){
      const [beaufort,speed]=near.water.map((value,i)=>value+(far.water![i]-value)*ratio);
      // The renderer's procedural swell is calibrated to a gentle breeze.
      waveStrength=.30+.70*Math.sqrt(beaufort/3);
      rippleSpeed=speed;
      if(Number.isFinite(beaufort))oceanBeaufort=Math.max(0,Math.min(12,beaufort));
    }
    if(lower.atmosphere&&upper.atmosphere){
      const interpolate=(key:"rayleigh"|"mie"|"absorption")=>lower.atmosphere![key].map((value,i)=>
        value+(upper.atmosphere![key][i]-value)*ratio) as [number,number,number,number];
      atmosphere={rayleigh:interpolate("rayleigh"),mie:interpolate("mie"),absorption:interpolate("absorption"),
        height:lower.atmosphere.height+(upper.atmosphere.height-lower.atmosphere.height)*ratio};
      if(lower.scatterTable&&upper.scatterTable)
        skyScatter=sampleStreetSkyScattering(lower.scatterTable,upper.scatterTable,ratio,z);
    }
    if(near.sun&&far.sun){
      const [red,green,blue,multiplier]=near.sun.map((value,i)=>value+(far.sun![i]-value)*ratio);
      sunlight=[sunlight[0]*red*multiplier,sunlight[1]*green*multiplier,sunlight[2]*blue*multiplier];
    }
    if(near.ambientSky&&far.ambientSky){
      // The native sky integration applies tint times intensity after the weather blend.
      const [red,green,blue,intensity]=near.ambientSky.map((value,i)=>value+(far.ambientSky![i]-value)*ratio);
      ambientSkyGain=[red*intensity,green*intensity,blue*intensity];
    }
    if(near.farClip!==undefined&&far.farClip!==undefined)
      farClip=near.farClip+(far.farClip-near.farClip)*ratio;
  }
  const shapes=environment?.cloudShapes;
  const shapeMix=smooth(.23,.85,cloudType);
  const shapeNoise=shapes?blend(shapes[0].noise,shapes[1].noise,shapeMix):[.3,.5,.15] as const;
  const shapeValue=(key:"displacement"|"lightingDensity"|"shapeFade",fallback:number)=>
    shapes?shapes[0][key]+(shapes[1][key]-shapes[0][key])*shapeMix:fallback;
  const cloudShape=[shapeMix,shapeValue("displacement",.15),shapeValue("lightingDensity",.25),shapeValue("shapeFade",.25)];
  const cloudBlend=lower?.maps&&upper?.maps?{lower:lower.maps,upper:upper.maps,progress:ratio,shear}:undefined;
  return {sunDirection,sunlight,ambientSkyGain,farClip,cloudCover,cloudLayer,cloudShape,shapeNoise,cloudShadowAlpha,contactShadow,fogProfile,atmosphere,skyScatter,waveStrength,rippleSpeed,oceanBeaufort,cloudBlend,
    skyLight:blend([.035,.055,.10],[.41,.52,.69],daylight),
    groundLight:blend([.018,.022,.039],[.23,.23,.25],daylight),
    horizonColor:blend(blend([.035,.049,.10],blend([.69,.79,.86],[.94,.99,1],clear),daylight),
      [.93,.55,.30],twilight*.79),
    zenithColor:blend([.010,.020,.052],blend([.15,.44,.70],[.105,.335,.885],clear),daylight)};
}
export type StreetLighting=ReturnType<typeof streetLighting>;

export function streetProjectionFarPlane(farClip:StreetLighting["farClip"],altitude:number,ramp:StreetEnvironment["farClipRamp"]){
  if(farClip===undefined)return streetFarPlane;
  if(!ramp)return farClip;
  const [start,end,multiplier]=ramp;
  const progress=Math.max(0,Math.min(1,(altitude-start)/(end-start)));
  return farClip*(1+progress*(multiplier-1));
}

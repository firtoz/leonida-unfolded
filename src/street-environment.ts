import type { Archive } from "./archive";
import { readRpf9PackedMember } from "./rpf9-boot";
import { drawableNameKey } from "./street-drawable-identity";
import type { openRpf9Preparer } from "./rpf9-prepare";
import { readWaterOpticsGrid } from "./street-water-optics";
import {readStreetCloudConfig,readStreetCloudWeather,readStreetWindModifiers,type StreetCloudConfig,
  type StreetCloudBlend,type StreetCloudWind} from "./street-cloud-config";

type StreetTimeKey={minute:number;quartic?:true};
type StreetSolarPath={roll:number;knots:[minute:number,phase:number][]};
type StreetLightCurves=[red:number[],green:number[],blue:number[],intensity:number[]];
type StreetFogCurves=[density:number[],height:number[],falloff:number[]];
type StreetWaterCurves=[beaufort:number[],rippleSpeed:number[]];
type ScatteringLayer=[red:number,green:number,blue:number,height:number];
export type StreetAtmosphere={rayleigh:ScatteringLayer;mie:ScatteringLayer;
  absorption:[red:number,green:number,blue:number,asymmetry:number];height:number};
type CloudShape={noise:[number,number,number];displacement:number;lightingDensity:number;shapeFade:number};
type ContactShadow=readonly [length:number,bias:number];
type FarClipRamp=readonly [start:number,end:number,multiplier:number];
type OctaDiffuseTint={rgb:readonly [number,number,number];start:number;range:number};
type OctaViewWeights=readonly [slope:number,bias:number,min:number,max:number];
export type StreetCloudLayer={cover:number;density:number;base:number[];top:number[];planetRadius:number;
  preset:string;maps?:StreetCloudBlend["lower"];
  wind?:StreetCloudWind;windShear?:number[];
  profile?:number;sun?:StreetLightCurves;ambientSky?:StreetLightCurves;fog?:StreetFogCurves;water?:StreetWaterCurves;shadowAlpha?:number[];
  farClip?:number[];contactShadow?:ContactShadow;atmosphere?:StreetAtmosphere;scatterTable?:Float32Array};
export type StreetEnvironment={clouds:StreetCloudLayer[];clock:StreetTimeKey[];
  farClipRamp?:FarClipRamp;
  octaDiffuseTint?:OctaDiffuseTint;
  octaViewWeights?:OctaViewWeights;
  solarPath?:StreetSolarPath;
  nativeClouds?:StreetCloudConfig;
  cloudShapes?:[cumulus:CloudShape,stratus:CloudShape];
  waterGrids?:NonNullable<ReturnType<typeof readWaterOpticsGrid>>[]};
const decoder=new TextDecoder();
const cloudCycles=new Set(["CLOUDSCAPE_CLOUDLESS","CLOUDSCAPE_CLEAR","CLOUDSCAPE_SCATTERED_CLOUDS",
  "CLOUDSCAPE_MIXED","CLOUDSCAPE_MIXED_HEAVY","CLOUDSCAPE_THICKLAYER"]);
const environmentKeys=new Set([
  ...[...cloudCycles].map(cycle=>BigInt(`0x${drawableNameKey(`data/timecycle/w_${cycle.toLowerCase()}.xml`)}`)),
  BigInt(`0x${drawableNameKey("data/levels/americas/time.xml")}`),
  BigInt(`0x${drawableNameKey("data/visualsettings.dat")}`),
  0x6abf35e839a6de62n, // STS_Config, cloud shape profiles
  0xd6a66c3b46cea0dfn, // WeatherTypeDatas and authored coverage map pairs
  0xa188eea08e5e9af8n, // Authored regional wind speed modifier ranges
  0x6d4ba3751cc20cden,0xb48ac0724226a7abn, // scattering and extinction GridAtlasInfo
]);

function readSolarPath(document:string):StreetSolarPath|undefined{
  const values=new Map<string,number>();
  for(const [,key,value] of document.matchAll(/^\s*misc\.(sun\.roll|sun(?:rise|set)\.(?:start|end)(?:hour|angle))[^\S\r\n]+([^\s/]+)[^\S\r\n]*(?:\/\/[^\r\n]*)?$/gim))
    values.set(key.toLowerCase(),Number(value));
  const roll=values.get("sun.roll");
  if(roll===undefined||!Number.isFinite(roll))return;
  const knots:StreetSolarPath["knots"]=[[0,0]];
  for(const stage of ["sunrise.start","sunrise.end","sunset.start","sunset.end"]){
    const hour=values.get(stage+"hour"),phase=values.get(stage+"angle");
    if(hour===undefined||phase===undefined)return;
    const minute=60*hour,previous=knots.at(-1)!;
    if(!(minute>previous[0]&&minute<1440&&phase>=previous[1]&&phase<=2))return;
    knots.push([minute,phase]);
  }
  knots.push([1440,2]);
  return {roll:roll*Math.PI/180,knots};
}

function numbers(xml:string,tag:string){
  const start=xml.indexOf(`<${tag}>`),first=start+tag.length+2,end=xml.indexOf(`</${tag}>`,first);
  if(start<0||end<0)return [];
  const content=xml.slice(first,end).trim();
  return content?content.split(/\s+/).map(Number):[];
}

function visualScalar(document:string,key:string){
  const pattern=key.replaceAll(".","\\.");
  return Number(new RegExp(`^[^\\S\\r\\n]*${pattern}[^\\S\\r\\n]+([^\\s/]+)`,"im").exec(document)?.[1]);
}

function readFarClipRamp(document:string):FarClipRamp|undefined{
  const read=(key:string)=>visualScalar(document,"misc.Multiplier."+key);
  const start=read("heightStart"),end=read("heightEnd"),multiplier=read("farClipMultiplier");
  if(Number.isFinite(start)&&Number.isFinite(end)&&end>start&&Number.isFinite(multiplier)&&multiplier>0)
    return [start,end,multiplier];
}

function readOctaDiffuseTint(document:string):OctaDiffuseTint|undefined{
  const read=(key:string)=>visualScalar(document,"imposter.trees.gbuff"+key);
  const rgb=[read("DiffuseScaleRed"),read("DiffuseScaleGreen"),read("DiffuseScaleBlue")] as const;
  const start=read("ScaleStart"),range=read("ScaleRange");
  if(rgb.every(value=>Number.isFinite(value)&&value>=0)&&Number.isFinite(start)&&start>=0&&Number.isFinite(range)&&range>0)
    return {rgb,start,range};
}

function readOctaViewWeights(document:string):OctaViewWeights|undefined{
  const read=(key:string)=>visualScalar(document,"imposter.trees.weightScale"+key);
  const start=read("Start"),end=read("End"),min=read("Min"),max=read("Max");
  const range=end-start;
  if(Number.isFinite(start)&&start>=0&&Number.isFinite(range)&&range>0&&
    Number.isFinite(min)&&min>=0&&Number.isFinite(max)&&max>=min){
    const slope=Math.fround(1/range);
    return [slope,Math.fround(-start*slope),min,max];
  }
}

function constant(xml:string,tag:string){
  const values=numbers(xml,tag);
  return Number.isFinite(values[0])&&values.every(value=>value===values[0])?values[0]:NaN;
}

function readCloudShapes(document:string):StreetEnvironment["cloudShapes"]{
  if(!document.includes("<STS_Config>"))return;
  const shape=(name:string):CloudShape|undefined=>{
    const body=new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(document)?.[1];
    if(!body)return;
    const noise=/<NoiseWeightsLow x="([^"]+)" y="([^"]+)" z="([^"]+)"/.exec(body)?.slice(1).map(Number);
    const read=(field:string)=>Number(new RegExp(`<${field} value="([^"]+)"`).exec(body)?.[1]);
    const displacement=read("NoiseDisplacement")/1000,lightingDensity=read("LightingDensityScale"),shapeFade=read("ShapeFade");
    if(!noise?.every(v=>v>=0&&v<=1)||noise.every(v=>v===0)||!(displacement>=0&&displacement<=2&&
      lightingDensity>=0&&lightingDensity<=4&&shapeFade>=0&&shapeFade<=1))return;
    return {noise:noise as CloudShape["noise"],displacement,lightingDensity,shapeFade};
  };
  const cumulus=shape("Cumulus"),stratus=shape("Stratus");
  if(cumulus&&stratus)return [cumulus,stratus];
}

function readAtmosphere(xml:string):StreetAtmosphere|undefined{
  const layer=(name:string,scale:number,height:number):ScatteringLayer=>{
    const intensity=constant(xml,`sky_new_${name}_intensity`);
    const channel=(nameSuffix:string)=>constant(xml,`sky_new_${name}_col_${nameSuffix}`)*intensity*scale;
    return [channel("r"),channel("g"),channel("b"),height];
  };
  const height=constant(xml,"sky_new_karman_line");
  const rayleigh=layer("ray_scattering",.03625,constant(xml,"sky_new_ray_density_scale"));
  const mie=layer("mie_scattering",.00694,constant(xml,"sky_new_mie_density_scale"));
  const absorption=layer("mie_absorption",.000763,constant(xml,"sky_new_mie_phase_eccentricity"));
  if(![...rayleigh.slice(0,3),...mie.slice(0,3),...absorption.slice(0,3)].every(v=>v>=0&&v<=.25)||
    !(height>=25&&height<=200&&rayleigh[3]>=1&&rayleigh[3]<=30&&mie[3]>=.1&&mie[3]<=10&&
      absorption[3]>=0&&absorption[3]<.98))return;
  return {rayleigh,mie,absorption,height};
}

function readClock(document:string){
  const keys:StreetTimeKey[]=[];
  for(const [,row] of document.matchAll(/<sample\s+([^>]+)>/g)){
    const hour=Number(/\bhour="([^"]+)"/.exec(row)?.[1]);
    if(!Number.isFinite(hour)||hour<0||hour>=24||hour*60<=(keys.at(-1)?.minute??-1))return [];
    keys.push({minute:hour*60,quartic:row.includes('interpolation_type="EASE_QUARTIC_INOUT"')?true:undefined});
  }
  return keys.length>1&&keys.length<=48&&keys[0].minute===0?keys:[];
}

function readCloudLayer(document:string):StreetCloudLayer|undefined{
  const cycle=/<cycle\s+name="([^"]+)"/i.exec(document)?.[1];
  if(!cycle||!cloudCycles.has(cycle.toUpperCase()))return;
  const vars=/<High_Level_Vars>([\s\S]*?)<\/High_Level_Vars>/.exec(document)?.[1];
  const global=/<region\s+name="GLOBAL">([\s\S]*?)<\/region>/.exec(document)?.[1];
  if(!vars||!global)return;
  const cover=constant(vars,"cloud_cover"),density=constant(vars,"cloud_Density"),profile=constant(vars,"cloud_type");
  const base=numbers(global,"local_atmosphere_cloud_height").map(value=>value/1000);
  const top=numbers(global,"local_atmosphere_cloud_height_top").map(value=>value/1000);
  const planetRadius=constant(global,"sky_new_planet_radius");
  if(!(cover>=0&&cover<=1&&density>=0&&density<=4&&base.length>0&&base.length<=48&&
    base.length===top.length&&base.every((value,i)=>value>=0&&top[i]>=value+.1&&top[i]<=15)&&
    planetRadius>=6000&&planetRadius<=7000))return;
  const sun:StreetLightCurves=[
    numbers(global,"light_dir_col_r"),numbers(global,"light_dir_col_g"),numbers(global,"light_dir_col_b"),
    numbers(global,"light_dir_mult"),
  ];
  const ambientSky:StreetLightCurves=[
    numbers(global,"ambient_sky_color_mult_r"),numbers(global,"ambient_sky_color_mult_g"),
    numbers(global,"ambient_sky_color_mult_b"),numbers(global,"ambient_sky_intensity"),
  ];
  const fog:StreetFogCurves=[numbers(global,"local_atmosphere_fog_density"),
    numbers(global,"local_atmosphere_fog_height"),numbers(global,"local_atmosphere_fog_falloff")];
  const water:StreetWaterCurves=[numbers(global,"water_ocean_beaufort_scale"),numbers(global,"water_ripple_speed_scale")];
  const shadowAlpha=numbers(global,"local_atmosphere_cloud_shadow_alpha");
  const windShear=numbers(global,"local_atmosphere_cloud_wind_shear");
  const farClip=numbers(global,"far_clip");
  const contactLength=constant(global,"screen_space_shadow_raylength"),contactBias=constant(global,"screen_space_shadow_bias");
  const contactShadow:ContactShadow|undefined=constant(global,"enable_screen_space_shadow")===1&&
    contactLength>0&&contactLength<=4&&contactBias>=0&&contactBias<=.1?[contactLength,contactBias]:undefined;
  return {cover,density,base,top,planetRadius,preset:cycle.toUpperCase(),profile:profile>=0&&profile<=1?profile:undefined,atmosphere:readAtmosphere(global),
    contactShadow,farClip:farClip.length===base.length&&farClip.every(value=>Number.isFinite(value)&&value>0)?farClip:undefined,
    windShear:windShear.length===base.length&&windShear.every(Number.isFinite)?windShear:undefined,
    sun:sun.every(curve=>curve.length===base.length&&curve.every(value=>value>=0&&value<=8))?sun:undefined,
    ambientSky:ambientSky.every(curve=>curve.length===base.length&&curve.every(value=>Number.isFinite(value)&&value>=0))?
      ambientSky:undefined,
    water:water.every((curve,index)=>curve.length===base.length&&curve.every(value=>value>=0&&value<=(index===0?12:4)))?
      water:undefined,
    shadowAlpha:shadowAlpha.length===base.length&&shadowAlpha.every(value=>value>=0&&value<=1)?shadowAlpha:undefined,
    fog:fog.every((curve,index)=>curve.length===base.length&&curve.every(value=>Number.isFinite(value)&&
      (index===0?value>=0&&value<=.03:index===1?value>=-1000&&value<=10000:value>=1&&value<=10000)))?fog:undefined};
}

export function readStreetEnvironment(documents:readonly string[]):StreetEnvironment|undefined{
  const layers=new Map<number,StreetCloudLayer>();
  const waterGrids:NonNullable<StreetEnvironment["waterGrids"]>=[];
  let clock:StreetTimeKey[]=[];
  let solarPath:StreetSolarPath|undefined;
  let farClipRamp:FarClipRamp|undefined;
  let octaDiffuseTint:OctaDiffuseTint|undefined;
  let octaViewWeights:OctaViewWeights|undefined;
  let cloudShapes:StreetEnvironment["cloudShapes"];
  let nativeClouds:StreetCloudConfig|undefined;
  let weatherXml:string|undefined;
  let windModifiers:ReturnType<typeof readStreetWindModifiers>|undefined;
  for(const document of documents){
    if(!document.trimStart().startsWith("<?xml")){
      solarPath??=readSolarPath(document);
      farClipRamp??=readFarClipRamp(document);
      octaDiffuseTint??=readOctaDiffuseTint(document);
      octaViewWeights??=readOctaViewWeights(document);
      continue;
    }
    if(/<time_data\b/.test(document))clock=readClock(document);
    cloudShapes??=readCloudShapes(document);
    if(!nativeClouds&&document.includes("<STS_Config>"))nativeClouds=readStreetCloudConfig(document);
    if(document.includes("<WeatherTypeDatas>"))weatherXml=document;
    if(document.includes("wind_prevailing_speed_min_at_bottom_falloff_kmh")&&/<modifier\s/.test(document))
      windModifiers=readStreetWindModifiers(document);
    const waterGrid=readWaterOpticsGrid(document);
    if(waterGrid&&!waterGrids.some(grid=>grid.name===waterGrid.name))waterGrids.push(waterGrid);
    if(/<timecycle_keyframe_data\b/.test(document)&&document.includes("</timecycle_keyframe_data>")){
      const layer=readCloudLayer(document);
      // Multiple sky presets can share the same cloud-cover endpoint.
      if(layer&&!layers.has(layer.cover))layers.set(layer.cover,layer);
    }
  }
  const clouds=[...layers.values()]
    .filter(layer=>clock.length===layer.base.length||
      layer.base.every(value=>value===layer.base[0])&&layer.top.every(value=>value===layer.top[0]))
    .sort((a,b)=>a.cover-b.cover);
  if(weatherXml){
    const weather=readStreetCloudWeather(weatherXml,windModifiers??new Map());
    for(const cloud of clouds){
      const source=weather.get(cloud.preset);
      cloud.maps=source?.maps;cloud.wind=source?.wind;
    }
  }
  return clouds.length||waterGrids.length||solarPath||farClipRamp||octaDiffuseTint||octaViewWeights?
    {clouds,clock,solarPath,farClipRamp,octaDiffuseTint,octaViewWeights,cloudShapes,nativeClouds,
    waterGrids:waterGrids.length?waterGrids:undefined}:undefined;
}

export async function loadStreetEnvironment(source:Archive,prepare:Awaited<ReturnType<typeof openRpf9Preparer>>){
  const directory=await prepare(source,0,source.file.size);
  const entries:{slot:number;offset:number}[]=[];
  for(let slot=0;slot<directory.layout.entryCount;slot++){
    const entry=directory.member(slot);
    if(entry?.nameKey&&entry.type===255&&!entry.alternateBacking&&environmentKeys.has(entry.nameKey))
      entries.push({slot,offset:entry.offset});
  }
  entries.sort((a,b)=>a.offset-b.offset);
  const documents=await Promise.all(entries.map(({slot})=>
    readRpf9PackedMember(source,directory,slot,prepare.processMember).then(bytes=>decoder.decode(bytes)).catch(()=>"")));
  return readStreetEnvironment(documents);
}

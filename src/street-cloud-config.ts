type CloudPair=readonly [string,string];
type WindRange={bottom:number;top:number;falloff:number};
export type StreetCloudWind=WindRange&{angle:number};
export type StreetCloudConfig={
  layers:Float32Array;
  frequency:readonly [number,number,number];
  warp:readonly [start:number,range:number,frequency:number];
  tightness:number;
  direction:number;
};

function attributes(xml:string,field:string,count:number){
  const row=new RegExp(`<${field}\\s+([^>]+)\\s*/>`).exec(xml)?.[1];
  const values=row&&[...row.matchAll(/(?:^|\s)(?:[xyzw]|value)="([^"]+)"/g)].map(match=>Number(match[1]));
  return values&&values.length===count&&values.every(Number.isFinite)?values:undefined;
}

export function readStreetCloudConfig(xml:string):StreetCloudConfig|undefined{
  if(!xml.includes("<STS_Config>"))return;
  const periods=attributes(xml,"CloudNoiseScale",3);
  const warpPeriod=attributes(xml,"CloudNoiseDisplacementScale",1)?.[0];
  const warpStart=attributes(xml,"CloudNoiseDisplacementDistanceMin",1)?.[0];
  const warpEnd=attributes(xml,"CloudNoiseDisplacementDistanceMax",1)?.[0];
  const tightness=attributes(xml,"WeatherTransition_Tightness",1)?.[0];
  const direction=attributes(xml,"WeatherTransition_Direction",1)?.[0];
  if(!periods?.every(period=>period>0)||tightness===undefined||tightness<=0||direction===undefined||
    !warpPeriod||warpPeriod<0||warpStart===undefined||warpEnd===undefined||warpStart<0||warpEnd<=warpStart)return;
  const layers:number[]=[];
  for(const name of ["Nimbus","Cumulus","Stratus","Alto"]){
    const body=new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];
    if(!body)return;
    const low=attributes(body,"NoiseWeightsLow",3),high=attributes(body,"NoiseWeightsHigh",3);
    const red=attributes(body,"NoiseBlend0",3),green=attributes(body,"NoiseBlend1",3);
    const density=attributes(body,"Density",2),heights=attributes(body,"AltitudeBlendMinMax",2);
    const erosion=attributes(body,"ErosionArea",2),fade=attributes(body,"ShapeFade",1)?.[0];
    const transition=attributes(body,"TransitionOffsetMinMax",4);
    const displacement=attributes(body,"NoiseDisplacement",1)?.[0];
    // The current runtime map pass uses a shared transition gate.
    if(!low||!high||!red||!green||!density||!heights||!erosion||!fade||fade<0||
      heights[1]<=heights[0]||!transition?.every((value,i)=>value===i%2)||displacement===undefined||displacement<0)return;
    const invRange=1/(heights[1]-heights[0]);
    layers.push(...low,density[0],...high,density[1],...red,erosion[0],...green,erosion[1],
      1/fade,-heights[0]*invRange,invRange,displacement/1000);
  }
  return {layers:new Float32Array(layers),frequency:[1000/periods[0],1000/periods[1],1000/periods[2]],
    warp:[warpStart/1000,1000/(warpEnd-warpStart),1000/warpPeriod],tightness,direction};
}

export function readStreetCloudWeather(xml:string,modifiers:ReadonlyMap<string,WindRange>){
  const weather=new Map<string,{maps:CloudPair;wind?:StreetCloudWind}>();
  const aliases=new Map<string,WindRange>();
  const types=/<WeatherTypes>([\s\S]*?)<\/WeatherTypes>/.exec(xml)?.[1];
  for(const [,row] of (types??"").matchAll(/<Item>([\s\S]*?)<\/Item>/g)){
    const preset=/<DataName>(CLOUDSCAPE_\w+)<\/DataName>/i.exec(row)?.[1].toUpperCase();
    const name=/<Name>(AM_\w+)<\/Name>/i.exec(row)?.[1].toUpperCase();
    const modifier=/<ModWind>(\w+)<\/ModWind>/i.exec(row)?.[1].toLowerCase();
    const wind=modifier&&modifiers.get(modifier);
    if(!preset||!name||!wind)continue;
    // Prefer the authored weather type named for this cloudscape over fog/rain aliases.
    const named=name.slice(3)===preset.slice("CLOUDSCAPE_".length);
    if(!aliases.has(preset)||named)aliases.set(preset,wind);
  }
  const presets=/<WeatherTypeDatas>([\s\S]*?)<\/WeatherTypeDatas>/.exec(xml)?.[1];
  if(!presets)return weather;
  for(const [,item] of presets.matchAll(/<Item>([\s\S]*?)<\/Item>/g)){
    const name=/<Name>(CLOUDSCAPE_\w+)<\/Name>/i.exec(item)?.[1];
    const a=/<CloudMapA>(cloudmap_\w+)<\/CloudMapA>/i.exec(item)?.[1];
    const b=/<CloudMapB>(cloudmap_\w+)<\/CloudMapB>/i.exec(item)?.[1];
    if(!name||!a||!b)continue;
    const key=name.toUpperCase(),range=aliases.get(key);
    const angle=attributes(item,"WindAngle",1)?.[0];
    weather.set(key,{maps:[a.toLowerCase(),b.toLowerCase()],
      wind:range&&angle!==undefined?{...range,angle:angle*Math.PI/180}:undefined});
  }
  return weather;
}

export function readStreetWindModifiers(xml:string){
  const result=new Map<string,WindRange>();
  for(const [,name,body] of xml.matchAll(/<modifier\s+name="(W_MOD_wind_\w+)"[^>]*>([\s\S]*?)<\/modifier>/gi)){
    const read=(field:string)=>{
      const values=new RegExp(`<wind_prevailing_speed_${field}_kmh>([^<]+)`)
        .exec(body)?.[1].trim().split(/\s+/).map(Number);
      return values?.every(value=>value===values[0])?values[0]:NaN;
    };
    const bottomMin=read("min_at_bottom_falloff"),bottomMax=read("max_at_bottom_falloff");
    const topMin=read("min_at_top_falloff"),topMax=read("max_at_top_falloff"),falloff=read("falloff_height");
    if([bottomMin,bottomMax,topMin,topMax,falloff].every(value=>Number.isFinite(value)&&value>=0)&&
      bottomMax>=bottomMin&&topMax>=topMin&&falloff>0)
      result.set(name.toLowerCase(),{bottom:(bottomMin+bottomMax)/7.2,top:(topMin+topMax)/7.2,falloff});
  }
  return result;
}

export type StreetCloudBlend={lower:CloudPair;upper:CloudPair;progress:number;shear:readonly [number,number]};

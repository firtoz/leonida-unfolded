export type StreetDestination={position:[number,number,number];heading?:number;pitch?:number;fov?:number};

const number=/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i;
export const maximumStreetPitch=Math.PI/2;
export const defaultStreetFov=2*Math.atan(1/1.38)*180/Math.PI;
export const streetProjection=(fov=defaultStreetFov)=>1/Math.tan(fov*Math.PI/360);
export const headingDegrees=(yaw:number)=>((90-yaw*180/Math.PI)%360+360)%360;

export function streetDestinationAngles({heading,pitch,fov}:StreetDestination,current:{yaw:number;pitch:number;fov?:number}){
  return {
    yaw:heading===undefined?current.yaw:(90-heading%360)*Math.PI/180,
    pitch:pitch===undefined?current.pitch:Math.max(-maximumStreetPitch,Math.min(maximumStreetPitch,pitch*Math.PI/180)),
    fov:fov??current.fov,
  };
}

export function formatStreetDestination({position,heading,pitch,fov}:StreetDestination&{heading:number;pitch:number}){
  const values=[...position,heading,pitch];
  if(fov!==undefined)values.push(fov);
  return values.map(value=>Number(value.toFixed(3))).join(", ");
}

export function parseStreetDestination(input:string):StreetDestination|null{
  const value=input.trim().replaceAll("−","-");
  const labeled=value.match(/^X\s+([^\s·,]+)\s*[·,]?\s*Y\s+([^\s·,]+)\s*[·,]?\s*Z\s+([^\s·,]+)(?=\s|[·,]|$)/i);
  const parts=labeled?labeled.slice(1):value.split(value.includes(",")?/\s*,\s*/:/\s+/);
  if(parts.length<3||parts.length>6||!parts.every(part=>number.test(part)&&Number.isFinite(Number(part))))return null;
  const [x,y,z,h,p,fov]=parts.map(Number);
  const angle=(label:string)=>{
    const match=value.match(new RegExp(`\\b${label}\\s+([^\\s°·,]+)`,"i"));
    return match?number.test(match[1])?Number(match[1]):NaN:undefined;
  };
  const heading=labeled?angle("heading"):h,pitch=labeled?angle("pitch"):p;
  if(heading!==undefined&&!Number.isFinite(heading)||pitch!==undefined&&
    (!Number.isFinite(pitch)||Math.abs(pitch)>maximumStreetPitch*180/Math.PI+.001))return null;
  if(fov!==undefined&&(fov<20||fov>105))return null;
  return {position:[x,y,z],heading,pitch,...(fov===undefined?{}:{fov})};
}

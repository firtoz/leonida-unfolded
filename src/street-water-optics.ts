import { textureSurface } from "./layers";
import { linearBc16 } from "./texture";
import type { WaterDictionary } from "./street-water-resource";

const atlasSystems=["waterfogatlas","waterfogatlas2"] as const;
const bc6hUnsigned=95;

type MapBounds=[west:number,north:number,width:number,height:number];
type OpticsGrid={name:string;channel:"scattering"|"extinction";bounds:MapBounds;tileSize?:number};
export type OpticsSurface={width:number;height:number;bytes:Uint8Array<ArrayBuffer>};
export type StreetWaterOptics={bounds:MapBounds;tileSize?:number;scattering:OpticsSurface;extinction:OpticsSurface};

export function readWaterOpticsGrid(xml:string):OpticsGrid|undefined{
  if(!xml.includes("<GridAtlasInfo>")||!xml.includes('useGlobalFallback value="true"'))return;
  const system=/<clientSystemName>([^<]+)<\/clientSystemName>/.exec(xml)?.[1];
  if(!atlasSystems.some(candidate=>candidate===system))return;
  const name=/<globalFallbackTextureName>([a-z0-9_]+)<\/globalFallbackTextureName>/.exec(xml)?.[1];
  const origin=/<origin x="([^"]+)" y="([^"]+)"/.exec(xml);
  const width=Number(/<width value="([^"]+)"/.exec(xml)?.[1]);
  const height=Number(/<height value="([^"]+)"/.exec(xml)?.[1]);
  const tileSize=Number(/<tileSize value="([^"]+)"/.exec(xml)?.[1]);
  if(!name||!origin||!(width>0&&height>0&&width<=100000&&height<=100000))return;
  const [x,y]=origin.slice(1).map(Number);
  if(!Number.isFinite(x)||!Number.isFinite(y))return;
  return {name,channel:system===atlasSystems[0]?"scattering":"extinction",
    bounds:[x-width/2,y+height/2,width,height],
    tileSize:tileSize>=128&&width%tileSize===0&&height%tileSize===0?tileSize:undefined};
}

export async function loadStreetWaterOptics(read:(name:string)=>Promise<WaterDictionary|undefined>,
  grids:OpticsGrid[]):Promise<StreetWaterOptics|undefined>{
  const scattering=grids.find(grid=>grid.channel==="scattering");
  const extinction=grids.find(grid=>grid.channel==="extinction");
  if(!scattering||!extinction||grids.length!==2||
    scattering.name===extinction.name||scattering.bounds.some((value,i)=>value!==extinction.bounds[i]))return;
  const load=async(name:string)=>{
    const dictionary=await read(name);
    if(!dictionary)return;
    try{
      const surface=textureSurface(dictionary.metadata,dictionary.graphics,name,bc6hUnsigned);
      const {width,height}=surface;
      if(width%4||height%4||scattering.bounds[2]/width!==scattering.bounds[3]/height)return;
      return {width,height,bytes:linearBc16(surface.bytes,width,height)};
    }catch{
      // A matching string alone does not identify a texture dictionary.
    }
  };
  const [scatter,extinct]=await Promise.all([load(scattering.name),load(extinction.name)]);
  return scatter&&extinct&&scatter.width===extinct.width&&scatter.height===extinct.height?
    {bounds:scattering.bounds,tileSize:scattering.tileSize===extinction.tileSize?scattering.tileSize:undefined,
      scattering:scatter,extinction:extinct}:undefined;
}

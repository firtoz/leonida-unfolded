import { streetTextureCacheVersions } from "./street-cache-versions";
import { Archive, identify } from "./archive";
import type { Event, Request } from "./protocol";
import { inputProfile } from "./recover";
import type { StreetAssetCache } from "./street-asset-cache";
import { bakeDynamicTerrain, DynamicTerrainSectorCache, type DynamicTerrainSource, type TerrainSectorReader } from "./street-dynamic-terrain";
import { dynamicTerrainPrefix, roomGlassTexturePrefix, streetBlueNoiseId, terrainTexturePrefix, type StreetBlockTexture, type StreetTextureImage } from "./street-terrain-material";
import { roadHeightPrefix, roadSurfacePrefix, roadSurfaceTintPrefix, roadWeightPrefix } from "./street-road-material";
import { StreetTextures, isStreetTexturePack } from "./street-textures";
import { closeMaterialPrefix, compressedMaterialFormats, compressedRoadColorFormats } from "./street-capacity";
import { streetInteriorCubePrefix } from "./street-cube-texture";
import {openRpf9Preparer,rpf9ExecutableName} from "./rpf9-prepare";
import {readStreetBlueNoise} from "./street-system-textures";
import {detailAtlasPackPath} from "./texture-pool-blocks";
import {streetSignFontPack} from "./street-sign-font";

const textureProfiles=new Map(inputProfile.filter(({path})=>path.startsWith("data/ttdb/")||path==="textures.rpf")
  .map(spec=>[spec.path,spec]));

export class StreetMaterialLoader {
  private textures?:StreetTextures;
  private readonly sectors=new DynamicTerrainSectorCache();
  constructor(private readonly files:Record<string,File>,private readonly cache?:StreetAssetCache){}

  private openTextures(){
    if(this.textures)return this.textures;
    const archives=new Map<string,Archive>();
    for(const path of textureProfiles.keys()){
      const file=this.files[path];
      if(file)archives.set(path,new Archive(path,file));
    }
    const profiled=new Set(archives.values());
    for(const [path,file] of Object.entries(this.files)){
      if((isStreetTexturePack(path)||path===detailAtlasPackPath||path===streetSignFontPack)&&!archives.has(path))
        archives.set(path,new Archive(path,file));
    }
    return this.textures=new StreetTextures(archives,new Map(),profiled,async archive=>{
      const spec=textureProfiles.get(archive.path);
      if(spec)await identify(archive,spec);
    });
  }

  prepare(){this.openTextures();}

  readImposterMips(key:bigint,minimum:number){return this.openTextures().imposterMips(key,minimum);}

  private async readBlueNoise(){
    const textures=this.files["textures.rpf"],exe=this.files[rpf9ExecutableName];
    if(!textures||!exe)return null;
    const prepare=await openRpf9Preparer(new Archive(rpf9ExecutableName,exe));
    return readStreetBlueNoise(new Archive("textures.rpf",textures),prepare);
  }

  async read({epoch,id,ground,compression}:Extract<Request,{kind:"streetTexture"}>,source?:DynamicTerrainSource,readSector?:TerrainSectorReader){
    if(id.startsWith(streetInteriorCubePrefix)){
      const key=id.slice(streetInteriorCubePrefix.length);
      const cube=await this.openTextures().interiorCube(key).catch(()=>null);
      const event:Event={kind:"streetTexture",epoch,id,ground,image:null,cube:cube??undefined};
      return {event,transfer:cube?.levels.map(level=>level.blocks.buffer)??[]};
    }
    if(id.startsWith(roadHeightPrefix)){
      if(compression&&(compression&(compressedMaterialFormats.bc1|compressedMaterialFormats.bc7))){
        const key=`road-height-blocks-v${streetTextureCacheVersions.roadHeightBlocks}:${id}`;
        const saved=await this.cache?.get("blocks",key);
        const cached=saved&&(saved.format==="bc1"||saved.format==="bc7")&&
          (compression&compressedMaterialFormats[saved.format])?saved:undefined;
        const compressed=cached??await this.openTextures().compressedRoadHeight(id,compression).catch(()=>null);
        if(compressed){
          const transfer=compressed.levels.map(mip=>mip.blocks.buffer);
          if(!cached)this.cache?.put("blocks",key,compressed,transfer.reduce((bytes,buffer)=>bytes+buffer.byteLength,0));
          const event:Event={kind:"streetTexture",epoch,id,ground,image:null,compressed,cached:cached?true:undefined};
          return {event,transfer};
        }
      }
      const key=`road-height-rg-v${streetTextureCacheVersions.roadHeightRG}:${id}`;
      const cached=await this.cache?.get("roadHeight",key);
      const levels=cached??await this.openTextures().roadHeightMips(id).catch(()=>null);
      if(levels){
        if(!cached)this.cache?.put("roadHeight",key,levels,levels.reduce((bytes,mip)=>bytes+mip.channels.byteLength,0));
        const event:Event={kind:"streetTexture",epoch,id,ground,image:null,roadHeight:levels,cached:cached?true:undefined};
        return {event,transfer:levels.map(mip=>mip.channels.buffer)};
      }
    }
    const close=id.startsWith(closeMaterialPrefix);
    const glass=id.startsWith(roomGlassTexturePrefix);
    const roadColor=id.startsWith(closeMaterialPrefix+roadSurfacePrefix);
    if(roadColor&&compression){
      const key=`road-color-srgb-blocks-v${streetTextureCacheVersions.roadColorBlocks}:${id}`;
      const saved=await this.cache?.get("blocks",key);
      const cached=saved&&(compression&compressedRoadColorFormats[saved.format])?saved:undefined;
      const compressed=cached??await this.openTextures().compressedRoadColor(id,compression).catch(()=>null);
      if(compressed){
        const transfer=compressed.levels.map(mip=>mip.blocks.buffer);
        if(!cached)this.cache?.put("blocks",key,compressed,transfer.reduce((bytes,buffer)=>bytes+buffer.byteLength,0));
        const event:Event={kind:"streetTexture",epoch,id,ground,image:null,compressed,cached:cached?true:undefined};
        return {event,transfer};
      }
    }
    const cache=(!close||roadColor)&&(!id.startsWith(dynamicTerrainPrefix)||source)?this.cache:undefined;
    const key=`false:${id}`;
    // Version decoded RGBA separately from compressed GPU blocks and meshes.
    const imageKey=ground?`ground-authored-mips-v${streetTextureCacheVersions.groundAuthoredMips}:${id}`:glass?`glass-mip-chain:${id}`:
      roadColor?`road-color-mips:${id}`:
      id.startsWith(roadSurfaceTintPrefix)?`road-surface-tint-mips:${id}`:
      id.startsWith(roadWeightPrefix)?`road-weight-mips:${id}`:
      id.startsWith(terrainTexturePrefix+"color:")||id.startsWith(terrainTexturePrefix+"normal:")||id.startsWith(terrainTexturePrefix+"height:")||id.startsWith(terrainTexturePrefix+"weights:")?`terrain-authored-mips:${id}`:
      id.startsWith(terrainTexturePrefix+"material-mask:")?`material-mask-mips:${id}`:`material-rgba-v${streetTextureCacheVersions.materialRGBA}:${id}`;
    let image:StreetTextureImage|null=null,compressed:StreetBlockTexture|null=null,cached=false;
    try{
      const format=glass?compressedMaterialFormats.bc7:compressedMaterialFormats.bc1;
      if(!close&&!ground&&((compression??0)&format)){
        compressed=await cache?.get("blocks",key)??null;
        cached=Boolean(compressed);
        if(!compressed){
          const textures=this.openTextures();
          compressed=await (glass?textures.compressedRoomGlass(id):textures.compressedBaseColor(id)).catch(()=>null);
          if(compressed)cache?.put("blocks",key,compressed,compressed.levels.reduce((sum,level)=>sum+level.blocks.byteLength,0));
        }
      }
      if(!compressed){
        image=await cache?.get("texture",imageKey)??null;
        cached=!!image;
        if(!image){
          const textures=this.openTextures();
          if(close&&compression){
            const blockKey=`close-color-blocks-v${streetTextureCacheVersions.closeColorBlocks}:${id}`;
            const saved=await this.cache?.get("blocks",blockKey);
            if(saved&&(compression&compressedMaterialFormats[saved.format])){
              compressed=saved;
              cached=true;
            }else{
              compressed=await textures.compressedCloseColor(id,compression).catch(()=>null);
              if(compressed)this.cache?.put("blocks",blockKey,compressed,
                compressed.levels.reduce((bytes,level)=>bytes+level.blocks.byteLength,0));
            }
          }
          if(!compressed)image=id===streetBlueNoiseId?await this.readBlueNoise():
            readSector&&source?await bakeDynamicTerrain(source,id=>textures.image(id,false),readSector,this.sectors):
            await textures.image(id,ground);
        }
        if(image&&!ground&&!id.startsWith(terrainTexturePrefix)&&!id.startsWith(roadHeightPrefix)&&image.alphaCutout===undefined){
          let clear=false,visible=false;
          for(let at=3;at<image.rgba.length&&!(clear&&visible);at+=4){
            clear||=image.rgba[at]<8;
            visible||=image.rgba[at]>96;
          }
          image.alphaCutout=clear&&visible;
        }
        if(image&&!cached)cache?.put("texture",imageKey,image,image.rgba.byteLength+(image.detailNormal?.byteLength??0)+
          (image.authoredMips?.reduce((bytes,mip)=>bytes+mip.rgba.byteLength,0)??0));
      }
    }catch{image=null;}
    const event:Event={kind:"streetTexture",epoch,id,ground,image,compressed:compressed??undefined,cached:cached?true:undefined};
    const transfer:Transferable[]=compressed?compressed.levels.map(level=>level.blocks.buffer):image?[image.rgba.buffer]:[];
    if(image?.detailNormal)transfer.push(image.detailNormal.buffer);
    if(image?.authoredMips)transfer.push(...image.authoredMips.map(mip=>mip.rgba.buffer));
    return {event,transfer};
  }
}

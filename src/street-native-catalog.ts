import { Archive, view } from "./archive";
import { readDrawableAliases } from "./street-archetypes";
import { batchPlant, decodeIndexedPlacements, streetAsset, type IndexedPlacement } from "./street-index-placement";
import { StreetRpf9, type StreetArchiveMember } from "./street-rpf9";
import type { StreetAsset, StreetChunk } from "./street-mesh";
import type { VegetationSource, VegetationModel, VegetationBatch, VegetationLod } from "./street-vegetation";
import { canopyQueryRadius, grassQueryRadius, nativeVegetationRadius, readVegetationLods, scanVegetation, vegetationDistance, vegetationDrawRadius,
  vegetationInstanceLayout, vegetationUpdateSize, type VegetationInstanceLayout } from "./street-vegetation";
import { bridgeDeckProxy, bridgeHorizon, prefabBridgeSkyline, roadBridgeDrawable } from "./street-lod";
import { drawableNameKey } from "./street-drawable-identity";
import { intersectsTerrain, readNativeTerrainMaterial, terrainMounts, terrainViewFootprint } from "./street-native-terrain";
import type { DetailCell } from "./street-grid";
import { readInteriorRoomVolumes, readStreetInteriorInstances, readStreetInteriors, streetInteriorScene,
  type InteriorRoomVolumes, type StreetInterior, type StreetInteriorInstance } from "./street-interior";
import { streetDistance } from "./street-priority";
import { composePlacement } from "./street-placement";
import { readInteriorCollision } from "./street-interior-collision";
import { decodeStaticCollision } from "./street-collision";

const worldCollisionTypes=new Set([6]);
const catalogMemberTypes: ReadonlySet<number> = new Set([2, 3, 4, 6, 0x0b, 0x49, 0x4a]);
const packedImpostorDrawableKey=BigInt("0x"+drawableNameKey("ip_slod_imposter"));
const nativeGroundCover=/^veg_(?:hedge|debris)_.*(?<!_uw)(?<!_water)(?<!_imposter)$/i;
// Floating leaf batches have ordinary cutout geometry at their authored water-surface pivots.
const floatingLeafDebris=/^veg_debris_(?:[a-z0-9]+_)*leaves_\d+_water$/i;
const plantDrawable=(model:VegetationModel)=>batchPlant.test(model.name)||nativeGroundCover.test(model.name)||floatingLeafDebris.test(model.name);

export type NativeCatalogOpen = { catalog: "open"; file: Blob; executable: Blob; common?: Blob };
export type NativeCatalogQuery = { catalog: "query"; id: number; point: readonly [number, number]; radius: number; altitude?: number; wide?:true };
export type NativeCatalogCancel = { catalog: "cancel" };
export type NativeCatalogCancelNear = { catalog:"cancelNear"; id:number };
export type NativeVegetationQuery = { catalog: "plants"; id: number; point: readonly [number, number]; altitude?:number };
export type NativePackedModelsQuery = { catalog:"packedModels"; id:number; keys:bigint[] };
export type NativePackedModelsReply = { packedModels:true; id:number; models:Map<bigint,VegetationModel> };
type NativeVegetationLod=Omit<VegetationLod,"parent">&{
  map:bigint;parent?:(Omit<NonNullable<VegetationLod["parent"]>,"selector">&{map:bigint});
};
type CatalogPlantBatch={batch:VegetationBatch;key:bigint;center:readonly [number,number,number];layout?:VegetationInstanceLayout};
type CatalogPlantMap=Omit<Awaited<ReturnType<StreetRpf9["readSystemPages"]>>,"bytes">&{
  graphicsSize:number;batches:CatalogPlantBatch[];lods:Map<number,VegetationLod>;
};
export type NativeVegetationSource=VegetationSource&{graphicsStart:number;graphicsSize:number;graphicsEnd:number;
  instanceLayouts:Map<number,VegetationInstanceLayout>;
  woodyDrawable?:true;
  lods?:Map<number,NativeVegetationLod>};
export type NativeVegetation = { sources: NativeVegetationSource[]; models: VegetationModel[];
  packedImpostors?:NativeVegetationSource[] };
export type NativeVegetationReply = { plants: true; id: number; result?: NativeVegetation };
export type NativeCatalogReply = { catalog: true; id: number; assets: StreetAsset[]; bytes: number;
  startedAt:number;registrationMs:number;queryMs:number } |
  { catalog: true; id: number; error: string };
export type NativeInterior={map:number;instance:StreetInteriorInstance;definition:StreetInterior;models:Map<bigint,VegetationModel>;
  spatial?:InteriorRoomVolumes;collision?:StreetChunk};
export type NativeInteriorsQuery={catalog:"interiors";id:number;eye:readonly [number,number,number];radius:number};
export type NativeInteriorsReply={interiors:true;id:number;assets?:StreetAsset[];collision?:StreetChunk[]};

export function placeInteriorAssets({map,instance,definition,models,spatial}:NativeInterior){
  const defaults=new Set(instance.defaultSets);
  const scene=streetInteriorScene(`${map.toString(16)}-${instance.ordinal}`,definition,instance.placement,spatial);
  const ownership=definition.entities.map(()=>new Set<number>());
  definition.rooms.forEach(({entities},room)=>entities.forEach(index=>ownership[index].add(room)));
  for(const {entities,from,to} of definition.portals)for(const index of entities){ownership[index].add(from);ownership[index].add(to);}
  const entities=definition.entities.map((entity,index)=>({entity,id:`base-${index}`,rooms:[...ownership[index]]}));
  definition.sets.forEach((set,index)=>{
    if(!defaults.has(set.name))return;
    set.entities.forEach((entity,ordinal)=>{
      const room=set.locations[ordinal];
      entities.push({entity,id:`set-${index}-${ordinal}`,rooms:room!==undefined&&room<scene.rooms.length?[room]:[]});
    });
  });
  return entities.flatMap(({entity,id,rooms},at)=>{
    const placement=composePlacement(instance.placement,entity.placement);
    const asset=streetAsset(models.get(entity.key),{at,hash:entity.hash,range:[map],placement});
    if(!asset)return [];
    return [{...asset,id:`interior:${scene.id}-${id}`,interior:{scene,rooms}}];
  });
}

export class StreetNativeCatalog {
  private readonly archive: Archive;
  private readonly directory: StreetRpf9;
  private collisionIndex?:Promise<StreetArchiveMember[]>;
  private readonly collisionIds=new Map<number,string[]>();
  private readonly maps: StreetArchiveMember[] = [];
  private readonly drawables = new Map<bigint, StreetArchiveMember[]>();
  private readonly canopyDrawables = new Map<bigint, StreetArchiveMember>();
  private readonly canopyModels = new Map<bigint, VegetationModel>();
  private readonly canopyPreviewModels = new Map<string, VegetationModel | undefined>();
  private readonly packs = new Map<number, Map<number, StreetArchiveMember>>();
  private readonly packsByName = new Map<number,StreetArchiveMember[]>();
  private readonly interiorMounts = new Set<number>();
  private readonly interiorSpatialMembers=new Map<bigint,StreetArchiveMember[]>();
  private readonly interiorCollisionMembers=new Map<bigint,StreetArchiveMember[]>();
  private readonly interiorCollisionData=new Map<number,Promise<Uint8Array|undefined>>();
  private readonly interiorRoomVolumes=new Map<number,Promise<InteriorRoomVolumes|undefined>>();
  // Keep decoded metadata for the selected folder. Near, wide and horizon
  // queries overlap, and a camera can revisit any of those authored members.
  // The worker is replaced when the user opens a different folder.
  private readonly placements = new Map<number, IndexedPlacement[]>();
  private readonly interiorInstances = new Map<number,StreetInteriorInstance[]>();
  private readonly interiorDefinitions = new Map<number,Promise<StreetInterior[]>>();
  private readonly models = new Map<number, VegetationModel[]>();
  private readonly plantModels = new Map<number, VegetationModel[]>();
  private readonly plantMaps = new Map<number, Promise<CatalogPlantMap|null>>();
  private readonly definitions = new Map<number, Awaited<ReturnType<typeof readDrawableAliases>>>();
  private readonly pendingDefinitions = new Map<number,Promise<Awaited<ReturnType<typeof readDrawableAliases>>>>();
  private ready?: Promise<void>;

  constructor(file: Blob, executable: Blob, private readonly common?: Blob) {
    this.archive = new Archive("levels.rpf", file);
    this.directory = new StreetRpf9(this.archive, executable);
  }

  prepare() {
    return this.ready ??= this.register();
  }

  async terrainMaterial(name:string){
    if(!this.common)return;
    const {mounts}=await this.directory.levelMounts(new Archive("common.rpf",this.common));
    return readNativeTerrainMaterial(this.directory,mounts.values(),name);
  }

  private async register() {
    const common = this.common && new Archive("common.rpf", this.common);
    const mounts=common?[...(await this.directory.levelMounts(common)).mounts.values()]:[];
    const canopyMount=mounts.find(mount=>mount.path==="platform:/levels/americas/vegetation/imposters.rpf")?.base;
    for(const mount of mounts)if(mount.path.includes("/interiors/"))this.interiorMounts.add(mount.base);
    for await (const members of this.directory.catalogMembers(common,catalogMemberTypes)) {
      for (const member of members) {
        if (member.type === 0x49 && (member.entityBounds || member.streamingBounds)) this.maps.push(member);
        else if((member.type===0x0b||member.type===6&&this.interiorMounts.has(member.mountBase))&&member.nameKey){
          const table=member.type===6?this.interiorCollisionMembers:this.interiorSpatialMembers;
          const rows=table.get(member.nameKey);
          if(rows)rows.push(member);
          else table.set(member.nameKey,[member]);
        } else if (member.type === 0x4a && member.nameHash) {
          let child = this.packs.get(member.mountBase);
          if (!child) this.packs.set(member.mountBase, child = new Map());
          child.set(member.nameHash, member);
          let named=this.packsByName.get(member.nameHash);
          if(!named)this.packsByName.set(member.nameHash,named=[]);
          named.push(member);
        } else if ((member.type === 2 || member.type === 3 || member.type === 4) && member.nameKey) {
          if(member.type===2&&member.mountBase===canopyMount)this.canopyDrawables.set(member.nameKey,member);
          const matches = this.drawables.get(member.nameKey);
          if (matches) matches.push(member);
          else this.drawables.set(member.nameKey, [member]);
        }
      }
    }
  }

  private async discoverCollision(){
    const common=this.common&&new Archive("common.rpf",this.common);
    if(!common)return [];
    const {mounts}=await this.directory.levelMounts(common);
    const candidates=[...mounts.values()].filter(mount=>
      mount.path.includes("/map/environment/")||mount.path.includes("/map/terrain/"));
    const sources:StreetArchiveMember[]=[];
    for(let start=0;start<candidates.length;start+=8){
      const batches=await Promise.all(candidates.slice(start,start+8).map(mount=>this.directory.mountedMembers(mount,worldCollisionTypes)));
      for(const batch of batches)for(const member of batch)
        if(member.type===6&&member.collisionBounds)sources.push(member);
    }
    return sources;
  }

  prepareCollision(){
    return this.collisionIndex??=this.discoverCollision().catch(error=>{
      this.collisionIndex=undefined;
      throw error;
    });
  }

  async queryWorldCollision(point:readonly [number,number],known:readonly string[],active=()=>true,
    spawnCell?:DetailCell){
    const resident=new Set(known);
    const wanted:string[]=[],meshes:StreetChunk[]=[];
    const sources=await this.prepareCollision();
    if(!active())return {wanted,meshes};
    const nearest=sources.flatMap(member=>{
      const [left,bottom,,right,top]=member.collisionBounds!;
      const distance=vegetationDistance(...point,left,bottom,right,top);
      if(spawnCell){
        const [column,row]=spawnCell;
        if(left>(column+1)*128||right<column*128||bottom>(row+1)*128||top<row*128)return [];
      }else if(distance>128)return [];
      return [{member,distance}];
    }).sort((a,b)=>a.distance-b.distance);
    for(let start=0;start<nearest.length&&active();start+=8){
      const group=await Promise.all(nearest.slice(start,start+8).map(async ({member})=>{
        const existing=this.collisionIds.get(member.offset);
        if(existing?.every(id=>resident.has(id)))return {wanted:existing,meshes:[]};
        try{
          const result=decodeStaticCollision(await this.directory.readSystem(member),member.offset,resident);
          this.collisionIds.set(member.offset,result.wanted);
          return result;
        }catch{return;}
      }));
      for(const region of group)if(region){
        wanted.push(...region.wanted);
        meshes.push(...region.meshes);
      }
    }
    return {wanted,meshes};
  }

  async query(point: readonly [number, number], radius: number, active: () => boolean) {
    const began=performance.now();
    await this.prepare();
    const registrationMs=performance.now()-began;
    const scenes = this.maps.filter(member => {
      const box = member.entityBounds ?? member.streamingBounds!;
      return vegetationDistance(...point, box[0], box[1], box[3], box[4]) <= radius;
    });
    const result=await this.resolve(scenes,row=>{
      const [x, y] = row.placement.position;
      return Math.hypot(x - point[0], y - point[1]) <= radius;
    },active);
    return {...result,registrationMs};
  }

  async queryInteriors(eye:readonly [number,number,number],radius:number,active:()=>boolean){
    await this.prepare();
    const before=this.archive.bytesRead;
    const scenes=this.maps.filter(member=>streetDistance(member.entityBounds??member.streamingBounds!,eye)<=radius**2);
    await this.readMaps(scenes,active);
    const interiors:NativeInterior[]=[];
    for(const map of scenes){
      if(!active())break;
      const instances=this.interiorInstances.get(map.offset);
      if(!instances?.length)continue;
      const packs=this.interiorPacksFor(map);
      for(const instance of instances){
        if(!active())break;
        for(const pack of packs){
          if(!active())break;
          const definition=(await this.loadInteriorPack(pack)).find(def=>def.key===instance.key&&def.name===instance.hash);
          if(!definition)continue;
          const [x,y,z]=instance.placement.position,[xy,height]=instance.placement.scale;
          const [left,bottom,low,right,top,high]=definition.bounds;
          const extent=Math.hypot(Math.max(Math.abs(left),Math.abs(right))*xy,
            Math.max(Math.abs(bottom),Math.abs(top))*xy,Math.max(Math.abs(low),Math.abs(high))*height);
          if(Math.hypot(x-eye[0],y-eye[1],z-eye[2])>radius+extent)break;
          const defaults=new Set(instance.defaultSets);
          const entities=[...definition.entities,...definition.sets.filter(set=>defaults.has(set.name)).flatMap(set=>set.entities)];
          const needed=new Map(entities.filter(entity=>entity.key).map(entity=>[entity.key,entity.hash]));
          const [models,spatial,collisionData]=await Promise.all([
            this.interiorModels(needed,[pack,...packs.filter(other=>other!==pack)],active),
            this.loadInteriorRoomVolumes(map,instance),
            this.loadInteriorCollisionData(instance),
          ]);
          if(active()){
            const scene=streetInteriorScene(`${map.offset.toString(16)}-${instance.ordinal}`,definition,instance.placement,spatial);
            const collision=collisionData&&readInteriorCollision(view(collisionData),{scene,rooms:[]});
            interiors.push({map:map.offset,instance,definition,models,spatial,collision});
          }
          break;
        }
      }
    }
    return {interiors:active()?interiors:[],bytes:this.archive.bytesRead-before};
  }

  async queryTerrain(point:readonly [number,number],reach:number,detailReach:number,active:()=>boolean,cells?:readonly DetailCell[]){
    if(!this.common)return {assets:[],bytes:0};
    const before=this.archive.bytesRead;
    const base=terrainViewFootprint(point,reach),detail=detailReach>=0?terrainViewFootprint(point,detailReach):undefined;
    const selectedCells=cells&&new Set(cells.map(cell=>cell.join(",")));
    const cellBounds=cells?.map(([col,row])=>[col*128,row*128,(col+1)*128,(row+1)*128] as const);
    const {mounts}=await this.directory.levelMounts(new Archive("common.rpf",this.common));
    const drawables=new Map<bigint,StreetArchiveMember[]>();
    const packs=new Map<number,Map<number,StreetArchiveMember>>();
    const scenes:StreetArchiveMember[]=[];
    const selected=terrainMounts(mounts.values(),base,detail);
    for(let i=0;i<selected.length&&active();i+=8){
      const contents=await Promise.all(selected.slice(i,i+8).map(mount=>this.directory.mountedMembers(mount)));
      for(const members of contents)for(const member of members){
        if(member.type===0x49){
          const bounds=member.entityBounds;
          const footprint=member.mapClass===3?detail:member.mapClass===5?base:undefined;
          if(!bounds||!footprint)continue;
          const area=[bounds[0],bounds[1],bounds[3],bounds[4]] as const;
          if(intersectsTerrain(footprint,area)&&(!cellBounds||cellBounds.some(cell=>intersectsTerrain(cell,area))))scenes.push(member);
        }else if(member.type===0x4a&&member.nameHash){
          let child=packs.get(member.mountBase);
          if(!child)packs.set(member.mountBase,child=new Map());
          child.set(member.nameHash,member);
        }else if((member.type===2||member.type===3||member.type===4)&&member.nameKey){
          const matches=drawables.get(member.nameKey);
          if(matches)matches.push(member);
          else drawables.set(member.nameKey,[member]);
        }
      }
    }
    const {assets}=await this.resolve(scenes,(row,map)=>{
      const [x,y]=row.placement.position;
      const [left,bottom,right,top]=map.mapClass===3&&detail?detail:base;
      return x>=left&&x<right&&y>=bottom&&y<top&&
        (!selectedCells||selectedCells.has(`${Math.floor(x/128)},${Math.floor(y/128)}`));
    },active,drawables,packs);
    return {assets:assets.filter(asset=>asset.kind==="terrain"),bytes:this.archive.bytesRead-before};
  }

  async queryHorizon(point: readonly [number, number, number], radius: number, active: () => boolean) {
    const began=performance.now();
    await this.prepare();
    const registrationMs=performance.now()-began;
    const scenes = this.maps.filter(({ mapClass, streamingBounds, entityBounds }) => {
      if ((mapClass !== 5 && mapClass !== 6) || !streamingBounds || !entityBounds) return false;
      if (!point.every((value, axis) => value >= streamingBounds[axis] - .1 &&
        value <= streamingBounds[axis + 3] + .1)) return false;
      const [left, bottom,, right, top] = entityBounds;
      return vegetationDistance(point[0], point[1], left, bottom, right, top) <=
        (mapClass === 5 ? Math.min(bridgeHorizon, radius) : radius);
    });
    const result = await this.resolve(scenes, row => {
      const lod = row.placementLod;
      return !!lod && lod.level > 0 && lod.children > 0;
    }, active, this.drawables, this.packs, true);
    return { ...result, maps: scenes.length,registrationMs,
      assets: result.assets.filter(asset => asset.kind === "skyline" || bridgeDeckProxy(asset.name)) };
  }

  async queryVegetation(point: readonly [number, number], active: () => boolean, grassOnly=false, includeLod=false) {
    await this.prepare();
    const candidates = this.maps.filter(({ mapFlags, entityBounds }) =>
      !!((mapFlags ?? 0) & 0x400) && !!entityBounds &&
      vegetationDistance(...point, entityBounds[0], entityBounds[1], entityBounds[3], entityBounds[4]) <=
        (grassOnly ? grassQueryRadius : canopyQueryRadius) + 1);
    return this.readVegetation(candidates,active,({batch:[,,,,grass,,left,bottom,right,top]}) =>
      (!grassOnly || !!grass) && vegetationDistance(...point,left,bottom,right,top) <=
      (grass ? grassQueryRadius : canopyQueryRadius),includeLod);
  }

  private async readVegetation(candidates:StreetArchiveMember[],active:()=>boolean,
    include:(entry:CatalogPlantBatch)=>boolean,includeLod=false) {
    const before = this.archive.bytesRead;
    const read = async (member: StreetArchiveMember) => {
      const map=await this.vegetationMap(member);
      if(!map)return null;
      if(!active())return;
      const nearby=map.batches.filter(include);
      if(!nearby.length)return;
      const lods=includeLod?new Map<number,VegetationLod>():undefined;
      const instanceLayouts=new Map<number,VegetationInstanceLayout>();
      for(const {batch:[,at],layout} of nearby){
        const link=map.lods.get(at);
        if(link)lods?.set(at,link);
        if(layout)instanceLayouts.set(at,layout);
      }
      return {member,pages:map.pages,graphics:map.graphics,graphicsStart:map.graphicsStart,
        graphicsSize:map.graphicsSize,batches:nearby,lods,instanceLayouts};
    };
    const sources: NonNullable<Awaited<ReturnType<typeof read>>>[] = [];
    let failed = 0;
    for (let start = 0; start < candidates.length && active(); start += 12) {
      const found = await Promise.all(candidates.slice(start, start + 12).map(read));
      if (!active()) break;
      for (const source of found) {
        if (source) sources.push(source);
        else if (source === null) failed++;
      }
    }
    return { sources: active() ? sources : [], candidates: candidates.length, failed, bytes: this.archive.bytesRead - before };
  }

  private vegetationMap(member:StreetArchiveMember){
    const saved=this.plantMaps.get(member.offset);
    if(saved)return saved;
    // Share current reads across camera requests. Retain the decoded metadata
    // and discard the system pages once the bounds and links are extracted.
    const loaded=this.directory.readSystemPages(member).then(({bytes,pages,graphics,graphicsStart})=>{
      const data=view(bytes);
      const {batches,graphicsSize}=scanVegetation(data);
      const entries=batches.map((batch):CatalogPlantBatch=>{
        const [,at,,,grass]=batch;
        const box=at+(grass?0x80:0xa0);
        const midpoint=(axis:number)=>(data.getFloat32(box+axis,true)+data.getFloat32(box+0x10+axis,true))*.5;
        const key=data.getBigUint64(at+0x20,true);
        let layout:VegetationInstanceLayout|undefined;
        try{layout=vegetationInstanceLayout(batch,data,key);}
        catch{ /* Keep the record eligible so the graphics path reports the invalid batch. */ }
        return {batch,key,center:[midpoint(0),midpoint(4),midpoint(8)],layout};
      });
      return {pages,graphics,graphicsStart,graphicsSize,batches:entries,lods:readVegetationLods(data,batches)};
    }).catch(()=>{
      this.plantMaps.delete(member.offset);
      return null;
    });
    this.plantMaps.set(member.offset,loaded);
    return loaded;
  }

  private async vegetationLods(member:StreetArchiveMember,selected:VegetationBatch[],
    lods:Map<number,VegetationLod>|undefined){
    const map=member.nameKey;
    if(!map||!lods?.size)return;
    const links=new Map<number,NativeVegetationLod>();
    const external=selected.some(([,at])=>(lods.get(at)?.parent?.selector??-1)>=0);
    const keys=external?await this.directory.linkedMapKeys(member).catch(()=>[]):[];
    for(const [,at] of selected){
      const lod=lods.get(at);
      if(!lod)continue;
      const {parent,...fields}=lod;
      const parentMap=parent&&(parent.selector<0?map:keys[parent.selector]);
      links.set(at,{...fields,map,parent:parent&&parentMap?
        {map:parentMap,ordinal:parent.ordinal,instance:parent.instance,indices:parent.indices}:undefined});
    }
    return links.size?links:undefined;
  }

  async queryCanopy(eye:readonly [number,number,number],active:()=>boolean,includePacked=false,includeImpostors=false){
    await this.prepare();
    const before=this.archive.bytesRead;
    const candidates=(includePacked||this.canopyDrawables.size)?this.maps.filter(({mapFlags,streamingBounds:box})=>
      !!((mapFlags??0)&0x400)&&!!box&&eye.every((value,i)=>value>=box[i]-.1&&value<=box[i+3]+.1)):[];
    const found=await this.readVegetation(candidates,active,({batch,key,center})=>{
      const [,,,,grass,radius,left,bottom,right,top,authored,,,vertical]=batch;
      if(grass){
        if(!includePacked||!authored||key===packedImpostorDrawableKey&&!includeImpostors)return false;
        const distance=vegetationDistance(eye[0],eye[1],left,bottom,right,top);
        return distance<=authored+vegetationUpdateSize;
      }
      const distance=Math.hypot(eye[0]-center[0],eye[1]-center[1],eye[2]-center[2]);
      // The traced object-readiness gate adds a 20 m margin at scale 1.
      if(distance>radius+20)return false;
      if(this.canopyDrawables.has(key))return true;
      if(!includePacked||!key||!authored||!vertical)return false;
      return Math.hypot(vegetationDistance(eye[0],eye[1],left,bottom,right,top),
        Math.max(vertical[0]-eye[2],0,eye[2]-vertical[1]))<=nativeVegetationRadius(batch,key)+vegetationUpdateSize;
    },true);
    const models:VegetationModel[]=[],sources:NativeVegetationSource[]=[],packedImpostors:NativeVegetationSource[]=[];
    const ids=new Map<bigint,number|undefined>();
    for(const {member,pages,graphics,graphicsStart,graphicsSize,batches,lods,instanceLayouts} of found.sources){
      const impostors=batches.flatMap(({batch,key}):VegetationBatch[]=>{
        if(!batch[4]||key!==packedImpostorDrawableKey)return [];
        const row:VegetationBatch=[...batch];
        row[12]=key;
        return [row];
      });
      if(impostors.length)packedImpostors.push({system:pages[0],systemPages:pages,graphics:graphics??[],
        graphicsStart,graphicsSize,graphicsEnd:member.end,batches:impostors,instanceLayouts});
      const selected:VegetationBatch[]=[];
      for(const {batch,key} of batches){
        if(!active())return {sources:[],models:[],candidates:found.candidates,failed:found.failed,bytes:this.archive.bytesRead-before};
        if(batch[4]||!this.canopyDrawables.has(key))continue;
        if(!ids.has(key)){
          let model=this.canopyModels.get(key);
          if(!model){
            const drawable=this.canopyDrawables.get(key)!;
            // The authored impostor mount and exact model hash identify the proxy.
            model=(await this.directory.readMembers([drawable],"full",active)).models
              .find(value=>value.hash===batch[0]&&/_imposter$/i.test(value.name));
            if(model)this.canopyModels.set(key,model);
          }
          ids.set(key,model?models.length:undefined);
          if(model)models.push(model);
        }
        const id=ids.get(key);
        if(id!==undefined&&models[id].hash===batch[0]){
          const row:VegetationBatch=[...batch];
          row[0]=id;row[12]=key;
          selected.push(row);
        }
      }
      if(selected.length)sources.push({system:pages[0],systemPages:pages,graphics:graphics??[],
        graphicsStart,graphicsSize,graphicsEnd:member.end,batches:selected,instanceLayouts,
        lods:await this.vegetationLods(member,selected,lods)});
    }
    const packed=includePacked?await this.bindPlants(found.sources,
      (batch,key)=>Boolean(batch[4])&&key!==packedImpostorDrawableKey, active):undefined;
    const woody=includePacked?await this.bindPlants(found.sources,
      (batch,key)=>!batch[4]&&!this.canopyDrawables.has(key),active):undefined;
    return {sources,models,packed,woody,packedImpostors,candidates:found.candidates,failed:found.failed,bytes:this.archive.bytesRead-before};
  }

  async queryCanopyPreview(eye:readonly [number,number,number],active:()=>boolean,includeImpostors=false):Promise<NativeVegetation>{
    const {models,sources,packed,woody,packedImpostors}=await this.queryCanopy(eye,active,true,includeImpostors);
    const preview:VegetationModel[]=[],indices=new Map<number,number>();
    for(const [index,impostor] of models.entries()){
      if(!active())return {sources:[],models:[]};
      const base=impostor.name.replace(/_imposter$/i,"");
      let model=this.canopyPreviewModels.get(base);
      if(!this.canopyPreviewModels.has(base)){
        const key=BigInt(`0x${drawableNameKey(base)}`);
        const members=this.drawables.get(key)?.filter(member=>member.type===2||member.type===3)??[];
        if(members.length)model=(await this.directory.readMembers(members,"full",active)).models.find(row=>row.name===base);
        if(active())this.canopyPreviewModels.set(base,model);
      }
      if(model){indices.set(index,preview.length);preview.push(model);}
    }
    const converted=sources.flatMap(source=>{
      const batches=source.batches.flatMap((batch):VegetationBatch[]=>{
        const model=indices.get(batch[0]);
        if(model===undefined)return [];
        const row:VegetationBatch=[...batch];
        row[0]=model;
        return [row];
      });
      return batches.length?[{...source,batches}]:[];
    });
    for(const lane of [packed,woody]){
      if(!lane)continue;
      const first=preview.length;
      preview.push(...lane.models);
      for(const source of lane.sources)converted.push({...source,woodyDrawable:lane===woody?true:undefined,
        batches:source.batches.map(([model,...batch]):VegetationBatch=>[model+first,...batch]),
      });
    }
    return {packedImpostors,models:preview,sources:converted};
  }

  private packsFor(map:StreetArchiveMember,mounts=this.packs) {
    const packs=mounts.get(map.mountBase);
    return [map.archetypePack,...map.archetypeDependencies??[]].flatMap(hash=>{
      const pack=hash&&packs?.get(hash);
      return pack?[pack]:[];
    });
  }

  private interiorPacksFor(map:StreetArchiveMember){
    const declared=[map.archetypePack,...map.archetypeDependencies??[]].flatMap(hash=>
      hash?this.packsByName.get(hash)??[]:[]);
    const local=this.packsFor(map);
    return [...new Set([...declared.filter(pack=>this.interiorMounts.has(pack.mountBase)),...local,...declared])];
  }

  private loadInteriorPack(pack:StreetArchiveMember){
    let saved=this.interiorDefinitions.get(pack.offset);
    if(!saved){
      saved=this.directory.readSystem(pack).then(bytes=>{
        const data=view(bytes);
        if(!this.definitions.has(pack.offset)&&!this.pendingDefinitions.has(pack.offset))
          this.definitions.set(pack.offset,readDrawableAliases(data,true));
        return readStreetInteriors(data);
      }).catch(()=>[]);
      this.interiorDefinitions.set(pack.offset,saved);
    }
    return saved;
  }

  private loadInteriorRoomVolumes(map:StreetArchiveMember,instance:StreetInteriorInstance){
    const matches=this.interiorSpatialMembers.get(instance.spatialKey);
    if(!matches)return;
    const selected=map.interiorSpatial?.key===instance.spatialKey?
      matches.filter(member=>member.nameHash===map.interiorSpatial?.hash):matches;
    if(selected.length!==1)return;
    const member=selected[0];
    let saved=this.interiorRoomVolumes.get(member.offset);
    if(!saved){
      saved=this.directory.readSystem(member).then(bytes=>readInteriorRoomVolumes(view(bytes))).catch(()=>undefined);
      this.interiorRoomVolumes.set(member.offset,saved);
    }
    return saved;
  }

  private loadInteriorCollisionData(instance:StreetInteriorInstance){
    const matches=this.interiorCollisionMembers.get(instance.key);
    if(matches?.length!==1)return;
    const member=matches[0];
    let saved=this.interiorCollisionData.get(member.offset);
    if(!saved){
      saved=this.directory.readSystem(member).catch(()=>undefined);
      this.interiorCollisionData.set(member.offset,saved);
    }
    return saved;
  }

  private async interiorModels(needed:Map<bigint,number>,packs:StreetArchiveMember[],active:()=>boolean){
    const matches=new Map<bigint,{members:StreetArchiveMember[];hash:number}>();
    for(const pack of packs){
      if(!needed.size||!active())break;
      const bindings=(await this.loadPack(pack))?.bindings;
      for(const [key] of needed){
        const binding=bindings?.get(key);
        if(!binding)continue;
        const members=this.drawables.get(binding.key)?.filter(member=>member.type===binding.type);
        if(!members?.length)continue;
        matches.set(key,{members,hash:binding.hash});
        needed.delete(key);
      }
    }
    for(const [key,hash] of needed){
      const members=this.drawables.get(key)?.filter(member=>member.type!==4);
      if(members?.length)matches.set(key,{members,hash});
    }
    await this.readModels([...new Set([...matches.values()].flatMap(({members})=>members))],active);
    const models=new Map<bigint,VegetationModel>();
    if(active())for(const [key,{members,hash}] of matches){
      for(const member of members){
        const model=this.models.get(member.offset)?.find(candidate=>candidate.hash===hash);
        if(model){models.set(key,model);break;}
      }
    }
    return models;
  }

  private async loadPack(pack:StreetArchiveMember) {
    if(this.definitions.has(pack.offset))return this.definitions.get(pack.offset);
    const pending=this.pendingDefinitions.get(pack.offset);
    if(pending)return pending;
    const load=this.directory.readSystem(pack).then(data=>readDrawableAliases(view(data),true)).catch(()=>undefined)
      .then(definition=>{
        this.pendingDefinitions.delete(pack.offset);
        this.definitions.set(pack.offset,definition);
        return definition;
      });
    this.pendingDefinitions.set(pack.offset,load);
    return load;
  }

  async queryPlants(point:readonly [number,number],active:()=>boolean):Promise<NativeVegetation>{
    const {sources}=await this.queryVegetation(point,active,false,true);
    return this.bindPlants(sources,batch=>{
      const [,,,,,,left,bottom,right,top]=batch;
      return vegetationDistance(...point,left,bottom,right,top)<=vegetationDrawRadius(batch)+vegetationUpdateSize;
    },active);
  }

  async queryPackedModels(keys:readonly bigint[],active:()=>boolean){
    await this.prepare();
    const models=new Map<bigint,VegetationModel>();
    for(const key of keys){
      if(!active())break;
      const entries=(this.drawables.get(key)??[]).filter(member=>member.type===2||member.type===3);
      if(!entries.length)continue;
      const {models:loaded}=await this.directory.readMembers(entries,"full",active);
      const exact=loaded.find(model=>/^veg_/i.test(model.name)&&BigInt("0x"+drawableNameKey(model.name))===key);
      if(exact)models.set(key,exact);
    }
    return models;
  }

  private async plantModel(key:bigint,hash:number,active:()=>boolean,type?:number){
    for(const drawable of this.drawables.get(key)??[]){
      if(!active())return;
      if(type===undefined?drawable.type===4:drawable.type!==type)continue;
      let candidates=this.plantModels.get(drawable.offset);
      if(!candidates){
        candidates=(await this.directory.readMembers([drawable],"full",active)).models.filter(plantDrawable);
        if(!active())return;
      }
      this.plantModels.delete(drawable.offset);
      this.plantModels.set(drawable.offset,candidates);
      if(this.plantModels.size>4096)this.plantModels.delete(this.plantModels.keys().next().value!);
      const model=candidates.find(value=>value.hash===hash);
      if(model)return model;
    }
  }

  private async bindPlants(sources:Awaited<ReturnType<StreetNativeCatalog["readVegetation"]>>["sources"],
    include:(batch:VegetationBatch,key:bigint)=>boolean,active:()=>boolean):Promise<NativeVegetation>{
    const models:VegetationModel[]=[],result:NativeVegetationSource[]=[];
    const selections=new Map<string,Map<bigint,number|undefined>>();
    const modelIds=new Map<VegetationModel,number>();
    const direct=new Map<number,StreetArchiveMember>();
    for(const source of sources)for(const {batch,key} of source.batches){
      if(!key||!include(batch,key))continue;
      const members=this.drawables.get(key)?.filter(member=>member.type!==4);
      const drawable=members?.length===1?members[0]:undefined;
      if(drawable&&!this.plantModels.has(drawable.offset))direct.set(drawable.offset,drawable);
    }
    // The directory reader coalesces neighboring members. Prime only
    // unambiguous candidates and keep the existing scoped lookup for aliases.
    const entries=[...direct.values()].sort((a,b)=>a.offset-b.offset);
    for(let start=0;start<entries.length&&active();start+=64){
      const window=entries.slice(start,start+64);
      const {models:loaded}=await this.directory.readMembers(window,"full",active);
      if(!active())return {models:[],sources:[]};
      const byMember=new Map(window.map(({offset})=>[offset,[] as VegetationModel[]]));
      for(const model of loaded)if(plantDrawable(model))byMember.get(model.streams[0][0])?.push(model);
      for(const [offset,candidates] of byMember)this.plantModels.set(offset,candidates);
      while(this.plantModels.size>4096)this.plantModels.delete(this.plantModels.keys().next().value!);
    }
    for(const source of sources){
      const {member,pages,graphics,graphicsStart,graphicsSize,instanceLayouts}=source;
      const packs=this.packsFor(member);
      const scope=packs.map(pack=>pack.offset).join(",");
      let selected=selections.get(scope);
      if(!selected)selections.set(scope,selected=new Map());
      const batches:VegetationSource["batches"]=[];
      for(const {batch,key} of source.batches){
        if(!active())return {sources:[],models:[]};
        if(!key||!include(batch,key))continue;
        let id=selected.get(key);
        if(!selected.has(key)){
          let model=await this.plantModel(key,batch[0],active);
          for(const pack of packs){
            if(model||!active())break;
            const binding=(await this.loadPack(pack))?.bindings.get(key);
            if(binding)model=await this.plantModel(binding.key,binding.hash,active,binding.type);
          }
          if(!active())return {sources:[],models:[]};
          if(model){
            id=modelIds.get(model);
            if(id===undefined){id=models.length;models.push(model);modelIds.set(model,id);}
          }
          selected.set(key,id);
        }
        if(id!==undefined){
          const row:VegetationSource["batches"][number]=[...batch];
          row[0]=id;row[12]=key;
          batches.push(row);
        }
      }
      if(batches.length)result.push({system:pages[0],systemPages:pages,graphics:graphics??[],
        graphicsStart,graphicsSize,graphicsEnd:member.end,batches,instanceLayouts,
        lods:await this.vegetationLods(member,batches,source.lods)});
    }
    return {sources:result,models};
  }

  private async readMaps(scenes:StreetArchiveMember[],active:()=>boolean){
    const missingMaps = scenes.filter(member => !this.placements.has(member.offset));
    await this.directory.readMembers(missingMaps, "sample", active, (pages, data) => {
      if(!active())return;
      const offset=pages[0][0],interiors=readStreetInteriorInstances(data);
      if(interiors.length)this.interiorInstances.set(offset,interiors);
      this.placements.set(offset,decodeIndexedPlacements(data,pages));
    });
    if(active())for (const member of missingMaps)
      if (!this.placements.has(member.offset)) this.placements.set(member.offset, []);
  }

  private async readModels(members:StreetArchiveMember[],active:()=>boolean){
    const resources=members.filter(member=>!this.models.has(member.offset));
    const {models}=await this.directory.readMembers(resources,"full",active);
    if(!active())return;
    for(const member of resources)this.models.set(member.offset,[]);
    for(const model of models)this.models.get(model.streams[0][0])?.push(model);
  }

  private async resolve(scenes: StreetArchiveMember[], include: (row: IndexedPlacement,map:StreetArchiveMember) => boolean,
    active: () => boolean,drawables=this.drawables,packs=this.packs,skylineRanges=false) {
    if (!active()) return { assets: [], bytes: 0 };
    const before = this.archive.bytesRead;
    await this.readMaps(scenes,active);
    if (!active()) return { assets: [], bytes: this.archive.bytesRead - before };

    const selected: {row:IndexedPlacement;key:bigint;map:StreetArchiveMember;dependencies:StreetArchiveMember[];
      matches:{member:StreetArchiveMember;hash:number}[]}[]=[];
    for (const map of scenes) {
      const dependencies=this.packsFor(map,packs);
      for (const row of this.placements.get(map.offset) ?? []) {
        if (row.staged || !row.key || !include(row,map)) continue;
        const key = BigInt(`0x${row.key}`);
        const matches=(drawables.get(key)??[]).filter(member=>member.type!==4)
          .map(member=>({member,hash:row.hash}));
        selected.push({row,key,map,dependencies,matches});
      }
    }
    let unresolved=selected.filter(({matches,dependencies})=>!matches.length&&dependencies.length);
    // Read each dependency tier once, preserving the first usable authored binding for each placement.
    for(let depth=0;unresolved.length&&active();depth++){
      const parents=[...new Set(unresolved.map(({dependencies})=>dependencies[depth]))];
      const definitions=new Map<StreetArchiveMember,Awaited<ReturnType<StreetNativeCatalog["loadPack"]>>>();
      for(let start=0;start<parents.length&&active();start+=8){
        const page=parents.slice(start,start+8);
        const loaded=await Promise.all(page.map(pack=>this.loadPack(pack)));
        for(const [index,pack] of page.entries())definitions.set(pack,loaded[index]);
      }
      unresolved=unresolved.filter(({dependencies,key,matches})=>{
        const binding=definitions.get(dependencies[depth])?.bindings.get(key);
        if(binding){
          for(const member of drawables.get(binding.key)??[])
            if(member.type===binding.type)matches.push({member,hash:binding.hash});
        }
        return !matches.length&&depth+1<dependencies.length;
      });
    }
    if (!active()) return { assets: [], bytes: this.archive.bytesRead - before };
    const required = new Set<StreetArchiveMember>();
    for (const {matches} of selected)
      for (const {member} of matches) if (!this.models.has(member.offset)) required.add(member);
    await this.readModels([...required],active);
    if (!active()) return { assets: [], bytes: this.archive.bytesRead - before };
    const assets: StreetAsset[] = [];
    for (const { row, key, map, matches } of selected) {
      for (const { member, hash } of matches) {
        const model = this.models.get(member.offset)?.find(candidate => candidate.hash === hash);
        const asset = streetAsset(model, row, true);
        if (!asset) continue;
        const lod=asset.placementLod;
        if(lod&&!lod.distance&&(skylineRanges&&asset.kind==="skyline"||
          roadBridgeDrawable(asset.name)||prefabBridgeSkyline(asset.name))){
          for(const pack of this.packsFor(map,packs)){
            if(!active())return {assets:[],bytes:this.archive.bytesRead-before};
            const distance=(await this.loadPack(pack))?.lodDistances.get(key);
            if(distance){
              asset.placementLod={...lod,distance};
              break;
            }
          }
        }
        assets.push(asset);
        break;
      }
    }
    return { assets, bytes: this.archive.bytesRead - before };
  }
}

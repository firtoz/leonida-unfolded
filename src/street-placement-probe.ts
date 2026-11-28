import { inflate, text, view, type Archive } from "./archive";
import type { StreetAsset } from "./street-mesh";
import { readPlacement, type SignLabel } from "./street-placement";
import type { Bounds } from "./native-spatial";

export type MapPage = [offset: number, bytes: number, decoded: number, raw?: 1];
export type PlacementMap = { bounds: number[]; pages: MapPage[]; entities: number };
export type PlacementModel = Omit<StreetAsset, "instance" | "at" | "center" | "id" | "coverage">;
type Region = { point: [number, number]; maps: PlacementMap[] };
export type PlacementProbe = { regions: Region[]; models: PlacementModel[] };
export type PlacementProbeStats = {
  maps: number; entities: number; matched: number; fallback: number; candidatePlacements: number;
  failedMaps: number; bytes: number; milliseconds: number; maximumCenterDelta: number;
};

const mapType = 0xd3593fa6, entityType = 0xce501483;
const placementStride = 0x90, archetypeOffset = 0x44;
const mapNameField=0xe6e17f14,entityArrayField=0xccab9307,parentMapsField=0x75d16adf;
export type TerrainPlacementLink={map:number;ordinal:number;parent?:[map:number,ordinal:number]};
export type PlacementLodLink=TerrainPlacementLink&{level:number;children:number;distance?:number};

function readMapLinks(data:DataView,blockTable:number,blocks:number,mapSize:number,name:number|undefined,
  entities:number|undefined,parents:number|undefined){
  if(name===undefined||entities===undefined)return;
  const root=data.getUint32(0x20,true);
  if(root<1||root>blocks)return;
  const entry=blockTable+(root-1)*16;
  if(data.getUint32(entry,true)!==mapType||mapSize>data.getUint32(entry+4,true))return;
  try{
    const at=pointer(data,entry+8,mapSize),map=data.getUint32(at+name,true);
    if(!map)return;
    const array=(field:number,kind:number,stride:number)=>{
      const ref=data.getBigUint64(at+field,true),count=data.getUint16(at+field+8,true);
      const block=Number(ref&0xfffffn),skip=Number(ref>>20n),length=count*stride;
      if(!count||count>data.getUint16(at+field+10,true)||block<1||block>blocks)return;
      const row=blockTable+(block-1)*16;
      if(data.getUint32(row,true)!==kind||skip+length>data.getUint32(row+4,true))return;
      return {start:pointer(data,row+8,skip+length)+skip,count};
    };
    const refs=array(entities,7,8);
    if(!refs)return;
    const ordinals=new Map<bigint,number>();
    for(let i=0;i<refs.count;i++){
      const ref=data.getBigUint64(refs.start+8*i,true);
      ordinals.set(ref,ordinals.has(ref)?-1:i);
    }
    const parentRefs=parents===undefined?undefined:array(parents,0x4a,4);
    const parentMaps=parentRefs?Array.from({length:parentRefs.count},(_,i)=>data.getUint32(parentRefs.start+4*i,true)):[];
    return {map,ordinals,parentMaps};
  }catch{return;}
}
// These archive map groups hold the logging intro and staged container route.
// Their HD and coarse maps share both group identifiers.
const stagedMapGroups=new Map([
  [0x8eac07d6,0x1811dc87],
  [0x1bdcacf4,0x7794a541],
  [0xb2b21960,0xf31ad210],
  [0x55c3deef,0x3be3f7b9],
  [0xdd9bfde0,0x0a9f5f0b],
]);

function pointer(data: DataView, at: number, bytes: number) {
  const offset = data.getUint32(at, true) - 0x50000000;
  if (data.getUint32(at + 4, true) || offset < 0 || offset + bytes > data.byteLength)
    throw new Error("Invalid placement map pointer.");
  return offset;
}

function readSignLabel(data:DataView,table:number,blocks:number,field:number):SignLabel|undefined{
  const count=data.getUint16(field+8,true);
  if(!count||count>data.getUint16(field+10,true))return;
  const resolve=(ref:bigint,length:number)=>{
    const block=Number(ref&0xfffffn),skip=Number(ref>>20n);
    if(block<1||block>blocks)return;
    const row=table+(block-1)*16;
    if(skip+length>data.getUint32(row+4,true))return;
    return {type:data.getUint32(row,true),start:pointer(data,row+8,skip+length)+skip};
  };
  try{
    const refs=resolve(data.getBigUint64(field,true),count*8);
    if(refs?.type!==7)return;
    let label:SignLabel|undefined;
    for(let i=0;i<count;i++){
      const extension=resolve(data.getBigUint64(refs.start+i*8,true),0x30);
      if(extension?.type!==0xf41297be)continue;
      const at=extension.start+0x20;
      // The supported layout has one inline text row per panel.
      if(label||data.getUint16(at+8,true)!==1||data.getUint16(at+10,true)<1)return;
      const row=resolve(data.getBigUint64(at,true),0x40);
      if(row?.type!==0x55561451)return;
      const start=row.start,length=data.getUint8(start+15)&0x7f;
      if(!length||length>15||data.getUint32(start+0x14,true)!==0||data.getUint32(start+0x20,true)!==0||
        data.getUint32(start+0x24,true)!==0||data.getUint8(start+0x38)!==1||data.getUint8(start+0x39)!==1)return;
      const name=text.decode(new Uint8Array(data.buffer,data.byteOffset+start,length));
      const font=data.getUint32(start+0x10,true);
      const scale=data.getFloat32(start+0x18,true),width=data.getFloat32(start+0x28,true);
      const anchor=data.getFloat32(start+0x2c,true),lineScale=data.getFloat32(start+0x30,true);
      if(!font||!name.trim()||/[\u0000-\u001f\ufffd]/.test(name)||
        ![scale,width,anchor,lineScale].every(Number.isFinite)||scale<=0||width<=0||lineScale<=0)return;
      label={text:name,font,scale,width,anchor,lineScale,rgba:data.getUint32(start+0x34,true)};
    }
    return label;
  }catch{return;}
}

export function placementOffsets(data: DataView, expected?: number): number[] {
  return placementLayout(data,expected,false).offsets;
}

export function placementLayout(data:DataView,expected?:number,includeLinks=true){
  if (data.byteLength < 0x50 || data.getUint32(0x10, true) !== 0x50524430 || data.getUint8(0x14) !== 0x7a)
    throw new Error("Invalid placement map header.");
  const structs = data.getUint16(0x48, true), blocks = data.getUint16(0x4c, true);
  const schema = pointer(data, 0x28, 32 * structs), blockTable = pointer(data, 0x38, 16 * blocks);
  let entitySchema = false, level=false, children=false, mapGroupSchema=false, keyOffset:number|undefined;
  let tintSelectorOffset:number|undefined,propLayerControlOffset:number|undefined,propDirtControlOffset:number|undefined;
  let extensionsOffset:number|undefined;
  let mapSize=0,mapName:number|undefined,entityArray:number|undefined,parentMaps:number|undefined;
  let streamingMin:number|undefined,streamingMax:number|undefined,streamingBounds:Bounds|undefined;
  let parentFields=0;
  for (let i = 0; i < structs; i++) {
    const row = schema + i * 32;
    const type=data.getUint32(row,true);
    if(type===mapType){
      mapSize=data.getUint32(row+0x18,true);
      const fields=data.getUint16(row+0x1e,true),members=data.getUint32(row+0x10,true)-0x50000000;
      let group=false,state=false;
      if(members>=0&&members+16*fields<=data.byteLength&&!data.getUint32(row+0x14,true)){
        for(let j=0;j<fields;j++){
          const member=members+j*16,hash=data.getUint32(member,true),offset=data.getUint32(member+4,true);
          if(hash===0x4c0acb96&&offset===124&&data.getUint8(member+8)===0x4a)group=true;
          if(hash===0x65876a4d&&offset===72&&data.getUint8(member+8)===0x4f)state=true;
          const kind=data.getUint8(member+8);
          if(hash===mapNameField&&kind===0x4a&&offset+4<=mapSize)mapName=offset;
          if(hash===entityArrayField&&kind===0x52&&offset+12<=mapSize)entityArray=offset;
          if(hash===parentMapsField&&kind===0x52&&offset+12<=mapSize)parentMaps=offset;
          if(kind===0x33&&offset+12<=mapSize){
            if(hash===0xdd22821f)streamingMin=offset;
            if(hash===0xa22ea335)streamingMax=offset;
          }
        }
      }
      mapGroupSchema||=group&&state;
    }
    if (type !== entityType) continue;
    if (data.getUint32(row + 0x18, true) !== placementStride) throw new Error("Unsupported placement record size.");
    const fields = data.getUint16(row + 0x1e, true), members = pointer(data, row + 0x10, fields * 16);
    const required = new Map([[0xa023a02c,0x44], [0x01166164,0x38], [0x77dd4010,0x10],
      [0x9ca32637,0x54], [0x10fb7c42,0x58]]);
    for (let j = 0; j < fields; j++) {
      const member = members + j * 16, hash = data.getUint32(member, true);
      const offset=data.getUint32(member+4,true);
      if (required.get(hash) === offset) required.delete(hash);
      if(hash===0x6c8f1715&&offset===0x7e&&data.getUint8(member+8)===0x60)level=true;
      if(hash===0xa687ac89&&offset===0x68&&data.getUint8(member+8)===0x15)children=true;
      if(hash===0xc8a7b90a&&offset+8<=placementStride&&[0x08,0x4f].includes(data.getUint8(member+8)))
        keyOffset=offset-archetypeOffset;
      const kind=data.getUint8(member+8);
      if(hash===0xf17e7f28&&kind===0x52&&offset+12<=placementStride)extensionsOffset=offset;
      if(hash===0x3c852527&&kind===0x15&&offset+4<=placementStride)
        tintSelectorOffset=offset-archetypeOffset;
      if(hash===0x0dc5f270&&kind===0x11&&offset<placementStride)
        propLayerControlOffset=offset-archetypeOffset;
      if(hash===0x540ca436&&kind===0x11&&offset<placementStride)
        propDirtControlOffset=offset-archetypeOffset;
      if(hash===0xd89231bd&&offset===0x5c&&kind===0x12)parentFields|=1;
      if(hash===0xe74c3c23&&offset===0x5e&&kind===0x12)parentFields|=2;
      if(hash===0x84799847&&offset===0x7f&&kind===0x10)parentFields|=4;
    }
    entitySchema = required.size === 0;
  }
  if (!entitySchema) throw new Error("Unsupported placement record schema.");
  const offsets: number[] = [];
  const links=new Map<number,TerrainPlacementLink>();
  const lodLinks=new Map<number,PlacementLodLink>();
  const signLabels=new Map<number,SignLabel>();
  const authored=includeLinks?readMapLinks(data,blockTable,blocks,mapSize,mapName,entityArray,parentFields===7?parentMaps:undefined):undefined;
  let hasMap = false, staged=false;
  for (let i = 0; i < blocks; i++) {
    const row = blockTable + i * 16, kind = data.getUint32(row, true), bytes = data.getUint32(row + 4, true);
    if(kind===mapType){
      hasMap=true;
      if(i+1===data.getUint32(0x20,true)&&bytes>=mapSize&&streamingMin!==undefined&&streamingMax!==undefined){
        const root=data.getUint32(row+8,true)-0x50000000;
        if(!data.getUint32(row+12,true)&&root>=0&&root+mapSize<=data.byteLength){
          const box:Bounds=[0,0,0,0,0,0];
          for(let axis=0;axis<3;axis++){
            box[axis]=data.getFloat32(root+streamingMin+axis*4,true);
            box[axis+3]=data.getFloat32(root+streamingMax+axis*4,true);
          }
          if(box.every(Number.isFinite)&&box[0]<=box[3]&&box[1]<=box[4]&&box[2]<=box[5])streamingBounds=box;
        }
      }
      if(mapGroupSchema&&bytes>=128){
        const root=pointer(data,row+8,128);
        staged||=stagedMapGroups.get(data.getUint32(root+124,true))===data.getUint32(root+72,true);
      }
    }
    if (kind !== entityType) continue;
    if (bytes % placementStride) throw new Error("Partial placement block.");
    const start = pointer(data, row + 8, bytes);
    for(let at=start;at<start+bytes;at+=placementStride){
      const field=at+archetypeOffset;
      offsets.push(field);
      const sign=includeLinks&&extensionsOffset!==undefined&&readSignLabel(data,blockTable,blocks,at+extensionsOffset);
      if(sign)signLabels.set(field,sign);
      if(!authored)continue;
      const ordinal=authored.ordinals.get((BigInt(at-start)<<20n)|BigInt(i+1));
      if(ordinal===undefined||ordinal<0)continue;
      const link:TerrainPlacementLink={map:authored.map,ordinal};
      if(authored.parentMaps.length&&data.getInt16(at+0x5e,true)===-1){
        const map=authored.parentMaps[data.getInt8(at+0x7f)],index=data.getInt16(at+0x5c,true);
        if(map&&index>=0)link.parent=[map,index];
      }
      links.set(field,link);
      if(level&&children){
        const lod=data.getUint8(at+0x7e),count=data.getUint32(at+0x68,true);
        if(lod<=6&&(count||link.parent)){
          const distance=data.getFloat32(at+0x60,true);
          lodLinks.set(field,{...link,level:lod,children:count,
            ...(Number.isFinite(distance)&&distance>0?{distance}:{})});
        }
      }
    }
  }
  if (!hasMap || expected !== undefined && offsets.length !== expected) throw new Error("Placement map count mismatch.");
  return {offsets,authoredLods:level&&children,staged,keyOffset,tintSelectorOffset,propLayerControlOffset,propDirtControlOffset,
    links,lodLinks,signLabels,streamingBounds};
}

export async function compareNativePlacements(archive: Archive, probe: PlacementProbe, point: readonly [number, number],
  radius: number, baseline: StreetAsset[], active = () => true, remember?: (offset: number, page: DataView) => void) {
  const region = probe.regions.find(region => region.point[0] === point[0] && region.point[1] === point[1]);
  if (!region) return { assets: baseline };
  const start = performance.now();
  const stats: PlacementProbeStats = { maps: region.maps.length, entities: 0, matched: 0, fallback: baseline.length,
    candidatePlacements: 0, failedMaps: 0, bytes: 0, milliseconds: 0, maximumCenterDelta: 0 };
  const models = new Map(probe.models.map(model => [model.hash,model]));
  const native = new Map<StreetAsset,StreetAsset>();
  const key = (offset: number, at: number) => `${offset}:${at}`;
  const original = new Map(baseline.map(asset => [key(asset.instance[0], asset.at), asset]));
  const [x,y] = point;
  let next = 0;
  await Promise.all(Array.from({length: 8}, async () => {
    while (active() && next < region.maps.length) {
      const { pages, entities } = region.maps[next++];
      try {
        const data = new Uint8Array(pages.reduce((sum, page) => sum + page[2], 0));
        const pageStarts: number[] = [];
        let cursor = 0;
        for (const [offset, bytes, decoded, raw] of pages) {
          const source = await archive.read(offset, bytes);
          stats.bytes += source.length;
          const chunk = raw ? source : inflate(source, decoded);
          if (chunk.length !== decoded) throw new Error("Invalid placement page length.");
          pageStarts.push(cursor);
          data.set(chunk,cursor);
          cursor += chunk.length;
        }
        const table = view(data), offsets = placementOffsets(table, entities);
        stats.entities += offsets.length;
        for (const at of offsets) {
          const hash = table.getUint32(at,true), model = models.get(hash);
          if (!model) continue;
          const page = pageStarts.findIndex((start, index) => at - 52 >= start && at + 24 <= start + pages[index][2]);
          // The current mesh loader needs a single compressed page for the transform.
          if (page < 0 || pages[page][3]) continue;
          const localAt = at - pageStarts[page], [offset,bytes,decoded] = pages[page];
          const identity = key(offset,localAt), old = original.get(identity);
          let position;
          try { position = readPlacement(table,at,hash).position; } catch { continue; }
          if (!old) {
            if (Math.hypot(x-position[0],y-position[1]) <= radius) stats.candidatePlacements++;
            continue;
          }
          // Preserve curated variants, bounds and IDs in the A/B comparison.
          if (old.batchStreams || old.hash !== hash || old.name !== model.name || old.kind !== model.kind ||
              old.system !== model.system || old.geometryDescriptor !== model.geometryDescriptor ||
              old.distantDescriptor !== model.distantDescriptor || old.collisionRef !== model.collisionRef ||
              JSON.stringify(old.parts) !== JSON.stringify(model.parts) ||
              JSON.stringify(old.streams) !== JSON.stringify(model.streams)) continue;
          const delta = Math.hypot(position[0]-old.center[0],position[1]-old.center[1]);
          if (delta > 0.005) continue;
          stats.maximumCenterDelta = Math.max(stats.maximumCenterDelta,delta);
          native.set(old,{...model,at:localAt,instance:[offset,bytes,decoded],center:position.slice(0,2),
            id:old.id,coverage:old.coverage});
          if (remember && table.getUint32(pageStarts[page]+0x10,true) === 0x50524430)
            remember(offset, new DataView(data.buffer,pageStarts[page],decoded));
        }
      } catch {
        stats.failedMaps++;
      }
    }
  }));
  const assets = baseline.map(old => {
    const improved = native.get(old);
    if (improved) stats.matched++;
    return improved ?? old;
  });
  stats.fallback = baseline.length - stats.matched;
  stats.milliseconds = performance.now() - start;
  return { assets, stats };
}

// Authored CMapTypes and archetype schemas, as described in Leonida's world_archetypes reader.
const mapTypes=0xd98bb561;
const definitionTypes=new Set([0x82d6fc83,0x76b0c56c,0x10506455]);
const fields={name:0xe6e17f14,asset:0x9a77c7c5,kind:0x069004b2,dictionaryChild:0x66d9cb52};

export type DrawableAlias={hash:number;asset:number;kind:1|2};
export type DictionaryArchetype={key:bigint;dictionary:bigint;child:number};
type DrawableBinding={key:bigint;type:2|3|4;hash:number};

export function readDrawableAliases(data:DataView,includeDictionaries=false){
  if(data.byteLength<0x50)return;
  const pointer=(at:number)=>data.getUint32(at+4,true)===0?data.getUint32(at,true)-0x50000000:-1;
  const structs=data.getUint16(0x48,true),blocks=data.getUint16(0x4c,true);
  const schema=pointer(0x28),table=pointer(0x38),root=data.getUint32(0x20,true);
  if(root<1||root>blocks||schema<0||table<0||schema+32*structs>data.byteLength||table+16*blocks>data.byteLength||
    data.getUint32(table+16*(root-1),true)!==mapTypes)return;
  const aliases:DrawableAlias[]=[];
  const dictionaries:DictionaryArchetype[]=[];
  const lodDistances=new Map<bigint,number>();
  const bindings=new Map<bigint,DrawableBinding>();
  let needed=data.byteLength;
  for(let i=0;i<structs;i++){
    const row=schema+i*32,type=data.getUint32(row,true);
    if(!definitionTypes.has(type))continue;
    const members=pointer(row+16),count=data.getUint16(row+30,true),stride=data.getUint32(row+24,true);
    if(members<0||stride<12||count>256)continue;
    if(members+count*16>data.byteLength){
      needed=Math.max(needed,members+count*16);continue;
    }
    const offsets=new Map<number,number>();
    for(let n=0;n<count;n++){
      const at=members+16*n,hash=data.getUint32(at,true),offset=data.getUint32(at+4,true),type=data.getUint8(at+8);
      if(offset+4>stride)continue;
      if((hash===fields.asset||hash===fields.name||hash===fields.dictionaryChild)&&type===0x4a||
        hash===fields.kind&&type===0x62)offsets.set(hash,offset);
    }
    const name=offsets.get(fields.name),assetName=offsets.get(fields.asset),assetType=offsets.get(fields.kind);
    const childOffset=offsets.get(fields.dictionaryChild);
    if(name===undefined||assetName===undefined||assetType===undefined)continue;
    for(let j=0;j<blocks;j++){
      const at=table+j*16;
      if(data.getUint32(at,true)!==type)continue;
      const length=data.getUint32(at+4,true),start=pointer(at+8);
      if(start<0||length%stride)continue;
      if(start+length>data.byteLength){needed=Math.max(needed,start+length);continue;}
      for(let item=start;item<start+length;item+=stride){
        const hash=data.getUint32(item+name,true),asset=data.getUint32(item+assetName,true),kind=data.getUint32(item+assetType,true);
        if(hash&&asset&&hash!==asset&&(kind===1||kind===2))aliases.push({hash,asset,kind});
        if(includeDictionaries&&type===0x82d6fc83&&stride===0xb8){
          const key=data.getBigUint64(item+8,true),distance=data.getFloat32(item+0x38,true);
          if(key&&Number.isFinite(distance)&&distance>0)lodDistances.set(key,distance);
          if(key&&(kind===1||kind===2)){
            // Fragment archetypes can name their member with the archetype key itself.
            const drawable=kind===1?data.getBigUint64(item+0x28,true)||key:data.getBigUint64(item+0x20,true);
            if(drawable&&asset)bindings.set(key,{key:drawable,type:kind===1?3:2,hash:asset});
          }
        }
        // The dictionary selector has its own reflected field, separate from assetName.
        if(includeDictionaries&&type===0x82d6fc83&&stride===0xb8&&childOffset===0x74&&kind===3){
          const child=data.getUint32(item+childOffset,true);
          const key=data.getBigUint64(item+8,true),dictionary=data.getBigUint64(item+0x18,true);
          if(key&&dictionary&&child){
            dictionaries.push({key,dictionary,child});
            bindings.set(key,{key:dictionary,type:4,hash:child});
          }
        }
      }
    }
  }
  return {aliases,dictionaries,lodDistances,bindings,needed};
}

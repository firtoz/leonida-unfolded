import type { VegetationLocator, VegetationRange } from "../src/street-vegetation";

const version=1;

// Store source offsets as deltas, with optional footprints for grass and woody plants.
export function encodeVegetationLocators(locators:VegetationLocator[]){
  const bytes:number[]=[];
  function put(value:number){
    if(!Number.isSafeInteger(value)||value<0)throw new Error("Invalid vegetation locator value.");
    while(value>=128){bytes.push(value%128+128);value=Math.floor(value/128);}
    bytes.push(value);
  }
  const signed=(value:number)=>put(value<0?-value*2-1:value*2);
  put(version);
  put(locators.length);
  let previous=0;
  for(const {system,graphics,grass,woody,excluded=[]} of locators){
    const [offset,stored,decoded]=system;
    put(offset-previous);put(stored);put(decoded);
    previous=offset;
    put(graphics.length);
    for(const [at,size,expanded,raw] of graphics){
      put(at-offset);put(size);put(expanded*2+Number(Boolean(raw)));
    }
    put(Number(Boolean(grass))+2*Number(Boolean(woody)));
    for(const box of [grass,woody])if(box)for(const bound of box)signed(bound);
    put(excluded.length);
    for(const at of excluded)put(at);
  }
  return Uint8Array.from(bytes);
}

export function decodeVegetationLocators(bytes:Uint8Array):VegetationLocator[]{
  let cursor=0,offset=0;
  function take(){
    let value=0;
    for(let shift=0;cursor<bytes.length&&shift<=49;shift+=7){
      const byte=bytes[cursor++];
      value+=(byte&127)*2**shift;
      if(byte<128&&Number.isSafeInteger(value))return value;
    }
    throw new Error("Invalid vegetation locator encoding.");
  }
  const signed=()=>{const value=take();return value%2?-(value+1)/2:value/2;};
  const footprint=():[number,number,number,number]=>[signed(),signed(),signed(),signed()];
  if(take()!==version)throw new Error("Unsupported vegetation locator version.");
  const count=take();
  if(count>bytes.length)throw new Error("Invalid vegetation locator count.");
  const locators:VegetationLocator[]=[];
  for(let i=0;i<count;i++){
    offset+=take();
    const system:VegetationRange=[offset,take(),take()];
    const pages=take();
    if(pages<1||pages>16)throw new Error("Invalid vegetation graphics page count.");
    const graphics:VegetationRange[]=Array.from({length:pages},()=>{
      const at=offset+take(),size=take(),expanded=take(),decoded=Math.floor(expanded/2);
      return expanded%2?[at,size,decoded,1]:[at,size,decoded];
    });
    const flags=take(),grass=flags&1?footprint():undefined,woody=flags&2?footprint():undefined;
    const excludedCount=take();
    if(excludedCount>4096)throw new Error("Invalid vegetation exclusion count.");
    const excluded=excludedCount?Array.from({length:excludedCount},take):undefined;
    locators.push({system,graphics,grass,woody,excluded});
  }
  if(cursor!==bytes.length)throw new Error("Trailing bytes in vegetation locator.");
  return locators;
}

import { cellKey, type Atlas } from "./recover";

export type EditFile = { version:1; build:string; fills:[number,number,string][] };

export function serialize(build:string,fills:Map<string,string>):EditFile {
  const rows:EditFile["fills"]=[...fills].map(([key,id])=>{
    const [x,y]=key.split(",").map(Number);
    return [x,y,id];
  });
  rows.sort((a,b)=>a[1]-b[1]||a[0]-b[0]);
  return {version:1,build,fills:rows};
}

export function parseEdits(raw:unknown,atlas:Atlas,keepUnavailable=false) {
  const data=raw as Partial<EditFile>|null;
  const [left,top,w,h]=atlas.world;
  if(!data||data.version!==1||data.build!==atlas.build||!Array.isArray(data.fills)||data.fills.length>w*h)
    throw new Error("Choose a compatible local edits file.");
  const fixed=new Set(atlas.cells.filter(cell=>!cell.recovery).map(cell=>cellKey(cell.x,cell.y)));
  const fills=new Map<string,string>();
  for(const row of data.fills){
    if(!Array.isArray(row)||row.length!==3)throw new Error("Invalid fill record.");
    const [x,y,id]=row,key=cellKey(x,y);
    if(!Number.isInteger(x)||!Number.isInteger(y)||x<left||y<top||x>=left+w||y>=top+h||
      typeof id!=="string"||!/^0x[0-9a-f]{16}$/.test(id)||(!keepUnavailable&&!Object.hasOwn(atlas.textures,id))||
      fixed.has(key)||fills.has(key))throw new Error(`Invalid fill at (${x}, ${-y-1}).`);
    fills.set(key,id);
  }
  return fills;
}

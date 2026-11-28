import { expect,test } from "bun:test";
import type { NativePart } from "../src/native-spatial";
import { pauseMapEntries,shadePauseMapEntries } from "../src/pause-map-buildings";
import { pauseMapBuildingPalette } from "../src/pause-map-constants";
import type { StreetInterior } from "../src/street-interior";
import { CELL } from "../src/recover";

test("pause-map entry probes follow exterior portals and the interior placement",()=>{
  const rooms:StreetInterior["rooms"]=[
    {name:0,bounds:[0,0,0,0,0,0],entities:[]},
    {name:1,bounds:[0,0,0,4,4,3],entities:[]},
    {name:2,bounds:[0,5,0,4,8,3],entities:[]},
  ];
  const corners:StreetInterior["portals"][number]["corners"]=[[0,1,0],[0,3,0],[0,3,2],[0,1,2]];
  const definitions:StreetInterior={key:1n,name:1,bounds:[0,0,0,4,8,3],rooms,entities:[],sets:[],portals:[
    {from:0,to:1,flags:0,corners,entities:[]},
    {from:1,to:2,flags:0,corners,entities:[]},
    {from:0,to:2,flags:4,corners,entities:[]},
  ]};
  expect(pauseMapEntries(definitions,{position:[10,20,3],rotation:[0,0,0,1],scale:[1,1]}))
    .toEqual([[11,22,4],[12,22,3]]);
});

test("pause-map coloring applies to the complete matching building and leaves adjacent and lower roofs alone",()=>{
  const square=(x:number,z:number)=>[x,0,z,0,x+4,0,z,0,x+4,-4,z,0,x,-4,z,0].map(n=>n/CELL);
  const part:NativePart={name:"buildings_std",vertices:new Float32Array([...square(0,8),...square(8,8),...square(0,1)]),
    indices:new Uint32Array([0,1,2,0,2,3,4,5,6,4,6,7,8,9,10,8,10,11]),
    spans:[{first:0,count:18}],bounds:[0,-4/CELL,1/CELL,12/CELL,0,8/CELL]};
  const colors=new Uint8Array(part.vertices.buffer);
  for(let i=0;i<12;i++)colors.set([...pauseMapBuildingPalette.ordinary,2],i*16+12);
  expect(shadePauseMapEntries([part],[[3,1,5],[100,100,0]])).toBe(1);
  for(let i=0;i<12;i++){
    const expected=i<4?pauseMapBuildingPalette.exteriorEntry:pauseMapBuildingPalette.ordinary;
    expect([...colors.subarray(i*16+12,i*16+16)]).toEqual([...expected,2]);
  }
});

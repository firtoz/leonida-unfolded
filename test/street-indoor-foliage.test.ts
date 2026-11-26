import {expect,test} from "bun:test";
import type {Bounds} from "../src/native-spatial";
import {hiddenExteriorFoliage,visibleIndoorFoliage,type IndoorFoliageRoom} from "../src/street-indoor-foliage";

test("indoor foliage excludes only exterior bounds outside the padded portal view",()=>{
  const room:IndoorFoliageRoom={
    scene:{id:"room",placement:{position:[0,0,0],rotation:[0,0,0,1],scale:[1,1]},
      bounds:[-2,-2,-2,2,2,2],rooms:[],portals:[]},
    bounds:[-2,-2,-2,2,2,2],
    openings:[{polygon:[[-.2,-.2],[.2,-.2],[.2,.2],[-.2,.2]],bounds:[-.2,-.2,.2,.2]}],
  };
  const hidden=hiddenExteriorFoliage(room,{eye:[0,0,0],yaw:0,pitch:0,aspect:1,fov:90,farPlane:100},1000,1000)!;
  expect(hidden([10,4,-1,12,5,1])).toBe(true);
  expect(hidden([10,-.5,-1,12,.5,1])).toBe(false);
  expect(hidden([10,1.99,-1,10.01,2.05,1])).toBe(false);
  expect(hidden([1,0,-1,4,2,1])).toBe(false);
  expect(hidden([-.01,3,-1,4,4,1])).toBe(false);
  expect(hidden([100,4,-1,102,5,1])).toBe(false);
});

test("indoor foliage preserves gaps and the retained pieces of a partially selected tile range",()=>{
  const hiddenBox:Bounds=[10,4,-1,12,5,1];
  const visibleBox:Bounds=[10,-.5,-1,12,.5,1];
  const tiles=[
    {first:2,count:5,bounds:hiddenBox},
    {first:8,count:2,bounds:visibleBox},
  ];
  const ranges=[{first:0,count:4},{first:5,count:5}];
  const filtered=visibleIndoorFoliage(ranges,tiles,visibleBox,10,bounds=>bounds===hiddenBox);
  expect(filtered).toEqual([{first:0,count:2},{first:7,count:3}]);
  expect(visibleIndoorFoliage(ranges,tiles,visibleBox,10,()=>false)).toBe(ranges);
});

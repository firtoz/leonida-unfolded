import { expect, test } from "bun:test";
import { RoadNames } from "../src/road-names";

test("road labels distinguish an overpass from the road below",()=>{
  const roads=new RoadNames([
    {name:"Canal Road",a:[-60,0,0],b:[60,0,0]},
    {name:"Market Bridge",a:[0,-60,12],b:[0,60,12]},
  ]);
  expect(roads.near(0,0,0)).toBe("Canal Road");
  expect(roads.near(0,0,12)).toBe("Market Bridge");
  expect(roads.near(0,0,50)).toBeUndefined();
  expect(roads.near(110,110,0)).toBeUndefined();
});

test("a curved label follows connected segments without joining a different level",()=>{
  const roads=new RoadNames([
    {name:"Canal Road",a:[-20,0,0],b:[0,0,0]},
    {name:"Canal Road",a:[40,40,0],b:[0,0,0]},
    {name:"Canal Road",a:[0,-30,12],b:[0,0,12]},
  ]);
  expect(roads.labels).toHaveLength(2);
  expect(roads.labels[0].points).toContainEqual([0,0,0]);
  expect(roads.labels[0].points.at(-1)).toEqual([40,40,0]);
  expect(roads.labels[1].points.every(([, ,z])=>z===12)).toBe(true);
});

test("the displayed road stays preferred near a junction until the new road is clear",()=>{
  const roads=new RoadNames([
    {name:"Canal Road",a:[-60,0,0],b:[60,0,0]},
    {name:"Market Road",a:[0,-60,0],b:[0,60,0]},
  ]);
  expect(roads.near(0,4,0)).toBe("Market Road");
  expect(roads.near(0,4,0,"Canal Road")).toBe("Canal Road");
  expect(roads.near(0,17,0,"Canal Road")).toBe("Market Road");
});

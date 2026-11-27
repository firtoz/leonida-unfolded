import {expect,test} from "bun:test";
import {StreetNativeCatalog} from "../src/street-native-catalog";
import type {StreetArchiveMember} from "../src/street-rpf9";

const collision=(offset:number):StreetArchiveMember=>({
  offset,end:offset+96,mountBase:8,type:6,systemBytes:128,collisionBounds:[0,0,0,1,1,1],
});

function catalogWithDiscovery(discoverCollision:(active:()=>boolean)=>Promise<StreetArchiveMember[]>){
  const file=new Blob();
  return Object.assign(new StreetNativeCatalog(file,file),{discoverCollision});
}

test("a complete registered collision list can satisfy concurrent callers before fallback finishes",async()=>{
  const direct=[collision(32)],registered=[collision(64),collision(96)];
  let release!:()=>void;
  const canComplete=new Promise<void>(resolve=>{release=resolve;});
  let activeDuringRead:(()=>boolean)|undefined;
  const catalog=catalogWithDiscovery(async active=>{
    activeDuringRead=active;
    await canComplete;
    return direct;
  });
  const first=catalog.prepareCollision();
  expect(catalog.prepareCollision()).toBe(first);
  expect(activeDuringRead?.()).toBe(true);
  expect(catalog.useRegisteredCollisionSources(registered)).toBe(true);
  expect(activeDuringRead?.()).toBe(false);
  release();
  expect(await first).toBe(registered);
  expect(await catalog.prepareCollision()).toBe(registered);
});

test("finished collision discovery retains its full list if the registered copy arrives late",async()=>{
  const direct=[collision(32)];
  const catalog=catalogWithDiscovery(async()=>direct);
  expect(catalog.useRegisteredCollisionSources([])).toBe(false);
  expect(await catalog.prepareCollision()).toBe(direct);
  expect(catalog.useRegisteredCollisionSources([collision(64)])).toBe(false);
  expect(await catalog.prepareCollision()).toBe(direct);
});

test("failed discovery can be retried when no registered collision list arrives",async()=>{
  const direct=[collision(32)];
  let attempts=0;
  const catalog=catalogWithDiscovery(async()=>{
    if(!attempts++)throw Error("synthetic unreadable directory");
    return direct;
  });
  await expect(catalog.prepareCollision()).rejects.toThrow("synthetic unreadable directory");
  expect(await catalog.prepareCollision()).toBe(direct);
});

test("failure releases a partial list collected for collision handoff",async()=>{
  const file=new Blob();
  const catalog=new StreetNativeCatalog(file,file,undefined,true);
  const partial=[collision(32)];
  Object.assign(catalog,{registrationCollision:partial,
    register:async()=>{throw Error("synthetic partial registration");}});
  await expect(catalog.prepare()).rejects.toThrow("synthetic partial registration");
  expect(await catalog.takeRegisteredCollisionSources()).toBeUndefined();
});

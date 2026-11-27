import { expect, test } from "bun:test";
import { zlibSync } from "fflate";
import { Archive } from "../src/archive";
import { PreparedRpf9Directory, readRpf9DirectoryLayout } from "../src/rpf9-directory";
import { readRpf9MapClass, readRpf9StreamingBounds, StreetRpf9 } from "../src/street-rpf9";
import { verifyRpf9Executable } from "../src/rpf9-prepare";
import { readRpf9ManifestPaths } from "../src/rpf9-level-manifest";
import { readDrawableAliases } from "../src/street-archetypes";
import { terrainMaterialHashes,terrainMounts,terrainViewFootprint } from "../src/street-native-terrain";

const nameKey = 0x73bcb72dce74f11fn;

test("terrain mount selection uses signed sector bounds and separate base and detail reaches",()=>{
  const root="platform:/levels/americas/map/terrain/";
  const group="n01_w01_n04_w04";
  const names=[
    `${group}/${group}_metadata.rpf`,`${group}/${group}.rpf`,
    `${group}/n02_w03.rpf`,`${group}/n01_w02.rpf`,
    `${group}/n04_w03.rpf`,`${group}/${group}_instance_placement.rpf`,
    "n01_e01_n04_e04/n01_e01_n04_e04_metadata.rpf"
  ];
  const mounts=names.map((name,i)=>({path:root+name,key:BigInt(i),base:i,end:i+1}));
  const point=[-1248.585,583.673] as const;
  expect(terrainViewFootprint(point,1)).toEqual([-1408,384,-1024,768]);
  const selected=terrainMounts(mounts,terrainViewFootprint(point,3),terrainViewFootprint(point,1));
  expect(selected.map(m=>m.base)).toEqual([0,1,2,3]);
});

test("native map classes respect the priority order of overlapping flags", () => {
  const bytes = new Uint8Array(0x18);
  const data = new DataView(bytes.buffer);
  for (const [flags, expected] of [[1, 3], [0x400, 4], [0x20184 | 0x400, 6], [0x20184 | 0x402, 5]]) {
    data.setUint32(0x14, flags, true);
    expect(readRpf9MapClass(bytes)).toBe(expected);
  }
  expect(readRpf9MapClass(bytes.subarray(0, 0x17))).toBeUndefined();
});

function directoryFixture(width: 1 | 2 | 4) {
  const bytes = new Uint8Array(0x180);
  const data = new DataView(bytes.buffer);
  data.setUint32(0, 0x52504639, true);
  data.setUint32(4, bytes.length, true);
  data.setUint32(8, 0x140, true);
  data.setUint16(0x1a, 1, true);
  data.setUint32(0x1c, 0x20, true);
  data.setUint16(0x20, 2, true);
  data.setUint16(0x22, 1, true);
  data.setUint32(0x24, 2, true);
  data.setUint8(0x2c, width);
  data.setUint8(0x2d, 1);
  const layout = readRpf9DirectoryLayout(bytes, 0x100000);
  data.setUint16(0x40, 1, true);
  data.setUint32(0x44, 4, true);
  data.setBigUint64(0x70, 0xba180afb232d1b4bn, true);
  data.setUint32(0x7c, 8, true);
  data.setUint16(0x80, 0x18, true);
  data.setBigUint64(0x88, nameKey, true);
  data.setUint32(0x94, 0x10, true);
  data.setUint16(0x98, 8, true);
  bytes.fill(0xff, layout.earlyIndices, layout.earlyIndices + width);
  bytes.fill(0xff, layout.lateIndices, layout.lateIndices + width);
  bytes[layout.earlyIndices + width] = 1;
  bytes[layout.lateIndices + width] = 1;
  const resourceAt = 0xc8;
  data.setUint32(resourceAt, 0x800000a8, true);
  data.setUint32(resourceAt + 4, 0xb2, true);
  data.setUint32(resourceAt + 8, 0x21, true);
  data.setUint32(resourceAt + 12, 0x87, true);
  data.setUint8(resourceAt + 16, 0x49);
  data.setBigUint64(0x160, 0x1122334455667788n, true);
  return { bytes, data, layout };
}

test("resolves RPF9 member records across early and late attribute matrices", () => {
  for (const width of [1, 2, 4] as const) {
    const { bytes } = directoryFixture(width);
    const directory = new PreparedRpf9Directory(bytes, 0x100000);
    expect(directory.sections.get(1)).toBe(0x54);
    expect(directory.member(0)).toBeUndefined();
    expect(directory.member(1)).toEqual({
      type: 0x49, offset: 0x870, storedBytes: 0x210, logicalBytes: 0x150, systemBytes: 0xa0,
      nameHash: undefined, nameKey: 0x1122334455667788n, alternateBacking: false
    });
  }
});

test("rejects RPF9 directory pointers outside their containing spans", () => {
  const { bytes, data, layout } = directoryFixture(2);
  expect(() => new PreparedRpf9Directory(bytes.subarray(0, 0x140), 0x100000)).toThrow("Truncated prepared");
  expect(() => new PreparedRpf9Directory(bytes, 0x100)).toThrow("Invalid RPF9 directory sizes");
  data.setUint16(layout.lateIndices + 2, 0xfffe, true);
  const directory = new PreparedRpf9Directory(bytes, 0x100000);
  expect(() => directory.attribute(1, nameKey)).toThrow("Out-of-bounds RPF9 attribute record");
  data.setUint32(0x44, layout.bodyBytes, true);
  expect(() => new PreparedRpf9Directory(bytes, 0x100000)).toThrow("Invalid prepared RPF9 section row");
});

test("reads authored streaming bounds and rejects invalid coordinate pairs", () => {
  const bytes = new Uint8Array(80);
  const data = new DataView(bytes.buffer);
  const bounds = [-40, -65, -5, 80, 100, 60];
  for (const [i, coordinate] of bounds.entries()) data.setFloat32(0x18 + i * 4, coordinate, true);
  expect(readRpf9StreamingBounds(bytes)).toEqual(bounds);
  expect(readRpf9StreamingBounds(bytes.subarray(0, 0x2f))).toBeUndefined();
  data.setFloat32(0x24, -100, true);
  expect(readRpf9StreamingBounds(bytes)).toBeUndefined();
});

test("requires the matching executable for native FPS", async () => {
  await expect(verifyRpf9Executable(undefined)).rejects.toThrow("to open the viewer");
  await expect(verifyRpf9Executable(new Blob([new Uint8Array(4096)]))).rejects.toThrow("does not match");
});

test("reads native manifest includes and mount paths from their authored sections", () => {
  const xml = String.raw`<includedSets><Item> COMMON:\DATA\Area.meta </Item></includedSets>
    <fileList><Item><filename>PLATFORM:/LEVELS/AMERICAS/Area.RPF</filename></Item>
    <Item><filename>common:/data/weather.xml</filename></Item></fileList>
    <filename>platform:/levels/unrelated.rpf</filename>`;
  expect(readRpf9ManifestPaths(xml)).toEqual({
    includes: ["common:/data/area.meta"], children: ["platform:/levels/americas/area.rpf"]
  });
});

test("reads aligned RPF9 system chunks within the declared member span", async () => {
  const pages = [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5)];
  const parts = pages.map(page => {
    const compressed = zlibSync(page);
    const padded = new Uint8Array(Math.ceil(compressed.length / 16) * 16);
    padded.set(compressed);
    return padded;
  });
  const file = new Blob([new Uint8Array(16), ...parts]);
  const reader = new StreetRpf9(new Archive("levels.rpf", file), new Blob());
  const member = { offset: 16, end: file.size, systemBytes: 5, type: 0x4a, mountBase: 0 };
  expect(await reader.readSystem(member)).toEqual(Uint8Array.of(1, 2, 3, 4, 5));
  expect(await reader.readSystem({ ...member, chunks: parts.map(p => p.length) })).toEqual(Uint8Array.of(1, 2, 3, 4, 5));
  await expect(reader.readSystem({ ...member, end: 16 + parts[0].length })).rejects.toThrow("Truncated");
});

test("reads RPF9 mode-4 raw system pages and preserves graphics ranges", async () => {
  const {bytes,data}=directoryFixture(1);
  const chunkAttribute=0xe0c12d7a5d4884c5n;
  data.setBigUint64(0x88,chunkAttribute,true);
  data.setUint32(0x160,8,true);
  data.setUint16(0x164,3,true);
  data.setUint8(0x167,4);
  for(const [index,[stored,decoded,codec]] of [[16,3,3],[16,16,0],[16,16,0]].entries()){
    data.setUint32(0x168+index*8,decoded|((stored&255)<<24),true);
    data.setUint32(0x16c+index*8,(stored>>>8)|(codec<<24),true);
  }
  const directory=new PreparedRpf9Directory(bytes,0x100000);
  const mode4=directory.decodedChunks(1,64,35);
  expect(mode4).toEqual([{stored:16,decoded:3},{stored:16,decoded:16,raw:1},{stored:16,decoded:16,raw:1}]);
  expect(()=>directory.decodedChunks(1,64,36)).toThrow("Invalid RPF9 mode-4 totals");
  expect(directory.storedChunks(1,64)).toBeUndefined();
  const compressed=new Uint8Array(16);compressed.set(zlibSync(Uint8Array.of(1,2,3)));
  const raw=new Uint8Array(16).fill(4),graphics=new Uint8Array(16).fill(5);
  const archive=new Archive("levels.rpf",new Blob([new Uint8Array(16),compressed,raw,graphics]));
  const reads:number[][]=[];
  const read=archive.read.bind(archive);
  archive.read=(offset,length)=>{reads.push([offset,length]);return read(offset,length);};
  const reader=new StreetRpf9(archive,new Blob());
  const resource=await reader.readSystemPages({offset:16,end:64,systemBytes:19,type:0x49,mountBase:0,pageChunks:mode4});
  expect(resource.bytes).toEqual(Uint8Array.of(1,2,3,...raw));
  expect(resource.pages[1]).toEqual([32,16,16,1]);
  expect(resource.graphics).toEqual([[48,16,16,1]]);
  expect(resource.graphicsStart).toBe(48);
  expect(archive.bytesRead).toBe(32);
  expect(reads).toEqual([[16,32]]);
  data.setUint8(0x167,2);
  for(let index=0;index<3;index++){
    data.setUint32(0x168+index*8,1,true);
    data.setUint32(0x16c+index*8,index===0?0xf0000001:1,true);
  }
  expect(directory.decodedChunks(1,64,48)).toEqual([
    {stored:16,decoded:16},{stored:16,decoded:16,raw:1},{stored:16,decoded:16,raw:1},
  ]);
});

test("uses the reflected dictionary selector when name and assetName differ", () => {
  const data=new DataView(new ArrayBuffer(0x1b8));
  const word=(at:number,value:number)=>data.setUint32(at,value,true);
  const pointer=(at:number,offset:number)=>word(at,0x50000000+offset);
  word(0x20,1);
  pointer(0x28,0x50);
  pointer(0x38,0x70);
  data.setUint16(0x48,1,true);
  data.setUint16(0x4c,2,true);
  word(0x50,0x82d6fc83);
  pointer(0x60,0x90);
  word(0x68,0xb8);
  data.setUint16(0x6e,4,true);
  word(0x70,0xd98bb561);
  word(0x80,0x82d6fc83);
  word(0x84,0xb8);
  pointer(0x88,0x100);
  for(const [index,[hash,offset,type]] of [
    [0xe6e17f14,0x78,0x4a],[0x9a77c7c5,0x88,0x4a],[0x069004b2,0x84,0x62],[0x66d9cb52,0x74,0x4a]
  ].entries()){
    const at=0x90+index*16;
    word(at,hash);
    word(at+4,offset);
    data.setUint8(at+8,type);
  }
  data.setBigUint64(0x108,1n,true);
  data.setBigUint64(0x118,2n,true);
  data.setFloat32(0x138,339,true);
  word(0x174,33);
  word(0x178,44);
  word(0x184,3);
  word(0x188,55);
  expect(readDrawableAliases(data,true)?.dictionaries).toEqual([{key:1n,dictionary:2n,child:33}]);
  expect(readDrawableAliases(data,true)?.lodDistances.get(1n)).toBe(339);
  word(0x174,0);
  expect(readDrawableAliases(data,true)?.dictionaries).toEqual([]);
  data.setBigUint64(0x120,0x123456789abcdef0n,true);
  word(0x184,2);
  expect(readDrawableAliases(data,true)?.bindings.get(1n)).toEqual({key:0x123456789abcdef0n,type:2,hash:55});
  data.setBigUint64(0x120,0n,true);
  word(0x184,1);
  expect(readDrawableAliases(data,true)?.bindings.get(1n)).toEqual({key:1n,type:3,hash:55});
  data.setBigUint64(0x120,3n,true);
  data.setBigUint64(0x128,4n,true);
  expect(readDrawableAliases(data,true)?.bindings.get(1n)).toEqual({key:4n,type:3,hash:55});
});

test("resolves terrain material hashes through the archetype extension list",()=>{
  const data=new DataView(new ArrayBuffer(0x280));
  const word=(at:number,value:number)=>data.setUint32(at,value,true);
  word(0x10,0x50524430);
  word(0x20,1);
  word(0x38,0x50000050);
  data.setUint16(0x4c,4,true);
  for(const [i,[type,start,length]] of [
    [0xd98bb561,0x90,0x10],[0x82d6fc83,0xa0,0xb8],[0,0x160,0x10],[0xc170daef,0x180,0xa0],
  ].entries()){
    const at=0x50+i*16;
    word(at,type);
    word(at+4,length);
    word(at+8,0x50000000+start);
  }
  data.setBigUint64(0x130,0x800003n,true);
  data.setUint16(0x138,1,true);
  data.setBigUint64(0x168,0x5000004n,true);
  word(0x1f0,0xdb73c1f9);
  word(0x214,0x79e1e9c4);
  expect([...terrainMaterialHashes(data,0xdb73c1f9)]).toEqual([0x79e1e9c4]);
  expect(terrainMaterialHashes(data,0x1234).size).toBe(0);
  data.setBigUint64(0x168,0x5100004n,true);
  expect(terrainMaterialHashes(data,0xdb73c1f9).size).toBe(0);
});

test("named catalog mount visits match direct collision listing order and aliases",async()=>{
  const blob=new Blob([new Uint8Array(8192)]),archive=new Archive("synthetic mounts",blob);
  const directory=new StreetRpf9(archive,blob);
  const mounts=[
    {path:"stage:/map/environment/root.rpf",key:1n,base:256,end:1024},
    {path:"stage:/map/terrain/next.rpf",key:2n,base:1024,end:2048},
    {path:"stage:/map/environment/alias.rpf",key:3n,base:256,end:1024},
  ];
  const valid=(at:number,mountBase:number)=>({at,end:at+64,mountBase,type:6,collisionBounds:[0,0,0,1,1,1]});
  const root=[
    {at:256,end:1024,mountBase:0,type:0},
    {at:1024,end:2048,mountBase:0,type:0},
    valid(2080,0),
  ];
  const source=new Map([
    [256,[valid(320,256),{at:448,end:768,mountBase:256,type:0},valid(800,256)]],
    [448,[valid(512,448)]],
    [1024,[valid(1088,1024),{at:1200,end:1264,mountBase:1024,type:2}]],
  ]);
  Object.assign(directory,{
    levelMounts:async()=>({mounts:new Map(mounts.map(mount=>[mount.key,mount])),missingIncludes:[]}),
    listing:async()=>root,
    catalogListing:async(base:number)=>source.get(base)??[],
  });
  const direct:number[]=[],flattened:number[]=[];
  for await(const members of directory.catalogMembers(archive,new Set([2,6]),(_,rows)=>{
    for(const row of rows)if(row.type===6&&row.collisionBounds)direct.push(row.offset);
  }))for(const row of members)if(row.type===6)flattened.push(row.offset);
  const standalone=(await Promise.all(mounts.map(mount=>directory.mountedMembers(mount,new Set([6])))))
    .flat().map(row=>row.offset);
  expect(direct).toEqual(standalone);
  expect(direct).toEqual([336,816,1104,336,816]);
  expect(flattened).toContain(528);
  expect(flattened).toContain(2096);
});

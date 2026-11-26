import { test, expect } from "bun:test";
import { gzipSync, zlibSync } from "fflate";
import { Archive, identify, inflate, unpackRanges, view } from "../src/archive";
import { bc1, blockOffset, loadPack, readMip, readTextureChunk, type Pack, type Texture } from "../src/texture";
import { decodeBcpackBc1 } from "../src/bcpack";
import { decodeBcpackColor } from "../src/bcpack-color";
import { drawableNameKey } from "../src/street-drawable-identity";
import { readDrawableAliases } from "../src/street-archetypes";
import { placementLayout } from "../src/street-placement-probe";
import { readTerrainLayerInput, StreetTextures } from "../src/street-textures";
import { StreetMaterialLoader } from "../src/street-material-loader";
import type { StreetAssetCache } from "../src/street-asset-cache";
import type { StreetBlockTexture } from "../src/street-terrain-material";
import { readStreetCube } from "../src/street-cube-texture";
import { accept } from "../src/inputs";
import { reconstructNativeCanopy } from "../src/street-canopy-atlas";
import { readImposterTreeRegistry, readImposterTreeTags, readPackedSlodModels } from "../src/street-imposter-metadata";
import { packedImpostorBatchInRange, packedImpostorBasis, packedImpostorCoverage, packedImpostorView } from "../src/street-packed-impostors";
import { readDrawables, type Atlas } from "../src/recover";
import { parseEdits, serialize } from "../src/edits";
import { describe, score } from "../src/matching";
import { groundHelipads, rangeBounds, type NativePart } from "../src/native-spatial";
import { StreetWorld } from "../src/street-world";
import { closeMaterialPrefix,compressedMaterialFormats,streetBudgets,streetCapacity } from "../src/street-capacity";
import { streetFrustum } from "../src/street-priority";
import { loadStreetRegion } from "../src/street-mesh";
import { loadCollisionRegions } from "../src/street-collision";
import { defaultStreetFov, formatStreetDestination, parseStreetDestination } from "../src/street-destination";
import { broadleafCanopyCandidates, distantCanopyAtlasCandidates, distantCanopyCandidates, nativePackedPlantCandidates, nearbyVegetationSources, placeVegetation, readVegetationBatch, readVegetationGraphics, readVegetationSource, scanVegetation,
  sameVegetationAffinesByOrdinal, uncoveredVegetationRanges, vegetationBatchId, vegetationCandidates, vegetationInstanceLayout, type VegetationBatch, type VegetationLocator, type VegetationSource } from "../src/street-vegetation";
import { decodeVegetationLocators, encodeVegetationLocators } from "../scripts/vegetation-locator";
import { streetOceanFromElevation } from "../src/street-ocean";
import { indexedGraphicsPages, readCarvedZlib, readIndexedGraphics, scanStreetSegment } from "../src/street-index-scan";
import { indexBundleMagic, StreetIndexBundle, streetArchiveFingerprint, type IndexManifest } from "../src/street-index-bundle";
import { decodeIndexedPlacements, indexStreetPropLod, PlacementDrawables, streetAsset, type IndexedPlacement } from "../src/street-index-placement";
import { joaat } from "../src/places";
import { authoredLodParent, bridgeDeckProxy, streetLodInRange, clonedPrefabName, roadBridgeDrawable, sameStreetLodPlacement,
  sameStreetPropBatch, streetLodVariant, streetPropLodVariant } from "../src/street-lod";
import { bridgeNavigationGaps } from "../src/street-nav-floor";
import { pickWalkSurface, walkFloor } from "../src/walk-surface";
import { readStreetEnvironment } from "../src/street-environment";
import { loadStreetWaterOptics, readWaterOpticsGrid } from "../src/street-water-optics";
import { inferWaterTileOrder } from "../src/street-water-tiles";
import { streetLighting, streetProjectionFarPlane } from "../src/street-lighting";
import { streetShadowCenter } from "../src/street-shadows";
import type { Bounds } from "../src/native-spatial";
import type { StreetChunk } from "../src/street-mesh";
import { trackInteriorCamera, visibleInteriorRooms, type InteriorScene } from "../src/street-interior";
import { readInteriorCollision } from "../src/street-interior-collision";
import { poseRoller, readStreetRoller } from "../src/street-roller";
import { composePlacement, placementMatrix, placementNormalMatrix, type Placement } from "../src/street-placement";

test("native canopy coverage and chroma use their own atlas resolutions",()=>{
  const base={width:16,height:16,rgba:new Uint8ClampedArray(16*16*4)};
  const chroma={width:8,height:8,rgba:new Uint8ClampedArray(8*8*4).fill(255)};
  base.rgba.set([123,243,41,255],0);
  base.rgba.set([123,255,41,255],4);
  chroma.rgba.set([123,132,32,13],0);
  const atlas=reconstructNativeCanopy(base,chroma);
  expect(atlas?.width).toBe(32);
  expect(atlas?.alphaCutout).toBe(true);
  expect(Array.from(atlas?.rgba.subarray(0,12)??[])).toEqual([44,38,31,243,47,40,32,255,0,0,0,0]);
  expect(Array.from(atlas?.rgba.subarray(64,72)??[])).toEqual([123,243,0,0,123,255,0,0]);
});

test("native canopy depth packets preserve color and mask normal data by authored coverage",()=>{
  const base={width:16,height:16,rgba:new Uint8ClampedArray(16*16*4)};
  const chroma={width:8,height:8,rgba:new Uint8ClampedArray(8*8*4).fill(128)};
  const normal={width:8,height:8,rgba:new Uint8ClampedArray(8*8*4)};
  base.rgba.set([120,255,70,255,80,128,60,255,40,0,30,255]);
  normal.rgba.set([255,127,127,255,128,128,255,255]);
  const unlit=reconstructNativeCanopy(base,chroma)!;
  const lit=reconstructNativeCanopy(base,chroma,normal)!;
  expect(lit.rgba.slice(0,64)).toEqual(unlit.rgba.slice(0,64));
  expect(Array.from(lit.rgba.slice(64,76))).toEqual([120,255,240,127,80,128,120,64,40,0,0,0]);
});

test("a superseded native terrain lookup does not fetch packaged terrain",async()=>{
  let active=true,profileRequests=0;
  const fetch=globalThis.fetch;
  globalThis.fetch=(async ()=>{
    profileRequests++;
    return new Response(null,{status:404});
  }) as typeof fetch;
  try{
    const result=await loadStreetRegion(new Archive("levels.rpf",new Blob()),[0,0],[],false,undefined,()=>active,
      undefined,true,undefined,undefined,undefined,undefined,undefined,undefined,
      async ()=>{
        await Promise.resolve();
        active=false;
        return [];
      });
    expect(result.wanted).toEqual([]);
    expect(profileRequests).toBe(0);
  }finally{
    globalThis.fetch=fetch;
  }
});

test("folder import retains the optional native impostor texture pack",()=>{
  const atlas=new File(["RDS5"],"Octa_Imposters.ttpf");
  const files:Record<string,File>={};
  accept([atlas,new File([], "unrelated.ttpf")],files);
  expect(files).toEqual({"data/ttdb/props/octa_imposters.ttpf":atlas});
});

test("water optics uses the authored grid center and pairs independently named BC6H resources",async()=>{
  const origin='<origin x="-5120.0" y="7680.0" z="0.0"/>';
  const xml=(system:string,name:string)=>`<GridAtlasInfo><clientSystemName>${system}</clientSystemName>
    <useGlobalFallback value="true"/><globalFallbackTextureName>${name}</globalFallbackTextureName>
    ${origin}<width value="512"/><height value="512"/></GridAtlasInfo>`;
  const scattering=readWaterOpticsGrid(xml("waterfogatlas","scatter_example"))!;
  const extinction=readWaterOpticsGrid(xml("waterfogatlas2","extinction_example"))!;
  expect(scattering.bounds).toEqual([-5376,7936,512,512]);
  expect(readWaterOpticsGrid(xml("shorewaves","scatter_example"))).toBeUndefined();
  const texture=(name:string,format:number)=>{
    const bytes=new Uint8Array(256),data=view(bytes),at=0x40;
    data.setUint32(0x30,0x500000c0,true);data.setUint16(0x38,1,true);
    data.setUint32(0xc0,0x50000000+at,true);
    data.setUint32(at+8,256,true);data.setUint32(at+0x18,0x60000000,true);
    data.setUint32(at+0x30,0x50000098,true);
    data.setUint16(at+0x38,64,true);data.setUint16(at+0x3a,64,true);
    data.setUint16(at+0x3c,1,true);data.setUint8(at+0x3e,1);
    data.setUint8(at+0x3f,format);data.setUint8(at+0x40,5);
    bytes.set(new TextEncoder().encode(name),0xa0);
    return bytes;
  };
  const graphics=Uint8Array.from({length:4096},(_,i)=>Math.floor(i/16));
  const read=async(name:string)=>({metadata:texture(name,95),graphics});
  const optics=await loadStreetWaterOptics(read,[extinction,scattering]);
  expect(optics?.bounds).toEqual(scattering.bounds);
  expect(optics?.extinction.bytes[(7*16+13)*16]).toEqual(blockOffset(13,7,16,16)/16);
  expect(optics?.scattering.bytes.length).toBe(4096);
  const wrongFormat=async(name:string)=>({metadata:texture(name,name===scattering.name?71:95),graphics});
  expect(await loadStreetWaterOptics(wrongFormat,[scattering,extinction])).toBeUndefined();
});

test("prop LOD batches must cover the same transforms before replacing one another",()=>{
  const first=[101,98,8,0,0,0,1,1,1],second=[151,128,8,0,0,.6,.8,1,1];
  const coarse=new Float32Array([...first,...second]);
  expect(streetPropLodVariant("prefab_ferry_hd")).toEqual({name:"prefab_ferry",rank:0});
  expect(streetPropLodVariant("prefab_ferry_lod")).toEqual({name:"prefab_ferry",rank:1});
  expect(sameStreetPropBatch(coarse,new Float32Array([...second,...first]))).toBe(true);
  expect(sameStreetPropBatch(coarse,new Float32Array([...first,...first]))).toBe(false);
  expect(sameStreetPropBatch(coarse,new Float32Array([...first,...second.slice(0,-1),1.1]))).toBe(false);
});

test("water tiles need corroborated spatial anchors before filling consecutive archive runs",()=>{
  const resources=Array.from({length:20},(_,i)=>({metadata:4096*(i+1),offset:4096*(i+1)+128}));
  const primary=[0,2,4,6,8,10,13].map(ordinal=>({ordinal,cell:ordinal+12}));
  const secondary=[15,16,18].map(ordinal=>({ordinal,cell:ordinal-12}));
  const offsets=inferWaterTileOrder(resources,27,[...primary,...secondary]);
  expect(offsets?.[11]).toBe(0);
  expect(offsets?.[12]).toBe(resources[0].offset);
  expect(offsets?.[26]).toBe(resources[14].offset);
  expect(offsets?.[3]).toBe(resources[15].offset);
  expect(offsets?.[7]).toBe(resources[19].offset);
  expect(inferWaterTileOrder(resources,27,[...primary.slice(0,5),...secondary])).toBeUndefined();
  expect(inferWaterTileOrder(resources,27,primary)?.[3]).toBe(0);
  expect(inferWaterTileOrder([...resources.slice(0,-1),{metadata:1e6,offset:1e6+128}],27,primary)).toBeUndefined();
});

test("shadow cascades snap to the same world cells from different scene origins",()=>{
  const eye=[2325.139,1077,59.132] as const;
  const yaw=(90-250.501)*Math.PI/180;
  for(const origin of [[-2340.174,-710.957,12],[2368.125,1088.75,3.4]] as const){
    const local=[eye[0]-origin[0],eye[1]-origin[1],eye[2]-origin[2]] as const;
    const center=streetShadowCenter(local,origin,yaw,44.1,57.512);
    for(const [axis,value] of [2280,1064,24].entries())expect(center[axis]+origin[axis]).toBeCloseTo(value,8);
  }
});

test("lighting follows the authored solar phase knots and roll",()=>{
  const settings=`
misc.Sun.Roll 122
misc.SunRise.StartHour 6
misc.SunRise.StartAngle 0.505 // first morning segment
misc.SunRise.EndHour 8
misc.SunRise.EndAngle 0.605
misc.SunSet.StartHour 18
misc.SunSet.StartAngle 1.4
misc.SunSet.EndHour 20
misc.SunSet.EndAngle 1.5
`;
  const environment=readStreetEnvironment([settings]);
  const afternoon=streetLighting(870,.35,environment).sunDirection;
  for(const [i,value] of [-.373231,-.491627,.786767].entries())
    expect(afternoon[i]).toBeCloseTo(value,6);
  expect(streetLighting(360,.35,environment).sunDirection[0]).toBeCloseTo(.999877,6);
  expect(streetLighting(1200,.35,environment).sunDirection[0]).toBeCloseTo(-1,6);
  expect(streetLighting(0,.35,environment).sunDirection).toEqual(streetLighting(1440,.35,environment).sunDirection);
  expect(readStreetEnvironment([settings.replace("EndHour 8","EndHour 5")])).toBeUndefined();
});

test("weather uses the authored global cloud layer and skips unplaced time keys",()=>{
  const scattering=Object.entries({karman_line:100,ray_density_scale:8,mie_density_scale:1.1973,mie_phase_eccentricity:.7798,
    ray_scattering_intensity:1,ray_scattering_col_r:.1598,ray_scattering_col_g:.3738,ray_scattering_col_b:.9131,
    mie_scattering_intensity:1,mie_scattering_col_r:.5767,mie_scattering_col_g:.5767,mie_scattering_col_b:.5767,
    mie_absorption_intensity:1,mie_absorption_col_r:.5767,mie_absorption_col_g:.5767,mie_absorption_col_b:.5767,
  }).map(([key,value])=>`<sky_new_${key}>${value} ${value}</sky_new_${key}>`).join("");
  const cycle=(name:string,cover:number,base:string)=>`<?xml version="1.0"?>
    <timecycle_keyframe_data><High_Level_Vars><cloud_cover>${cover}</cloud_cover>
    <cloud_Density>1</cloud_Density></High_Level_Vars><cycle name="${name}">
    <region name="GLOBAL"><sky_new_planet_radius>6360 6360</sky_new_planet_radius>${scattering}
    <local_atmosphere_cloud_height>${base}</local_atmosphere_cloud_height>
    <local_atmosphere_fog_density>.0001 .0005</local_atmosphere_fog_density>
    <local_atmosphere_fog_height>100 300</local_atmosphere_fog_height>
    <local_atmosphere_fog_falloff>400 600</local_atmosphere_fog_falloff>
    <ambient_sky_intensity>${cover===.2?".2 .6":".8 1.2"}</ambient_sky_intensity>
    <ambient_sky_color_mult_r>${cover===.2?".6 1":".4 .8"}</ambient_sky_color_mult_r>
    <ambient_sky_color_mult_g>.8 1</ambient_sky_color_mult_g>
    <ambient_sky_color_mult_b>1 1</ambient_sky_color_mult_b>
    <far_clip>${cover===.2?"7000 9000":"9000 10000"}</far_clip>
    <water_ocean_beaufort_scale>3 6</water_ocean_beaufort_scale>
    <water_ripple_speed_scale>1 2</water_ripple_speed_scale>
    <local_atmosphere_cloud_shadow_alpha>.2 .6</local_atmosphere_cloud_shadow_alpha>
    <enable_screen_space_shadow>1 1</enable_screen_space_shadow>
    <screen_space_shadow_raylength>1 1</screen_space_shadow_raylength>
    <screen_space_shadow_bias>.003 .003</screen_space_shadow_bias>
    <local_atmosphere_cloud_height_top>1500 1500</local_atmosphere_cloud_height_top></region>
    <region name="URBAN"><local_atmosphere_cloud_height>240 250</local_atmosphere_cloud_height>
    </region></cycle></timecycle_keyframe_data>`;
  const sparse=cycle("CLOUDSCAPE_SCATTERED_CLOUDS",.2,"200 200");
  const other=cycle("CLOUDSCAPE_THICKLAYER",.8,"400 400");
  const variable=cycle("CLOUDSCAPE_MIXED",.5,"100 200");
  const documents=[variable,sparse,other];
  const environment=readStreetEnvironment(documents);
  expect(environment?.clouds.map(layer=>layer.cover)).toEqual([.2,.8]);
  expect(streetLighting(840,.5,environment).cloudLayer).toEqual([.3,1.5,1,6360]);
  expect(streetLighting(840,.5,environment).contactShadow).toEqual([1,.003]);
  expect(streetLighting(840,.5,environment).ambientSkyGain).toEqual([1,1,1]);
  expect(streetLighting(840,.95,environment).cloudLayer).toEqual([.4,1.5,1,6360]);
  const clock=`<?xml version="1.0"?>
    <time_data><sample hour="0" interpolation_type="EASE_QUARTIC_INOUT"/><sample hour="12"/></time_data>`;
  const ramp="misc.Multiplier.heightStart 100\nmisc.Multiplier.heightEnd\t250.00\nmisc.Multiplier.farClipMultiplier\t2";
  const tint=`imposter.trees.gbuffDiffuseScaleRed 0.6
    imposter.trees.gbuffDiffuseScaleGreen 0.8
    imposter.trees.gbuffDiffuseScaleBlue 0.8
    imposter.trees.gbuffScaleStart 100
    imposter.trees.gbuffScaleRange 1000`;
  const weights=`imposter.trees.weightScaleStart 300
    imposter.trees.weightScaleEnd 2000
    imposter.trees.weightScaleMin 1
    imposter.trees.weightScaleMax 10`;
  const timed=readStreetEnvironment([clock,ramp,tint,weights,...documents]);
  expect(timed?.clouds.map(layer=>layer.cover)).toEqual([.2,.5,.8]);
  expect(streetLighting(180,.5,timed).cloudLayer[0]).toBeCloseTo(.103125,6);
  expect(streetLighting(1080,.5,timed).cloudLayer[0]).toBeCloseTo(.15,6);
  const fog=streetLighting(180,.5,timed).fogProfile;
  expect(fog[0]).toBeCloseTo(.0001125,8);
  expect(fog.slice(1)).toEqual([106.25,406.25]);
  const atmosphere=streetLighting(180,.5,timed).atmosphere;
  expect(atmosphere?.height).toBe(100);
  expect(atmosphere?.rayleigh[2]).toBeCloseTo(.0331,4);
  expect(atmosphere?.absorption[3]).toBe(.7798);
  const afternoon=streetLighting(1080,.5,timed);
  expect(afternoon.waveStrength).toBeCloseTo(.30+.70*Math.sqrt(4.5/3),6);
  expect(afternoon.rippleSpeed).toBe(1.5);
  expect(afternoon.cloudShadowAlpha).toBeCloseTo(.4,6);
  const ambient=streetLighting(1080,.35,timed).ambientSkyGain;
  expect(ambient[0]).toBeCloseTo(.49,6);
  expect(ambient[1]).toBeCloseTo(.63,6);
  expect(ambient[2]).toBeCloseTo(.7,6);
  const {farClip}=streetLighting(1080,.35,timed);
  expect(farClip).toBeCloseTo(8750,6);
  expect(streetProjectionFarPlane(farClip,50,timed?.farClipRamp)).toBeCloseTo(8750,6);
  expect(streetProjectionFarPlane(farClip,175,timed?.farClipRamp)).toBeCloseTo(13125,6);
  expect(streetProjectionFarPlane(farClip,350,timed?.farClipRamp)).toBeCloseTo(17500,6);
  expect(streetProjectionFarPlane(undefined,175,timed?.farClipRamp)).toBe(10000);
  expect(timed?.octaDiffuseTint).toEqual({rgb:[.6,.8,.8],start:100,range:1000});
  expect(timed?.octaViewWeights).toEqual([0.0005882352706976235,-0.1764705777168274,1,10]);
  expect(readStreetEnvironment([weights.replace("2000","300")])).toBeUndefined();
  expect(readStreetEnvironment([clock,tint.replace("1000","0"),...documents])?.octaDiffuseTint).toBeUndefined();
  const weather=`<?xml version="1.0"?>
    <WeatherTypes>
      <Item><Name>AM_Fog</Name><DataName>CLOUDSCAPE_SCATTERED_CLOUDS</DataName><ModWind>W_MOD_wind_other</ModWind></Item>
      <Item><Name>AM_Scattered_Clouds</Name><DataName>CLOUDSCAPE_SCATTERED_CLOUDS</DataName><ModWind>W_MOD_wind_mid</ModWind></Item>
    </WeatherTypes>
    <WeatherTypeDatas><Item><Name>CLOUDSCAPE_SCATTERED_CLOUDS</Name><WindAngle value="90.0" />
    <CloudMapA>cloudmap_test_a</CloudMapA><CloudMapB>cloudmap_test_b</CloudMapB></Item></WeatherTypeDatas>`;
  const wind=`<?xml version="1.0"?>
    <modifier
      name="W_MOD_wind_other">
      <wind_prevailing_speed_min_at_bottom_falloff_kmh>0</wind_prevailing_speed_min_at_bottom_falloff_kmh>
      <wind_prevailing_speed_max_at_bottom_falloff_kmh>0</wind_prevailing_speed_max_at_bottom_falloff_kmh>
      <wind_prevailing_speed_min_at_top_falloff_kmh>0</wind_prevailing_speed_min_at_top_falloff_kmh>
      <wind_prevailing_speed_max_at_top_falloff_kmh>0</wind_prevailing_speed_max_at_top_falloff_kmh>
      <wind_prevailing_speed_falloff_height_kmh>500</wind_prevailing_speed_falloff_height_kmh>
    </modifier>
    <modifier
      name="W_MOD_wind_mid">
      <wind_prevailing_speed_min_at_bottom_falloff_kmh>30</wind_prevailing_speed_min_at_bottom_falloff_kmh>
      <wind_prevailing_speed_max_at_bottom_falloff_kmh>42</wind_prevailing_speed_max_at_bottom_falloff_kmh>
      <wind_prevailing_speed_min_at_top_falloff_kmh>60</wind_prevailing_speed_min_at_top_falloff_kmh>
      <wind_prevailing_speed_max_at_top_falloff_kmh>84</wind_prevailing_speed_max_at_top_falloff_kmh>
      <wind_prevailing_speed_falloff_height_kmh>500</wind_prevailing_speed_falloff_height_kmh>
    </modifier>`;
  const shearCycle=sparse.replace("</region>",`<local_atmosphere_cloud_wind_shear>500 500</local_atmosphere_cloud_wind_shear></region>`);
  const sheared=streetLighting(840,.2,readStreetEnvironment([weather,shearCycle,wind])).cloudBlend;
  expect(sheared?.shear[0]).toBeCloseTo(.21875,6);
  expect(sheared?.shear[1]).toBeCloseTo(0,6);
});

test("the higher canopy ring can fill omitted nearby batches without redrawing them",()=>{
  const source:VegetationSource={system:[0x1100,0x100,0x1000],graphics:[],batches:[
    [0,75,0,10,0,250,120,0,140,15],
    [0,205,0,13,0,250,135,0,155,20],
    [0,405,0,3,1,250,145,0,155,15],
  ]};
  const model={name:"veg_tree_seagrape",hash:10,system:1,streams:[],bounds:[-3,-3,0,3,3,8] as Bounds};
  const retained=new Set([vegetationBatchId(source,source.batches[0])]);
  const candidates=distantCanopyCandidates([source],[0,0],[model],()=>true,retained);
  expect(candidates.map(candidate=>candidate.batch)).toEqual([source.batches[1]]);
});

test("visible canopy takes priority over a stronger off-screen batch",()=>{
  const source:VegetationSource={system:[0x1100,0x100,0x1000],graphics:[],batches:[
    [0,0,0,96,0,500,250,0,260,10],
    [0,1,0,1,0,500,260,30,270,40],
  ]};
  const model={name:"veg_tree_seagrape",hash:10,system:1,streams:[],bounds:[-3,-3,0,3,3,8] as Bounds};
  const onScreen=(bounds:Bounds)=>bounds[1]>=30;
  const coarse=distantCanopyCandidates([source],[0,0],[model],onScreen,new Set());
  const atlas=distantCanopyAtlasCandidates([source],[0,0],[model],onScreen,new Set());
  expect(coarse.map(({batch})=>batch[1])).toEqual([1,0]);
  expect(atlas.map(({batch})=>batch[1])).toEqual([1]);
});

test("a linked canopy fallback remains eligible inside the ordinary distant cutoff",()=>{
  const source:VegetationSource={system:[0x1100,0x100,0x1000],graphics:[],batches:[
    [0,1,0,6,0,500,64,0,80,10],
    [0,2,0,6,0,500,70,0,84,10],
  ]};
  const model={name:"veg_tree_palm",hash:10,system:1,streams:[],bounds:[-3,-3,0,3,3,8] as Bounds};
  const select=(retained:Set<string>)=>distantCanopyCandidates([source],[0,0],[model],()=>true,retained,
    (_,batch)=>batch[1]===1).map(({batch})=>batch[1]);
  expect(select(new Set())).toEqual([1]);
  expect(select(new Set([vegetationBatchId(source,source.batches[0])]))).toEqual([]);
});

test("narrow aerial canopy views keep separate visible stands inside a wide-view cell",()=>{
  const source:VegetationSource={system:[0x1100,0x100,0x1000],graphics:[],batches:[
    [0,1,0,30,0,500,275,10,285,20],
    [0,2,0,6,0,500,323,10,333,20],
  ]};
  const model={name:"veg_tree_palm",hash:1,system:1,streams:[],bounds:[-3,-3,0,3,3,8] as Bounds};
  const visible=()=>true;
  const select=(fov:number)=>distantCanopyAtlasCandidates([source],[0,0],[model],visible,new Set(),
    {fov,aspect:16/9,onScreen:visible}).map(({batch})=>batch[1]);
  expect(select(70)).toEqual([1]);
  expect(select(32.5)).toEqual([1,2]);
});

test("extra native canopy batches fill visible broadleaf coverage without duplicating palms or selected batches",()=>{
  const source:VegetationSource={system:[0x1100,0x100,0x1000],graphics:[],batches:[
    [0,1,0,24,0,500,130,0,150,10],
    [1,2,0,4,0,500,140,0,145,10],
    [1,3,0,6,0,500,150,-40,152,-30],
    [1,4,0,2,0,500,170,0,175,10],
  ]};
  const model={name:"veg_tree_seagrape",hash:10,system:1,streams:[],bounds:[-5,-5,0,5,5,8] as Bounds};
  const occupied=new Set([vegetationBatchId(source,source.batches[3])]);
  const selected=broadleafCanopyCandidates([source],[0,0],[{...model,name:"veg_tree_palm_royal"},model],
    bounds=>bounds[1]>=0,occupied);
  expect(selected.map(({batch})=>batch[1])).toEqual([2]);
});

test("indexed canopy coverage preserves authored ordinals after sampling and tile sorting",()=>{
  const ordinals=Uint16Array.of(140,2,139,200,9,290,393);
  const ranges=[{first:0,count:4},{first:5,count:2}];
  expect(uncoveredVegetationRanges(ranges,ordinals,new Set([139,140,9,312]))).toEqual([
    {first:1,count:1},{first:3,count:1},{first:5,count:2}
  ]);
  expect(uncoveredVegetationRanges(ranges,ordinals,new Set())).toEqual(ranges);
});

test("whole-batch canopy handoff requires identical affine transforms by ordinal",()=>{
  const first=[10,20,0,1,0,0,0,1,0,0,0,1,1,1,1,1];
  const second=[30,40,0,1,0,0,0,1,0,0,0,1,1,1,1,1];
  const a={affine:true as const,ids:["a","b"],ordinals:Uint16Array.of(0,1),poses:Float32Array.of(...first,...second)};
  const b={affine:true as const,ids:["b","a"],ordinals:Uint16Array.of(1,0),poses:Float32Array.of(...second,...first)};
  expect(sameVegetationAffinesByOrdinal(a,b,2)).toBe(true);
  expect(sameVegetationAffinesByOrdinal(a,{...b,ordinals:Uint16Array.of(1,1)},2)).toBe(false);
  b.poses[3]=2;
  expect(sameVegetationAffinesByOrdinal(a,b,2)).toBe(false);
});

test("distant broadleaf slots prefer denser authored stands within the same projected size",()=>{
  const source:VegetationSource={system:[0x1100,0x100,0x1000],graphics:[],batches:[
    [0,1,0,96,0,500,250,0,270,50],
    [0,2,0,190,0,500,250,0,270,50],
  ]};
  const model={name:"veg_tree_mangrove",hash:10,system:1,streams:[],bounds:[-4,-4,0,4,4,8] as Bounds};
  const selected=broadleafCanopyCandidates([source],[0,0],[model],()=>true,new Set(),1);
  expect(selected.map(({batch})=>batch[1])).toEqual([2]);
});

test("the canopy streams at ground level and refreshes on ascent without reloading terrain",()=>{
  const gl={getExtension:()=>null} as unknown as WebGL2RenderingContext;
  const updates:{canopy?:boolean;terrain?:boolean}[]=[];
  let regions=0,vegetation=0;
  const world=new StreetWorld(gl,[0,0,0],()=>regions++,()=>{},undefined,false,()=>vegetation++,
    view=>updates.push({canopy:view.distantCanopy,terrain:view.flightTerrain}));
  for(const z of [26,35,30,26,55])world.update(1,1,false,{eye:[1,1,z],yaw:0,pitch:0,aspect:16/9});
  expect(regions).toBe(2);
  expect(vegetation).toBe(4);
  expect(updates[0]).toEqual({canopy:true,terrain:false});
  expect(updates.at(-1)).toEqual({canopy:true,terrain:true});
});

test("stationary turns refresh the canopy at ground and flight altitudes",()=>{
  const gl={getExtension:()=>null} as unknown as WebGL2RenderingContext;
  let regions=0,vegetation=0;
  const world=new StreetWorld(gl,[0,0,0],()=>regions++,()=>{},undefined,false,()=>vegetation++);
  const look=(degrees:number,z:number)=>world.update(1,1,false,
    {eye:[1,1,z],yaw:degrees*Math.PI/180,pitch:0,aspect:16/9});
  for(const degrees of [350,0,10])look(degrees,55);
  expect(vegetation).toBe(1);
  for(const degrees of [25,28,29])look(degrees,55);
  expect(vegetation).toBe(2);
  expect(regions).toBe(1);
  for(const degrees of [25,145,270])look(degrees,10);
  expect(vegetation).toBe(5);
  expect(regions).toBe(2);
});

test("sector LODs stay out of the opaque street object pass",()=>{
  const row:IndexedPlacement={at:72,hash:20,range:[100,20,24],
    placement:{position:[0,0,3],rotation:[0,0,0,1],scale:[1,1]}};
  const model=(name:string)=>streetAsset({name,hash:row.hash,system:1,streams:[[100,20,24]]},row);
  expect(model("n01_w09_waterveg_slod2")).toBeUndefined();
  expect(model("n01_w09_n02_w10_waterveg_slod3")).toBeUndefined();
  expect(model("s01_e04_s02_e05_slod3")?.kind).toBe("skyline");
  expect(model("n01_w09_slod2")?.kind).toBe("skyline");
  expect(model("ma_cnw_02_slod")?.kind).toBe("skyline");
  expect(model("ma_cnw_06_structure_slod")?.kind).toBe("skyline");
  expect(model("ma_sqr_03_slod1b")?.kind).toBe("skyline");
  expect(model("bk_01_slod_b")?.kind).toBe("skyline");
  expect(model("ma_cnw_lod_01_02_03_05_06_slod3")?.kind).toBe("skyline");
  expect(model("ap_lod_02_02e_02f_slod2")?.kind).toBe("skyline");
  expect(model("ap_lod_slod3_1")?.kind).toBe("skyline");
  expect(model("tr_sby_bridge_n_02b_02")?.kind).toBe("road");
  expect(roadBridgeDrawable("ds_road_2_bridge_a")).toBeTrue();
  expect(bridgeDeckProxy("ds_road_2_bridge_a")).toBeFalse();
  expect(bridgeDeckProxy("ds_road_2_bridge_a_decal2_lod")).toBeFalse();
  expect(model("ma_cnw_lod_slod4")?.kind).toBe("skyline");
  const broad={hash:row.hash,system:1,streams:[[100,20,24]],bounds:[-160,-172,-70,160,173,72] as Bounds};
  expect(streetAsset({...broad,name:"dn_lod_s3"},row)?.kind).toBe("skyline");
  expect(streetAsset({...broad,name:"dn_lod_01_s3"},row)?.kind).toBe("skyline");
  expect(streetAsset({...broad,name:"dn_fw_03_block_f1_slod"},{...row,aggregate:true})?.aggregate).toBeTrue();
  expect(streetAsset({...broad,name:"dn_fw_03_block_f1_slod"},row)?.kind).toBeUndefined();
  expect(streetAsset({...broad,name:"n04_w08_slod2"},{...row,aggregate:true})?.aggregate).toBeUndefined();
  expect(streetAsset({...broad,name:"ma_cnw_06_quarry_lake_scum_03_slod"},{...row,aggregate:true})?.kind).toBeUndefined();
  expect(streetAsset({name:"ds_lod_s2_15c_18_bridgea",hash:row.hash,system:1,streams:[[100,20,24]],
    bounds:[-160,-172,-70,160,173,72]},row)?.kind).toBe("skyline");
  expect(streetAsset({name:"lo_int1_lod_s2_01_ec_monument",hash:row.hash,system:1,streams:[[100,20,24]],
    bounds:[-2,-2,-1,2,2,5]},row)?.kind).toBeUndefined();
  expect(model("ma_cnw_02_services1_fire_lod")?.id).toBe("native:64-48");
  expect(model("gi_proxy_fire_large")).toBeUndefined();
  expect(streetAsset({name:"gi_proxy_fire_large",hash:row.hash,system:1,streams:[[100,20,24]]},row,true,true)).toBeDefined();
  expect(model("canal_water_1")?.kind).toBe("water");
  expect(model("prop_am_crate_water_01a")?.kind).toBe("prop");
});

test("prefab bridge skyline keeps the authored placement range",()=>{
  const row:IndexedPlacement={at:72,hash:20,range:[100,20,24],
    placement:{position:[0,0,3],rotation:[0,0,0,1],scale:[1,1]},
    placementLod:{map:1,ordinal:0,level:2,children:1,distance:6500}};
  const mesh={hash:row.hash,system:1,streams:[[100,20,24]]};
  const bridge=streetAsset({...mesh,name:"prefab_am_bridge_06_slod"},row);
  expect(bridge?.kind).toBe("skyline");
  expect(bridge?.placementLod?.distance).toBe(6500);
  expect(streetAsset({...mesh,name:"prop_am_barrel_01"},row)?.placementLod).toBeUndefined();
});

test("matching drawable variants share a name and prefer the finest level",()=>{
  expect(authoredLodParent("district_landmark_slod_children_detail_a")).toBe("district_landmark_slod");
  expect(authoredLodParent("district_children_detail_a")).toBeUndefined();
  expect(clonedPrefabName("district_slod_children_am_e_arch_01_lod_cln")).toBe("prefab_am_arch_01");
  expect(clonedPrefabName("district_slod_d_children_am_arch_01_lod_cln")).toBe("prefab_am_arch_01");
  expect(clonedPrefabName("district_slod_children_am_arch_01_lod")).toBeUndefined();
  expect(bridgeDeckProxy("district_road_2_bridgewest_01_lod")).toBeTrue();
  expect(bridgeDeckProxy("tr_wky_road_oldbridge_02d_slod")).toBeTrue();
  expect(bridgeDeckProxy("tr_wky_road_oldbridge_02d_bolts_slod")).toBeFalse();
  expect(bridgeDeckProxy("district_road_cs_bridge_01_lod")).toBeTrue();
  expect(bridgeDeckProxy("district_road_2_bridgewest_01_decal_lod")).toBeFalse();
  expect(bridgeDeckProxy("district_road_cs_bridge_01_dtl_lod")).toBeFalse();
  expect(streetLodVariant("ground_metb")).toEqual({name:"ground_metb",rank:0});
  expect(streetLodVariant("ground_metb_lod").name).toBe("ground_metb");
  expect(streetLodVariant("ground_metb_lod").rank).toBeLessThan(streetLodVariant("ground_metb_slod2").rank);
  expect(streetLodVariant("ground_metb_dtl").name).toBe("ground_metb_dtl");
  expect(sameStreetLodPlacement([0,0,0],[13,5,2],[-35,-39,-13,35,39,13],[-34.8,-39,-13,35,39.1,13])).toBeTrue();
  expect(sameStreetLodPlacement([0,0,0],[13,5,2],[-35,-39,-13,35,39,13],[-23,-39,-13,48,39,13])).toBeFalse();
});

test("bridge LOD distance uses the three-dimensional bounds center and readiness margin",()=>{
  const bounds:[number,number,number,number,number,number]=[-20,-10,-2,20,10,2];
  expect(streetLodInRange(bounds,[359,0,0],339)).toBeTrue();
  expect(streetLodInRange(bounds,[360,0,0],339)).toBeFalse();
  expect(streetLodInRange(bounds,[350,0,90],339)).toBeFalse();
});

test("portable world index validates the archive and reads only the requested spatial cells",async()=>{
  const archive=new Blob([new Uint8Array(16384)]);
  const model={name:"test_building",hash:20,system:100,streams:[[100,20,24]]};
  const terrain={...model,name:"s02_w03_017a_hd",hash:21};
  const container={...model,name:"prop_am_container_02a",hash:22};
  const bridge={...model,name:"test_road_cs_bridge_01_lod",hash:23,bounds:[-20,-20,-2,20,20,5]};
  const cell=([x,y]:[number,number])=>gzipSync(new TextEncoder().encode(JSON.stringify({
    models:[model,terrain,container,bridge],vegetation:[],entities:[model,terrain,container,bridge].map(({hash},index)=>({
      hash:index===3?24:hash,model:index===3?3:undefined,at:72+index*144,range:[100,20,24],staged:index===2?true:undefined,
      placement:{position:[x,y,3],rotation:[0,0,0,1],scale:[1,1]}})),
  })));
  const near=cell([-5,5]),far=cell([1024,1024]);
  const manifest:IndexManifest={
    archive:{size:archive.size,fingerprint:await streetArchiveFingerprint(archive)},
    terrain:true,stagedMaps:true,total:1,maps:1,vegetation:0,models:4,placements:8,plants:[],
    shards:{"-1,0":[0,near.byteLength],"4,4":[near.byteLength,far.byteLength]},
  };
  const json=new TextEncoder().encode(JSON.stringify(manifest)),header=new Uint8Array(12);
  header.set(new TextEncoder().encode(indexBundleMagic));
  view(header).setUint32(8,json.byteLength,true);
  const reads:[number|undefined,number|undefined][]=[];
  class TrackedFile extends Blob{
    slice(start?:number,end?:number){
      reads.push([start,end]);
      return super.slice(start,end);
    }
  }
  const file=new TrackedFile([header,json,near,far]);
  const bundle=await StreetIndexBundle.open(file,archive);
  const offset=header.byteLength+json.byteLength;
  expect(reads).toEqual([[0,12],[12,offset]]);
  const rows=await bundle.buildings([-5,5],8,()=>true);
  expect(rows.map(row=>[row.name,row.hash])).toEqual([[model.name,model.hash],[bridge.name,24]]);
  expect(rows.every(row=>row.placement?.position.join()=== "-5,5,3")).toBeTrue();
  const withTerrain=await bundle.buildings([-5,5],8,()=>true,undefined,true);
  expect(withTerrain.map(row=>row.name)).toEqual([model.name,terrain.name,bridge.name]);
  expect(withTerrain.filter(row=>row.kind==="terrain").map(row=>row.name)).toEqual([terrain.name]);
  expect(reads.at(-1)).toEqual([offset,offset+near.byteLength]);
  await bundle.buildings([-6,5],8,()=>true);
  expect((await bundle.proxies("bridge",[-5,5],8,()=>true)).map(row=>row.name)).toEqual([bridge.name]);
  expect(await bundle.proxies("skyline",[-5,5],8,()=>true)).toEqual([]);
  expect(await bundle.proxies("bridge",[1024,1024],8,()=>false)).toEqual([]);
  expect(reads).toHaveLength(3);
  await expect(StreetIndexBundle.open(file,new Blob([new Uint8Array(archive.size).fill(1)])))
    .rejects.toThrow("different archive");
});

test("a named prop batch LOD can supply the base placement's drawable",()=>{
  const name="prefab_am_rubble_demo_batchlod",hash=joaat("prefab_am_rubble_demo");
  const model={name,hash:joaat(name),system:1,streams:[[100,20,24]],bounds:[-1,-1,0,1,1,.2] as Bounds};
  const lods=new Map<number,typeof model>();
  expect(indexStreetPropLod(lods,model)).toBe(hash);
  const row:IndexedPlacement={at:20,hash,range:[100,20,24],placement:{position:[1,2,3],rotation:[0,0,0,1],scale:[1,1]}};
  expect(streetAsset(lods.get(hash),row)?.name).toBe(name);
  expect(streetAsset(lods.get(hash),row)?.kind).toBe("prop");
  expect(streetAsset(lods.get(hash),row)?.placement?.position).toEqual([1,2,3]);
  expect(indexStreetPropLod(lods,{...model,name:"unrelated_structure_batchlod"})).toBeUndefined();
});

test("rectangular terrain weights use the original BC1 page layout",async()=>{
  const pageSize=65536,width=512,height=2048;
  const samples=[0xf800,0x07e0,0x001f,0xffff,0,0x07ff,0xf81f,0xffe0];
  const raw=new Uint8Array(pageSize*samples.length);
  const words=view(raw);
  for(const [page,color] of samples.entries())
    for(let offset=page*pageSize;offset<(page+1)*pageSize;offset+=8)words.setUint16(offset,color,true);
  const texture:Texture={id:"weights",pack:"fixture",index:0,descriptorOffset:0,
    width,height,mode:0x239,start:0,end:1,mipCount:1,tileMode:0};
  const pack:Pack={source:new Archive("fixture",new Blob([raw])),descriptors:[texture],
    offsets:[0,raw.byteLength],addresses:[0],eofAddress:raw.byteLength,codecs:new Uint8Array(1),padding:new Uint16Array(1)};
  const image=await readTerrainLayerInput(pack,texture,"weights");
  expect([image?.width,image?.height]).toEqual([width,height]);
  const sample=(page:number)=>Array.from(image!.rgba.subarray(page*256*width*4,page*256*width*4+4));
  expect(sample(0)).toEqual([255,0,0,255]);
  expect(sample(1)).toEqual([0,255,0,255]);
  expect(sample(7)).toEqual([255,255,0,255]);
  expect(await readTerrainLayerInput(pack,{...texture,tileMode:2},"weights")).toBeNull();
});

test("1024-square RGBA terrain heights use the standalone 256-square mip",async()=>{
  const offsets=[0,131072,393216,1441792,5636096];
  const raw=new Uint8Array(offsets.at(-1)!);
  for(let tile=0;tile<4;tile++)
    raw.fill(20+tile,offsets[1]+tile*65536,offsets[1]+(tile+1)*65536);
  const texture:Texture={id:"height",pack:"fixture",index:0,descriptorOffset:0,
    width:1024,height:1024,mode:0xe3,start:0,end:4,mipCount:7,tileMode:0};
  const pack:Pack={source:new Archive("fixture",new Blob([raw])),descriptors:[texture],
    offsets,addresses:offsets.slice(0,-1),eofAddress:raw.byteLength,codecs:new Uint8Array(4),padding:new Uint16Array(4)};
  const image=await readTerrainLayerInput(pack,texture,"height");
  expect([image?.width,image?.height]).toEqual([256,256]);
  expect([0,128,128*256,128*257].map(pixel=>image?.rgba[pixel*4])).toEqual([20,21,22,23]);
  expect(await readTerrainLayerInput({...pack,eofAddress:raw.byteLength-4},texture,"height")).toBeNull();
});

test("first-person positions round-trip with heading, pitch, and optional vertical FOV",()=>{
  const pose={position:[-2053,604.125,2.2] as [number,number,number],heading:58,pitch:-7.25};
  expect(parseStreetDestination(formatStreetDestination(pose))).toEqual(pose);
  const down={...pose,pitch:-90};
  expect(parseStreetDestination(formatStreetDestination(down))).toEqual(down);
  expect(parseStreetDestination("X −2053.0 · Y 604.1 · Z 2.2 · 68 visible chunks\nHeading 058° NE\nPitch -7.25°"))
    .toEqual({...pose,position:[-2053,604.1,2.2]});
  expect(parseStreetDestination("-2053 604.1 2.2")?.heading).toBeUndefined();
  expect(parseStreetDestination("-2053, 604.1, 2.2, 58")?.pitch).toBeUndefined();
  expect(parseStreetDestination("-2053, 604.1, 2.2, 58, 91")).toBeNull();
  const zoomed={...pose,fov:37.74};
  expect(parseStreetDestination(formatStreetDestination(zoomed))).toEqual(zoomed);
  expect(parseStreetDestination(formatStreetDestination({...pose,fov:defaultStreetFov}))?.fov)
    .toBeCloseTo(defaultStreetFov,3);
  expect(parseStreetDestination("-2053, 604.1, 2.2, 58, -7.25, 10")).toBeNull();
});

test("walk placement picks the front surface and resolves the matching gameplay floor",()=>{
  const triangle=(z:number)=>[0,0,z,0,4,0,z,0,0,4,z,0];
  const vertices=new Float32Array([...triangle(0),...triangle(2)]);
  const tags=new Uint8Array(vertices.buffer);
  for(let i=0;i<6;i++)tags[i*16+15]=i<3?0:3;
  const bounds:Bounds=[0,0,0,4,4,2];
  const chunk={first:0,count:6,bounds};
  const scene={parts:2,vertices:vertices.buffer,indices:Uint32Array.of(0,1,2,3,4,5),tiles:[{...chunk,chunks:[chunk]}]};
  expect(pickWalkSurface(scene,{origin:[0,0,4],direction:[.5,.5,-1],minimum:0}))
    .toEqual({point:[1,1,2],walkable:true,water:false,structure:false});
  const lower={...scene,indices:Uint32Array.of(0,1,2),tiles:[{...chunk,count:3,chunks:[{...chunk,count:3}]}]};
  expect(pickWalkSurface(lower,{origin:[1,1,4],direction:[0,0,-1],minimum:0})?.water).toBe(true);
  const floor=(height:number):StreetChunk=>({kind:"terrain",id:String(height),origin:[10,20,height],
    vertices:Float32Array.from(triangle(0)),indices:Uint32Array.of(0,1,2),bounds:[0,0,0,4,4,0]});
  expect(walkFloor([floor(5),floor(12)],11,21,5.4)).toBe(5);
  expect(walkFloor([floor(5),floor(12)],11,21)).toBe(12);
  expect(walkFloor([floor(5)],8,21)).toBeUndefined();
  expect(walkFloor([{...floor(12),visualOnly:true},floor(5)],11,21)).toBe(5);
});

test("vegetation uses authored bounds and reads an instance crossing graphics pages",async()=>{
  const system=new Uint8Array(0x340),data=view(system),at=0x60,hash=0x10203040;
  system.set([0x30,0x44,0x52,0x50,0x7a],0x10);
  data.setBigUint64(0x38,0x50000300n,true);
  data.setUint16(0x4c,2,true);
  data.setUint32(0x300,0x7c475b5d,true);
  data.setUint32(0x304,416,true);
  data.setBigUint64(0x308,BigInt(0x50000000+at),true);
  data.setUint32(0x310,0xed86f522,true);
  data.setUint32(0x314,16,true);
  data.setBigUint64(0x318,0x60000002n,true);
  data.setUint32(at+0x44,hash,true);
  data.setBigUint64(at+0x178,2n,true);
  data.setUint16(at+0x180,1,true);
  for(const [axis,lo,hi] of [[0,64,66],[1,32,34],[2,2,4]]){
    data.setFloat32(at+0x80+axis*4,lo,true);
    data.setFloat32(at+0x90+axis*4,hi,true);
  }
  data.setFloat32(at+0xa0,1,true);data.setFloat32(at+0xa4,1,true);
  data.setFloat32(at+0xb8,20,true);
  data.setFloat32(at+0xbc,40,true);
  const graphics=new Uint8Array(18);
  view(graphics).setUint16(2,65535,true);
  graphics.set([128,128],8);
  graphics.set([92,72,48],10);
  graphics[15]=90; // Heading bin 18 after wrapping the packed byte.
  const compressed=zlibSync(system);
  const locator:VegetationLocator={system:[0,compressed.length,system.length],
    graphics:[[compressed.length,8,8,1],[compressed.length+8,10,10,1]],
    grass:[64,32,66,34]};
  const archive=new Archive("fixture",new Blob([compressed,graphics]));
  expect(nearbyVegetationSources([locator],[300,300])).toEqual([]);
  const storage=await readVegetationSource(archive,locator);
  const source={...locator,batches:scanVegetation(storage.data,new Map([[hash,0]])).batches};
  expect(source.batches).toEqual([[0,at,2,1,1,20,64,32,66,34,40,20,undefined,[2,4]]]);
  expect(scanVegetation(storage.data,new Map([[hash,0]]),[at]).batches).toEqual([]);
  expect(vegetationCandidates([source],[300,300])).toEqual([]);
  const [near]=vegetationCandidates([source],[62,31]);
  expect(near.drawRadius).toBe(30);
  const mesh=await placeVegetation({id:"fixture",kind:"foliage",packedVegetationTint:true,origin:[0,0,0],bounds:[0,0,0,1,1,1],
    vertices:new Float32Array(),indices:new Uint32Array()}, {name:"fixture",hash,system:1,streams:[]},
    near.batch,storage,"vegetation:test",near.drawRadius);
  expect(mesh.origin).toEqual([64,32,0]);
  expect([...mesh.instances!.poses.slice(0,3)]).toEqual([2,0,2]);
  const basis=mesh.instances!.poses.slice(3,12);
  expect(basis[1]).toBeCloseTo(-1,4);
  expect(basis[3]).toBeCloseTo(1,4);
  expect(basis[2]).toBeCloseTo(1/255,6);
  expect(basis[5]).toBeCloseTo(1/255,6);
  expect(basis[6]).toBeCloseTo(-1/255,6);
  expect(basis[7]).toBeCloseTo(1/255,6);
  expect([...mesh.instances!.poses.slice(12)]).toEqual([92/255,72/255,48/255,2].map(Math.fround));
  expect(mesh.instances!.tiles?.[0].count).toBe(1);
  expect(mesh.vegetationFadeStart).toBe(10);
  const layout=vegetationInstanceLayout(near.batch,storage.data,hash);
  const before=archive.bytesRead;
  const nativeStorage=readVegetationGraphics(archive,locator,new Map([[at,layout]]));
  const {data:instances,...params}=await readVegetationBatch(near.batch,nativeStorage,hash);
  expect(params).toEqual(layout);
  expect(new Uint8Array(instances.buffer,instances.byteOffset,instances.byteLength)).toEqual(graphics.slice(2));
  expect(archive.bytesRead-before).toBe(0);
  const missing=readVegetationGraphics(archive,locator,new Map());
  await expect(readVegetationBatch(near.batch,missing,hash)).rejects.toThrow("Invalid vegetation batch");
});

test("packed tree tags resolve authored keys and coverage matches only the same plant nearby",()=>{
  const base=0x40,stride=0x68;
  const bytes=new Uint8Array(base+4*stride),data=view(bytes);
  data.setUint32(0,0x5053494e);
  data.setUint32(8,0xed26378b,true);
  data.setUint32(12,16,true);
  data.setUint32(24,0xe68c3ae7,true);
  data.setUint32(28,4*stride,true);
  data.setBigUint64(0x30,2n,true);
  data.setUint16(0x38,4,true);
  data.setUint16(0x3a,4,true);
  for(const [i,tag,key] of [[0,12,1n],[1,12,1n],[2,19,2n],[3,19,3n]] as const){
    data.setUint32(base+i*stride+0x38,tag,true);
    data.setBigUint64(base+i*stride+0x10,key,true);
  }
  for(const offset of [base,base+stride]){
    data.setFloat32(offset+0x3c,.2,true);
    data.setFloat32(offset+0x40,.75,true);
  }
  expect([...readImposterTreeTags(bytes)]).toEqual([[12,1n]]);
  expect([...readImposterTreeRegistry(bytes).coverage]).toEqual([[1n,[Math.fround(.2),.75]]]);
  data.setFloat32(base+stride+0x40,.5,true);
  expect(readImposterTreeRegistry(bytes).coverage.has(1n)).toBe(false);
  expect(()=>readImposterTreeTags(bytes.subarray(0,-1))).toThrow();
  const cover=packedImpostorCoverage([{model:1n,positions:new Float32Array([.249,20,6,130,20,6]),radius:125}]);
  expect(cover(1n,.266,20,6,.035)).toBe(125);
  expect(cover(2n,.266,20,6,.035)).toBe(0);
  expect(cover(1n,.266,20,7,.035)).toBe(0);
  expect(cover(1n,130,20,6,.035)).toBe(125);
});

test("packed canopy preserves the octahedral up axis and independent vertical scale",()=>{
  const basis=packedImpostorBasis(118,108,9,1.2490188935,2);
  expect([basis[2],basis[5],basis[8]].map(value=>Number((value/2).toFixed(5))))
    .toEqual([-.09419,-.19334,.9766]);
  expect(Math.hypot(basis[0],basis[3],basis[6])).toBeCloseTo(1.2490188935,7);
  expect(Math.hypot(basis[2],basis[5],basis[8])).toBeCloseTo(2,7);
  expect(packedImpostorBasis(118,108,81,1.2490188935,2)).toEqual(basis);
  expect(packedImpostorBasis(255,255,9,1,1)[8]).toBe(-1);
});

test("packed canopy rejects out-of-range placement pages before decoding them",()=>{
  const batch:VegetationBatch=[0,0,0,1,1,500,164,-2,180,2,100,undefined,1n,[10,14]];
  expect(packedImpostorBatchInRange(batch,[0,0,10])).toBe(true);
  expect(packedImpostorBatchInRange(batch,[0,0,9])).toBe(false);
  expect(packedImpostorBatchInRange(batch,[-1,0,10])).toBe(false);
});

test("packed SLOD model banks expose the per-tag distance bands",()=>{
  const header=0x40,offset=0x20,tag=409,stride=0x40,bankSize=0x400*stride;
  const bytes=new Uint8Array(header+offset+bankSize),data=view(bytes);
  data.setUint32(0,0x5053494e);
  data.setUint32(8,0x8b910459,true);
  data.setUint32(12,offset,true);
  data.setUint32(24,0x488b4199,true);
  data.setUint32(28,bankSize,true);
  const row=header+offset+tag*stride;
  for(const [at,value] of [[0,-1],[4,1.5],[8,10],[0x10,550],[0x14,6099]])
    data.setFloat32(row+at,value,true);
  expect([...readPackedSlodModels(bytes)]).toEqual([[tag,{center:[-1,1.5,10],minimum:550,maximum:6099}]]);
  expect(()=>readPackedSlodModels(bytes.subarray(0,-1))).toThrow();
});

test("packed drawable fallback keeps the instance band and fits the replacement mesh",async()=>{
  const at=0x60,table=new DataView(new ArrayBuffer(0x210)),key=1n,tag=42;
  table.setBigUint64(at+0x20,key,true);
  table.setBigUint64(0x38,0x50000200n,true);
  table.setUint16(0x4c,1,true);
  table.setUint32(0x200,0xed86f522,true);
  table.setUint32(0x204,16,true);
  table.setBigUint64(0x208,0x60000000n,true);
  table.setBigUint64(at+0x178,1n,true);
  table.setUint16(at+0x180,1,true);
  for(const field of [0x80,0x90])table.setFloat32(at+field,150,true);
  table.setFloat32(at+0xa0,1,true);
  table.setFloat32(at+0xa4,1,true);
  const pose=new DataView(new ArrayBuffer(16));
  pose.setUint8(6,128);pose.setUint8(7,128);pose.setUint16(14,tag,true);
  const packedView=(farPlane?:number)=>packedImpostorView({eye:[0,0,0],yaw:0,pitch:0,aspect:16/9,fov:70,farPlane},
    new Map([[tag,key]]),new Map([[key,{textures:[1n,2n,3n],center:[0,0,0],radius:1,axis:0}]]),
    new Map([[tag,{center:[0,0,0],minimum:100,maximum:11500}]]),()=>0);
  const packed=packedView(),narrow=packedView(7000);
  const initial:VegetationBatch=[0,at,0,1,1,500,150,0,150,0,500,undefined,key];
  packed.append(initial,await readVegetationBatch(initial,{data:table,pages:new Map(),instances:async()=>pose},0));
  const mesh=packed.mesh(tag,{id:"fixture",kind:"foliage",origin:[0,0,0],bounds:[-1,-2,0,5,3,8],
    vertices:new Float32Array(),indices:new Uint16Array()},"fallback",true);
  expect(mesh.instances?.poses.slice(12)).toEqual(new Float32Array([500,0,75,11500]));
  expect(mesh.bounds[5]).toBeGreaterThan(7.9);
  expect(mesh.instances?.tiles?.[0].bounds).toEqual(mesh.bounds);
  for(const x of [7400,10500,-7400,12000]){
    for(const field of [0x80,0x90]){
      table.setFloat32(at+field,x,true);
      table.setFloat32(at+field+4,1500,true);
    }
    const batch:VegetationBatch=[0,at,0,1,1,12000,x,1500,x,1500,12000,undefined,key];
    const storage={data:table,pages:new Map(),instances:async()=>pose};
    const decoded=await readVegetationBatch(batch,storage,0);
    packed.append(batch,decoded);
    narrow.append(batch,decoded);
  }
  const wide=packed.mesh(tag,mesh,"wide");
  expect(wide.instances?.poses).toHaveLength(4*16);
  expect(wide.instances?.ids).toBeUndefined();
  expect(wide.instances?.poses.slice(16,18)).toEqual(new Float32Array([7400,1500]));
  expect(wide.instances?.poses[28]).toBe(12000);
  const reserve=narrow.mesh(tag,mesh,"reserve");
  expect(reserve.instances?.poses).toEqual(wide.instances?.poses.slice(16));
  const camera={eye:[0,0,0] as const,yaw:0,pitch:0,aspect:16/9,fov:70};
  const tiles=reserve.instances?.tiles??[];
  expect(tiles.filter(tile=>streetFrustum(camera,1,7000)(tile.bounds,12000))).toHaveLength(0);
  expect(tiles.filter(tile=>streetFrustum({...camera,yaw:Math.PI},1,10000)(tile.bounds,12000))).toHaveLength(1);
  // Read-ahead begins at the padded lower limit on the CPU as well.
  for(const field of [0x80,0x90]){
    table.setFloat32(at+field,20,true);
    table.setFloat32(at+field+4,0,true);
  }
  const reserved=packedView();
  const beforeBand:VegetationBatch=[0,at,0,1,1,500,20,0,20,0,500,undefined,key];
  reserved.append(beforeBand,await readVegetationBatch(beforeBand,{data:table,pages:new Map(),instances:async()=>pose},0));
  expect(reserved.models()).toEqual([{tag,key}]);
});

test("native packed grass and shrubs use authored bounds and bypass the near grass budget",()=>{
  const source:VegetationSource={system:[0,1,1],graphics:[],batches:[
    [0,32,0,100,1,170,100,0,110,10,200,170,1n,[68,71]],
    [1,64,0,100,1,170,100,0,110,10,200,170,2n,[68,71]],
    [0,96,0,100,1,70,100,0,110,10,80,70,1n,[68,71]],
    [1,128,0,100,1,170,100,0,110,10,200,170,undefined,[68,71]],
  ]};
  const shrub={name:"veg_bush_example",hash:1,system:1,streams:[],bounds:[-1,-1,0,1,1,2] as const};
  const models=[{...shrub,bounds:[...shrub.bounds] as Bounds},{...shrub,name:"veg_grass_example",bounds:[...shrub.bounds] as Bounds}];
  const select=(occupied=new Set<string>())=>nativePackedPlantCandidates([source],[0,0],models,
    bounds=>bounds[2]>=66,occupied);
  expect(select().map(row=>[row.batch[1],row.drawRadius])).toEqual([[32,200],[64,200]]);
  expect(select(new Set([vegetationBatchId(source,source.batches[0])])).map(row=>row.batch[1])).toEqual([64]);
  const stand:VegetationSource={...source,batches:Array.from({length:24},(_,i)=>[
    1,32*i,0,512,1,170,100,0,110,10,200,170,2n,[68,71]
  ])};
  expect(vegetationCandidates([stand],[0,0])).toHaveLength(24);
});

test("keyed woody batches use the truncated authored start and 20 m outer fade",()=>{
  const source:VegetationSource={system:[0,1,1],graphics:[],batches:[
    [0,32,0,8,0,520,390,0,405,10,500.75,undefined,1n,[0,10]],
    [0,64,0,8,0,520,390,0,405,10,500,undefined,undefined,[0,10]],
  ]};
  expect(vegetationCandidates([source],[0,0]).map(row=>[row.batch[1],row.drawRadius])).toEqual([[32,520]]);
  const stand:VegetationSource={...source,batches:Array.from({length:36},(_,index)=>{
    const batch:VegetationBatch=[...source.batches[0]];
    batch[1]=32*(index+1);
    return batch;
  })};
  expect(vegetationCandidates([stand],[0,0])).toHaveLength(36);
});

test("keyed woody batches preserve valid pivots outside the geometry box",async ()=>{
  const data=new DataView(new ArrayBuffer(0x210)),at=0x50,key=0x1234n;
  data.setBigUint64(0x38,0x50000200n,true);
  data.setUint16(0x4c,1,true);
  data.setUint32(0x200,0xea6b3a96,true);
  data.setUint32(0x204,128,true);
  data.setBigUint64(0x208,0x60000000n,true);
  data.setBigUint64(at+0x20,key,true);
  data.setBigUint64(at+0x90,1n,true);
  data.setUint16(at+0x98,2,true);
  data.setFloat32(at+0xa8,1,true);
  for(const axis of [0,4,8])data.setFloat32(at+0xb0+axis,2,true);
  const transforms=new DataView(new ArrayBuffer(128));
  for(const offset of [0,64]){
    for(const axis of [0,20,40])transforms.setFloat32(offset+axis,1,true);
    transforms.setFloat32(offset+44,offset?Infinity:.95,true);
  }
  const mesh=await placeVegetation({id:"fixture",kind:"foliage",origin:[0,0,0],bounds:[0,0,.05,1,1,1],
    vertices:new Float32Array(),indices:new Uint32Array()},
    {name:"fixture",hash:0,system:1,streams:[]},[0,at,0,2,0,300,0,0,2,2,300,undefined,key,[1,2]],
    {data,pages:new Map(),instances:async()=>transforms},"vegetation:test",300,2);
  expect(mesh.instances?.ids).toEqual(["vegetation:test:0"]);
  expect(mesh.instances?.poses[2]).toBeCloseTo(.95);
  expect(mesh.vegetationFadeStart).toBe(280);
  expect(mesh.vegetationLinearFade).toBe(true);
});

test("placement LOD links preserve authored slots across mixed reference classes",()=>{
  const data=new DataView(new ArrayBuffer(0x600)),word=(at:number,n:number)=>data.setUint32(at,n,true);
  const half=(at:number,n:number)=>data.setUint16(at,n,true),ref=(at:number,n:bigint)=>data.setBigUint64(at,n,true);
  const ptr=(at:number,n:number)=>word(at,0x50000000+n);
  word(0x10,0x50524430);data.setUint8(0x14,0x7a);
  word(0x20,1);ptr(0x28,0x50);ptr(0x38,0x90);half(0x48,2);half(0x4c,4);
  const mapType=0xd3593fa6,entityType=0xce501483;
  const schema=(at:number,type:number,size:number,start:number,members:number[][])=>{
    word(at,type);ptr(at+0x10,start);word(at+0x18,size);half(at+0x1e,members.length);
    for(const [i,[hash,offset,kind]] of members.entries()){
      word(start+16*i,hash);word(start+16*i+4,offset);data.setUint8(start+16*i+8,kind);
    }
  };
  schema(0x50,mapType,0xc0,0x500,[[0xe6e17f14,8,0x4a],[0xccab9307,0x40,0x52],[0x75d16adf,0x58,0x52],
    [0xdd22821f,0x90,0x33],[0xa22ea335,0xa0,0x33]]);
  schema(0x70,entityType,0x90,0x400,[[0xa023a02c,0x44,0x4a],[0x01166164,0x38,0x49],[0x77dd4010,0x10,0x49],
    [0x9ca32637,0x54,0x21],[0x10fb7c42,0x58,0x21],[0xd89231bd,0x5c,0x12],[0xe74c3c23,0x5e,0x12],[0x84799847,0x7f,0x10],
    [0x6c8f1715,0x7e,0x60],[0xa687ac89,0x68,0x15],[0x3c852527,0x70,0x15],
    [0x0dc5f270,0x80,0x11],[0x540ca436,0x81,0x11]]);
  for(const [i,[type,size,at]] of [[mapType,0xc0,0x180],[entityType,0x120,0x260],[7,32,0x380],[0x4a,8,0x3c0]].entries()){
    word(0x90+16*i,type);word(0x94+16*i,size);ptr(0x98+16*i,at);
  }
  word(0x188,11);ref(0x1c0,3n);half(0x1c8,3);half(0x1ca,4);
  ref(0x1d8,4n);half(0x1e0,2);half(0x1e2,2);
  for(let axis=0;axis<3;axis++){
    data.setFloat32(0x210+4*axis,-12+axis,true);
    data.setFloat32(0x220+4*axis,4+axis,true);
  }
  expect(placementLayout(data,undefined,false).streamingBounds).toEqual([-12,-11,-10,4,5,6]);
  data.setFloat32(0x220,-20,true);
  expect(placementLayout(data,undefined,false).streamingBounds).toBeUndefined();
  ref(0x380,2n);ref(0x388,1n);ref(0x390,(0x90n<<20n)|2n);
  word(0x3c0,22);word(0x3c4,33);
  half(0x260+0x5c,5);half(0x260+0x5e,65535);data.setInt8(0x260+0x7f,1);
  half(0x2f0+0x5c,6);half(0x2f0+0x5e,65535);data.setInt8(0x2f0+0x7f,0);
  data.setFloat32(0x260+0x60,-1,true);data.setFloat32(0x2f0+0x60,339,true);
  data.setUint8(0x2f0+0x7e,1);word(0x2f0+0x68,2);
  for(const row of [0x260,0x2f0]){
    data.setFloat32(row+0x1c,1,true);
    data.setFloat32(row+0x54,1,true);data.setFloat32(row+0x58,1,true);
  }
  word(0x2f0+0x70,0xfeed0090);
  data.setUint8(0x2f0+0x80,129);data.setUint8(0x2f0+0x81,255);
  expect(decodeIndexedPlacements(data,[[0,0x600,0x600]]).map(({placement})=>
    [placement.tintSelector,placement.propLayerControl,placement.propDirtControl])).toEqual([[0,0,0],[16,129,255]]);
  expect([...placementLayout(data).links.values()]).toEqual([
    {map:11,ordinal:0,parent:[33,5]},{map:11,ordinal:2,parent:[22,6]},
  ]);
  expect([...placementLayout(data).lodLinks.values()]).toEqual([
    {map:11,ordinal:0,parent:[33,5],level:0,children:0},
    {map:11,ordinal:2,parent:[22,6],level:1,children:2,distance:339},
  ]);
  half(0x260+0x5e,1);
  expect([...placementLayout(data).lodLinks.keys()]).toEqual([0x2f0+0x44]);
  half(0x260+0x5e,65535);
  ref(0x398,2n);half(0x1c8,4);
  expect([...placementLayout(data).links.values()]).toEqual([{map:11,ordinal:2,parent:[22,6]}]);
});

test("vegetation locators preserve large offsets and signed footprints without a batch catalog",()=>{
  const start=0x18000b010;
  const locator:VegetationLocator={system:[start,500,1920],graphics:[[start+512,64,64,1]],
    grass:[-2321,761,-2290,780],excluded:[96]};
  expect(decodeVegetationLocators(encodeVegetationLocators([locator]))).toEqual([locator]);
});

test("the local archive scanner validates stream boundaries and discovers drawable names",async()=>{
  const metadata=new Uint8Array(96);
  view(metadata).setBigUint64(8,0x50000040n,true);
  metadata.set(new TextEncoder().encode("veg_grass_fixture.#dr\0"),0x40);
  const encoded=zlibSync(metadata),graphics=zlibSync(new Uint8Array(48).fill(31));
  const offset=4096+16,next=Math.ceil((offset+encoded.length)/16)*16;
  const bytes=new Uint8Array(next+graphics.length);
  bytes.set(encoded,offset);bytes.set(graphics,next);
  const stream=readCarvedZlib(bytes.subarray(offset));
  expect(stream?.stored).toBe(encoded.length);
  expect(stream?.bytes).toEqual(metadata);
  bytes[offset+encoded.length-1]^=1;
  expect(readCarvedZlib(bytes.subarray(offset))).toBeUndefined();
  bytes.set(encoded,offset);
  const segment=await scanStreetSegment(new Archive("fixture",new Blob([bytes])),0,()=>true);
  expect(segment.models).toMatchObject([{name:"veg_grass_fixture",system:1,streams:[[offset,encoded.length,metadata.length]]}]);
});

test("a typed RPF9 drawable root supplies its name without a preceding NUL",async()=>{
  const metadata=new Uint8Array(0x150),data=view(metadata);
  data.setBigUint64(8,0x500000b0n,true);
  data.setBigUint64(0x10,0x500000c0n,true);
  data.setBigUint64(0x50,0x500000e0n,true);
  data.setBigUint64(0xa8,0x50000110n,true);
  for(const at of [0x3c,0x40,0x44])data.setFloat32(at,1,true);
  metadata[0x10f]=0x26;
  metadata.set(new TextEncoder().encode("prefab_fixture.#dr\0"),0x110);
  const offset=4112,encoded=zlibSync(metadata),end=Math.ceil((offset+encoded.length)/16)*16;
  const archiveBytes=new Uint8Array(end);
  archiveBytes.set(encoded,offset);
  const segment=await scanStreetSegment(new Archive("fixture",new Blob([archiveBytes])),0,()=>true,"full",
    [{type:2,offset,end,chunks:[end-offset]}]);
  expect(segment.models).toMatchObject([{name:"prefab_fixture",hash:joaat("prefab_fixture"),drawable:0,assetType:2,verified:true}]);
});

test("drawable lookup needs the authored placement key or an unambiguous typed alias",()=>{
  expect(drawableNameKey("foo")).toBe("e271865701f54561");
  const name="fixture_wall",hash=joaat(name),alias=joaat("alternate_wall");
  const model={name,hash,system:1,streams:[[4112,64,128]],assetType:1 as const,
    verified:true as const,keyedOnly:true as const};
  const row:IndexedPlacement={hash,at:0,placement:{position:[0,0,0],rotation:[0,0,0,1],scale:[1,1]},range:[8192,64,256]};
  const variants=new PlacementDrawables();
  variants.add(model);
  expect(variants.resolve(row)).toBeUndefined();
  expect(variants.resolve({...row,key:drawableNameKey(name)})).toBe(model);
  expect(variants.resolve({...row,key:drawableNameKey("wrong_wall")})).toBeUndefined();
  variants.addAlias({hash:alias,asset:hash,kind:1});
  expect(variants.resolve({...row,hash:alias})).toBe(model);
  variants.addAlias({hash:alias,asset:hash,kind:2});
  expect(variants.resolve({...row,hash:alias})).toBeUndefined();
  variants.add({...model,streams:[[12304,64,128]]});
  expect(variants.resolve({...row,key:drawableNameKey(name)})).toBeUndefined();
});

test("drawable aliases come from the typed CMapTypes schema",()=>{
  const data=new DataView(new ArrayBuffer(0x180));
  const word=(at:number,n:number)=>data.setUint32(at,n,true);
  const ptr=(at:number,n:number)=>word(at,0x50000000+n);
  word(0x20,1);ptr(0x28,0x50);ptr(0x38,0x70);
  data.setUint16(0x48,1,true);data.setUint16(0x4c,2,true);
  word(0x50,0x82d6fc83);ptr(0x60,0x90);word(0x68,12);data.setUint16(0x6e,3,true);
  word(0x70,0xd98bb561);word(0x80,0x82d6fc83);word(0x84,12);ptr(0x88,0xd0);
  for(const [i,hash] of [0xe6e17f14,0x9a77c7c5,0x069004b2].entries()){
    word(0x90+i*16,hash);word(0x94+i*16,i*4);
    data.setUint8(0x98+i*16,i===2?0x62:0x4a);
  }
  word(0xd0,11);word(0xd4,22);word(0xd8,2);
  expect(readDrawableAliases(data)?.aliases).toEqual([{hash:11,asset:22,kind:2}]);
  data.setUint8(0xb8,0x4a);
  expect(readDrawableAliases(data)?.aliases).toEqual([]);
});

test("indexed drawables can read graphics pages larger than a metadata page",async()=>{
  const page=new Uint8Array(3*1024*1024).fill(19);
  const encoded=zlibSync(page);
  const archive=new Archive("graphics",new Blob([encoded]));
  expect(readCarvedZlib(encoded)).toBeUndefined();
  let decoded:Uint8Array|undefined;
  expect(await readIndexedGraphics(archive,0,undefined,bytes=>decoded=bytes))
    .toEqual([[0,encoded.length,page.length]]);
  expect(decoded?.length).toBe(page.length);
  expect(decoded?.at(-1)).toBe(19);
});

test("an indexed graphics page resumes decoding after the initial read",async()=>{
  const page=new Uint8Array(350*1024);
  let state=1;
  for(let i=0;i<page.length;i++){
    state^=state<<13;
    state^=state>>>17;
    state^=state<<5;
    page[i]=state;
  }
  const encoded=zlibSync(page);
  expect(encoded.length).toBeGreaterThan(256*1024);
  const next=Math.ceil(encoded.length/16)*16;
  const following=zlibSync(new Uint8Array(4096).fill(42));
  const input=new Uint8Array(next+following.length);
  input.set(encoded);
  input.set(following,next);
  const archive=new Archive("graphics",new Blob([input]));
  const decoded:Uint8Array[]=[];
  expect(await readIndexedGraphics(archive,0,undefined,bytes=>decoded.push(bytes)))
    .toEqual([[0,encoded.length,page.length],[next,following.length,4096]]);
  expect(decoded[0]).toEqual(page);
  expect(decoded[1].at(-1)).toBe(42);
  expect(archive.bytesRead).toBe(input.length);
  const prefix=new Uint8Array(16);
  view(prefix).setUint32(4,0x10000,true);
  view(prefix).setUint32(8,0x2d0000,true);
  const prefixed=new Archive("prefixed graphics",new Blob([prefix,input]));
  expect(await readIndexedGraphics(prefixed,0)).toEqual([
    [16,encoded.length,page.length],[16+next,following.length,4096],
  ]);
});

test("directory graphics reads stop before the next compressed member",async()=>{
  const page=new Uint8Array(4096).fill(42),chunk=zlibSync(page);
  const end=Math.ceil(chunk.length/16)*16;
  const bytes=new Uint8Array(end+chunk.length);
  bytes.set(chunk);
  bytes.set(chunk,end);
  for(const range of [{end,chunks:[end]},{end}]){
    const archive=new Archive("fixture",new Blob([bytes]));
    const result=await indexedGraphicsPages(archive,0,range);
    expect(result).toEqual({pages:[page],end});
    expect(archive.bytesRead).toBe(end);
  }
});

test("navigation floor bridges enclosed level gaps without extending into open space",()=>{
  const vertices:number[]=[],faces:number[]=[];
  function quad(left:number,bottom:number,right:number,top:number,z:number){
    const base=vertices.length/4;
    vertices.push(left,bottom,z,73,right,bottom,z,73,right,top,z,73,left,top,z,73);
    faces.push(base,base+1,base+2,base,base+2,base+3);
  }
  quad(10,10,12,18,3);
  quad(16,10,18,18,3);
  quad(12,10,16,12,3);
  quad(12,16,16,18,3);
  quad(30,10,32,18,6);
  quad(36,10,38,18,6);
  quad(32,10,36,12,9);
  quad(32,16,36,18,9);
  const floor=bridgeNavigationGaps(Float32Array.from(vertices),faces);
  const fills=(x:number,y:number)=>{
    for(let i=vertices.length;i<floor.length;i+=16){
      if(x>=floor[i]&&x<=floor[i+4]&&y>=floor[i+1]&&y<=floor[i+9])return floor[i+2];
    }
  };
  expect(fills(14,14)).toBe(3);
  expect(fills(9,14)).toBeUndefined();
  expect(fills(34,14)).toBeUndefined();
});

test("sea surface follows the coast and leaves isolated depressions dry",()=>{
  const elevation=new Uint16Array(25).fill(28100);
  for(let y=0;y<5;y++)elevation[5*y]=27700;
  elevation[13]=27500;
  const coast=streetOceanFromElevation([0,-1,1,1],elevation,5,5);
  const water=coast.water([20,60],new Set());
  expect(water.meshes).toHaveLength(1);
  const result=water.meshes[0];
  expect(result.kind).toBe("water");
  expect(result.bounds[3]).toBeLessThan(40);
  expect(result.appearance?.uv.some(depth=>depth>2)).toBe(true);
  expect(coast.water([20,60],new Set(water.wanted))).toEqual({wanted:water.wanted,meshes:[]});
  const terrain=coast.terrain([20,60],new Set());
  expect(terrain.meshes).toHaveLength(1);
  const land=terrain.meshes[0];
  expect(land.visualOnly).toBe(true);
  expect(land.normals).toHaveLength(land.vertices.length/4*3);
  expect(land.normals?.some((component,index)=>index%3===0&&component<0)).toBe(true);
  const x=(i:number)=>land.vertices[4*i]+land.origin[0];
  // Nearest water and land triangles share the interpolated coastline.
  expect(Math.min(...Array.from(land.indices,x))).toBeCloseTo(result.bounds[3],4);
  expect(coast.terrain([20,60],new Set(terrain.wanted))).toEqual({wanted:terrain.wanted,meshes:[]});
  const seabed=coast.seabed([20,60],new Set());
  expect(seabed.meshes).toHaveLength(1);
  const bottom=seabed.meshes[0];
  expect(bottom.visualOnly).toBe(true);
  expect(bottom.bounds.slice(0,2)).toEqual(result.bounds.slice(0,2));
  expect(bottom.bounds[3]).toBe(result.bounds[3]);
  expect(bottom.bounds[5]).toBeLessThan(0);
  expect(bottom.bounds[2]).toBeLessThan(-2);
  expect(coast.seabed([20,60],new Set(seabed.wanted))).toEqual({wanted:seabed.wanted,meshes:[]});
  const openSea=streetOceanFromElevation([0,-1,1,1],new Uint16Array(25).fill(24000),5,5);
  const near=openSea.water([20,60],new Set()).meshes[0];
  const distant=openSea.water([2048,60],new Set()).meshes[0];
  expect(near.indices.length).toBeGreaterThan(distant.indices.length);
  expect(near.bounds).toEqual(distant.bounds);
});

test("absolute byte range tables preserve values above 4 GiB",()=>{
  const numbers=[40*2**30+16,1690,4096,600];
  const output:number[]=[];
  for(let n of numbers){
    while(n>=128){output.push(n%128+128);n=Math.floor(n/128);}
    output.push(n);
  }
  expect(unpackRanges(btoa(String.fromCharCode(...output)))).toEqual([[numbers[0],1690],[numbers[0]+4096,600]]);
});

test("masked CPU count changes scheduling while memory determines scene detail",()=>{
  const four=streetCapacity({deviceMemory:4,hardwareConcurrency:4});
  const sixteen=streetCapacity({deviceMemory:4,hardwareConcurrency:16});
  expect(four.geometryReads).toBeLessThan(sixteen.geometryReads);
  expect(four.materialTextures).toBe(sixteen.materialTextures);
  expect(four.detailCells).toBe(sixteen.detailCells);
  expect(four.detailCells).toBe(9);
  expect(streetCapacity({hardwareConcurrency:4}).detailCells)
    .toBe(streetCapacity({hardwareConcurrency:16}).detailCells);
  expect(streetCapacity({deviceMemory:2,hardwareConcurrency:16}).detailCells)
    .toBeLessThan(four.detailCells);
});

test("reannouncing packed foliage retains the resident chunk until its fade inputs change",()=>{
  const gl={getExtension:()=>null} as unknown as WebGL2RenderingContext;
  const world=new StreetWorld(gl,[89,1,3],()=>{},()=>{});
  const bounds:Bounds=[100,-2,0,104,2,5];
  const mesh:StreetChunk={
    id:"packed-impostor:test",kind:"foliage",origin:[0,0,0],bounds,geometryKey:"impostor:test",
    vertices:new Float32Array(),indices:new Uint16Array(),packedSlodCenter:[0,0,2],vegetation:500,
    instances:{affine:true,ids:["plant"],poses:new Float32Array(16),tiles:[{first:0,count:1,bounds}]},
  };
  world.install(null,[structuredClone(mesh)],undefined,"vegetation");
  const original=world["chunks"].get(mesh.id);
  expect(world.install(null,[structuredClone(mesh)],undefined,"vegetation")).toBeFalse();
  expect(world["chunks"].get(mesh.id)).toBe(original);
  const faded=structuredClone(mesh);
  faded.instances!.poses[13]=250;
  expect(world.install(null,[faded],undefined,"vegetation")).toBeTrue();
  expect(world["chunks"].get(mesh.id)?.mesh).toBe(faded);
});

test("tilted interior placements retain their parent scale and perpendicular normals",()=>{
  const parent:Placement={position:[100,200,10],rotation:[0,0,Math.SQRT1_2,Math.SQRT1_2],scale:[2,3]};
  const child:Placement={position:[1,2,3],rotation:[Math.sin(Math.PI/8),0,0,Math.cos(Math.PI/8)],scale:[1,4]};
  const placement=composePlacement(parent,child);
  const [a,b,c,d,e,f,g,h,k,x,y,z]=placementMatrix(placement,parent.position);
  expect(x).toBeCloseTo(-4);expect(y).toBeCloseTo(2);expect(z).toBeCloseTo(9);
  expect(d).toBeCloseTo(2);expect(b).toBeCloseTo(-Math.SQRT2);expect(h).toBeCloseTo(3*Math.SQRT1_2);
  expect(c).toBeCloseTo(4*Math.SQRT2);expect(k).toBeCloseTo(12*Math.SQRT1_2);
  const [,,nx,,,ny,,,nz]=placementNormalMatrix(placement);
  expect(nx*a+ny*d+nz*g).toBeCloseTo(0);
  expect(nx*b+ny*e+nz*h).toBeCloseTo(0);
  expect(nx*c+ny*f+nz*k).toBeGreaterThan(0);
});

test("portal traversal requires overlapping apertures and preserves a close opening",()=>{
  const bounds:Bounds=[1,-10,-10,20,10,10];
  const first:InteriorScene["portals"][number]={from:0,to:1,plane:[1,0,0,2],corners:[
    [2,1.6,-1.6],[2,-1.2,-1.6],[2,1.6,1.2],
  ]};
  const second:typeof first={from:1,to:2,plane:[1,0,0,4],corners:[
    [4,2.4,3.2],[4,-3.2,-2.4],[4,-3.2,3.2],
  ]};
  const scene:InteriorScene={id:"portal-test",placement:{position:[0,0,0],rotation:[0,0,0,1],scale:[1,1]},
    bounds,rooms:[bounds,bounds,bounds],portals:[first,second]};
  const camera={eye:[0,0,0] as const,yaw:0,pitch:0,aspect:1,fov:90};
  expect([...visibleInteriorRooms(scene,camera).keys()]).toEqual([0,1]);
  second.corners=first.corners.map(([x,y,z])=>[2*x,2*y,2*z]);
  expect([...visibleInteriorRooms(scene,camera).keys()]).toEqual([0,1,2]);
  expect(visibleInteriorRooms({...scene,bounds:[2,-10,-10,20,10,10]}, {...camera,eye:[1.95,.4,-.4]}).has(1)).toBeTrue();
});

test("continuous interior room tracking crosses apertures and preserves the room through walls",()=>{
  const bounds:Bounds=[-2,-3,-3,2,3,3];
  const scene:InteriorScene={id:"portal-crossing",placement:{position:[0,0,0],rotation:[0,0,0,1],scale:[1,1]},
    bounds,rooms:[bounds,bounds],portals:[{from:0,to:1,plane:[1,0,0,0],corners:[
      [0,-1,-1],[0,1,-1],[0,1,1],[0,-1,1],
    ]}]};
  const outside={eye:[-.2,0,0] as const,rooms:[0]};
  const threshold=trackInteriorCamera(scene,[0,0,0],outside);
  expect(threshold.rooms).toEqual([0]);
  const inside=trackInteriorCamera(scene,[.2,0,0],threshold);
  expect(inside.rooms).toEqual([1]);
  expect(trackInteriorCamera(scene,inside.eye,inside)).toBe(inside);
  expect(trackInteriorCamera(scene,outside.eye,inside).rooms).toEqual([0]);
  expect(trackInteriorCamera(scene,[.2,2,0],{eye:[-.2,2,0],rooms:[0]}).rooms).toEqual([0]);
  scene.rooms.push(bounds);
  scene.portals.unshift({from:1,to:2,plane:[1,0,0,1],corners:[
    [1,-1,-1],[1,1,-1],[1,1,1],[1,-1,1],
  ]});
  const further=trackInteriorCamera(scene,[1.2,0,0],outside);
  expect(further.rooms).toEqual([2]);
  expect(trackInteriorCamera(scene,outside.eye,further).rooms).toEqual([0]);
  scene.portals[0].flags=4;
  expect(trackInteriorCamera(scene,[1.2,0,0],outside).rooms).toEqual([1]);
});

test("cold interior room classification uses the authored volume within overlapping bounds",()=>{
  const bounds:Bounds=[0,0,0,1,1,1];
  const scene:InteriorScene={id:"room-volume",placement:{position:[10,20,30],rotation:[0,0,0,1],scale:[2,3]},
    bounds,rooms:[bounds,bounds],portals:[],spatial:{bounds,volumes:[{room:1,bounds,
      vertices:[[0,0,0],[1,0,0],[0,1,0],[0,0,1]],triangles:Uint16Array.of(0,2,1,0,1,3,0,3,2,1,2,3),
    }]}};
  expect(trackInteriorCamera(scene,[10.2,20.2,30.3]).rooms).toEqual([1]);
  expect(trackInteriorCamera(scene,[11.8,21.8,32.7]).rooms).toEqual([0]);
  expect(trackInteriorCamera(scene,[10.2,20.2,29.99975]).rooms).toEqual([1]);
});

test("an authored roller rises and restores its exact closed geometry",()=>{
  const data=new DataView(new ArrayBuffer(0x180));
  data.setUint32(0x90,0x500000a0,true);
  data.setUint32(0xe0,0x50000140,true);
  data.setFloat32(0x158,4,true);
  data.setUint32(0x160,0xbca7812c,true);
  const placement:Placement={position:[10,20,30],rotation:[0,0,0,1],scale:[1,1]};
  const roller=readStreetRoller(data,0,placement,[-2,-.5,0,2,.1,4.2])!;
  expect(roller.travel).toBe(4);
  const closed=Float32Array.of(10,20,30,66,10,19.5,34.1,66),vertices=closed.slice();
  poseRoller(roller,placement.position,closed,vertices,.5);
  expect(vertices[2]).toBeGreaterThan(32);
  expect(vertices.slice(4)).toEqual(closed.slice(4));
  poseRoller(roller,placement.position,closed,vertices,1);
  expect(vertices[2]).toBeGreaterThan(34);
  poseRoller(roller,placement.position,closed,vertices,0);
  expect(vertices).toEqual(closed);
});

test("an opened roller keeps its walking clearance when streamed back into FPS",()=>{
  const gl={getExtension:()=>null} as unknown as WebGL2RenderingContext;
  const world=new StreetWorld(gl,[0,0,0],()=>{},()=>{});
  const shutter=():StreetChunk=>({id:"roller",kind:"structure",origin:[0,0,0],bounds:[-2,0,0,2,0,4],
    vertices:Float32Array.of(-2,0,0,66,2,0,0,66,-2,0,4,66,2,0,4,66),
    indices:Uint16Array.of(0,1,2,1,3,2),roller:{anchor:[0,0,0],up:[0,0,1],back:[0,-1,0],travel:4,radius:.2}});
  world.install(null,[shutter()]);
  expect(world.blocked(0,-1,0,1,0)).toBeTrue();
  world.toggleRoller("roller",0,0);
  world.updateRollers(0);
  expect(world.blocked(0,-1,0,1,0)).toBeFalse();
  world.install([],[]);
  world.install(null,[shutter()]);
  expect(world.blocked(0,-1,0,1,0)).toBeFalse();
  expect(world.rollerButton({eye:[0,-3,1.6],yaw:Math.PI/2,pitch:0,aspect:1})?.open).toBeTrue();
  world.toggleRoller("roller",0,0);
  world.updateRollers(0);
  expect(world.blocked(0,-1,0,1,0)).toBeTrue();
});

test("instance ranges reuse the pose binding until prop attributes switch buffers",()=>{
  const bound:WebGLBuffer[]=[],offsets:number[]=[],counts:number[]=[];
  const gl={
    getExtension:()=>null,bindBuffer:(_target:number,buffer:WebGLBuffer)=>bound.push(buffer),
    vertexAttribPointer:(attribute:number,_size:number,_type:number,_norm:boolean,_stride:number,offset:number)=>{
      if(attribute===15)offsets.push(offset);
    },
    drawElementsInstanced:(_mode:number,_count:number,_type:number,_offset:number,instances:number)=>counts.push(instances),
  } as unknown as WebGL2RenderingContext;
  const world=new StreetWorld(gl,[0,0,0],()=>{},()=>{});
  const vao={} as WebGLVertexArrayObject,poseBuffer={name:"poses"} as WebGLBuffer;
  const controls={name:"controls"} as WebGLBuffer;
  const resident:Parameters<StreetWorld["drawTriangles"]>[0]={
    vao,vertices:poseBuffer,indices:poseBuffer,poses:poseBuffer,instances:8,instanceMode:2,instanceStart:0,
    instanceExtras:true,count:6,indexType:gl.UNSIGNED_SHORT,indexBytes:2,frame:0,bytes:0,
  };
  const ranges=[{first:1,count:2},{first:4,count:3}];
  world["drawTriangles"](resident,0,6,ranges);
  expect(bound).toEqual([poseBuffer]);
  expect(offsets).toEqual([64+48,4*64+48]);
  world["drawTriangles"]({...resident,instanceMode:1,instanceExtras:undefined,instanceStart:0,propInstances:controls},0,6,ranges);
  expect(bound).toEqual([poseBuffer,poseBuffer,controls,poseBuffer,controls]);
  expect(offsets).toEqual([64+48,4*64+48,3,12]);
  expect(counts).toEqual([2,3,2,3]);
});

test("material selection is independent of mesh delivery order and prior residency",()=>{
  const gl={getExtension:()=>null} as unknown as WebGL2RenderingContext;
  const meshes=Array.from({length:384},(_,index)=>index+1000);
  const plan=(order:number[],cached:number)=>{
    const world=new StreetWorld(gl,[0,0,0],()=>{},()=>{});
    world["textures"].set(`material-${cached}`,{} as WebGLTexture);
    world.install(null,order.map(index=>({
      id:`wall-${index}`,kind:"structure",origin:[100,0,0],bounds:[0,0,0,0,4,4],
      vertices:new Float32Array([0,0,0,0,0,4,0,0,0,0,4,0]),indices:new Uint32Array([0,1,2]),
      appearance:{uv:new Float32Array(6),spans:[{first:0,count:3,texture:`material-${index}`}]},
    })));
    world["prepareTextures"]([...world["chunks"].values()],{eye:[0,0,0],yaw:0,pitch:0,aspect:1},()=>true,[]);
    return [...world["materialPlan"]!.wanted];
  };
  const cold=plan(meshes,1000);
  expect(cold[0]).toBe("material-1000");
  expect(cold).not.toContain("material-1383");
  expect(plan([...meshes].reverse(),1383)).toEqual(cold);
});

test("a visible sign texture stays selected as larger structures stream in",()=>{
  const gl={getExtension:()=>null} as unknown as WebGL2RenderingContext;
  const world=new StreetWorld(gl,[0,0,0],()=>{},()=>{});
  const camera={eye:[0,0,0] as const,yaw:0,pitch:0,aspect:1,fov:55};
  function surface(id:string,origin:StreetChunk["origin"],width:number,depth:number):StreetChunk{
    const textureBounds:Bounds=[0,-width/2,0,depth,width/2,width];
    return {id,kind:"structure",origin,bounds:textureBounds,
      vertices:new Float32Array([0,-width/2,0,0,depth,width/2,0,0,0,width/2,width,0]),
      indices:new Uint32Array([0,1,2]),appearance:{uv:new Float32Array(6),spans:[{first:0,count:3,texture:id,textureBounds}]}};
  }
  const wanted=()=>{
    world["prepareTextures"]([...world["chunks"].values()],camera,streetFrustum(camera),[]);
    return world["materialPlan"]!.wanted;
  };
  world.install(null,[surface("sign",[150,0,0],5,0),surface("offscreen-sign",[150,200,0],5,0)]);
  expect(wanted().has("sign")).toBeTrue();
  world.install(null,Array.from({length:384},(_,index)=>surface(`building-${index}`,[100,0,0],20,20)));
  expect(wanted().has("sign")).toBeTrue();
  expect(wanted().has("offscreen-sign")).toBeFalse();
});

test("settled views stream all scene materials while aerial views prioritize more skyline textures",()=>{
  const gl={getExtension:()=>null} as unknown as WebGL2RenderingContext;
  const world=new StreetWorld(gl,[0,0,0],()=>{},()=>{});
  const camera={eye:[0,0,60] as const,yaw:0,pitch:0,aspect:1,fov:55};
  const meshes=Array.from({length:480},(_,index):StreetChunk=>{
    const skyline=index>=384;
    const id=skyline?`skyline-${index}`:`building-${index}`;
    return {id,kind:skyline?"skyline":"structure",origin:[skyline?500:120,0,60],bounds:[0,-8,0,16,8,16],
      vertices:new Float32Array([0,-8,0,0,16,8,0,0,0,8,16,0]),indices:new Uint32Array([0,1,2,0,1,2]),
      appearance:{uv:new Float32Array(6),spans:[{first:0,count:3,texture:id},
        {first:3,count:3,texture:`ground-${index}`,ground:true}]}};
  });
  world.install(null,meshes);
  const plan=(aerial:boolean)=>{
    world["flightTerrain"]=aerial;
    world["prepareTextures"]([...world["chunks"].values()],camera,streetFrustum(camera),[]);
    const {wanted,queue}=world["materialPlan"]!;
    return {wanted:wanted.size,groundWanted:world["groundPlan"]!.wanted.size,
      earlySkyline:queue.slice(0,165).filter(id=>id.startsWith("skyline-")).length};
  };
  expect(plan(true)).toEqual(plan(false));
  expect(world.install(meshes.map(({id})=>id),[])).toBeTrue();
  const ground=plan(false),aerial=plan(true);
  expect(aerial.earlySkyline).toBeGreaterThan(ground.earlySkyline);
  expect(aerial.wanted).toBe(meshes.length);
  expect(aerial.groundWanted).toBe(meshes.length);
});

test("the foreground plan preserves scene, ground and layered textures across region loads",()=>{
  const deleted:WebGLTexture[]=[];
  const gl={getExtension:()=>null,deleteTexture:(texture:WebGLTexture)=>deleted.push(texture)} as unknown as WebGL2RenderingContext;
  const requests:string[]=[];
  const world=new StreetWorld(gl,[0,0,0],()=>{},id=>requests.push(id));
  world["textures"].set("previous-region",{} as WebGLTexture);
  world["groundTextures"].set("previous-ground",{} as WebGLTexture);
  world["terrainTextures"].set("previous-layer",{} as WebGLTexture);
  world["terrainTextureBytes"]=96*1024*1024;
  world["requestTextureSet"](false,{wanted:new Set(["local"]),queue:["local"],foregroundRoad:[]});
  world["requestTextureSet"](true,{wanted:new Set(["ground"]),queue:["ground"],foregroundRoad:[]});
  world["trimTerrainTextures"]();
  expect(requests).toEqual(["local","ground"]);
  expect(deleted).toEqual([]);
  expect(world["textures"].has("previous-region")).toBeTrue();
  expect(world["groundTextures"].has("previous-ground")).toBeTrue();
  expect(world["terrainTextures"].has("previous-layer")).toBeTrue();
});

test("settled road requests keep all visible masks and heights",()=>{
  const gl={getExtension:()=>null} as unknown as WebGL2RenderingContext;
  const world=new StreetWorld(gl,[0,0,0],()=>{},()=>{});
  const roads:Parameters<StreetWorld["planTextureSet"]>[3]=Array.from({length:8},(_,i)=>({
    bounds:[i,0,0,i+1,1,1],
    road:{
      textures:[`road-weights:${i}`,`road-surface:${i}:0`,`road-surface:${i}:1`,`road-surface:${i}:2`,`road-surface:${i}:3`],
      useProjectedColor:true,primary:[1,1,1,1],secondary:[0,0,0,0],powers:[1,1,1,1],
      height:{textures:[`road-height:${i}:0`,`road-height:${i}:1`,null,null,null],gain:[1,1,1,1],cutoff:[0,0,0,0]},
    },
  }));
  world["textures"].set("road-weights:6",null);
  world["textures"].set("road-height:7:0",null);
  world.install([],[]);
  const {wanted,queue}=world["planTextureSet"]([],false,[],roads);
  const expected=roads.slice(0,7).flatMap(({road})=>[...road.textures,...road.height!.textures.filter(id=>id!==null)])
    .filter(id=>id!=="road-weights:6");
  expect([...wanted]).toEqual(expected);
  expect(queue).toEqual(expected);
});

test("the foreground road can start while object texture requests fill the regular lane",()=>{
  const gl={getExtension:()=>null} as unknown as WebGL2RenderingContext;
  const requested:string[]=[];
  const world=new StreetWorld(gl,[0,0,0],()=>{},id=>requested.push(id));
  const road=["road-weights:mask","road-surface:color","road-height:height"];
  const otherRoad=["road-weights:other","road-surface:other"];
  for(let i=0;i<streetBudgets.materialReads;i++)world["pending"].add("object-"+i);
  world["requestTextureSet"](false,{wanted:new Set(road),queue:road,foregroundRoad:road});
  world["requestTextureSet"](false,{wanted:new Set(otherRoad),queue:otherRoad,foregroundRoad:otherRoad});
  expect(requested).toEqual(road);
  for(const id of road)world.installTexture(id,null,false);
  world["requestTextureSet"](false,{wanted:new Set(otherRoad),queue:otherRoad,foregroundRoad:otherRoad});
  expect(requested).toEqual([...road,...otherRoad]);
});

test("settled terrain requests retain every available authored layer group",()=>{
  const gl={getExtension:()=>null} as unknown as WebGL2RenderingContext;
  const world=new StreetWorld(gl,[0,0,0],()=>{},()=>{});
  const cells:Parameters<StreetWorld["prepareTerrainTextures"]>[0]=Array.from({length:6},(_,i)=>({terrain:{
    textures:[`weight-${i}`,`diffuse-${i}`],primary:[1,1,1,1],heightGain:[0,0,0,0],heightBias:[0,0,0,0],powers:[1,1,1,1],
    normals:{textures:[`normal-${i}`],strength:[1,0,0,0]},
    tint:{texture:`tint-${i}`,inset:false,maskAlpha:false,mode:[0,0,0,0],scale:[1,1,1,1],amount:[1,1,1,1]},
  }}));
  world["terrainMissing"].add("diffuse-5");
  world["prepareTerrainTextures"](cells,[],[]);
  expect(world["terrainWanted"].has("weight-2")).toBeFalse();
  world.install([],[]);
  world["prepareTerrainTextures"](cells,[],[]);
  expect([...world["terrainWanted"]]).toEqual([
    ...cells.slice(0,5).flatMap(({terrain})=>terrain.textures),
    ...Array.from({length:5},(_,i)=>`tint-${i}`),
    ...Array.from({length:5},(_,i)=>`normal-${i}`),
  ]);
});

test("an authored skyline needs all sibling identities and every selected child",()=>{
  const gl={getExtension:()=>null} as unknown as WebGL2RenderingContext;
  const world=new StreetWorld(gl,[0,0,0],()=>{},()=>{});
  const camera={eye:[0,0,10] as const,yaw:0,pitch:0,aspect:1,fov:55};
  function skyline(id:string,bounds:Bounds,link:NonNullable<StreetChunk["placementLod"]>,drawDistance?:number):StreetChunk{
    return {id,kind:"skyline",aggregate:true,origin:[0,0,0],bounds,
      vertices:new Float32Array(),indices:new Uint32Array(),placementLod:link,drawDistance};
  }
  const parent=skyline("parent",[500,-800,0,600,100,20],{map:1,ordinal:1,level:3,children:2});
  const child=skyline("visible",[520,0,0,560,30,20],{map:2,ordinal:1,level:2,children:0,parent:[1,1]});
  const sibling=skyline("sibling",[520,-800,0,560,-760,20],{map:2,ordinal:2,level:2,children:0,parent:[1,1]});
  const plan=()=>world["visibleChunks"](camera,streetFrustum(camera),true);
  const selected=()=>[...plan().skylineChildren]
    .map(([parent,children])=>[parent.mesh.id,children.map(chunk=>chunk.mesh.id)]);
  const unrelated={...child,id:"unrelated",placementLod:{map:3,ordinal:1,level:2,children:0}};
  world.install(null,[parent,child,unrelated]);
  expect(selected()).toEqual([]);
  const partial=new Map([...plan().skylineCoverage].map(([chunk,coverage])=>[chunk.mesh.id,coverage]));
  expect(partial.get("parent")?.read).toBeGreaterThan(0);
  expect(partial.get("visible")?.write).toBe(partial.get("parent")?.read);
  expect(partial.has("unrelated")).toBeFalse();
  world.install(null,[sibling]);
  expect(selected()).toEqual([["parent",["visible"]]]);
  expect(plan().skylineCoverage.size).toBe(0);
  world.install(null,[{...sibling,id:"duplicate-sibling"}]);
  expect(selected()).toEqual([]);
  world.install(["parent","visible","sibling"],[{...sibling,bounds:[520,-30,0,560,-10,20],drawDistance:200}]);
  expect(selected()).toEqual([]);
});

test("skyline stencil bits can be shared only by separated branch footprints",()=>{
  const gl={getExtension:()=>null} as unknown as WebGL2RenderingContext;
  const camera={eye:[0,0,10] as const,yaw:0,pitch:0,aspect:1,fov:55};
  const allocated=(positions:number[],crossingChild=false)=>{
    const world=new StreetWorld(gl,[0,0,0],()=>{},()=>{});
    const meshes=positions.flatMap((y,i)=>{
      const parent:StreetChunk={id:`parent-${i}`,kind:"skyline",aggregate:true,origin:[0,0,0],
        bounds:[900,y-25,0,950,y+25,40],vertices:new Float32Array(),indices:new Uint32Array(),
        placementLod:{map:i+1,ordinal:0,level:3,children:2}};
      const child:StreetChunk={...parent,id:`child-${i}`,bounds:crossingChild&&i===0?[890,-330,0,950,340,50]:parent.bounds,
        placementLod:{map:i+1,ordinal:1,level:2,children:0,parent:[i+1,0]}};
      return [parent,child];
    });
    world.install(null,meshes);
    return new Map([...world["visibleChunks"](camera,streetFrustum(camera),true).skylineCoverage]
      .filter(([,bits])=>bits.read).map(([chunk,bits])=>[chunk.mesh.id,bits.read]));
  };
  const separated=allocated([-300,-100,100,300]);
  expect(separated.size).toBe(4);
  expect(new Set(separated.values()).size).toBeLessThanOrEqual(3);
  const crossing=allocated([-300,-100,100,300],true);
  expect(crossing.size).toBe(4);
  expect([...crossing].filter(([,bit])=>bit===crossing.get("parent-0")).length).toBe(1);
  expect(allocated([0,0,0,0]).size).toBe(3);
});

test("an interior composite supplies a transformed floor across exterior region updates",()=>{
  const data=new DataView(new ArrayBuffer(0x280));
  const pointer=(at:number,offset:number)=>data.setUint32(at,0x50000000+offset,true);
  data.setUint8(0x10,6);
  pointer(0x70,0xa0);pointer(0x78,0xb0);
  data.setUint16(0x98,1,true);data.setUint16(0x9a,1,true);
  pointer(0xa0,0xf0);
  [0,5,10].forEach(index=>data.setFloat32(0xb0+4*index,1,true));
  data.setFloat32(0xb0+4*14,2,true);
  data.setUint8(0x100,5);
  pointer(0xf0+0x88,0x200);pointer(0xf0+0xb0,0x240);
  for(let axis=0;axis<3;axis++)data.setFloat32(0xf0+0x90+4*axis,1,true);
  data.setUint32(0xf0+0xd0,3,true);data.setUint32(0xf0+0xd4,2,true);
  data.setUint16(0x206,1,true);data.setUint16(0x208,2,true);
  data.setUint8(0x213,3);data.setUint16(0x214,0xffff,true);
  data.setInt16(0x246,4,true);data.setInt16(0x24e,4,true);
  const bounds:Bounds=[0,0,0,4,4,4];
  const scene:InteriorScene={id:"floor",bounds,rooms:[bounds],portals:[],
    placement:{position:[100,200,10],rotation:[0,0,0,1],scale:[1,2]}};
  const mesh=readInteriorCollision(data,{scene,rooms:[]})!;
  expect(mesh.collision?.indices).toEqual(Uint32Array.of(0,1,2));
  const gl={getExtension:()=>null} as unknown as WebGL2RenderingContext;
  const world=new StreetWorld(gl,scene.placement.position,()=>{},()=>{});
  world.install(null,[mesh],undefined,"interior");
  world.install([],[],undefined,"region");
  expect(world.floorBelow(1,1,5)).toBe(4);
  world.install([],[],undefined,"interior");
  expect(world.floorBelow(1,1,5)).toBeNull();
});

test("interior collision primitives supply their authored contact heights",()=>{
  const data=new DataView(new ArrayBuffer(0x280));
  const pointer=(at:number,offset:number)=>data.setUint32(at,0x50000000+offset,true);
  data.setUint8(0x10,6);
  pointer(0x70,0xa0);pointer(0x78,0xb0);
  data.setUint16(0x98,1,true);data.setUint16(0x9a,1,true);
  pointer(0xa0,0xf0);
  [0,5,10].forEach(index=>data.setFloat32(0xb0+4*index,1,true));
  data.setUint8(0x100,5);
  pointer(0x178,0x200);pointer(0x1a0,0x240);
  for(let axis=0;axis<3;axis++)data.setFloat32(0x180+4*axis,1,true);
  data.setUint32(0x1c0,8,true);data.setUint32(0x1c4,3,true);
  const positions=[4,4,0,4,6,2,6,4,2,6,6,0,0,0,1,0,0,2,3,0,1,3,0,2];
  positions.forEach((n,i)=>data.setInt16(0x240+2*i,n,true));
  data.setUint8(0x203,3);
  [0,1,2,3].forEach((n,i)=>data.setUint16(0x204+2*i,n,true));
  for(const [row,shape,start,end] of [[0x210,4,4,5],[0x220,2,6,7]]){
    data.setUint8(row+3,shape);
    data.setUint16(row,start,true);data.setUint16(row+8,end,true);
    data.setFloat32(row+4,.5,true);
  }
  const bounds:Bounds=[-1,-1,0,7,7,3];
  const scene:InteriorScene={id:"shapes",bounds,rooms:[bounds],portals:[],
    placement:{position:[0,0,0],rotation:[0,0,0,1],scale:[1,1]}};
  const gl={getExtension:()=>null} as unknown as WebGL2RenderingContext;
  const world=new StreetWorld(gl,[0,0,0],()=>{},()=>{});
  world.install(null,[readInteriorCollision(data,{scene,rooms:[]})!],undefined,"interior");
  expect(world.floorBelow(5,5,3)).toBe(2);
  expect(world.floorBelow(0,0,3)).toBe(2);
  expect(world.floorBelow(3,0,3)).toBe(2.5);
  expect(world.floorBelow(1,0,3)).toBeNull();
});

test("walking keeps an authored road deck above a competing lower surface",()=>{
  const gl={getExtension:()=>null} as unknown as WebGL2RenderingContext;
  const world=new StreetWorld(gl,[0,0,0],()=>{},()=>{});
  const indices=new Uint32Array([0,1,2]);
  world.install(null,[
    {id:"deck",kind:"road",origin:[0,0,0],bounds:[0,0,5,4,4,5],
      vertices:new Float32Array([0,0,5,0,4,0,5,0,0,4,5,0]),indices},
    {id:"lower",kind:"collision",origin:[0,0,0],bounds:[0,0,4.5,4,4,4.5],
      vertices:new Float32Array(),indices:new Uint32Array(),
      collision:{vertices:new Float32Array([0,0,4.5,4,0,4.5,0,4,4.5]),indices}},
  ]);
  expect(world.floor(1,1,5)).toBe(5);
  expect(world.floor(1,1,4.5)).toBe(4.5);
  expect(world.floorBelow(1,1,4.9)).toBe(4.5);
  expect(world.floorBelow(1,1,9)).toBe(5);
  expect(world.ceiling(1,1,4.6,5.1)).toBe(5);
  expect(world.ceiling(1,1,4.6,4.9)).toBeNull();
});

test("walkable LOD fills a hole in HD terrain without replacing its floor",()=>{
  const gl={getExtension:()=>null} as unknown as WebGL2RenderingContext;
  const world=new StreetWorld(gl,[0,0,0],()=>{},()=>{});
  const indices=new Uint32Array([0,1,2]);
  world.install(null,[
    {id:"0,0",kind:"terrain",origin:[0,0,0],bounds:[0,0,3,8,8,3],
      vertices:new Float32Array([0,0,3,0,8,0,3,0,0,8,3,0]),indices},
    {id:"0,0:detail",replaces:"0,0",kind:"terrain",origin:[0,0,0],bounds:[0,0,2.5,4,4,2.5],
      vertices:new Float32Array([0,0,2.5,0,4,0,2.5,0,0,4,2.5,0]),indices},
  ]);
  expect(world.floor(1,1,2.5)).toBe(2.5);
  expect(world.floor(5,1,2.5)).toBe(3);
  expect(world.floorBelow(1,1,5)).toBe(2.5);
  expect(world.floorBelow(5,1,5)).toBe(3);
  expect(world.floor(9,1,2.5)).toBeNull();
  world.install(null,[
    {id:"ground-blend",kind:"terrain",origin:[0,0,0],bounds:[8,0,3,12,4,3],
      vertices:new Float32Array([8,0,3,0,12,0,3,0,8,4,3,0]),indices,
      appearance:{uv:new Float32Array(6),spans:[{first:0,count:3,texture:null,overlay:true,groundBlend:true}]}},
  ]);
  expect(world.floor(9,1,2.5)).toBe(3);
  expect(world.ceiling(9,1,2.5,3.5)).toBeNull();
});

test("walking crosses a narrow seam only between similarly elevated surfaces",()=>{
  const gl={getExtension:()=>null} as unknown as WebGL2RenderingContext;
  const world=new StreetWorld(gl,[0,0,0],()=>{},()=>{});
  const indices=new Uint32Array([0,1,2,2,1,3]);
  const plane=(id:string,left:number,right:number,height:number)=>({
    id,kind:"terrain" as const,origin:[0,0,0] as [number,number,number],
    bounds:[left,0,height,right,2,height] as NativePart["bounds"],
    vertices:new Float32Array([left,0,height,0,right,0,height,0,left,2,height,0,right,2,height,0]),indices,
  });
  world.install(null,[plane("a",0,3,2),plane("b",3.5,6,2.05),plane("c",6.5,8,2.4)]);
  expect(world.floor(3.25,1,2)).toBeNull();
  expect(world.stepFloor(3,1,3.25,1,2)).toBeCloseTo(2.025,5);
  expect(world.stepFloor(6,1,6.25,1,2.05)).toBeNull();
  expect(world.stepFloor(8,1,8.25,1,2.4)).toBeNull();
});

test("static box corners restore the top and side collision faces",async()=>{
  const bytes=new Uint8Array(0x230),data=view(bytes);
  const root=0,child=0xf0;
  const u=(at:number,value:number)=>data.setUint32(at,value,true);
  const f=(at:number,value:number)=>data.setFloat32(at,value,true);
  const p=(at:number,value:number)=>u(at,0x50000000+value);
  u(root+16,6);u(root+0x98,0x10001);
  p(root+0x70,0xa0);p(root+0x78,0xa8);p(0xa0,child);
  [0,5,10].forEach(i=>f(0xa8+4*i,1));
  u(child+16,5);u(child+0xd0,7);u(child+0xd4,2);
  p(child+0x88,0x1d0);p(child+0xb0,0x200);
  for(const [i,max] of [6,2,2].entries()){
    f(root+0x20+i*4,max);f(child+0x20+i*4,max);f(child+0x90+i*4,1);
  }
  [0,1,2].forEach((value,i)=>data.setUint16(0x1d4+i*2,value,true));
  data.setUint8(0x1e3,3);
  [3,4,5,6,0xffff,0xffff].forEach((value,i)=>data.setUint16(0x1e4+i*2,value,true));
  [0,0,0, 1,0,0, 0,1,0, 6,2,2, 6,0,0, 4,2,0, 4,0,2]
    .forEach((value,i)=>data.setInt16(0x200+i*2,value,true));
  const compressed=zlibSync(bytes);
  const archive=new Archive("collision.rpf",new Blob([compressed]));
  const result=await loadCollisionRegions(archive,[{bounds:[0,0,6,2],compounds:[[[[0,compressed.length,bytes.length]],1,[[0,1]]]]}],[0,0],[]);
  expect(result.meshes[0]?.collision?.indices.length).toBe(13*3);
  const gl={getExtension:()=>null} as unknown as WebGL2RenderingContext;
  const world=new StreetWorld(gl,[0,0,0],()=>{},()=>{});
  world.install(null,result.meshes);
  expect(world.floor(5,1,2)).toBe(2);
  expect(world.blocked(3,1,5,1,0)).toBe(true);
  expect(world.blocked(3,3,5,3,0)).toBe(false);
});

test("pause-map helipads keep their footprint and attach to visible surfaces",()=>{
  const triangle=(name:string,x:number,y:number,z:number,side:number):NativePart=>{
    const part:NativePart={
      name,vertices:new Float32Array([x,y,z,0,x+side,y,z,0,x,y+side,z,0]),
      indices:new Uint32Array([0,1,2]),spans:[{first:0,count:3}],bounds:[0,0,0,0,0,0],
    };
    part.bounds=rangeBounds(part,0,3);
    return part;
  };
  const roof=triangle("buildings_std",0,0,.5,1);
  const overhead=triangle("buildings_std",0,0,5,1);
  const terrain=triangle("terrain_std",0,0,.1,4);
  const roofPad=triangle("helipads_std",.1,.1,2,.05);
  const groundPad=triangle("helipads_std",2,1,2,.05);
  const footprint=roofPad.vertices[0];
  groundHelipads([roof,overhead,terrain,roofPad,groundPad]);
  expect(roofPad.vertices[0]).toBe(footprint);
  expect(roofPad.bounds[2]).toBeCloseTo(.5+.2/128,6);
  expect(groundPad.bounds[2]).toBeCloseTo(.1+.2/128,6);
});

test("file validation checks size and raw fingerprint",async()=>{
  const file=new Blob([new Uint8Array(4096)]),source=new Archive("synthetic.rpf",file);
  const actual=Buffer.from(await crypto.subtle.digest("SHA-256",await file.arrayBuffer())).toString("hex");
  const spec={path:source.path,size:4096,required:true,probes:[[0,actual]]};
  await expect(identify(source,spec)).resolves.toBeUndefined();
  await expect(identify(source,{...spec,size:4097})).rejects.toThrow("expected");
  await expect(identify(source,{...spec,probes:[[0,"bad"]]})).rejects.toThrow("fingerprint failed at 0x0");
  expect(source.bytesRead).toBe(8192);
  await expect(source.read(2**32,1)).rejects.toThrow("outside the file");
});

test("inflation tolerates alignment and rejects oversized output",()=>{
  const raw=new Uint8Array(128).fill(21),z=zlibSync(raw);
  const bytes=new Uint8Array(z.length+16);bytes.set(z);
  expect(inflate(bytes,128)).toEqual(raw);
  expect(()=>inflate(bytes,63)).toThrow();
  bytes[0]=0;
  expect(()=>inflate(bytes,128)).toThrow("zlib header");
});

test("RDS5 and ETPF join to a real swizzled BC1 mip",async()=>{
  const texture=new Uint8Array(8192),mipColors=view(texture);
  for(let y=0;y<32;y++)for(let x=0;x<32;x++)mipColors.setUint16(blockOffset(x,y,32,8),0xf800,true);
  const packed=zlibSync(texture),file=new Uint8Array(512+packed.length);
  file.set(new TextEncoder().encode("RDS5"));
  const d=view(file);
  d.setUint32(4,3,true);
  const end=file.length;
  const padded=new Uint8Array(256*Math.ceil(end/256));padded.set(file);
  const v=view(padded);
  v.setBigUint64(24,2n|(0x20n<<24n)|(BigInt(padded.length-end)<<52n),true);
  v.setBigUint64(32,BigInt(padded.length/256)|(2n<<30n),true);
  padded.set(new TextEncoder().encode("ETPF"),48);
  v.setUint32(52,0x27a,true);v.setUint32(56,1,true);
  v.setUint32(64,127|(127<<14),true);v.setUint32(68,0x243,true);
  v.setBigUint64(80,0xdef0aabbccddeeffn,true);
  padded.set(packed,512);
  const pack=await loadPack(new Archive("synthetic.ttpf",new Blob([padded])));
  const row=pack.descriptors[0];
  expect(row.id).toBe("0xdef0aabbccddeeff");
  const mip=await readMip(pack,row,128);
  expect(mip?.offset).toBe(512);
  expect([...bc1(mip!.data,128,128).rgba.slice(0,4)]).toEqual([255,0,0,255]);
});

test("pack reads merge requested neighbors and decode rows independently",async()=>{
  class TrackedArchive extends Archive {
    readonly ranges:number[][]=[];
    async read(at:number,length:number){
      this.ranges.push([at,length]);
      return super.read(at,length);
    }
  }
  const raw=Uint8Array.of(1,2,3,4),color=Uint8Array.of(5,6,7,8),compressed=zlibSync(color);
  const bytes=new Uint8Array(24+compressed.length);
  bytes.set(raw);bytes.set(compressed,8);bytes.set(raw,20+compressed.length);
  const source=new TrackedArchive("fixture",new Blob([bytes]));
  const pack:Pack={source,descriptors:[],offsets:[0,8,8+compressed.length,20+compressed.length,bytes.length],
    addresses:[0,4,8,12],eofAddress:16,codecs:Uint8Array.of(0,32,0,0),padding:Uint16Array.of(4,0,8,0)};
  const rows=await Promise.all([3,1,0,0].map(row=>readTextureChunk(pack,row,4)));
  expect(rows).toEqual([raw,color,raw,raw]);
  expect(source.ranges).toEqual([[0,8+compressed.length],[20+compressed.length,4]]);
  expect(rows[2]!.buffer).not.toBe(rows[3]!.buffer);
  bytes[8]=0;
  const damaged=new TrackedArchive("damaged",new Blob([bytes]));
  const damagedPack={...pack,source:damaged};
  const outcome=await Promise.allSettled([0,1].map(row=>readTextureChunk(damagedPack,row,4)));
  expect(outcome[0]).toEqual({status:"fulfilled",value:raw});
  expect(outcome[1].status).toBe("rejected");
  expect(damaged.ranges).toEqual([[0,8+compressed.length]]);
});

test("terrain textures locate standalone and packed-tail BC1 mips in a shared stream",async()=>{
  const bytes=new Uint8Array(512+12288),header=view(bytes),data=bytes.subarray(512),blocks=view(data);
  const encode=new TextEncoder();
  bytes.set(encode.encode("RDS5"));
  header.setUint32(4,3,true);
  header.setBigUint64(24,2n,true);
  header.setBigUint64(32,BigInt(bytes.length/256)|(3n<<30n),true);
  bytes.set(encode.encode("ETPF"),48);
  header.setUint32(52,0x27a,true);header.setUint32(56,1,true);
  header.setUint32(64,127|(95<<14)|(3<<28),true);
  header.setUint32(68,1|(72<<3)|(1<<21)|(4<<23),true);
  header.setBigUint64(80,1n,true);
  blocks.setUint16(4096+blockOffset(0,0,32,8),0xf800,true);
  blocks.setUint16(blockOffset(16,0,16,8),0x07e0,true);
  const path="data/ttdb/terrain/fixture.ttpf",archive=new Archive(path,new Blob([bytes]));
  const pack=await loadPack(archive),texture=pack.descriptors[0];
  expect(texture.surface).toEqual({format:72,dimension:1,depth:1,mipLevels:4});
  const textures=new StreetTextures(new Map(),new Map([[path,pack]]));
  const image=await textures.image(texture.id,true);
  expect([image?.width,image?.height]).toEqual([128,96]);
  expect([...image!.rgba.slice(0,4)]).toEqual([255,0,0,255]);
  const {readPoolBc1}=await import("../src/texture-pool-blocks");
  const tail=await readPoolBc1(pack,texture,64,false);
  expect([tail?.width,tail?.height]).toEqual([64,48]);
  expect([...tail!.rgba.slice(0,4)]).toEqual([0,255,0,255]);
  const linear={...texture,surface:{...texture.surface!,format:71}};
  const normal=await readTerrainLayerInput(pack,linear,"normal");
  expect([normal?.width,normal?.height]).toEqual([128,96]);
  expect([...normal!.rgba.slice(0,4)]).toEqual([255,0,0,255]);
  const masks=new StreetTextures(new Map(),new Map([[path,{...pack,descriptors:[linear]}]]));
  const mask=await masks.image(`terrain-layer:material-mask:${linear.id}`,false);
  expect(mask).toEqual(normal);
  expect(await readPoolBc1(pack,{...texture,surface:{...texture.surface!,depth:2}},64,false)).toBeNull();
  expect(await readPoolBc1({...pack,eofAddress:16384},texture,64,false)).toBeNull();
});

test("single-mip BC1 material reads its first block rather than the packed tail",async()=>{
  const path="data/ttdb/maps/one-block.ttpf",id="0x0000000000000001";
  const bytes=new Uint8Array(4096);
  view(bytes).setUint16(0,0xffff,true);
  const texture:Texture={id,pack:path,index:0,descriptorOffset:0,width:4,height:4,mode:0x240,
    start:0,end:1,mipCount:2,tileMode:1,surface:{format:72,dimension:1,depth:1,mipLevels:1}};
  const pack:Pack={source:new Archive(path,new Blob([bytes])),descriptors:[texture],
    offsets:[0,bytes.length],addresses:[0],eofAddress:bytes.length,codecs:new Uint8Array(1),padding:new Uint16Array(1)};
  const loader=new StreetTextures(new Map(),new Map([[path,pack]]));
  const image=await loader.image("terrain-layer:color:"+id,false);
  expect(image?.rgba.every(value=>value===255)).toBeTrue();
});

test("a BCPack top level can use a lower BC1 level in a readable chunk",async()=>{
  const tail=new Uint8Array(12288),blocks=view(tail);
  for(let y=0;y<32;y++)for(let x=0;x<32;x++)
    blocks.setUint16(4096+blockOffset(x,y,32,8),0xf800,true);
  const compressed=zlibSync(tail);
  const topOffset=512+256*Math.ceil(compressed.length/256);
  const bytes=new Uint8Array(topOffset+256),header=view(bytes);
  bytes.set(new TextEncoder().encode("RDS5"));
  header.setUint32(4,4,true);
  header.setBigUint64(24,2n|(0x20n<<24n)|(BigInt(topOffset-512-compressed.length)<<52n),true);
  header.setBigUint64(32,BigInt(topOffset/256)|(4n<<24n)|(3n<<30n),true);
  header.setBigUint64(40,BigInt(bytes.length/256)|(11n<<30n),true);
  bytes.set(new TextEncoder().encode("ETPF"),48);
  header.setUint32(52,0x27a,true);header.setUint32(56,1,true);
  header.setUint32(64,255|(255<<14)|(6<<28),true);
  header.setUint32(68,0x02000241,true);
  header.setBigUint64(80,0xdef0aabbccddeeffn,true);
  bytes.set(compressed,512);
  const path="data/ttdb/maps/synthetic.ttpf";
  const source=new StreetTextures(new Map([[path,new Archive(path,new Blob([bytes]))]]),new Map());
  const image=await source.image("0xdef0aabbccddeeff",false);
  expect([image?.width,image?.height]).toEqual([128,128]);
  expect([...image!.rgba.slice(0,4)]).toEqual([255,0,0,255]);
  const match=new Archive("data/ttdb/maps/ttdb_maps_7_7.ttpf",new Blob([bytes]));
  const unrelated=new Archive("data/ttdb/maps/ttdb_maps_0_7.ttpf",new Blob([bytes]));
  const candidates=new Map([[unrelated.path,unrelated],[match.path,match]]);
  const checked:string[]=[];
  const routed=new StreetTextures(candidates,new Map(),new Set(candidates.values()),async archive=>{checked.push(archive.path);});
  expect(await routed.image("0xdef0aabbccddeeff",false)).toEqual(image);
  expect(unrelated.bytesRead).toBe(0);
  expect(checked).toEqual([match.path]);
  const rejected=new StreetTextures(candidates,new Map(),new Set(candidates.values()),async()=>{throw new Error("Fixture mismatch");});
  expect(await rejected.image("0xdef0aabbccddeeff",false)).toBeNull();
});

test("BCPack BC1 WASM decodes a synthetic stream and rejects truncation",async()=>{
  // Synthetic vector 11 from the pinned bcpack-rs release, with the default tables.
  const packed=Buffer.from(`
FRQbG98QExQ9PgkRAygUAwEB9RwBEAURcRe3rwAP/VRs0uqkdGjcdmwQK+0dZQH0GxiR48F0GxgcJwMc1QVJKCEj86aBBh1r
q2XbipPcqD2oBGb1GlQ93xqTSncbNjyTYCIxKsSjJZ+X4fyheWbQu6EYKMTHJ65j1twC7btyCgovrvQq5OwRp5HWwj0fX+np
9XE0x1Iay4DUCiL9CVv5ZO9UOqogkwY5hBUB/23HTLojXStdJV49skUZFUmL5l65CCpFDHTaGvDXFgG8zkfwefMaWOlq3wN3
JxFzhQ3kgwEAY2u/Z0OFzXUiPzsMTQvq3PcJAwEM9QujFog9kyAlFrfYLFnonwSHLn4EwWtC/BWXtRUTKxhgAXIHxFbgEqf0
x5yOe/v7oBGWB3w0fQXblwsymd/2LN7wXSFJZD1qfiBr+bF5IiC2lGRPo9INhB5EcAlRiz5nNgd6mrs1eZQDDySPdxGvzR0F
NN85hVeJhsWietQTmu12Um8sJT3gIx3zou5muE4zOvPKpEIsiCu0P9GRavEnUARdlrbEH+uVyvYDAQRIEZ9tI/YeUIF++5EY
DreoTlYJ9ug14fNSFwoBrks97/+FpVnaLmYGb/YwNi2ZsF+GJdWzRidi8tDSh/eWAJw10iuIFIVrIIiHYPDBDHdy09MgA+U9
lyBGMZTgpMCA9kw=
  `,"base64");
  const fetchOriginal=globalThis.fetch;
  globalThis.fetch=((input,init)=>{
    if(input instanceof URL&&input.pathname.endsWith("/bcpack-decode.wasm"))
      return Promise.resolve(new Response(Bun.file(new URL("../third-party/bcpack-decode.wasm",import.meta.url))));
    return fetchOriginal(input,init);
  }) as typeof fetch;
  try{
    const blocks=await decodeBcpackBc1(packed,512);
    expect(blocks?.length).toBe(512);
    expect(new Bun.CryptoHasher("sha256").update(blocks!).digest("hex"))
      .toBe("4132fc94d85d8eb4dbe94641d754efa04e523669defe495724a02d6956ebf271");
    expect(await decodeBcpackBc1(packed.subarray(0,64),512)).toBeNull();
  }finally{
    globalThis.fetch=fetchOriginal;
  }
});

test("strict BCPack BC3 and BC5 restore endpoints, history and index pairs",()=>{
  // One-block uniform rANS fixtures. The BC5 stream uses confirmed history entry 255.
  const bc3=Buffer.from("EBAQEBAQEBAEBAMEBAQEAwEBARAQEBAEAAAABAgICAACAgIEAAAAUAEBAQAJCQkQAgIREREREBADAxAQEAQDAwAAAQEwMAEAEEAAAgMD","base64");
  const bc5=Buffer.from("EBAQEBAQEBADBAMEBAQEBAEBAQEQEBAQAAAAAQQICAgBAgIEBAAAABEBAQAACQkJAgIREREREBAEBBAQEBAEBAQIEBAIAAgIAAkAABERCQkREQ==","base64");
  expect(Buffer.from(decodeBcpackColor(bc3,16,3)??[]).toString("hex")).toBe("817f090000000000c3284408a5a50f0f");
  expect(Buffer.from(decodeBcpackColor(bc5,16,5)??[]).toString("hex")).toBe("827e090000000000827e240000000000");
  expect(decodeBcpackColor(bc5.subarray(0,-1),16,5)).toBeNull();
  expect(decodeBcpackColor(Buffer.concat([bc3,Buffer.from([1])]),16,3)).toBeNull();
});

test("BC1 GPU materials preserve authored mip coordinates and cutout alpha",async()=>{
  const start=512,top=start+12288,end=top+32768;
  const bytes=new Uint8Array(end),header=view(bytes);
  bytes.set(new TextEncoder().encode("RDS5"));
  header.setUint32(4,4,true);
  header.setBigUint64(24,BigInt(start/256),true);
  header.setBigUint64(32,BigInt(top/256)|(3n<<30n),true);
  header.setBigUint64(40,BigInt(end/256)|(11n<<30n),true);
  bytes.set(new TextEncoder().encode("ETPF"),48);
  header.setUint32(52,0x27a,true);header.setUint32(56,1,true);
  header.setUint32(64,255|(255<<14)|(4<<28),true);
  header.setUint32(68,0x02000243,true);
  header.setBigUint64(80,0xdef0aabbccddeeffn,true);
  const secondTile=top+blockOffset(32,0,64,8);
  header.setUint16(secondTile,0x001f,true);
  header.setUint16(secondTile+2,0xf800,true);
  header.setUint32(secondTile+4,3,true);
  header.setUint16(start+2048,0x07e0,true);

  const path="data/ttdb/maps/synthetic.ttpf";
  const source=new StreetTextures(new Map([[path,new Archive(path,new Blob([bytes]))]]),new Map());
  const id="0xdef0aabbccddeeff";
  const blocks=await source.compressedBaseColor(id);
  expect(blocks?.levels.map(({width,height,blocks})=>[width,height,blocks.length]))
    .toEqual([[256,256,32768],[128,128,8192],[64,64,2048],[32,32,512],[16,16,128]]);
  expect(blocks?.alphaCutout).toBeTrue();
  expect(view(blocks!.levels[0].blocks).getUint16(32*8,true)).toBe(0x001f);
  expect(view(blocks!.levels[2].blocks).getUint16(0,true)).toBe(0x07e0);
  expect((await source.image(id,false))?.rgba[4*128+3]).toBe(0);
});

test("compact BC7 materials decode the authored top mip at its packed tile coordinates",async()=>{
  const path="data/ttdb/maps/compact.ttpf",id="0x0000000000000001";
  const bytes=new Uint8Array(8192);
  const colorBlock=(r:number,g:number,b:number)=>{
    // BC7 mode 6, identical endpoints and zero indices give a constant color.
    let bits=64n,offset=7n;
    for(const value of [r,r,g,g,b,b,127,127]){
      bits|=BigInt(value)<<offset;
      offset+=7n;
    }
    const block=new Uint8Array(16);
    for(let i=0;i<16;i++)block[i]=Number((bits>>BigInt(8*i))&255n);
    return block;
  };
  const red=colorBlock(127,0,0),green=colorBlock(0,127,0),blue=colorBlock(0,0,127);
  bytes.set(red,0);
  for(let y=0;y<2;y++)for(let x=0;x<16;x++){
    const tileIndex=y|((x&3)<<2)|((x&4)<<3)|((x&8)<<4);
    bytes.set(x===15&&y===1?blue:green,4096+tileIndex*16);
  }
  const source=new Archive(path,new Blob([bytes]));
  const texture:Texture={id,pack:path,index:0,descriptorOffset:0,width:64,height:8,
    mode:0x318,start:0,end:1,mipCount:3,tileMode:1,
    surface:{format:99,dimension:1,depth:1,mipLevels:2}};
  const pack:Pack={source,descriptors:[texture],offsets:[0,bytes.length],addresses:[0],
    eofAddress:bytes.length,codecs:new Uint8Array(1),padding:new Uint16Array(1)};
  const fetchOriginal=globalThis.fetch;
  globalThis.fetch=Object.assign((input:RequestInfo|URL,init?:RequestInit)=>
    String(input).endsWith("/night-decode.wasm")?
      Promise.resolve(new Response(Bun.file(new URL("../third-party/night-decode.wasm",import.meta.url)))):
      fetchOriginal(input,init),{preconnect:fetchOriginal.preconnect});
  try{
    const textures=new StreetTextures(new Map(),new Map([[path,pack]]));
    const image=await textures.image(id,false);
    expect([image?.width,image?.height]).toEqual([64,8]);
    expect([...image!.rgba.slice(0,4)]).toEqual([0,254,0,254]);
    expect([...image!.rgba.slice(-4)]).toEqual([0,0,254,254]);
    const linear={...texture,surface:{...texture.surface!,format:98}};
    const normal=await readTerrainLayerInput(pack,linear,"normal");
    expect([normal?.width,normal?.height]).toEqual([64,8]);
    expect([...normal!.rgba.slice(0,4)]).toEqual([0,254,0,254]);
    for(const mode of [0x311,0x313]){
      const maskTexture={...linear,mode};
      const materials=new StreetTextures(new Map(),new Map([[path,{...pack,descriptors:[maskTexture]}]]));
      expect(await materials.image(`terrain-layer:material-mask:${id}`,false)).toEqual(normal);
    }
    const wide=new Uint8Array(2*65536);
    // The 128px mip starts in the packed tail; mip zero is a standalone page.
    wide.set(blue,32768);
    wide.set(green,65536);
    const glass={...texture,width:256,height:256,mode:0x31b,tileMode:0};
    const glassPack={...pack,source:new Archive(path,new Blob([wide])),descriptors:[glass],
      offsets:[0,wide.length],eofAddress:wide.length};
    const glassTextures=new StreetTextures(new Map(),new Map([[path,glassPack]]));
    const glassId=`terrain-layer:room-glass:${id}`;
    const blocks=await glassTextures.compressedRoomGlass(glassId);
    expect(blocks?.format).toBe("bc7");
    expect(blocks?.levels.map(({width,height,blocks})=>[width,height,blocks.length]))
      .toEqual([[256,256,65536],[128,128,16384]]);
    expect(blocks?.levels[0].blocks.slice(0,16)).toEqual(green);
    expect(blocks?.levels[1].blocks.slice(0,16)).toEqual(blue);
    const glassImage=await glassTextures.image(glassId,false);
    expect([...glassImage!.rgba.slice(0,4)]).toEqual([0,254,0,254]);
    expect([...glassImage!.authoredMips![0].rgba.slice(0,4)]).toEqual([0,0,254,254]);
  }finally{
    globalThis.fetch=fetchOriginal;
  }
});

test("street BC1 pages keep block coordinates across 4 KiB boundaries",async()=>{
  const start=512,top=start+4096,end=top+65536;
  const bytes=new Uint8Array(end),header=view(bytes);
  bytes.set(new TextEncoder().encode("RDS5"));
  header.setUint32(4,4,true);
  header.setBigUint64(24,BigInt(start/256),true);
  header.setBigUint64(32,BigInt(top/256)|(1n<<30n),true);
  header.setBigUint64(40,BigInt(end/256)|(17n<<30n),true);
  bytes.set(new TextEncoder().encode("ETPF"),48);
  header.setUint32(52,0x27a,true);header.setUint32(56,1,true);
  header.setUint32(64,511|(255<<14)|(5<<28),true);
  header.setUint32(68,0x243,true);
  header.setBigUint64(80,0xdef0aabbccddeeffn,true);
  // Block x32 is at address bit 10, and block y16 is at bit 9.
  header.setUint16(top+(1<<10)*8,0xf800,true);
  header.setUint16(top+(1<<9)*8,0x07e0,true);
  const path="data/ttdb/maps/synthetic.ttpf";
  const source=new StreetTextures(new Map([[path,new Archive(path,new Blob([bytes]))]]),new Map());
  const image=await source.image("0xdef0aabbccddeeff",false);
  expect([image?.width,image?.height]).toEqual([512,256]);
  const pixel=(x:number,y:number)=>[...image!.rgba.slice((y*512+x)*4,(y*512+x)*4+4)];
  expect(pixel(128,0)).toEqual([255,0,0,255]);
  expect(pixel(0,64)).toEqual([0,255,0,255]);
});

test("road displacement reads the BC4 red channel from the authored top mip",async()=>{
  const path="data/ttdb/maps/control.ttpf",id="0x0000000000000010";
  const bytes=new Uint8Array(12288);
  // Mip 1 occupies the first page. Mip 0 reaches a second 4 KiB tile in X.
  bytes.set([22,22],0);
  bytes.set([140,0,2],4096);
  bytes.set([200,200],8192);
  const texture:Texture={id,pack:path,index:0,descriptorOffset:0,width:256,height:64,
    mode:0x283,start:0,end:2,mipCount:1,tileMode:1,
    surface:{format:80,dimension:1,depth:1,mipLevels:2}};
  const pack:Pack={source:new Archive(path,new Blob([bytes])),descriptors:[texture],
    offsets:[0,4096,bytes.length],addresses:[0,4096],eofAddress:bytes.length,
    codecs:new Uint8Array(2),padding:new Uint16Array(2)};
  const load=(candidate:Pack)=>new StreetTextures(new Map(),new Map([[path,candidate]])).image("road-control:"+id,false);
  const image=await load(pack);
  expect([image?.width,image?.height,image?.baseLevelOnly]).toEqual([256,64,true]);
  expect([...image!.rgba.slice(0,4)]).toEqual([120,0,0,255]);
  expect([...image!.rgba.slice(512,516)]).toEqual([200,0,0,255]);
  expect(await load({...pack,codecs:new Uint8Array([0,1])})).toBeNull();
});

test("interior cube reads each face after its lower mips and linearizes its blocks",async()=>{
  const path="data/ttdb/maps/sample.ttpf";
  for(const [format,mode,blockBytes] of [[72,0x643,8],[95,0x6fb,16]] as const){
    const tail=blockBytes*512,faceBytes=blockBytes*1024,stride=tail+faceBytes;
    const start=6*tail,size=6*stride;
    const bytes=new Uint8Array(start+size);
    for(let face=0;face<6;face++){
      const origin=start+face*stride;
      bytes[origin]=255;
      bytes[origin+tail+blockOffset(31,31,32,blockBytes)]=face+1;
      const offset=blockBytes===8?blockOffset(16,0,32,8):4096;
      bytes[face*tail+offset]=face+7;
    }
    const texture:Texture={id:"0x0000000000000001",pack:path,index:0,descriptorOffset:0,width:128,height:128,
      mode,start:0,end:2,mipCount:6,tileMode:12,surface:{format,dimension:2,depth:6,mipLevels:8}};
    const pack:Pack={source:new Archive(path,new Blob([bytes])),descriptors:[texture],
      offsets:[0,start,start+size],addresses:[0,start],eofAddress:start+size,codecs:new Uint8Array(2),padding:new Uint16Array(2)};
    const cube=await readStreetCube(pack,texture);
    expect(cube?.format).toBe(format===72?"bc1-srgb":"bc6h-unsigned");
    expect(cube?.levels.map(level=>level.side)).toEqual([128,64,32,16,8,4,2,1]);
    const blocks=cube!.levels[0].blocks;
    expect(Array.from({length:6},(_,face)=>blocks[(face+1)*faceBytes-blockBytes])).toEqual([1,2,3,4,5,6]);
    expect(blocks.includes(255)).toBeFalse();
    const small=cube!.levels[1].blocks;
    expect(Array.from({length:6},(_,face)=>small[face*small.length/6])).toEqual([7,8,9,10,11,12]);
    expect(await readStreetCube({...pack,eofAddress:pack.eofAddress-4096},texture)).toBeNull();
  }
});

test("a drawable must have a self-referencing shader binding",()=>{
  const payload=new Uint8Array(1024),raw=view(payload);
  const system=0x50000000,x=0x80,footer=0x1c0,nameAt=0x200,id=0x9911223344556677n;
  payload.set(new TextEncoder().encode("n01_w01_001_lod.#dr\0"),nameAt);
  raw.setBigUint64(x,BigInt(system+nameAt),true);
  raw.setFloat32(x-0x68,64,true);raw.setFloat32(x-0x64,64,true);
  raw.setBigUint64(x-0x58,BigInt(system+footer),true);
  raw.setBigUint64(footer-32,6n,true);raw.setBigUint64(footer-16,BigInt(system+footer-32+5),true);
  raw.setBigUint64(footer-8,id,true);
  const map=new Map([[id,{id:"0x9911223344556677",width:1024,height:1024,mode:0x243} as Texture]]);
  const valid=readDrawables(payload,2**35,"lod",map);
  expect(valid[0].meshes.get("0x9911223344556677")?.offset).toBe(2**35);
  raw.setBigUint64(footer-16,0n,true);
  expect(readDrawables(payload,2**35,"lod",map)).toHaveLength(0);
});

test("manual edits round-trip and cannot overwrite recovered tiles",()=>{
  const id="0x9911223344556677";
  const atlas:Atlas={build:"synthetic",world:[-5,-5,10,10],sectors:[],catalog:[id],
    cells:[{x:0,y:0,id,meshes:[]}],optional:[],textures:{[id]:{} as Texture}};
  const fills=new Map([["2,-1",id]]);
  expect(parseEdits(serialize(atlas.build,fills),atlas)).toEqual(fills);
  expect(()=>parseEdits({version:1,build:atlas.build,fills:[[0,0,id]]},atlas)).toThrow("Invalid fill");
  expect(()=>parseEdits({version:1,build:atlas.build,fills:[[2,-1,id],[2,-1,id]]},atlas)).toThrow();
  atlas.cells.push({x:2,y:-1,id,meshes:[],recovery:"seams"});
  expect(parseEdits(serialize(atlas.build,fills),atlas)).toEqual(fills);
});

test("color sketches and edge match both prefer the consistent tile",()=>{
  const make=(r:number,g:number,b:number)=>describe({width:32,height:32,
    rgba:Uint8ClampedArray.from({length:32*32*4},(_,i)=>[r,g,b,255][i%4])});
  const red=make(255,0,0),green=make(0,255,0);
  const points=[{x:.5,y:.5,color:[255,0,0] as [number,number,number]}];
  expect(score(red,[],points)).toBeLessThan(score(green,[],points));
  expect(score(red,[{direction:1,features:red}],[])).toBe(0);
  expect(score(green,[{direction:1,features:red}],[])).toBeGreaterThan(0);
});
test("close material refinements reuse compressed blocks on a new loader",async()=>{
  const blocks=new Map<string,StreetBlockTexture>();
  const cache={
    get:async(kind:string,key:string)=>kind==="blocks"?blocks.get(key):undefined,
    put:(kind:string,key:string,value:StreetBlockTexture)=>{if(kind==="blocks")blocks.set(key,structuredClone(value));},
  } as Pick<StreetAssetCache,"get"|"put"> as StreetAssetCache;
  let decodes=0;
  const makeLoader=()=>Object.assign(new StreetMaterialLoader({},cache),{openTextures:()=>({
    compressedCloseColor:async(_:string,compression:number):Promise<StreetBlockTexture>=>{
      decodes++;
      const bc1=compression===compressedMaterialFormats.bc1;
      return {format:bc1?"bc1":"bc7",levels:[{width:4,height:4,blocks:new Uint8Array(bc1?8:16)}]};
    },
  })});
  const request={kind:"streetTexture",epoch:0,id:closeMaterialPrefix+"0x0000000000000001",
    ground:false,compression:compressedMaterialFormats.bc1} as const;
  const first=await makeLoader().read(request),second=await makeLoader().read({...request,epoch:1});
  expect(second.event.compressed).toEqual(first.event.compressed);
  expect(second.event.cached).toBe(true);
  expect(decodes).toBe(1);
  const changed=await makeLoader().read({...request,compression:compressedMaterialFormats.bc7});
  expect(changed.event.compressed?.format).toBe("bc7");
  expect(decodes).toBe(2);
});

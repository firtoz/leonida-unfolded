import {StreetEdgeAA} from "./street-edge-aa";
import {install as installOpaque,disposeOpaque} from "./street-opaque-program";
import {rendererReview} from "./street-renderer-review";
import type { StreetFpsChart } from "./street-fps-chart";
import type { StreetChunk, StreetMesh } from "./street-mesh";
import { nativePackedTintMaterial, nativePaletteMaterial } from "./street-vegetation";
import { CELL, type Rect } from "./recover";
import { streetHorizon, streetWaterBackdropUnit, StreetWorld } from "./street-world";
import { overviewTerrainTileSize, streetNearPlane } from "./street-grid";
import { makeProgram, uniforms } from "./view-gl";
import { defaultStreetFov, headingDegrees, maximumStreetPitch, streetProjection, type StreetDestination } from "./street-destination";
import {standardPaletteMaterial,terrainDetailUnits,type StreetBlockTexture,type StreetTextureImage} from "./street-terrain-material";
import { roadDetailFarDepth, type RoadHeightMip } from "./street-road-material";
import {streetRoomCubeUnit,type StreetCubeTexture} from "./street-cube-texture";
import {streetRoomShader} from "./street-room-material";
import {interiorClipEdgeCapacity} from "./street-interior";
import {streetPropParallaxShader} from "./street-prop-parallax";
import type {StreetPendingBox,StreetStreamView} from "./street-priority";
import {streetLighting,streetProjectionFarPlane} from "./street-lighting";
import type { StreetEnvironment } from "./street-environment";
import type { StreetWaterOptics } from "./street-water-optics";
import type { StreetWaterMaterials } from "./street-water-materials";
import type { StreetOceanSource } from "./street-ocean-worker";
import { StreetOceanWaves,streetOceanWaveUnits } from "./street-ocean-waves";
import {streetDistantShadowUnit,streetShadowUnit,StreetShadows} from "./street-shadows";
import {streetCloudNoiseUnit,streetCloudShadowUnit,streetPreviousSkyUnit,streetSkyUnit,StreetSky} from "./street-sky";
import {nativeCloudVolumeShader,StreetNativeClouds,streetCloudDensityUnit,streetNativeCloudNoiseUnit} from "./street-native-clouds";
import type {StreetCloudAssets} from "./street-cloud-assets";
import {streetWaterReflectionUnit} from "./street-water-reflection";
import {StreetFrameBudget} from "./street-frame-budget";
import {atmosphericScattering} from "./street-atmosphere";
import {nativeCanopyMaterial} from "./street-canopy-atlas";
import type {Bounds} from "./native-spatial";

const canopyBasis=`
vec3 canopyRight(vec3 axis,vec3 toward){
  vec3 right=cross(axis,toward);
  if(dot(right,right)<1e-8)right=cross(abs(toward.x)<0.8?vec3(1,0,0):vec3(0,1,0),toward);
  return normalize(right);
}
vec3 canopyTileNormal(vec2 tile){
  vec2 xy=vec2(tile.x-tile.y,tile.x+tile.y-7.0)/7.0;
  return normalize(vec3(xy,(1.0-abs(xy.x)-abs(xy.y))*8.0/7.0-1.0/7.0));
}`;

const vertex=`#version 300 es
#ifndef STREET_ROOMS
#define STREET_ROOMS 0
#endif
precision highp float;
layout(location=0) in vec4 mesh;
layout(location=1) in vec2 texcoord;
layout(location=2) in vec3 instancePosition;
layout(location=3) in vec4 instanceRotation;
layout(location=4) in vec3 instanceScale;
layout(location=5) in vec3 instanceThirdRow;
layout(location=6) in vec3 vertexNormal;
layout(location=7) in vec2 roadUV;
layout(location=8) in vec4 roadVertexWeights;
layout(location=9) in float vertexDecalOpacity;
layout(location=10) in float vertexDecalBlend;
layout(location=11) in vec4 vertexTerrainColor;
layout(location=12) in vec4 vertexTerrainTangent;
layout(location=13) in vec2 vertexTintUV;
layout(location=14) in vec4 vertexSecondaryTangent;
layout(location=15) in vec4 instanceExtras;
uniform vec3 eye;
uniform bool roadHasParallax;
uniform vec2 heading;
uniform vec2 pitch;
uniform float aspect;
uniform float projectionScale;
uniform float nearPlane;
uniform float inverseHalfFarPlane;
uniform bool skyPass;
uniform bool shadowPass;
uniform bool decalPaletteEnabled;
uniform vec3 sunDirection;
uniform vec4 shadowX,shadowY,shadowZ;
uniform bool lightingEnabled;
uniform bool waterReflectionPass;
uniform float waterReflectionPlane;
uniform float waterTime;
uniform float waveStrength;
uniform vec2 waterOrigin;
uniform int instanced;
uniform vec2 propLayerState;
uniform highp vec4 propParallaxMarch;
uniform vec2 staticLayerState;
uniform highp sampler2D propPalette;
uniform vec4 packedSlodCenter;
uniform vec4 octaViewWeights;
uniform bool frontOnlyDecal;
uniform vec3 vegetationRange;
uniform vec2 cropChildRange;
out vec3 world;
out vec3 surfaceNormal;
out vec2 materialUV;
out vec2 roadSecondaryUV;
out vec4 roadWeights;
#if STREET_ROOMS
flat out vec4 roomDimensions;
flat out vec2 roomSizeUV;
uniform vec4 roomAbsorption;
#endif
out float decalOpacity;
out float decalBlend;
out vec4 terrainVertexColor;
flat out float propLayerAux;
out float propLayerDirtWeight;
out vec2 propParallaxVertex;
out vec4 terrainTangent;
out vec4 terrainSecondaryTangent;
out vec2 terrainThirdUV;
flat out float material;
flat out int mirroredInstance;
flat out float vegetationCoverage;
flat out vec3 canopyTiles;
flat out vec3 canopyWeights;
flat out vec4 cropImpostor;
flat out float cropHandoff;
out vec4 canopyUV0,canopyUV1,canopyUV2;
out float viewDepth;
flat out vec3 canopyLight,canopyAxis;
flat out float canopyDepthSpan;
out vec2 skyPoint;
vec3 rotateVector(vec3 point){
  vec3 r=2.0*cross(instanceRotation.xyz,point);
  return point+instanceRotation.w*r+cross(instanceRotation.xyz,r);
}
${canopyBasis}
vec4 projectCanopyTile(vec2 tile,vec3 axis,vec3 point,vec3 ray,float radius,vec2 aspect){
  vec3 normal=canopyTileNormal(tile);
  vec3 u=canopyRight(axis,normal),v=cross(u,normal);
  vec2 base=0.5+vec2(dot(point,u),dot(point,v))/(2.0*radius*aspect);
  return vec4(base,base-0.5*vec2(dot(ray,u),dot(ray,v))/aspect);
}
void orderCanopyViews(inout float a,inout float b,inout vec2 tileA,inout vec2 tileB){
  if(a>=b)return;
  float weight=a;a=b;b=weight;
  vec2 tile=tileA;tileA=tileB;tileB=tile;
}
void main(){
  if(skyPass){
    skyPoint=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2))*2.0-1.0;
    gl_Position=vec4(skyPoint,1.0,1.0);
    return;
  }
  if(instanced==2&&packedSlodCenter.w>0.0){
    vec3 delta=instancePosition-eye;
    float horizontalScale=length(vec3(instanceRotation.x,instanceScale.x,instanceThirdRow.x));
    vec3 centerDelta=delta+packedSlodCenter.xyz*horizontalScale;
    float distanceSquared=dot(centerDelta,centerDelta);
    float pivotDistanceSquared=dot(delta,delta);
    if(pivotDistanceSquared>instanceExtras.x*instanceExtras.x||
       pivotDistanceSquared<=instanceExtras.y*instanceExtras.y||
       distanceSquared<instanceExtras.z*instanceExtras.z||
       distanceSquared>instanceExtras.w*instanceExtras.w){
      gl_Position=vec4(2.0,0.0,0.0,1.0);
      return;
    }
  }
  vegetationCoverage=1.0;
  if(instanced!=0&&vegetationRange.y>0.0){
    float distanceToInstance=length(instancePosition-eye);
    vegetationCoverage=vegetationRange.x<vegetationRange.y
      ?(vegetationRange.z>0.0
        ?clamp((vegetationRange.y-distanceToInstance)/(vegetationRange.y-vegetationRange.x),0.0,1.0)
        :1.0-smoothstep(vegetationRange.x,vegetationRange.y,distanceToInstance))
      :float(distanceToInstance<=vegetationRange.y);
    // Coverage is constant across the instance. Zero coverage would discard
    // every fragment in both the color and shadow passes.
    if(vegetationCoverage<=0.0){
      gl_Position=vec4(2.0,0.0,0.0,1.0);
      return;
    }
  }
  world=mesh.xyz;
  materialUV=texcoord;
  surfaceNormal=vertexNormal;
  vec3 tangent=vertexTerrainTangent.xyz;
  mat3 canopyNormalMatrix;
  mirroredInstance=0;
  if(instanced==2){
    vec3 cx=cross(instanceScale,instanceThirdRow);
    vec3 cy=cross(instanceThirdRow,instanceRotation.xyz);
    vec3 cz=cross(instanceRotation.xyz,instanceScale);
    float determinant=dot(instanceRotation.xyz,cx);
    if(mesh.w==${nativeCanopyMaterial}.0){
      canopyNormalMatrix=mat3(cx,cy,cz)*sign(determinant);
      vec3 center=mesh.xyz;
      vec3 centerWorld=vec3(dot(instanceRotation.xyz,center),dot(instanceScale,center),dot(instanceThirdRow,center))+instancePosition;
      vec3 delta=shadowPass?sunDirection:eye-centerWorld;
      if(waterReflectionPass)delta.z=2.0*waterReflectionPlane-eye.z-centerWorld.z;
      vec3 localEye=(cx*delta.x+cy*delta.y+cz*delta.z)/determinant;
      vec3 toward=localEye;
      toward=dot(toward,toward)>1e-8?normalize(toward):vec3(1.0,0.0,0.0);
      vec3 axis=texcoord.y==0.0?vec3(1,0,0):texcoord.y==1.0?vec3(0,1,0):vec3(0,0,1);
      vec3 worldToward=vec3(dot(instanceRotation.xyz,toward),dot(instanceScale,toward),dot(instanceThirdRow,toward));
      if(shadowPass){
        canopyLight=toward;
        canopyAxis=axis;
        canopyDepthSpan=-dot(shadowZ.xyz,worldToward)*texcoord.x;
      }else canopyDepthSpan=length(worldToward)*texcoord.x;
      vec3 right=canopyRight(axis,toward);
      materialUV=vec2(float(gl_VertexID==1||gl_VertexID==2),float(gl_VertexID>=2));
      cropImpostor=vertexTerrainTangent;
      vec2 canopyAspect=cropImpostor.x>0.0?cropImpostor.xy:vec2(1.0);
      cropHandoff=1.0;
      if(cropChildRange.y>cropChildRange.x){
        cropHandoff=clamp((length(instancePosition-eye)-cropChildRange.x)/(cropChildRange.y-cropChildRange.x),0.0,1.0);
      }
      vec2 corner=(materialUV*2.0-1.0)*canopyAspect;
      vec3 point=(right*corner.x+cross(right,toward)*corner.y)*texcoord.x;
      world=center+point;
      surfaceNormal=toward;
      float up=clamp((toward.z+1.0/14.0)*(14.0/15.0),0.0,1.0);
      float denom=max(1e-5,abs(toward.x)+abs(toward.y)+up);
      vec2 view=3.5*clamp(1.0+vec2(toward.y+toward.x,toward.y-toward.x)/denom,0.0,2.0);
      vec2 tile=floor(view),f=fract(view);
      vec2 t0=clamp(tile+float(f.x+f.y>1.0),0.0,7.0);
      vec2 t1=clamp(tile+vec2(1.0,0.0),0.0,7.0);
      vec2 t2=clamp(tile+vec2(0.0,1.0),0.0,7.0);
      canopyWeights=vec3(abs(1.0-f.x-f.y),min(f.x,1.0-f.y),min(f.y,1.0-f.x));
      if(!shadowPass&&octaViewWeights.w>0.0){
        orderCanopyViews(canopyWeights.x,canopyWeights.y,t0,t1);
        orderCanopyViews(canopyWeights.y,canopyWeights.z,t1,t2);
        orderCanopyViews(canopyWeights.x,canopyWeights.y,t0,t1);
        float ramp=clamp(length(delta)*octaViewWeights.x+octaViewWeights.y,0.0,1.0);
        float scale=mix(octaViewWeights.z,octaViewWeights.w,ramp);
        vec2 offCenter=abs(view-3.5);
        float bias=(2.0/7.0)*scale*max(offCenter.x,offCenter.y)*(canopyWeights.x-1.0/3.0);
        float first=canopyWeights.x+bias;
        float middle=clamp(canopyWeights.y-bias*.5,0.0,1.0);
        // The native shader clamps each export and can leave a sum above one.
        canopyWeights=vec3(clamp(first,0.0,1.0),middle,clamp(clamp(1.0-first,0.0,1.0)-middle,0.0,1.0));
      }
      canopyTiles=vec3(dot(t0,vec2(1,8)),dot(t1,vec2(1,8)),dot(t2,vec2(1,8)));
      vec3 ray=shadowPass?-toward:normalize(point-localEye);
      canopyUV0=projectCanopyTile(t0,axis,point,ray,texcoord.x,canopyAspect);
      canopyUV1=projectCanopyTile(t1,axis,point,ray,texcoord.x,canopyAspect);
      canopyUV2=projectCanopyTile(t2,axis,point,ray,texcoord.x,canopyAspect);
    }
    world=vec3(dot(instanceRotation.xyz,world),dot(instanceScale,world),dot(instanceThirdRow,world))+instancePosition;
    tangent=vec3(dot(instanceRotation.xyz,tangent),dot(instanceScale,tangent),dot(instanceThirdRow,tangent));
    mirroredInstance=determinant<0.0?1:0;
    surfaceNormal=vec3(dot(cx,surfaceNormal),dot(cy,surfaceNormal),dot(cz,surfaceNormal))*sign(determinant);
  }else if(instanced==1){
    world=rotateVector(world*instanceScale.xxy)+instancePosition;
    surfaceNormal=rotateVector(vertexNormal/instanceScale.xxy);
    tangent=rotateVector(tangent*instanceScale.xxy);
  }
  if(dot(surfaceNormal,surfaceNormal)>0.0)surfaceNormal=normalize(surfaceNormal);
  roadSecondaryUV=roadUV;
  roadWeights=roadVertexWeights;
#if STREET_ROOMS
  roomDimensions=roadVertexWeights;
  roomSizeUV=vertexTintUV;
#endif
  decalOpacity=vertexDecalOpacity;
  decalBlend=vertexDecalBlend;
  terrainVertexColor=vertexTerrainColor;
  propLayerAux=-1.0;
  propLayerDirtWeight=0.0;
  propParallaxVertex=vec2(vertexTerrainColor.g,abs(instanceScale.x));
  if(!shadowPass&&propLayerState.x>0.0&&instanced==1&&instanceExtras.x<128.0){
    int width=int(propLayerState.x);
    int shift=8-(width&7);
    int variant=min(int(instanceExtras.x),(width>>shift)-1);
    int index=(variant<<shift)+int(round(vertexTerrainColor.b*255.0));
    int pitch=textureSize(propPalette,0).x;
    vec3 tint=texelFetch(propPalette,ivec2(index%pitch,index/pitch),0).rgb;
    terrainVertexColor=vec4(tint,vertexTerrainColor.r);
    propLayerAux=instanceExtras.y/255.0;
    propLayerDirtWeight=vertexTerrainColor.g*(instanceExtras.z/255.0);
    if(propParallaxMarch.x>0.0)
      propLayerDirtWeight=vertexTerrainColor.a*(instanceExtras.z<255.0?instanceExtras.z/255.0:.4);
  }
  if(mesh.w==${nativePaletteMaterial}.0||mesh.w==${standardPaletteMaterial}.0||decalPaletteEnabled||staticLayerState.x>0.0){
    vec3 rgb=vertexTerrainColor.rgb;
    terrainVertexColor.rgb=mix(rgb/12.92,pow((rgb+.055)/1.055,vec3(2.4)),step(.04045,rgb));
  }
#if STREET_ROOMS
  if(roomAbsorption.w>0.0){
    vec3 rgb=vertexTerrainColor.rgb;
    terrainVertexColor.rgb=mix(rgb/12.92,pow((rgb+.055)/1.055,vec3(2.4)),step(.04045,rgb));
  }
#endif
  if(mesh.w==${nativePackedTintMaterial}.0){
    terrainVertexColor=vec4(1.0,1.0,1.0,0.0);
    if(instanced==2&&instanceExtras.w==2.0){
      vec3 rgb=instanceExtras.rgb;
      terrainVertexColor=vec4(mix(vec3(1.0),rgb*rgb,vertexTintUV.x),vertexTintUV.y);
    }
  }
  terrainTangent=vec4(tangent,vertexTerrainTangent.w*(mirroredInstance==0?1.0:-1.0));
  terrainSecondaryTangent=vertexSecondaryTangent;
  if(mesh.w==${nativeCanopyMaterial}.0&&instanced==2){
    terrainTangent.xyz=canopyNormalMatrix[0];
    terrainSecondaryTangent.xyz=canopyNormalMatrix[1];
    terrainVertexColor.xyz=canopyNormalMatrix[2];
  }
  terrainThirdUV=vertexTintUV;
  material=mesh.w;
  if(shadowPass){
    vec4 point=vec4(world,1.0);
    gl_Position=vec4(dot(point,shadowX),dot(point,shadowY),dot(point,shadowZ),1.0);
    return;
  }
  if(lightingEnabled&&material==71.0){
    vec2 p=world.xy+waterOrigin;
    float swell=.10*sin(dot(p,vec2(.121,.169))-waterTime*1.01)
      +.055*sin(dot(p,vec2(-.21,.075))-waterTime*.73);
    world.z+=swell*waveStrength*smoothstep(.4,2.5,materialUV.x)*(1.0-smoothstep(95.0,230.0,distance(eye.xy,world.xy)));
  }
  vec3 d=world-eye;
  if(roadHasParallax){
    vec3 tangent=vertexSecondaryTangent.xyz;
    vec3 bitangent=cross(tangent,surfaceNormal)*vertexSecondaryTangent.w;
    float fade=(1.0-vertexDecalOpacity)*clamp(1.0-(length(d)-3.0)/15.0,0.0,1.0);
    terrainSecondaryTangent=vec4(dot(tangent,d),dot(bitangent,d),dot(surfaceNormal,d),fade);
  }
  if(waterReflectionPass)d.z=2.0*waterReflectionPlane-world.z-eye.z;
  // A shallow overlap with the receiver can outlast raster depth bias.
  if(frontOnlyDecal)d+=surfaceNormal*0.002;
  if(material==69.0)d.z+=0.045;
  float ahead=dot(d.xy,heading);
  float depth=ahead*pitch.x+d.z*pitch.y;
  viewDepth=depth;
  float up=d.z*pitch.x-ahead*pitch.y;
  float right=dot(d.xy,vec2(heading.y,-heading.x));
  gl_Position=vec4(right*projectionScale/aspect,up*projectionScale,
    depth*(1.0+nearPlane*inverseHalfFarPlane)-2.0*nearPlane,depth);
}`;
const canopyAtlasSampling=`
vec2 canopyTile(float tile){
  return vec2(mod(tile,8.0),floor(tile/8.0));
}
vec2 clampCanopyUV(vec2 uv){
  vec2 inset=vec2(8,4)/vec2(textureSize(materialColor,0));
  return clamp(uv,inset,1.0-inset);
}
vec2 canopyAtlasUV(float tile,vec2 uv){
  return (canopyTile(tile)+clampCanopyUV(uv))/vec2(16.0,8.0);
}
float canopyReprojection(vec3 coverage,vec3 depth,float total){
  return clamp(2.0*dot(coverage,0.5-depth)/(total+.00010001659),-1.0,1.0);
}`;

const fixedDepthShadowFragment=`#version 300 es
precision highp float;
in vec2 materialUV;
flat in float vegetationCoverage;
uniform sampler2D materialColor;
uniform int alphaLayer;
void main(){
  if(vegetationCoverage<=0.0||(alphaLayer==2&&texture(materialColor,materialUV).a<.5))discard;
}`;

const shadowFragment=`#version 300 es
precision highp float;
in vec2 materialUV;
flat in float material,vegetationCoverage,canopyDepthSpan;
flat in vec3 canopyTiles,canopyWeights,canopyLight,canopyAxis;
flat in vec4 cropImpostor;
in vec4 canopyUV0,canopyUV1,canopyUV2;
uniform sampler2D materialColor;
uniform int alphaLayer;
${canopyBasis}
${canopyAtlasSampling}
const vec2 depthHalf=vec2(.5,0.0);
float surfaceTowardSun(float tile,vec2 uv,float depth){
  vec3 normal=canopyTileNormal(canopyTile(tile));
  vec3 right=canopyRight(canopyAxis,normal);
  vec2 location=(clampCanopyUV(uv)-.5)*(cropImpostor.x>0.0?cropImpostor.xy:vec2(1.0));
  // Express the tile sample in the light-facing card's local depth.
  return dot(canopyLight,right*location.x+cross(right,normal)*location.y+normal*(.5-depth));
}
void main(){
  if(vegetationCoverage<=0.0)discard;
  gl_FragDepth=gl_FragCoord.z;
  if(alphaLayer!=2)return;
  if(material!=${nativeCanopyMaterial}.0){
    if(texture(materialColor,materialUV).a<.5)discard;
    return;
  }
  vec2 d0=texture(materialColor,canopyAtlasUV(canopyTiles.x,canopyUV0.xy)+depthHalf,4.0-3.0*canopyWeights.x).rg;
  vec2 d1=texture(materialColor,canopyAtlasUV(canopyTiles.y,canopyUV1.xy)+depthHalf,4.0-3.0*canopyWeights.y).rg;
  vec2 d2=texture(materialColor,canopyAtlasUV(canopyTiles.z,canopyUV2.xy)+depthHalf,4.0-3.0*canopyWeights.z).rg;
  vec3 coverage=canopyWeights*vec3(d0.g,d1.g,d2.g);
  float total=dot(coverage,vec3(1.0));
  if(total<=0.0)discard;
  float shift=canopyReprojection(coverage,vec3(d0.r,d1.r,d2.r),total);
  vec2 uv0=mix(canopyUV0.xy,canopyUV0.zw,shift);
  vec2 uv1=mix(canopyUV1.xy,canopyUV1.zw,shift);
  vec2 uv2=mix(canopyUV2.xy,canopyUV2.zw,shift);
  d0=texture(materialColor,canopyAtlasUV(canopyTiles.x,uv0)+depthHalf).rg;
  d1=texture(materialColor,canopyAtlasUV(canopyTiles.y,uv1)+depthHalf).rg;
  d2=texture(materialColor,canopyAtlasUV(canopyTiles.z,uv2)+depthHalf).rg;
  coverage=canopyWeights*vec3(d0.g,d1.g,d2.g);
  total=dot(coverage,vec3(1.0));
  // Reproduce the ordered test with unit gain, zero floor and no additional fade.
  ivec2 pixel=ivec2(gl_FragCoord.xy)&1;
  vec4 thresholds=vec4(.4,.8,.6,.2);
  if(2.0*total<thresholds[pixel.x+2*pixel.y])discard;
  vec3 depths=vec3(surfaceTowardSun(canopyTiles.x,uv0,d0.r),
    surfaceTowardSun(canopyTiles.y,uv1,d1.r),surfaceTowardSun(canopyTiles.z,uv2,d2.r));
  float towardSun=dot(coverage,depths)/(total+.00010001659);
  // WebGL's forward depth reverses the native conservative max.
  gl_FragDepth=max(0.0,gl_FragCoord.z-max(0.0,towardSun)*canopyDepthSpan);
}`;

const fragment=`#version 300 es
precision highp float;
in vec3 world;
in vec2 skyPoint;
in vec3 surfaceNormal;
in vec2 materialUV;
flat in vec3 canopyTiles;
flat in vec3 canopyWeights;
flat in vec4 cropImpostor;
flat in float cropHandoff;
flat in float canopyDepthSpan;
in vec4 canopyUV0,canopyUV1,canopyUV2;
in vec2 roadSecondaryUV;
in float viewDepth;
in vec4 roadWeights;
in float decalOpacity;
in float decalBlend;
in vec4 terrainVertexColor;
flat in float propLayerAux;
in float propLayerDirtWeight;
in vec2 propParallaxVertex;
in vec4 terrainTangent;
in vec4 terrainSecondaryTangent;
in vec2 terrainThirdUV;
flat in float material;
flat in int mirroredInstance;
flat in float vegetationCoverage;
uniform vec3 eye;
uniform vec2 heading;
uniform vec2 pitch;
uniform float aspect;
uniform float projectionScale;
uniform bool skyPass;
uniform bool skyBake;
uniform int interiorClipEdgeCount;
uniform vec2 interiorClipScale;
uniform vec4 interiorClipEdges[${interiorClipEdgeCapacity}];
uniform bool skyHdr;
uniform bool hasSkyEnvironment;
#if STREET_SKY
uniform sampler2D skyEnvironment;
#endif
#if STREET_SKY_BLEND
uniform sampler2D previousSkyEnvironment;
uniform float previousSkyAmount;
#endif
uniform bool sunShadows;
uniform bool canopySampleCoverage;
uniform vec4 shadowX,shadowY,shadowZ;
#if STREET_SHADOWS
uniform highp sampler2DArrayShadow shadowDepth;
uniform float shadowLayer;
uniform float shadowPreviousWeight;
uniform vec4 shadowPreviousX;
uniform vec4 shadowPreviousY;
uniform vec4 shadowPreviousZ;
#endif
#if STREET_DISTANT_SHADOWS
uniform bool sunDistantShadows;
uniform highp sampler2DShadow distantShadowDepth;
uniform vec4 distantShadowX,distantShadowY,distantShadowZ;
#endif
uniform bool lightingEnabled;
uniform vec3 sunDirection;
uniform vec3 sunlight;
uniform vec3 skyLight;
uniform vec3 groundLight;
uniform vec3 ambientSkyGain;
uniform vec3 octaDiffuseTint;
uniform vec2 octaDiffuseRamp;
uniform vec3 horizonColor;
uniform vec3 zenithColor;
uniform float cloudCover;
uniform vec4 cloudLayer;
uniform vec4 cloudShape;
uniform vec3 cloudNoiseWeights;
uniform vec3 cloudObserver;
${nativeCloudVolumeShader}
#if STREET_CLOUD_NOISE
uniform highp sampler3D cloudNoiseVolume;
uniform bool hasCloudNoiseVolume;
#endif
#if STREET_CLOUD_SHADOWS
uniform sampler2D cloudShadowMask;
uniform vec3 cloudShadowRegion;
uniform float cloudShadowAlpha;
uniform bool cloudShadowBake;
uniform bool hasCloudShadows;
#endif
uniform vec3 fogProfile;
uniform float cameraAltitude;
uniform sampler2D aerial;
uniform float waterTime;
uniform float waveStrength;
uniform vec2 waterOrigin;
uniform bool waterDepthOnly;
#if STREET_OCEAN_WAVES
uniform bool hasOceanWaves;
uniform highp sampler2DArray oceanWaves0;
uniform highp sampler2DArray oceanWaves1;
uniform vec3 oceanBandLengths;
uniform float oceanPhaseBlend;
#endif
uniform bool hasWaveTexture;
uniform bool hasAuthoredWaterBump;
uniform bool hasWaterFoam;
uniform bool hasWaterOptics;
uniform vec4 waterOpticsBounds;
uniform bool hasWaterTileRegion;
uniform vec4 waterTileBounds;
uniform bool hasWaterBackdrop;
uniform bool waterBackdropNeedsBottom;
uniform bool hasWaterSceneDepth;
#if STREET_REFRACTION
uniform sampler2D waterBackdrop;
uniform float nearPlane;
uniform float inverseHalfFarPlane;
#endif
uniform vec2 waterViewport;
uniform bool waterReflectionPass;
uniform bool hasWaterReflection;
uniform float waterReflectionPlane;
#if STREET_REFLECTION
uniform sampler2D waterReflection;
#endif
uniform vec3 waterReflectionEye;
uniform vec4 waterReflectionAngles;
uniform vec2 waterReflectionProjection;
uniform sampler2D materialColor;
uniform bool useMaterial;
uniform highp uint overviewCoveredCells;
uniform bool hasDetailNormal;
uniform vec2 detailNormalBumpiness;
uniform bool foliageLighting;
uniform bool roadEnabled;
uniform bool roadVertexOnly;
uniform bool roadUsesHeight;
uniform bool roadAuthoredHeight;
uniform bool roadSurfaceTint;
uniform vec4 roadVertexTintAmount;
uniform bool roadLocalVertexColor;
uniform bool roadHasDetail;
uniform bool roadHasParallax;
uniform vec2 roadControlOrigin;
uniform vec4 roadParallaxStrength;
uniform vec4 roadParallaxCenter;
uniform vec4 roadParallaxRefine;
uniform vec4 roadDetailU,roadDetailV,roadDetailStrength;
uniform vec4 roadHeightChannels;
uniform vec4 roadColorReference;
uniform bool roadMaskUV3;
uniform float roadProjectedDetail;
uniform bool terrainEnabled;
uniform bool terrainProjectedDetail;
#if STREET_TERRAIN_DETAIL
uniform bool terrainLocalDetail;
uniform vec4 terrainDetailU,terrainDetailV,terrainDetailStrength;
uniform sampler2D terrainDetailMaps[3];
#endif
uniform bool terrainNativeLocalBlend;
uniform bool terrainHasHeightLayers;
uniform vec2 propLayerState;
uniform vec2 staticLayerState;
uniform vec4 staticDetail0;
uniform vec4 staticDetail1;
uniform bool staticLayerDirt;
uniform bool twoLayerDecal;
uniform bool hasDecalControl;
uniform float retroBlend;
uniform bool decalPaletteEnabled;
uniform sampler2D roadMask;
uniform bool standardDecalTintEnabled;
uniform float surfaceDecalReciprocal;
uniform highp sampler2D roadColors[4];
uniform vec4 roadPrimary;
uniform vec4 roadSecondary;
uniform vec4 roadPrimaryLayers;
uniform vec4 roadPowers;
uniform sampler2D terrainHeights[4];
${streetRoomShader}
uniform bool terrainUsesVertexWeights;
uniform bool terrainBlendsVertexWeights;
uniform bool terrainMaskUV3;
uniform vec4 terrainSecondaryLayers;
uniform vec4 terrainHeightGain;
uniform vec4 terrainHeightBias;
uniform sampler2D terrainTint;
uniform bool terrainHasTint;
uniform int terrainTintUVMode;
uniform bool terrainTintInset;
uniform bool terrainTintUsesAlpha;
uniform vec4 terrainTintMode;
uniform vec4 terrainTintScale;
uniform vec4 terrainTintAmount;
uniform bool terrainHasVertexTint;
uniform bool terrainVertexTintBeforeSector;
uniform bool terrainVertexTintUsesAlpha;
uniform vec4 terrainVertexTintInvertAlpha;
uniform vec4 terrainVertexTintMode;
uniform vec4 terrainVertexTintScale;
uniform vec4 terrainVertexTintAmount;
uniform bool terrainHasNormals;
uniform sampler2D terrainNormals[4];
uniform bvec4 terrainNormalAvailable;
uniform vec4 terrainNormalStrength;
uniform int alphaLayer;
uniform bool frontOnlyDecal;
uniform vec4 aerialRect;
uniform bool aerialUsesOverview;
uniform vec3 groundAtlas;
out vec4 color;
float grain(vec3 p){
  p=fract(p*0.1031);p+=dot(p,p.yxz+33.33);
  return fract((p.x+p.y)*p.z);
}
vec3 linearColor(vec3 c){
  return mix(c/12.92,pow((c+0.055)/1.055,vec3(2.4)),step(0.04045,c));
}
vec3 srgbColor(vec3 c){
  return mix(c*12.92,1.055*pow(c,vec3(1.0/2.4))-0.055,step(0.0031308,c));
}
${canopyAtlasSampling}
${streetPropParallaxShader}
vec3 canopyNormal(vec4 sampleValue){
  if(max(sampleValue.b,sampleValue.a)<.03*sampleValue.g||sampleValue.g<1e-5)return vec3(0);
  vec2 oct=clamp((sampleValue.ba/sampleValue.g-128.0/255.0)*(255.0/112.0),-1.0,1.0);
  vec3 normal=vec3(oct,1.0-abs(oct.x)-abs(oct.y));
  normal.xy+=(1.0-2.0*step(vec2(0.0),normal.xy))*max(0.0,-normal.z);
  return normalize(normal)*sampleValue.g;
}
vec4 sampleWorldMaterial(vec2 uv,bool normalEnabled,out vec3 atlasNormal,out float atlasDisplacement){
  atlasNormal=vec3(0);
  atlasDisplacement=0.0;
  if(material!=${nativeCanopyMaterial}.0)return texture(materialColor,uv);
  vec2 depthHalf=vec2(.5,0);
  vec4 d0=texture(materialColor,canopyAtlasUV(canopyTiles.x,canopyUV0.xy)+depthHalf,4.0-3.0*canopyWeights.x);
  vec4 d1=texture(materialColor,canopyAtlasUV(canopyTiles.y,canopyUV1.xy)+depthHalf,4.0-3.0*canopyWeights.y);
  vec4 d2=texture(materialColor,canopyAtlasUV(canopyTiles.z,canopyUV2.xy)+depthHalf,4.0-3.0*canopyWeights.z);
  vec3 coverage=canopyWeights*vec3(d0.g,d1.g,d2.g);
  float total=dot(coverage,vec3(1.0));
  float shift=canopyReprojection(coverage,vec3(d0.r,d1.r,d2.r),total);
  atlasDisplacement=canopyDepthSpan*shift;
  vec2 surface0=canopyAtlasUV(canopyTiles.x,mix(canopyUV0.xy,canopyUV0.zw,shift));
  vec2 surface1=canopyAtlasUV(canopyTiles.y,mix(canopyUV1.xy,canopyUV1.zw,shift));
  vec2 surface2=canopyAtlasUV(canopyTiles.z,mix(canopyUV2.xy,canopyUV2.zw,shift));
  // Compute gradients before the coverage branch so mip selection is valid
  // for leaf edges, where adjacent fragments can take different paths.
  vec2 dx0=dFdx(surface0),dy0=dFdy(surface0);
  vec2 dx1=dFdx(surface1),dy1=dFdy(surface1);
  vec2 dx2=dFdx(surface2),dy2=dFdy(surface2);
  if(total<=0.0)return vec4(0.0);
  vec4 value=textureGrad(materialColor,surface0,dx0,dy0)*canopyWeights.x
    +textureGrad(materialColor,surface1,dx1,dy1)*canopyWeights.y
    +textureGrad(materialColor,surface2,dx2,dy2)*canopyWeights.z;
  if(normalEnabled&&(canopySampleCoverage?value.a>0.0:value.a>=.5)){
    // Sample the normal half at the same reprojected surface and mip as color.
    // Explicit gradients remain valid with coverage-varying control flow.
    vec3 local=canopyNormal(textureGrad(materialColor,surface0+depthHalf,dx0,dy0))*canopyWeights.x
      +canopyNormal(textureGrad(materialColor,surface1+depthHalf,dx1,dy1))*canopyWeights.y
      +canopyNormal(textureGrad(materialColor,surface2+depthHalf,dx2,dy2))*canopyWeights.z;
    atlasNormal=vec3(dot(terrainTangent.xyz,local),dot(terrainSecondaryTangent.xyz,local),dot(terrainVertexColor.xyz,local));
  }
  return vec4(srgbColor(value.rgb/max(value.a,1e-5)),value.a);
}
vec4 sampleWorldMaterial(vec2 uv){
  vec3 unusedNormal;
  float unusedDisplacement;
  return sampleWorldMaterial(uv,false,unusedNormal,unusedDisplacement);
}
#if STREET_REFRACTION
float sceneDistance(float depth){
  return nearPlane/max(.000001,1.0-depth+.5*nearPlane*inverseHalfFarPlane);
}
#endif
vec4 layeredDecal(vec4 primary,vec2 uv){
  vec2 secondaryUV=retroBlend>0.0&&!decalPaletteEnabled?vec2(uv.x,1.0-uv.y):uv;
  vec4 secondary=texture(roadMask,secondaryUV);
  if(retroBlend>0.0)primary=texture(materialColor,roadSecondaryUV);
  // Blend the two authored diffuse layers using vertex weight and control blue.
  float weight=clamp(decalBlend*(hasDecalControl?1.0+texture(roadColors[0],uv).b:1.0),0.0,1.0);
  float sharpness=retroBlend>0.0?retroBlend:hasDecalControl?4.0:1.0;
  weight=weight/mix(sharpness,1.0,weight)*secondary.a;
  vec3 a=linearColor(primary.rgb),b=linearColor(secondary.rgb);
  if(decalPaletteEnabled){
    a*=mix(vec3(1.0),terrainVertexColor.rgb,texture(roadColors[1],roadSecondaryUV).a);
    b*=mix(vec3(1.0),terrainVertexColor.rgb,texture(roadColors[2],secondaryUV).a);
    if(primary.a<0.025)return vec4(srgbColor(b),secondary.a*weight);
  }
  vec3 mixed=mix(a,b,weight);
  return vec4(srgbColor(mixed),mix(primary.a,secondary.a,weight));
}
vec4 surfaceDecal(vec4 primary){
  vec4 secondary=texture(materialColor,roadSecondaryUV);
  float control=texture(roadMask,materialUV).b;
  float raw=clamp(roadWeights.r*(1.0+control),0.0,1.0);
  float weight=clamp(raw/max(.01,mix(surfaceDecalReciprocal,1.0,raw)),0.0,1.0)*secondary.a;
  vec3 secondaryColor=linearColor(secondary.rgb);
  bool secondaryOnly=primary.a<.025;
  vec3 color=secondaryOnly?secondaryColor:mix(linearColor(primary.rgb),secondaryColor,weight);
  vec4 dirt=texture(roadColors[0],roadSecondaryUV);
  float dirtWeight=dirt.a*roadWeights.g;
  vec3 muted=mix(color,vec3(dot(color,vec3(.2125,.7154,.0721))),dirtWeight);
  vec3 dirtBlend=mix(2.0*dirt.rgb*muted,1.0-2.0*(1.0-dirt.rgb)*(1.0-muted),step(.5,dirt.rgb));
  float alpha=secondaryOnly?secondary.a*weight:mix(primary.a,secondary.a,weight);
  return vec4(srgbColor(mix(color,dirtBlend,dirtWeight)),alpha);
}
vec2 roadSurfaceChannels(vec4 texel,float compressed){
  return mix(texel.rg,texel.ba,compressed);
}
vec3 roadLayerLinear(vec3 color,float reference){
  return reference>=0.0?color:linearColor(color);
}
float roadLayerMean(sampler2D source,vec2 uv,float reference){
  return reference>=0.0?reference:dot(linearColor(textureLod(source,uv,12.0).rgb),vec3(0.2126,0.7152,0.0722));
}
vec3 tintRoadLayer(vec3 diffuse,vec3 tint,float coverage,vec3 vertexTint,float vertexAmount){
  vec3 vertex=mix(diffuse,clamp(diffuse*vertexTint,0.0,1.0),vertexAmount);
  // The admitted material sets the vertex-first selector at +0x180.
  vec3 textured=mix(vertex,clamp(vertex*tint,0.0,1.0),clamp(coverage,0.0,1.0));
  return mix(textured,vertex,terrainVertexColor.a);
}
float roadDetailGain(sampler2D atlas,vec2 uv,float weight,float strength,bool inRange){
  vec2 dx=dFdx(uv),dy=dFdy(uv);
  if(!inRange||weight<=0.0)return 1.0;
  float blue=textureGrad(atlas,uv,dx,dy).b;
  return 1.0+strength*(2.0*clamp(0.5+(blue-0.5)*weight,0.0,1.0)-1.0);
}
vec3 roadColor(){
  float vertexResidual=clamp(1.0-dot(roadWeights.rgb,vec3(1.0)),0.0,1.0);
  vec4 weights=vec4(roadWeights.rgb,vertexResidual);
  if(!roadVertexOnly){
    vec3 mask=texture(roadMask,roadMaskUV3?terrainThirdUV:materialUV).rgb;
    float maskResidual=clamp(1.0-dot(mask,vec3(1.0)),0.0,1.0);
    weights=mix(vec4(mask,maskResidual),weights,roadWeights.a);
  }
  vec2 primary=materialUV*roadPrimary.xy+roadPrimary.zw;
  vec2 secondary=roadSecondaryUV*roadSecondary.xy+roadSecondary.zw;
  vec2 uv0=mix(secondary,primary,roadPrimaryLayers.x),uv1=mix(secondary,primary,roadPrimaryLayers.y);
  vec2 uv2=mix(secondary,primary,roadPrimaryLayers.z),uv3=mix(secondary,primary,roadPrimaryLayers.w);
  vec4 surfaceCoverage=vec4(0.0),baseHeights=vec4(0.0);
  if(roadAuthoredHeight){
    vec2 layer0=roadSurfaceChannels(texture(terrainHeights[0],uv0),roadHeightChannels.x);
    vec2 layer1=roadSurfaceChannels(texture(terrainHeights[1],uv1),roadHeightChannels.y);
    vec2 layer2=roadSurfaceChannels(texture(terrainHeights[2],uv2),roadHeightChannels.z);
    vec2 layer3=roadSurfaceChannels(texture(terrainHeights[3],uv3),roadHeightChannels.w);
    baseHeights=vec4(layer0.x,layer1.x,layer2.x,layer3.x);
    surfaceCoverage=vec4(layer0.y,layer1.y,layer2.y,layer3.y)*terrainTintAmount;
    weights=clamp(weights*max(vec4(0.01),(baseHeights-terrainHeightBias)*terrainHeightGain),0.0,1.0);
  }else if(roadUsesHeight){
    vec4 heights=vec4(terrainHeightBias.x>0.01?roadSurfaceChannels(texture(terrainHeights[0],uv0),roadHeightChannels.x).x:0.0,
      terrainHeightBias.y>0.01?roadSurfaceChannels(texture(terrainHeights[1],uv1),roadHeightChannels.y).x:0.0,
      terrainHeightBias.z>0.01?roadSurfaceChannels(texture(terrainHeights[2],uv2),roadHeightChannels.z).x:0.0,
      terrainHeightBias.w>0.01?roadSurfaceChannels(texture(terrainHeights[3],uv3),roadHeightChannels.w).x:0.0);
    weights=clamp(weights*max(vec4(0.01),terrainHeightBias-heights)*terrainHeightGain,0.0,1.0);
  }
  weights/=max(max(max(weights.x,weights.y),max(weights.z,weights.w)),0.00001);
  weights=pow(weights,roadPowers)-0.001;
  // Count the zero-weight auxiliary lane in the traced height-blend path.
  float normalization=dot(weights,vec4(1.0))-(roadAuthoredHeight?0.001:0.0);
  weights=clamp(weights/max(normalization,0.00001),0.0,1.0);
  if(roadHasParallax){
    vec2 sectorUV=(world.xy-roadControlOrigin)/512.0;
    float control=textureLod(terrainTint,vec2(sectorUV.x,1.0-sectorUV.y),0.0).r;
    // Use the initialized camera state, with the displacement override off.
    float fade=terrainSecondaryTangent.w*(1.0-control);
    vec3 viewTangent=terrainSecondaryTangent.xyz;
    viewTangent*=inversesqrt(max(dot(viewTangent,viewTangent),1e-10));
    vec2 direction=viewTangent.xy/min(-1.0,viewTangent.z);
    float refine=dot(weights,roadParallaxRefine);
    vec2 ray=direction*(refine*fade>0.0?fade:0.0);
    vec2 shifted=primary+ray*dot(weights,roadParallaxStrength*(baseHeights-1.0+roadParallaxCenter));
    vec4 shiftedHeights=vec4(
      roadSurfaceChannels(texture(terrainHeights[0],shifted),roadHeightChannels.x).x,
      roadSurfaceChannels(texture(terrainHeights[1],shifted),roadHeightChannels.y).x,
      roadSurfaceChannels(texture(terrainHeights[2],shifted),roadHeightChannels.z).x,
      roadSurfaceChannels(texture(terrainHeights[3],shifted),roadHeightChannels.w).x);
    vec2 refined=shifted-ray*(.7*.02)*refine*(1.0-dot(weights,shiftedHeights));
    uv0=refined;uv1=refined;uv2=refined;uv3=refined;
  }
  vec3 c0=roadLayerLinear(texture(roadColors[0],uv0).rgb,roadColorReference.x);
  vec3 c1=roadLayerLinear(texture(roadColors[1],uv1).rgb,roadColorReference.y);
  vec3 c2=roadLayerLinear(texture(roadColors[2],uv2).rgb,roadColorReference.z);
  vec3 c3=roadLayerLinear(texture(roadColors[3],uv3).rgb,roadColorReference.w);
  if(roadLocalVertexColor){
    vec3 vertexTint=linearColor(terrainVertexColor.rgb);
    c0*=vertexTint;
    c1*=vertexTint;
    c2*=vertexTint;
    c3*=vertexTint;
  }else if(roadSurfaceTint){
    vec3 tint=texture(terrainTint,materialUV).rgb;
    vec3 vertexTint=linearColor(terrainVertexColor.rgb);
    c0=tintRoadLayer(c0,tint,surfaceCoverage.x,vertexTint,roadVertexTintAmount.x);
    c1=tintRoadLayer(c1,tint,surfaceCoverage.y,vertexTint,roadVertexTintAmount.y);
    c2=tintRoadLayer(c2,tint,surfaceCoverage.z,vertexTint,roadVertexTintAmount.z);
    c3=tintRoadLayer(c3,tint,surfaceCoverage.w,vertexTint,roadVertexTintAmount.w);
  }else if(terrainHasTint){
    vec3 tint=texture(terrainTint,materialUV).rgb;
    c0=mix(c0,clamp(c0*tint*terrainTintScale.x,0.0,1.0),terrainTintAmount.x);
    c1=mix(c1,clamp(c1*tint*terrainTintScale.y,0.0,1.0),terrainTintAmount.y);
    c2=mix(c2,clamp(c2*tint*terrainTintScale.z,0.0,1.0),terrainTintAmount.z);
    c3=mix(c3,clamp(c3*tint*terrainTintScale.w,0.0,1.0),terrainTintAmount.w);
  }
  if(roadHasDetail){
    // The native gate uses perspective clip W, in forward-view units.
    bool inRange=1.0<gl_FragCoord.w*${roadDetailFarDepth}.0;
    c0*=roadDetailGain(terrainNormals[0],uv0*vec2(roadDetailU.x,roadDetailV.x),weights.x,roadDetailStrength.x,inRange);
    c1*=roadDetailGain(terrainNormals[1],uv1*vec2(roadDetailU.y,roadDetailV.y),weights.y,roadDetailStrength.y,inRange);
    c2*=roadDetailGain(terrainNormals[2],uv2*vec2(roadDetailU.z,roadDetailV.z),weights.z,roadDetailStrength.z,inRange);
    c3*=roadDetailGain(terrainNormals[3],uv3*vec2(roadDetailU.w,roadDetailV.w),weights.w,roadDetailStrength.w,inRange);
  }
  vec3 blended=c0*weights.x+c1*weights.y+c2*weights.z+c3*weights.w;
  if(roadProjectedDetail!=0.0){
    float average=dot(weights,vec4(roadLayerMean(roadColors[0],uv0,roadColorReference.x),
      roadLayerMean(roadColors[1],uv1,roadColorReference.y),roadLayerMean(roadColors[2],uv2,roadColorReference.z),
      roadLayerMean(roadColors[3],uv3,roadColorReference.w)));
    const vec3 luminance=vec3(0.2126,0.7152,0.0722);
    float detail=clamp(dot(blended,luminance)/max(0.01,average),0.45,1.8);
    vec2 atlasUV=(world.xy-groundAtlas.xy)/128.0;
    vec3 sector=linearColor(texture(materialColor,clamp(vec2(atlasUV.x,1.0-atlasUV.y),0.0,1.0)).rgb);
    // A missing texture mask leaves only the authored vertex contribution.
    blended=clamp(sector*mix(1.0,detail,roadProjectedDetail<0.0?roadWeights.a:1.0),0.0,1.0);
  }
  return srgbColor(blended);
}
vec3 applyTerrainTint(vec3 base,vec3 tint,float mode,float scale,float amount){
  vec3 scaled=tint*scale;
  vec3 recolored=mode==1.0?clamp(scaled*base,0.0,1.0):scaled*dot(base,vec3(0.2125,0.7154,0.0721));
  return mix(base,recolored,amount);
}
vec3 unpackTerrainNormal(vec2 rg,float strength){
  vec2 xy=(rg*2.0-1.0)*strength;
  return normalize(vec3(xy,sqrt(max(0.0001,1.0-dot(xy,xy)))));
}
vec3 terrainNormalInWorld(vec3 direction,vec4 frame,vec3 normal){
  vec3 tangent=frame.xyz-normal*dot(frame.xyz,normal);
  if(dot(tangent,tangent)<0.000001)return normal*direction.z;
  tangent=normalize(tangent);
  vec3 bitangent=cross(tangent,normal)*sign(frame.w);
  return tangent*direction.x+bitangent*direction.y+normal*direction.z;
}
float terrainLayerDetail(sampler2D source,vec2 uv){
  // The mip bias makes the contrast converge to neutral at a distance.
  const vec3 luminance=vec3(0.2126,0.7152,0.0722);
  float fine=dot(linearColor(texture(source,uv).rgb),luminance);
  float coarse=dot(linearColor(texture(source,uv,4.0).rgb),luminance);
  return (fine+0.015)/(coarse+0.015)-1.0;
}
vec3 terrainColor(inout vec3 normal){
  vec3 mask=terrainUsesVertexWeights?roadWeights.rgb:texture(roadMask,terrainMaskUV3?terrainThirdUV:materialUV).rgb;
  vec4 weights=vec4(mask,max(0.0,1.0-dot(mask,vec3(1.0))));
  if(terrainBlendsVertexWeights){
    float residual=max(0.0,1.0-dot(roadWeights.rgb,vec3(1.0)));
    weights=mix(weights,vec4(roadWeights.rgb,residual),roadWeights.a);
  }
  if(terrainNativeLocalBlend)weights=clamp(weights,0.0,1.0);
  vec4 detailWeights=weights/max(dot(weights,vec4(1.0)),0.00001);
  vec2 uv=materialUV*roadPrimary.xy+roadPrimary.zw;
  vec4 secondary=terrainSecondaryLayers;
  vec2 uv0=mix(uv,roadSecondaryUV,secondary.x),uv1=mix(uv,roadSecondaryUV,secondary.y);
  vec2 uv2=mix(uv,roadSecondaryUV,secondary.z),uv3=mix(uv,roadSecondaryUV,secondary.w);
  vec2 packed0,packed1,packed2,packed3;
  if(terrainHasHeightLayers){
    packed0=texture(terrainHeights[0],uv0).rg;packed1=texture(terrainHeights[1],uv1).rg;
    packed2=texture(terrainHeights[2],uv2).rg;packed3=texture(terrainHeights[3],uv3).rg;
    vec4 h=vec4(packed0.r,packed1.r,packed2.r,packed3.r);
    weights=clamp(weights*max(vec4(0.01),(h-terrainHeightBias)*terrainHeightGain),0.0,1.0);
    weights/=max(max(max(weights.x,weights.y),max(weights.z,weights.w)),0.00001);
    weights=pow(weights,roadPowers)-0.001;
    if(terrainUsesVertexWeights||terrainNativeLocalBlend){
      // The original denominator includes the zero-weight fifth lane.
      weights=clamp(weights/max(dot(weights,vec4(1.0))-0.001,0.00001),0.0,1.0);
    }else{
      weights=max(vec4(0.0),weights);
      weights/=max(dot(weights,vec4(1.0)),0.00001);
    }
  }else weights/=max(dot(weights,vec4(1.0)),0.00001);
  if(terrainHasNormals&&dot(weights,weights)>0.0){
    vec3 flatNormal=vec3(0.0,0.0,1.0);
    vec3 n0=terrainNormalAvailable.x?unpackTerrainNormal(texture(terrainNormals[0],uv0).rg,terrainNormalStrength.x):flatNormal;
    vec3 n1=terrainNormalAvailable.y?unpackTerrainNormal(texture(terrainNormals[1],uv1).rg,terrainNormalStrength.y):flatNormal;
    vec3 n2=terrainNormalAvailable.z?unpackTerrainNormal(texture(terrainNormals[2],uv2).rg,terrainNormalStrength.z):flatNormal;
    vec3 n3=terrainNormalAvailable.w?unpackTerrainNormal(texture(terrainNormals[3],uv3).rg,terrainNormalStrength.w):flatNormal;
    if(terrainUsesVertexWeights||any(greaterThan(secondary,vec4(0.0)))){
      mat4x3 directions=mat4x3(n0,n1,n2,n3);
      vec4 secondaryWeights=weights*secondary;
      vec3 worldDirection=terrainNormalInWorld(directions*(weights-secondaryWeights),terrainTangent,normal);
      if(any(greaterThan(secondaryWeights,vec4(0.0))))
        worldDirection+=terrainNormalInWorld(directions*secondaryWeights,terrainSecondaryTangent,normal);
      if(dot(worldDirection,worldDirection)>0.000001)normal=normalize(worldDirection);
    }else{
      vec3 tangent=normalize(terrainTangent.xyz);
      vec3 bitangent=normalize(cross(tangent,normal))*sign(terrainTangent.w);
      vec3 direction=n0*weights.x+n1*weights.y+n2*weights.z+n3*weights.w;
      normal=normalize(tangent*direction.x+bitangent*direction.y+normal*direction.z);
    }
  }
  if(terrainProjectedDetail){
    // The projected atlas supplies the broad colors and crop-bed pattern.
    vec4 localDetail=vec4(terrainLayerDetail(roadColors[0],uv0),terrainLayerDetail(roadColors[1],uv1),
      terrainLayerDetail(roadColors[2],uv2),terrainLayerDetail(roadColors[3],uv3));
    // Height blending can hide the finer grains in a layer whose base color
    // is already present in the sector atlas. Weight detail by painted coverage.
    float gain=clamp(1.0+dot(localDetail,detailWeights),0.5,1.75);
    vec2 atlasUV=(world.xy-groundAtlas.xy)/128.0;
    vec3 sector=linearColor(texture(materialColor,clamp(vec2(atlasUV.x,1.0-atlasUV.y),0.0,1.0)).rgb);
    return srgbColor(clamp(sector*gain,0.0,1.0));
  }
  vec3 c0=texture(roadColors[0],uv0).rgb,c1=texture(roadColors[1],uv1).rgb;
  vec3 c2=texture(roadColors[2],uv2).rgb,c3=texture(roadColors[3],uv3).rgb;
  if(!terrainUsesVertexWeights&&!terrainNativeLocalBlend){
    c0=linearColor(c0);c1=linearColor(c1);c2=linearColor(c2);c3=linearColor(c3);
  }
  vec3 v0=c0,v1=c1,v2=c2,v3=c3;
  vec4 packedAlpha=vec4(packed0.g,packed1.g,packed2.g,packed3.g);
  if(terrainHasVertexTint){
    vec3 tint=linearColor(terrainVertexColor.rgb);
    vec4 amount=terrainVertexTintAmount;
    if(terrainVertexTintUsesAlpha)
      amount*=mix(packedAlpha,1.0-packedAlpha,terrainVertexTintInvertAlpha);
    v0=applyTerrainTint(c0,tint,terrainVertexTintMode.x,terrainVertexTintScale.x,amount.x);
    v1=applyTerrainTint(c1,tint,terrainVertexTintMode.y,terrainVertexTintScale.y,amount.y);
    v2=applyTerrainTint(c2,tint,terrainVertexTintMode.z,terrainVertexTintScale.z,amount.z);
    v3=applyTerrainTint(c3,tint,terrainVertexTintMode.w,terrainVertexTintScale.w,amount.w);
    if(terrainVertexTintBeforeSector){c0=v0;c1=v1;c2=v2;c3=v3;}
  }
  if(terrainHasTint){
    vec2 tintUV=terrainTintUVMode==3?terrainThirdUV:terrainTintUVMode==2?roadSecondaryUV:materialUV;
    if(terrainTintInset)tintUV=tintUV*(508.0/512.0)+2.0/512.0;
    vec3 tint=texture(terrainTint,tintUV).rgb;
    vec4 amount=terrainTintAmount;
    if(terrainTintUsesAlpha)amount*=packedAlpha;
    c0=applyTerrainTint(c0,tint,terrainTintMode.x,terrainTintScale.x,amount.x);
    c1=applyTerrainTint(c1,tint,terrainTintMode.y,terrainTintScale.y,amount.y);
    c2=applyTerrainTint(c2,tint,terrainTintMode.z,terrainTintScale.z,amount.z);
    c3=applyTerrainTint(c3,tint,terrainTintMode.w,terrainTintScale.w,amount.w);
  }
  if(terrainHasVertexTint){
    c0=mix(c0,v0,terrainVertexColor.a);
    c1=mix(c1,v1,terrainVertexColor.a);
    c2=mix(c2,v2,terrainVertexColor.a);
    c3=mix(c3,v3,terrainVertexColor.a);
  }
#if STREET_TERRAIN_DETAIL
  if(terrainLocalDetail){
    bool inRange=gl_FragCoord.w*${roadDetailFarDepth}.0>1.0;
    c0*=roadDetailGain(waterBackdrop,uv0*vec2(terrainDetailU.x,terrainDetailV.x),weights.x,terrainDetailStrength.x,inRange);
    c1*=roadDetailGain(terrainDetailMaps[0],uv1*vec2(terrainDetailU.y,terrainDetailV.y),weights.y,terrainDetailStrength.y,inRange);
    c2*=roadDetailGain(terrainDetailMaps[1],uv2*vec2(terrainDetailU.z,terrainDetailV.z),weights.z,terrainDetailStrength.z,inRange);
    c3*=roadDetailGain(terrainDetailMaps[2],uv3*vec2(terrainDetailU.w,terrainDetailV.w),weights.w,terrainDetailStrength.w,inRange);
  }
#endif
  return srgbColor(c0*weights.x+c1*weights.y+c2*weights.z+c3*weights.w);
}
vec3 atmosphere(vec3 direction){
  float elevation=clamp(direction.z,0.0,1.0);
  float alignment=max(dot(direction,sunDirection),0.0);
  vec3 sky=mix(horizonColor,zenithColor,pow(elevation,.42));
  return sky+sunlight*pow(alignment,20.0)*.16;
}
float valueNoise(vec2 p){
  vec2 cell=floor(p),f=fract(p);
  f=f*f*(3.0-2.0*f);
  return mix(mix(grain(vec3(cell,0.0)),grain(vec3(cell+vec2(1,0),0.0)),f.x),
    mix(grain(vec3(cell+vec2(0,1),0.0)),grain(vec3(cell+vec2(1),0.0)),f.x),f.y);
}
float cloudDensity(vec2 p){
  return valueNoise(p)*.54+valueNoise(p*2.07+8.2)*.26+
    valueNoise(p*4.13-3.6)*.13+valueNoise(p*8.27+2.3)*.07;
}
vec3 cloudyAtmosphere(vec3 direction,vec3 sky){
  if(direction.z<=.018||cloudCover<=0.0)return sky;
  vec2 p=direction.xy/(direction.z+.17)*2.25+vec2(7.6,4.2)+cloudObserver.xy*1.38;
  vec2 warp=vec2(valueNoise(p*.53),valueNoise(p*.47+4.8))-.5;
  p+=warp*1.22;
  float shape=cloudDensity(p)*.77+valueNoise(p*.59+31.0)*.23;
  float occluder=cloudDensity(p+sunDirection.xy*.27)*.77+valueNoise(p*.59+31.0)*.23;
  float densityBias=(cloudCover-.55)*.34;
  float opticalDepth=5.7*smoothstep(.43-densityBias,.73-densityBias,shape);
  float cover=(1.0-exp(-opticalDepth))*smoothstep(.018,.12,direction.z);
  float rim=smoothstep(-.08,.12,shape-occluder);
  vec3 radiance=skyLight*(.74+.16*rim)+sunlight*(.11+.35*rim)*exp(-opticalDepth*.12);
  vec3 cloud=srgbColor(radiance/(1.0+.27*radiance));
  cloud=mix(cloud,horizonColor,.28*(1.0-smoothstep(.05,.33,direction.z)));
  return mix(sky,cloud,cover*smoothstep(0.0,.2,cloudCover));
}
${atmosphericScattering}
float cloudVolumeNoise(vec3 p){
  vec3 cell=floor(p),f=fract(p);
  f=f*f*(3.0-2.0*f);
  float a=mix(mix(grain(cell),grain(cell+vec3(1,0,0)),f.x),
    mix(grain(cell+vec3(0,1,0)),grain(cell+vec3(1,1,0)),f.x),f.y);
  cell.z+=1.0;
  float b=mix(mix(grain(cell),grain(cell+vec3(1,0,0)),f.x),
    mix(grain(cell+vec3(0,1,0)),grain(cell+vec3(1,1,0)),f.x),f.y);
  return mix(a,b,f.z);
}
float cloudBillow(vec3 p){
#if STREET_CLOUD_NOISE
  if(hasCloudNoiseVolume){
    vec2 shape=textureLod(cloudNoiseVolume,p*.159,0.0).rg;
    return clamp(shape.r*.83+shape.g*.17-.065,0.0,1.0);
  }
#endif
  return cloudVolumeNoise(p);
}
float cloudVolume(vec3 position,float octaves){
  float altitude=(position.z-cloudLayer.x)/(cloudLayer.y-cloudLayer.x);
  if(altitude<=0.0||altitude>=1.0)return 0.0;
#if STREET_NATIVE_CLOUDS
  if(hasNativeClouds)return nativeCloudVolume(position,altitude,skyBake);
#endif
  vec2 plane=position.xy*1.38+vec2(7.2,4.2);
  vec2 curl=vec2(valueNoise(plane*.37+1.7),valueNoise(plane*.45+13.2))-.5;
  plane+=curl*2.3;
  vec2 rotated=vec2(dot(plane,vec2(.61,.79)),dot(plane,vec2(-.79,.61)));
  float masses=valueNoise(plane)*.72+valueNoise(rotated*1.81+9.4)*.28;
  float threshold=mix(.77,.34,smoothstep(0.0,1.0,cloudCover))-.03*cloudShape.x;
  float body=(masses-threshold)*3.65;
  if(body<-.36)return 0.0;
  vec3 p=vec3(rotated*1.38+curl*cloudShape.y,altitude*2.48+masses*1.12+11.6);
  float billows=dot(cloudNoiseWeights,vec3(cloudBillow(p),cloudBillow(p*2.11+7.8),
    octaves>2.0?cloudBillow(p*4.12-3.0):.5))/max(.01,dot(cloudNoiseWeights,vec3(1.0)));
  float height=mix(.31,.94,smoothstep(-.05,.62,body+(billows-.5)*.39));
  float envelope=smoothstep(0.0,.10,altitude)*
    (1.0-smoothstep(height*mix(.56,.66,cloudShape.x),height,altitude));
  float edge=body+(billows-.51)*mix(.78,.52,cloudShape.x)-altitude*altitude*.15;
#if STREET_CLOUD_NOISE
  if(hasCloudNoiseVolume){
    float erosion=cloudBillow(p*3.93+vec3(.2,6.5,11.7))-.47;
    edge+=erosion*mix(.28,.10,cloudShape.x);
    return envelope*smoothstep(.032,.20+cloudShape.w*.21,edge);
  }
#endif
  return envelope*smoothstep(.015,.26+cloudShape.w*.26,edge);
}
vec3 distantCloudAtmosphere(vec3 direction,vec3 sky){
  if(skyHdr)return encodeSkyRadiance(cloudyAtmosphere(direction,displaySkyRadiance(sky)));
  return cloudyAtmosphere(direction,sky);
}
vec3 volumeAtmosphere(vec3 direction){
  vec3 sky=scatterClearSky(direction,atmosphere(direction));
  if(direction.z<=.004||cloudCover<=0.0||cloudLayer.z<=0.0||cloudObserver.z>=cloudLayer.y)return sky;
  // Cloud altitudes and ray distances use kilometres. Curvature keeps the
  // integration stable through the horizon where a planar layer diverges.
  float elevation=direction.z,radius=cloudLayer.w+cloudObserver.z;
  float lower=max(0.0,cloudLayer.x-cloudObserver.z);
  float upper=cloudLayer.y-cloudObserver.z;
  float tangent=radius*elevation;
  float base=2.0*radius*lower/(sqrt(tangent*tangent+2.0*radius*lower)+tangent);
  float top=2.0*radius*upper/(sqrt(tangent*tangent+2.0*radius*upper)+tangent);
  // A horizon ray crosses much more cloud than a ray looking up. Above the
  // resolvable path length, fade to continuous haze instead of marching
  // widely spaced slices through the same cloud.
  float span=top-base;
  float resolved=1.0-smoothstep(9.0,17.0,span);
  if(resolved<=0.0)return distantCloudAtmosphere(direction,sky);
  float stepSize=min(.184,span/10.0);
  float jitter=valueNoise(direction.xy*127.0+direction.z*13.0);
  int stepLimit=96;
#if STREET_NATIVE_CLOUDS
  if(hasNativeClouds){
    stepSize=span/ceil(clamp(span/.100,16.0,144.0));
    jitter=.5;
    stepLimit=144;
  }
#endif
  float t=base+stepSize*mix(.09,.91,jitter);
  float transmittance=1.0;
  vec3 scatter=vec3(0.0);
  float phase=.72+.28*pow(max(0.0,dot(direction,sunDirection)),3.0);
  for(int i=0;i<stepLimit;i++){
    if(t>=top)break;
    vec3 p=cloudObserver+direction*t;
    p.z+=t*t*(1.0-elevation*elevation)/(2.0*radius);
    float density=cloudVolume(p,3.0)*cloudLayer.z;
    if(density>.003){
      float lightColumn=cloudVolume(p+sunDirection*.18,2.0)+.65*cloudVolume(p+sunDirection*.47,2.0);
      float shade=exp(-lightColumn*(1.8+cloudShape.z*2.5)-density*.50);
      // The wider component approximates light scattered back into dense
      // cloud from the surrounding air and adjacent cloud volumes.
      float multiple=exp(-lightColumn*.68-density*.21);
      float above=smoothstep(cloudLayer.x,cloudLayer.y,p.z);
      vec3 ambient=mix(vec3(dot(skyLight,vec3(.2126,.7152,.0722))),skyLight,.45);
      vec3 radiance=ambient*(.71+.22*above)+sunlight*(.04+.43*shade*phase+.19*multiple);
#if STREET_CLOUD_NOISE
      if(hasCloudNoiseVolume){
        float powder=1.0-exp(-density*2.9);
        radiance=ambient*(.73+.24*above)+sunlight*(.043+.51*shade*phase*(.7+.3*powder)+.23*multiple);
      }
#endif
      vec3 light=srgbColor(radiance/(1.0+.31*radiance));
      light=mix(light,horizonColor,1.0-exp(-t*.014));
      float opacity=1.0-exp(-density*min(stepSize,top-t+stepSize*.5)*3.35);
      scatter+=(skyHdr?encodeSkyRadiance(light):light)*opacity*transmittance;
      transmittance*=1.0-opacity;
      if(transmittance<.015)break;
    }
    t+=stepSize;
  }
  vec3 volume=mix(sky,sky*transmittance+scatter,smoothstep(0.0,.2,cloudCover));
  return resolved<1.0?mix(distantCloudAtmosphere(direction,sky),volume,resolved):volume;
}
vec3 filteredSky(vec3 direction,float mip){
#if STREET_SKY
  if(hasSkyEnvironment){
    vec2 uv=vec2(atan(direction.y,direction.x)*(0.5/3.14159265)+.5,sqrt(max(0.0,direction.z)));
    // Explicit level sampling avoids a derivative discontinuity at the longitude seam.
    vec3 sky=textureLod(skyEnvironment,uv,mip).rgb;
#if STREET_SKY_BLEND
    if(previousSkyAmount>0.0)sky=mix(sky,textureLod(previousSkyEnvironment,uv,mip).rgb,previousSkyAmount);
#endif
    return sky;
  }
#endif
  return cloudyAtmosphere(direction,atmosphere(direction));
}
vec3 environmentColor(vec3 direction,float mip){
  vec3 sky=filteredSky(direction,mip);
  return skyHdr?displaySkyRadiance(sky):sky;
}
vec2 unpackWaterSlope(vec4 field){
  // The original BC3 normal field stores its components in alpha and green.
  return hasAuthoredWaterBump?(field.ag-vec2(.4713,.6260))*1.47:(field.rg*255.0-128.0)/127.0;
}
float atmosphereHaze(float distance){
  // Sample the outdoor layer at the midpoint of the segment. The water
  // shader accounts for extinction along the submerged part of the light path.
  float base=max(0.0,fogProfile.y),fade=max(1.0,fogProfile.z);
  float altitude=max(0.0,cameraAltitude+(world.z-eye.z)*.5-base)/fade;
  float localDensity=fogProfile.x*exp(-altitude);
  // The planetary atmosphere is still visible well above the local layer.
  float opticalDepth=distance*(localDensity+.000105)+distance*distance*.000000062;
  return 1.0-exp(-opticalDepth);
}
vec3 surfaceAlbedo(vec3 diffuse){
  if(material!=${nativeCanopyMaterial}.0)return diffuse;
  float amount=clamp((viewDepth-octaDiffuseRamp.x)*octaDiffuseRamp.y,0.0,1.0);
  return diffuse*mix(vec3(1.0),octaDiffuseTint,amount);
}
float cloudSunVisibility(vec3 position){
#if STREET_CLOUD_SHADOWS
  if(hasCloudShadows){
    float altitude=cameraAltitude+position.z-eye.z;
    vec2 projected=(position.xy+waterOrigin-sunDirection.xy*altitude/max(.16,sunDirection.z))*.001;
    vec2 uv=(projected-cloudShadowRegion.xy)/cloudShadowRegion.z;
    float edge=min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
    if(edge>0.0){
      float fade=smoothstep(0.0,.09,edge)*(1.0-smoothstep(cloudLayer.x,cloudLayer.y,altitude*.001));
      return mix(1.0,texture(cloudShadowMask,uv).r,cloudShadowAlpha*fade);
    }
  }
#endif
  return 1.0;
}
#if STREET_SHADOWS
float nearShadowSample(vec3 uv,float layer,float bias){
  float samples=0.0;
  for(int i=0;i<4;i++){
    vec2 offset=vec2(float(i&1),float(i>>1))-.5;
    samples+=texture(shadowDepth,vec4(uv.xy+offset*.0011,layer,uv.z-bias));
  }
  return samples*.25;
}
#endif
float sunVisibility(vec3 position,vec3 normal){
  float cloud=cloudSunVisibility(position);
#if STREET_SHADOWS
  vec4 point=vec4(position+normal*.11,1.0);
  vec3 uv=vec3(dot(point,shadowX),dot(point,shadowY),dot(point,shadowZ))*.5+.5;
  float edge=min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
  float nearBlend=sunShadows&&uv.z>0.0&&uv.z<1.0?smoothstep(.015,.08,edge):0.0;
  float farVisibility=1.0;
#if STREET_DISTANT_SHADOWS
  if((nearBlend<.999||shadowPreviousWeight>0.0)&&sunDistantShadows){
    vec3 outer=vec3(dot(point,distantShadowX),dot(point,distantShadowY),dot(point,distantShadowZ))*.5+.5;
    float border=min(min(outer.x,1.0-outer.x),min(outer.y,1.0-outer.y));
    if(border>.02&&outer.z>0.0&&outer.z<1.0){
      outer.z-=mix(.0015,.00065,max(0.0,dot(normal,sunDirection)));
      farVisibility=mix(1.0,texture(distantShadowDepth,outer),smoothstep(.02,.14,border)*.96);
    }
  }
#endif
  float bias=mix(.0017,.00035,max(0.0,dot(normal,sunDirection)));
  float current=farVisibility;
  if(nearBlend>0.0)current=mix(farVisibility,nearShadowSample(uv,shadowLayer,bias),nearBlend);
  if(sunShadows&&shadowPreviousWeight>0.0){
    vec3 previous=vec3(dot(point,shadowPreviousX),dot(point,shadowPreviousY),dot(point,shadowPreviousZ))*.5+.5;
    float border=min(min(previous.x,1.0-previous.x),min(previous.y,1.0-previous.y));
    float coverage=previous.z>0.0&&previous.z<1.0?smoothstep(.015,.08,border):0.0;
    float prior=farVisibility;
    if(coverage>0.0)prior=mix(farVisibility,nearShadowSample(previous,1.0-shadowLayer,bias),coverage);
    current=mix(current,prior,smoothstep(0.0,1.0,shadowPreviousWeight));
  }
  return cloud*current;
#endif
  return cloud;
}
void main(){
  if(interiorClipEdgeCount>0){
    vec2 point=gl_FragCoord.xy*interiorClipScale-1.0;
    bool inside=true,visible=false;
    for(int i=0;i<interiorClipEdgeCount;i++){
      vec4 edge=interiorClipEdges[i];
      inside=inside&&dot(edge.xyz,vec3(point,1.0))>=-0.000001;
      if(edge.w>0.0){
        if(inside){visible=true;break;}
        inside=true;
      }
    }
    if(!visible)discard;
  }
  if(!skyPass&&vegetationCoverage<1.0){
    float threshold=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))));
    if(vegetationCoverage<=threshold)discard;
  }
  if(waterReflectionPass){
    if(world.z<waterReflectionPlane)discard;
    vec4 diffuse=useMaterial?sampleWorldMaterial(materialUV):vec4(.42,.45,.47,1.0);
    if(alphaLayer==2&&diffuse.a<.48)discard;
    vec3 face=cross(dFdx(world),dFdy(world));
    vec3 n=normalize(dot(surfaceNormal,surfaceNormal)>.001?surfaceNormal:face);
    vec3 light=mix(groundLight,skyLight*ambientSkyGain,.5+.5*n.z)+sunlight*(max(0.0,dot(n,sunDirection))*cloudSunVisibility(world));
    vec3 radiance=linearColor(surfaceAlbedo(diffuse.rgb))*light;
    radiance=srgbColor(radiance/(1.0+.24*radiance));
    color=vec4(mix(radiance,horizonColor,atmosphereHaze(length(eye-world))),1.0);
    return;
  }
  if(skyPass){
#if STREET_CLOUD_SHADOWS
    if(cloudShadowBake){
      vec2 ground=cloudShadowRegion.xy+(skyPoint*.5+.5)*cloudShadowRegion.z;
      float thickness=cloudLayer.y-cloudLayer.x;
      float density=0.0;
      for(int i=0;i<8;i++){
        float altitude=cloudLayer.x+(float(i)+.5)*thickness/8.0;
        vec2 xy=ground+sunDirection.xy*altitude/max(.16,sunDirection.z);
        density+=cloudVolume(vec3(xy,altitude),2.0);
      }
      float transmission=exp(-density*cloudLayer.z*thickness*.42/max(.16,sunDirection.z));
      color=vec4(transmission,0.0,0.0,1.0);
      return;
    }
#endif
#if STREET_SKY
    if(skyBake){
      vec2 uv=skyPoint*.5+.5;
      float a=(uv.x-.5)*6.2831853,z=uv.y*uv.y;
      vec3 direction=vec3(vec2(cos(a),sin(a))*sqrt(max(0.0,1.0-z*z)),z);
      color=vec4(volumeAtmosphere(direction),1.0);
      return;
    }
#endif
    vec2 screen=skyPoint*vec2(aspect,1.0)/projectionScale;
    vec3 direction=normalize(vec3(heading*(pitch.x-screen.y*pitch.y)+
      vec2(heading.y,-heading.x)*screen.x,pitch.y+screen.y*pitch.x));
    vec3 sky=environmentColor(direction,0.0)+sunlight*.65*smoothstep(.99985,.99994,dot(direction,sunDirection));
    color=vec4(sky,1.0);
    return;
  }
  if(material==72.0){color=vec4(1.0,0.58,0.77,0.43);return;}
  if(alphaLayer==1&&frontOnlyDecal&&gl_FrontFacing==(mirroredInstance!=0))discard;
  if(material==69.0){color=vec4(0.32,0.95,0.76,1.0);return;}
  if(material==70.0&&max(abs(world.x-eye.x),abs(world.y-eye.y))<${streetHorizon.toFixed(1)})discard;
  if(material==67.0||material==71.0){
    if(waterDepthOnly){color=vec4(0.0);return;}
    vec2 p=world.xy+waterOrigin;
    vec2 east=vec2(.63,.29),north=vec2(-.36,.84);
    float distance=length(eye-world),detail=1.0-smoothstep(35.0,240.0,distance);
    vec2 footprint=fwidth(p),slope=vec2(0.0);
    vec2 wideWaves=p*.0412+vec2(-.042,-.023)*waterTime;
    vec2 fineWaves=vec2(dot(p,vec2(.65,.76)),dot(p,vec2(-.76,.65)))*.171+vec2(.121,.042)*waterTime;
    vec2 wideDx=dFdx(wideWaves),wideDy=dFdy(wideWaves),fineDx=dFdx(fineWaves),fineDy=dFdy(fineWaves);
    float phase=0.0,crossPhase=0.0,wavePatch=.5;
    if(detail>0.0){
      phase=dot(p,east)-waterTime*1.35+1.3*sin(dot(p,vec2(-.071,.097)));
      crossPhase=dot(p,north)+waterTime*.93+1.1*sin(dot(p,vec2(.113,.063)));
      if(lightingEnabled){
        phase+=2.2*sin(dot(p,vec2(.164,.131))+.29*waterTime);
        crossPhase+=1.8*sin(dot(p,vec2(-.103,.179))-.24*waterTime);
      }
      vec2 bands=vec2(dot(footprint,abs(east)),dot(footprint,abs(north)));
      vec2 ripple=vec2(cos(phase),cos(crossPhase))*(1.0-smoothstep(vec2(.30),vec2(1.5),bands));
      slope=east*ripple.x*.12+north*ripple.y*.10;
      if(lightingEnabled){
        wavePatch=valueNoise(p*.162+vec2(12.8,8.0));
        if(hasWaveTexture){
          // The same unit carries terrain tint in opaque draws. Gradients
          // project the periodic slope field to the current pixel footprint.
          vec4 broad=textureGrad(terrainTint,wideWaves,wideDx,wideDy);
          vec4 fine=textureGrad(terrainTint,fineWaves,fineDx,fineDy);
          vec2 primary=unpackWaterSlope(broad),secondary=unpackWaterSlope(fine);
          secondary=vec2(dot(secondary,vec2(.65,-.76)),dot(secondary,vec2(.76,.65)));
          slope=slope*.26+primary*.63+secondary*mix(.28,.49,wavePatch);
        }
        if(material==71.0){
          vec2 a=vec2(.121,.169),b=vec2(-.21,.075);
          slope+=(a*.10*cos(dot(p,a)-waterTime*1.01)+b*.055*cos(dot(p,b)-waterTime*.73))*
            smoothstep(.4,2.5,materialUV.x);
        }
      }
    }
    slope*=detail;
    if(lightingEnabled){
      if(hasWaveTexture){
        // Blend longer, differently oriented wave groups as short waves
        // leave the pixel footprint. Never magnify an unresolved sine.
        vec2 rotation=vec2(.527,.850);
        vec2 offshore=vec2(dot(p,rotation),dot(p,vec2(-rotation.y,rotation.x)))*.0147+
          vec2(.023,-.012)*waterTime;
        vec2 offshoreDx=vec2(dot(dFdx(p),rotation),dot(dFdx(p),vec2(-rotation.y,rotation.x)))*.0147;
        vec2 offshoreDy=vec2(dot(dFdy(p),rotation),dot(dFdy(p),vec2(-rotation.y,rotation.x)))*.0147;
        vec2 slow=unpackWaterSlope(textureGrad(terrainTint,offshore,offshoreDx,offshoreDy));
        vec2 swell=vec2(dot(slow,vec2(rotation.x,-rotation.y)),dot(slow,rotation));
        float resolved=1.0-.74*smoothstep(1.1,6.0,length(footprint));
        slope+=swell*mix(.18,.34,1.0-detail)*resolved;
        if(detail<.82){
          vec2 broad=unpackWaterSlope(textureGrad(terrainTint,wideWaves,wideDx,wideDy));
          slope+=broad*(1.0-detail)*.19*resolved;
        }
      }
      slope*=waveStrength;
    }
#if STREET_OCEAN_WAVES
    if(hasOceanWaves&&material==71.0){
      vec2 dx=dFdx(p),dy=dFdy(p);
      slope=vec2(0.0);
      for(int band=0;band<3;band++){
        float length=oceanBandLengths[band];
        vec3 at=vec3(p/length,float(band));
        vec2 first=textureGrad(oceanWaves0,at,dx/length,dy/length).rg;
        vec2 next=textureGrad(oceanWaves1,at,dx/length,dy/length).rg;
        slope+=mix(first,next,oceanPhaseBlend);
      }
    }
#endif
    vec3 normal=normalize(vec3(-slope,1.0));
    vec3 view=normalize(eye-world);
    vec3 reflected=reflect(-view,normal);
    float fresnel=pow(1.0-clamp(dot(normal,view),0.0,1.0),4.0);
    float depth=material==71.0?materialUV.x:1.25;
#if STREET_REFRACTION
    bool waterHasBottom=!waterBackdropNeedsBottom;
    if(hasWaterSceneDepth&&material==71.0&&depth<26.0&&gl_FragCoord.y<waterViewport.y){
      float sampled=texelFetch(roadColors[2],ivec2(gl_FragCoord.xy),0).r;
      float plane=sceneDistance(gl_FragCoord.z);
      float actual=(sceneDistance(sampled)-plane)*(eye.z-world.z)/max(plane,.01);
      waterHasBottom=waterHasBottom||(sampled<1.0&&actual>0.0);
      if(sampled<1.0&&actual>=.025&&actual<max(depth*1.8,depth+3.0)){
        float correction=1.0-smoothstep(10.0,24.0,depth);
        depth=mix(depth,actual,correction*.80);
      }
    }
#endif
    float depthFootprint=fwidth(depth);
    vec3 water=mix(vec3(.12,.60,.54),vec3(.045,.23,.34),smoothstep(0.0,18.0,depth));
    vec3 sky=mix(vec3(.56,.71,.79),vec3(.24,.47,.68),clamp(reflected.z,0.0,1.0));
    water=mix(water,sky,.88*fresnel);
    vec3 sun=lightingEnabled?sunDirection:normalize(vec3(-.4,.5,.8));
    float glint=pow(max(0.0,dot(reflected,sun)),72.0);
    vec3 glare=vec3(1.0,.88,.65);
    float opacity=mix(.18,.99,smoothstep(0.0,15.0,depth));
    if(lightingEnabled){
      vec3 through=refract(-view,normal,1.0/1.333);
      float opticalDepth=depth/max(.28,-through.z);
      float absorption=1.0-exp(-opticalDepth*.163);
      float shelf=1.0-smoothstep(3.0,25.0,depth);
      vec3 tint=mix(vec3(.008,.070,.196),vec3(.019,.277,.145),shelf);
      vec3 extinction=mix(vec3(.218,.145,.121),vec3(.335,.123,.181),shelf);
      float nativeOptics=0.0;
      vec3 nativeAbsorption=vec3(absorption);
      vec2 opticsUV=vec2(p.x-waterOpticsBounds.x,waterOpticsBounds.y-p.y)/max(waterOpticsBounds.zw,vec2(1.0));
      if(hasWaterOptics&&material==71.0&&all(greaterThanEqual(opticsUV,vec2(0.0)))&&all(lessThanEqual(opticsUV,vec2(1.0)))){
        // These original atlases carry per-metre spectral coefficients.
        vec3 nativeExtinction=textureLod(roadColors[0],opticsUV,0.0).rgb;
        vec3 nativeScattering=textureLod(roadMask,opticsUV,0.0).rgb;
        if(hasWaterTileRegion){
          vec2 uv=vec2(p.x-waterTileBounds.x,waterTileBounds.y-p.y)/waterTileBounds.zw;
          // The stock resolve blends to the broad atlas over the outer fifth
          // of the window's normalized half-extent on either axis.
          vec2 fromCenter=abs(2.0*uv-1.0);
          float weight=1.0-smoothstep(.8,1.0,max(fromCenter.x,fromCenter.y));
          if(weight>0.0){
            vec3 localExtinction=textureLod(terrainHeights[0],uv,0.0).rgb;
            float valid=smoothstep(.0005,.01,min(localExtinction.r,min(localExtinction.g,localExtinction.b)));
            nativeExtinction=mix(nativeExtinction,localExtinction,weight*valid);
            nativeScattering=mix(nativeScattering,textureLod(roadColors[3],uv,0.0).rgb,weight*valid);
          }
        }
        if(min(nativeExtinction.r,min(nativeExtinction.g,nativeExtinction.b))>.0005){
          vec2 edge=min(opticsUV,1.0-opticsUV);
          nativeOptics=smoothstep(0.0,64.0,min(edge.x*waterOpticsBounds.z,edge.y*waterOpticsBounds.w));
          // The generated seabed lacks the game's wet material shading.
          // Keep an attenuation floor for it while retaining native chromatic
          // differences and letting stronger authored turbidity raise it.
          float density=dot(nativeExtinction,vec3(.2126,.7152,.0722));
          vec3 coastalExtinction=max(extinction*.72,nativeExtinction*max(1.0,.162/density));
          float authoredTint=nativeOptics*mix(.40,.92,smoothstep(1.0,8.0,depth));
          vec3 sourceTint=clamp(nativeScattering/nativeExtinction,0.0,1.0);
          float diffuseGain=1.0+.66*smoothstep(8.0,18.0,depth);
          tint=mix(tint,sourceTint*diffuseGain,authoredTint);
          nativeAbsorption=mix(nativeAbsorption,1.0-exp(-opticalDepth*coastalExtinction),nativeOptics);
          extinction=mix(extinction,coastalExtinction,nativeOptics);
        }
      }
      float cosine=clamp(dot(normal,view),0.0,1.0);
      float reflection=.0204+.9796*pow(1.0-cosine,5.0);
      reflection*=mix(.37,1.0,smoothstep(-.25,.05,reflected.z));
      reflection=min(reflection,.86);
      float sunlit=sunVisibility(world,vec3(0.0,0.0,1.0));
      vec3 scatter=tint*(skyLight*.70+sunlight*.59*mix(.46,1.0,sunlit));
      // Grazing transmission lights suspended material across the coastal shelf.
      scatter+=sunlight*sunlit*shelf*(1.0-cosine)*(1.0-cosine)*.042*(1.0-nativeOptics);
      vec3 bounced=normalize(mix(reflected,reflect(-view,vec3(0.0,0.0,1.0)),.36));
      vec3 skyReflection=filteredSky(bounced,2.0);
      vec3 reflectedSky=skyHdr?skyReflection:linearColor(skyReflection);
#if STREET_REFLECTION
      if(hasWaterReflection&&material==71.0){
        vec3 d=vec3(world.xy,waterReflectionPlane)-waterReflectionEye;
        vec2 forward=waterReflectionAngles.xy,right=vec2(forward.y,-forward.x);
        float ahead=dot(d.xy,forward);
        float viewDepth=ahead*waterReflectionAngles.z+d.z*waterReflectionAngles.w;
        float up=d.z*waterReflectionAngles.z-ahead*waterReflectionAngles.w;
        vec2 uv=.5+.5*vec2(dot(d.xy,right),up)*waterReflectionProjection/max(.01,viewDepth);
        uv+=vec2(dot(right,slope),dot(forward,slope))*(.042+.054*detail);
        // The distorted ray can cover several reflection texels at grazing angles.
        vec2 dx=dFdx(uv),dy=dFdy(uv);
        float edge=min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
        if(viewDepth>.01&&edge>0.0&&reflection>.025&&distance<620.0){
          vec4 scene=textureGrad(waterReflection,uv,dx,dy);
          float weight=scene.a*smoothstep(0.0,.058,edge)*(1.0-smoothstep(380.0,620.0,distance));
          reflectedSky=mix(reflectedSky,linearColor(scene.rgb/max(.01,scene.a)),weight*.91);
        }
      }
#endif
      vec3 halfway=normalize(view+sunDirection);
      float lobe=max(dot(halfway,normal),0.0);
      // Broaden the glint where the pixel footprint can no longer resolve short waves.
      float fineGlint=detail*(1.0-smoothstep(.07,.55,length(footprint)));
      float glitter=(pow(lobe,20.0)*mix(.067,.033,shelf)+pow(lobe,52.0)*mix(.175,.125,shelf)+
        pow(lobe,180.0)*mix(.25,.57,wavePatch)*fineGlint)*
        sunlit*max(0.0,sunDirection.z);
      opacity=1.0-(1.0-absorption)*(1.0-reflection);
      vec3 added=scatter*nativeAbsorption*(1.0-reflection)+reflectedSky*reflection+sunlight*glitter;
      if(material==71.0&&detail>.01&&depth>.13&&depth<7.0&&sunDirection.z>.15){
        vec2 projected=p+sunDirection.xy*depth/max(.33,sunDirection.z);
        float a=dot(projected,vec2(1.28,1.61))-waterTime*2.1;
        float b=dot(projected,vec2(-1.55,1.11))+waterTime*1.9;
        float caustic=pow(.5+.5*cos(a+sin(b)*1.5)*cos(b+sin(a)*1.3),8.0);
        float visible=(1.0-smoothstep(.3,2.0,length(footprint)))*smoothstep(.13,.55,depth)*exp(-depth*.48);
        added+=sunlight*caustic*visible*sunlit*(1.0-reflection)*.028;
      }
#if STREET_REFRACTION
      if(hasWaterBackdrop&&waterHasBottom&&material==71.0&&depth<20.0&&gl_FragCoord.y<waterViewport.y){
        vec2 right=vec2(heading.y,-heading.x);
        vec2 distortion=vec2(dot(slope,right),dot(slope,heading))*
          (min(depth,5.0)*2.8*detail/(1.0+distance*.035));
        vec2 size=vec2(textureSize(waterBackdrop,0));
        vec2 center=gl_FragCoord.xy;
        vec2 bent=clamp(center+distortion,vec2(.5),waterViewport-.5);
        vec3 straight=texture(waterBackdrop,center/size).rgb;
        vec3 bottom=texture(waterBackdrop,bent/size).rgb;
        if(hasWaterSceneDepth){
          float front=sceneDistance(texelFetch(roadColors[2],ivec2(bent),0).r);
          if(front+.08<sceneDistance(gl_FragCoord.z))bottom=straight;
        }
        // Hold onto the local color across strong opaque edges.
        bottom=mix(bottom,straight,smoothstep(.15,.41,length(bottom-straight)));
        // The opaque seabed is lit as if it were dry. Attenuate both the
        // visible path through water and the illumination reaching that sand.
        float illuminationDepth=depth/max(.38,sunDirection.z);
        vec3 transmitted=exp(-(opticalDepth+.72*illuminationDepth)*extinction);
        float lookup=1.0-smoothstep(14.0,20.0,depth);
        // Wet sediment loses diffuse surface reflection. Keep the texture
        // and reduce its dry specular color over a narrow waterline blend.
        float wet=smoothstep(.10,1.20,depth);
        vec3 wetAlbedo=mix(vec3(1.0),vec3(.23,.44,.40),wet);
        vec3 refracted=added+linearColor(bottom)*wetAlbedo*transmitted*(1.0-reflection);
        vec3 base=added+linearColor(straight)*(1.0-opacity);
        water=srgbColor(mix(base,refracted,lookup));
        opacity=1.0;
      }else
#endif
      water=srgbColor(added/max(opacity,.035));
      glare=vec3(0.0);
      glint=0.0;
    }
    water+=glare*glint*.5*detail;
    float shore=material==71.0?(1.0-smoothstep(.05,.60,depth))*detail:0.0;
    float foam=shore*smoothstep(.42,.88,sin(phase)*sin(crossPhase))*.38;
    if(lightingEnabled&&material==71.0&&depth<4.3&&detail>0.0){
      // Shoaling crests follow bathymetry, with broken edges from the
      // shorter wave field. Stop drawing crests when they become subpixel.
      float phaseDepth=depth*2.95+1.36*(wavePatch-.5)+1.10*valueNoise(p*.041)+.38*sin(dot(p,vec2(.38,.13))+waterTime*.4);
      float crest=sin(phaseDepth-waterTime*2.1);
      float wave=(1.0-smoothstep(.08,.41,depthFootprint))*smoothstep(.65,.97,crest);
      float breaking=smoothstep(.19,.67,depth)*(1.0-smoothstep(1.65,3.5,depth));
      float lacing=.26+.74*smoothstep(-.43,.70,sin(phase*.82)*cos(crossPhase*1.61));
      if(hasWaterFoam){
        vec2 foamUV=p*.089+vec2(-.025,.009)*waterTime;
        vec4 authored=textureGrad(roadColors[1],foamUV,wideDx*(.089/.0412),wideDy*(.089/.0412));
        lacing=mix(lacing,smoothstep(.22,.85,authored.r*.68+authored.a*.32),.82);
      }
      foam=max(foam,wave*breaking*lacing*detail*.58);
    }
    water=mix(water,vec3(.81,.93,.89),foam);
    float haze=lightingEnabled?atmosphereHaze(distance):smoothstep(900.0,3700.0,distance);
    float opacityBoost=lightingEnabled?foam:max(max(.92*fresnel,glint*.65),foam);
    opacity=mix(opacity,1.0,max(opacityBoost,haze));
    color=vec4(mix(water,lightingEnabled?horizonColor:vec3(.54,.67,.75),haze),opacity);
    return;
  }
  vec3 face=cross(dFdx(world),dFdy(world));
  vec3 n=normalize(dot(surfaceNormal,surfaceNormal)>0.001?surfaceNormal:face);
  vec3 toward=normalize(eye-world);
  vec3 base=vec3(0.62,0.55,0.45);
  if(material==65.0)base=vec3(0.47,0.56,0.35);
  else if(material==66.0||material==${standardPaletteMaterial}.0)base=vec3(0.72,0.60,0.47);
  else if(material==68.0)base=vec3(0.34,0.35,0.36);
  else if(material==70.0||material==75.0)base=vec3(0.49,0.53,0.55);
  else if(material==73.0)base=vec3(0.46,0.45,0.42);
  else if(material==74.0){
    if(overviewCoveredCells!=0u){
      const int side=${overviewTerrainTileSize/CELL};
      ivec2 cell=ivec2(floor((world.xy+waterOrigin)/${CELL}.0))&ivec2(side-1);
      if((overviewCoveredCells&(1u<<uint(cell.y*side+cell.x)))!=0u)discard;
    }
    base=mix(vec3(0.53,0.49,0.39),vec3(0.43,0.49,0.34),abs(n.z));
  }
  else if(material==77.0)base=vec3(.17,.22,.24);
  else if(material==78.0)base=vec3(.48,.46,.43);
  else if(material==${nativePaletteMaterial}.0)base=srgbColor(terrainVertexColor.rgb);
  else if(material==76.0){
    float grainWeight=1.0-smoothstep(8.0,65.0,length(world-eye));
    base=vec3(.53,.51,.39)+(grain(floor(world*5.0))-.5)*.12*grainWeight;
  }
  else if(material>=40.0)base=mix(vec3(0.29,0.35,0.21),vec3(0.58,0.47,0.35),clamp((world.z+4.0)*0.10,0.0,1.0));
  else if(material>=32.0)base=vec3(0.72,0.62,0.55);
  else if(material>=16.0)base=vec3(0.53,0.56,0.57);
  else if(material==2.0||material==3.0||material==6.0||material==10.0)base=vec3(0.40,0.42,0.43);
  else if(material==7.0||material==9.0)base=vec3(0.68,0.49,0.31);
  if(!useMaterial&&(material==65.0||material==68.0||material==74.0)&&aerialRect.z>0.0){
    vec2 uv=(vec2(world.x,-world.y)-aerialRect.xy)/aerialRect.zw;
    vec4 ground=texture(aerial,uv);
    float alpha=ground.a;
    if(aerialUsesOverview&&material!=74.0)alpha*=smoothstep(.57,.82,ground.a);
    if(all(greaterThanEqual(uv,vec2(0.0)))&&all(lessThanEqual(uv,vec2(1.0))))
      base=mix(base,ground.rgb,alpha*(material==68.0?0.75:1.0));
  }
  if(terrainEnabled)base=terrainColor(n);
  if(hasDetailNormal){
    vec2 sampleRG=texture(terrainNormals[0],materialUV).rg;
    bool authored=detailNormalBumpiness.x>0.5;
    vec2 xy=authored?2.0*sampleRG-1.0:(sampleRG*255.0-128.0)/127.0;
    vec3 axis=terrainTangent.xyz-dot(terrainTangent.xyz,n)*n;
    if(dot(axis,axis)>0.000001&&terrainTangent.w!=0.0){
      vec3 tangent=normalize(axis);
      vec3 bitangent=cross(tangent,n)*sign(terrainTangent.w);
      float z=sqrt(max(0.0001,1.0-dot(xy,xy)));
      if(authored)xy*=detailNormalBumpiness.y;
      n=normalize(tangent*xy.x+bitangent*xy.y+n*z);
    }
  }
  float distance=length(world-eye);
  float shade=1.0;
  if(!lightingEnabled)shade=0.36+0.29*abs(dot(n,normalize(vec3(-0.4,0.5,0.8))))+
    0.31*abs(dot(n,toward))/(1.0+distance*0.05);
  if(!lightingEnabled&&material<64.0)
    shade+=(grain(floor(world*vec3(13.0,13.0,8.0)))-0.5)*0.09*(1.0-smoothstep(3.0,25.0,distance));
  float opacity=1.0;
  float atlasDisplacement=0.0;
  bool hasCanopyNormal=false;
  if(staticLayerState.x>0.0){
    vec4 primary=texture(roadMask,materialUV);
    vec4 secondary=texture(roadColors[0],terrainThirdUV);
    float control=texture(roadColors[3],terrainThirdUV).b;
    float raw=clamp(terrainVertexColor.a*(1.0+control),0.0,1.0);
    float reciprocal=staticLayerState.x;
    float shaped=clamp(raw/max(.01,reciprocal+(1.0-reciprocal)*raw),0.0,1.0);
    float weight=clamp(shaped*min(1.0,3.0*staticLayerState.y),0.0,1.0)*secondary.a;
    vec4 mask0=texture(roadColors[1],materialUV),mask1=texture(roadColors[2],terrainThirdUV);
    vec3 a=primary.rgb*mix(vec3(1.0),terrainVertexColor.rgb,mask0.a);
    vec3 b=secondary.rgb*mix(vec3(1.0),terrainVertexColor.rgb,mask1.a);
    float gain0=0.0,gain1=0.0;
    if(staticDetail0.z>0.0){
      vec2 uv=materialUV*staticDetail0.xy;
      float detail=staticDetail0.w>0.0?propDetail(terrainHeights[0],uv,mask0.r):
        clamp(0.5+(texture(terrainHeights[0],uv).b-0.5)*mask0.r,0.0,1.0);
      gain0=staticDetail0.z*(2.0*detail-1.0);
    }
    if(staticDetail1.z>0.0){
      vec2 uv=terrainThirdUV*staticDetail1.xy;
      float detail=staticDetail1.w>0.0?propDetail(terrainHeights[1],uv,mask1.r):
        clamp(0.5+(texture(terrainHeights[1],uv).b-0.5)*mask1.r,0.0,1.0);
      gain1=staticDetail1.z*(2.0*detail-1.0);
    }
    vec3 color=mix(a,b,weight)*(1.0+mix(gain0,gain1,weight));
    if(staticLayerDirt){
      vec4 dirt=texture(terrainHeights[2],materialUV);
      float amount=dirt.a*decalOpacity;
      float luma=dot(color,vec3(0.2125,0.7154,0.0721));
      vec3 faded=mix(color,vec3(luma),amount);
      vec3 overlay=mix(2.0*faded*dirt.rgb,1.0-2.0*(1.0-faded)*(1.0-dirt.rgb),
        greaterThan(dirt.rgb,vec3(0.5)));
      color=mix(color,overlay,amount);
    }
    base=srgbColor(color);
    shade=mix(1.0,shade,0.55);
  }else if(propLayerState.x>0.0&&propLayerAux>=0.0&&propParallaxMarch.x>0.0){
    base=srgbColor(propParallaxColor(n,toward,distance,terrainVertexColor.rgb));
    shade=mix(1.0,shade,0.55);
  }else if(propLayerState.x>0.0&&propLayerAux>=0.0){
    bool decal=alphaLayer==1;
    vec3 palette=terrainVertexColor.rgb;
    vec4 primary=texture(roadMask,materialUV);
    vec4 secondary=texture(roadColors[0],materialUV);
    float control=texture(roadColors[3],materialUV).b;
    float raw=clamp(terrainVertexColor.a*(1.0+(decal?control:propLayerAux*control)),0.0,1.0);
    float reciprocal=propLayerState.y;
    float shaped=clamp(raw/max(0.01,reciprocal+(1.0-reciprocal)*raw),0.0,1.0);
    float weight=decal?clamp(shaped*(propLayerAux<1.0?propLayerAux:0.1),0.0,1.0):
      clamp(shaped*min(1.0,3.0*propLayerAux),0.0,1.0)*secondary.a;
    vec3 a=primary.rgb*mix(vec3(1),palette,texture(roadColors[1],materialUV).a);
    vec3 b=secondary.rgb*mix(vec3(1),palette,texture(roadColors[2],materialUV).a);
    vec3 color=mix(a,b,weight);
    if(decal){
      // The low-opacity native path starts with the secondary color and
      // multiplies the first diffuse's alpha by the shaped blend weight.
      if(primary.a<0.025){
        color=b;
        primary.a*=weight;
      }
      vec4 dirt=texture(terrainHeights[1],terrainThirdUV);
      color=mix(color,dirt.rgb,propLayerDirtWeight*dirt.a);
      opacity=primary.a*decalOpacity;
    }
    base=srgbColor(color);
    shade=mix(1.0,shade,0.55);
  }else if(terrainEnabled){
    shade=mix(1.0,shade,0.55);
  }else if(roadEnabled){
    base=roadColor();
    shade=mix(1.0,shade,0.55);
  }else if(useMaterial){
    vec2 atlasUV=(world.xy-groundAtlas.xy)/128.0;
    atlasUV=clamp(vec2(atlasUV.x,1.0-atlasUV.y),0.0,1.0);
    vec3 atlasNormal;
    vec4 source=sampleWorldMaterial(groundAtlas.z>0.5?atlasUV:materialUV,lightingEnabled,atlasNormal,atlasDisplacement);
    hasCanopyNormal=dot(atlasNormal,atlasNormal)>1e-8;
    if(hasCanopyNormal)n=normalize(atlasNormal);
    if(twoLayerDecal)source=layeredDecal(source,materialUV);
    if(surfaceDecalReciprocal>0.0)source=surfaceDecal(source);
    if(standardDecalTintEnabled){
      float mask=texture(roadMask,materialUV).a;
      source.rgb=srgbColor(linearColor(source.rgb)*mix(vec3(1.0),terrainVertexColor.rgb,mask));
    }
    if(material==${standardPaletteMaterial}.0)
      source.rgb=srgbColor(linearColor(source.rgb)*mix(vec3(1.0),terrainVertexColor.rgb,source.a));
    base=surfaceAlbedo(source.rgb);
    if(material==${nativePackedTintMaterial}.0&&terrainVertexColor.a>0.0){
      vec3 tint=mix(vec3(1.0),terrainVertexColor.rgb,terrainVertexColor.a);
      base=srgbColor(linearColor(base)*tint);
    }
    shade=mix(1.0,shade,0.55);
    if(alphaLayer==2){
      if(material==${nativeCanopyMaterial}.0&&cropImpostor.x>0.0){
        // Hold the ordered mask at a fixed phase so an idle camera stays still.
        ivec2 pixel=ivec2(gl_FragCoord.xy)%3;
        const float thresholds[9]=float[9](.1,.8,.5,.7,.4,.3,.6,.2,.9);
        float coverage=2.0*cropImpostor.w*cropHandoff*vegetationCoverage*max(0.0,source.a-cropImpostor.z);
        if(coverage<thresholds[pixel.y*3+pixel.x])discard;
      }else if(material==${nativeCanopyMaterial}.0&&canopySampleCoverage){
        opacity=clamp(2.0*source.a,0.0,1.0);
        if(opacity<=0.0)discard;
      }else if(source.a<0.5)discard;
    }
    if(alphaLayer==1)opacity=source.a*decalOpacity;
  }
#if STREET_ROOMS
  vec3 roomColor;
  if(sampleStreetRoom(roomColor))base=srgbColor(roomColor);
#endif
  // The same slope can span detailed ground, a sector LOD and the elevation
  // fallback. Distance haze must agree across those material passes.
  float fog=material>=64.0?smoothstep(220.0,3600.0,distance):smoothstep(35.0,190.0,distance);
  vec3 shaded=base*shade;
  vec3 fogColor=vec3(.54,.67,.75);
  if(lightingEnabled){
    // Atlas normals describe the foliage volume, not the camera-facing card.
    if(!hasCanopyNormal&&dot(n,toward)<0.0)n=-n;
    vec3 ambient=mix(groundLight,skyLight*ambientSkyGain,n.z*.5+.5);
    // Receive shadows at the sampled point on the canopy ray.
    float incidence=dot(n,sunDirection),sunlit=sunVisibility(world+toward*atlasDisplacement,n);
    vec3 light=ambient+sunlight*(max(0.0,incidence)*sunlit);
    if(foliageLighting&&alphaLayer==2){
      // Leaf cards pass a small amount of sunlight through their thin side.
      // Opaque wood still uses the ordinary material lighting.
      float backlight=max(0.0,-incidence)*smoothstep(.05,.75,dot(-toward,sunDirection));
      light+=sunlight*vec3(.63,1.0,.37)*(.27*backlight*sunlit);
    }
    vec3 lit=(material==${nativePaletteMaterial}.0?terrainVertexColor.rgb:linearColor(base))*light;
    if(material==77.0){
      vec3 bounced=reflect(-toward,n);
      float fresnel=.04+.53*pow(1.0-clamp(dot(n,toward),0.0,1.0),5.0);
      float skyness=smoothstep(-.22,.08,bounced.z);
      vec3 reflection=mix(groundLight*.36,linearColor(environmentColor(bounced,1.5)),skyness);
      lit=mix(lit,reflection,fresnel);
    }else if(material==78.0&&useMaterial){
      float night=1.0-smoothstep(-.14,.22,sunDirection.z);
      lit+=linearColor(base)*(.16+night*1.12);
    }
    shaded=srgbColor(lit/(1.0+.24*lit));
    fogColor=mix(horizonColor,zenithColor,.15*max(0.0,-toward.z));
    if(material>=64.0)fog=atmosphereHaze(distance);
  }
  color=vec4(mix(shaded,fogColor,fog),opacity);
}`;

function streetProgram(gl:WebGL2RenderingContext,opaque=0){
  const units=gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
  const features=[
    ["STREET_SHADOWS",streetShadowUnit],["STREET_SKY",streetSkyUnit],
    ["STREET_REFRACTION",streetWaterBackdropUnit],["STREET_REFLECTION",streetWaterReflectionUnit],
    ["STREET_CLOUD_SHADOWS",streetCloudShadowUnit],
    ["STREET_CLOUD_NOISE",streetCloudNoiseUnit],
    ["STREET_NATIVE_CLOUDS",streetNativeCloudNoiseUnit],
    ["STREET_SKY_BLEND",streetPreviousSkyUnit],
    ["STREET_DISTANT_SHADOWS",streetDistantShadowUnit],
    ["STREET_ROOMS",streetRoomCubeUnit],
    ["STREET_TERRAIN_DETAIL",terrainDetailUnits[3]],
    ["STREET_OCEAN_WAVES",streetOceanWaveUnits[1]],
  ] as const;
  const defines=features.map(([name,unit])=>`#define ${name} ${Number(units>unit)}\n`).join("");
  const eliminatePassBranches=(code:string)=>opaque===1||opaque===2
    ?code.replace(/uniform bool (skyPass|waterReflectionPass|shadowPass);/g,"const bool $1=false;")
    :code;
  let vertexSource=eliminatePassBranches(vertex);
  let fragmentSource=eliminatePassBranches(fragment);
  if(opaque===2){
    vertexSource=vertexSource.replace("if(lightingEnabled&&material==71.0)","if(false)");
    fragmentSource=fragmentSource.replace("if(material==67.0||material==71.0)","if(false)");
  }
  return makeProgram(gl,vertexSource.replace("#version 300 es\n","#version 300 es\n"+
    "#define STREET_ROOMS "+Number(units>streetRoomCubeUnit)+"\n"),fragmentSource.replace("#version 300 es\n","#version 300 es\n"+defines));
}

const forward=[-.329,.944] as const;
const right=[forward[1],-forward[0]] as const;
const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
const along=(x:number,y:number)=>x*forward[0]+y*forward[1];
const across=(x:number,y:number)=>x*right[0]+y*right[1];
type Floor = {ax:number;ay:number;az:number;bx:number;by:number;bz:number;cx:number;cy:number;cz:number;det:number;material:number;walkable:boolean};
const floorKey=(x:number,y:number)=>`${Math.floor(x/8)},${Math.floor(y/8)}`;
const walkSpeed=5.2,runSpeed=9.5,defaultFlightSpeed=18,jumpSpeed=5.4,gravity=15,headHeight=1.7;
const flightToggleWindow=320;
const movingPixelBudget=1920*1080;
const motionSettleTime=160;
const compassPoints=["N","NE","E","SE","S","SW","W","NW"];

export type StreetSpawn={matchHeight:boolean;flying?:false}|{flying:true};

export type StreetPose={
  position:[number,number,number];yaw:number;pitch:number;flying:boolean;airborne:boolean;
  flightSpeed:number;verticalSpeed:number;hasFloor:boolean;entry:ReturnType<StreetWorld["spawn"]>;
  destination?:{position:[number,number,number];yaw:number;pitch:number};
  fov?:number;
};

export class StreetView {
  private readonly gl:WebGL2RenderingContext;
  private readonly edgeAA:StreetEdgeAA;
  private program:WebGLProgram;
  private shadowShader?:{program:WebGLProgram;locations:ReturnType<typeof uniforms>;source:readonly [string,string]};
  private shaderSource=[vertex,fragment];
  private locations:ReturnType<typeof uniforms>;
  private readonly vao:WebGLVertexArrayObject;
  private readonly geometry:WebGLBuffer;
  private readonly elements:WebGLBuffer;
  private readonly keys=new Set<string>();
  private readonly floors=new Map<string,Floor[]>();
  private readonly events=new AbortController();
  private readonly rollerAction=document.createElement("button");
  private rollerTarget?:string;
  private frame=0;
  private paused=false;
  private parallaxSample=0;
  private sceneDirty=true;
  private lastCamera?:readonly [number,number,number,number,number];
  private lastMotion=-Infinity;
  private moving=false;
  private motionTimer=0;
  private nextWaterFrame=Infinity;
  private lighting:ReturnType<typeof streetLighting>|undefined;
  private environment:StreetEnvironment|undefined;
  private readonly reducedMotion=matchMedia("(prefers-reduced-motion: reduce)");
  private nextHud=0;
  private canvasSize:readonly [number,number]=[0,0];
  private count=0;
  private time=0;
  private x=0;
  private y=0;
  private z=0;
  private yaw=0;
  private fov=defaultStreetFov;
  private pitch=0;
  private flying=false;
  private airborne=false;
  private verticalSpeed=0;
  private flightSpeed=defaultFlightSpeed;
  private lastSpace=-Infinity;
  private drag=false;
  private initialRegion=true;
  private hasStreetInput=false;
  private resize:ResizeObserver;
  private readonly world:StreetWorld|null;
  private readonly shadows:StreetShadows;
  private distantShadows?:StreetShadows;
  private sky:StreetSky;
  private nativeClouds:StreetNativeClouds;
  private frameBudget:StreetFrameBudget;
  private shadowTimer=0;
  private readonly karstYaw:number|undefined;
  private readonly aerial:WebGLTexture;
  private readonly aerialCanvas=document.createElement("canvas");
  private texturePlanTimer=0;
  private aerialRect:Rect=[0,0,0,0];
  private aerialUsesOverview=false;
  private minimapPosition:[number,number]|null=null;
  private displayedBearing=-1;
  private imageryDirty=true;
  private imageryTimer=0;

  constructor(private canvas:HTMLCanvasElement,
    private mesh:StreetMesh|{origin:[number,number,number];request:(point:readonly [number,number],known:string[])=>void;
      requestTexture:(id:string,ground:boolean,compression?:number)=>void;requestNavigation?:(point:readonly [number,number],known:string[])=>void;
      requestVegetation?:(point:readonly [number,number],known:string[],lookOnly?:true)=>void;
      streamView?:(view:StreetStreamView)=>void;karstYaw?:number;pickedSpawn?:StreetSpawn;ocean?:StreetOceanSource},
    private status:HTMLElement,
    private hud:{bearing:HTMLElement;minimap:HTMLCanvasElement;marker:HTMLElement;fps:StreetFpsChart;flight?:HTMLButtonElement;roadName?:(x:number,y:number,z:number)=>void},
    private imagery?:(canvas:HTMLCanvasElement,rect:Rect,useOverview:boolean)=>boolean){
    const gl=canvas.getContext("webgl2",{alpha:false,antialias:false,stencil:true,powerPreference:"high-performance"});
    if(!gl)throw new Error("WebGL 2 is required for Street view.");
    this.gl=gl;
    this.edgeAA=new StreetEdgeAA(gl);
    this.shadows=new StreetShadows(gl);
    if(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)>streetDistantShadowUnit)this.distantShadows=new StreetShadows(gl,true);
    this.sky=new StreetSky(gl);
    this.nativeClouds=new StreetNativeClouds(gl);
    this.frameBudget=new StreetFrameBudget(gl);
    this.program=streetProgram(gl);
    if(rendererReview.opaque)installOpaque(gl,this.program,mode=>streetProgram(gl,mode));
    this.locations=uniforms(gl,this.program);
    this.bindSamplers();
    this.vao=gl.createVertexArray();
    this.geometry=gl.createBuffer();
    this.elements=gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.geometry);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.elements);
    gl.vertexAttribPointer(0,4,gl.FLOAT,false,16,0);
    gl.enableVertexAttribArray(0);
    this.karstYaw="request" in mesh?mesh.karstYaw:undefined;
    this.world="request" in mesh?new StreetWorld(gl,mesh.origin,mesh.request,mesh.requestTexture,mesh.requestNavigation,
      this.karstYaw!==undefined,mesh.requestVegetation,mesh.streamView,
      mesh.ocean?new StreetOceanWaves(gl,mesh.ocean,()=>this.draw()):undefined):null;
    this.aerial=gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D,this.aerial);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4));
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D,this.aerial);
    gl.activeTexture(gl.TEXTURE0);
    if("vertices" in mesh)this.upload(mesh);
    gl.vertexAttrib1f(9,1);
    gl.enable(gl.DEPTH_TEST);
    this.reset();
    const {signal}=this.events;
    const door=this.rollerAction;
    door.type="button";
    door.className="street-roller-action";
    door.hidden=true;
    canvas.after(door);
    door.addEventListener("click",()=>{
      if(this.rollerTarget&&this.world?.toggleRoller(this.rollerTarget,performance.now(),this.reducedMotion.matches?0:1400)){
        canvas.focus();
        this.draw();
      }
    },{signal});
    document.addEventListener("visibilitychange",()=>{if(!document.hidden)this.draw();},{signal});
    this.reducedMotion.addEventListener("change",()=>this.draw(),{signal});
    canvas.addEventListener("pointerdown",event=>{
      if(event.button!==0)return;
      canvas.focus();
      this.drag=true;
      canvas.setPointerCapture(event.pointerId);
    },{signal});
    canvas.addEventListener("pointermove",event=>this.look(event),{signal});
    canvas.addEventListener("lostpointercapture",()=>{this.drag=false;},{signal});
    canvas.addEventListener("keydown",event=>this.keyDown(event),{signal});
    canvas.addEventListener("keyup",event=>{if(this.keys.delete(event.code))this.draw();},{signal});
    canvas.addEventListener("blur",()=>{this.keys.clear();this.lastSpace=-Infinity;},{signal});
    canvas.addEventListener("wheel",event=>this.wheel(event),{signal,passive:false});
    this.resize=this.observeCanvas();
  }

  private observeCanvas(){
    const resize=new ResizeObserver(([entry])=>{
      this.canvasSize=[entry.contentRect.width,entry.contentRect.height];
      this.draw();
    });
    resize.observe(this.canvas);
    return resize;
  }

  private bindSamplers(){
    const {gl,locations}=this;
    gl.useProgram(this.program);
    gl.uniform1i(locations("aerial"),0);
    gl.uniform1i(locations("materialColor"),1);
    gl.uniform1i(locations("roadMask"),2);
    gl.uniform1i(locations("roomColorCube"),streetRoomCubeUnit);
    gl.uniform1iv(locations("roadColors[0]"),[3,4,5,6]);
    gl.uniform1iv(locations("terrainHeights[0]"),[7,8,9,10]);
    gl.uniform1i(locations("propPalette"),7);
    gl.uniform1i(locations("terrainTint"),11);
    gl.uniform1iv(locations("terrainNormals[0]"),[12,13,14,15]);
    gl.uniform1iv(locations("terrainDetailMaps[0]"),terrainDetailUnits.slice(1));
    gl.uniform1i(locations("waterBackdrop"),streetWaterBackdropUnit);
    this.shadows.bindSampler(locations("shadowDepth"));
    this.distantShadows?.bindSampler(locations("distantShadowDepth"));
    this.sky.bindSampler(locations("skyEnvironment"));
    gl.uniform1i(locations("previousSkyEnvironment"),streetPreviousSkyUnit);
    this.sky.bindCloudShadowSampler(locations("cloudShadowMask"));
    this.sky.bindCloudNoiseSampler(locations("cloudNoiseVolume"));
    gl.uniform1i(locations("nativeCloudDensity"),streetCloudDensityUnit);
    gl.uniform1i(locations("nativeCloudNoise"),streetNativeCloudNoiseUnit);
    gl.uniform1i(locations("oceanWaves0"),streetOceanWaveUnits[0]);
    gl.uniform1i(locations("oceanWaves1"),streetOceanWaveUnits[1]);
  }

  private look(event:PointerEvent){
    if(!this.drag)return;
    this.hasStreetInput=true;
    this.yaw-=event.movementX*.003;
    this.pitch=clamp(this.pitch-event.movementY*.003,-maximumStreetPitch,maximumStreetPitch);
    this.draw(false);
  }

  private keyDown(event:KeyboardEvent){
    if(!/^(Key[WASD]|Arrow(Up|Down|Left|Right)|Shift(Left|Right)|Space)$/.test(event.code))return;
    event.preventDefault();
    if(this.keys.has(event.code))return;
    this.hasStreetInput=true;
    if(event.code==="Space"&&!event.repeat)this.pressSpace(event.timeStamp);
    this.keys.add(event.code);
    this.draw();
  }

  private wheel(event:WheelEvent){
    if(!this.flying||!event.deltaY)return;
    event.preventDefault();
    const units=event.deltaMode===0?100:event.deltaMode===1?3:1;
    this.flightSpeed=clamp(this.flightSpeed*1.25**clamp(-event.deltaY/units,-4,4),4,160);
    this.draw();
  }

  savePose():StreetPose{
    return {position:[this.x,this.y,this.z],yaw:this.yaw,pitch:this.pitch,flying:this.flying,airborne:this.airborne,
      flightSpeed:this.flightSpeed,verticalSpeed:this.verticalSpeed,hasFloor:this.hasFloor,entry:this.entrySpawn,destination:this.teleportEntry,fov:this.fov};
  }
  destination():Required<StreetDestination>{
    const [x,y]=this.position;
    return {position:[x,y,this.mesh.origin[2]+this.z],heading:headingDegrees(this.yaw),pitch:this.pitch*180/Math.PI,fov:this.fov};
  }

  restorePose(pose:StreetPose){
    this.world?.resetInteriorCamera();
    const relocated=Math.hypot(this.x-pose.position[0],this.y-pose.position[1],this.z-pose.position[2])>320;
    if(relocated)this.sky.invalidate();
    if(relocated||Math.abs(this.fov-(pose.fov??defaultStreetFov))>10)this.frameBudget.reset();
    [this.x,this.y,this.z]=pose.position;
    this.yaw=pose.yaw;this.pitch=pose.pitch;this.flying=pose.flying;this.airborne=pose.airborne;
    this.fov=pose.fov??defaultStreetFov;
    this.flightSpeed=pose.flightSpeed;this.verticalSpeed=pose.verticalSpeed;this.hasFloor=pose.hasFloor;
    this.entrySpawn=pose.entry;this.teleportEntry=pose.destination;this.initialRegion=false;this.draw();
  }

  relocate(position:readonly [number,number,number],yaw:number,pitch:number,fov=this.fov){
    if(!this.world||this.karstYaw!==undefined)return false;
    const local=position.map((value,i)=>value-this.mesh.origin[i]) as [number,number,number];
    this.restorePose({...this.savePose(),position:local,yaw,pitch,fov,airborne:false,verticalSpeed:0,hasFloor:true,entry:null,
      destination:{position:local,yaw,pitch}});
    this.keys.clear();
    return true;
  }

  installPending(boxes:StreetPendingBox[]){
    if(this.world?.installPending(boxes))this.draw();
  }
  installBridgeLods(links:[string,NonNullable<StreetChunk["placementLod"]>][]){
    if(this.world?.installBridgeLods(links))this.draw();
  }

  refreshAssets(){
    this.world?.update(this.x,this.y,true);
  }

  refreshTextures(){
    this.world?.refreshTextures();
  }

  private fixedDepthShadowShader?:WebGLProgram;
  private fixedDepthShadowLocations?:ReturnType<typeof uniforms>;
  private paintShadowCascade(center:StreetStreamView["eye"],inside:(bounds:Bounds)=>boolean,axes:number[][],
    settled:boolean,distant=false){
    const {gl,world,lighting}=this;
    if(!world||!lighting)return;
    if(!this.shadowShader){
      const program=makeProgram(gl,vertex,shadowFragment);
      this.shadowShader={program,locations:uniforms(gl,program),source:[vertex,shadowFragment]};
    }
    const {program,locations}=this.shadowShader;
    const bind=(program:WebGLProgram,locations:ReturnType<typeof uniforms>)=>{
      gl.useProgram(program);
      gl.uniform1i(locations("shadowPass"),1);
      gl.uniform1i(locations("materialColor"),1);
      gl.uniform3f(locations("eye"),this.x,this.y,this.z+1.62);
      gl.uniform3f(locations("sunDirection"),...lighting.sunDirection);
      gl.uniform4fv(locations("shadowX"),axes[0]);
      gl.uniform4fv(locations("shadowY"),axes[1]);
      gl.uniform4fv(locations("shadowZ"),axes[2]);
    };
    const bindFixed=rendererReview.shadows?()=>{
      if(!this.fixedDepthShadowShader){
        const ordinaryVertex=vertex.replace("if(mesh.w=="+nativeCanopyMaterial+".0){","if(false){");
        this.fixedDepthShadowShader=makeProgram(gl,ordinaryVertex,fixedDepthShadowFragment);
        this.fixedDepthShadowLocations=uniforms(gl,this.fixedDepthShadowShader);
      }
      const fixedLocations=this.fixedDepthShadowLocations!;
      bind(this.fixedDepthShadowShader,fixedLocations);
      return fixedLocations;
    }:undefined;
    try{
      bind(program,locations);
      world.paintShadows(center,inside,settled,locations,distant,bindFixed);
    }finally{
      gl.useProgram(this.program);
    }
  }

  refreshRenderer(){
    this.sky??=new StreetSky(this.gl);
    this.nativeClouds??=new StreetNativeClouds(this.gl);
    this.frameBudget??=new StreetFrameBudget(this.gl);
    if(!this.distantShadows&&this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS)>streetDistantShadowUnit)
      this.distantShadows=new StreetShadows(this.gl,true);
    if(this.shaderSource[0]!==vertex||this.shaderSource[1]!==fragment){
      const next=streetProgram(this.gl);
      disposeOpaque(this.gl);
      this.gl.deleteProgram(this.program);
      this.program=next;
      if(rendererReview.opaque)installOpaque(this.gl,next,mode=>streetProgram(this.gl,mode));
      this.locations=uniforms(this.gl,next);
      this.shaderSource=[vertex,fragment];
      if(this.world)this.world.shadowRevision++;
      const noise=this.sky.cloudNoiseSource;
      this.sky.dispose();this.sky=new StreetSky(this.gl);
      if(noise)this.sky.setCloudNoise(noise);
    }
    if(this.shadowShader&&(this.shadowShader.source[0]!==vertex||this.shadowShader.source[1]!==shadowFragment)){
      this.gl.deleteProgram(this.shadowShader.program);
      this.shadowShader=undefined;
      if(this.fixedDepthShadowShader)this.gl.deleteProgram(this.fixedDepthShadowShader);
      this.fixedDepthShadowShader=undefined;
      this.fixedDepthShadowLocations=undefined;
      if(this.world)this.world.shadowRevision++;
    }
    this.bindSamplers();
    if(this.world)Object.setPrototypeOf(this.world,StreetWorld.prototype);
    if(!this.canvasSize){
      this.canvasSize=[this.canvas.clientWidth,this.canvas.clientHeight];
      this.resize.disconnect();
      this.resize=this.observeCanvas();
    }
    this.draw();
  }

  toggleFlight(){
    this.hasStreetInput=true;
    this.flying=!this.flying;
    this.airborne=!this.flying;
    this.verticalSpeed=0;
    this.lastSpace=-Infinity;
    this.draw();
  }

  private pressSpace(now:number){
    if(now-this.lastSpace<=flightToggleWindow){
      this.toggleFlight();
      return;
    }
    this.lastSpace=now;
    if(!this.flying&&!this.airborne&&(!this.world||this.hasFloor)){
      this.airborne=true;
      this.verticalSpeed=jumpSpeed;
    }
  }

  private upload(mesh:StreetMesh){
    const {gl}=this,{vertices,indices}=mesh;
    for(let i=0;i<mesh.indices.length;i+=3){
      const a=mesh.indices[i]*4,b=mesh.indices[i+1]*4,c=mesh.indices[i+2]*4;
      const [ax,ay,az]=vertices.slice(a,a+3),[bx,by,bz]=vertices.slice(b,b+3),[cx,cy,cz]=vertices.slice(c,c+3);
      const material=vertices[a+3];
      if(material>=32&&material<40)continue;
      const det=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
      if(Math.abs(det)<1e-5)continue;
      const dz1=bz-az,dz2=cz-az;
      const dx=(dz1*(cy-ay)-dz2*(by-ay))/det;
      const dy=((bx-ax)*dz2-(cx-ax)*dz1)/det;
      const walkable=Math.hypot(dx,dy)<=1.2&&!(material<16&&Math.max(az,bz,cz)>-.75);
      const floor={ax,ay,az,bx,by,bz,cx,cy,cz,det,material,walkable};
      for(let y=Math.floor(Math.min(ay,by,cy)/8);y<=Math.floor(Math.max(ay,by,cy)/8);y++)
        for(let x=Math.floor(Math.min(ax,bx,cx)/8);x<=Math.floor(Math.max(ax,bx,cx)/8);x++){
          const key=`${x},${y}`,bucket=this.floors.get(key);
          if(bucket)bucket.push(floor);else this.floors.set(key,[floor]);
        }
    }
    gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.STATIC_DRAW);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,indices,gl.STATIC_DRAW);
    this.count=indices.length;
  }

  private surface(x:number,y:number,maximum=this.z+.61,ceilingFrom?:number){
    const a=Math.abs(along(x,y)),side=Math.abs(across(x,y));
    const wasInside=Math.abs(along(this.x,this.y))<27&&Math.abs(across(this.x,this.y))<1.3&&this.z<-.7;
    if(ceilingFrom===undefined&&wasInside&&a<27&&side>1.15)return null;
    const underRoof=wasInside&&a<26;
    let best=ceilingFrom===undefined?-Infinity:Infinity;
    for(const floor of this.floors.get(floorKey(x,y))??[]){
      const {ax,ay,az,bx,by,bz,cx,cy,cz,det,material}=floor;
      if(ceilingFrom===undefined&&(!floor.walkable||underRoof&&material>=16))continue;
      const u=((x-ax)*(cy-ay)-(y-ay)*(cx-ax))/det;
      const v=((bx-ax)*(y-ay)-(by-ay)*(x-ax))/det;
      if(u<-.002||v<-.002||u+v>1.002)continue;
      const height=az+u*(bz-az)+v*(cz-az);
      if(height>maximum)continue;
      if(ceilingFrom===undefined)best=Math.max(best,height);
      else if(height>=ceilingFrom)best=Math.min(best,height);
    }
    return Number.isFinite(best)?best:null;
  }

  reset(){
    this.world?.resetInteriorCamera();
    this.flying=false;this.airborne=false;this.verticalSpeed=0;
    this.flightSpeed=defaultFlightSpeed;this.lastSpace=-Infinity;this.keys.clear();
    if(this.world&&this.teleportEntry){
      const {position,yaw,pitch}=this.teleportEntry;
      [this.x,this.y,this.z]=position;
      this.yaw=yaw;this.pitch=pitch;this.hasFloor=true;
      this.draw();this.canvas.focus();
      return;
    }
    if(this.world){
      // The entry origin comes from an archived navigation polygon above the mesh floor.
      const caveHeight=this.karstYaw===undefined?null:this.world.floor(0,0,0,true);
      const entry=this.entrySpawn;
      const entryHeight=entry?this.world.floor(entry.x,entry.y,entry.z):null;
      const saved=entry&&entryHeight!==null&&Math.abs(entryHeight-entry.z)<.35?{...entry,z:entryHeight}:null;
      const picked="pickedSpawn" in this.mesh?this.mesh.pickedSpawn:undefined;
      this.flying=picked?.flying===true;
      const pickedHeight=picked&&!picked.flying?this.pickedFloor(picked.matchHeight):null;
      const start=picked?pickedHeight===null?null:{x:0,y:0,z:pickedHeight,yaw:Math.atan2(forward[1],forward[0])}:
        this.karstYaw===undefined?saved??this.world.spawn(-this.mesh.origin[2])??this.world.spawn():
        caveHeight!==null&&Math.abs(caveHeight)<=.35?{x:0,y:0,z:caveHeight,yaw:this.karstYaw}:null;
      if(start&&this.karstYaw===undefined&&this.initialRegion&&!this.hasStreetInput)this.entrySpawn=start;
      this.hasFloor=start!==null;
      this.x=start?.x??0;this.y=start?.y??0;this.z=start?.z??0;
      this.yaw=start?.yaw??Math.atan2(forward[1],forward[0]);
    }else{
      this.x=-32*forward[0];this.y=-32*forward[1];this.z=-1.4;this.z=this.surface(this.x,this.y)??-1.4;
      this.yaw=Math.atan2(forward[1],forward[0]);
    }
    this.pitch=-.07;
    this.draw();this.canvas.focus();
  }
  private hasFloor=false;
  private teleportEntry:StreetPose["destination"];
  private entrySpawn:ReturnType<StreetWorld["spawn"]>=null;
  private pickedFloor(matchHeight:boolean){
    const floor=matchHeight?this.world?.floorBelow(0,0,1):this.world?.floor(0,0);
    return floor===undefined||floor===null||matchHeight&&floor< -1?null:floor;
  }
  installRegion(wanted:string[]|null,meshes:StreetChunk[],error?:string){
    if(!this.world)return;
    const redraw=this.world.install(wanted,meshes,error);
    if(redraw)this.minimapPosition=null;
    const zBefore=this.z;
    const picked="pickedSpawn" in this.mesh?this.mesh.pickedSpawn:undefined;
    if(picked&&!picked.flying&&this.x===0&&this.y===0&&!this.hasStreetInput&&!this.flying&&!this.airborne){
      const height=this.pickedFloor(picked.matchHeight);
      if(height!==null){this.z=height;this.hasFloor=true;}
    }else if(!this.hasFloor&&!this.flying&&!this.airborne)this.reset();
    if(wanted){
      if(!picked&&this.karstYaw===undefined&&this.initialRegion&&!this.hasStreetInput&&this.hasFloor&&this.mesh.origin[2]+this.z<0){
        const start=this.world.spawn(-this.mesh.origin[2]);
        if(start){
          this.entrySpawn=start;
          this.x=start.x;this.y=start.y;this.z=start.z;this.yaw=start.yaw;
        }
      }
      this.initialRegion=false;
    }
    if(redraw||zBefore!==this.z)this.draw();
  }
  installTexture(id:string,image:StreetTextureImage|null,ground:boolean,compressed?:StreetBlockTexture,cube?:StreetCubeTexture,roadHeight?:RoadHeightMip[]){
    this.world?.installTexture(id,image,ground,compressed,cube,roadHeight);
    this.world?.refillTextureSlots();
    this.draw();
  }
  setNavigation(enabled:boolean){
    this.world?.setNavigation(enabled);
    this.draw();
  }
  installNavigation(wanted:string[],meshes:StreetChunk[]){
    this.world?.installNavigation(wanted,meshes);
    this.draw();
  }
  installVegetation(wanted:string[]|null,meshes:StreetChunk[]){
    if(this.world?.install(wanted,meshes,undefined,"vegetation"))this.draw();
  }
  installInteriors(wanted:string[]|null,meshes:StreetChunk[],complete:boolean){
    if(this.world?.installInteriors(wanted,meshes,complete))this.draw();
  }
  get position(){return [this.mesh.origin[0]+this.x,this.mesh.origin[1]+this.y] as const;}
  refreshImagery(){
    if(!this.imagery||this.imageryTimer)return;
    this.imageryTimer=window.setTimeout(()=>{
      this.imageryTimer=0;this.imageryDirty=true;this.draw();
    },140);
  }
  private uploadImagery(){
    if(!this.imagery)return;
    const [x,y]=this.position,[ox,oy]=this.mesh.origin;
    const cells=this.world?8:5,padding=this.world?3:2;
    const left=Math.floor(x/CELL)-padding,top=Math.floor(-y/CELL)-padding;
    const bx=left*CELL-ox,by=top*CELL+oy;
    const useOverview=Boolean(this.world&&(!this.world.loading||this.aerialUsesOverview)&&
      this.world.hasOverviewGround(this.x,this.y));
    if(!this.imageryDirty&&this.aerialRect[0]===bx&&this.aerialRect[1]===by&&this.aerialUsesOverview===useOverview)return;
    this.imageryDirty=false;
    this.aerialUsesOverview=useOverview;
    if(!this.imagery(this.aerialCanvas,[left,top,cells,cells],useOverview)){
      this.aerialRect=[bx,by,0,0];
      this.minimapPosition=null;
      return;
    }
    if(this.world){
      const {gl}=this;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D,this.aerial);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE,this.aerialCanvas);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    this.aerialRect=[bx,by,cells*CELL,cells*CELL];
    this.minimapPosition=null;
  }

  refreshRoadName(){
    const [x,y,z]=this.mesh.origin;
    this.hud.roadName?.(x+this.x,y+this.y,z+this.z);
  }

  private drawHud(){
    this.refreshRoadName();
    const flight=this.hud.flight,pressed=String(this.flying);
    if(flight&&flight.getAttribute("aria-pressed")!==pressed)flight.setAttribute("aria-pressed",pressed);
    const bearing=headingDegrees(this.yaw);
    const degrees=Math.round(bearing)%360;
    if(degrees!==this.displayedBearing){
      this.displayedBearing=degrees;
      this.hud.bearing.textContent=`Heading ${String(degrees).padStart(3,"0")}° ${compassPoints[Math.round(degrees/45)%8]}`;
      this.hud.marker.style.transform=`translate(-50%,-50%) rotate(${degrees}deg)`;
    }
    const [bx,by,width]=this.aerialRect;
    const canvas=this.hud.minimap;
    if(!width){
      const x=Math.round(this.x),y=Math.round(this.y);
      if(this.minimapPosition?.[0]===x&&this.minimapPosition[1]===y)return;
      const ctx=canvas.getContext("2d");
      if(ctx&&this.world)this.world.paintMinimap(ctx,x,y,CELL*3);
      this.minimapPosition=[x,y];return;
    }
    const span=CELL*3,density=this.aerialCanvas.width/width;
    const x=Math.round((this.x-bx-span/2)*density),y=Math.round((-this.y-by-span/2)*density);
    if(this.minimapPosition?.[0]===x&&this.minimapPosition[1]===y)return;
    const ctx=canvas.getContext("2d");
    if(!ctx)return;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(this.aerialCanvas,x,y,span*density,span*density,0,0,canvas.width,canvas.height);
    this.minimapPosition=[x,y];
  }
  setPaused(paused:boolean){
    this.paused=paused;
    this.keys.clear();
    this.lastSpace=-Infinity;
    if(paused){
      cancelAnimationFrame(this.frame);
      this.frame=0;
      this.hud.fps.reset();
    }else{
      this.time=performance.now();
      this.draw();
      this.canvas.focus();
    }
  }
  private draw(sceneChanged=true){
    if(sceneChanged)this.sceneDirty=true;
    if(!this.paused&&!this.frame)this.frame=requestAnimationFrame(now=>this.render(now));
  }

  private animateWater(visible:boolean,now:number,tick:boolean){
    if(!visible||this.reducedMotion.matches||document.hidden){
      this.nextWaterFrame=Infinity;
      return;
    }
    const interval=1000/30;
    const next=tick?this.nextWaterFrame+interval:now+interval;
    // Keep the display-aligned cadence through small RAF jitter, without
    // trying to catch up after a slow frame or a hidden tab.
    this.nextWaterFrame=next>now?next:now+interval;
    this.draw(false);
  }

  setLighting(enabled:boolean,minute:number,cloudCover=.55,environment=this.environment){
    this.environment=environment;
    this.lighting=enabled?streetLighting(minute,cloudCover,environment):undefined;
    this.world?.setLighting(enabled);
    this.draw();
  }

  get supportsCloudNoise(){return this.sky.supportsCloudNoise;}
  get supportsNativeClouds(){return this.nativeClouds.supported;}
  get supportsHdrSky(){return this.sky.supportsHdr;}

  setCloudNoise(noise:Uint8Array<ArrayBuffer>){
    if(this.sky.setCloudNoise(noise))this.draw();
  }

  setNativeClouds(assets:StreetCloudAssets){
    if(!this.nativeClouds.upload(assets))return;
    this.sky.invalidate();
    this.draw();
  }

  setWaterOptics(optics:StreetWaterOptics){
    if(this.world?.setWaterOptics(optics))this.draw();
  }

  setWaterTileRegion(optics?:StreetWaterOptics){
    if(this.world?.setWaterTileRegion(optics))this.draw();
  }

  setWaterMaterials(materials:StreetWaterMaterials){
    if(this.world?.setWaterMaterials(materials))this.draw();
  }

  private moveVertical(dt:number){
    if(!this.airborne)return false;
    const velocity=Math.max(-18,this.verticalSpeed-gravity*dt);
    const next=this.z+(this.verticalSpeed+velocity)*.5*dt;
    if(next>this.z){
      const head=this.z+headHeight,nextHead=next+headHeight;
      const roof=this.world?this.world.ceiling(this.x,this.y,head,nextHead):
        this.surface(this.x,this.y,nextHead,head);
      this.z=roof===null?next:Math.max(this.z,roof-headHeight-.001);
      this.verticalSpeed=roof===null?velocity:0;
    }else{
      const floor=this.world?this.world.floorBelow(this.x,this.y,this.z+.001):this.surface(this.x,this.y,this.z+.001);
      // Wait for a landing surface when leaving flight over unloaded terrain.
      if(floor===null)return false;
      this.z=Math.max(floor,next);
      this.airborne=next>floor;
      this.verticalSpeed=this.airborne?velocity:0;
      if(!this.airborne)this.hasFloor=true;
    }
    return this.airborne;
  }

  private render(now:number){
    this.frame=0;
    const {keys,gl,canvas}=this,dt=Math.min(.04,(now-this.time)/1000);
    this.time=now;
    const doorMoving=this.world?.updateRollers(now);
    if(doorMoving)this.draw();
    const pressed=(a:string)=>Number(keys.has(a));
    const turn=pressed("ArrowLeft")-pressed("ArrowRight"),tilt=pressed("ArrowUp")-pressed("ArrowDown");
    this.yaw+=turn*dt*1.65;
    this.pitch=clamp(this.pitch+tilt*dt*1.15,-maximumStreetPitch,maximumStreetPitch);
    const f=pressed("KeyW")-pressed("KeyS"),side=pressed("KeyD")-pressed("KeyA");
    const cos=Math.cos(this.yaw),sin=Math.sin(this.yaw);
    const shift=keys.has("ShiftLeft")||keys.has("ShiftRight");
    const up=this.flying?pressed("Space")-Number(shift):0;
    if(this.flying){
      const step=dt*this.flightSpeed/Math.max(1,Math.hypot(f,side,up));
      this.x+=(f*cos+side*sin)*step;
      this.y+=(f*sin-side*cos)*step;
      this.z+=up*step;
    }else if(f||side){
      const step=dt*(shift?runSpeed:walkSpeed)/Math.max(1,Math.hypot(f,side));
      const x=this.x+(f*cos+side*sin)*step,y=this.y+(f*sin-side*cos)*step;
      if(this.world&&(this.hasFloor||this.airborne)){
        const z=this.airborne?this.world.floor(x,y,this.z):this.world.stepFloor(this.x,this.y,x,y,this.z);
        const canStep=this.airborne?z===null||z<=this.z+.05:z!==null&&Math.abs(z-this.z)<.8;
        if(canStep&&!this.world.blocked(this.x,this.y,x,y,this.z)){
          this.x=x;this.y=y;
          if(!this.airborne&&z!==null)this.z=z;
        }
      }else if(!this.world&&x>-97&&x<117&&y>-97&&y<117){
        const z=this.surface(x,y);
        if(z!==null&&(this.airborne?z<=this.z+.05:Math.abs(z-this.z)<.64)){
          this.x=x;this.y=y;
          if(!this.airborne)this.z=z;
        }
      }
    }
    const movingVertically=this.moveVertical(dt);
    const camera=[this.x,this.y,this.z,this.yaw,this.pitch] as const,previous=this.lastCamera;
    const cameraMoved=previous!==undefined&&camera.some((value,i)=>value!==previous[i]);
    this.lastCamera=camera;
    if(cameraMoved)this.lastMotion=now;
    const remaining=motionSettleTime-(now-this.lastMotion),moving=remaining>0;
    const sceneChanged=this.sceneDirty||cameraMoved||moving!==this.moving;
    const waterAnimating=Number.isFinite(this.nextWaterFrame)&&!this.reducedMotion.matches&&!document.hidden;
    const waterTick=waterAnimating&&now+.25>=this.nextWaterFrame;
    const redraw=sceneChanged||waterTick;
    this.sceneDirty=false;this.moving=moving;
    const repeat=Boolean(f||side||up||turn||tilt||movingVertically);
    if(repeat)this.draw(false);
    else if(moving&&!this.motionTimer)this.motionTimer=window.setTimeout(()=>{
      this.motionTimer=0;this.draw(false);
    },remaining+1);
    if(!redraw){
      if(waterAnimating)this.draw(false);
      return;
    }
    const [cssWidth,cssHeight]=this.canvasSize;
    let ratio=Math.min(2,devicePixelRatio||1);
    const movingScale=this.frameBudget.update(now,Boolean(this.world&&moving));
    if(this.world&&moving)ratio=Math.min(ratio,Math.sqrt(movingPixelBudget/(cssWidth*cssHeight)))*movingScale;
    const w=Math.round(cssWidth*ratio),h=Math.round(cssHeight*ratio);
    if(w&&h&&waterTick&&!sceneChanged&&!moving&&this.world&&canvas.width===w&&canvas.height===h){
      gl.useProgram(this.program);
      gl.uniform1f(this.locations("waterTime"),this.reducedMotion.matches?0:now/1000*(this.lighting?.rippleSpeed??1));
      const replayed=this.world.replayWater(w,h,this.program);
      if(replayed!==null){
        this.edgeAA.paint(this.program);
        this.hud.fps.frame(now);
        this.animateWater(replayed,now,true);
        return;
      }
    }
    let chunks=0,textured=0,groundDraws=0,detailDraws=0,navigationDraws=0,roadDraws=0,roadDecals=0,terrainDraws=0,vegetationDraws=0,settling=false;
    if(w&&h){
      const eye=[this.x,this.y,this.z+1.62] as const;
      const farPlane=streetProjectionFarPlane(this.lighting?.farClip,this.mesh.origin[2]+eye[2],this.environment?.farClipRamp);
      const camera:StreetStreamView={eye,yaw:this.yaw,pitch:this.pitch,aspect:w/h,fov:this.fov,farPlane};
      const door=this.world?.rollerButton(camera);
      this.rollerTarget=door?.id;
      this.rollerAction.hidden=!door;
      if(door){
        this.rollerAction.style.left=door.x+"%";
        this.rollerAction.style.top=door.y+"%";
        const label=door.open?"Close roller door":"Open roller door";
        if(this.rollerAction.textContent!==label)this.rollerAction.textContent=label;
      }
      this.world?.update(this.x,this.y,false,camera,moving);
      if(!this.world||this.hasFloor||this.flying||this.airborne)this.uploadImagery();
      if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
      const cloudConfig=this.environment?.nativeClouds;
      const nativeClouds=this.nativeClouds.prepare(cloudConfig,this.lighting?.cloudBlend);
      const timed=Boolean(this.world&&moving&&this.frameBudget.begin(now));
      gl.viewport(0,0,w,h);gl.clearColor(.54,.67,.75,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.useProgram(this.program);gl.bindVertexArray(this.vao);
      gl.uniform3f(this.locations("eye"),this.x,this.y,this.z+1.62);
      gl.uniform2f(this.locations("heading"),cos,sin);
      gl.uniform2f(this.locations("pitch"),Math.cos(this.pitch),Math.sin(this.pitch));
      gl.uniform1f(this.locations("aspect"),w/h);
      gl.uniform1f(this.locations("projectionScale"),streetProjection(this.fov));
      gl.uniform1i(this.locations("lightingEnabled"),Number(Boolean(this.lighting)));
      const drawSky=this.lighting?()=>{
        gl.uniform1i(this.locations("skyPass"),1);
        gl.bindVertexArray(null);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(false);
        gl.drawArrays(gl.TRIANGLES,0,3);
        gl.depthMask(true);
        gl.depthFunc(gl.LESS);
        gl.uniform1i(this.locations("skyPass"),0);
      }:undefined;
      if(this.lighting){
        const {sunDirection,sunlight,skyLight,groundLight,ambientSkyGain,horizonColor,zenithColor,cloudCover,cloudLayer,cloudShape,
          shapeNoise,cloudShadowAlpha,fogProfile,atmosphere,skyScatter}=this.lighting;
        gl.uniform3f(this.locations("sunDirection"),...sunDirection);
        gl.uniform3f(this.locations("sunlight"),...sunlight);
        gl.uniform3f(this.locations("skyLight"),...skyLight);
        gl.uniform3f(this.locations("groundLight"),...groundLight);
        gl.uniform3f(this.locations("ambientSkyGain"),...ambientSkyGain);
        gl.uniform3f(this.locations("horizonColor"),...horizonColor);
        gl.uniform3f(this.locations("zenithColor"),...zenithColor);
        gl.uniform1f(this.locations("cloudCover"),cloudCover);
        gl.uniform4fv(this.locations("cloudLayer"),cloudLayer);
        gl.uniform4fv(this.locations("cloudShape"),cloudShape);
        gl.uniform3fv(this.locations("cloudNoiseWeights"),shapeNoise);
        this.sky.useCloudNoise(this.locations("hasCloudNoiseVolume"));
        gl.uniform1i(this.locations("hasNativeClouds"),Number(nativeClouds));
        if(nativeClouds&&cloudConfig){
          this.nativeClouds.bind();
          gl.uniform4fv(this.locations("nativeCloudShapes[0]"),cloudConfig.layers);
          gl.uniform3f(this.locations("nativeCloudFrequency"),...cloudConfig.frequency);
          gl.uniform3f(this.locations("nativeCloudWarp"),...cloudConfig.warp);
        }
        const observer=[(this.mesh.origin[0]+this.x)/1000,(this.mesh.origin[1]+this.y)/1000,
          (this.mesh.origin[2]+this.z+1.62)/1000] as const;
        gl.uniform3f(this.locations("cloudObserver"),...observer);
        gl.uniform1f(this.locations("atmosphereHeight"),atmosphere?.height??0);
        if(atmosphere){
          gl.uniform4fv(this.locations("rayleighScattering"),atmosphere.rayleigh);
          gl.uniform4fv(this.locations("mieScattering"),atmosphere.mie);
          gl.uniform4fv(this.locations("mieAbsorption"),atmosphere.absorption);
        }
        gl.uniform3fv(this.locations("fogProfile"),fogProfile);
        gl.uniform1f(this.locations("cameraAltitude"),this.mesh.origin[2]+this.z+1.62);
        gl.uniform1i(this.locations("skyPass"),1);
        gl.disable(gl.DEPTH_TEST);
        gl.bindVertexArray(null);
        const shadowAmount=cloudShadowAlpha*Math.min(1,cloudCover*5)*clamp((sunDirection[2]-.12)*5,0,1);
        const region=shadowAmount>0?this.sky.updateCloudShadows(this.lighting,
          (this.mesh.origin[0]+this.x)/1000,(this.mesh.origin[1]+this.y)/1000,area=>{
            gl.uniform3f(this.locations("cloudShadowRegion"),...area);
            gl.uniform1i(this.locations("cloudShadowBake"),1);
            gl.drawArrays(gl.TRIANGLES,0,3);
            gl.uniform1i(this.locations("cloudShadowBake"),0);
          }):undefined;
        gl.uniform1i(this.locations("hasCloudShadows"),Number(Boolean(region)));
        if(region)gl.uniform1f(this.locations("cloudShadowAlpha"),shadowAmount);
        const skyReady=this.sky.update(this.lighting,(hdr,bakeObserver)=>{
          gl.uniform1i(this.locations("skyHdr"),Number(hdr&&Boolean(skyScatter)));
          if(hdr&&skyScatter)gl.uniform3fv(this.locations("skyScatterSource[0]"),skyScatter);
          if(bakeObserver)gl.uniform3f(this.locations("cloudObserver"),...bakeObserver);
          gl.uniform1i(this.locations("skyBake"),1);
          gl.drawArrays(gl.TRIANGLES,0,3);
          gl.uniform1i(this.locations("skyBake"),0);
          if(bakeObserver)gl.uniform3f(this.locations("cloudObserver"),...observer);
        },nativeClouds&&cloudCover>0?{observer,now,moving}:undefined);
        gl.uniform1f(this.locations("previousSkyAmount"),this.sky.previousAmount);
        if(this.sky.needsFrame)this.draw();
        gl.uniform1i(this.locations("skyHdr"),Number(skyReady&&this.sky.supportsHdr&&Boolean(skyScatter)));
        gl.uniform1i(this.locations("hasSkyEnvironment"),Number(skyReady));
        gl.bindVertexArray(this.vao);
        gl.enable(gl.DEPTH_TEST);
        gl.uniform1i(this.locations("skyPass"),0);
      }
      gl.uniform1f(this.locations("nearPlane"),this.world?streetNearPlane:.045);
      gl.uniform1f(this.locations("inverseHalfFarPlane"),this.world?2/farPlane:1/240);
      const octaTint=this.lighting?this.environment?.octaDiffuseTint:undefined;
      gl.uniform3f(this.locations("octaDiffuseTint"),...(octaTint?.rgb??[1,1,1] as const));
      gl.uniform2f(this.locations("octaDiffuseRamp"),octaTint?.start??0,octaTint?1/octaTint.range:0);
      gl.uniform4f(this.locations("octaViewWeights"),...(this.environment?.octaViewWeights??[0,0,0,0] as const));
      gl.uniform1f(this.locations("waterTime"),this.reducedMotion.matches?0:now/1000*(this.lighting?.rippleSpeed??1));
      gl.uniform1f(this.locations("waveStrength"),this.lighting?.waveStrength??1);
      gl.uniform2f(this.locations("waterOrigin"),this.mesh.origin[0],this.mesh.origin[1]);
      gl.uniform1i(this.locations("useMaterial"),0);
      gl.uniform1i(this.locations("hasDetailNormal"),0);
      gl.uniform2f(this.locations("detailNormalBumpiness"),0,1);
      gl.uniform1i(this.locations("roadEnabled"),0);
      gl.uniform1i(this.locations("terrainEnabled"),0);
      gl.uniform1i(this.locations("twoLayerDecal"),0);
      gl.uniform1i(this.locations("alphaLayer"),0);
      gl.uniform1i(this.locations("frontOnlyDecal"),0);
      gl.uniform1i(this.locations("instanced"),0);
      gl.uniform3f(this.locations("groundAtlas"),0,0,0);
      if(this.world)gl.uniform4f(this.locations("aerialRect"),...this.aerialRect);
      else gl.uniform4f(this.locations("aerialRect"),0,0,0,0);
      gl.uniform1i(this.locations("aerialUsesOverview"),Number(this.aerialUsesOverview));
      if(this.world){
        const revision=this.world.shadowRevision;
        gl.uniform1i(this.locations("sunShadows"),0);
        gl.uniform1i(this.locations("sunDistantShadows"),0);
        const altitude=this.flying?this.mesh.origin[2]+this.z:0;
        const distantDelay=this.lighting&&this.distantShadows?this.distantShadows.update(camera.eye,this.mesh.origin,
          this.lighting.sunDirection,this.lighting.sunlight[0],revision,now,!moving&&!this.world.loading,this.yaw,altitude,
          this.locations,(center,inside,axes)=>this.paintShadowCascade(center,inside,axes,false,true)):undefined;
        const shadowDelay=this.lighting?this.shadows.update(camera.eye,this.mesh.origin,this.lighting.sunDirection,
          this.lighting.sunlight[0],revision,now,!moving,this.yaw,altitude,this.locations,(center,inside,axes)=>
            this.paintShadowCascade(center,inside,axes,!moving)):undefined;
        // Match the native eight-sample cycle on full rendered frames.
        const ditherEnabled=!this.reducedMotion.matches;
        if(ditherEnabled)this.parallaxSample=(this.parallaxSample+1)&7;
        gl.uniform3f(this.locations("propParallaxTemporal"),this.parallaxSample,ditherEnabled?4:0,h);
        const result=this.world.paint(camera,moving,this.lighting,
          this.locations("useMaterial"),this.locations("alphaLayer"),this.locations("groundAtlas"),this.locations("instanced"),
          this.locations,this.program,!this.reducedMotion.matches&&!document.hidden,drawSky,
          rendererReview.occlusion?()=>this.draw():undefined);
        chunks=result.draws;textured=result.textured;groundDraws=result.groundDraws;
        detailDraws=result.detailDraws;navigationDraws=result.navigationDraws;roadDraws=result.roadDraws;roadDecals=result.roadDecals;settling=result.settling;
        vegetationDraws=result.vegetationDraws;
        terrainDraws=result.terrainDraws;
        const delay=Math.min(distantDelay??Infinity,shadowDelay??Infinity);
        if(this.lighting&&(Number.isFinite(delay)||revision!==this.world.shadowRevision)&&!this.shadowTimer)this.shadowTimer=window.setTimeout(()=>{
          this.shadowTimer=0;this.draw();
        },Number.isFinite(delay)?delay+1:135);
        this.animateWater(result.animateWater,now,waterTick&&!sceneChanged);
        if(result.textureDelay===undefined){
          if(this.texturePlanTimer)clearTimeout(this.texturePlanTimer);
          this.texturePlanTimer=0;
        }else if(!this.texturePlanTimer)this.texturePlanTimer=window.setTimeout(()=>{
          this.texturePlanTimer=0;this.draw();
        },result.textureDelay);
      }else if("indices" in this.mesh){
        if(drawSky){drawSky();gl.bindVertexArray(this.vao);}
        gl.drawElements(gl.TRIANGLES,this.count,
          this.mesh.indices.BYTES_PER_ELEMENT===2?gl.UNSIGNED_SHORT:gl.UNSIGNED_INT,0);
      }
      this.edgeAA.paint(this.program);
      if(timed)this.frameBudget.end();
      this.hud.fps.frame(now);
    }
    if(settling)this.draw();
    if(moving&&now<this.nextHud)return;
    this.nextHud=now+100;
    this.drawHud();
    const [ox,oy,oz]=this.mesh.origin;
    const status=this.world&&!this.hasFloor&&!this.flying&&!this.airborne
      ?this.world.error||(this.world.loading?"Reading gameplay terrain":"No recovered gameplay ground here. Try another map location.") :
      `X ${(ox+this.x).toFixed(1)} · Y ${(oy+this.y).toFixed(1)} · Z ${(oz+this.z).toFixed(1)}`+
      (this.flying?` · Flight speed ${this.flightSpeed.toFixed(1)}`:"")+
      (this.world?` · ${chunks} visible chunks`:"")+
      (textured?` · ${textured} original texture draws`:"")+
      (roadDraws?` · ${roadDraws} layered road draws`:"")+
      (roadDecals?` · ${roadDecals} road decal draws`:"")+
      (vegetationDraws?` · ${vegetationDraws} foliage draws`:"")+
      (terrainDraws?` · ${terrainDraws} layered terrain draws`:"")+
      (groundDraws?` · ${groundDraws} ground texture draws`:"")+
      (detailDraws?` · ${detailDraws} high-detail terrain cells`:"")+
      (this.world?.hasOverviewGround(this.x,this.y)?" · Overview terrain nearby":"")+
      (navigationDraws?` · ${navigationDraws} navigation cells`:"")+
      (this.world?.error?" · Nearby geometry load interrupted":"");
    if(this.status.textContent!==status)this.status.textContent=status;
  }
  dispose(){
    this.hud.fps.reset();
    this.events.abort();
    this.rollerAction.remove();
    this.resize.disconnect();
    clearTimeout(this.imageryTimer);
    clearTimeout(this.texturePlanTimer);
    clearTimeout(this.motionTimer);
    clearTimeout(this.shadowTimer);
    this.hud.bearing.textContent="";
    this.hud.marker.style.removeProperty("transform");
    const minimap=this.hud.minimap;
    minimap.getContext("2d")?.clearRect(0,0,minimap.width,minimap.height);
    this.world?.dispose();
    this.shadows.dispose();
    this.edgeAA.dispose();
    this.distantShadows?.dispose();
    if(this.shadowShader)this.gl.deleteProgram(this.shadowShader.program);
    if(this.fixedDepthShadowShader)this.gl.deleteProgram(this.fixedDepthShadowShader);
    this.sky.dispose();
    this.nativeClouds.dispose();
    this.frameBudget.dispose();
    this.gl.deleteTexture(this.aerial);
    cancelAnimationFrame(this.frame);
    this.gl.deleteBuffer(this.geometry);this.gl.deleteBuffer(this.elements);
    disposeOpaque(this.gl);
    this.gl.deleteVertexArray(this.vao);this.gl.deleteProgram(this.program);
  }
}

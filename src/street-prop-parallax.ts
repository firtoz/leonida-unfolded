// The verified prop_batch_standard_2lyr_pxm permutation. It reuses the
// ordinary layered prop bindings and the terrain units for its extra maps.
export const streetPropParallaxShader=`
uniform highp vec4 propParallaxMarch;
uniform highp vec3 propParallaxTemporal;

float propParallaxDither(vec2 pixel,int sampleIndex,float distance,float strength){
  float phase=float((sampleIndex+3)&63);
  vec2 shifted=pixel+uintBitsToFloat(0x40b2d2d8u)*phase;
  float hash=fract(uintBitsToFloat(0x4253ee82u)*fract(
    uintBitsToFloat(0x3bbf4590u)*shifted.y+uintBitsToFloat(0x3d897143u)*shifted.x));
  return hash*strength*(1.0-clamp(distance*uintBitsToFloat(0x3d888888u),0.0,1.0));
}

vec2 marchPropHeight(highp sampler2D mask,vec2 uv,vec2 dx,vec2 dy,vec2 direction,
    float steps,float travel,float start){
  float previousRay=1.0;
  float previousGap=previousRay-textureGrad(mask,uv+direction*start,dx,dy).b-1e-6;
  if(previousGap<=0.0)return direction*start;
  float height=0.0;
  for(int i=1;i<=15;i++){
    float fraction=float(i)/steps;
    float ray=1.0-fraction;
    float gap=ray-textureGrad(mask,uv+direction*(start-travel*fraction),dx,dy).b;
    if(gap<=0.0||i==15){
      float denominator=previousGap-gap;
      height=clamp(denominator>0.0?(ray*previousGap-previousRay*gap)/denominator:ray-gap,0.0,1.0);
      break;
    }
    previousRay=ray;
    previousGap=gap;
  }
  return direction*(start-travel*(1.0-height));
}

float propNoiseRank(ivec2 p){
  vec2 bytes=texelFetch(terrainTint,p&ivec2(63),0).rg;
  return dot(bytes,vec2(256.0,1.0))/257.0;
}

float propBlueNoise(vec2 uv){
  vec2 pixel=uv*64.0-0.5;
  ivec2 p=ivec2(floor(pixel));
  vec2 f=fract(pixel);
  return mix(mix(propNoiseRank(p),propNoiseRank(p+ivec2(1,0)),f.x),
    mix(propNoiseRank(p+ivec2(0,1)),propNoiseRank(p+ivec2(1,1)),f.x),f.y);
}

float propDetailShift(float phase){
  return sin(6.28318530718*fract(phase*uintBitsToFloat(0x3ef47644u)));
}

float propDetail(highp sampler2D atlas,vec2 uv,float strength){
  vec2 dx=dFdx(uv),dy=dFdy(uv);
  float phase=8.0*propBlueNoise(.02*uv);
  vec3 a=textureGrad(atlas,uv+propDetailShift(floor(phase)),dx,dy).rgb;
  vec3 b=textureGrad(atlas,uv+propDetailShift(floor(phase)+1.0),dx,dy).rgb;
  float blend=clamp(fract(phase)+.1*dot(b-a,vec3(1.0)),0.0,1.0);
  return clamp(.5+(mix(a.b,b.b,blend)-.5)*strength,0.0,1.0);
}

float propParallaxWeight(float raw,float aux,float reciprocal){
  raw=clamp(raw,0.0,1.0);
  float shaped=clamp(raw/max(.01,reciprocal+(1.0-reciprocal)*raw),0.0,1.0);
  return clamp(shaped*min(1.0,3.0*aux),0.0,1.0);
}

vec3 propParallaxColor(vec3 normal,vec3 view,float distance,vec3 palette){
  vec2 offset0=vec2(0.0),offset1=vec2(0.0);
  vec2 dx=dFdx(materialUV),dy=dFdy(materialUV);
  float nv=dot(normal,view),incidence=abs(nv);
  float fade=clamp((distance-3.0)/15.0,0.0,1.0);
  float steps=floor(15.0-14.0*clamp(.2*incidence+.8*fade,0.0,1.0));
  float gate=clamp(4.0*(1.0-incidence),0.0,1.0)*(1.0-fade)*
    (1.0-propParallaxVertex.x)*clamp(steps-1.0,0.0,1.0);
  vec3 axis=terrainTangent.xyz-dot(terrainTangent.xyz,normal)*normal;
  if(gate>0.0&&abs(nv)>1e-5&&dot(axis,axis)>1e-8&&terrainTangent.w!=0.0){
    vec2 pixel=vec2(gl_FragCoord.x,propParallaxTemporal.z-gl_FragCoord.y);
    steps+=propParallaxDither(pixel,int(propParallaxTemporal.x),distance,propParallaxTemporal.y);
    vec3 tangent=normalize(axis);
    vec3 bitangent=cross(tangent,normal)*sign(terrainTangent.w);
    vec2 ray=vec2(dot(tangent,view),dot(bitangent,view))/nv;
    offset0=marchPropHeight(roadColors[1],materialUV,dx,dy,ray,steps,gate*propParallaxMarch.x,gate*propParallaxMarch.y);
    offset1=marchPropHeight(roadColors[2],materialUV,dx,dy,ray,steps,gate*propParallaxMarch.z,gate*propParallaxMarch.w);
  }
  vec2 uv0=materialUV+offset0,uv1=materialUV+offset1;
  vec4 diffuse0=texture(roadMask,uv0),diffuse1=texture(roadColors[0],uv1);
  vec4 mask0=texture(roadColors[1],uv0),mask1=texture(roadColors[2],uv1);
  float reciprocal=propLayerState.y;
  float vertexWeight=terrainVertexColor.a;
  float preliminary=propParallaxWeight(vertexWeight,propLayerAux,reciprocal);
  float control=texture(roadColors[3],materialUV+mix(offset0,offset1,preliminary)).b;
  float weight=propParallaxWeight(vertexWeight*(1.0+propLayerAux*control),propLayerAux,reciprocal)*diffuse1.a;
  vec3 a=diffuse0.rgb*mix(vec3(1.0),palette,mask0.a);
  vec3 b=diffuse1.rgb*mix(vec3(1.0),palette,mask1.a);
  float detail0=propDetail(terrainHeights[2],uv0*vec2(8,4)*propParallaxVertex.y,mask0.r);
  float detail1=propDetail(terrainHeights[3],uv1*vec2(10,5)*propParallaxVertex.y,mask1.r);
  float gain=1.0+mix(detail0-.5,2.0*detail1-1.0,weight);
  float neutral=126.0/255.0;
  float dirtHeight=neutral+(1.0-propParallaxVertex.x)*(.3*(mix(mask0.b,mask1.b,weight)-neutral)+.15);
  vec2 dirtOffset=mix(offset0,offset1,max(0.0,weight-decalBlend));
  vec4 dirt=texture(terrainHeights[1],terrainThirdUV+dirtOffset);
  float dirtWeight=propLayerDirtWeight*dirt.a*smoothstep(0.0,1.0,10.0*(1.0-dirtHeight));
  float materialA=mix(texture(terrainNormals[0],uv0).r,texture(terrainNormals[1],uv1).r,weight);
  return mix(mix(a,b,weight)*gain,dirt.rgb,dirtWeight)*(1.0-clamp(materialA-dirtWeight,0.0,1.0));
}
`;

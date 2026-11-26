import { streetSkyScatteringAltitudes } from "./street-sky-scattering";

// Scattering is evaluated only when baking the angular environment.
// The shorter world passes sample the finished texture.
export const atmosphericScattering=`
uniform vec4 rayleighScattering;
uniform vec4 mieScattering;
uniform vec4 mieAbsorption;
uniform float atmosphereHeight;
uniform vec3 skyScatterSource[${streetSkyScatteringAltitudes}];

vec3 encodeSkyRadiance(vec3 displayColor){
  vec3 linear=linearColor(displayColor);
  return linear/max(vec3(.11),1.0-.58*linear);
}
vec3 displaySkyRadiance(vec3 radiance){
  return srgbColor(radiance/(1.0+.58*radiance));
}

vec3 scatterClearSky(vec3 direction,vec3 fallback){
  if(atmosphereHeight<=0.0||sunDirection.z<-.12)return skyHdr?encodeSkyRadiance(fallback):fallback;
  float radius=cloudLayer.w,cosine=max(0.0,direction.z),tangent=cosine*radius;
  float shell=atmosphereHeight*(2.0*radius+atmosphereHeight);
  float end=shell/(sqrt(tangent*tangent+shell)+tangent);
  float asymmetry=mieAbsorption.w,mu=dot(direction,sunDirection);
  float rayPhase=.0596831*(1.0+mu*mu);
  float miePhase=.1193662*(1.0-asymmetry*asymmetry)*(1.0+mu*mu)/
    ((2.0+asymmetry*asymmetry)*pow(max(.001,1.0+asymmetry*asymmetry-2.0*asymmetry*mu),1.5));
  vec3 ray=rayleighScattering.rgb,mie=mieScattering.rgb;
  vec3 aerosolExtinction=mie+mieAbsorption.rgb;
  vec2 scale=vec2(rayleighScattering.a,mieScattering.a);
  vec2 viewColumn=vec2(0.0);
  vec3 radiance=vec3(0.0);
  float start=0.0;
  for(int i=0;i<20;i++){
    float u=float(i+1)/20.0;
    float next=end*u*u;
    float distance=(start+next)*.5,segment=next-start;
    vec3 position=direction*distance+vec3(0.0,0.0,radius);
    // Subtraction near the ground loses precision on a planetary scale.
    float altitude=distance*(2.0*tangent+distance)/(length(position)+radius);
    vec2 density=exp(-altitude/scale),local=density*segment;
    float solarCosine=dot(position,sunDirection)/(radius+altitude);
    float dip=sqrt(2.0*altitude/radius);
    if(solarCosine>-dip){
      // The curvature term bounds the slant column for a tangent sun ray.
      vec2 airMass=2.0/(max(0.0,solarCosine)+sqrt(solarCosine*solarCosine+2.0*scale/radius));
      vec2 column=viewColumn+local*.5+density*scale*airMass;
      vec3 transmission=exp(-ray*column.x-aerosolExtinction*column.y);
      radiance+=transmission*(ray*(rayPhase*local.x)+mie*(miePhase*local.y));
    }
    if(skyHdr){
      const int last=${streetSkyScatteringAltitudes-1};
      float v=clamp(sqrt(altitude/atmosphereHeight)*float(last),0.0,float(last));
      int level=int(v);
      vec3 multiple=mix(skyScatterSource[level],skyScatterSource[min(level+1,last)],fract(v));
      vec2 column=viewColumn+local*.5;
      vec3 transmission=exp(-ray*column.x-aerosolExtinction*column.y);
      radiance+=transmission*(ray*local.x+mie*local.y)*multiple;
    }
    viewColumn+=local;
    start=next;
  }
  // The fallback retains a diffuse multiple-scatter term and the night sky.
  float daylight=smoothstep(-.09,.16,sunDirection.z);
  vec3 direct=radiance*sunlight*11.0;
  if(skyHdr)return mix(encodeSkyRadiance(fallback),direct,.64*daylight);
  vec3 color=displaySkyRadiance(direct);
  return mix(fallback,mix(fallback,color,.64),daylight);
}
`;

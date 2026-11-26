export const streetRoomShader=`
#if STREET_ROOMS
flat in vec4 roomDimensions;
flat in vec2 roomSizeUV;
uniform samplerCube roomColorCube;
uniform vec4 roomState;
uniform bool roomHasProjection;
uniform vec3 roomDensity;
uniform vec4 roomAbsorption;
vec3 streetRoomGlass(vec3 color,vec4 projected,float alpha,float path,float projectedDepth,vec3 eyeRay){
  vec4 diffuse0=texture(roadColors[0],materialUV);
  vec4 diffuse1=texture(roadColors[1],materialUV);
  float tint=texture(roadColors[2],materialUV).a;
  float mask=mix(texture(roadColors[3],materialUV).r,texture(terrainHeights[0],materialUV).r,diffuse1.a);
  vec3 exterior=mix(diffuse0.rgb*mix(vec3(1),terrainVertexColor.rgb,tint),diffuse1.rgb,diffuse1.a)*
    (1.0-clamp(mask,0.0,1.0));
  // The viewer has no deferred room-color volume. Use the replay's unit gain.
  vec2 distanceWeight=clamp(1.0-vec2(path,projectedDepth)/roomAbsorption.w,0.0,1.0);
  vec2 gain=.025+.975*distanceWeight*distanceWeight;
  vec3 room=mix(color*gain.x,projected.rgb*gain.y,alpha);
  float alignment=dot(surfaceNormal,eyeRay);
  float incidence=max(.0001,abs(alignment));
  float density=mix(roomDensity.x,min(roomDensity.y,roomDensity.x/incidence),roomDensity.z);
  vec3 transmission=exp(-density*roomAbsorption.xyz*exterior.bgr);
  float glass=1.0-textureLod(roadColors[1],materialUV,0.0).a>=.02?1.0-diffuse0.a:0.0;
  return mix(exterior,transmission*transmission*mix(exterior,room,glass),1.0-diffuse1.a);
}

float foldRoomCoordinate(float coordinate,float extent,float copies){
  float unit=2.0*coordinate*copies/extent;
  if(mod(copies,2.0)==0.0)return 2.0*fract(.5*unit)-1.0;
  return unit>=-1.0&&unit<=1.0?unit:mod(unit+1.0,2.0)-1.0;
}

bool sampleStreetRoom(out vec3 color){
  // Other room selectors use a different projection or texture path.
  if(roomState.y<=0.0||roomDimensions.b>0.0)return false;
  float roomScale=1.0-roomSizeUV.y;
  float rows=roundEven(31.875*roomDimensions.r)+1.0;
  float columns=20.0*roomDimensions.a;
  columns=roomDimensions.a-.05*trunc(columns)<.02?floor(columns):ceil(columns);
  vec3 extent=roomScale*vec3(5.0*roomDimensions.g*rows,columns,roomState.y*roomSizeUV.x);
  if(any(lessThanEqual(extent,vec3(0))))return false;
  vec3 N=surfaceNormal,U=terrainTangent.xyz,V=terrainSecondaryTangent.xyz;
  mat3 frame=transpose(mat3(N/extent.x,U/extent.y,-V/extent.z));
  vec3 relative=world-eye;
  vec3 surface=U*(roadSecondaryUV.x-.5)*extent.y+V*(roadSecondaryUV.y-.5)*roomScale;
  vec3 offset=-relative+surface;
  vec3 origin=frame*(offset+.5*extent.x*N);
  vec3 eyeRay=normalize(relative),localRay=frame*eyeRay;
  vec3 direction=normalize(localRay);
  vec3 side=mix(vec3(-1),vec3(1),greaterThan(direction,vec3(0)));
  vec3 divisor=side*max(abs(direction),vec3(1e-7));
  vec3 nearTime=(-.5*side-origin)/divisor,farTime=(.5*side-origin)/divisor;
  float nearHit=max(nearTime.x,max(nearTime.y,nearTime.z));
  float farHit=min(farTime.x,min(farTime.y,farTime.z));
  if(farHit<max(0.0,nearHit))return false;
  vec3 far=origin+direction*farHit;
  vec3 farWorld=N*(far.x*extent.x)+U*(far.y*extent.y)-V*(far.z*extent.z);
  float widthRepeat=max(1.0,roomState.x+columns-1.0);
  vec3 cubeRay=vec3(foldRoomCoordinate(dot(farWorld,N),extent.x,rows),
    foldRoomCoordinate(dot(farWorld,U),extent.y,widthRepeat),
    foldRoomCoordinate(-dot(farWorld,V),extent.z,roomState.y));
  if(farHit==farTime.x)cubeRay.x=side.x;
  else if(farHit==farTime.y)cubeRay.y=side.y;
  else cubeRay.z=side.z;
  float turns=round(3.0*roomDimensions.g);
  if(turns==1.0)cubeRay.xy=vec2(-cubeRay.y,cubeRay.x);
  else if(turns==2.0)cubeRay.xy=-cubeRay.xy;
  else if(turns==3.0)cubeRay.xy=vec2(cubeRay.y,-cubeRay.x);
  color=texture(roomColorCube,cubeRay).rgb;
  vec3 projectedOrigin=frame*(offset+N*(roomState.z*extent.x/rows));
  vec3 mid=projectedOrigin-direction*(projectedOrigin.x/divisor.x);
  vec4 projected=vec4(0);
  if(roomHasProjection&&abs(mid.y)<.5&&abs(mid.z)<.5){
    vec2 uv=vec2(fract(widthRepeat*(mid.y+.5))*.5,fract(roomState.y*(.5-mid.z)*.5));
    projected=texture(roadMask,uv);
  }
  float alpha=roomHasProjection?clamp(projected.a/max(roomState.w,1e-6),0.0,1.0):0.0;
  if(roomAbsorption.w>0.0)
    color=streetRoomGlass(color,projected,alpha,(farHit-nearHit)/length(localRay),roomScale*roomState.z,eyeRay);
  else color=mix(color,projected.rgb,alpha);
  return true;
}
#endif
`;

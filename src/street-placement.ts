type LinearTransform=readonly [number,number,number,number,number,number,number,number,number];

export type SignLabel={text:string;font:number;scale:number;width:number;anchor:number;lineScale:number;rgba:number};

export type Placement = {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number];
  linear?: LinearTransform;
  tintSelector?: number;
  propLayerControl?: number;
  propDirtControl?: number;
  signLabel?: SignLabel;
};

export function placementMatrix(placement:Placement,anchor:readonly [number,number,number]){
  const {position,scale:[xy,zScale],rotation:[qx,qy,qz,qw]}=placement;
  const dx=position[0]-anchor[0],dy=position[1]-anchor[1],dz=position[2]-anchor[2];
  if(placement.linear)return [...placement.linear,dx,dy,dz] as const;
  const a=(1-2*(qy*qy+qz*qz))*xy,b=2*(qx*qy-qz*qw)*xy,c=2*(qx*qz+qy*qw)*zScale;
  const d=2*(qx*qy+qz*qw)*xy,e=(1-2*(qx*qx+qz*qz))*xy,f=2*(qy*qz-qx*qw)*zScale;
  const g=2*(qx*qz-qy*qw)*xy,h=2*(qy*qz+qx*qw)*xy,k=(1-2*(qx*qx+qy*qy))*zScale;
  return [a,b,c,d,e,f,g,h,k,dx,dy,dz] as const;
}

export function composePlacement(parent:Placement,child:Placement):Placement{
  const [a,b,c,d,e,f,g,h,k,dx,dy,dz]=placementMatrix(parent,[0,0,0]);
  const [x,y,z]=child.position;
  const [px,py,pz,pw]=parent.rotation,[cx,cy,cz,cw]=child.rotation;
  const placement:Placement={...child,position:[a*x+b*y+c*z+dx,d*x+e*y+f*z+dy,g*x+h*y+k*z+dz],rotation:[
    pw*cx+px*cw+py*cz-pz*cy,pw*cy-px*cz+py*cw+pz*cx,
    pw*cz+px*cy-py*cx+pz*cw,pw*cw-px*cx-py*cy-pz*cz,
  ],scale:[parent.scale[0]*child.scale[0],parent.scale[1]*child.scale[1]]};
  if(parent.linear||child.linear||parent.scale[0]!==parent.scale[1]&&(cx!==0||cy!==0)){
    const [j,l,m,n,o,p,q,r,s]=placementMatrix(child,child.position);
    placement.linear=[a*j+b*n+c*q,a*l+b*o+c*r,a*m+b*p+c*s,
      d*j+e*n+f*q,d*l+e*o+f*r,d*m+e*p+f*s,
      g*j+h*n+k*q,g*l+h*o+k*r,g*m+h*p+k*s];
  }
  return placement;
}

export function placementNormalMatrix(placement:Placement):LinearTransform{
  if(placement.linear){
    const [a,b,c,d,e,f,g,h,k]=placement.linear;
    // All authored scales are positive. The cofactor matrix has the same
    // directions as the inverse transpose after normals are normalized.
    return [e*k-f*h,f*g-d*k,d*h-e*g,c*h-b*k,a*k-c*g,b*g-a*h,b*f-c*e,c*d-a*f,a*e-b*d];
  }
  const [xy,z]=placement.scale;
  const [a,b,c,d,e,f,g,h,k]=placementMatrix({...placement,scale:[1/xy,1/z]},placement.position);
  return [a,b,c,d,e,f,g,h,k];
}

export function readPlacement(data: DataView, at: number, hash: number): Placement {
  if (data.getUint32(at,true)!==hash) throw new Error("Street instance hash mismatch.");
  const f = (offset: number) => data.getFloat32(at+offset,true);
  const position: Placement["position"] = [f(-12),f(-8),f(-4)];
  // CEntityDef stores the inverse world quaternion.
  const rotation: Placement["rotation"] = [-f(-52),-f(-48),-f(-44),f(-40)];
  const scale: Placement["scale"] = [f(16),f(20)];
  if (!position.every(Number.isFinite) || !rotation.every(Number.isFinite) || Math.abs(Math.hypot(...rotation)-1)>1e-4 ||
      !scale.every(value=>Number.isFinite(value)&&value>0))
    throw new Error("Invalid street instance transform.");
  return {position,rotation,scale};
}

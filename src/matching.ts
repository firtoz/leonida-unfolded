import { sample, type Image } from "./texture";
import type { SketchPoint } from "./protocol";

export const GRID=20;
const EDGE=16;
const coords=(side:number,i:number,depth:number,im:Image) => {
  const x=Math.min(im.width-1,Math.floor((i+.5)*im.width/EDGE));
  const y=Math.min(im.height-1,Math.floor((i+.5)*im.height/EDGE));
  if(side===0)return (depth*im.width+x)*4;
  if(side===1)return (y*im.width+im.width-1-depth)*4;
  if(side===2)return ((im.height-1-depth)*im.width+x)*4;
  return (y*im.width+depth)*4;
};
export function describe(image:Image) {
  const pixels=new Uint8Array(GRID*GRID*3),edges=new Uint8Array(4*EDGE*3);
  const shade=new Float32Array(GRID*GRID),gradient=new Uint8Array(GRID*GRID);
  for(let y=0;y<GRID;y++) for(let x=0;x<GRID;x++) {
    const rgb=sample(image,x,y,GRID),i=y*GRID+x;
    pixels.set(rgb,i*3);shade[i]=.30*rgb[0]+.59*rgb[1]+.11*rgb[2];
  }
  for(let y=1;y<GRID-1;y++) for(let x=1;x<GRID-1;x++) {
    const i=y*GRID+x;
    gradient[i]=Math.min(255,Math.hypot(shade[i+1]-shade[i-1],shade[i+GRID]-shade[i-GRID]));
  }
  for(let side=0;side<4;side++) for(let i=0;i<EDGE;i++) for(let color=0;color<3;color++) {
    let value=0;
    for(let d=0;d<3;d++) value+=image.rgba[coords(side,i,d,image)+color];
    edges[(side*EDGE+i)*3+color]=value/3;
  }
  return {pixels,edges,gradient};
}

export type Features=ReturnType<typeof describe>;
export function score(candidate:Features, neighbors:{direction:number;features:Features}[], points:SketchPoint[]) {
  let edges=0,sketch=0;
  for(const {direction,features} of neighbors) {
    const a=direction*EDGE*3,b=((direction+2)%4)*EDGE*3;
    for(let i=0;i<EDGE*3;i++) {
      const delta=candidate.edges[a+i]-features.edges[b+i];
      edges+=delta*delta;
      if(i>=3) edges+=.45*(delta-candidate.edges[a+i-3]+features.edges[b+i-3])**2;
    }
  }
  for(const {x,y,color} of points) {
    const gx=Math.round(x*(GRID-1)),gy=Math.round(y*(GRID-1));
    let best=Infinity;
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
      const px=gx+dx,py=gy+dy;
      if(px<0||px>=GRID||py<0||py>=GRID) continue;
      const i=py*GRID+px;
      const cost=color?Math.sqrt(color.reduce((s,v,c)=>s+(candidate.pixels[i*3+c]-v)**2,0)/3):
        60-Math.min(60,candidate.gradient[i]*1.25);
      best=Math.min(best,cost+3*(Math.abs(dx)+Math.abs(dy)));
    }
    sketch+=best;
  }
  return (neighbors.length?Math.sqrt(edges/(neighbors.length*EDGE*3)):0) +
    (points.length?sketch/points.length*(neighbors.length?.8:1):0);
}

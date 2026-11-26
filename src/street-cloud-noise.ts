export const streetCloudNoiseSide=48;

// Periodic inverted cellular noise and distance to the second-nearest point.
// Compute it once in the worker so the cached sky can filter the cloud volumes
// at several scales without repeating the neighborhood search for every ray.
export function streetCloudNoise(){
  const size=streetCloudNoiseSide,cells=6,cellWidth=size/cells;
  const grid=new Float32Array(cells**3*3);
  let seed=0x82673c45;
  for(let i=0;i<grid.length;i++){
    seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;
    grid[i]=.19+.62*(seed>>>0)/4294967296;
  }
  const wrapped=Array.from({length:cells+2},(_,i)=>(i+cells-1)%cells);
  const volume=new Uint8Array(size**3*2);
  const smooth=(value:number)=>value*value*(3-2*value);
  for(let z=0;z<size;z++)for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const px=(x+.5)/cellWidth,py=(y+.5)/cellWidth,pz=(z+.5)/cellWidth;
    const gx=Math.floor(px),gy=Math.floor(py),gz=Math.floor(pz);
    let first=Infinity,second=Infinity;
    for(let dz=-1;dz<=1;dz++)for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const at=((wrapped[gz+dz+1]*cells+wrapped[gy+dy+1])*cells+wrapped[gx+dx+1])*3;
      const rx=gx+dx+grid[at]-px,ry=gy+dy+grid[at+1]-py,rz=gz+dz+grid[at+2]-pz;
      const d=rx*rx+ry*ry+rz*rz;
      if(d<first){second=first;first=d;}
      else if(d<second)second=d;
    }
    const at=((z*size+y)*size+x)*2;
    const near=Math.sqrt(first),gap=Math.sqrt(second)-near;
    volume[at]=Math.round(255*(1-smooth(Math.min(1,near*.87))));
    volume[at+1]=Math.round(255*smooth(Math.min(1,gap*1.55)));
  }
  return volume;
}

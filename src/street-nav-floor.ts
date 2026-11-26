import type { StreetNavCatalog } from "./street-nav-catalog";
import type { DetailCell } from "./street-grid";
import type { StreetChunk } from "./street-mesh";
import { decodeNavigationCell } from "./street-navigation";
import { maximumWalkSlope } from "./walk-surface";

const binSize=2;
const supportRadius=8;
const binsPerSide=128/binSize;
const supportKey=(x:number,y:number)=>Math.floor(y/binSize)*binsPerSide+Math.floor(x/binSize);

const floorStep=.5, floorSide=128/floorStep;
const floorMaterial=73;
const gapDirections=[[1,0,20],[0,1,20],[1,1,14],[1,-1,14]] as const;

// Navigation cuts around obstacles even where the underlying floor is flat.
// Span enclosed, level gaps using only the original polygons as support.
export function bridgeNavigationGaps(vertices:Float32Array,faces:number[]){
  const heights=new Float32Array(floorSide**2).fill(Infinity);
  const key=(x:number,y:number)=>y*floorSide+x;
  let minX=floorSide,maxX=0,minY=floorSide,maxY=0;
  for(let i=0;i<faces.length;i+=3){
    const a=faces[i]*4,b=faces[i+1]*4,c=faces[i+2]*4;
    const ax=vertices[a],ay=vertices[a+1],bx=vertices[b],by=vertices[b+1],cx=vertices[c],cy=vertices[c+1];
    const ux=bx-ax,uy=by-ay,vx=cx-ax,vy=cy-ay,area=ux*vy-uy*vx;
    const left=Math.max(0,Math.floor(Math.min(ax,bx,cx)/floorStep));
    const right=Math.min(floorSide-1,Math.floor(Math.max(ax,bx,cx)/floorStep));
    const bottom=Math.max(0,Math.floor(Math.min(ay,by,cy)/floorStep));
    const top=Math.min(floorSide-1,Math.floor(Math.max(ay,by,cy)/floorStep));
    for(let y=bottom;y<=top;y++)for(let x=left;x<=right;x++){
      const dx=(x+.5)*floorStep-ax,dy=(y+.5)*floorStep-ay;
      const u=(dx*vy-dy*vx)/area,v=(ux*dy-uy*dx)/area;
      if(u<0||v<0||u+v>1)continue;
      const height=vertices[a+2]*(1-u-v)+vertices[b+2]*u+vertices[c+2]*v;
      const k=key(x,y);
      heights[k]=Math.min(heights[k],height);
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);
      minY=Math.min(minY,y);maxY=Math.max(maxY,y);
    }
  }
  const bridge:number[]=[];
  const findSupport=(x:number,y:number,dx:number,dy:number,limit:number)=>{
    for(let step=1;step<=limit;step++){
      x+=dx;y+=dy;
      if(x<0||x>=floorSide||y<0||y>=floorSide)break;
      const height=heights[key(x,y)];
      if(Number.isFinite(height))return {step,height};
    }
  };
  for(let y=minY+1;y<maxY;y++)for(let x=minX+1;x<maxX;x++){
    if(Number.isFinite(heights[key(x,y)]))continue;
    let height=0,support=0;
    for(const [dx,dy,limit] of gapDirections){
      const before=findSupport(x,y,-dx,-dy,limit-1);
      if(!before)continue;
      const after=findSupport(x,y,dx,dy,limit-before.step);
      if(!after||Math.abs(before.height-after.height)>.25)continue;
      const interpolated=(before.height*after.step+after.height*before.step)/(before.step+after.step);
      if(support&&Math.abs(height/support-interpolated)>.25){support=0;break;}
      height+=interpolated;
      support++;
    }
    if(support<2)continue;
    // An occupied sample only guarantees coverage at the cell center.
    // Overlap to that center to avoid cracks along diagonal polygon edges.
    const z=height/support,left=(x-.5)*floorStep,bottom=(y-.5)*floorStep;
    const right=left+2*floorStep,top=bottom+2*floorStep;
    const base=(vertices.length+bridge.length)/4;
    bridge.push(left,bottom,z,floorMaterial,right,bottom,z,floorMaterial,right,top,z,floorMaterial,left,top,z,floorMaterial);
    faces.push(base,base+1,base+2,base,base+2,base+3);
  }
  const expanded=new Float32Array(vertices.length+bridge.length);
  expanded.set(vertices);
  expanded.set(bridge,vertices.length);
  return expanded;
}

export class StreetNavFloor {
  private readonly cells=new Map<string,Float32Array>();

  remember(mesh:StreetChunk){
    const bins=new Float32Array(binsPerSide**2).fill(Infinity),{vertices}=mesh;
    for(let i=0;i<vertices.length;i+=4){
      const [x,y,z]=[vertices[i],vertices[i+1],vertices[i+2]];
      if(x<0||y<0||x>=128||y>=128)continue;
      const key=supportKey(x,y);
      bins[key]=Math.min(z+mesh.origin[2],bins[key]);
    }
    this.cells.delete(mesh.id);
    this.cells.set(mesh.id,bins);
    if(this.cells.size>32)this.cells.delete(this.cells.keys().next().value!);
  }

  private supported(x:number,y:number,z:number){
    for(let dy=-supportRadius;dy<=supportRadius;dy+=binSize)
      for(let dx=-supportRadius;dx<=supportRadius;dx+=binSize){
        if(dx*dx+dy*dy>supportRadius**2)continue;
        const col=Math.floor((x+dx)/128),row=Math.floor((y+dy)/128);
        const h=this.cells.get(`${col},${row}`)?.[supportKey(x+dx-col*128,y+dy-row*128)];
        if(h!==undefined&&Math.abs(h-z)<.75)return true;
      }
    return false;
  }

  async load(catalog:StreetNavCatalog,point:readonly [number,number],known:readonly string[],active:()=>boolean){
    const [cx,cy]=point.map(value=>Math.floor(value/128)),cells:DetailCell[]=[];
    for(let y=cy-1;y<=cy+1;y++)for(let x=cx-1;x<=cx+1;x++)
      if(this.cells.has(`${x},${y}`))cells.push([x,y]);
    const wanted:string[]=[],meshes:StreetChunk[]=[];
    const resident=new Set(known);
    // Read only nearby navigation cells, after the gameplay terrain has arrived.
    for(const [x,y] of cells){
      if(!active())break;
      const id=`nav-floor:${x},${y}`;
      if(resident.has(id)){wanted.push(id);continue;}
      const source=await catalog.read(x,y).then(bytes=>bytes?decodeNavigationCell(bytes,x,y,true):null).catch(()=>null);
      if(!source||!active())continue;
      const {origin,vertices,indices}=source,faces:number[]=[];
      for(let i=0;i<indices.length;i+=3){
        const a=indices[i]*4,b=indices[i+1]*4,c=indices[i+2]*4;
        const ux=vertices[b]-vertices[a],uy=vertices[b+1]-vertices[a+1],uz=vertices[b+2]-vertices[a+2];
        const vx=vertices[c]-vertices[a],vy=vertices[c+1]-vertices[a+1],vz=vertices[c+2]-vertices[a+2];
        const area=ux*vy-uy*vx;
        if(Math.abs(area)<.001||Math.hypot(uy*vz-uz*vy,uz*vx-ux*vz)>maximumWalkSlope*Math.abs(area))continue;
        const corners=[a,b,c];
        const near=(axis:number)=>origin[axis]+corners.reduce((sum,j)=>sum+vertices[j+axis],0)/3;
        if(!this.supported(near(0),near(1),near(2)))continue;
        faces.push(indices[i],indices[i+1],indices[i+2]);
      }
      if(!faces.length)continue;
      for(let i=3;i<vertices.length;i+=4)vertices[i]=floorMaterial;
      const floor=bridgeNavigationGaps(vertices,faces);
      meshes.push({...source,id,kind:"terrain",vertices:floor,indices:Uint32Array.from(faces),visualOnly:true,
        appearance:{uv:new Float32Array(floor.length/2),spans:[{first:0,count:faces.length,texture:null,
          overlay:true,groundBlend:true}]}});
      wanted.push(id);
    }
    return {wanted,meshes};
  }
}

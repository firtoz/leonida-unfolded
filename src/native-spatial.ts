import { CELL } from "./recover";

export type Bounds = [number,number,number,number,number,number];
export type NativeBatch = { first:number; count:number; bounds:Bounds };
export type NativeTile = NativeBatch & { chunks:NativeBatch[] };
export type NativePart = {
  name:string;
  vertices:Float32Array<ArrayBuffer>;
  indices:Uint32Array<ArrayBuffer>;
  spans:{first:number;count:number}[];
  bounds:Bounds;
};

export function emptyBounds():Bounds{return [Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];}

export function extendBounds(bounds:Bounds,other:Bounds){
  for(let axis=0;axis<3;axis++){
    bounds[axis]=Math.min(bounds[axis],other[axis]);
    bounds[axis+3]=Math.max(bounds[axis+3],other[axis+3]);
  }
}

export function rangeBounds(part:NativePart,first:number,count:number):Bounds{
  const bounds=emptyBounds();
  for(let i=first;i<first+count;i++){
    const offset=part.indices[i]*4;
    for(let axis=0;axis<3;axis++){
      const value=part.vertices[offset+axis];
      bounds[axis]=Math.min(bounds[axis],value);
      bounds[axis+3]=Math.max(bounds[axis+3],value);
    }
  }
  return bounds;
}

type Surface = {height:number;eastSlope:number;southSlope:number};
function supportAt(parts:NativePart[],x:number,y:number,authored:number){
  let support:Surface|null=null;
  for(const part of parts){
    const [left,top,,right,bottom]=part.bounds;
    if(x<left||x>right||y<top||y>bottom)continue;
    const {vertices,indices}=part;
    const ceiling=part.name==="buildings_std"?authored+2/CELL:Infinity;
    for(let i=0;i<indices.length;i+=3){
      const a=indices[i]*4,b=indices[i+1]*4,c=indices[i+2]*4;
      const ax=vertices[a],ay=vertices[a+1],az=vertices[a+2];
      const bx=vertices[b],by=vertices[b+1],cx=vertices[c],cy=vertices[c+1];
      if(x<Math.min(ax,bx,cx)||x>Math.max(ax,bx,cx)||y<Math.min(ay,by,cy)||y>Math.max(ay,by,cy))continue;
      const ux=bx-ax,uy=by-ay,uz=vertices[b+2]-az;
      const vx=cx-ax,vy=cy-ay,vz=vertices[c+2]-az;
      const det=ux*vy-uy*vx;
      if(Math.abs(det)<1e-9)continue;
      const u=((x-ax)*vy-(y-ay)*vx)/det,v=(ux*(y-ay)-uy*(x-ax))/det;
      if(u<-.0001||v<-.0001||u+v>1.0001)continue;
      const height=az+u*uz+v*vz;
      if(height>ceiling||height<=(support?.height??-Infinity))continue;
      const eastSlope=(uz*vy-vz*uy)/det,southSlope=(ux*vz-vx*uz)/det;
      // Reject near-vertical faces as a surface on which a helipad could sit.
      if(Math.hypot(eastSlope,southSlope)>1)continue;
      support={height,eastSlope,southSlope};
    }
  }
  return support;
}

export function groundHelipads(parts:NativePart[]){
  const land=parts.filter(part=>part.name==="buildings_std"||part.name.startsWith("terrain_"));
  const water=parts.filter(part=>part.name.startsWith("water_"));
  const levels=new Map<number,{part:NativePart;offset:number;x:number;y:number}[]>();
  const pads=parts.filter(part=>part.name==="helipads_std");
  for(const part of pads){
    const {vertices}=part;
    for(let i=0;i<vertices.length;i+=4){
      const level=Math.round(vertices[i+2]*CELL*100);
      const vertex={part,offset:i,x:vertices[i],y:vertices[i+1]};
      const group=levels.get(level);
      if(group)group.push(vertex);else levels.set(level,[vertex]);
    }
  }
  for(const [level,vertices] of levels){
    const remaining=new Set(vertices);
    while(remaining.size){
      const start=remaining.values().next().value!;
      remaining.delete(start);
      const emblem=[start];
      // The ring and letter are disconnected in index space. Join nearby pieces
      // on the same authored plane, including emblems split across tile boundaries.
      for(let i=0;i<emblem.length;i++){
        const current=emblem[i];
        for(const other of remaining){
          if(Math.hypot(current.x-other.x,current.y-other.y)>8/CELL)continue;
          emblem.push(other);remaining.delete(other);
        }
      }
      const x=emblem.reduce((sum,p)=>sum+p.x,0)/emblem.length;
      const y=emblem.reduce((sum,p)=>sum+p.y,0)/emblem.length;
      const authored=level/(CELL*100);
      const support=supportAt(land,x,y,authored)??supportAt(water,x,y,authored);
      for(const point of emblem){
        const base=support
          ? support.height+(point.x-x)*support.eastSlope+(point.y-y)*support.southSlope
          : 0;
        point.part.vertices[point.offset+2]=base+.2/CELL;
      }
    }
  }
  for(const pad of pads)pad.bounds=rangeBounds(pad,0,pad.indices.length);
}

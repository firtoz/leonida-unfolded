import { readOverviewElevation } from "./layers";
import { CELL, loadWorld, type Rect } from "./recover";
import type { Archive } from "./archive";
import type { StreetChunk } from "./street-mesh";
import { oceanRadius, overviewTerrainRadius, overviewTerrainTileSize as terrainTile } from "./street-grid";

const seaLevel=27988,elevationScale=.010733639;
const minimumDepth=.15;

export async function loadStreetOcean(common:Archive,textures:Archive){
  const [world,{elevation,width,height}]=await Promise.all([
    loadWorld(common),readOverviewElevation(textures),
  ]);
  return streetOceanFromElevation(world,elevation,width,height);
}

export function streetOceanFromElevation([left,top,columns,rows]:Rect,elevation:Uint16Array,width:number,height:number){
  const connected=new Uint8Array(elevation.length),queue=new Uint32Array(elevation.length);
  let read=0,write=0;
  function mark(i:number){
    if(connected[i]||elevation[i]>=seaLevel-minimumDepth/elevationScale)return;
    connected[i]=1;queue[write++]=i;
  }
  for(let x=0;x<width;x++){mark(x);mark((height-1)*width+x);}
  for(let y=1;y<height-1;y++){mark(y*width);mark(y*width+width-1);}
  while(read<write){
    const i=queue[read++],x=i%width;
    if(x>0)mark(i-1);
    if(x<width-1)mark(i+1);
    if(i>=width)mark(i-width);
    if(i+width<elevation.length)mark(i+width);
  }
  const xStep=columns*CELL/width,yStep=rows*CELL/height;
  const worldLeft=left*CELL+xStep/2,worldTop=-top*CELL-yStep/2;
  const depth=(i:number)=>connected[i]?(seaLevel-elevation[i])*elevationScale-minimumDepth:
    Math.min(-minimumDepth,(seaLevel-elevation[i])*elevationScale-minimumDepth);
  const emptyTerrain=new Set<string>(),emptyOcean=new Set<string>();
  function tileExtent(col:number,row:number){
    const origin:StreetChunk["origin"]=[col*terrainTile,row*terrainTile,0];
    const x0=Math.max(0,Math.ceil((origin[0]-worldLeft)/xStep));
    const x1=Math.min(width-1,Math.ceil((origin[0]+terrainTile-worldLeft)/xStep));
    const y0=Math.max(0,Math.ceil((worldTop-origin[1]-terrainTile)/yStep));
    const y1=Math.min(height-1,Math.ceil((worldTop-origin[1])/yStep));
    return {origin,x0,x1,y0,y1};
  }
  function terrainMesh(col:number,row:number,id:string):StreetChunk|undefined{
    const {origin,x0,x1,y0,y1}=tileExtent(col,row);
    const stride=x1-x0+1;
    if(stride<2||y1<=y0)return;
    const vertices:number[]=[],indices:number[]=[],normals:number[]=[];
    const bounds:StreetChunk["bounds"]=[worldLeft+x0*xStep-origin[0],worldTop-y1*yStep-origin[1],Infinity,
      worldLeft+x1*xStep-origin[0],worldTop-y0*yStep-origin[1],-Infinity];
    const distance=new Float32Array(stride*(y1-y0+1));
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
      const sample=y*width+x,z=(elevation[sample]-seaLevel)*elevationScale;
      distance[(y-y0)*stride+x-x0]=depth(sample);
      vertices.push(worldLeft+x*xStep-origin[0],worldTop-y*yStep-origin[1],z,74);
      // Sample both sides in the source raster so neighbouring tiles agree
      // on slope even along a clipped tile edge.
      const west=Math.max(0,x-1),east=Math.min(width-1,x+1);
      const north=Math.max(0,y-1),south=Math.min(height-1,y+1);
      const dx=(elevation[y*width+east]-elevation[y*width+west])*elevationScale/((east-west)*xStep);
      const dy=(elevation[north*width+x]-elevation[south*width+x])*elevationScale/((south-north)*yStep);
      const scale=32767/Math.sqrt(1+dx*dx+dy*dy);
      normals.push(Math.round(-dx*scale),Math.round(-dy*scale),Math.round(scale));
      bounds[2]=Math.min(bounds[2],z);bounds[5]=Math.max(bounds[5],z);
    }
    function triangle(a:number,b:number,c:number){
      if(distance[a]<=0&&distance[b]<=0&&distance[c]<=0){indices.push(a,b,c);return;}
      if(distance[a]>0&&distance[b]>0&&distance[c]>0)return;
      const ring:number[]=[];
      let previous=c;
      for(const i of [a,b,c]){
        if((distance[previous]>0)!==(distance[i]>0)){
          const t=distance[previous]/(distance[previous]-distance[i]);
          ring.push(vertices.length/4);
          const p=previous*4,q=i*4;
          vertices.push(vertices[p]+t*(vertices[q]-vertices[p]),vertices[p+1]+t*(vertices[q+1]-vertices[p+1]),
            vertices[p+2]+t*(vertices[q+2]-vertices[p+2]),74);
          for(let axis=0;axis<3;axis++){
            const from=normals[previous*3+axis],to=normals[i*3+axis];
            normals.push(Math.round(from+t*(to-from)));
          }
        }
        if(distance[i]<=0)ring.push(i);
        previous=i;
      }
      for(let i=1;i+1<ring.length;i++)indices.push(ring[0],ring[i],ring[i+1]);
    }
    for(let y=0;y<y1-y0;y++)for(let x=0;x<x1-x0;x++){
      const a=y*stride+x,b=a+1,c=a+stride;
      triangle(a,c,b);triangle(b,c,c+1);
    }
    if(indices.length)return {id,kind:"terrain",overview:true,visualOnly:true,origin,bounds,
      vertices:Float32Array.from(vertices),indices:Uint32Array.from(indices),normals:Int16Array.from(normals)};
  }
  function oceanMesh(col:number,row:number,id:string,dense=false):StreetChunk|undefined{
    const {origin,x0,x1,y0,y1}=tileExtent(col,row);
    if(x1<=x0||y1<=y0)return;
    let wet=false,deep=true;
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
      const sample=y*width+x;
      if(connected[sample])wet=true;
      if(depth(sample)<22)deep=false;
    }
    if(!wet)return;
    const vertices:number[]=[],indices:number[]=[],uv:number[]=[];
    const bounds:StreetChunk["bounds"]=[Infinity,Infinity,0,-Infinity,-Infinity,0];
    const stride=x1-x0+1;
    const shared=deep&&!dense?undefined:new Int32Array(stride*(y1-y0+1)).fill(-1);
    function vertex(px:number,py:number,z:number){
      const index=vertices.length/4;
      vertices.push(px,py,0,71);uv.push(z,0);
      bounds[0]=Math.min(bounds[0],px);bounds[1]=Math.min(bounds[1],py);
      bounds[3]=Math.max(bounds[3],px);bounds[4]=Math.max(bounds[4],py);
      return index;
    }
    function gridVertex(i:number,z:number){
      const x=i%width,y=Math.floor(i/width),at=(y-y0)*stride+x-x0;
      if(!shared)return vertex(worldLeft+x*xStep-origin[0],worldTop-y*yStep-origin[1],z);
      if(shared[at]===-1)shared[at]=vertex(worldLeft+x*xStep-origin[0],worldTop-y*yStep-origin[1],z);
      return shared[at];
    }
    function clip(a:number,b:number,c:number){
      const boundary:number[]=[];
      let previous=c;
      let previousDepth=depth(c);
      for(const point of [a,b,c]){
        const currentDepth=depth(point);
        if((previousDepth>0)!==(currentDepth>0)){
          const t=previousDepth/(previousDepth-currentDepth);
          const x=previous%width+(point%width-previous%width)*t;
          const y=Math.floor(previous/width)+(Math.floor(point/width)-Math.floor(previous/width))*t;
          boundary.push(vertex(worldLeft+x*xStep-origin[0],worldTop-y*yStep-origin[1],0));
        }
        if(currentDepth>0)boundary.push(gridVertex(point,currentDepth));
        previous=point;previousDepth=currentDepth;
      }
      for(let k=1;k<boundary.length-1;k++)indices.push(boundary[0],boundary[k],boundary[k+1]);
    }
    if(deep&&!dense){
      const nw=gridVertex(y0*width+x0,22),ne=gridVertex(y0*width+x1,22);
      const sw=gridVertex(y1*width+x0,22),se=gridVertex(y1*width+x1,22);
      indices.push(nw,sw,ne,ne,sw,se);
    }
    else for(let j=y0;j<y1;j++)for(let i=x0;i<x1;i++){
      const a=j*width+i,b=a+1,d=a+width,c=d+1;
      if(!connected[a]&&!connected[b]&&!connected[c]&&!connected[d])continue;
      if(connected[a]&&connected[b]&&connected[c]&&connected[d]){
        const nw=gridVertex(a,depth(a)),ne=gridVertex(b,depth(b));
        const sw=gridVertex(d,depth(d)),se=gridVertex(c,depth(c));
        indices.push(nw,sw,ne,ne,sw,se);
      }else{
        clip(a,d,b);clip(b,d,c);
      }
    }
    if(!indices.length)return;
    return {id,origin,bounds,kind:"water",vertices:new Float32Array(vertices),indices:new Uint32Array(indices),
      appearance:{uv:new Float32Array(uv),spans:[{first:0,count:indices.length,texture:null}]}};
  }
  function tiles([x,y]:readonly [number,number],radius:number,known:Set<string>,prefix:string,
    empty:Set<string>,meshAt:(col:number,row:number,id:string,dense?:boolean)=>StreetChunk|undefined){
    const wanted:string[]=[],meshes:StreetChunk[]=[];
    const left=Math.floor((x-radius)/terrainTile),right=Math.floor((x+radius)/terrainTile);
    const bottom=Math.floor((y-radius)/terrainTile),top=Math.floor((y+radius)/terrainTile);
    for(let row=bottom;row<=top;row++)for(let col=left;col<=right;col++){
      const dense=prefix==="ocean"&&Math.abs(col-Math.floor(x/terrainTile))<=1&&Math.abs(row-Math.floor(y/terrainTile))<=1;
      const id=`${prefix}:${dense?"wave:":""}${col},${row}`;
      if(empty.has(id))continue;
      const mesh=known.has(id)?undefined:meshAt(col,row,id,dense);
      if(mesh)meshes.push(mesh);
      if(mesh||known.has(id))wanted.push(id);
      else empty.add(id);
    }
    return {wanted,meshes};
  }
  function seabedMesh(col:number,row:number,id:string):StreetChunk|undefined{
    const water=oceanMesh(col,row,id);
    if(!water?.appearance)return;
    const {vertices,indices,appearance}=water;
    let lowest=0,highest=-Infinity;
    for(let i=0;i<vertices.length;i+=4){
      const z=-appearance.uv[i/2]-minimumDepth;
      vertices[i+2]=z;
      vertices[i+3]=76;
      lowest=Math.min(lowest,z);
      highest=Math.max(highest,z);
    }
    if(highest<=-22)return;
    const {origin,bounds:[left,bottom,,right,top]}=water;
    return {id,origin,bounds:[left,bottom,lowest,right,top,highest],kind:"terrain",overview:true,visualOnly:true,vertices,indices};
  }
  return {
    terrain:(point:readonly [number,number],known:Set<string>)=>tiles(point,overviewTerrainRadius,known,"overview",emptyTerrain,terrainMesh),
    water:(point:readonly [number,number],known:Set<string>)=>tiles(point,oceanRadius,known,"ocean",emptyOcean,oceanMesh),
    seabed:(point:readonly [number,number],known:Set<string>)=>tiles(point,768,known,"seabed",emptyTerrain,seabedMesh),
  };
}

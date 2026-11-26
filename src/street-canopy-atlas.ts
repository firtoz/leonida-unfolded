import type { StreetChunk } from "./street-mesh";
import type { StreetTextureImage } from "./street-terrain-material";
import type { ImposterAtlasRecord } from "./street-imposter-metadata";

export const canopyAtlasPrefix="canopy-atlas:";
export const nativeCanopyAtlasPrefix=canopyAtlasPrefix+"octa-v5:";
export const nativeCanopyMaterial=80;

export function nativeCanopyModel({center,radius,axis}:ImposterAtlasRecord,key:string):StreetChunk|undefined{
  if(!(radius>.01&&Number.isFinite(radius)&&center.every(Number.isFinite)))return;
  const [x,y,z]=center,extent=radius*Math.SQRT2;
  // The vertex shader expands the repeated center using the projection radius
  // and corner index. Bounds cover the quad at any orientation.
  const vertices=new Float32Array([
    x,y,z,nativeCanopyMaterial,x,y,z,nativeCanopyMaterial,
    x,y,z,nativeCanopyMaterial,x,y,z,nativeCanopyMaterial,
  ]);
  return {id:key,kind:"foliage",origin:[0,0,0],visualOnly:true,
    bounds:[x-extent,y-extent,z-extent,x+extent,y+extent,z+extent],
    vertices,indices:new Uint16Array([0,1,2,0,2,3]),
    appearance:{uv:new Float32Array([radius,axis,radius,axis,radius,axis,radius,axis]),
      spans:[{first:0,count:6,texture:nativeCanopyAtlasPrefix+key,cutout:true}]}};
}

export function reconstructNativeCanopy(base:StreetTextureImage,chroma:StreetTextureImage,
  normal?:StreetTextureImage|null):StreetTextureImage|undefined{
  const {width,height}=base;
  if(!width||!height||!chroma.width||!chroma.height||
    width%8||height%8||chroma.width%8||chroma.height%8||
    base.rgba.length!==width*height*4||chroma.rgba.length!==chroma.width*chroma.height*4)return;
  const rgba=new Uint8ClampedArray(width*height*8);
  const normals=normal&&normal.width>0&&normal.height>0&&normal.width%8===0&&normal.height%8===0&&
    normal.rgba.length===normal.width*normal.height*4?normal:undefined;
  // The atlas contains 8×8 views. Reuse column taps for every row and
  // clamp interpolation to the current view tile.
  const tileWidth=chroma.width/8,tileHeight=chroma.height/8;
  const left=new Uint32Array(width),right=new Uint32Array(width),horizontal=new Float64Array(width);
  const normalColumn=normals&&new Uint32Array(width);
  for(let x=0;x<width;x++){
    const tileX=Math.floor(8*x/width)*tileWidth;
    const px=Math.max(tileX,Math.min(tileX+tileWidth-1,(x+.5)*chroma.width/width-.5));
    const x0=Math.floor(px);
    left[x]=x0*4;
    right[x]=Math.min(x0+1,tileX+tileWidth-1)*4;
    horizontal[x]=px-x0;
    if(normalColumn&&normals)normalColumn[x]=Math.floor((x+.5)*normals.width/width)*4;
  }
  const chromaBytes=chroma.rgba,normalBytes=normals?.rgba,baseBytes=base.rgba;
  for(let y=0;y<height;y++){
    const tileY=Math.floor(8*y/height)*tileHeight;
    const py=Math.max(tileY,Math.min(tileY+tileHeight-1,(y+.5)*chroma.height/height-.5));
    const y0=Math.floor(py),y1=Math.min(y0+1,tileY+tileHeight-1),fy=py-y0;
    const topRow=y0*chroma.width*4,bottomRow=y1*chroma.width*4;
    const normalRow=normals?Math.floor((y+.5)*normals.height/height)*normals.width*4:0;
    const row=y*width*4,depthRow=2*row+width*4;
    for(let x=0;x<width;x++){
      const xByte=x*4,at=row+xByte,coverage=baseBytes[at+1],out=2*row+xByte,depth=depthRow+xByte;
      // The right half stores authored depth, coverage and weighted normals.
      rgba[depth]=baseBytes[at];
      rgba[depth+1]=coverage;
      if(!coverage)continue;
      if(normalBytes&&normalColumn){
        const tap=normalRow+normalColumn[x];
        const nx=normalBytes[tap]*2-255,ny=normalBytes[tap+1]*2-255,nz=normalBytes[tap+2]*2-255;
        const length=Math.abs(nx)+Math.abs(ny)+Math.abs(nz);
        if(length>3){
          let u=nx/length,v=ny/length;
          if(nz<0){
            const folded=(1-Math.abs(v))*Math.sign(u);
            v=(1-Math.abs(u))*Math.sign(v);
            u=folded;
          }
          rgba[depth+2]=(128+112*u)*coverage/255;
          rgba[depth+3]=(128+112*v)*coverage/255;
        }
      }
      const fx=horizontal[x];
      const a=topRow+left[x],b=topRow+right[x],c=bottomRow+left[x],d=bottomRow+right[x];
      const cb=(chromaBytes[a]*(1-fx)+chromaBytes[b]*fx)*(1-fy)
        +(chromaBytes[c]*(1-fx)+chromaBytes[d]*fx)*fy-128;
      const cr=(chromaBytes[a+1]*(1-fx)+chromaBytes[b+1]*fx)*(1-fy)
        +(chromaBytes[c+1]*(1-fx)+chromaBytes[d+1]*fx)*fy-128;
      const luma=baseBytes[at+2],alpha=coverage/255;
      rgba[out]=Math.max(0,Math.min(255,luma+1.4*cr))*alpha;
      rgba[out+1]=Math.max(0,Math.min(255,luma-.343*cb-.711*cr))*alpha;
      rgba[out+2]=Math.max(0,Math.min(255,luma+1.765*cb))*alpha;
      rgba[out+3]=coverage;
    }
  }
  return {width:width*2,height,rgba,alphaCutout:true};
}
const cell=80,padding=2;
const projections=[[0,2,1],[1,2,0],[0,1,2]] as const;
const width=cell*projections.length,height=cell;
const area=(x:number,y:number,ax:number,ay:number,bx:number,by:number)=>(x-ax)*(by-ay)-(y-ay)*(bx-ax);

function wrap(v:number,size:number){return Math.min(size-1,Math.floor((v-Math.floor(v))*size));}

export function canopyAtlasModel(mesh:StreetChunk,key:string):StreetChunk|undefined{
  const {bounds}=mesh;
  const positions:number[]=[],uv:number[]=[],triangles:number[]=[],normals:number[]=[];
  for(const [plane,[u,v,d]] of projections.entries()){
    const wide=bounds[u+3]-bounds[u],high=bounds[v+3]-bounds[v],deep=bounds[d+3]-bounds[d];
    if(Math.min(wide,high,deep)<.02)return;
    const offset=positions.length/4;
    for(const [x,y] of [[0,0],[1,0],[1,1],[0,1]]){
      const point=[0,0,0],normal=[0,0,0];
      point[u]=bounds[u]+x*wide;
      point[v]=bounds[v]+y*high;
      point[d]=bounds[d]+deep*(plane===2?.69:.5);
      normal[d]=plane===1?-32767:32767;
      positions.push(...point,66);
      uv.push((plane*cell+padding+x*(cell-2*padding))/width,(padding+y*(height-2*padding))/height);
      normals.push(...normal);
    }
    triangles.push(offset,offset+1,offset+2,offset,offset+2,offset+3);
  }
  return {...mesh,visualOnly:true,vertices:Float32Array.from(positions),indices:Uint16Array.from(triangles),
    normals:Int16Array.from(normals),appearance:{uv:Float32Array.from(uv),
      spans:[{first:0,count:triangles.length,texture:canopyAtlasPrefix+key,cutout:true}]}};
}

export async function bakeCanopyAtlas(mesh:StreetChunk,key:string,
  read:(texture:string)=>Promise<StreetTextureImage|null>):Promise<{model:StreetChunk;texture:string;image:StreetTextureImage}|undefined>{
  const {vertices,indices,appearance,bounds}=mesh;
  if(!appearance||!appearance.spans.length)return;
  const model=canopyAtlasModel(mesh,key);
  if(!model)return;
  const names=[...new Set(appearance.spans.flatMap(span=>span.texture&&!span.overlay?[span.texture]:[]))];
  const sources=new Map(await Promise.all(names.map(async name=>[name,await read(name)] as const)));
  if(!sources.size||[...sources.values()].some(texture=>!texture))return;
  const rgba=new Uint8ClampedArray(width*height*4);
  for(const [plane,[u,v,d]] of projections.entries()){
    const wide=bounds[u+3]-bounds[u],high=bounds[v+3]-bounds[v];
    const depth=new Float32Array(cell*height).fill(-Infinity);
    const sign=plane===1?-1:1;
    const count=vertices.length/4;
    const px=new Float32Array(count),py=new Float32Array(count),pz=new Float32Array(count);
    for(let i=0;i<count;i++){
      px[i]=padding+(vertices[4*i+u]-bounds[u])*(cell-2*padding)/wide;
      py[i]=padding+(vertices[4*i+v]-bounds[v])*(height-2*padding)/high;
      pz[i]=vertices[4*i+d]*sign;
    }
    let painted=0;
    for(const span of appearance.spans){
      const image=span.texture?sources.get(span.texture):null;
      if(!image||span.overlay)continue;
      for(let i=span.first;i<span.first+span.count;i+=3){
        const a=indices[i],b=indices[i+1],c=indices[i+2];
        const [ax,bx,cx]=[px[a],px[b],px[c]], [ay,by,cy]=[py[a],py[b],py[c]];
        const surface=area(cx,cy,ax,ay,bx,by);
        if(Math.abs(surface)<.005)continue;
        const startX=Math.max(padding,Math.floor(Math.min(ax,bx,cx)));
        const stopX=Math.min(cell-padding,Math.ceil(Math.max(ax,bx,cx)));
        const startY=Math.max(padding,Math.floor(Math.min(ay,by,cy)));
        const stopY=Math.min(height-padding,Math.ceil(Math.max(ay,by,cy)));
        for(let y=startY;y<stopY;y++)for(let x=startX;x<stopX;x++){
          const w0=area(x+.5,y+.5,bx,by,cx,cy)/surface;
          const w1=area(x+.5,y+.5,cx,cy,ax,ay)/surface,w2=1-w0-w1;
          if(Math.min(w0,w1,w2)<-1e-5)continue;
          const at=y*cell+x,z=w0*pz[a]+w1*pz[b]+w2*pz[c];
          if(z<depth[at])continue;
          const source=appearance.uv;
          const tx=wrap(w0*source[a*2]+w1*source[b*2]+w2*source[c*2],image.width);
          const ty=wrap(w0*source[a*2+1]+w1*source[b*2+1]+w2*source[c*2+1],image.height);
          const sample=(ty*image.width+tx)*4;
          if(image.rgba[sample+3]<128)continue;
          if(depth[at]===-Infinity)painted++;
          depth[at]=z;
          const to=(y*width+plane*cell+x)*4;
          rgba.set(image.rgba.subarray(sample,sample+3),to);
          rgba[to+3]=255;
        }
      }
    }
    if(painted<cell*height*.035)return;
  }
  // Keep the original silhouette when the renderer filters color across
  // transparent texels. The atlas tiles are filtered independently here.
  const opaque=rgba.slice();
  for(let plane=0;plane<projections.length;plane++)for(let y=1;y<height-1;y++)for(let x=1;x<cell-1;x++){
    const at=(y*width+plane*cell+x)*4;
    if(opaque[at+3])continue;
    const neighbors=[at-4,at+4,at-width*4,at+width*4].filter(i=>opaque[i+3]);
    if(!neighbors.length)continue;
    for(let c=0;c<3;c++)rgba[at+c]=neighbors.reduce((sum,i)=>sum+opaque[i+c],0)/neighbors.length;
  }
  const texture=canopyAtlasPrefix+key;
  return {model,texture,image:{width,height,rgba,alphaCutout:true}};
}

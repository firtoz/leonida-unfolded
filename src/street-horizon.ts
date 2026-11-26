import type { StreetChunk } from "./street-mesh";

const positionCells=512,uvCells=192,normalCells=9;

// At skyline distances, vertices in the same small grid cell project to a
// handful of pixels. Keep material and normal seams while collapsing details
// which cannot be resolved at this range.
export function simplifySkyline(mesh:StreetChunk,step:number):StreetChunk{
  const {appearance,indices,normals,vertices}=mesh;
  if(indices.length<=36000||!appearance||mesh.instances||mesh.dynamic||mesh.road||mesh.terrainTangents||
    appearance.spans.some(span=>span.terrain||span.road||span.overlay||span.water))return mesh;
  const output:number[]=[],positions:number[]=[],uv:number[]=[],directions:number[]=[];
  const spans:typeof appearance.spans=[];
  const mapped=new Int32Array(vertices.length/4).fill(-1);
  for(const span of appearance.spans){
    const first=output.length,clusters=new Map<number|string,number>();
    const touched:number[]=[];
    const cluster=(index:number)=>{
      if(mapped[index]!==-1)return mapped[index];
      const p=index*4,n=index*3,t=index*2;
      const x=vertices[p],y=vertices[p+1],z=vertices[p+2];
      const u=appearance.uv[t],v=appearance.uv[t+1];
      const nx=normals?.[n]??0,ny=normals?.[n+1]??0,nz=normals?.[n+2]??0;
      const qx=Math.round(x/step),qy=Math.round(y/step),qz=Math.round(z/step);
      const qu=Math.round(u*32),qv=Math.round(v*32);
      const qnx=Math.round(nx/8192),qny=Math.round(ny/8192),qnz=Math.round(nz/8192);
      const material=vertices[p+3];
      let key:number|string;
      // The mixed-radix key stays below 2^53. Signed 16-bit normals round
      // into [-4,4]; unusual position, UV and material values use the text key.
      if((material===70||material===75)&&qx>=-256&&qx<256&&qy>=-256&&qy<256&&qz>=-256&&qz<256&&
        qu>=-64&&qu<128&&qv>=-64&&qv<128){
        const positionKey=((qx+256)*positionCells+qy+256)*positionCells+qz+256;
        const uvKey=(qu+64)*uvCells+qv+64;
        const normalKey=((qnx+4)*normalCells+qny+4)*normalCells+qnz+4;
        key=((positionKey*uvCells**2+uvKey)*normalCells**3+normalKey)*2+Number(material===75);
      }else key=[qx,qy,qz,qu,qv,qnx,qny,qnz,material].join(",");
      let id=clusters.get(key);
      if(id===undefined){
        id=positions.length/4;
        clusters.set(key,id);
        positions.push(x,y,z,material);
        uv.push(u,v);
        if(normals)directions.push(nx,ny,nz);
      }
      mapped[index]=id;
      touched.push(index);
      return id;
    };
    for(let i=span.first;i<span.first+span.count;i+=3){
      const a=cluster(indices[i]),b=cluster(indices[i+1]),c=cluster(indices[i+2]);
      if(a!==b&&b!==c&&a!==c)output.push(a,b,c);
    }
    for(const index of touched)mapped[index]=-1;
    if(first<output.length)spans.push({...span,first,count:output.length-first});
  }
  if(!output.length||output.length>indices.length*.90)return mesh;
  return {...mesh,indices:Uint32Array.from(output),vertices:Float32Array.from(positions),
    normals:normals?Int16Array.from(directions):undefined,appearance:{uv:Float32Array.from(uv),spans}};
}

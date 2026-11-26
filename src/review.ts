import { cellKey, type Placement, type Sector } from "./recover";
import { bc1, readMip, sample, type Image, type Pack, type Texture } from "./texture";

type Edges = number[][];
type CropEvidence = { correlation:number; error:number; lead:number; contrast:number };
const directions=[[0,-1],[1,0],[0,1],[-1,0]];
const bins=16;

async function pixels(id:string,side:number,packs:Map<string,Pack>,textures:Record<string,Texture>) {
  const texture=textures[id];
  const mip=await readMip(packs.get(texture.pack)!,texture,side);
  return mip&&bc1(mip.data,mip.side,mip.side);
}

function bands({rgba,width,height}:Image):Edges {
  return directions.map(([dx,dy])=>{
    const length=dx?height:width;
    const values=new Array<number>(bins*3).fill(0);
    for(let i=0;i<length;i++){
      const bin=Math.floor(i*bins/length)*3;
      for(let depth=0;depth<2;depth++){
        const x=dx===1?width-1-depth:dx===-1?depth:i;
        const y=dy===1?height-1-depth:dy===-1?depth:i;
        const at=(y*width+x)*4;
        for(let color=0;color<3;color++)values[bin+color]+=rgba[at+color];
      }
    }
    return values.map(value=>value/(2*length/bins));
  });
}

function distances(candidate:Edges,neighbors:{side:number;edges:Edges}[]) {
  return neighbors.map(({edges,side})=>{
    const opposite=edges[(side+2)%4];
    const differences=candidate[side].map((value,i)=>value-opposite[i]);
    return differences.reduce((sum,delta,i)=>sum+delta**2+
      (i>=3?.36*(delta-differences[i-3])**2:0),0)/differences.length;
  });
}

export async function reviewNeighborSeams(
  cells:Placement[],candidates:Placement[],packs:Map<string,Pack>,textures:Record<string,Texture>,
  progress:(done:number,total:number)=>void,
  review?:Map<string,CropEvidence>|"edges",
) {
  const edgeOnly=review==="edges";
  const cropChecks=edgeOnly?undefined:review;
  const fixed=new Map(cells.map(cell=>[cellKey(cell.x,cell.y),cell]));
  const jobs=candidates.flatMap(candidate=>{
    const neighbors=directions.flatMap(([dx,dy],side)=>{
      const neighbor=fixed.get(cellKey(candidate.x+dx,candidate.y+dy));
      return neighbor?[{side,neighbor}]:[];
    });
    if(!review)return neighbors.length===4?[{candidate,neighbors}]:[];
    const independent=neighbors.filter(({neighbor})=>!neighbor.recovery).length;
    if(edgeOnly)return neighbors.length>=3&&independent>=2?[{candidate,neighbors}]:[];
    const crop=cropChecks?.get(candidate.id);
    if(!crop||crop.error>20||crop.correlation<.42||neighbors.length<5-candidate.meshes.length||
       independent<2)return [];
    return [{candidate,neighbors}];
  });
  const ids=[...new Set(jobs.flatMap(job=>[job.candidate.id,...job.neighbors.map(({neighbor})=>neighbor.id)]))];
  const edges=new Map<string,Edges>();
  progress(0,ids.length);
  for(let start=0;start<ids.length;start+=24){
    const batch=ids.slice(start,start+24);
    await Promise.all(batch.map(async id=>{
      const image=await pixels(id,128,packs,textures);
      if(image)edges.set(id,bands(image));
    }));
    progress(start+batch.length,ids.length);
  }
  return jobs.flatMap(({candidate,neighbors})=>{
    const image=edges.get(candidate.id);
    const sides=neighbors.flatMap(({neighbor,side})=>{
      const neighborEdges=edges.get(neighbor.id);
      return neighborEdges?[{side,edges:neighborEdges}]:[];
    });
    if(!image||sides.length!==neighbors.length)return [];
    const costs=distances(image,sides);
    const score=Math.sqrt(costs.reduce((sum,cost)=>sum+cost,0)/sides.length);
    const limit=edgeOnly?12:cropChecks?(sides.length===2?15:18):14;
    const strongOtherEdges=sides.length===4&&costs.filter(cost=>cost<=15**2).length>=3;
    const maxEdge=edgeOnly?18:cropChecks?(strongOtherEdges?32:24):21;
    if(score>limit||Math.max(...costs)>maxEdge**2)return [];
    let runner=Infinity;
    for(const [id,alternative] of edges){
      if(id===candidate.id)continue;
      const other=distances(alternative,sides);
      runner=Math.min(runner,Math.sqrt(other.reduce((sum,cost)=>sum+cost,0)/sides.length));
    }
    if(runner-score<(edgeOnly?5:cropChecks?4:3)||score>(edgeOnly ? .75 : cropChecks ? .80 : .83)*runner)return [];
    const recovery=edgeOnly?"edges" as const:cropChecks?"seams-and-sector" as const:"seams" as const;
    return [{...candidate,recovery}];
  });
}

const grid=20;

function fingerprint(image:Image,x:number,y:number,parts:number,soften=false) {
  let rgb=new Float32Array(grid*grid*3);
  for(let j=0;j<grid;j++)for(let i=0;i<grid;i++)
    rgb.set(sample(image,x*grid+i,y*grid+j,grid*parts),(j*grid+i)*3);
  if(soften){
    const across=rgb.map((value,i)=>{
      const col=Math.floor(i/3)%grid;
      return value*.82+.09*(rgb[col>0?i-3:i]+rgb[col<grid-1?i+3:i]);
    });
    const stride=grid*3;
    rgb=across.map((value,i)=>value*.82+.09*(across[i>=stride?i-stride:i]+
      across[i<across.length-stride?i+stride:i]));
  }
  const mean=[0,0,0];
  rgb.forEach((value,i)=>mean[i%3]+=value/(grid*grid));
  const shape=rgb.map((value,i)=>value-mean[i%3]);
  const length=Math.sqrt(shape.reduce((sum,value)=>sum+value**2,0));
  return {rgb,shape:shape.map(value=>value/Math.max(length,1e-6)),contrast:length/Math.sqrt(rgb.length)};
}
const similarity=(a:Float32Array,b:Float32Array)=>a.reduce((sum,value,i)=>sum+value*b[i],0);

function alternateOrientation(a:Float32Array,b:Float32Array) {
  let best=-1;
  for(let transform=1;transform<8;transform++){
    let corr=0;
    for(let row=0;row<grid;row++)for(let col=0;col<grid;col++){
      const y=transform&2?grid-1-row:row,x=transform&1?grid-1-col:col;
      const to=(row*grid+col)*3,from=(transform&4?x*grid+y:y*grid+x)*3;
      for(let ch=0;ch<3;ch++)corr+=a[to+ch]*b[from+ch];
    }
    best=Math.max(best,corr);
  }
  return best;
}

function compareCrop(item:ReturnType<typeof fingerprint>,reference:ReturnType<typeof fingerprint>[],pos:number):CropEvidence {
  const expected=reference[pos];
  const correlation=similarity(item.shape,expected.shape);
  const error=item.rgb.reduce((sum,value,i)=>sum+Math.abs(value-expected.rgb[i]),0)/item.rgb.length;
  const elsewhere=Math.max(...reference.map((crop,i)=>i===pos?-1:similarity(item.shape,crop.shape)));
  const lead=correlation-Math.max(elsewhere,alternateOrientation(item.shape,expected.shape));
  return {correlation,error,lead,contrast:expected.contrast};
}

function supportsPlacement({correlation,error,lead,contrast}:CropEvidence,bindings:number) {
  if(contrast>=4){
    if(correlation>=.975&&error<=6&&lead>=.05)return true;
    if(bindings===3&&correlation>=.91&&error<=5&&lead>=.16)return true;
  }
  return contrast>=2&&correlation>=.99&&error<=2.5&&lead>=.15;
}

export async function reviewSectorCrops(
  sectors:Sector[],candidates:Placement[],packs:Map<string,Pack>,textures:Record<string,Texture>,
  progress:(done:number,total:number)=>void,
) {
  const sectorAt=new Map(sectors.map(sector=>[cellKey(sector.x,sector.y),sector]));
  const cache=new Map<string,Promise<ReturnType<typeof fingerprint>[]|null>>();
  function readSector(sector:Sector,side:number){
    const key=`${sector.id}:${side}`;
    let entry=cache.get(key);
    if(!entry){
      entry=pixels(sector.id,side,packs,textures).then(image=>image&&Array.from({length:16},
        (_,i)=>fingerprint(image,i%4,i>>2,4,side===512)));
      cache.set(key,entry);
    }
    return entry;
  }
  const jobs=candidates.flatMap(candidate=>{
    const sector=sectorAt.get(cellKey(Math.floor(candidate.x/4)*4,Math.floor(candidate.y/4)*4));
    return sector?[{candidate,sector}]:[];
  });
  const verified:Placement[]=[];
  const evidence=new Map<string,CropEvidence>();
  progress(0,jobs.length);
  for(let start=0;start<jobs.length;start+=12){
    const batch=jobs.slice(start,start+12);
    const results=await Promise.all(batch.map(async ({candidate,sector})=>{
      const [image,reference]=await Promise.all([pixels(candidate.id,128,packs,textures),readSector(sector,256)]);
      if(!image||!reference)return;
      const pos=(candidate.y-sector.y)*4+candidate.x-sector.x;
      const quick=compareCrop(fingerprint(image,0,0,1),reference,pos);
      const bindings=candidate.meshes.length;
      evidence.set(candidate.id,quick);
      if(!supportsPlacement(quick,bindings)){
        // In a promising match, use a larger mip to reduce sampling errors
        // before rejecting a strongly distinctive crop.
        if(quick.correlation<.84||quick.error>9||quick.contrast<2)return;
        const [detail,larger]=await Promise.all([pixels(candidate.id,256,packs,textures),readSector(sector,512)]);
        if(!detail||!larger)return;
        const refined=compareCrop(fingerprint(detail,0,0,1,true),larger,pos);
        if(refined.correlation>quick.correlation&&refined.error<quick.error)evidence.set(candidate.id,refined);
        if(!supportsPlacement(refined,bindings))return;
      }
      return {...candidate,recovery:"sector" as const};
    }));
    for(const result of results)if(result)verified.push(result);
    progress(start+batch.length,jobs.length);
  }
  return {verified,evidence};
}

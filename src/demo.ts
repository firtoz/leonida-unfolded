import { TerrainView } from "./terrain-view";
import { StreetView } from "./street-view";
import { StreetFpsChart } from "./street-fps-chart";
import type { StreetChunk } from "./street-mesh";
import type { Rect } from "./recover";

const canvas=document.querySelector<HTMLCanvasElement>("#demo-map")!;
const walkCanvas=document.querySelector<HTMLCanvasElement>("#demo-walk")!;
const controls=document.querySelector<HTMLElement>("#demo-controls")!;
const status=document.querySelector<HTMLElement>("#demo-status")!;
const walk=document.querySelector<HTMLButtonElement>("#walk")!;
const back=document.querySelector<HTMLButtonElement>("#back")!;
const water=document.querySelector<HTMLElement>("#water")!;
const rect:Rect=[0,0,40,28];
const size=192;
const elevation=new Uint16Array(size*size);
const raster=document.createElement("canvas");
raster.width=raster.height=size;
const ctx=raster.getContext("2d")!;
const image=ctx.createImageData(size,size);

function island(x:number,y:number) {
  const main=1-Math.hypot((x+.12)*1.23,(y-.1)*1.6);
  const point=.42-Math.hypot(x-.52,y+.16);
  return Math.max(main,point)+.055*Math.sin(x*14+y*8)*Math.cos(y*8);
}

for(let row=0;row<size;row++)for(let col=0;col<size;col++){
  const i=row*size+col;
  const height=island(2*col/size-1,2*row/size-1);
  elevation[i]=Math.round(27988+3400*height);
  const color=height<0?[35,86,112]:height<.12?[213,185,128]:[90+75*height,122+35*height,84+12*height];
  image.data.set([...color,255],4*i);
}
ctx.putImageData(image,0,0);
const view=new TerrainView(canvas,rect,([x,y,w,h],density)=>{
  const overlay=document.createElement("canvas");
  overlay.width=Math.ceil(w*density);
  overlay.height=Math.ceil(h*density);
  overlay.getContext("2d")!.drawImage(raster,x/rect[2]*size,y/rect[3]*size,w/rect[2]*size,h/rect[3]*size,
    0,0,overlay.width,overlay.height);
  return overlay;
});
view.raised=true;
view.tilt=29;
view.open([20,14],Math.min(canvas.clientWidth/42,canvas.clientHeight/34));
await createImageBitmap(raster).then(image=>view.installHeight({image,rect,elevation}));
water.querySelector("input")!.onchange=event=>{
  view.waterEffects=(event.currentTarget as HTMLInputElement).checked;
  view.draw();
};

function sampleTerrain():StreetChunk {
  const vertices:number[]=[],indices:number[]=[];
  const steps=49;
  for(let row=0;row<steps;row++)for(let col=0;col<steps;col++){
    const x=(col-24)*6,y=(row-24)*6;
    const height=island(x/145,-y/145);
    vertices.push(x,y,Math.max(-1,30*height),height<0?31:height<.12?48:46);
    if(row&&col){
      const a=row*steps+col;
      indices.push(a-steps-1,a-steps,a,a-steps-1,a,a-1);
    }
  }
  return {id:"sample-island",kind:"terrain",origin:[0,0,0],bounds:[-144,-144,-1,144,144,30],vertices:Float32Array.from(vertices),indices:Uint16Array.from(indices)};
}

let street:StreetView|undefined;
const chart=new StreetFpsChart(document.querySelector("#demo-fps")!,document.querySelector("#demo-idle")!);
walk.onclick=()=>{
  canvas.hidden=walk.hidden=water.hidden=true;
  walkCanvas.hidden=back.hidden=controls.hidden=false;
  street=new StreetView(walkCanvas,{
    origin:[0,0,0],pickedSpawn:{matchHeight:false},request:()=>{},requestTexture:()=>{},
  },status,{
    bearing:document.querySelector("#demo-bearing")!,minimap:document.querySelector("#demo-minimap")!,
    marker:document.querySelector("#demo-marker")!,fps:chart,
  });
  const terrain=sampleTerrain();
  street.installRegion([terrain.id],[terrain]);
};
back.onclick=()=>{
  street?.dispose();
  street=undefined;
  walkCanvas.hidden=back.hidden=controls.hidden=true;
  canvas.hidden=walk.hidden=water.hidden=false;
  status.textContent="";
  view.draw();
  walk.focus();
};
document.documentElement.dataset.demoReady="true";

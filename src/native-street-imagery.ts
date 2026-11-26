import type { NativeScene } from "./native-map";

const tilePixels=128;
const retainedTiles=80;

export class NativeStreetImagery {
  private readonly positions:Float32Array;
  private readonly materials:Uint8Array;
  private readonly cache=new Map<string,HTMLCanvasElement|null>();

  constructor(private readonly scene:NativeScene){
    this.positions=new Float32Array(scene.vertices);
    this.materials=new Uint8Array(scene.vertices);
  }

  paint(ctx:CanvasRenderingContext2D,x:number,y:number,left:number,top:number,pixels:number){
    const key=`${x},${y}`;
    let tile=this.cache.get(key);
    this.cache.delete(key);
    if(tile===undefined)tile=this.makeTile(x,y);
    this.cache.set(key,tile);
    if(this.cache.size>retainedTiles)this.cache.delete(this.cache.keys().next().value!);
    if(tile)ctx.drawImage(tile,left,top,pixels,pixels);
  }

  private makeTile(x:number,y:number){
    const {positions,materials}=this,indices=this.scene.indices;
    const intersects=([left,top,,right,bottom]:readonly number[])=>
      left<x+1&&right>x&&top<y+1&&bottom>y;
    let paths:Path2D|undefined;
    for(const tile of this.scene.tiles){
      if(!intersects(tile.bounds))continue;
      for(const range of tile.chunks){
        if(!intersects(range.bounds))continue;
        for(let i=range.first;i<range.first+range.count;i+=3){
          const a=indices[i],surface=materials[a*16+15];
          if(surface!==3&&surface!==4)continue;
          const b=indices[i+1],c=indices[i+2];
          const ax=positions[4*a]-x,ay=positions[4*a+1]-y;
          const bx=positions[4*b]-x,by=positions[4*b+1]-y;
          const cx=positions[4*c]-x,cy=positions[4*c+1]-y;
          if(Math.max(ax,bx,cx)<=0||Math.min(ax,bx,cx)>=1||
             Math.max(ay,by,cy)<=0||Math.min(ay,by,cy)>=1)continue;
          const area=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
          if(area===0)continue;
          const path=paths??=new Path2D();
          path.moveTo(ax*tilePixels,ay*tilePixels);
          // Keep overlapping source triangles from cancelling in a combined fill.
          path.lineTo((area>0?bx:cx)*tilePixels,(area>0?by:cy)*tilePixels);
          path.lineTo((area>0?cx:bx)*tilePixels,(area>0?cy:by)*tilePixels);
          path.closePath();
        }
      }
    }
    if(!paths)return null;
    const canvas=document.createElement("canvas");
    canvas.width=canvas.height=tilePixels;
    const ctx=canvas.getContext("2d");
    if(!ctx)return null;
    ctx.fillStyle="#929087";
    ctx.globalAlpha=.56;
    ctx.fill(paths);
    return canvas;
  }
}

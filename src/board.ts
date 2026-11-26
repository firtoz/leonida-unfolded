import { cellKey, type Atlas, type Rect, type Placement, type Sector } from "./recover";
import type { Event, Request, SketchPoint, TileInfo } from "./protocol";
import type { NativeStreetImagery } from "./native-street-imagery";

type Raster = {image:ImageBitmap;rect:Rect};
type Loaded = {image:ImageBitmap;info?:TileInfo};
type Job = {request:Extract<Request,{kind:"tile"|"sector"}>;priority:number};
export type LayerName = "height"|"surface"|"atlas"|"coarse"|"manual"|"roads"|"lights"|"roofs"|"cartography"|"native"|"districts"|"places"|"road-names";
export const layerNames:Record<LayerName,string>={
  districts:"Districts",places:"Places","road-names":"Road names",
  height:"Height relief",surface:"Surface detail",atlas:"Recovered tiles",coarse:"Sector textures",
  manual:"Manual fills",roofs:"Roof imagery",cartography:"Cartographic map",native:"Pause map",roads:"Roads",lights:"Night lights",
};
export const defaults:Record<LayerName,number>={height:0,surface:0,atlas:0,coarse:0,manual:100,roads:0,lights:0,roofs:0,cartography:0,native:100,districts:100,places:0,"road-names":0};

export class Images {
  private cache=new Map<string,Loaded>();
  private pending=new Set<string>();
  private missing=new Set<string>();
  private wanted=new Map<string,Job>();
  private thumbnails=new Map<string,Job>();
  private bytes=0;
  constructor(private worker:Worker, private update:(key:string)=>void) {}
  key(id:string,side:number,sector=false){return `${sector?"sector":"tile"}:${id}:${side}`;}
  get(key:string){
    const entry=this.cache.get(key);
    if(entry){this.cache.delete(key);this.cache.set(key,entry);}
    return entry;
  }
  startFrame(){this.wanted.clear();}
  private want(id:string,side:number,sector:boolean,priority:number,gallery=false) {
    const key=this.key(id,side,sector);
    const queue=gallery?this.thumbnails:this.wanted;
    if(!this.cache.has(key)&&!this.pending.has(key)&&!this.missing.has(key)&&
       (queue.get(key)?.priority??Infinity)>priority)
      queue.set(key,{request:{kind:sector?"sector":"tile",key,id,side},priority});
    return key;
  }
  image(id:string,side:number,priority:number,sector=false) {
    const key=this.want(id,side,sector,priority);
    return this.get(key)??[256,128,512,1024].map(s=>this.get(this.key(id,s,sector))).find(Boolean);
  }
  thumbnail(id:string){
    const key=this.want(id,96,false,15000,true);
    this.flush();
    return {key,entry:this.get(key)};
  }
  flush(){
    if(this.pending.size>=5) return;
    const rows=[...this.wanted.values(),...this.thumbnails.values()].sort((a,b)=>a.priority-b.priority);
    for(const {request} of rows){
      const {key}=request;
      if(this.pending.size>=5)break;
      if(this.pending.has(key)||this.cache.has(key)||this.missing.has(key))continue;
      this.pending.add(key);this.thumbnails.delete(key);
      this.worker.postMessage(request);
    }
  }
  finish(message:Extract<Event,{kind:"tile"}>){
    const {key,image,info}=message;
    this.pending.delete(key);
    if(image){
      this.cache.set(key,{image,info});
      this.bytes+=image.width*image.height*4;
      while(this.bytes>144*1024*1024){
        const oldest=this.cache.keys().next().value!;
        const removed=this.cache.get(oldest)!.image;
        this.bytes-=removed.width*removed.height*4;
        this.cache.delete(oldest);
        removed.close();
      }
    }else this.missing.add(key);
    this.update(key);
    this.flush();
  }
  clearGallery(){this.thumbnails.clear();}
  dispose(){for(const {image} of this.cache.values()) image.close();this.cache.clear();}
}

export class Board {
  x=0;y=0;scale=10;
  selected:[number,number]|null=null;
  preview:string|null=null;
  strokes:SketchPoint[][]=[];
  markers=false;
  opacity={...defaults};
  readonly tiles:Map<string,Placement>;
  readonly sectors=new Map<string,Sector>();
  readonly rasters=new Map<string,Raster>();
  readonly roofImages=new Map<string,Raster>();
  fills=new Map<string,string>();
  private animation=0;
  private readonly ctx:CanvasRenderingContext2D;
  private readonly resize:ResizeObserver;
  private disposed=false;
  private dpr=1;
  private projectedCanvas=document.createElement("canvas");
  projected=false;
  afterPaint:()=>void=()=>{};
  projectDraw:()=>void=()=>{};
  requestRoofs:(rect:Rect|null)=>void=()=>{};

  constructor(readonly canvas:HTMLCanvasElement,readonly atlas:Atlas,readonly images:Images,
              private onScale:(scale:number)=>void){
    this.tiles=new Map();
    this.installAtlas(atlas);
    this.ctx=canvas.getContext("2d")!;
    this.resize=new ResizeObserver(()=>this.draw());
    this.resize.observe(canvas);
  }
  installAtlas(atlas:Atlas){
    Object.assign(this.atlas,atlas);
    this.tiles.clear();this.sectors.clear();
    for(const tile of atlas.cells)this.tiles.set(cellKey(tile.x,tile.y),tile);
    for(const sector of atlas.sectors)for(let y=sector.y;y<sector.y+4;y++)for(let x=sector.x;x<sector.x+4;x++)
      this.sectors.set(cellKey(x,y),sector);
  }
  dispose(){
    this.resize.disconnect();
    this.disposed=true;
    cancelAnimationFrame(this.animation);
    for(const raster of this.rasters.values())raster.image.close();
    for(const raster of this.roofImages.values())raster.image.close();
    this.images.dispose();
  }
  raster(name:string,image:ImageBitmap,rect:Rect){
    this.rasters.get(name)?.image.close();
    this.rasters.set(name,{image,rect});this.draw();
  }
  roofImage(id:string,image:ImageBitmap,rect:Rect){
    this.roofImages.get(id)?.image.close();
    this.roofImages.delete(id);
    this.roofImages.set(id,{image,rect});
    if(this.roofImages.size>96){
      const oldest=this.roofImages.keys().next().value!;
      this.roofImages.get(oldest)!.image.close();
      this.roofImages.delete(oldest);
    }
    this.draw();
  }
  zoom(factor:number,px=this.canvas.clientWidth/2,py=this.canvas.clientHeight/2){
    const next=Math.max(.3,Math.min(4096,this.scale*factor));
    this.x+=px*(1/this.scale-1/next);
    this.y+=py*(1/this.scale-1/next);
    this.scale=next;
    this.onScale(next);this.draw();
  }
  fit(sidebar:number){
    const [x,y,w,h]=this.atlas.world;
    const width=Math.max(100,this.canvas.clientWidth-sidebar);
    const height=Math.max(100,this.canvas.clientHeight);
    this.scale=Math.min(width*.94/w,height*.9/h);
    this.x=x-(width/this.scale-w)/2;
    this.y=y-(height/this.scale-h)/2;
    this.onScale(this.scale);this.draw();
  }
  center(x:number,y:number,sidebar:number,minScale=92){
    this.scale=Math.max(this.scale,minScale);
    this.x=x+.5-Math.max(100,this.canvas.clientWidth-sidebar)/this.scale/2;
    this.y=y+.5-this.canvas.clientHeight/this.scale/2;
    this.onScale(this.scale);this.draw();
  }
  pan(dx:number,dy:number){this.x-=dx/this.scale;this.y-=dy/this.scale;this.draw();}
  mapPoint(x:number,y:number){return [this.x+x/this.scale,this.y+y/this.scale] as const;}
  contains(x:number,y:number){
    const [left,top,w,h]=this.atlas.world;
    return x>=left&&y>=top&&x<left+w&&y<top+h;
  }
  canEdit(key:string){
    const tile=this.tiles.get(key);
    return !tile||tile.recovery!==undefined;
  }
  placeThumbnail([x,y]:readonly [number,number],canvas:HTMLCanvasElement){
    const cx=Math.floor(x),cy=Math.floor(y),key=cellKey(cx,cy);
    const tile=this.tiles.get(key),sector=this.sectors.get(key);
    const id=tile?.id??sector?.id;
    if(!id)return false;
    const image=this.images.image(id,256,0,!tile)?.image;
    this.images.flush();
    if(!image)return false;
    const span=tile?1:4,anchor=tile?[cx,cy]:[sector!.x,sector!.y];
    const pixels=image.width/span;
    const size=Math.min(image.width,pixels*.7);
    const left=Math.min(image.width-size,Math.max(0,(x-anchor[0])*pixels-size/2));
    const top=Math.min(image.height-size,Math.max(0,(y-anchor[1])*pixels-size/2));
    canvas.getContext("2d")!.drawImage(image,left,top,size,size,0,0,canvas.width,canvas.height);
    return true;
  }
  color(x:number,y:number):[number,number,number]{
    const pixel=this.ctx.getImageData(Math.floor(x*this.dpr),Math.floor(y*this.dpr),1,1).data;
    return [pixel[0],pixel[1],pixel[2]];
  }
  cancelDraw(){
    cancelAnimationFrame(this.animation);
    this.animation=0;
  }
  draw(){
    if(this.disposed||document.hidden)return;
    if(this.projected){this.projectDraw();return;}
    if(this.animation)return;
    this.animation=requestAnimationFrame(()=>{this.animation=0;if(!this.projected)this.paint();});
  }
  project(rect:Rect,pixelsPerCell:number,viewScale:number,native=false){
    const opacity=native?{...this.opacity,roads:0}:this.opacity;
    const imagery=opacity.atlas||opacity.coarse||opacity.roofs||opacity.manual&&this.fills.size||
      Object.entries(opacity).some(([key,value])=>value&&this.rasters.has(key));
    if(!imagery&&!this.selected&&!this.markers)return null;
    const canvas=this.projectedCanvas;
    const [x,y,w,h]=rect;
    const width=Math.max(1,Math.ceil(w*pixelsPerCell));
    const height=Math.max(1,Math.ceil(h*pixelsPerCell));
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    this.paintLayers(canvas.getContext("2d")!,x,y,width,height,pixelsPerCell,viewScale,Math.min(2,devicePixelRatio||1),true,opacity);
    return canvas;
  }
  streetImagery(canvas:HTMLCanvasElement,[x,y,w,h]:Rect,overview?:NativeStreetImagery){
    const density=256,width=w*density,height=h*density;
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    const ctx=canvas.getContext("2d")!;
    ctx.clearRect(0,0,width,height);
    this.images.startFrame();
    for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++){
      const key=cellKey(col,row),tile=this.tiles.get(key),sector=this.sectors.get(key);
      const left=(col-x)*density,top=(row-y)*density;
      const priority=Math.abs(col-x-w/2)+Math.abs(row-y-h/2);
      const local=tile&&this.images.image(tile.id,256,priority)?.image;
      if(local){ctx.drawImage(local,left,top,density,density);continue;}
      if(!sector){
        if(!tile)overview?.paint(ctx,col,row,left,top,density);
        continue;
      }
      const fallback=this.images.image(sector.id,512,priority+10,true)?.image;
      if(!fallback)continue;
      const side=fallback.width/4;
      ctx.drawImage(fallback,(col-sector.x)*side,(row-sector.y)*side,side,side,left,top,density,density);
    }
    this.images.flush();
  }
  private paint(){
    const {canvas,ctx,scale}=this;
    const ratio=Math.min(2,devicePixelRatio||1);
    this.dpr=ratio;
    const width=Math.round(canvas.clientWidth*ratio),height=Math.round(canvas.clientHeight*ratio);
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    this.paintLayers(ctx,this.x,this.y,width,height,scale*ratio,scale,ratio,false);
    this.afterPaint();
  }
  private paintLayers(ctx:CanvasRenderingContext2D,leftEdge:number,topEdge:number,width:number,height:number,
                      pixelsPerCell:number,scale:number,ratio:number,transparent:boolean,opacity=this.opacity){
    const box=(x:number,y:number,w=1,h=1)=>{
      const xx=Math.round((x-leftEdge)*pixelsPerCell),yy=Math.round((y-topEdge)*pixelsPerCell);
      return [xx,yy,Math.round((x+w-leftEdge)*pixelsPerCell)-xx,Math.round((y+h-topEdge)*pixelsPerCell)-yy] as const;
    };
    const backdrop=(name:string,opacity:number)=>{
      const raster=this.rasters.get(name);
      if(!raster||!opacity)return;
      ctx.globalAlpha=opacity/100;
      ctx.drawImage(raster.image,...box(...raster.rect));
    };
    const baseSample=(name:"atlas"|"coarse",x:number,y:number,dest:readonly [number,number,number,number])=>{
      const raster=this.rasters.get(name);
      if(!raster)return;
      const r=raster.image.width/raster.rect[2];
      ctx.drawImage(raster.image,(x-raster.rect[0])*r,(y-raster.rect[1])*r,r,r,...dest);
    };
    ctx.globalAlpha=1;
    if(transparent)ctx.clearRect(0,0,width,height);
    else{ctx.fillStyle="#171123";ctx.fillRect(0,0,width,height);}
    this.images.startFrame();
    const cartographyOpaque=opacity.cartography===100&&this.rasters.has("cartography");
    if(!cartographyOpaque){
      backdrop("height",opacity.height);backdrop("surface",opacity.surface);
    }
    const [left,top,w,h]=this.atlas.world;
    const minX=Math.max(left,Math.floor(leftEdge)),maxX=Math.min(left+w,Math.ceil(leftEdge+width/pixelsPerCell));
    const minY=Math.max(top,Math.floor(topEdge)),maxY=Math.min(top+h,Math.ceil(topEdge+height/pixelsPerCell));
    const close=scale>=15;
    if(!close&&!cartographyOpaque){
      backdrop("coarse",opacity.coarse);backdrop("atlas",opacity.atlas);
    }
    const tileSide=scale*ratio>=620?1024:scale*ratio>=340?512:scale*ratio>=155?256:128;
    const sectorSide=scale*ratio>=160?1024:scale*ratio>=64?512:128;
    if(close&&!cartographyOpaque){
      for(let y=minY;y<maxY;y++)for(let x=minX;x<maxX;x++){
        const key=cellKey(x,y),tile=this.tiles.get(key),sector=this.sectors.get(key);
        const isSelected=this.selected?.[0]===x&&this.selected[1]===y;
        const dest=box(x,y);
        if(!dest[2]||!dest[3])continue;
        const distance=Math.abs(dest[0]-width/2)+Math.abs(dest[1]-height/2);
        if(sector&&opacity.coarse&&(!tile||tile.recovery==="edges"&&opacity.atlas<100)){
          ctx.globalAlpha=opacity.coarse/100;
          const entry=this.images.image(sector.id,sectorSide,distance+30,true);
          if(entry){
            const s=entry.image.width/4;
            ctx.drawImage(entry.image,(x-sector.x)*s,(y-sector.y)*s,s,s,...dest);
          }else baseSample("coarse",x,y,dest);
        }
        if(tile&&opacity.atlas){
          ctx.globalAlpha=opacity.atlas/100;
          const entry=this.images.image(tile.id,tileSide,isSelected?-1000:distance);
          if(entry)ctx.drawImage(entry.image,...dest);
          else baseSample("atlas",x,y,dest);
        }
      }
    }
    backdrop("cartography",opacity.cartography);
    if(opacity.roofs&&close&&this.atlas.sectors.length&&minX<maxX&&minY<maxY){
      this.requestRoofs([minX,minY,maxX-minX,maxY-minY]);
      ctx.globalAlpha=opacity.roofs/100;
      for(const {image,rect} of this.roofImages.values()){
        const [x,y,w,h]=rect;
        if(x<maxX&&x+w>minX&&y<maxY&&y+h>minY)ctx.drawImage(image,...box(...rect));
      }
    }else if(opacity.roofs)this.requestRoofs(null);
    if(opacity.manual&&this.fills.size){
      ctx.globalAlpha=opacity.manual/100;
      for(let y=minY;y<maxY;y++)for(let x=minX;x<maxX;x++){
        const fill=this.fills.get(cellKey(x,y));
        if(!fill)continue;
        const dest=box(x,y);
        if(!dest[2]||!dest[3])continue;
        const distance=Math.abs(dest[0]-width/2)+Math.abs(dest[1]-height/2);
        const selected=this.selected?.[0]===x&&this.selected[1]===y;
        const entry=this.images.image(fill,close?tileSide:128,selected?-1000:distance);
        if(entry)ctx.drawImage(entry.image,...dest);
      }
    }
    if(this.selected&&this.preview){
      const [x,y]=this.selected;
      if(x>=minX&&x<maxX&&y>=minY&&y<maxY&&this.canEdit(cellKey(x,y))){
        ctx.globalAlpha=1;
        const preview=this.images.image(this.preview,close?tileSide:128,-2000);
        if(preview)ctx.drawImage(preview.image,...box(x,y));
      }
    }
    backdrop("roads",opacity.roads);backdrop("lights",opacity.lights);
    ctx.globalAlpha=1;ctx.lineWidth=ratio;
    if(this.markers&&this.atlas.cells.length&&scale>=22){
      ctx.strokeStyle="#ffe3f0b0";ctx.beginPath();
      for(let y=minY;y<maxY;y++)for(let x=minX;x<maxX;x++){
        const key=cellKey(x,y);
        if(this.tiles.has(key)||this.fills.has(key)||opacity.coarse&&this.sectors.has(key))continue;
        const [px,py]=box(x+.5,y+.5);
        ctx.moveTo(px-3*ratio,py);ctx.lineTo(px+3*ratio,py);
        ctx.moveTo(px,py-3*ratio);ctx.lineTo(px,py+3*ratio);
      }
      ctx.stroke();
    }
    if(this.selected){
      const [x,y,w,h]=box(...this.selected);
      ctx.strokeStyle=this.preview?"#ff9aba":"#ffe0a9";
      if(this.preview)ctx.setLineDash([8*ratio,5*ratio]);
      ctx.strokeRect(x,y,w,h);
      ctx.setLineDash([]);
      ctx.lineCap="round";ctx.lineWidth=2*ratio;
      for(const stroke of this.strokes){
        const color=stroke[0]?.color;
        ctx.strokeStyle=color?`rgb(${color.join(",")})`:"#ff91b1";
        ctx.beginPath();
        for(const [i,p] of stroke.entries()) {
          if(i===0){ctx.moveTo(x+p.x*w,y+p.y*h);ctx.lineTo(x+p.x*w+.1,y+p.y*h);}
          else ctx.lineTo(x+p.x*w,y+p.y*h);
        }
        ctx.stroke();
      }
    }
    this.images.flush();
  }
}

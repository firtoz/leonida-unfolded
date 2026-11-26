import { contains, type District, type MapLabel, type Point } from "./districts";
import type { Place, PlaceKind } from "./places";
import type { ProjectedAnchor } from "./map-depth";
import type { RoadLabelPath, RoadNames } from "./road-names";
import { CELL } from "./recover";

const markerColors:Record<PlaceKind,string>={
  Shop:"#ffc7a4","Food and drink":"#eeb3ff",Landmark:"#ffed88",Place:"#a8eadc",
};

type ProjectLabel=(point:Point,elevation?:number)=>ProjectedAnchor|null;
type Glyph={text:string;x:number;y:number;angle:number};
type LabelBox={left:number;right:number;top:number;bottom:number};
const fade=(scale:number,from:number,to:number)=>{
  const t=Math.max(0,Math.min(1,(scale-from)/(to-from)));
  return t*t*(3-2*t);
};
const intersects=(a:LabelBox,b:LabelBox)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;

function visibleRoadSpan(line:ProjectedAnchor[],distances:number[],width:number,height:number){
  let best:[number,number]|null=null,begin=0,end=0;
  for(let i=1;i<line.length;i++){
    const a=line[i-1],b=line[i],span=distances[i]-distances[i-1];
    let min=0,max=1;
    for(const [origin,delta,limit] of [[a.x,b.x-a.x,width],[a.y,b.y-a.y,height]]){
      if(!delta){
        if(origin<0||origin>limit)max=-1;
        continue;
      }
      const first=-origin/delta,last=(limit-origin)/delta;
      min=Math.max(min,Math.min(first,last));
      max=Math.min(max,Math.max(first,last));
    }
    if(min>max||!span)continue;
    const low=distances[i-1]+min*span,high=distances[i-1]+max*span;
    if(low>end+.001)begin=low;
    end=high;
    if(!best||end-begin>best[1]-best[0])best=[begin,end];
  }
  return best;
}

function roadGlyphs(path:RoadLabelPath,anchor:ProjectedAnchor,project:ProjectLabel,
  metrics:{width:number;letters:{text:string;offset:number}[]},width:number,height:number){
  const points=path.points.map(([x,y,z],i)=>i===path.anchorIndex?anchor:project([x/CELL,-y/CELL],z));
  let start=path.anchorIndex,end=start;
  while(start>0&&points[start-1])start--;
  while(end<points.length-1&&points[end+1])end++;
  const line=points.slice(start,end+1) as ProjectedAnchor[],distances=[0];
  for(let i=1;i<line.length;i++)distances.push(distances[i-1]+Math.hypot(line[i].x-line[i-1].x,line[i].y-line[i-1].y));
  let middle=distances[path.anchorIndex-start];
  const length=distances.at(-1)!;
  if(length<12)return null;
  const at=(distance:number)=>{
    const index=distances.findIndex((value,i)=>i>0&&value>distance);
    const i=index<0?line.length-1:index;
    const a=line[i-1],b=line[i],span=distances[i]-distances[i-1];
    const t=span?(distance-distances[i-1])/span:1;
    return {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,depth:a.depth+(b.depth-a.depth)*t};
  };
  const padding=metrics.width/2+8;
  const shifted=anchor.x<-padding||anchor.x>width+padding||anchor.y<-padding||anchor.y>height+padding;
  if(shifted){
    const span=visibleRoadSpan(line,distances,width,height);
    if(!span||span[1]-span[0]<18)return null;
    middle=(span[0]+span[1])/2;
  }
  const before=at(Math.max(0,middle-10)),after=at(Math.min(length,middle+10));
  const direction=after.x<before.x?-1:1;
  const glyphs:Glyph[]=[];
  const box:LabelBox={left:Infinity,right:-Infinity,top:Infinity,bottom:-Infinity};
  for(const {text,offset} of metrics.letters){
    if(text===" ")continue;
    const d=middle+offset*direction;
    if(d<0||d>length)continue;
    const {x,y}=at(d);
    if(x<-8||x>width+8||y<-8||y>height+8)continue;
    const a=at(Math.max(0,d-4)),b=at(Math.min(length,d+4));
    const angle=Math.atan2((b.y-a.y)*direction,(b.x-a.x)*direction);
    glyphs.push({text,x,y,angle});
    box.left=Math.min(box.left,x-7);box.right=Math.max(box.right,x+7);
    box.top=Math.min(box.top,y-7);box.bottom=Math.max(box.bottom,y+7);
  }
  return glyphs.length?{glyphs,box,anchor:shifted?at(middle):anchor,shifted}:null;
}

type RoadCandidate={path:RoadLabelPath;layout:NonNullable<ReturnType<typeof roadGlyphs>>};
type RoadBuild={key:string;roads:RoadNames;paths:RoadLabelPath[];next:number;candidates:RoadCandidate[]};

export class DistrictView {
  districts:District[]=[];
  mapLabels:MapLabel[]=[];
  places:Place[]=[];
  roads:RoadNames|null=null;
  cursor:Point|null=null;

  private readonly roadText=new Map<string,{width:number;letters:{text:string;offset:number}[]}>();
  private roadBuild:RoadBuild|null=null;
  private roadView:{key:string;roads:RoadNames;moving:boolean}|null=null;
  private roadPlaced:{roads:RoadNames;paths:RoadLabelPath[]}|null=null;
  private roadHits:RoadCandidate[]=[];
  private readonly glyphs=new Map<string,HTMLCanvasElement>();
  private readonly depthByFeature=new Map<Point|Place,boolean>();
  private zoomFade:{from:number;to:number;start:number}|null=null;
  private readonly instantZoom=matchMedia("(prefers-reduced-motion: reduce)");
  private readonly title=document.createElement("span");
  private readonly photo=document.createElement("canvas");

  constructor(private canvas:HTMLCanvasElement,private roadCanvas:HTMLCanvasElement,private tooltip:HTMLElement,
    private thumbnail:(point:Point,canvas:HTMLCanvasElement)=>boolean){
    this.photo.width=256;this.photo.height=144;
    this.photo.setAttribute("aria-label","Local aerial texture near this place");
    this.tooltip.append(this.title,this.photo);
  }

  private roadMetrics(ctx:CanvasRenderingContext2D,name:string){
    const cached=this.roadText.get(name);
    if(cached)return cached;
    let prefix="",advance=0;
    const width=ctx.measureText(name).width;
    const letters=Array.from(name,text=>{
      prefix+=text;
      const next=ctx.measureText(prefix).width;
      const offset=(advance+next-width)/2;
      advance=next;
      return {text,offset};
    });
    const metrics={width,letters};
    this.roadText.set(name,metrics);
    return metrics;
  }

  private roadGlyph(text:string,ratio:number){
    const key=`${ratio}:${text}`;
    let sprite=this.glyphs.get(key);
    if(sprite)return sprite;
    sprite=document.createElement("canvas");
    sprite.width=sprite.height=Math.ceil(24*ratio);
    const ctx=sprite.getContext("2d")!;
    ctx.setTransform(ratio,0,0,ratio,sprite.width/2,sprite.height/2);
    ctx.font="650 12px system-ui";
    ctx.textBaseline="middle";ctx.textAlign="center";
    ctx.lineWidth=3;ctx.lineJoin="round";ctx.strokeStyle="#1d142be6";ctx.fillStyle="#ffdfac";
    ctx.strokeText(text,0,0);ctx.fillText(text,0,0);
    this.glyphs.set(key,sprite);
    return sprite;
  }

  private updateRoadLayer(roads:RoadNames|null,view:string,moving:boolean,alpha:number,width:number,height:number,ratio:number,
    occupied:LabelBox[],unproject:(point:Point)=>Point|null,project:ProjectLabel,depthVisibility:(points:ProjectedAnchor[])=>boolean[]){
    const canvas=this.roadCanvas;
    const opacity=(alpha:number)=>{
      const value=String(alpha);
      if(canvas.style.opacity!==value)canvas.style.opacity=value;
    };
    if(!roads||!alpha){
      opacity(0);
      this.roadBuild=null;this.roadView=null;this.roadHits=[];
      if(!roads)this.roadPlaced=null;
      return false;
    }
    const key=`${view}:${width}:${height}:${ratio}`;
    if(this.roadView?.key===key&&this.roadView.roads===roads&&this.roadView.moving===moving)return false;
    const previous=this.roadPlaced?.roads===roads?this.roadPlaced.paths:[];
    if(moving&&!previous.length){
      opacity(0);this.roadBuild=null;
      return false;
    }
    const w=Math.round(width*ratio),h=Math.round(height*ratio);
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
    const ctx=canvas.getContext("2d")!;
    ctx.font="650 12px system-ui";
    let job=this.roadBuild;
    if(!job||job.key!==key||job.roads!==roads||moving){
      let paths=moving?previous:roads.labels;
      if(!moving){
        const corners=([[0,0],[width,0],[0,height],[width,height]] as Point[]).map(unproject);
        if(corners.every(point=>point!==null)){
          const xs=corners.map(point=>point[0]*CELL),ys=corners.map(point=>-point[1]*CELL);
          const search={left:Math.min(...xs)-CELL,right:Math.max(...xs)+CELL,
            top:Math.min(...ys)-CELL,bottom:Math.max(...ys)+CELL};
          paths=paths.filter(({bounds:[left,top,right,bottom]})=>intersects(search,{left,top,right,bottom}));
        }
      }
      job={key,roads,paths,next:0,candidates:[]};
      this.roadBuild=moving?null:job;
    }
    // Keep full candidate layout out of the input path, even when many roads appear together.
    const deadline=performance.now()+3;
    const nearScreen=(x:number,y:number,padding:number)=>x>=-padding&&x<=width+padding&&y>=-padding&&y<=height+padding;
    while(job.next<job.paths.length){
      const path=job.paths[job.next++],[x,y,z]=path.anchor;
      const anchor=project([x/CELL,-y/CELL],z);
      if(anchor&&(!moving||nearScreen(anchor.x,anchor.y,175))){
        const metrics=this.roadMetrics(ctx,path.name);
        const layout=roadGlyphs(path,anchor,project,metrics,width,height);
        if(layout&&(!moving||!layout.shifted))job.candidates.push({path,layout});
      }
      if(!moving&&job.next%16===0&&performance.now()>=deadline&&job.next<job.paths.length)return true;
    }
    const candidates=job.candidates;
    this.roadBuild=null;
    if(!moving){
      const priority=new Set(previous.map(path=>path.id));
      candidates.sort((a,b)=>Number(a.layout.shifted)-Number(b.layout.shifted)||
        Number(priority.has(b.path.id))-Number(priority.has(a.path.id))||
        b.path.length-a.path.length||a.path.id-b.path.id);
    }
    const onScreen=moving?[]:candidates.filter(({layout:{anchor}})=>nearScreen(anchor.x,anchor.y,0));
    const depth=depthVisibility(onScreen.map(({layout:{anchor}})=>anchor));
    const covered=new Set(onScreen.filter((_,i)=>depth[i]===false));
    const repeated=new Map<string,ProjectedAnchor[]>(),hits:RoadCandidate[]=[];
    ctx.resetTransform();ctx.clearRect(0,0,w,h);
    for(const candidate of candidates){
      if(covered.has(candidate))continue;
      const {path,layout}=candidate,{anchor}=layout;
      const prior=repeated.get(path.name);
      if(prior?.some(p=>(p.x-anchor.x)**2+(p.y-anchor.y)**2<150**2)||occupied.some(box=>intersects(box,layout.box)))continue;
      if(prior)prior.push(anchor);else repeated.set(path.name,[anchor]);
      occupied.push(layout.box);
      hits.push(candidate);
      for(const {text,x,y,angle} of layout.glyphs){
        const sprite=this.roadGlyph(text,ratio),cos=Math.cos(angle),sin=Math.sin(angle);
        ctx.setTransform(cos,sin,-sin,cos,x*ratio,y*ratio);
        ctx.drawImage(sprite,-sprite.width/2,-sprite.height/2);
      }
    }
    if(!moving)this.roadPlaced={roads,paths:hits.map(({path})=>path)};
    this.roadHits=hits;
    this.roadView={key,roads,moving};
    opacity(hits.length?alpha:0);
    return false;
  }

  hideTooltip(){this.tooltip.hidden=true;}

  draw(enabled:boolean,showPlaces:boolean,showRoads:boolean,scale:number,project:(point:Point)=>Point|null,unproject:(point:Point)=>Point|null,
    moving:boolean,view:string,projectDepth:ProjectLabel,depthVisibility:(points:ProjectedAnchor[])=>boolean[]){
    const now=performance.now(),duration=170;
    const previous=this.zoomFade;
    const current=previous&&now<previous.start+duration
      ?previous.from+(previous.to-previous.from)*fade(now,previous.start,previous.start+duration)
      :previous?.to??scale;
    if(previous?.to!==scale)this.zoomFade={from:current,to:scale,start:now};
    const zoom=this.instantZoom.matches?scale:current;
    const animating=zoom!==scale;
    const roadAlpha=fade(scale,24,44);
    const roads=showRoads?this.roads:null;
    this.canvas.hidden=!enabled&&!showPlaces&&!roads;
    if(this.canvas.hidden){
      this.hideTooltip();this.depthByFeature.clear();
      this.roadCanvas.style.opacity="0";
      this.roadPlaced=this.roadBuild=this.roadView=null;
      this.roadHits=[];
      return false;
    }
    const {canvas}=this,width=canvas.clientWidth,height=canvas.clientHeight;
    const ratio=Math.min(2,devicePixelRatio||1);
    const w=Math.round(width*ratio),h=Math.round(height*ratio);
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
    const ctx=canvas.getContext("2d")!;
    ctx.setTransform(ratio,0,0,ratio,0,0);
    ctx.clearRect(0,0,width,height);

    const onscreen=([x,y]:Point,padding:number)=>x>=-padding&&y>=-padding&&x<=width+padding&&y<=height+padding;
    const markers:{place:Place;point:Point;alpha:number}[]=[];
    const candidates:{place:Place;anchor:ProjectedAnchor;alpha:number}[]=[];
    let marker:Place|undefined,closest=12;
    if(showPlaces)for(const place of this.places){
      const alpha=place.kind==="Landmark"?fade(zoom,20,30):fade(zoom,42,58);
      if(!alpha)continue;
      const anchor=projectDepth(place.point,place.elevation);
      if(anchor&&onscreen([anchor.x,anchor.y],0))candidates.push({place,anchor,alpha});
    }
    const visible=enabled?this.districts.filter(region=>!region.detail||scale>=23):[];
    const labels:{name:string;point:Point;anchor:ProjectedAnchor;width:number;alpha:number}[]=[];
    ctx.font="600 12px system-ui";
    ctx.textBaseline="middle";ctx.textAlign="center";
    const nativeLabels=new Set<string>();
    const addLabel=(name:string,point:Point,alpha:number)=>{
      const anchor=projectDepth(point);
      const width=ctx.measureText(name).width;
      if(anchor&&onscreen([anchor.x,anchor.y],width/2))labels.push({name,point,anchor,width,alpha});
    };
    for(const label of enabled?this.mapLabels:[]){
      const alpha=label.minScale?fade(zoom,label.minScale*.82,label.minScale*1.18):1;
      if(!alpha)continue;
      nativeLabels.add(label.name);
      addLabel(label.name,label.point,alpha);
    }
    const boundaryLabelsStart=labels.length;
    for(const region of visible){
      const span=Math.max(region.bounds[2],region.bounds[3])*zoom;
      const alpha=fade(span,46,72)*(region.detail?fade(zoom,19,28):1);
      if(region.name&&alpha&&!nativeLabels.has(region.name))addLabel(region.name,region.anchor,alpha);
    }
    const depthPoints=[...candidates.map(item=>item.anchor),...labels.map(item=>item.anchor)];
    const featureKeys=[...candidates.map(item=>item.place),...labels.map(item=>item.point)];
    const visibility=moving?featureKeys.map(key=>this.depthByFeature.get(key)!==false):depthVisibility(depthPoints);
    if(!moving){
      this.depthByFeature.clear();
      featureKeys.forEach((key,index)=>this.depthByFeature.set(key,visibility[index]));
    }
    const priorityLabels=labels.slice(0,boundaryLabelsStart).filter((_,i)=>visibility[candidates.length+i]);
    const secondaryLabels=labels.slice(boundaryLabelsStart)
      .filter((_,i)=>visibility[candidates.length+boundaryLabelsStart+i]).reverse();
    for(let i=0;i<candidates.length;i++){
      if(!visibility[i])continue;
      const {place,alpha,anchor:{x,y}}=candidates[i];
      if(markers.some(({point:[px,py]})=>(x-px)**2+(y-py)**2<18**2))continue;
      markers.push({place,point:[x,y],alpha});
      if(this.cursor){
        const distance=Math.hypot(x-this.cursor[0],y-this.cursor[1]);
        if(distance<closest){closest=distance;marker=place;}
      }
    }
    const point=enabled&&!marker&&this.cursor&&unproject(this.cursor);
    const hits=point?visible.filter(({bounds:[x,y,w,h],ring})=>
      point[0]>=x&&point[0]<=x+w&&point[1]>=y&&point[1]<=y+h&&contains(ring,point)):[];
    const hovered=hits.find(region=>region.name)??hits[0];
    const main=new Path2D(),detail=new Path2D(),highlight=new Path2D();
    for(const region of visible){
      const path=region===hovered?highlight:region.detail?detail:main;
      const points=region.ring.map(project);
      for(let i=0,j=points.length-1;i<points.length;j=i++){
        const a=points[j],b=points[i];
        if(!a||!b)continue;
        if(Math.max(a[0],b[0])<0||Math.min(a[0],b[0])>width||
           Math.max(a[1],b[1])<0||Math.min(a[1],b[1])>height)continue;
        path.moveTo(...a);path.lineTo(...b);
      }
    }
    ctx.lineCap="round";
    ctx.lineWidth=3;ctx.strokeStyle="#1d142b8c";ctx.stroke(main);
    ctx.lineWidth=1.5;ctx.strokeStyle="#fff2edba";ctx.stroke(main);
    ctx.strokeStyle="#ffe7f07a";ctx.stroke(detail);
    ctx.lineWidth=4;ctx.strokeStyle="#ffe0ea";ctx.stroke(highlight);

    const drawn:typeof labels=[],occupied:LabelBox[]=[];
    ctx.font="600 12px system-ui";
    ctx.lineWidth=3;ctx.lineJoin="round";ctx.strokeStyle="#1d142be6";
    for(const label of [...priorityLabels,...secondaryLabels]){
      const {name,anchor:{x,y},width,alpha}=label;
      const box={left:x-width/2-4,right:x+width/2+4,top:y-8,bottom:y+8};
      if(occupied.some(other=>intersects(box,other)))continue;
      ctx.globalAlpha=alpha;
      ctx.fillStyle="#fff3ed";ctx.strokeText(name,x,y);ctx.fillText(name,x,y);
      if(alpha>.3)occupied.push(box);
      drawn.push(label);
    }
    const roadsPending=this.updateRoadLayer(roads,view,moving,roadAlpha,width,height,ratio,occupied,unproject,projectDepth,depthVisibility);
    for(const {place,point:[x,y],alpha} of markers){
      ctx.globalAlpha=alpha;
      ctx.beginPath();
      const radius=place===marker?6:4.5;
      if(place.kind==="Landmark"){
        ctx.moveTo(x,y-radius-1);ctx.lineTo(x+radius+1,y);
        ctx.lineTo(x,y+radius+1);ctx.lineTo(x-radius-1,y);ctx.closePath();
      }else ctx.arc(x,y,radius,0,Math.PI*2);
      ctx.strokeStyle="#21162d";ctx.lineWidth=2;
      ctx.fillStyle=markerColors[place.kind];
      ctx.fill();ctx.stroke();
    }

    ctx.globalAlpha=1;
    if(!this.cursor){this.hideTooltip();return animating||roadsPending;}
    const [x,y]=this.cursor;
    const place=drawn.find(label=>Math.abs(label.anchor.x-x)<=label.width/2+4&&Math.abs(label.anchor.y-y)<=8);
    const road=this.roadHits.find(({layout:{box}})=>x>=box.left&&x<=box.right&&y>=box.top&&y<=box.bottom);
    if(marker||hovered||place||road){
      this.title.textContent=marker?`${marker.name} · ${marker.kind}`:place?.name??road?.path.name??hovered?.name??"District name unavailable";
      this.photo.hidden=!marker||!this.thumbnail(marker.point,this.photo);
      this.tooltip.hidden=false;
      this.tooltip.style.left=`${Math.max(8,Math.min(width-this.tooltip.offsetWidth-8,this.cursor[0]+15))}px`;
      this.tooltip.style.top=`${Math.max(8,Math.min(height-this.tooltip.offsetHeight-8,this.cursor[1]+16))}px`;
    }else this.hideTooltip();
    return animating||roadsPending;
  }
}

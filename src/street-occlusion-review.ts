import type {Bounds} from "./native-spatial";
import {nativeCanopyAtlasPrefix} from "./street-canopy-atlas";
import {streetProjection} from "./street-destination";
import {streetNearPlane} from "./street-grid";
import type {InstanceTile, StreetChunk} from "./street-mesh";
import type {StreetStreamView} from "./street-priority";
import {makeProgram} from "./view-gl";

type Range = Pick<InstanceTile,"first"|"count">;
type Geometry = {instances:number};
type Chunk = {mesh:StreetChunk;bounds:Bounds;tiles?:InstanceTile[]};
type Candidate = {gpu:Geometry;range:Range;box:number[];depth:number};
type Query = {members:Candidate[];query:WebGLQuery};
const foliageQueryGroupSize=8;
const vertex=`#version 300 es
uniform vec4 boxes[${foliageQueryGroupSize}];
uniform float depths[${foliageQueryGroupSize}];
void main(){
  vec4 box=boxes[gl_InstanceID];
  vec2 uv=vec2(gl_VertexID&1,gl_VertexID>>1);
  gl_Position=vec4(mix(box.xy,box.zw,uv),depths[gl_InstanceID],1.0);
}`;
const fragment=`#version 300 es
precision highp float;
out vec4 color;
void main(){color=vec4(0);}
`;

export class StreetOcclusionReview {
  private key="";
  private measured="";
  private submitted?:Map<Geometry,Set<number>>;
  private hidden=new Map<Geometry,Set<number>>();
  private filtered=new WeakMap<Geometry,Map<Range[]|undefined,Range[]|null>>();
  private queries:Query[]=[];
  private program?:WebGLProgram;
  private timer?:ReturnType<typeof setTimeout>;
  private settleTimer?:ReturnType<typeof setTimeout>;
  private stableSince=0;
  private replay=false;
  private foliageOnly=false;
  private foliage=new Set<Geometry>();

  constructor(private readonly gl:WebGL2RenderingContext){}

  begin(camera:StreetStreamView,revision:number,eligible:boolean,foliage?:Set<Geometry>){
    this.foliageOnly=foliage!==undefined;
    this.foliage=foliage??new Set();
    const key=eligible?[revision,this.foliageOnly,...camera.eye,camera.yaw,camera.pitch,camera.fov,camera.aspect,
      camera.farPlane,this.gl.drawingBufferWidth,this.gl.drawingBufferHeight].join(","):"";
    if(key!==this.key){
      this.key=key;
      this.stableSince=performance.now();
      if(this.settleTimer!==undefined)clearTimeout(this.settleTimer);
      this.settleTimer=undefined;
    }
    this.replay=Boolean(this.key&&this.key===this.measured);
    if(!this.replay&&this.hidden.size){
      this.hidden.clear();
      this.filtered=new WeakMap();
    }
    if(!eligible)this.measured="";
    const stable=!this.foliageOnly||performance.now()-this.stableSince>=750;
    this.submitted=eligible&&stable&&!this.replay&&!this.queries.length?new Map():undefined;
  }

  filter(gpu:Geometry,ranges?:Range[]):Range[]|undefined|null{
    if(this.foliageOnly&&!this.foliage.has(gpu))return ranges;
    const hidden=this.replay?this.hidden.get(gpu):undefined;
    if(!this.submitted&&!hidden)return ranges;
    const input=ranges??[{first:0,count:gpu.instances||1}];
    if(this.submitted){
      let submitted=this.submitted.get(gpu);
      if(!submitted)this.submitted.set(gpu,submitted=new Set());
      for(const {first,count} of input)for(let i=first;i<first+count;i++)submitted.add(i);
    }
    if(!hidden)return ranges;
    if(!gpu.instances)return null;
    let cache=this.filtered.get(gpu);
    if(!cache)this.filtered.set(gpu,cache=new Map());
    const previous=cache.get(ranges);
    if(previous!==undefined)return previous;
    const selected:Range[]=[];
    for(const {first,count} of input)for(let i=first;i<first+count;i++){
      if(hidden.has(i))continue;
      const last=selected.at(-1);
      if(last&&last.first+last.count===i)last.count++;
      else selected.push({first:i,count:1});
    }
    const visible=selected.length?selected:null;
    cache.set(ranges,visible);
    return visible;
  }

  end<T extends Chunk>(camera:StreetStreamView,visible:T[],cache:ReadonlyMap<T,Geometry>,
    eligible:boolean,redraw?:()=>void){
    const submitted=this.submitted;
    this.submitted=undefined;
    this.replay=false;
    const gl=this.gl,far=camera.farPlane,key=this.key,near=streetNearPlane;
    if(this.foliageOnly&&eligible&&key&&!submitted&&key!==this.measured&&!this.queries.length&&
      this.settleTimer===undefined&&redraw){
      const remaining=750-(performance.now()-this.stableSince);
      if(remaining>0)this.settleTimer=setTimeout(()=>{
        this.settleTimer=undefined;
        if(this.key===key)redraw();
      },remaining);
    }
    if(!eligible||!submitted||!far||!gl.isEnabled(gl.DEPTH_TEST)||
      gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)!==null)return;
    const candidates:Candidate[]=[];
    const [x,y,z]=camera.eye,cy=Math.cos(camera.yaw),sy=Math.sin(camera.yaw);
    const cp=Math.cos(camera.pitch),sp=Math.sin(camera.pitch),scale=streetProjection(camera.fov);
    for(const chunk of visible){
      const {mesh}=chunk;
      if(this.foliageOnly&&mesh.kind!=="foliage")continue;
      if(!["prop","foliage","structure"].includes(mesh.kind)||mesh.interior||mesh.roller||mesh.packedSlodCenter||
        mesh.vegetationLod?.fallback||mesh.appearance?.spans.some(span=>span.texture?.startsWith(nativeCanopyAtlasPrefix)))continue;
      const gpu=cache.get(chunk),drawn=gpu&&submitted.get(gpu);
      if(!gpu||!drawn)continue;
      for(const range of chunk.tiles??[{first:0,count:gpu.instances||1,bounds:chunk.bounds}]){
        let used=false;
        for(let i=range.first;i<range.first+range.count&&!used;i++)used=drawn.has(i);
        if(!used)continue;
        const bounds=range.bounds;
        let left=Infinity,bottom=Infinity,right=-Infinity,top=-Infinity,nearest=Infinity;
        for(let corner=0;corner<8;corner++){
          const dx=bounds[corner&1?3:0]-x,dy=bounds[corner&2?4:1]-y,dz=bounds[corner&4?5:2]-z;
          const ahead=dx*cy+dy*sy,depth=ahead*cp+dz*sp;
          nearest=Math.min(nearest,depth);
          if(nearest<=near+.04)break;
          const px=(dx*sy-dy*cy)*scale/(depth*camera.aspect),py=(dz*cp-ahead*sp)*scale/depth;
          left=Math.min(left,px);right=Math.max(right,px);bottom=Math.min(bottom,py);top=Math.max(top,py);
        }
        if(nearest<=near+.04||nearest>=far-.04)continue;
        const padX=4/gl.drawingBufferWidth,padY=4/gl.drawingBufferHeight;
        const box=[Math.max(-1,left-padX),Math.max(-1,bottom-padY),Math.min(1,right+padX),Math.min(1,top+padY)];
        if(box[0]>=box[2]||box[1]>=box[3])continue;
        candidates.push({gpu,range,box,depth:1+2*near/far-2*near/(nearest-.03)-.00000012});
      }
    }
    if(!candidates.length){this.measured=key;return;}
    const program=this.program??=makeProgram(gl,vertex,fragment);
    const previous=gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
    const vao=gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject|null;
    const color=gl.getParameter(gl.COLOR_WRITEMASK) as [boolean,boolean,boolean,boolean];
    const depth=gl.getParameter(gl.DEPTH_WRITEMASK) as boolean,func=gl.getParameter(gl.DEPTH_FUNC) as number;
    const toggles=[gl.STENCIL_TEST,gl.SCISSOR_TEST,gl.CULL_FACE,gl.POLYGON_OFFSET_FILL,
      gl.SAMPLE_COVERAGE,gl.SAMPLE_ALPHA_TO_COVERAGE].filter(cap=>gl.isEnabled(cap));
    for(const cap of toggles)gl.disable(cap);
    gl.useProgram(program);gl.bindVertexArray(null);
    gl.colorMask(false,false,false,false);gl.depthMask(false);gl.depthFunc(gl.LEQUAL);
    const boxSlot=gl.getUniformLocation(program,"boxes[0]"),depthSlot=gl.getUniformLocation(program,"depths[0]");
    // Group nearby screen rectangles so a single depth query can prove
    // several tiles hidden. A positive result keeps the entire group.
    const groups:Candidate[][]=[];
    if(this.foliageOnly){
      const cells=new Map<string,Candidate[]>();
      for(const candidate of candidates){
        const [left,bottom,right,top]=candidate.box;
        const cell=[Math.floor((left+right+2)*2),Math.floor((bottom+top+2)*2)].join(",");
        let group=cells.get(cell);
        if(!group||group.length===foliageQueryGroupSize){
          group=[];
          cells.set(cell,group);
          groups.push(group);
        }
        group.push(candidate);
      }
    }else for(const candidate of candidates)groups.push([candidate]);
    const boxes=new Float32Array(foliageQueryGroupSize*4),depths=new Float32Array(foliageQueryGroupSize);
    for(const members of groups){
      const query=gl.createQuery();
      if(!query)break;
      for(const [index,{box,depth}] of members.entries()){
        boxes.set(box,index*4);
        depths[index]=depth;
      }
      gl.uniform4fv(boxSlot,boxes,0,members.length*4);
      gl.uniform1fv(depthSlot,depths,0,members.length);
      gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE,query);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,members.length);
      gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
      this.queries.push({members,query});
    }
    gl.depthFunc(func);gl.depthMask(depth);gl.colorMask(...color);
    for(const cap of toggles)gl.enable(cap);
    gl.useProgram(previous);gl.bindVertexArray(vao);
    let attempts=0;
    const poll=()=>{
      if(this.key!==key||gl.isContextLost()||attempts++>=100){
        this.clearQueries();
        return;
      }
      if(this.queries.some(({query})=>!gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE))){
        this.timer=setTimeout(poll,20);
        return;
      }
      for(const {members,query} of this.queries){
        if(gl.getQueryParameter(query,gl.QUERY_RESULT))continue;
        for(const {gpu,range:{first,count}} of members){
          let hidden=this.hidden.get(gpu);
          if(!hidden)this.hidden.set(gpu,hidden=new Set());
          for(let i=first;i<first+count;i++)hidden.add(i);
        }
      }
      this.measured=key;
      this.clearQueries();
      redraw?.();
    };
    this.timer=setTimeout(poll,20);
  }

  private clearQueries(){
    if(this.timer!==undefined)clearTimeout(this.timer);
    this.timer=undefined;
    for(const {query} of this.queries)this.gl.deleteQuery(query);
    this.queries=[];
  }

  dispose(){
    this.clearQueries();
    if(this.settleTimer!==undefined)clearTimeout(this.settleTimer);
    if(this.program)this.gl.deleteProgram(this.program);
  }
}

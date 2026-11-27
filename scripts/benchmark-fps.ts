/// <reference types="bun" />
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdir, mkdtemp, rename, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import type {Writable} from "node:stream";

const scenes={
  swamp:[-4350,-7240,60,55,-21,70],
  city:[-762.298,-1589.716,26.247,289.459,-13.465,60],
  indoors:[-4203.035,-260.353,13.020,35.001,0,52],
  coast:[2325.139,1077,57.512,250.501,-3.8,32.544],
} as const;
type Scene=keyof typeof scenes;
// At these fixed poses, the stream can pause on a much smaller preview before
// foliage and the wider region arrive. Use floors from the populated controls.
const minimumVisibleChunks={city:3000,indoors:1200,coast:1600,swamp:1150} satisfies Record<Scene,number>;
const modes=["idle","idle-redraw","turn","slow","medium"] as const;
type Mode=typeof modes[number];
const selected=(Bun.env.FPS_SCENES?.split(",")??Object.keys(scenes)) as Scene[];
const actions=(Bun.env.FPS_MODES?.split(",")??modes) as readonly Mode[];
const profileMode=Bun.env.FPS_PROFILE_MODE as Mode|undefined;
const onePixelRaster=Bun.env.FPS_PROFILE_ONE_PIXEL==="1";
const lockRenderScale=Bun.env.FPS_LOCK_SCALE==="1";
const profileGeometry=Bun.env.FPS_PROFILE_GEOMETRY==="1";
const softwareCompositor=Bun.env.FPS_SOFTWARE_COMPOSITOR==="1";
const angleBackend=Bun.env.FPS_ANGLE_BACKEND??"gl";
const captureActions=Bun.env.FPS_CAPTURE_ACTIONS==="1";
const recordLoops=Bun.env.FPS_RECORD_LOOPS==="1";
const fixedTravel=Bun.env.FPS_FIXED_TRAVEL==="1";
const travelTargets={city:{slow:10,medium:20},coast:{slow:15,medium:28},
  swamp:{slow:19,medium:36},indoors:{slow:2,medium:4}} satisfies Record<Scene,Record<"slow"|"medium",number>>;
const trials=Number(Bun.env.FPS_REPEATS??2);
const settleTimeout=Number(Bun.env.FPS_SETTLE_TIMEOUT_MS??100_000);
const game=Bun.env.TERRAIN_TEST_GAME_FOLDER;
const output=Bun.env.FPS_RESULTS??"";
if(!game||!output||!selected.length||selected.some(scene=>!Object.hasOwn(scenes,scene))||
  !actions.length||actions.some(mode=>!modes.includes(mode))||profileMode&&!actions.includes(profileMode)||onePixelRaster&&!profileMode||
  !["gl","vulkan"].includes(angleBackend)||
  !Number.isSafeInteger(trials)||trials<1||!Number.isSafeInteger(settleTimeout)||settleTimeout<2000)
  throw Error("Set TERRAIN_TEST_GAME_FOLDER and FPS_RESULTS, and select valid scenes, actions, repeats and settling timeout.");
const build=resolve(Bun.env.FPS_BUILD??join(import.meta.dir,"../dist"));
const revision=Bun.env.FPS_REVISION??Bun.spawnSync(["git","rev-parse","HEAD"],{cwd:join(import.meta.dir,"..")}).stdout.toString().trim();
assert(await Bun.file(join(build,"index.html")).exists(),"Build the benchmark revision first.");
await mkdir(output,{recursive:true});
const server=Bun.serve({hostname:"127.0.0.1",port:Number(Bun.env.FPS_PORT??4394),fetch(request){
  const path=new URL(request.url).pathname;
  const name=path.slice(1)||"index.html";
  if(!/^[\w-][\w.-]*$/.test(name))return new Response("Not found",{status:404});
  const file=Bun.file(join(build,name));
  return new Response(file,{headers:{"Content-Type":file.type,"Cache-Control":"no-cache"}});
}});
const viewport={width:1120,height:720,deviceScaleFactor:1,mobile:false};
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

type CastFrame={data:string;metadata:{timestamp?:number};sessionId:number};
class Browser {
  private serial=0;
  private connected="";
  private cast?:{time:number;data:string}[];
  readonly errors:string[]=[];
  private pending=new Map<number,{resolve:(result:any)=>void;reject:(error:Error)=>void}>();
  private chrome;
  private readonly commands:Writable;
  readonly exited;
  constructor(profile:string){
    this.chrome=spawn(Bun.env.TERRAIN_TEST_BROWSER??"brave",[
      "--headless","--remote-debugging-pipe","--no-first-run","--disable-background-networking","--disable-extensions",
      "--disable-dev-shm-usage","--use-gl=angle",`--use-angle=${angleBackend}`,
      ...(softwareCompositor?["--disable-gpu-compositing"]:[]),
      `--user-data-dir=${profile}`,"about:blank",
    ],{stdio:["ignore","ignore","inherit","pipe","pipe"]});
    const commands=this.chrome.stdio[3];
    if(!commands||!("write" in commands))throw Error("Brave did not open its debugging command pipe.");
    this.commands=commands;
    this.exited=once(this.chrome,"exit").catch(()=>[]);
    const disconnect=(error:Error)=>{
      for(const {reject} of this.pending.values())reject(error);
      this.pending.clear();
    };
    this.chrome.on("error",disconnect);
    this.chrome.on("exit",()=>disconnect(new Error("Brave exited during benchmark.")));
    let buffer="";
    this.chrome.stdio[4]!.on("data",chunk=>{
      buffer+=chunk.toString();
      for(let at;(at=buffer.indexOf("\0"))>=0;){
        const message=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
        if(message.method==="Runtime.exceptionThrown")this.errors.push(message.params.exceptionDetails.text);
        if(message.method==="Page.screencastFrame"){
          const frame:CastFrame=message.params;
          this.cast?.push({data:frame.data,time:frame.metadata.timestamp??Date.now()/1000});
          void this.call("Page.screencastFrameAck",{sessionId:frame.sessionId}).catch(()=>{});
        }
        const pending=this.pending.get(message.id);
        if(!pending)continue;
        this.pending.delete(message.id);
        if(message.error)pending.reject(Error(message.error.message));
        else pending.resolve(message.result);
      }
    });
  }
  call(method:string,params:object={},root=false):Promise<any>{
    const id=++this.serial;
    return new Promise((resolve,reject)=>{
      this.pending.set(id,{resolve,reject});
      this.commands.write(JSON.stringify({id,method,params,...(!root&&this.connected?{sessionId:this.connected}:{})})+"\0");
    });
  }
  async eval<T>(expression:string):Promise<T>{
    const result=await this.call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);
    return result.result.value;
  }
  async wait<T>(expression:string,timeout=30_000):Promise<T>{
    const until=performance.now()+timeout;
    while(performance.now()<until){
      const value=await this.eval<T>(expression);
      if(value)return value;
      await delay(100);
    }
    throw Error(`Timed out waiting for ${expression}`);
  }
  async open(){
    const {targetInfos}=await this.call("Target.getTargets",{},true);
    const target=targetInfos.find((item:{type:string})=>item.type==="page")??
      await this.call("Target.createTarget",{url:"about:blank"},true);
    this.connected=(await this.call("Target.attachToTarget",{targetId:target.targetId,flatten:true},true)).sessionId;
    await this.call("Page.enable");
    await this.call("Runtime.enable");
    await this.call("Emulation.setDeviceMetricsOverride",viewport);
    await this.call("Page.addScriptToEvaluateOnNewDocument",{source:
      `(${observePage.toString()})(${Boolean(profileMode)},${onePixelRaster},${lockRenderScale},${profileGeometry})`});
    await this.call("Page.navigate",{url:server.url.href});
    await this.wait("document.readyState==='complete'");
    if(Bun.env.FPS_VERIFY_CHART==="1"){
      assert(await this.eval(`document.querySelector("#street-show-fps").checked&&!document.querySelector("#street-fps").hidden`));
      await this.eval(`document.querySelector(".street-settings").open=true;document.querySelector("#street-show-fps").click()`);
      assert(await this.eval(`document.querySelector("#street-fps").hidden`));
      await this.call("Page.reload");
      await this.wait("document.querySelector('#street-fps')?.hidden&&document.readyState==='complete'");
      assert(await this.eval(`!document.querySelector("#street-show-fps").checked`));
      await this.eval(`document.querySelector("#street-show-fps").click()`);
      assert(await this.eval(`!document.querySelector("#street-fps").hidden`));
    }
    const {result:{objectId}}=await this.call("Runtime.evaluate",{expression:"document.querySelector('#folder')"});
    await this.call("DOM.setFileInputFiles",{objectId,files:[game]});
    await this.wait("document.querySelector('#import-stats').textContent.includes('Imported')",90_000);
  }
  async enter(){
    await this.eval(`document.querySelector("#cell-search").value="-19,-6";
      document.querySelector("#go-to-cell").requestSubmit();document.querySelector("#walk-here").click()`);
    const marker=await this.eval<[number,number]>(`(()=>{const m=document.querySelector("#walk-preview");return [parseFloat(m.style.left),parseFloat(m.style.top)];})()`);
    for(const [dx,dy] of [[20,5],[0,0],[30,-8],[10,10],[-20,20]]){
      const x=Math.round(marker[0]+dx),y=Math.round(marker[1]+dy);
      await this.call("Input.dispatchMouseEvent",{type:"mouseMoved",x,y});
      await delay(550);
      if(!await this.wait('["ready","flight"].includes(document.querySelector("#walk-preview").dataset.state)',3000).catch(()=>false))continue;
      for(const type of ["mousePressed","mouseReleased"])
        await this.call("Input.dispatchMouseEvent",{type,x,y,button:"left",clickCount:1});
      break;
    }
    await this.wait('document.querySelector("#street-view").open&&!document.querySelector("#street-go-to").disabled');
    await this.eval('if(document.querySelector("#street-controls")?.open)document.querySelector("#street-controls-close").click()');
  }
  async key(code:"ArrowRight"|"KeyW"|"Space",down:boolean){
    const [key,vk]={ArrowRight:["ArrowRight",39],KeyW:["w",87],Space:[" ",32]}[code];
    await this.call("Input.dispatchKeyEvent",{type:down?"keyDown":"keyUp",key,code,windowsVirtualKeyCode:vk});
  }
  async capture(name:string){
    const {data}=await this.call("Page.captureScreenshot",{format:"png"});
    await writeFile(join(output!,name+".png"),Buffer.from(data,"base64"));
  }
  async recordLoop(scene:Scene){
    const rect=await this.eval<{x:number;y:number;width:number;height:number}>(
      'document.querySelector("#street-canvas").getBoundingClientRect().toJSON()');
    const frames:{time:number;data:string}[]=[];
    this.cast=frames;
    await this.call("Page.startScreencast",{format:"jpeg",quality:90,everyNthFrame:1});
    try{
      await this.eval("window.fpsBenchmark.forceRedraw?.()");
      await delay(150);
      await turn360(this);
    }finally{
      await this.call("Page.stopScreencast");
      this.cast=undefined;
    }
    assert(frames.length>12,`Only ${frames.length} frames recorded for ${scene}`);
    const temporary=await mkdtemp(join(output!,`.${scene}-`));
    try{
      const sequence=["ffconcat version 1.0"];
      for(let i=0;i<frames.length;i++){
        const name=`${i}.jpg`;
        await writeFile(join(temporary,name),Buffer.from(frames[i].data,"base64"));
        sequence.push(`file '${name}'`);
        if(i+1<frames.length)sequence.push(`duration ${Math.max(.001,frames[i+1].time-frames[i].time).toFixed(6)}`);
      }
      await writeFile(join(temporary,"frames.ffconcat"),sequence.join("\n")+"\n");
      const crop=[Math.floor(rect.width/2)*2,Math.floor(rect.height/2)*2,Math.round(rect.x),Math.round(rect.y)].join(":");
      const encoding=Bun.spawnSync(["ffmpeg","-hide_banner","-loglevel","error","-f","concat","-i","frames.ffconcat",
        "-vf",`crop=${crop},fps=30`,"-an","-c:v","libx264","-pix_fmt","yuv420p","-crf","20","-movflags","+faststart","clip.mp4"],
      {cwd:temporary,stderr:"pipe"});
      if(encoding.exitCode!==0)throw Error(encoding.stderr.toString());
      await rename(join(temporary,"clip.mp4"),join(output!,scene+".mp4"));
    }finally{await rm(temporary,{recursive:true,force:true});}
  }
  async close(){
    void this.call("Browser.close",{},true).catch(()=>{});
    const timer=setTimeout(()=>this.chrome.kill(),5000);
    await this.exited;
    clearTimeout(timer);
  }
}

function observePage(profile:boolean,onePixel:boolean,lockScale:boolean,geometry:boolean){
  let frame:number|undefined;
  type Frame={t:number;w:number;h:number;full:boolean;cpuMs?:number;gpuMs?:number;attributePointers?:number;
    instancedDraws?:number;instancedIndices?:number;offscreenInstancedIndices?:number};
  type Region={point:number[];serial:number};
  type CompletedRegion={serial:number;chunks:number;radius?:number;horizon?:number};
  const observed={
    frames:[] as Frame[], regions:[] as Region[], completed:[] as CompletedRegion[], lastActivity:0,
    contexts:new Set<WebGL2RenderingContext>(), indexes:0, contextLost:false, forceRedraw:undefined as (()=>void)|undefined,
    activity:{} as Record<string,{count:number;last:number}>, regionError:undefined as string|undefined,
    textureReplies:new Map<string,{ok:number;missing:number}>(),
    workerTimeline:[] as {time:number;kind:string}[],
  };
  const offscreen=new WeakSet<WebGL2RenderingContext>();
  const labels=new WeakMap<WebGLVertexArrayObject,string>();
  const arrays=new WeakMap<WebGL2RenderingContext,WebGLVertexArrayObject|null>();
  const submissions=new Map<number,Map<string,{indices:number;draws:number}>>();
  if(geometry){
    const proto=WebGL2RenderingContext.prototype;
    const bind=proto.bindVertexArray,draw=proto.drawElementsInstanced;
    proto.bindVertexArray=function(vao){
      arrays.set(this,vao);
      return bind.call(this,vao);
    };
    proto.drawElementsInstanced=function(...args){
      const vao=arrays.get(this);
      if(vao&&frame!==undefined){
        const label=labels.get(vao)??"unlabeled";
        const key=(offscreen.has(this)?"offscreen":"canvas")+" / "+label;
        let tally=submissions.get(frame);
        if(!tally){tally=new Map();submissions.set(frame,tally);}
        const entry=tally.get(key);
        const indices=args[1]*args[4];
        if(entry){entry.indices+=indices;entry.draws++;}
        else tally.set(key,{indices,draws:1});
      }
      return draw.apply(this,args);
    };
    Object.assign(observed,{labelGeometry:(vao:WebGLVertexArrayObject,label:string)=>labels.set(vao,label),
      geometryBetween(start:number,end:number){
        const totals=new Map<string,{indices:number;draws:number}>();
        for(const [time,tally] of submissions){
          if(time<start||time>=end)continue;
          for(const [key,entry] of tally){
            const prior=totals.get(key);
            if(prior){prior.indices+=entry.indices;prior.draws+=entry.draws;}
            else totals.set(key,{...entry});
          }
        }
        return [...totals].sort((a,b)=>b[1].indices-a[1].indices);
      }});
  }
  Object.assign(window,{fpsBenchmark:observed});
  const raf=window.requestAnimationFrame;
  window.requestAnimationFrame=callback=>raf(time=>{
    const previous=frame;
    frame=time;
    const start=profile?performance.now():0,last=observed.frames.at(-1);
    try{callback(time);}finally{
      const drawn=observed.frames.at(-1);
      if(profile&&drawn&&drawn!==last)drawn.cpuMs=performance.now()-start;
      frame=previous;
    }
  });
  if(profile){
    const proto=WebGL2RenderingContext.prototype;
    const attributePointer=proto.vertexAttribPointer,drawInstanced=proto.drawElementsInstanced;
    proto.vertexAttribPointer=function(...args){
      const current=observed.frames.at(-1);
      if(current&&current.t===frame&&this.canvas instanceof HTMLCanvasElement&&this.canvas.id==="street-canvas")
        current.attributePointers=(current.attributePointers??0)+1;
      return attributePointer.apply(this,args);
    };
    proto.drawElementsInstanced=function(...args){
      const current=observed.frames.at(-1);
      if(current&&current.t===frame&&this.canvas instanceof HTMLCanvasElement&&this.canvas.id==="street-canvas"){
        current.instancedDraws=(current.instancedDraws??0)+1;
        const indices=args[1]*args[4];
        current.instancedIndices=(current.instancedIndices??0)+indices;
        current.offscreenInstancedIndices=(current.offscreenInstancedIndices??0)+(offscreen.has(this)?indices:0);
      }
      return drawInstanced.apply(this,args);
    };
  }
  if(profile||lockScale){
    const proto=WebGL2RenderingContext.prototype;
    const begin=proto.beginQuery,result=proto.getQueryParameter;
    const queries=new WeakMap<WebGLQuery,number>();
    proto.beginQuery=function(target,query){
      // EXT_disjoint_timer_query_webgl2 TIME_ELAPSED_EXT. Observe the viewer's
      // own asynchronous measurements without introducing a second GPU query.
      if(target===0x88bf&&frame!==undefined&&this.canvas instanceof HTMLCanvasElement&&this.canvas.id==="street-canvas")
        queries.set(query,frame);
      return begin.call(this,target,query);
    };
    proto.getQueryParameter=function(query,pname){
      const value=result.call(this,query,pname);
      const time=queries.get(query);
      if(pname===this.QUERY_RESULT&&time!==undefined&&typeof value==="number"){
        const drawn=observed.frames.findLast(sample=>sample.t===time);
        if(profile&&drawn)drawn.gpuMs=value/1e6;
        // Keep the native drawing buffer without losing diagnostic timing.
        if(lockScale)return 0;
      }
      return value;
    };
  }
  function submitted(gl:WebGL2RenderingContext,full:boolean){
    if(frame===undefined||offscreen.has(gl)||!(gl.canvas instanceof HTMLCanvasElement)||gl.canvas.id!=="street-canvas")return;
    observed.contexts.add(gl);
    const last=observed.frames.at(-1);
    if(last?.t===frame){last.full||=full;return;}
    observed.frames.push({t:frame,w:gl.canvas.width,h:gl.canvas.height,full});
  }
  const bindFramebuffer=WebGL2RenderingContext.prototype.bindFramebuffer;
  function scissorCanvas(gl:WebGL2RenderingContext){
    if(!onePixel||!(gl.canvas instanceof HTMLCanvasElement)||gl.canvas.id!=="street-canvas")return;
    if(offscreen.has(gl))gl.disable(gl.SCISSOR_TEST);
    else{gl.scissor(0,0,1,1);gl.enable(gl.SCISSOR_TEST);}
  }
  WebGL2RenderingContext.prototype.bindFramebuffer=function(target,buffer){
    bindFramebuffer.call(this,target,buffer);
    if(target===this.FRAMEBUFFER||target===this.DRAW_FRAMEBUFFER){
      if(buffer)offscreen.add(this);else offscreen.delete(this);
      scissorCanvas(this);
    }
  };
  const clear=WebGL2RenderingContext.prototype.clear;
  WebGL2RenderingContext.prototype.clear=function(mask){
    if(mask&this.COLOR_BUFFER_BIT)submitted(this,true);
    clear.call(this,mask);
    if(mask&this.COLOR_BUFFER_BIT&&!offscreen.has(this))scissorCanvas(this);
  };
  const drawArrays=WebGL2RenderingContext.prototype.drawArrays;
  WebGL2RenderingContext.prototype.drawArrays=function(mode,first,count){submitted(this,false);return drawArrays.call(this,mode,first,count);};
  const blit=WebGL2RenderingContext.prototype.blitFramebuffer;
  WebGL2RenderingContext.prototype.blitFramebuffer=function(...args){submitted(this,false);return blit.apply(this,args);};
  const NativeResizeObserver=window.ResizeObserver;
  window.ResizeObserver=class extends NativeResizeObserver{
    constructor(callback:ResizeObserverCallback){
      super((entries,observer)=>{
        if(entries.some(entry=>entry.target.id==="street-canvas"))observed.forceRedraw=()=>callback(entries,observer);
        callback(entries,observer);
      });
    }
  };
  document.addEventListener("webglcontextlost",()=>{observed.contextLost=true;},true);
  const post=Worker.prototype.postMessage;
  Worker.prototype.postMessage=function(data:any,...args:any[]){
    if(data.kind==="streetRegion"){
      observed.regions.push({point:data.point,serial:data.serial});
      observed.lastActivity=performance.now();
      observed.regionError=undefined;
    }
    return Reflect.apply(post,this,[data,...args]);
  };
  const NativeWorker=window.Worker;
  window.Worker=class extends NativeWorker{
    constructor(...args:ConstructorParameters<typeof Worker>){
      super(...args);
      this.addEventListener("message",({data})=>{
        if(data.kind==="streetRegion"){
          observed.completed.push({serial:data.serial,chunks:data.wanted.length,radius:data.nativeRadius,horizon:data.nativeHorizon});
          if(data.serial===observed.regions.at(-1)?.serial)observed.regionError=data.error;
        }
        if(data.kind==="streetIndex")observed.indexes++;
        if(data.kind==="streetTexture"){
          const key=`${data.epoch}:${data.ground}:${data.id}`;
          const replies=observed.textureReplies.get(key)??{ok:0,missing:0};
          if(data.image||data.compressed||data.cube||data.roadHeight)replies.ok++;
          else replies.missing++;
          observed.textureReplies.set(key,replies);
        }
        if(["streetRegion","streetRegionBatch","streetTexture","streetVegetation","streetInteriors","streetEnvironment"]
          .includes(data.kind)){
          const previous=observed.activity[data.kind];
          observed.lastActivity=performance.now();
          observed.activity[data.kind]={count:(previous?.count??0)+1,last:observed.lastActivity};
          if(profile)observed.workerTimeline.push({time:observed.lastActivity,kind:data.kind});
        }
      });
    }
  };
}

const position=String.raw`(()=>Array.from(document.querySelector("#street-status").textContent.matchAll(/[XYZ] (-?[\d.]+)/g),m=>Number(m[1])))()`;
const heading=String.raw`Number(document.querySelector("#street-bearing").textContent.match(/(\d+)°/)?.[1])`;
const status=`document.querySelector("#street-status").textContent`;
const startPose=`(()=>{const b=window.fpsBenchmark,serial=b.regions.at(-1)?.serial;return {
  heading:${heading},status:${status},regions:b.completed.filter(region=>region.serial===serial),
};})()`;
async function locate(browser:Browser,scene:Scene){
  const pose=scenes[scene];
  const previousFrame=await browser.eval<number>(`(()=>{
    const time=window.fpsBenchmark.frames.at(-1)?.t??-1;
    document.querySelector("#street-xyz").value=${JSON.stringify(pose.join(","))};
    document.querySelector("#street-destination").requestSubmit();
    return time;
  })()`);
  await browser.wait(`(()=>{const p=${position},bearing=${heading};
    return window.fpsBenchmark.frames.at(-1)?.t>${previousFrame}&&p.length===3&&
      Math.hypot(p[0]-(${pose[0]}),p[1]-(${pose[1]}),p[2]-(${pose[2]}))<.15&&
      Math.abs((bearing-(${pose[3]})+540)%360-180)<1.1;
  })()`);
  const settled=await browser.wait<string>(`(()=>{const b=window.fpsBenchmark;
    if(b.regionError)return b.regionError;
    if(!b.completed.some(region=>region.serial===b.regions.at(-1)?.serial)||performance.now()-b.lastActivity<2000)return false;
    if(Number(${status}.match(/([0-9]+) visible chunks/)?.[1]??0)<${minimumVisibleChunks[scene]})return false;
    return "settled";})()`,settleTimeout)
    .catch(async(error:Error)=>{
      const diagnostic=await browser.eval(`(()=>{const b=window.fpsBenchmark;return {
        regions:b.regions.slice(-8),completed:b.completed.slice(-8),activity:b.activity,now:performance.now(),
        status:document.querySelector("#street-status")?.textContent,loading:document.querySelector("#load-overlay:not([hidden])")?.innerText,
        uniqueTextures:b.textureReplies.size,repeatedTextures:[...b.textureReplies].filter(([,r])=>r.ok+r.missing>1)
          .sort(([,a],[,b])=>b.ok+b.missing-a.ok-a.missing).slice(0,10),
      };})()`);
      throw Error(`${scene} did not settle. ${JSON.stringify(diagnostic)}`,{cause:error});
    });
  assert.equal(settled,"settled",`${scene} geometry failed to load`);
}

async function turn360(browser:Browser){
  await browser.key("ArrowRight",true);
  try{
    return await browser.eval<number>(`new Promise((resolve,reject)=>{
      const began=performance.now();let previous=${heading},total=0;
      function tick(){
        const current=${heading};
        if(Number.isFinite(current)&&Number.isFinite(previous))total+=((current-previous+540)%360)-180;
        previous=current;
        if(Math.abs(total)>=360){resolve(Math.abs(total));return;}
        if(performance.now()-began>30000){reject(Error("Incomplete 360-degree sweep"));return;}
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    })`);
  }finally{await browser.key("ArrowRight",false);}
}

type Submitted={t:number;w:number;h:number;full:boolean;cpuMs?:number;gpuMs?:number;attributePointers?:number;
  instancedDraws?:number;instancedIndices?:number;offscreenInstancedIndices?:number};
function summarize(frames:Submitted[],elapsed:number){
  const interval=frames.slice(1).map((frame,index)=>frame.t-frames[index].t).sort((a,b)=>a-b);
  const quantile=(sorted:number[],p:number)=>sorted.length?Number(sorted[Math.ceil(sorted.length*p)-1].toFixed(2)):null;
  const bySize=new Map<string,{frames:number;intervals:number[]}>();
  for(let i=0;i<frames.length;i++){
    const {w,h,t}=frames[i],size=`${w}×${h}`;
    let group=bySize.get(size);
    if(!group){group={frames:0,intervals:[]};bySize.set(size,group);}
    group.frames++;
    const previous=frames[i-1];
    if(previous?.w===w&&previous.h===h)group.intervals.push(t-previous.t);
  }
  const perSize=[...bySize].map(([size,group])=>({size,frames:group.frames,intervalCount:group.intervals.length,
    p95Ms:quantile(group.intervals.sort((a,b)=>a-b),.95)}));
  const timing=(key:"cpuMs"|"gpuMs"|"attributePointers"|"instancedDraws"|"instancedIndices"|"offscreenInstancedIndices")=>{
    const samples=frames.flatMap(frame=>frame[key]===undefined?[]:[frame[key]]).sort((a,b)=>a-b);
    return samples.length?{count:samples.length,median:Number(samples[Math.ceil(samples.length/2)-1].toFixed(2)),
      p95:Number(samples[Math.ceil(samples.length*.95)-1].toFixed(2))}:undefined;
  };
  return {frames:frames.length,elapsed:Math.round(elapsed),fps:Number((frames.length*1000/elapsed).toFixed(2)),
    medianMs:quantile(interval,.5),p95Ms:quantile(interval,.95),maxMs:quantile(interval,1),over33Ms:interval.filter(ms=>ms>1000/30+.25).length,
    sizes:[...bySize.keys()],perSize,fullFrames:frames.filter(frame=>frame.full).length,intervals:interval,
    cpuTiming:timing("cpuMs"),gpuTiming:timing("gpuMs"),
    attributePointers:timing("attributePointers"),instancedDraws:timing("instancedDraws"),instancedIndices:timing("instancedIndices"),
    offscreenInstancedIndices:timing("offscreenInstancedIndices")};
}

async function run(browser:Browser,scene:Scene,trial:number,mode:Mode){
  await locate(browser,scene);
  if(mode==="slow"||mode==="medium"){
    await browser.eval(`(()=>{
      const canvas=document.querySelector("#street-canvas");
      const current=Number(document.querySelector("#street-status").textContent.match(/Flight speed ([\\d.]+)/)?.[1]);
      if(!current)throw Error("FPS benchmark requires flight mode");
      for(let i=0;i<3;i++)canvas.dispatchEvent(new WheelEvent("wheel",{deltaY:400,cancelable:true}));
      if(${mode==="medium"})canvas.dispatchEvent(new WheelEvent("wheel",{deltaY:-300,cancelable:true}));
    })()`);
    await delay(200);
  }
  const from=await browser.eval<number[]>(position);
  const initialPose=await browser.eval<{heading:number;status:string}>(startPose);
  if(mode===profileMode){
    await browser.call("Profiler.enable");
    await browser.call("Profiler.setSamplingInterval",{interval:2000});
    await browser.call("Profiler.start");
  }
  const workerSnapshot=`({time:performance.now(),timeOrigin:performance.timeOrigin,messages:Object.fromEntries(
    Object.entries(window.fpsBenchmark.activity).map(([kind,activity])=>[kind,activity.count]))})`;
  const {time:start,timeOrigin,messages:before}=await browser.eval<{
    time:number;timeOrigin:number;messages:Record<string,number>
  }>(workerSnapshot);
  let degrees:number|undefined;
  const distanceTarget=fixedTravel&&(mode==="slow"||mode==="medium")?travelTargets[scene][mode]:undefined;
  if(mode==="turn"){
    degrees=await turn360(browser);
  }else if(mode==="slow"||mode==="medium"){
    await browser.key("KeyW",true);
    try{
      if(distanceTarget===undefined)await delay(scene==="indoors"?650:5000);
      else await browser.eval(`new Promise((resolve,reject)=>{
        const began=performance.now(),from=${JSON.stringify(from)};
        const release=()=>document.querySelector("#street-canvas").dispatchEvent(
          new KeyboardEvent("keyup",{code:"KeyW",key:"w",bubbles:true}));
        function tick(now){
          const current=${position};
          if(current.length===3&&Math.hypot(current[0]-from[0],current[1]-from[1])>=${distanceTarget}){
            release();resolve(null);return;
          }
          if(now-began>=40000){release();reject(Error("Forward route timed out"));return;}
          requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      })`);
    }finally{await browser.key("KeyW",false);}
  }else if(mode==="idle-redraw"){
    await browser.eval(`new Promise(resolve=>{
      const b=window.fpsBenchmark,until=performance.now()+5000;
      if(!b.forceRedraw)throw Error("Resize callback was not recorded");
      function tick(now){
        if(now>=until){resolve(null);return;}
        b.forceRedraw();requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    })`);
  }else await delay(5000);
  const {time:end,messages:after}=await browser.eval<{time:number;messages:Record<string,number>}>(workerSnapshot);
  const workerMessages=Object.fromEntries(Object.entries(after).map(([kind,count])=>[kind,count-(before[kind]??0)]));
  if(mode===profileMode){
    const {profile}=await browser.call("Profiler.stop");
    await writeFile(join(output,`${scene}-${trial}-${mode}.cpuprofile`),JSON.stringify(profile));
    await browser.call("Profiler.disable");
  }
  await delay(120);
  const to=await browser.eval<number[]>(position);
  const distance=Math.hypot(...to.map((value,index)=>value-from[index]));
  if(mode==="slow"||mode==="medium")assert(distance>.5,"Forward input did not move the camera.");
  if(distanceTarget!==undefined)assert(Math.abs(distance-distanceTarget)<1,
    `Fixed route ended at ${distance.toFixed(2)} m, expected ${distanceTarget} m.`);
  const frames=await browser.eval<Submitted[]>(`window.fpsBenchmark.frames.filter(frame=>frame.t>=${start}&&frame.t<${end})`);
  if(mode===profileMode){
    const workerTimeline=await browser.eval<{time:number;kind:string}[]>(
      `window.fpsBenchmark.workerTimeline.filter(event=>event.time>=${start}&&event.time<${end})`);
    await writeFile(join(output,`${scene}-${trial}-${mode}-timeline.json`),JSON.stringify({frames,workerTimeline},null,2));
  }
  if(profileGeometry){
    const geometry=await browser.eval<[string,{indices:number;draws:number}][]>(
      `window.fpsBenchmark.geometryBetween(${start},${end})`);
    assert(geometry.some(([key])=>!key.endsWith("/ unlabeled")),"The geometry profiling build did not supply asset labels");
    await writeFile(join(output,`${scene}-${trial}-${mode}-geometry.json`),JSON.stringify({frames:frames.length,geometry},null,2));
  }
  const endPose=await browser.eval<{heading:number;status:string}>(`({heading:${heading},status:${status}})`);
  const capture=captureActions?`${scene}-${trial}-${mode}`:undefined;
  if(capture)await browser.capture(capture);
  return {mode,...summarize(frames,end-start),startedAt:new Date(timeOrigin+start).toISOString(),
    degrees,from,to,distance,distanceTarget,startPose:initialPose,endPose,workerMessages,capture};
}

type Result={scene:Scene;trial:number;hardware:unknown;samples:Awaited<ReturnType<typeof run>>[]};
const results:Result[]=[];
const failures:{scene:Scene;message:string}[]=[];
const saveReport=()=>writeFile(join(output,"report.json"),JSON.stringify({revision,scenes,viewport,trials,actions,profileMode,
  angleBackend,onePixelRaster,profileGeometry,lockRenderScale,minimumVisibleChunks,results,failures},null,2));
try{
  for(const scene of selected){
    const profile=await mkdtemp(join(tmpdir(),"terrain-atlas-benchmark-"));
    const browser=new Browser(profile);
    try{
      await browser.open();
      await browser.enter();
      const activeRenderer=await browser.wait<string>(`(()=>{
        const [gl]=window.fpsBenchmark.contexts;
        if(!gl)return false;
        const debug=gl.getExtension("WEBGL_debug_renderer_info");
        return debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):"Renderer unavailable";
      })()`);
      const expected=Bun.env.FPS_EXPECT_GPU;
      if(expected)assert(activeRenderer.toLowerCase().includes(expected.toLowerCase()),
        `Expected the FPS canvas to use ${expected}, but Brave reported ${activeRenderer}`);
      console.log(JSON.stringify({scene,renderer:activeRenderer}));
      await browser.eval(`document.querySelector("#street-time").value="870";
        document.querySelector("#street-cloud-cover").value="35";
        document.querySelector("#street-lighting").click();
        document.querySelector("#street-canvas").focus();`);
      await locate(browser,scene);
      if(!await browser.eval<boolean>(`document.querySelector("#street-status").textContent.includes("Flight speed")`)){
        for(let press=0;press<2;press++){
          await browser.key("Space",true);await browser.key("Space",false);await delay(80);
        }
        await locate(browser,scene);
      }
      const {gpu}=await browser.call("SystemInfo.getInfo",{},true);
      const webglExtensions=await browser.eval<string[]>(
        "([...window.fpsBenchmark.contexts][0]?.getSupportedExtensions() ?? [])");
      const hardware={devices:gpu.devices,renderer:activeRenderer,compositor:gpu.featureStatus?.gpu_compositing,webglExtensions};
      console.log(JSON.stringify({scene,compositor:hardware.compositor}));
      await browser.capture(scene);
      if(recordLoops){
        await browser.recordLoop(scene);
        console.log(`Recorded ${scene}.mp4`);
        continue;
      }
      for(let trial=1;trial<=trials;trial++){
        const samples:Result["samples"]=[];
        for(const mode of actions){
          const sample=await run(browser,scene,trial,mode);
          if(lockRenderScale)assert(sample.sizes.every(size=>size==="1120×477"),
            `Locked-scale run changed the drawing buffer: ${sample.sizes.join(", ")}`);
          samples.push(sample);
          console.log(JSON.stringify({scene,trial,...sample,intervals:undefined}));
        }
        assert.equal(browser.errors.length,0,"Browser reported exceptions");
        assert(await browser.eval(`(()=>{const b=window.fpsBenchmark;
          return !b.contextLost&&!b.indexes&&[...b.contexts].every(gl=>gl.getError()===0);})()`),
        "WebGL error, context loss, or saved-index activity.");
        results.push({scene,trial,hardware,samples});
        await saveReport();
      }
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      failures.push({scene,message});
      console.error(`${scene}: ${message}`);
      await saveReport();
    }finally{
      await browser.close();
      await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:100});
    }
  }
}finally{server.stop(true);}
if(failures.length)process.exitCode=1;

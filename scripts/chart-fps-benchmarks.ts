import {dirname,join} from "node:path";
import {mkdir} from "node:fs/promises";

const [output,...inputs]=process.argv.slice(2);
if(!output||!inputs.length)throw Error("Pass an output HTML path followed by benchmark report JSON paths, oldest first.");
type Measurement={mode:string;fps:number;p95Ms:number|null;sizes:string[];distanceTarget?:number};
type Report={revision:string;scenes:Record<string,number[]>;viewport:{width:number;height:number};
  profileMode?:string;onePixelRaster?:boolean;profileGeometry?:boolean;lockRenderScale?:boolean;
  minimumVisibleChunks?:Record<string,number>;
  results:{scene:string;trial:number;hardware?:{renderer?:string;compositor?:string};samples:Measurement[]}[];
  failures?:{scene:string;message:string}[]};
const reports:Report[]=await Promise.all(inputs.map(file=>Bun.file(file).json()));
if(reports.some(report=>report.profileMode||report.onePixelRaster||report.profileGeometry))
  throw Error("Use unprofiled results for the benchmark chart.");
const escape=(value:unknown)=>String(value).replace(/[&<>"']/g,character=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character]!);
const median=(values:number[])=>{
  const sorted=values.slice().sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
};
const actions={"idle":"Idle · actual redraws","idle-redraw":"Idle · forced redraw","turn":"360° turn","slow":"Slow forward","medium":"Medium forward"};
const cards=[];
for(const scene of Object.keys(reports[0].scenes)){
  const modes=[];
  for(const [mode,label] of Object.entries(actions)){
    const rows=reports.flatMap(report=>{
      const groups=new Map<string,{renderer:string;compositor:string;samples:Measurement[]}>();
      for(const entry of report.results){
        if(entry.scene!==scene)continue;
        const sample=entry.samples.find(sample=>sample.mode===mode);
        if(!sample)continue;
        const renderer=entry.hardware?.renderer??"Unknown GPU";
        // Reports before compositor metadata all forced software compositing.
        const compositor=entry.hardware?.compositor??"disabled_software";
        const key=`${renderer}\n${compositor}\n${sample.distanceTarget??""}`;
        const group=groups.get(key);
        if(group)group.samples.push(sample);else groups.set(key,{renderer,compositor,samples:[sample]});
      }
      return [...groups.values()].map(({renderer,compositor,samples})=>{
        const fps=median(samples.map(sample=>sample.fps));
        const intervals=samples.flatMap(sample=>sample.p95Ms===null?[]:[sample.p95Ms]);
        const p95=intervals.length?`${median(intervals).toFixed(1)} ms p95`:"No frame interval";
        const value=mode==="idle"&&samples.every(sample=>!sample.fps)?"On demand":`${fps.toFixed(1)} FPS`;
        const resolution=[...new Set(samples.flatMap(sample=>sample.sizes))].join(", ");
        const gpu=renderer.match(/\b(?:NVIDIA\s+)?GeForce [^(,/]+/)?.[0]?.trim()??
          renderer.match(/ANGLE \([^,]+, ([^(,]+?)(?:\s*\(|,)/)?.[1]??renderer;
        const backend=renderer.includes("Vulkan")?" · Vulkan":renderer.includes("OpenGL")?" · OpenGL":"";
        const composition=compositor==="enabled"?"Hardware compositing":
          compositor.endsWith("_software")?"Software compositing":`Compositing ${compositor}`;
        const renderScale=report.lockRenderScale?"Fixed resolution":"Adaptive resolution";
        const route=samples[0].distanceTarget;
        const motion=mode==="slow"||mode==="medium"
          ?` · ${route===undefined?"Timed input":`${route} m route`}`:"";
        const coverage=report.minimumVisibleChunks?.[scene]?"Coverage checked":"Coverage unverified at start";
        return `<div class="row"><div><code>${escape(report.revision)}</code><small title="${escape(renderer)}">${escape(gpu+backend)}</small><small>${escape(composition)} · ${renderScale}</small></div>
          <div class="track" aria-hidden="true"><b style="width:${Math.min(100,100*fps/60)}%"></b></div>
          <span>${escape(value)} · ${p95}<small>${samples.length} runs${resolution?` · ${escape(resolution)}`:""}${escape(motion)}</small><small>${coverage}</small></span></div>`;
      });
    });
    if(rows.length)modes.push(`<h3>${label}</h3>${rows.join("")}`);
  }
  const failures=reports.flatMap(report=>(report.failures??[]).filter(failure=>failure.scene===scene)
    .map(({message})=>`<details><summary>${escape(report.revision.slice(0,7))} · Incomplete run</summary><p>${escape(message)}</p></details>`));
  const pose=reports[0].scenes[scene];
  const loop=/^[a-z-]+$/.test(scene)&&await Bun.file(join(dirname(output),"scene-loops",scene+".mp4")).exists()
    ?`<video controls loop muted playsinline preload="metadata" aria-label="${escape(scene)} scene turn">
        <source src="scene-loops/${scene}.mp4" type="video/mp4">
        <a href="scene-loops/${scene}.mp4">Download MP4</a>
      </video>`:"";
  const coordinates=`<p class="pose"><span>Go to XYZ · X, Y, Z, heading°, pitch°, vertical FOV°</span><code>${escape(pose.join(", "))}</code></p>`;
  if(modes.length||failures.length||loop)cards.push(`<section><h2>${escape(scene)}</h2>${coordinates}${loop}${modes.join("")}${failures.join("")}</section>`);
}
await mkdir(dirname(output),{recursive:true});
await Bun.write(output,`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Leonida Unfolded FPS benchmarks</title><style>
*{box-sizing:border-box}body{background:#171320;color:#f5ebf8;font:15px system-ui,sans-serif;margin:2rem auto;max-width:1050px;padding:0 1rem}
h1,h2{margin:.2rem 0 1rem}p,small{color:#cfbfd7}section{background:#261c30;border:1px solid #564460;border-radius:12px;margin:1rem 0;padding:1.15rem}
h2{text-transform:capitalize}h3{font-size:.95rem;margin:1rem 0 .4rem}.row{display:grid;grid-template-columns:minmax(6rem,11rem) minmax(48px,1fr) minmax(8rem,14rem);gap:.7rem;align-items:center;margin:.45rem 0}
.track{background:#422e4e;position:relative;height:.75rem;border-radius:3px}.track::after{content:"";position:absolute;left:50%;top:-.2rem;height:1.15rem;border-left:1px dashed #ffcf98}
b{background:#eeb4d7;display:block;height:100%;border-radius:3px}small{display:block}
.pose{display:grid;gap:.25rem;margin:.35rem 0 .9rem}.pose code{width:fit-content;user-select:all;color:#fff1f8;overflow-wrap:anywhere}
video{display:block;width:100%;max-width:800px;aspect-ratio:1120/476;background:#100d16;border-radius:8px}
</style><main><h1>Settled FPS benchmarks</h1><p>Medians across runs. The dashed line marks 30 FPS. Scene loops are recorded separately from timing.</p>${cards.join("")}</main></html>`);

import { mkdir, mkdtemp, copyFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const staticFiles=["index.html","styles.css","demo.html","demo.css","explorer.webp"];
const dist = resolve(Bun.env.TERRAIN_ATLAS_DIST??join(import.meta.dir,"../dist"));
const out = await mkdtemp(join(tmpdir(),"terrain-atlas-build-"));
try {
  const sourceFiles=await readdir(join(import.meta.dir,"../src"));
  const bundledProfiles=sourceFiles.filter(name=>
    /^profile\.json$|^street-.*-profile\.json(?:\.gz)?$|^street-vegetation-(?:locator\.bin|models\.json)$/.test(name));
  if(bundledProfiles.length)throw new Error(`Remove generated game profiles before building: ${bundledProfiles.join(", ")}`);
  const output = await Bun.build({
    entrypoints:["app","demo","worker","street-scan-worker","street-cloud-worker","street-ocean-worker"].map(name=>join(import.meta.dir,`../src/${name}.ts`)),
    target:"browser",format:"esm",outdir:out,splitting:true,minify:true,
    define:{"import.meta.hot":"undefined"},
    naming:{entry:"[name].js",chunk:"shared-[hash].js"},
  });
  if(!output.success)throw new Error(output.logs.map(log=>log.message).join("\n"));
  for(const name of staticFiles)await copyFile(join(import.meta.dir,"..",name),join(out,name));
  const sourceUrl=Bun.env.TERRAIN_ATLAS_SOURCE_URL;
  if(sourceUrl&&!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/tree\/[a-f\d]{40}$/.test(sourceUrl))
    throw new Error("Set TERRAIN_ATLAS_SOURCE_URL to the GitHub tree URL of the exact release commit.");
  if(sourceUrl)for(const name of ["index.html","demo.html"]){
    const html=await readFile(join(out,name),"utf8");
    await writeFile(join(out,name),html.replace('href="./SOURCE.txt"',`href="${sourceUrl}"`));
  }
  await writeFile(join(out,"SOURCE.txt"),sourceUrl
    ?`Corresponding source for this build:\n${sourceUrl}\n`
    :"Local build. The corresponding source is the checkout or exported tree used to build it. See README.md and docs/build.md.\n");

  const decoders=["night-decode.wasm","bcpack-decode.wasm"];
  for(const name of decoders)await copyFile(join(import.meta.dir,"../third-party",name),join(out,name));
  const bcdec=await readFile(join(import.meta.dir,"../third-party/bcdec.h"),"utf8");
  const marker=bcdec.lastIndexOf("ALTERNATIVE A - MIT License");
  const license=bcdec.slice(marker,bcdec.indexOf("ALTERNATIVE B - The Unlicense",marker));
  if(marker<0||!license.includes("Copyright"))throw new Error("BC decoder license was not found");
  const fflate=await readFile(join(import.meta.dir,"../node_modules/fflate/LICENSE"),"utf8");
  const stats=await readFile(join(import.meta.dir,"../node_modules/stats.js/LICENSE"),"utf8");
  const bcpack=await readFile(join(import.meta.dir,"../third-party/bcpack-wasm/NOTICES.txt"),"utf8");
  await writeFile(join(out,"THIRD-PARTY-NOTICES.txt"),`bcdec 026acf9\nhttps://github.com/iOrange/bcdec\n\n${license}\nfflate 0.8.3\nhttps://github.com/101arrowz/fflate\n\n${fflate}\nstats.js 0.17.0\nhttps://github.com/mrdoob/stats.js\n\n${stats}\n${bcpack}`);
  await writeFile(join(out,".nojekyll"),"");

  const expected=new Set(output.outputs.map(file=>file.path.split("/").at(-1)));
  for(const name of [...staticFiles,...decoders,"SOURCE.txt","THIRD-PARTY-NOTICES.txt",".nojekyll"])expected.add(name);
  const actual=await readdir(out);
  for(const name of actual){
    if(!expected.has(name))throw new Error(`Unexpected publish file ${name}. Build in a clean dist directory.`);
    const file=await readFile(join(out,name),"utf8");
    if(/\/home\/[^/]+\/|file:\/\/|\.torrent\b|magnet:\?/.test(file))
      throw new Error(`Private material found in ${name}`);
  }
  await mkdir(dist,{recursive:true});
  const previous=await readdir(dist);
  for(const name of previous) {
    if(!expected.has(name)&&!/^shared-[a-z0-9]+\.js$|^street-(?:base|hd|objects|nav|vegetation)--?\d+_-?\d+\.json$|^street-(?:base-index|hd-index|nav-index|objects-index|vegetation-index|vegetation-models)\.json$|^roof-placements\.json$/.test(name))
      throw new Error(`Unexpected existing file ${name} in dist`);
  }
  for(const name of actual) await copyFile(join(out,name),join(dist,name));
  for(const name of previous) if(!expected.has(name))await rm(join(dist,name));
  console.log(`Audited ${actual.length} files in dist`);
} finally {
  await rm(out,{recursive:true,force:true});
}

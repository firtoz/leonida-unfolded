import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const decoderPaths=new Map(["night-decode.wasm","bcpack-decode.wasm"]
  .map(name=>[name,resolve(import.meta.dirname,"third-party",name)]));
const sourceDir=resolve(import.meta.dirname,"src")+"/";

function viewerDevelopment():Plugin{
  return {
    name:"leonida-unfolded-development",
    apply:"serve",
    transformIndexHtml:{
      order:"pre",
      handler(html){
        return html.replace(/src="\.\/(app|demo)\.js"/g,'src="./src/$1.ts"')
          .replace("connect-src 'self';","connect-src 'self' ws://127.0.0.1:*;");
      },
    },
    configureServer(server){
      server.middlewares.use(async (request,response,next)=>{
        const pathname=(request.url??"").split("?")[0];
        const name=pathname.slice(1).replace(/^src\//,"");
        const decoderPath=decoderPaths.get(name);
        if(decoderPath){
          try{
            const bytes=await readFile(decoderPath);
            response.setHeader("Content-Type","application/wasm");
            response.setHeader("Cache-Control","no-store");
            response.end(bytes);
          }catch(error){next(error);}
          return;
        }
        next();
      });
    },
    handleHotUpdate({file,server}){
      const name=file.startsWith(sourceDir)?file.slice(sourceDir.length):"";
      if(/^street-/.test(name)&&!["street-view.ts","street-world.ts","street-destination.ts"].includes(name)){
        server.ws.send({type:"custom",event:"terrain:street-worker"});
        return [];
      }
      if(name==="worker.ts"||[...decoderPaths.values()].includes(file)){
        server.ws.send({type:"full-reload"});
        return [];
      }
    },
  };
}

export default defineConfig({
  plugins:[viewerDevelopment()],
  server:{host:"127.0.0.1"},
});

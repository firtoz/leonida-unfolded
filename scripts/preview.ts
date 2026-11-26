import { resolve } from "node:path";
const root=resolve(import.meta.dir,"../dist");
const port=Number(Bun.env.PORT??4394);
const server=Bun.serve({
  hostname:"127.0.0.1",port,
  async fetch(request){
    const url=new URL(request.url);
    const path=url.pathname.slice(1)||"index.html";
    if(!/^[\w.-]+$/.test(path)||path.startsWith("."))return new Response("Not found",{status:404});
    const file=Bun.file(resolve(root,path));
    if(!await file.exists())return new Response("Not found",{status:404});
    return new Response(file,{headers:{"Content-Type":path.endsWith(".wasm")?"application/wasm":file.type,
      "Cache-Control":"no-cache","X-Content-Type-Options":"nosniff"}});
  }
});
console.log(server.url.href);

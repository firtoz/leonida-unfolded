let session:SharedWorker|undefined;

function port(){
  if(session)return session.port;
  const key="terrain-atlas-dev-file-session";
  try{
    let name=sessionStorage.getItem(key);
    if(!name){name=crypto.randomUUID();sessionStorage.setItem(key,name);}
    const options:WorkerOptions & {extendedLifetime:boolean}={name,type:"module",extendedLifetime:true};
    const url=new URL("./dev-files-worker.ts",import.meta.url);
    session=new SharedWorker(url,options);
    return session.port;
  }catch{return;}
}

export function rememberDevFiles(files:Record<string,File>|null){
  try{port()?.postMessage(files);}catch{}
}

export function reopenDevFiles(){
  const worker=port();
  if(!worker)return;
  return new Promise<Record<string,File>|null>(resolve=>{
    const channel=new MessageChannel();
    const finish=(files:Record<string,File>|null)=>{
      clearTimeout(timer);channel.port1.close();resolve(files);
    };
    const timer=setTimeout(()=>finish(null),2000);
    channel.port1.onmessage=({data})=>finish(data);
    try{worker.postMessage("read",[channel.port2]);}catch{finish(null);}
  });
}

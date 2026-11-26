const scope=self as unknown as SharedWorkerGlobalScope;
let files:Record<string,File>|null=null;

scope.onconnect=({ports:[port]})=>{
  port.onmessage=event=>{
    if(event.data==="read"){
      event.ports[0].postMessage(files);
      event.ports[0].close();
    }else files=event.data;
  };
};

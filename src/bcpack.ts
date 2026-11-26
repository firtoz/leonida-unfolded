type Decoder = {
  memory: WebAssembly.Memory;
  prepare_input: (size:number)=>number;
  decode_bc1: (size:number)=>number;
};

let decoder:Promise<Decoder|null>|undefined;

async function loadDecoder(){
  const response=await fetch(new URL("./bcpack-decode.wasm",import.meta.url));
  if(!response.ok)return null;
  const {instance}=await WebAssembly.instantiate(await response.arrayBuffer());
  return instance.exports as unknown as Decoder;
}

export async function decodeBcpackBc1(bytes:Uint8Array,expected:number){
  const wasm=await (decoder??=loadDecoder().catch(()=>null));
  if(!wasm)return null;
  try{
    const input=wasm.prepare_input(bytes.length);
    if(!input)return null;
    new Uint8Array(wasm.memory.buffer,input,bytes.length).set(bytes);
    const output=wasm.decode_bc1(expected);
    return output?new Uint8Array(wasm.memory.buffer,output,expected).slice():null;
  }catch{
    return null;
  }
}

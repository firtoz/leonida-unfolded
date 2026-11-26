import {Archive} from "./archive";
import {openRpf9Preparer,rpf9ExecutableName} from "./rpf9-prepare";
import {readCloudAssets,type StreetCloudAssets} from "./street-cloud-assets";

const worker=self as unknown as DedicatedWorkerGlobalScope;
export type CloudAssetRequest={textures:File;exe:File;names:string[]};
export type CloudAssetReply={assets?:StreetCloudAssets};
worker.onmessage=async ({data}:MessageEvent<CloudAssetRequest>)=>{
  try{
    const prepare=await openRpf9Preparer(new Archive(rpf9ExecutableName,data.exe));
    const assets=await readCloudAssets(new Archive("textures.rpf",data.textures),prepare,data.names,()=>true);
    worker.postMessage({assets} satisfies CloudAssetReply,[assets.noise.buffer,...assets.maps.map(map=>map.bytes.buffer)]);
  }catch{
    worker.postMessage({} satisfies CloudAssetReply);
  }
};

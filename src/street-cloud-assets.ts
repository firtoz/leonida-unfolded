import {Archive} from "./archive";
import {findTextureDescriptor} from "./layers";
import {openRpf9Preparer} from "./rpf9-prepare";
import {openStreetSystemTextures} from "./street-system-textures";
import {bc1,linearBc16} from "./texture";

const cubeSide=128,blockSide=cubeSide/4;
const groupStride=0x2b000,tailBytes=0xb000;
const maxAddress=15*groupStride+tailBytes+blockSide*blockSide*8*16;

function decodeVolume(payload:Uint8Array){
  const output=new Uint8Array(cubeSide**3*2);
  const palette=new Uint8Array(8);
  for(let z=0;z<cubeSide;z++)for(let y=0;y<blockSide;y++)for(let x=0;x<blockSide;x++){
    const block=((x&1)<<2)|((x&2)<<4)|((y&1)<<1)|((y&2)<<3)|((y&4)<<5)|
      (z&1)|((z&2)<<2)|((z&4)<<4);
    const at=(z>>>3)*groupStride+tailBytes+((y>>>3)*8+(x>>>2))*4096+block*16;
    for(let channel=0;channel<2;channel++){
      const from=at+8*channel,a=payload[from],b=payload[from+1];
      palette[0]=a;palette[1]=b;
      const interpolated=a>b?8:6,denominator=interpolated-1;
      for(let i=2;i<interpolated;i++)
        palette[i]=Math.round(((interpolated-i)*a+(i-1)*b)/denominator);
      if(interpolated===6){palette[6]=0;palette[7]=255;}
      for(let i=0;i<16;i++){
        const bit=i*3,byte=from+2+(bit>>>3);
        const index=((payload[byte]|(payload[byte+1]<<8))>>>(bit&7))&7;
        const to=2*((z*cubeSide+y*4+(i>>>2))*cubeSide+x*4+(i&3))+channel;
        output[to]=palette[index];
      }
    }
  }
  return output;
}

export async function readCloudAssets(archive:Archive,prepare:Awaited<ReturnType<typeof openRpf9Preparer>>,
  names:readonly string[],active:()=>boolean){
  const {metadata,readSlice}=await openStreetSystemTextures(archive,prepare,active);
  const volume=findTextureDescriptor(metadata,"cloud_volume");
  if(volume.width!==cubeSide||volume.height!==cubeSide||volume.depth!==cubeSide||
    volume.format!==83||maxAddress>volume.elements*16)throw Error("Unexpected cloud volume descriptor");
  const [noise,maps]=await Promise.all([
    readSlice(volume.start,volume.start+maxAddress).then(decodeVolume),
    Promise.all([...new Set(names)].map(async name=>{
      const {width,height,format,depth,dimension,layout,start,elements}=findTextureDescriptor(metadata,name);
      if(depth!==1||dimension!==1||layout!==5||width%4||height%4||width!==height||
        ![4,128,256].includes(width)||![71,83,98].includes(format))throw Error("Unexpected cloud map "+name);
      const blockWidth=width/4,blockRows=height/4,elementSize=format===71?8:16;
      const stop=start+elements*elementSize;
      const tileBytes=Math.ceil(blockWidth/(elementSize===8?32:16))*Math.ceil(blockRows/16)*4096;
      if(tileBytes>stop-start)throw Error("Invalid cloud map mip range");
      const tiled=await readSlice(stop-tileBytes,stop);
      const bytes=elementSize===16?linearBc16(tiled,width,height):bc1(tiled,width,height).rgba;
      return {name,width,height,format,bytes};
    })),
  ]);
  return {noise,maps};
}

export type StreetCloudAssets=Awaited<ReturnType<typeof readCloudAssets>>;

import { bc3Pairs, bc3Quads, bc5Pairs, ransFrequencies } from "./bcpack-color-tables";

const widths = {
  3: [4,4,8,6,6,6,6,5,6,5,8,8],
  5: [4,4,8,8,6,6,6,6,6,6,6,6],
};
const home = 2 ** 24;
const enum Header { Control, Length, HighLength, Data }
type Model = { base:number[]; frequency:number[] };
const models = ransFrequencies.map(row => row.map(frequency => {
  let next=0;
  const base=frequency.map((f,band) => {
    const start=next;
    next+=f*(band===0?1:2**(band-1));
    return start;
  });
  return {base,frequency};
}));

class Lane {
  header=Header.Control;
  input=-1;
  held=-1;
  slot=-1;
  done=false;
  stalled=false;
  remaining=0;
  zeroes=0;
  state=0;
  nextState=0;
  flush=false;
  long=false;
  width=0;
  model?:Model;
  count=0;
  constructor(readonly symbols:Uint8Array, readonly defaultWidth:number){}

  advance(){
    if(this.held<0)return this.state;
    const symbol=this.held;
    const band=32-Math.clz32(symbol);
    const model=this.model!;
    const frequency=model.frequency[band];
    const start=model.base[band]+frequency*(symbol-(band===0?0:1<<(band-1)));
    return (frequency-Number(start===0))*(this.state>>>16)+(this.state&65535)-(start||1);
  }

  step(total:number){
    const byte=this.input;
    if(this.header!==Header.Data){
      this.input=-1;
      if(this.header===Header.Control){
        this.width=this.defaultWidth-(byte>>6);
        this.model=models[this.width-1]?.[byte&15];
        if(!this.model)return false;
        this.flush=!!(byte&16);
        this.long=!!(byte&32);
        this.zeroes=0;
        this.header=Header.Length;
      }else if(this.header===Header.Length){
        this.remaining=byte+Number(!this.long);
        this.header=this.long?Header.HighLength:Header.Data;
      }else{
        this.remaining+=byte*256+257;
        this.header=Header.Data;
      }
      return true;
    }
    let state=this.nextState;
    if(state<home){
      if(this.remaining>0){
        if(byte>=0){
          state=state*256+byte;
          this.input=-1;
          this.remaining--;
        }
      }else if(this.flush){
        if(state===0||this.zeroes===8)return false;
      }else{
        this.state=state;
        if(this.count<total)this.header=Header.Control;
        else this.done=true;
        return true;
      }
      if(this.remaining===0&&this.flush){
        while(state>0&&state<home&&this.zeroes<8){
          state*=256;
          this.zeroes++;
        }
      }
    }
    this.state=state;
    if(state>home&&this.count<total){
      const {base,frequency}=this.model!;
      const cumulative=state&65535;
      let band=this.width;
      while(band>0&&cumulative<base[band])band--;
      const symbol=band===0?0:(1<<(band-1))+Math.floor((cumulative-base[band])/frequency[band]);
      if(!Number.isInteger(symbol)||symbol>=1<<this.width)return false;
      this.held=symbol;
      this.count++;
    }
    if(this.remaining===0){
      if(this.flush&&state===home){
        if(this.count===total)this.done=true;
        else{this.header=Header.Control;this.state=0;}
      }else if(state>home&&this.held<0&&this.flush)return false;
      else if(this.count===total&&this.held<0&&!this.flush)this.done=true;
    }else if(state===home||state>home&&this.held<0&&this.count===total)return false;
    return true;
  }
}

function unpack(bytes:Uint8Array,codec:3|5,count:number){
  const lanes=widths[codec].map(width=>new Lane(new Uint8Array(count),width));
  let input=0,written=0,active=lanes.length;
  // Each cycle can move bytes into up to eight lanes and release one synchronized symbol.
  for(let cycle=0;active&&cycle<=bytes.length+2*count+32;cycle++){
    let available=8;
    for(const lane of lanes){
      lane.stalled=lane.done||lane.held>=0&&lane.slot>=0;
      if(lane.stalled)continue;
      if(lane.header===Header.Data)lane.nextState=lane.advance();
      if(lane.input<0&&(lane.header!==Header.Data||lane.remaining>0)){
        if(!available){lane.stalled=true;continue;}
        if(input>=bytes.length)return;
        lane.input=bytes[input++];
        available--;
      }
      if(lane.held>=0){lane.slot=lane.held;lane.held=-1;}
    }
    for(const lane of lanes)if(!lane.stalled&&!lane.step(count))return;
    let ready=true,hasSlot=false;
    active=0;
    for(const lane of lanes){
      if(lane.slot>=0)hasSlot=true;
      else if(!lane.done||lane.held>=0)ready=false;
      if(!lane.done||lane.slot>=0||lane.held>=0)active++;
    }
    if(ready&&hasSlot){
      if(lanes[1].slot!==0)return;
      for(const lane of lanes){
        if(lane.slot<0)return;
        lane.symbols[written]=lane.slot;
        lane.slot=-1;
      }
      // External history is only reachable from the first 255 blocks. Reject
      // an unconfirmed entry now, before expanding the rest of the texture.
      if(written<510&&(written&1)){
        const block=written>>1;
        const distance=endpointDistance(lanes[0].symbols[written-1],lanes[0].symbols[written]);
        if(distance>block&&(codec===3||!bc5History.has(256+block-distance)))return;
      }
      written++;
    }
    for(const lane of lanes)if(lane.done&&lane.held>=0&&lane.slot<0){lane.slot=lane.held;lane.held=-1;}
  }
  if(active||written!==count||lanes.some(lane=>lane.count!==count)||bytes.subarray(input).some(byte=>byte!==0))return;
  return lanes.map(lane=>lane.symbols);
}

const interleaved = Uint8Array.from({length:16},(_,i)=>(i&1)|((i&2)<<1)|((i&4)<<2)|((i&8)<<3));
const bc3Default=[128,128,0,0,0,0,0,0],bc5Default=[128,128,128,128];
const bc5History=new Map([
  [105,[219,153,195,135]],[182,[133,126,124,55]],[183,[128,126,116,112]],
  [222,[131,128,123,37]],[255,[129,127,128,126]],
]);
const unzig=(value:number)=>(value>>>1)^-(value&1);
const endpointDistance=(left:number,right:number)=>unzig(interleaved[left]|interleaved[right]<<1)&255;

function writeIndexRows(out:DataView,at:number,lanes:Uint8Array[],first:number,symbol:number,pairs:number[]){
  for(let pair=0;pair<2;pair++){
    const top=lanes[first+2*pair],bottom=lanes[first+2*pair+1];
    const bits=pairs[top[symbol]]|pairs[top[symbol+1]]<<6|
      pairs[bottom[symbol]]<<12|pairs[bottom[symbol+1]]<<18;
    out.setUint16(at+3*pair,bits,true);
    out.setUint8(at+3*pair+2,bits>>>16);
  }
}

export function decodeBcpackColor(bytes:Uint8Array,expected:number,codec:3|5):Uint8Array|null{
  if(!Number.isSafeInteger(expected)||expected<=0||expected%16!==0||expected>2*1024*1024||
    !bytes.length||bytes.length>expected+1024)return null;
  const lanes=unpack(bytes,codec,expected/8);
  if(!lanes)return null;
  const output=new Uint8Array(expected),out=new DataView(output.buffer);
  const color=codec===3,baseZero=color?bc3Default:bc5Default;
  const components=color?[2,2,7,8,9,7,8,9]:[2,2,3,3];
  const element=[0,1,0,0,0,1,1,1];
  const masks=[255,255,31,63,31,31,63,31];
  const ring=new Uint8Array(256*components.length);
  for(let i=0;i<expected/16;i++){
    const a=i*2,at=i*16;
    const distance=endpointDistance(lanes[0][a],lanes[0][a+1]);
    const prior=distance>0&&distance<=i?((i-distance)&255)*components.length:-1;
    const initial=distance===0?baseZero:color?undefined:bc5History.get(256+i-distance);
    // The stream is useful only if all external history is confirmed.
    if(prior<0&&!initial)return null;
    const slot=(i&255)*components.length;
    for(let k=0;k<components.length;k++){
      const component=color?element[k]:k&1;
      const base=prior>=0?ring[prior+k]:initial![k];
      ring[slot+k]=(base+unzig(lanes[components[k]][a+component]))&(color?masks[k]:255);
    }
    out.setUint8(at,ring[slot]);out.setUint8(at+1,ring[slot+1]);
    writeIndexRows(out,at+2,lanes,color?3:4,a,color?bc3Pairs:bc5Pairs);
    if(color){
      out.setUint16(at+8,ring[slot+2]<<11|ring[slot+3]<<5|ring[slot+4],true);
      out.setUint16(at+10,ring[slot+5]<<11|ring[slot+6]<<5|ring[slot+7],true);
      for(let row=0;row<2;row++){
        const left=bc3Quads[lanes[10+row][a]],right=bc3Quads[lanes[10+row][a+1]];
        out.setUint8(at+12+row*2,(left&15)|(right&15)<<4);
        out.setUint8(at+13+row*2,(left>>>4)|(right&240));
      }
    }else{
      out.setUint8(at+8,ring[slot+2]);out.setUint8(at+9,ring[slot+3]);
      writeIndexRows(out,at+10,lanes,8,a,bc5Pairs);
    }
  }
  return output;
}

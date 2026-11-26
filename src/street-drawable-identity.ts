// Low 64 bits of MurmurHash3 x64_128, seed zero. The placement schema
// stores this beside the 32-bit archetype hash.
const mask=(1n<<64n)-1n;
const c1=0x87c37b91114253d5n,c2=0x4cf5ad432745937fn;
const rotate=(word:bigint,shift:bigint)=>((word<<shift)|(word>>(64n-shift)))&mask;
const mix1=(word:bigint)=>(rotate(word*c1&mask,31n)*c2)&mask;
const mix2=(word:bigint)=>(rotate(word*c2&mask,33n)*c1)&mask;
const encoder=new TextEncoder();

function finish(word:bigint){
  word=((word^(word>>33n))*0xff51afd7ed558ccdn)&mask;
  word=((word^(word>>33n))*0xc4ceb9fe1a85ec53n)&mask;
  return word^(word>>33n);
}

export function drawableNameKey(name:string){
  const bytes=encoder.encode(name),data=new DataView(bytes.buffer);
  let first=0n,second=0n,at=0;
  while(at+16<=bytes.length){
    first=((rotate(first^mix1(data.getBigUint64(at,true)),27n)+second)*5n+0x52dce729n)&mask;
    second=((rotate(second^mix2(data.getBigUint64(at+8,true)),31n)+first)*5n+0x38495ab5n)&mask;
    at+=16;
  }
  let left=0n,right=0n;
  for(let i=0;at+i<bytes.length;i++){
    const value=BigInt(bytes[at+i])<<BigInt((i&7)*8);
    if(i<8)left|=value;
    else right|=value;
  }
  const size=BigInt(bytes.length);
  first=((first^mix1(left)^size)+(second^mix2(right)^size))&mask;
  second=((second^mix2(right)^size)+first)&mask;
  return ((finish(first)+finish(second))&mask).toString(16).padStart(16,"0");
}

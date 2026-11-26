import { Archive, identify, view } from "./archive";
import { PreparedRpf9Directory, readRpf9DirectoryLayout, readRpf9PreparedSections } from "./rpf9-directory";
import type { Rpf9MemberProcessor } from "./rpf9-boot";

export const rpf9ExecutableName = "game_scarlett_master.exe";
const buildProbe = {
  path: rpf9ExecutableName, size: 120181760, required: false,
  probes: [[0, "a858d47f2b71fd06ad66691695c1d68163422c7fcfc28c92eea52c5366179a11"]]
};
const imageBase = 0x140000000;

export async function verifyRpf9Executable(file: Blob | undefined) {
  if (!file) throw new Error(`Add ${rpf9ExecutableName} from Xbox Series v1.0.2.1 to open the viewer.`);
  try {
    await identify(new Archive(rpf9ExecutableName, file), buildProbe);
  } catch {
    throw new Error(`${rpf9ExecutableName} does not match the supported Xbox Series build v1.0.2.1.`);
  }
}

function shift(word: number, at: number) {
  return (word >>> at) & 255;
}

function createTransform(fixed: Uint8Array, registryInput: Uint8Array) {
  const tables = view(fixed);
  const schedule = view(registryInput);
  if (registryInput.length !== 4340 || schedule.getUint32(0, true) !== 0x4e3b9b8e) throw new Error("Unsupported RPF9 processor record");
  const words = Uint32Array.from({length:fixed.length/4},(_,i)=>tables.getUint32(i*4,true));
  const keys = Uint32Array.from({length:56},(_,i)=>schedule.getUint32(4+i*4,true));
  const final = registryInput.subarray(244);
  const table = (offset: number, index: number) => words[(offset>>>2)+index];
  const key = (word: number) => keys[word];
  const initial = (block: Uint8Array, at: number) =>
    (fixed[at*256+block[at]]<<24) | (fixed[(at+1)*256+block[at+1]]<<16) |
    (fixed[(at+2)*256+block[at+2]]<<8) | fixed[(at+3)*256+block[at+3]];
  const writeFinal = (out:Uint8Array, at:number, a:number, b:number, c:number, d:number)=>{
    const row=at*256;
    out[at]=final[row+shift(a,24)];
    out[at+1]=final[row+256+shift(d,16)];
    out[at+2]=final[row+512+shift(c,8)];
    out[at+3]=final[row+768+shift(b,0)];
  };
  return (block: Uint8Array, out: Uint8Array) => {
    let a = initial(block,0) ^ key(0);
    let b = initial(block,4) ^ key(1);
    let c = initial(block,8) ^ key(2);
    let d = initial(block,12) ^ key(3);
    for (let round=4; round<56; round+=4) {
      const nextA = table(0x3800,shift(c,8)) ^ table(0x4400,shift(d,16)) ^
        table(0x1000,shift(a,24)) ^ table(0x2c00,shift(b,0)) ^ key(round);
      const nextB = table(0x1400,shift(a,16)) ^ table(0x4800,shift(d,8)) ^
        table(0x2000,shift(b,24)) ^ table(0x3c00,shift(c,0)) ^ key(round+1);
      const nextC = table(0x2400,shift(b,16)) ^ table(0x1800,shift(a,8)) ^
        table(0x3000,shift(c,24)) ^ table(0x4c00,shift(d,0)) ^ key(round+2);
      const nextD = table(0x3400,shift(c,16)) ^ table(0x2800,shift(b,8)) ^
        table(0x4000,shift(d,24)) ^ table(0x1c00,shift(a,0)) ^ key(round+3);
      a=nextA;
      b=nextB;
      c=nextC;
      d=nextD;
    }
    writeFinal(out,0,a,b,c,d);
    writeFinal(out,4,b,c,d,a);
    writeFinal(out,8,c,d,a,b);
    writeFinal(out,12,d,a,b,c);
  };
}

function createMemberTransform(fixed:Uint8Array,registryInput:Uint8Array){
  const schedule=view(registryInput),tables=view(fixed);
  if(registryInput.length!==4340||schedule.getUint32(0,true)!==0x2718ce5d)
    throw new Error("Unsupported RPF9 member processor record");
  const offsets=[
    [0x1000,0x2400,0x3800,0x4c00],
    [0x2000,0x3400,0x4800,0x1c00],
    [0x3000,0x4400,0x1800,0x2c00],
    [0x4000,0x1400,0x2800,0x3c00],
  ];
  const roundTables=offsets.map(row=>row.map(offset=>
    Uint32Array.from({length:256},(_,i)=>tables.getUint32(offset+4*i,true))));
  const words=Uint32Array.from({length:56},(_,i)=>schedule.getUint32(4+i*4,true));
  const shifts=[24,16,8,0],final=registryInput.subarray(244);
  let lanes=new Uint32Array(4),next=new Uint32Array(4);
  return (input:Uint8Array,output:Uint8Array)=>{
    for(let lane=0;lane<4;lane++){
      let word=0;
      for(let byte=0;byte<4;byte++){
        const position=4*lane+byte;
        word|=fixed[position*256+input[position]]<<shifts[byte];
      }
      lanes[lane]=word^words[lane];
    }
    for(let round=4;round<56;round+=4){
      for(let lane=0;lane<4;lane++){
        let word=words[round+lane];
        for(let byte=0;byte<4;byte++)
          word^=roundTables[lane][byte][shift(lanes[(lane+byte)&3],shifts[byte])];
        next[lane]=word;
      }
      [lanes,next]=[next,lanes];
    }
    for(let position=0;position<16;position++){
      const byte=position&3,lane=position>>>2;
      output[position]=final[position*256+shift(lanes[(lane+byte)&3],shifts[byte])];
    }
  };
}

export async function openRpf9Preparer(executable: Archive) {
  await verifyRpf9Executable(executable.file);
  const dos = view(await executable.read(0, 64));
  const peOffset = dos.getUint32(60, true);
  const pe = view(await executable.read(peOffset, 24));
  const count = pe.getUint16(6, true);
  if (dos.getUint16(0, true) !== 0x5a4d || pe.getUint32(0, true) !== 0x4550 ||
      pe.getUint16(4, true) !== 0x8664 || count < 1 || count > 32)
    throw new Error("Unsupported RPF9 executable layout");
  const sections = view(await executable.read(peOffset + 24 + pe.getUint16(20, true), 40 * count));
  function readImage(va: number, length: number) {
    const rva = va - imageBase;
    for (let i = 0; i < count; i++) {
      const row = i * 40;
      const start = sections.getUint32(row + 12, true);
      const size = sections.getUint32(row + 16, true);
      if (rva >= start && rva + length <= start + size)
        return executable.read(sections.getUint32(row + 20, true) + rva - start, length);
    }
    throw new Error("RPF9 processor input is outside the executable's stored sections");
  }
  const [tables, operations, registry, bootSeed] = await Promise.all([
    readImage(0x146036f30, 0x5000), readImage(0x1462fe860, 0x13 * 4),
    readImage(0x1466e5900, 24 * 24), readImage(0x1462fd470, 16)
  ]);
  const input = view(registry), ops = view(operations);
  function readRecord(id:number){
    const key=(BigInt(id)<<32n)|(2n<<24n);
    for(let row=0;row<registry.length;row+=24){
      if(input.getBigUint64(row,true)!==key)continue;
      const size=input.getBigUint64(row+16,true);
      if(size!==4340n)throw new Error("Unexpected RPF9 processor input size");
      return readImage(Number(input.getBigUint64(row+8,true)),Number(size));
    }
    throw new Error("RPF9 processor input record is missing");
  }
  const transforms = new Map<number, Promise<ReturnType<typeof createTransform>>>();
  function resolve(id: number, operation: number) {
    if (operation >= 0x13 || ops.getUint32(operation * 4, true) !== 16)
      throw new Error("Unsupported RPF9 processor operation");
    const cached = transforms.get(id);
    if (cached) return cached;
    const transform=readRecord(id).then(value=>createTransform(tables,value));
    transforms.set(id,transform);
    return transform;
  }

  let memberTables:Promise<Uint8Array>|undefined;
  const memberTransforms=new Map<number,Promise<ReturnType<typeof createMemberTransform>>>();
  const processMember:Rpf9MemberProcessor=async (bytes,{id,operation,seed,prefix,stripe,gap,suffix})=>{
    if(operation!==17)throw new Error("Unsupported RPF9 member processor operation");
    let pending=memberTransforms.get(id);
    if(!pending){
      pending=Promise.all([memberTables??=readImage(0x146040f30,0x5000),readRecord(id)])
        .then(([fixed,record])=>createMemberTransform(fixed,record));
      memberTransforms.set(id,pending);
    }
    const transform=await pending;
    const start=Math.min(bytes.length,prefix),end=Math.max(start,bytes.length-suffix);
    const counter=new Uint8Array(16),data=view(counter),state=view(seed),mask=(1n<<64n)-1n;
    const initial=(state.getBigUint64(0)<<64n)|state.getBigUint64(8);
    const output=new Uint8Array(16);
    function apply(first:number,last:number){
      for(let at=first;at<last;at+=16){
        const offset=initial+BigInt(at/16);
        data.setBigUint64(0,offset>>64n);
        data.setBigUint64(8,offset&mask);
        transform(counter,output);
        for(let i=0;i<16;i++)bytes[at+i]^=output[i];
      }
    }
    apply(0,start);
    if(stripe)for(let at=start;at<end;at+=stripe+gap)apply(at,Math.min(at+stripe,end));
    apply(end,bytes.length);
  };

  async function prepare(bytes: Uint8Array, spans: readonly (readonly [number, number])[],
    id: number, operation: number, seed: Uint8Array) {
    const transform = await resolve(id, operation);
    let prior = seed.slice(), cipher = new Uint8Array(16);
    const work = new Uint8Array(16);
    for (const [start, end] of spans) {
      if (start < 0 || start > end || end > bytes.length || (end - start) % 16 !== 0)
        throw new Error("Misaligned RPF9 directory span");
      for (let at = start; at < end; at += 16) {
        for (let i = 0; i < 16; i++) cipher[i] = bytes[at + i];
        transform(cipher, work);
        for (let i = 0; i < 16; i++) bytes[at + i] = work[i] ^ prior[i];
        const previous = prior;
        prior = cipher;
        cipher = previous;
      }
    }
  }

  async function prepareDirectory(archive: Archive, base: number, limit: number) {
    if (limit < 64 || base + limit > archive.file.size) throw new Error("Invalid RPF9 archive extent");
    const header = await archive.read(base, 64);
    const layout = readRpf9DirectoryLayout(header, limit);
    const { body, bodyBytes, bodySuffixBytes, narrowEnd, wideEnd } = layout;
    if (layout.protectionTag !== 9 || !(header[0x2d] & 1) || wideEnd > 64 * 1024 * 1024 ||
        layout.entryCount > 0xffff) throw new Error("Unsupported RPF9 preparation layout");
    const bytes = await archive.read(base, wideEnd);
    const beforeSuffix = body + bodyBytes - bodySuffixBytes;
    await prepare(bytes, [[layout.sectionRows, body], [body, beforeSuffix]], 0x10000001, 16, bootSeed);
    const sections = readRpf9PreparedSections(bytes, layout);
    const descriptor = sections.get(1);
    if (descriptor !== undefined) {
      if (descriptor + 22 > beforeSuffix) throw new Error("RPF9 processor descriptor is outside its prepared span");
      const data = view(bytes);
      const id = data.getUint32(descriptor, true);
      const operation = data.getUint16(descriptor + 4, true);
      const seed = bytes.subarray(descriptor + 6, descriptor + 22);
      await prepare(bytes, [[beforeSuffix, narrowEnd]], id, operation, seed);
      if (wideEnd > narrowEnd) await prepare(bytes, [[narrowEnd, wideEnd]], id, operation, seed);
    }
    return new PreparedRpf9Directory(bytes, limit);
  }
  return Object.assign(prepareDirectory,{processMember});
}

import { view } from "./archive";

export type Rpf9Chunk = { stored: number; decoded: number; raw?: 1 };

const headerBytes = 0x40;
const sectionRowBytes = 8;
const attributeDescriptorBytes = 24;
const align = (offset: number, alignment: number) => Math.ceil(offset / alignment) * alignment;

// All offsets are relative to the start of this archive, including nested archives.
export function readRpf9DirectoryLayout(header: Uint8Array, archiveBytes: number) {
  if (header.length < headerBytes) throw new Error("Truncated RPF9 header");
  const data = view(header);
  if (data.getUint32(0, true) !== 0x52504639) throw new Error("Invalid RPF9 signature");
  const wideEnd = data.getUint32(4, true);
  const narrowEnd = data.getUint32(8, true);
  const sectionCount = data.getUint16(0x1a, true);
  const bodyBytes = data.getUint32(0x1c, true);
  const attributeCount = data.getUint16(0x20, true);
  const lateCount = data.getUint16(0x22, true);
  const entryCount = data.getUint32(0x24, true);
  const indexWidth = data.getUint8(0x2c);
  const sectionAlignment = data.getUint8(0x2d) & 1 ? 16 : 8;
  const protectionTag = data.getUint8(0x2e);
  const bodySuffixBytes = data.getUint32(0x30, true);
  if (wideEnd > archiveBytes || narrowEnd > wideEnd || lateCount > attributeCount ||
      bodySuffixBytes > bodyBytes || (indexWidth !== 1 && indexWidth !== 2 && indexWidth !== 4))
    throw new Error("Invalid RPF9 directory sizes");

  const sectionRows = headerBytes;
  const body = align(sectionRows + sectionCount * sectionRowBytes, sectionAlignment);
  const attributes = align(body + bodyBytes, sectionAlignment);
  const earlyCount = attributeCount - lateCount;
  const earlyIndices = align(attributes + attributeCount * attributeDescriptorBytes, indexWidth);
  const earlyRecords = align(earlyIndices + entryCount * earlyCount * indexWidth, 8);
  const lateIndices = align(narrowEnd, indexWidth);
  const lateRecords = lateCount ? align(lateIndices + entryCount * lateCount * indexWidth, 8) : narrowEnd;
  if (earlyRecords > narrowEnd || lateRecords > wideEnd) throw new Error("Truncated RPF9 directory tables");
  return { wideEnd, narrowEnd, sectionCount, sectionRows, body, bodyBytes, bodySuffixBytes,
    protectionTag, attributes, attributeCount, earlyCount, lateCount, entryCount, indexWidth,
    earlyIndices, earlyRecords, lateIndices, lateRecords };
}

type DirectoryLayout = ReturnType<typeof readRpf9DirectoryLayout>;

export function readRpf9PreparedSections(bytes: Uint8Array, layout: DirectoryLayout) {
  if (layout.body + layout.bodyBytes > bytes.length) throw new Error("Truncated RPF9 section body");
  const data = view(bytes);
  const sections = new Map<number, number>();
  for (let row = 0; row < layout.sectionCount; row++) {
    const rowOffset = layout.sectionRows + row * sectionRowBytes;
    const id = data.getUint16(rowOffset, true);
    const offset = data.getUint32(rowOffset + 4, true);
    if (offset >= layout.bodyBytes || sections.has(id)) throw new Error("Invalid prepared RPF9 section row");
    sections.set(id, layout.body + offset);
  }
  return sections;
}

const memberResource = 0xba180afb232d1b4bn;
const memberWide = 0x33f70dfaf2c50989n;
const memberCompact = 0x04eaa16dd829995bcn;
const nameHash = 0xb7076b6245d35fb5n;
const nameKey = 0x73bcb72dce74f11fn;
const alternateBacking = 0xcbb68ff7b7078db7n;
const memberChunks = 0xe0c12d7a5d4884c5n;
const typedAttribute = 0x5a9c2ed48d5e0959n;
const mapObject = 0xf07b5f1820ea0b48n;
const linkedMapsField = 0x847ea1f04d5de972n;

type AttributeDescriptor = { indexBase: number; indexStride: number; recordBase: number; recordLimit: number; stride: number };

export class PreparedRpf9Directory {
  readonly layout: DirectoryLayout;
  readonly sections: ReadonlyMap<number, number>;
  private readonly data: DataView;
  private readonly attributes = new Map<bigint, AttributeDescriptor>();
  private readonly emptyIndex: number;
  private mapLinksSchema?: { object: number; field: number } | null;

  // The mount preparer supplies a contiguous directory after transforming its protected spans.
  constructor(private readonly bytes: Uint8Array, archiveBytes: number) {
    this.layout = readRpf9DirectoryLayout(bytes, archiveBytes);
    if (bytes.length < this.layout.wideEnd) throw new Error("Truncated prepared RPF9 directory");
    this.sections = readRpf9PreparedSections(bytes, this.layout);
    this.data = view(bytes);
    const { indexWidth, earlyCount, lateCount, earlyIndices, lateIndices,
      earlyRecords, lateRecords, narrowEnd, wideEnd } = this.layout;
    this.emptyIndex = 2 ** (indexWidth * 8) - 1;
    for (let slot = 0; slot < this.layout.attributeCount; slot++) {
      const descriptor = this.layout.attributes + slot * attributeDescriptorBytes;
      const id = this.data.getBigUint64(descriptor, true);
      const offset = this.data.getUint32(descriptor + 0xc, true);
      const stride = this.data.getUint16(descriptor + 0x10, true);
      if (this.attributes.has(id)) throw new Error("Duplicate RPF9 attribute descriptor");
      const late = slot >= earlyCount;
      this.attributes.set(id, {
        indexBase: late ? lateIndices + (slot - earlyCount) * indexWidth : earlyIndices + slot * indexWidth,
        indexStride: (late ? lateCount : earlyCount) * indexWidth,
        recordBase: (late ? lateRecords : earlyRecords) + offset,
        recordLimit: late ? wideEnd : narrowEnd,
        stride,
      });
    }
  }

  private checkEntry(entry: number) {
    if (!Number.isInteger(entry) || entry < 0 || entry >= this.layout.entryCount) throw new Error("Invalid RPF9 member slot");
  }

  private recordOffset(entry: number, descriptor: AttributeDescriptor | undefined) {
    if (!descriptor) return;
    const { layout, data } = this;
    const { indexBase, indexStride, recordBase, recordLimit, stride } = descriptor;
    const indexAt = indexBase + entry * indexStride;
    const index = layout.indexWidth === 1 ? data.getUint8(indexAt)
      : layout.indexWidth === 2 ? data.getUint16(indexAt, true) : data.getUint32(indexAt, true);
    if (index === this.emptyIndex) return;
    const recordStart = recordBase + index * stride;
    if (stride === 0 || recordStart + stride > recordLimit)
      throw new Error("Out-of-bounds RPF9 attribute record");
    return recordStart;
  }

  attribute(entry: number, id: bigint): Uint8Array | undefined {
    this.checkEntry(entry);
    const descriptor = this.attributes.get(id);
    if (!descriptor) return;
    const start = this.recordOffset(entry, descriptor);
    if (start !== undefined) return this.bytes.subarray(start, start + descriptor.stride);
  }

  private fieldOffset(entry: number, id: bigint, minBytes: number, kind: string) {
    const descriptor = this.attributes.get(id);
    if (!descriptor) return;
    const start = this.recordOffset(entry, descriptor);
    if (start !== undefined && descriptor.stride < minBytes) throw new Error(`Truncated RPF9 ${kind}`);
    return start;
  }

  attributePayload(record: Uint8Array, offset: number, length: number) {
    const start = record.byteOffset - this.bytes.byteOffset;
    const at = start + offset;
    const end = start < this.layout.narrowEnd ? this.layout.narrowEnd : this.layout.wideEnd;
    if (record.buffer !== this.bytes.buffer || start < 0 || offset < record.length ||
        length < 0 || at + length > end) throw new Error("Out-of-bounds RPF9 attribute payload");
    return view(this.bytes.subarray(at, at + length));
  }

  private linkedMapSchema() {
    const start=this.sections.get(11);
    if(start===undefined)return null;
    const {data,layout}=this;
    let end=layout.body+layout.bodyBytes;
    for(const offset of this.sections.values())if(offset>start&&offset<end)end=offset;
    if(start+12>end)throw new Error("Truncated RPF9 typed object schema");
    const objectCount=data.getUint16(start,true),fieldCount=data.getUint32(start+4,true);
    const objects=start+12,fields=objects+objectCount*24;
    if(fields+fieldCount*16>end)throw new Error("Invalid RPF9 typed object schema");
    for(let object=0;object<objectCount;object++){
      const at=objects+object*24;
      if(data.getBigUint64(at,true)!==mapObject)continue;
      const count=data.getUint16(at+12,true),first=data.getUint32(at+16,true);
      if(first+count>fieldCount)throw new Error("Invalid RPF9 typed object fields");
      for(let index=first;index<first+count;index++){
        const record=fields+index*16;
        if(data.getBigUint64(record,true)===linkedMapsField&&data.getUint8(record+10)===0x8c)
          return {object,field:data.getUint16(record+8,true)};
      }
    }
    return null;
  }

  linkedMaps(entry:number):bigint[] {
    const schema=this.mapLinksSchema===undefined?(this.mapLinksSchema=this.linkedMapSchema()):this.mapLinksSchema;
    const wrapper=schema&&this.attribute(entry,typedAttribute);
    if(!wrapper||wrapper.length<8)return [];
    const header=view(wrapper),offset=header.getUint32(0,true),count=header.getUint32(4,true);
    if(!count)return [];
    const index=this.attributePayload(wrapper,offset,count*12);
    for(let row=0;row<index.byteLength;row+=12){
      if(index.getUint16(row,true)!==schema.object)continue;
      const start=index.getUint32(row+4,true),length=index.getUint32(row+8,true);
      if(schema.field+8>length)throw new Error("Invalid RPF9 map links field");
      const object=this.attributePayload(wrapper,start,length);
      const relative=object.getUint32(schema.field,true),entries=object.getUint32(schema.field+4,true);
      if(!entries)return [];
      if(relative<length)throw new Error("Invalid RPF9 linked map array offset");
      const keys=this.attributePayload(wrapper,start+relative,entries*8);
      return Array.from({length:entries},(_,i)=>keys.getBigUint64(i*8,true));
    }
    return [];
  }

  member(entry: number) {
    this.checkEntry(entry);
    const resource = this.fieldOffset(entry, memberResource, 17, "member record");
    const wide = resource === undefined ? this.fieldOffset(entry, memberWide, 24, "member record") : undefined;
    const record = resource ?? wide ?? this.fieldOffset(entry, memberCompact, 16, "member record");
    if (record === undefined) return;
    const { data } = this;
    const hash = this.fieldOffset(entry, nameHash, 4, "member name");
    const key = this.fieldOffset(entry, nameKey, 8, "member name");
    const backing = this.fieldOffset(entry, alternateBacking, 4, "backing selector");
    const systemBytes = resource === undefined ? undefined : data.getUint32(record, true) & 0x7ffffff0;
    const fields = { nameHash: hash === undefined ? undefined : data.getUint32(hash, true),
      nameKey: key === undefined ? undefined : data.getBigUint64(key, true), systemBytes,
      alternateBacking: backing !== undefined && data.getUint32(backing, true) !== 0xffffffff };
    if (systemBytes !== undefined) return { ...fields, type: data.getUint8(record + 16),
      offset: data.getUint32(record + 12, true) * 16, storedBytes: data.getUint32(record + 8, true) * 16,
      logicalBytes: systemBytes + ((data.getUint32(record + 4, true) & 0xfffffff0) >>> 0) };
    if (wide !== undefined) return { ...fields, type: data.getUint8(record + 5),
      offset: Number(data.getBigUint64(record, true) & 0xffffffffffn) * 16,
      storedBytes: Number(data.getBigUint64(record + 8, true) & 0xffffffffffn) * 16,
      logicalBytes: Number(data.getBigUint64(record + 16, true) & 0xfffffffffffn) };
    return { ...fields, type: data.getUint8(record + 14), offset: data.getUint32(record + 4, true) * 16,
      storedBytes: data.getUint32(record, true) * 16, logicalBytes: Number(data.getBigUint64(record + 8, true) & 0xffffffffffffn) };
  }

  storedChunks(entry: number, storedBytes: number): number[] | undefined {
    const record = this.attribute(entry, memberChunks);
    if (!record) return;
    if (record.length < 6) throw new Error("Truncated RPF9 chunk descriptor");
    const descriptor = view(record);
    if (record.length >= 8 && descriptor.getUint8(7) === 4) return;
    const relative = descriptor.getUint32(0, true);
    const count = descriptor.getUint16(4, true);
    if (!count || count > 4096) return;
    const start = record.byteOffset - this.bytes.byteOffset;
    const table = start + relative;
    const end = start < this.layout.narrowEnd ? this.layout.narrowEnd : this.layout.wideEnd;
    if (table + count * 8 > end) throw new Error("RPF9 chunk table is outside its containing span");
    const chunks: number[] = [];
    let used = 16;
    for (let chunk = 0; chunk < count; chunk++) {
      const size = (this.data.getUint32(table + chunk * 8 + 4, true) & 0xffffff) * 16;
      if (!size || (used += size) > storedBytes) return;
      chunks.push(size);
    }
    if (used === storedBytes) return chunks;
  }

  decodedChunks(entry: number, storedBytes: number, logicalBytes: number): Rpf9Chunk[] | undefined {
    const record = this.attribute(entry, memberChunks);
    if (!record || record.length < 8) return;
    const mode = record[7];
    if (mode !== 2 && mode !== 4) return;
    const descriptor = view(record);
    const count = descriptor.getUint16(4, true);
    if (!count || count > 4096) return;
    const table = this.attributePayload(record, descriptor.getUint32(0, true), count * 8);
    const chunks: Rpf9Chunk[] = [];
    let physical = 16, logical = 0;
    for (let index = 0; index < count; index++) {
      const a = table.getUint32(index * 8, true), b = table.getUint32(index * 8 + 4, true);
      const decoded = mode === 4 ? a & 0xffffff : a * 16;
      const stored = mode === 4 ? ((b & 0xfffff) << 8) | (a >>> 24) : (b & 0xffffff) * 16;
      const codec = mode === 4 ? (b >>> 24) & 15 : b >>> 24 ? 3 : 0;
      if (!decoded || !stored || (physical += stored) > storedBytes || (logical += decoded) > logicalBytes) break;
      if (codec === 0 && stored === decoded) chunks.push({ stored, decoded, raw: 1 });
      else if (codec === 3) chunks.push({ stored, decoded });
      else return;
    }
    if (physical === storedBytes && logical === logicalBytes && chunks.length === count) return chunks;
    if (mode === 4) throw new Error("Invalid RPF9 mode-4 totals");
  }

  packedChunks(entry:number,storedBytes:number,logicalBytes:number) {
    const record=this.attribute(entry,memberChunks);
    if(!record||record.length<8||record[7]!==3)return;
    const descriptor=view(record),count=descriptor.getUint16(4,true);
    if(!count||count>4096)throw new Error("Invalid RPF9 mode-3 chunk count");
    const table=this.attributePayload(record,descriptor.getUint32(0,true),count*8);
    const chunks:(Rpf9Chunk&{offset:number})[]=[];
    let physical=0,logical=0;
    for(let index=0;index<count;index++){
      const at=index*8,low=table.getUint32(at,true),high=table.getUint32(at+4,true);
      const offset=(high&0x0fffffff)*16,codec=(high>>>28)&3;
      const stored=65536-(low>>>16),decoded=65536-(low&0xffff);
      if(offset!==physical||offset+stored>storedBytes||codec!==3&&(codec!==0||stored!==decoded))
        throw new Error("Invalid RPF9 mode-3 chunk span");
      physical+=align(stored,16);
      logical+=decoded;
      chunks.push(codec===0?{offset,stored,decoded,raw:1}:{offset,stored,decoded});
    }
    if(physical!==storedBytes||logical!==logicalBytes)throw new Error("Invalid RPF9 mode-3 totals");
    return chunks;
  }
}

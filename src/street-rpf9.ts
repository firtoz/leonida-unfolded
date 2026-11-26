import { Archive, view } from "./archive";
import { openRpf9Preparer, rpf9ExecutableName } from "./rpf9-prepare";
import { indexSegmentSize, readCarvedZlib, scanStreetSegment, type ScanScope, type StreetMemberRange, type VisitIndexedMap } from "./street-index-scan";
import type { Bounds } from "./native-spatial";
import { vegetationDistance } from "./street-vegetation";
import { readRpf9LevelMounts, type Rpf9Mount } from "./rpf9-level-manifest";
import type { Rpf9Chunk } from "./rpf9-directory";
import type { PreparedRpf9Directory } from "./rpf9-directory";
import type { MapPage } from "./street-placement-probe";
import { readRpf9PackedMember } from "./rpf9-boot";

type Member = { at: number; end: number; type: number; chunks?: number[]; streamingBounds?: Bounds;
  entityBounds?: Bounds; collisionBounds?: Bounds; nameKey?: bigint; nameHash?: number; systemBytes?: number; archetypePack?: number;
  archetypeDependencies?: number[]; mapClass?: 3 | 4 | 5 | 6; mapFlags?: number; pageChunks?: Rpf9Chunk[]; mountBase: number;
  mapSlot?: number; interiorSpatial?:{key:bigint;hash:number} };
export type StreetArchiveMember = StreetMemberRange & Omit<Member, "at" | "end" | "chunks" | "streamingBounds">;
const signature = 0x52504639;
const mapType = 0x49;
const staticCollisionBoundsAttribute=0x354d34a2f99040d1n;
const mapBoundsAttribute = 0x658e1ef6e7b629can;
const mapArchetypePackAttribute = 0xeacdfb5a68c99445n;
const mapArchetypeDependenciesAttribute = 0xea2e64902a50e4b8n;
const mapInteriorSpatialAttribute = 0x938fa71da04cf30dn;

function resourceMember({ at, ...member }: Member): StreetArchiveMember | undefined {
  const offset = at + 16;
  if (member.type !== 0 && offset + 7 < member.end) return { ...member, offset };
}

export function readRpf9StreamingBounds(record?: Uint8Array, field: "streaming" | "entities" = "streaming"): Bounds | undefined {
  const start = field === "streaming" ? 0x18 : 0x30;
  if (!record || record.length < start + 24) return;
  return readBounds(record,start);
}

function readBounds(record:Uint8Array,start=0){
  if(record.length<start+24)return;
  const data = view(record);
  const bounds: Bounds = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 6; i++) bounds[i] = data.getFloat32(start + i * 4, true);
  if (bounds.every((value, i) => Number.isFinite(value) && Math.abs(value) < 50000 &&
      (i >= 3 || value <= bounds[i + 3]))) return bounds;
}

export function readRpf9MapClass(record?: Uint8Array): Member["mapClass"] {
  if (!record || record.length < 0x18) return;
  const flags = view(record).getUint32(0x14, true);
  if (flags & 2) return 5;
  if (flags & 0x20184) return 6;
  return flags & 0x400 ? 4 : 3;
}

// Keep the directory on the scan lane. The existing placement and drawable
// decoders still determine whether a resource can enter the spatial index.
export class StreetRpf9 {
  private opening?: ReturnType<typeof openRpf9Preparer>;
  private preparedRoot?: Promise<PreparedRpf9Directory>;
  private mounts?: ReturnType<typeof readRpf9LevelMounts>;
  private readonly executable: Archive;
  private readonly listings = new Map<number, Promise<Member[]>>();
  private readonly mountEnds = new Map<number,number>();
  private readonly linkDirectories = new Map<number,Promise<PreparedRpf9Directory>>();

  constructor(private readonly archive: Archive, executable: Blob) {
    this.executable = new Archive(rpf9ExecutableName, executable);
  }

  levelMounts(common: Archive) {
    return this.mounts ??= this.readLevelMounts(common);
  }

  private async readLevelMounts(common: Archive) {
    const prepare = await (this.opening ??= openRpf9Preparer(this.executable));
    const [commonRoot, levelsRoot] = await Promise.all([
      prepare(common, 0, common.file.size), this.prepareRoot()
    ]);
    return readRpf9LevelMounts(common, commonRoot, levelsRoot);
  }

  private prepareRoot() {
    return this.preparedRoot ??= (this.opening ??= openRpf9Preparer(this.executable))
      .then(prepare=>prepare(this.archive,0,this.archive.file.size));
  }

  async linkedMapKeys(member:StreetArchiveMember){
    const {mountBase:base,mapSlot}=member;
    const end=this.mountEnds.get(base);
    if(end===undefined||mapSlot===undefined)return [];
    let directory=this.linkDirectories.get(base);
    this.linkDirectories.delete(base);
    directory??=base?this.prepareChild(base,end):this.prepareRoot();
    this.linkDirectories.set(base,directory);
    if(this.linkDirectories.size>8)this.linkDirectories.delete(this.linkDirectories.keys().next().value!);
    return (await directory).linkedMaps(mapSlot);
  }

  private async prepareChild(base:number,end:number){
    const prepare=await (this.opening??=openRpf9Preparer(this.executable));
    return prepare(this.archive,base,end-base);
  }

  async mountedMembers(mount:Rpf9Mount,types?:ReadonlySet<number>):Promise<StreetArchiveMember[]> {
    const members=await this.catalogListing(mount.base,mount.end,types);
    return members.flatMap(member=>!types||types.has(member.type)?resourceMember(member)??[]:[]);
  }

  async readMountedMetadata(mount:Rpf9Mount,nameHash:number){
    const directory=await this.prepareChild(mount.base,mount.end);
    let match:number|undefined;
    for(let slot=0;slot<directory.layout.entryCount;slot++){
      const member=directory.member(slot);
      if(member?.type!==0x0b||member.nameHash!==nameHash)continue;
      if(match!==undefined)return;
      match=slot;
    }
    if(match===undefined)return;
    const prepare=await this.opening!;
    return readRpf9PackedMember(this.archive,directory,match,prepare.processMember,mount);
  }

  async *catalogMembers(common: Archive | undefined, types?: ReadonlySet<number>) {
    const mounts = common ? (await this.levelMounts(common)).mounts : undefined;
    const root = await this.listing(0, this.archive.file.size);
    const named = new Set<number>();
    const ordered=[...mounts?.values()??[]];
    const width=8;
    for(let start=0;start<ordered.length;start+=width){
      const group=ordered.slice(start,start+width);
      const listings=await Promise.all(group.map(mount=>this.catalogListing(mount.base,mount.end,types)));
      for(let index=0;index<group.length;index++){
        named.add(group[index].base);
        yield* this.catalogTree(listings[index],1,types);
      }
    }
    // Some valid root entries are outside the main level manifest.
    yield* this.catalogTree(root.filter(member => !named.has(member.at)), 0, types);
  }

  private catalogListing(base: number, end: number, types?: ReadonlySet<number>) {
    // A scoped listing must never stand in for the full directory on the scan lane.
    return this.listings.get(base) ?? (types ? this.loadListing(base,end,types) : this.listing(base,end));
  }

  private async *catalogTree(members: Member[], depth: number, types?: ReadonlySet<number>): AsyncGenerator<StreetArchiveMember[]> {
    yield members.flatMap(member => !types || types.has(member.type) ? resourceMember(member) ?? [] : []);
    for (const member of members) {
      if (member.type !== 0) continue;
      if (depth >= 4) throw new Error("Nested RPF9 directory exceeds supported depth");
      yield* this.catalogTree(await this.catalogListing(member.at, member.end, types), depth + 1, types);
    }
  }

  readMembers(members: StreetArchiveMember[], scope: ScanScope, active: () => boolean, visitMap?: VisitIndexedMap) {
    return scanStreetSegment(this.archive, 0, active, scope, members.sort((a, b) => a.offset - b.offset), visitMap);
  }

  async readSystem(member: StreetArchiveMember) {
    return (await this.readSystemPages(member)).bytes;
  }

  async readSystemPages(member: StreetArchiveMember) {
    const { systemBytes, chunks, pageChunks } = member;
    const maxBytes = 32 * 1024 * 1024;
    const span = member.end - member.offset;
    if (!systemBytes || systemBytes > maxBytes || span <= 0 || (!chunks && !pageChunks && span > maxBytes))
      throw new Error("Unsupported RPF9 system stream layout");
    // Read the known system prefix in one operation. Graphics remain on
    // disk until a consumer asks for their individual pages.
    let systemStored=0,systemDecoded=0;
    for(const page of pageChunks??[]){
      if(!page.stored||!page.decoded||systemStored+page.stored>span||systemDecoded+page.decoded>systemBytes)break;
      systemStored+=page.stored;
      systemDecoded+=page.decoded;
      if(systemDecoded===systemBytes)break;
    }
    // Some members contain aligned zlib pages but omit the optional chunk table.
    const contents=systemDecoded===systemBytes?await this.archive.read(member.offset,systemStored):
      chunks||pageChunks?undefined:await this.archive.read(member.offset,span);
    const bytes = new Uint8Array(systemBytes);
    const pages: MapPage[] = [];
    let at = member.offset, cursor = 0, index = 0;
    while (at < member.end) {
      const entry = pageChunks?.[index], stored = entry?.stored ?? chunks?.[index];
      index++;
      if ((chunks||pageChunks)&&(!stored||at+stored>member.end))break;
      const from=at-member.offset;
      const input=contents?contents.subarray(from,stored===undefined?undefined:from+stored):
        await this.archive.read(at,stored!);
      const page = entry?.raw ? { bytes: input, stored: input.length } :
        readCarvedZlib(input, Math.min(systemBytes - cursor, entry?.decoded ?? Infinity));
      if (!page || !page.bytes.length) break;
      const padded = entry?.raw ? page.stored : Math.ceil(page.stored / 16) * 16;
      if ((stored && padded !== stored) || at + padded > member.end ||
        (entry && page.bytes.length !== entry.decoded) || cursor + page.bytes.length > systemBytes) break;
      bytes.set(page.bytes, cursor);
      pages.push(entry?.raw ? [at, page.stored, page.bytes.length, 1] : [at, page.stored, page.bytes.length]);
      cursor += page.bytes.length;
      at += padded;
      if (cursor === systemBytes) {
        const graphicsStart = at;
        const graphics = pageChunks?.slice(index).map(({ stored, decoded, raw }): MapPage => {
          const start = at;
          at += stored;
          return raw ? [start, stored, decoded, 1] : [start, stored, decoded];
        });
        return { bytes, pages, graphics, graphicsStart };
      }
    }
    throw new Error("Truncated RPF9 system stream");
  }

  private listing(at: number, end: number) {
    const saved = this.listings.get(at);
    if (saved) return saved;
    const load = this.loadListing(at, end);
    this.listings.set(at, load);
    // Broad discovery is interleaved across regions; retain just the most
    // recent child directories and always retain the root.
    if (this.listings.size > 25) {
      const oldestChild = [...this.listings.keys()].find(key => key !== 0);
      if (oldestChild !== undefined) this.listings.delete(oldestChild);
    }
    return load;
  }

  private async loadListing(base: number, end: number, types?: ReadonlySet<number>): Promise<Member[]> {
    if (base && view(await this.archive.read(base, 4)).getUint32(0, true) !== signature) return [];
    const directory = base ? await this.prepareChild(base,end) : await this.prepareRoot();
    this.mountEnds.set(base,end);
    const members: Member[] = [];
    for (let slot = 0; slot < directory.layout.entryCount; slot++) {
      const member = directory.member(slot);
      if (!member || !member.storedBytes) continue;
      if (member.alternateBacking) throw new Error("RPF9 alternate backing is required");
      const at = base + member.offset, next = at + member.storedBytes;
      if (at < base + directory.layout.wideEnd || next > end) throw new Error("Invalid RPF9 member range");
      if (member.type && types && !types.has(member.type)) continue;
      const bounds = member.type === mapType ? directory.attribute(slot, mapBoundsAttribute) : undefined;
      const collision=member.type===6?directory.attribute(slot,staticCollisionBoundsAttribute):undefined;
      const pack = member.type === mapType ? directory.attribute(slot, mapArchetypePackAttribute) : undefined;
      const dependencies = member.type === mapType ? directory.attribute(slot, mapArchetypeDependenciesAttribute) : undefined;
      const spatial = member.type === mapType ? directory.attribute(slot,mapInteriorSpatialAttribute) : undefined;
      const spatialRecord=spatial&&spatial.length>=0x20?view(spatial):undefined;
      let archetypeDependencies: number[] | undefined;
      if (dependencies && dependencies.length >= 12) {
        const descriptor = view(dependencies);
        const count = descriptor.getUint32(8, true);
        if (count && count <= 4096) {
          const table = directory.attributePayload(dependencies, descriptor.getUint32(4, true), count * 4);
          archetypeDependencies = Array.from({ length: count }, (_, index) => table.getUint32(index * 4, true));
        }
      }
      members.push({ at, end: next, type: member.type, nameKey: member.nameKey, nameHash: member.nameHash,
        mountBase: base, mapSlot:member.type===mapType?slot:undefined, archetypeDependencies,
        interiorSpatial:spatialRecord&&{key:spatialRecord.getBigUint64(0x18,true),hash:spatialRecord.getUint32(0x14,true)},
        systemBytes: member.systemBytes, archetypePack: pack && pack.length >= 4 ? view(pack).getUint32(0, true) : undefined,
        collisionBounds:collision&&readBounds(collision),
        streamingBounds: readRpf9StreamingBounds(bounds), entityBounds: readRpf9StreamingBounds(bounds, "entities"),
        mapClass: readRpf9MapClass(bounds),
        mapFlags: bounds && bounds.length >= 0x18 ? view(bounds).getUint32(0x14, true) : undefined,
        pageChunks: member.type === mapType || member.type === 0x4a ?
          directory.decodedChunks(slot, member.storedBytes, member.logicalBytes) : undefined,
        chunks: member.type ? directory.storedChunks(slot, member.storedBytes) : undefined });
    }
    return members.sort((a, b) => a.at - b.at);
  }

  async candidates(segment: number, scope: ScanScope, active: () => boolean) {
    const start = segment * indexSegmentSize, end = Math.min(start + indexSegmentSize, this.archive.file.size);
    const offsets = new Map<number, StreetArchiveMember>();
    const visit = async (members: Member[], depth: number) => {
      for (const member of members) {
        if (member.at >= end || !active()) break;
        if (member.type === 0 && member.end > start) {
          if (depth >= 4) throw new Error("Nested RPF9 directory exceeds supported depth");
          await visit(await this.listing(member.at, member.end), depth + 1);
        } else if (member.at >= start && member.type !== 0 &&
                   (scope === "full" || member.type === mapType)) {
          const resource = resourceMember(member);
          if (resource) offsets.set(resource.offset, resource);
        }
      }
    };
    await visit(await this.listing(0, this.archive.file.size), 0);
    return [...offsets.values()].sort((a, b) => a.offset - b.offset);
  }

  async readSegment(segment: number, scope: ScanScope, active: () => boolean, point?: readonly [number, number]) {
    const before = this.archive.bytesRead;
    const members = await this.candidates(segment, scope, active);
    const selected = point && scope === "sample" ? members.filter(({ streamingBounds: box }) => !box ||
      vegetationDistance(point[0], point[1], box[0], box[1], box[3], box[4]) <= 450) : members;
    const result = await scanStreetSegment(this.archive, segment, active, scope, selected);
    return { ...result, bytes: this.archive.bytesRead - before, directory: true };
  }
}

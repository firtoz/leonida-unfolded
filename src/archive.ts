import { inflateSync } from "fflate";

export type Range = readonly [offset: number, length: number];
export type Probe = { path: string; size: number; required: boolean; probes: (string | number)[][] };
export const text = new TextDecoder("latin1");
export const hex = (n: number | bigint) => "0x" + n.toString(16);

export class Archive {
  bytesRead = 0;
  constructor(public readonly path: string, readonly file: Blob) {}
  async read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
        offset < 0 || length < 1 || offset + length > this.file.size)
      throw new Error(`${this.path}: byte range ${hex(offset)} + ${length} is outside the file`);
    const bytes = new Uint8Array(await this.file.slice(offset, offset + length).arrayBuffer());
    this.bytesRead += bytes.length;
    if (bytes.length !== length) throw new Error(`${this.path}: short read at ${hex(offset)}`);
    return bytes;
  }
}

export const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export async function identify(archive: Archive, spec: Probe) {
  if (archive.file.size !== spec.size)
    throw new Error(`${spec.path}: expected ${spec.size.toLocaleString()} bytes, found ${archive.file.size.toLocaleString()}`);
  for (const [offset, expected] of spec.probes) {
    const sample = await archive.read(Number(offset), 4096);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", sample));
    const actual = Array.from(hash, byte => byte.toString(16).padStart(2,"0")).join("");
    if (actual !== expected) throw new Error(`${spec.path}: build fingerprint failed at ${hex(Number(offset))}`);
  }
}

export function inflate(bytes: Uint8Array, limit: number) {
  // RDS5 records and some profiled resource ranges include alignment bytes.
  // Bound raw DEFLATE output and validate the zlib wrapper before decoding.
  if (bytes.length < 7 || bytes[0] !== 0x78 || ((bytes[0] * 256 + bytes[1]) % 31) || (bytes[1] & 32))
    throw new Error("Invalid zlib header");
  const result = inflateSync(bytes.subarray(2), { out: new Uint8Array(limit + 1) });
  if (result.length > limit) throw new Error("Inflated resource exceeds its size limit");
  return result;
}

export function unpackRanges(encoded: string): Range[] {
  const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  let i = 0, offset = 0;
  const ranges: Range[] = [];
  function take() {
    let num = 0, factor = 1;
    while (i < bytes.length && factor <= 2 ** 49) {
      const byte = bytes[i++];
      num += (byte & 127) * factor;
      if (!(byte & 128)) return num;
      factor *= 128;
    }
    throw new Error("Invalid range table");
  }
  while (i < bytes.length) {
    offset += take();
    const length = take();
    if (!Number.isSafeInteger(offset) || !length) throw new Error("Invalid resource range");
    ranges.push([offset,length]);
  }
  return ranges;
}

export async function* readResources(archive: Archive, ranges: Range[]) {
  // Read consecutive archive pages together while skipping unrelated payloads.
  for (let first = 0; first < ranges.length;) {
    const base = ranges[first][0];
    let end = base + ranges[first][1];
    let next = first + 1;
    while (next < ranges.length) {
      const [offset,length] = ranges[next];
      if (offset - end > 4096 || offset + length - base > 1024 * 1024) break;
      end = Math.max(end, offset + length);
      next++;
    }
    const chunk = await archive.read(base,end-base);
    for (; first < next; first++) {
      const [offset,length] = ranges[first];
      yield { offset, bytes: chunk.subarray(offset-base,offset-base+length) };
    }
  }
}

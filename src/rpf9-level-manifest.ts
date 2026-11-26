import type { Archive } from "./archive";
import type { PreparedRpf9Directory } from "./rpf9-directory";
import { drawableNameKey } from "./street-drawable-identity";
import { readCarvedZlib } from "./street-index-scan";

const maxManifestBytes = 2 * 1024 * 1024;

type FileMember = NonNullable<ReturnType<PreparedRpf9Directory["member"]>>;
export type Rpf9Mount = { path: string; key: bigint; base: number; end: number };

function indexMembers(directory: PreparedRpf9Directory) {
  const members = new Map<bigint, FileMember>();
  const ambiguous = new Set<bigint>();
  for (let slot = 0; slot < directory.layout.entryCount; slot++) {
    const member = directory.member(slot);
    if (!member?.nameKey || !member.storedBytes || member.alternateBacking || ambiguous.has(member.nameKey)) continue;
    if (members.has(member.nameKey)) {
      members.delete(member.nameKey);
      ambiguous.add(member.nameKey);
    } else members.set(member.nameKey, member);
  }
  return members;
}

const archiveKey = (path: string) => BigInt(`0x${drawableNameKey(path)}`);
const normalized = (path: string) => path.trim().toLowerCase().replaceAll("\\", "/");

export function readRpf9ManifestPaths(xml: string) {
  const includes = [...xml.matchAll(/<includedSets\b[^>]*>([\s\S]*?)<\/includedSets>/gi)]
    .flatMap(([, section]) => [...section.matchAll(/<Item>\s*(common:[^<]+)\s*<\/Item>/gi)]
      .map(([, path]) => normalized(path)))
    .filter(path => path.startsWith("common:/") && path.endsWith(".meta"));
  const children = [...xml.matchAll(/<fileList\b[^>]*>([\s\S]*?)<\/fileList>/gi)]
    .flatMap(([, section]) => [...section.matchAll(/<filename>\s*(platform:[^<]+)\s*<\/filename>/gi)]
      .map(([, path]) => normalized(path)))
    .filter(path => path.startsWith("platform:/") && path.endsWith(".rpf"));
  return { includes, children };
}

async function manifestText(archive: Archive, member: FileMember) {
  if (member.storedBytes > maxManifestBytes || member.logicalBytes > maxManifestBytes)
    throw new Error("RPF9 level manifest exceeds the decode limit");
  const bytes = await archive.read(member.offset, member.storedBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let decoded = 0;
  for (let at = 0; at + 6 < bytes.length && bytes[at] === 0x78;) {
    const part = readCarvedZlib(bytes.subarray(at), maxManifestBytes - decoded);
    if (!part) throw new Error("Invalid compressed RPF9 level manifest");
    parts.push(decoder.decode(part.bytes, { stream: true }));
    decoded += part.bytes.length;
    at += Math.ceil(part.stored / 16) * 16;
  }
  parts.push(decoder.decode());
  const xml = parts.join("");
  if (!xml.includes("<CDataFileMgr__Content")) throw new Error("Invalid RPF9 level manifest");
  return xml;
}

export async function readRpf9LevelMounts(common: Archive, commonRoot: PreparedRpf9Directory,
  levelsRoot: PreparedRpf9Directory) {
  const manifests = indexMembers(commonRoot);
  const children = indexMembers(levelsRoot);
  const pending = ["common:/data/levels/americas/americas.meta"];
  const seen = new Set(pending);
  const mounts = new Map<bigint, Rpf9Mount>();
  const missingIncludes: string[] = [];
  for (let i = 0; i < pending.length; i++) {
    const path = pending[i];
    const member = manifests.get(archiveKey(path.slice("common:/".length)));
    if (!member) {
      if (i === 0) throw new Error("The RPF9 level manifest is missing");
      missingIncludes.push(path);
      continue;
    }
    const { includes, children: listed } = readRpf9ManifestPaths(await manifestText(common, member));
    for (const include of includes) {
      if (seen.has(include)) continue;
      seen.add(include);
      pending.push(include);
    }
    for (const child of listed) {
      const key = archiveKey(child.slice("platform:/".length, -".rpf".length));
      const entry = children.get(key);
      if (entry?.type === 0 && !mounts.has(key))
        mounts.set(key, { path: child, key, base: entry.offset, end: entry.offset + entry.storedBytes });
    }
  }
  return { mounts, missingIncludes };
}

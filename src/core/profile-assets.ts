import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { HostProfile } from "../types/index.ts";

export const MAX_PROFILE_ASSET_BYTES = 1024 * 1024;

export interface CapturedProfileAsset {
  readonly kind: "claude_md" | "agents_md";
  readonly destinationPath: "claude/CLAUDE.md" | "codex/AGENTS.md";
  readonly configuredPath: string;
  readonly bytes: Buffer;
  readonly size: number;
  readonly sha256: string;
}

function containedPath(configDir: string, configuredPath: string): string {
  if (isAbsolute(configuredPath)) throw new Error("Profile asset path must be config-relative");
  if (/[\0\r\n]/.test(configuredPath)) {
    throw new Error("Profile asset path must not contain NUL or newlines");
  }
  if (configuredPath.split(sep).some((component) => component.length === 0)) {
    throw new Error("Profile asset path must not contain empty components");
  }
  const absoluteConfigDir = resolve(configDir);
  const absolutePath = resolve(absoluteConfigDir, configuredPath);
  const fromConfig = relative(absoluteConfigDir, absolutePath);
  if (
    !fromConfig ||
    fromConfig === ".." ||
    fromConfig.startsWith(`..${sep}`) ||
    isAbsolute(fromConfig)
  ) {
    throw new Error("Profile asset path must be contained in the config directory");
  }
  return absolutePath;
}

async function assertNoSymlinkComponents(configDir: string, assetPath: string): Promise<void> {
  const absoluteConfigDir = resolve(configDir);
  const segments = relative(absoluteConfigDir, assetPath).split(sep);
  let current = absoluteConfigDir;
  const configStat = await lstat(current);
  if (configStat.isSymbolicLink())
    throw new Error("Profile config directory must not be a symlink");
  if (!configStat.isDirectory()) throw new Error("Profile config directory must be a directory");
  for (const segment of segments) {
    current = resolve(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("Profile asset path must not contain symlinks");
  }
}

async function trustedConfigDirectory(configDir: string): Promise<string> {
  // Node/Bun do not expose openat. Establish the local-config threat boundary explicitly:
  // root/current-uid owners are trusted. Sticky ancestors such as /tmp prevent other users
  // from replacing our owned entry; ordinary group/world-writable ancestors do not.
  const lexical = resolve(configDir);
  const currentUid = process.getuid?.();
  const chain: string[] = [];
  for (let current = lexical; ; current = dirname(current)) {
    chain.push(current);
    if (dirname(current) === current) break;
  }
  for (const current of chain.reverse()) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Profile config directory must have regular directory ancestors");
    }
    const isWritable = (info.mode & 0o022) !== 0;
    const isStickyAncestor = current !== lexical && (info.mode & 0o1000) !== 0;
    if (isWritable && !isStickyAncestor) {
      throw new Error("Profile config directory must not have group/world-writable ancestors");
    }
    if (currentUid !== undefined && info.uid !== 0 && info.uid !== currentUid) {
      throw new Error("Profile config directory has an untrusted owner");
    }
  }
  const canonical = await realpath(lexical);
  if (canonical !== lexical) {
    throw new Error("Profile config directory must not use symlink ancestors");
  }
  return lexical;
}

async function assertTrustedAssetParents(configDir: string, assetPath: string): Promise<void> {
  const currentUid = process.getuid?.();
  let current = dirname(assetPath);
  while (true) {
    const info = await lstat(current);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      (info.mode & 0o022) !== 0 ||
      (currentUid !== undefined && info.uid !== 0 && info.uid !== currentUid)
    ) {
      throw new Error("Profile asset parent directories must be trusted non-symlink directories");
    }
    if (current === configDir) return;
    current = dirname(current);
  }
}

export async function readProfileAssetBounded(handle: FileHandle): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(MAX_PROFILE_ASSET_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_PROFILE_ASSET_BYTES) {
    throw new Error(`Profile asset exceeds ${MAX_PROFILE_ASSET_BYTES} bytes`);
  }
  return buffer.subarray(0, offset);
}

async function captureOne(
  kind: CapturedProfileAsset["kind"],
  destinationPath: CapturedProfileAsset["destinationPath"],
  configuredPath: string,
  configDir: string,
): Promise<CapturedProfileAsset> {
  const trustedConfigDir = await trustedConfigDirectory(configDir);
  const assetPath = containedPath(trustedConfigDir, configuredPath);
  await assertNoSymlinkComponents(trustedConfigDir, assetPath);
  await assertTrustedAssetParents(trustedConfigDir, assetPath);
  const handle = await open(assetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Profile asset must be a regular file");
    if (before.size > MAX_PROFILE_ASSET_BYTES) {
      throw new Error(`Profile asset exceeds ${MAX_PROFILE_ASSET_BYTES} bytes`);
    }
    const bytes = await readProfileAssetBounded(handle);
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.length !== after.size
    ) {
      throw new Error("Profile asset changed while being captured");
    }
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    await assertNoSymlinkComponents(trustedConfigDir, assetPath);
    await assertTrustedAssetParents(trustedConfigDir, assetPath);
    return {
      kind,
      destinationPath,
      configuredPath,
      bytes: Buffer.from(bytes),
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error instanceof TypeError && error.message.includes("encoded data")) {
      throw new Error("Profile asset must be valid UTF-8", { cause: error });
    }
    throw error;
  } finally {
    await handle.close();
  }
}

/** Loads all replacement files once so later planning can bind their exact bytes and hashes. */
export async function captureProfileAssets(
  profile: HostProfile,
  configDir: string,
): Promise<ReadonlyArray<CapturedProfileAsset>> {
  const requested = [
    ["claude_md", "claude/CLAUDE.md", profile.claude_md],
    ["agents_md", "codex/AGENTS.md", profile.agents_md],
  ] as const;
  const assets: CapturedProfileAsset[] = [];
  for (const [kind, destinationPath, configuredPath] of requested) {
    if (configuredPath !== undefined)
      assets.push(await captureOne(kind, destinationPath, configuredPath, configDir));
  }
  return assets;
}

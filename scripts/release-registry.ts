import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readTarEntries } from "./verify-release.ts";

export interface ReleaseIdentity {
  readonly name: string;
  readonly version: string;
  readonly shasum: string;
  readonly integrity: string;
}

export type PublicationDecision = "publish" | "already-published";

export interface RegistryDigests {
  readonly shasum: string;
  readonly integrity: string;
}

export type RegistryLookup = (
  name: string,
  version: string,
) => Promise<RegistryDigests | undefined>;

export async function readReleaseIdentity(tarball: string): Promise<ReleaseIdentity> {
  const bytes = await readFile(tarball);
  const metadataEntry = readTarEntries(bytes).find(
    (entry) => entry.name === "package/package.json" && (entry.type === "0" || entry.type === "\0"),
  );
  if (!metadataEntry) throw new Error("release tarball has no package/package.json");
  const metadata = JSON.parse(metadataEntry.data.toString()) as {
    name?: unknown;
    version?: unknown;
  };
  if (typeof metadata.name !== "string" || !metadata.name) {
    throw new Error("release tarball package name is invalid");
  }
  if (typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+$/.test(metadata.version)) {
    throw new Error("release tarball package version is invalid");
  }
  return {
    name: metadata.name,
    version: metadata.version,
    shasum: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

export function decidePublication(
  expected: RegistryDigests,
  published: RegistryDigests | undefined,
): PublicationDecision {
  assertDigests(expected, "local release");
  if (published === undefined) return "publish";
  assertDigests(published, "published release");
  if (published.shasum !== expected.shasum || published.integrity !== expected.integrity) {
    throw new Error("npm already contains this version with different tarball digests");
  }
  return "already-published";
}

export async function lookupRegistryDigests(
  name: string,
  version: string,
): Promise<RegistryDigests | undefined> {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { headers: { accept: "application/json" } },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`npm registry lookup failed with HTTP ${response.status}`);
  const metadata = (await response.json()) as {
    dist?: { shasum?: unknown; integrity?: unknown };
  };
  if (typeof metadata.dist?.shasum !== "string" || typeof metadata.dist.integrity !== "string") {
    throw new Error("npm registry response has no complete tarball digests");
  }
  const digests = { shasum: metadata.dist.shasum, integrity: metadata.dist.integrity };
  assertDigests(digests, "npm registry");
  return digests;
}

export async function waitForPublishedRelease(
  identity: ReleaseIdentity,
  options: {
    readonly attempts?: number;
    readonly delayMs?: number;
    readonly lookup?: RegistryLookup;
    readonly sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<void> {
  const attempts = options.attempts ?? 12;
  const delayMs = options.delayMs ?? 5_000;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 120) {
    throw new Error("registry verification attempts are invalid");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
    throw new Error("registry verification delay is invalid");
  }
  const lookup = options.lookup ?? lookupRegistryDigests;
  const sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const published = await lookup(identity.name, identity.version);
    if (published !== undefined) {
      decidePublication(identity, published);
      return;
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error(`npm did not expose ${identity.name}@${identity.version} before timeout`);
}

function assertDigests(digests: RegistryDigests, source: string): void {
  if (!/^[a-f0-9]{40}$/.test(digests.shasum)) {
    throw new Error(`${source} tarball shasum is invalid`);
  }
  if (!digests.integrity.startsWith("sha512-")) {
    throw new Error(`${source} tarball integrity is invalid`);
  }
  const encoded = digests.integrity.slice("sha512-".length);
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== encoded) {
    throw new Error(`${source} tarball integrity is invalid`);
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, tarball] = argv;
  if ((command !== "decide" && command !== "verify") || !tarball || argv.length !== 2) {
    throw new Error("usage: release-registry decide|verify TARFILE");
  }
  const identity = await readReleaseIdentity(tarball);
  if (command === "decide") {
    console.log(
      decidePublication(identity, await lookupRegistryDigests(identity.name, identity.version)),
    );
    return;
  }
  await waitForPublishedRelease(identity);
  console.log(JSON.stringify(identity));
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const execFile = promisify(execFileCallback);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (command, args, options = {}) => {
  const result = await execFile(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

export interface TarEntry {
  name: string;
  mode: number;
  type: string;
  data: Buffer;
}

function readTarString(block: Buffer, start: number, length: number): string {
  const end = block.indexOf(0, start);
  return block
    .subarray(start, end === -1 || end > start + length ? start + length : end)
    .toString();
}

function readTarNumber(block: Buffer, start: number, length: number): number {
  const value = readTarString(block, start, length).trim();
  if (!value) return 0;
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid tar number: ${value}`);
  return parsed;
}

export function readTarEntries(compressed: Buffer): TarEntry[] {
  const archive = gunzipSync(compressed);
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | undefined;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const size = readTarNumber(header, 124, 12);
    const mode = readTarNumber(header, 100, 8);
    const type = String.fromCharCode(header[156] ?? 0) || "0";
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const headerName = prefix ? `${prefix}/${name}` : name;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw new Error(`truncated tar entry: ${headerName}`);
    const data = archive.subarray(dataStart, dataEnd);

    if (type === "L") {
      longName = data.subarray(0, Math.max(0, data.length - 1)).toString();
    } else if (type !== "x" && type !== "g") {
      entries.push({ name: longName ?? headerName, mode, type, data: Buffer.from(data) });
      longName = undefined;
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function changelogSection(changelog: string, version: string): string {
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\] - \\d{4}-\\d{2}-\\d{2}$`, "gm");
  const matches = [...changelog.matchAll(heading)];
  if (matches.length !== 1) {
    throw new Error(`CHANGELOG.md must have exactly one dated [${version}] section`);
  }
  const match = matches[0];
  if (!match) throw new Error(`CHANGELOG.md has no dated [${version}] section`);
  const bodyStart = (match.index ?? 0) + match[0].length;
  const nextHeading = changelog.slice(bodyStart).search(/^## /m);
  const body = changelog
    .slice(bodyStart, nextHeading === -1 ? undefined : bodyStart + nextHeading)
    .trim();
  if (!body) throw new Error(`CHANGELOG.md [${version}] section is empty`);
  return body;
}

export function assertReleaseVersions(input: {
  tag: string;
  packageVersion: string;
  cliVersion: string;
}): void {
  if (!/^v\d+\.\d+\.\d+$/.test(input.tag)) {
    throw new Error(`release tag must use vX.Y.Z: ${input.tag}`);
  }
  const tagVersion = input.tag.slice(1);
  if (input.packageVersion !== tagVersion) {
    throw new Error(`tag ${input.tag} does not match package version ${input.packageVersion}`);
  }
  if (input.cliVersion !== input.packageVersion) {
    throw new Error(
      `CLI version ${input.cliVersion} does not match package version ${input.packageVersion}`,
    );
  }
}

export function assertPackedContents(
  entries: readonly TarEntry[],
  expectedFiles: readonly string[],
  version: string,
): void {
  const files = entries.filter((entry) => entry.type === "0" || entry.type === "\0");
  const names = files.map((entry) => entry.name).sort();
  const expected = [...expectedFiles].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    const missing = expected.filter((name) => !names.includes(name));
    const extra = names.filter((name) => !expected.includes(name));
    throw new Error(
      `packed contents differ (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
    );
  }

  const forbidden = names.find((name) => {
    const relative = name.replace(/^package\//, "");
    return (
      relative.split("/").some((part) => part.startsWith(".")) ||
      relative.startsWith("tests/") ||
      relative.startsWith(".github/") ||
      /(?:^|\/)(?:credentials?|auth)(?:\.|\/|$)/i.test(relative) ||
      /\.(?:pem|key|tgz|tar\.gz)$/i.test(relative)
    );
  });
  if (forbidden) throw new Error(`forbidden packed entry: ${forbidden}`);

  const metadataEntry = files.find((entry) => entry.name === "package/package.json");
  if (!metadataEntry) throw new Error("packed package.json is missing");
  const metadata = JSON.parse(metadataEntry.data.toString()) as {
    version?: unknown;
    bin?: Record<string, unknown>;
  };
  if (metadata.version !== version)
    throw new Error("packed package version does not match release");
  if (metadata.bin?.ccm !== "./src/index.ts") throw new Error("packed ccm bin entry is invalid");

  const cliEntry = files.find((entry) => entry.name === "package/src/index.ts");
  if (!cliEntry) throw new Error("packed CLI entrypoint is missing");
  if ((cliEntry.mode & 0o111) === 0) throw new Error("packed CLI entrypoint is not executable");
  if (!cliEntry.data.toString().startsWith("#!/usr/bin/env bun\n")) {
    throw new Error("packed CLI entrypoint does not declare Bun");
  }
  if (!files.some((entry) => entry.name === "package/src/core/remote-push-helper.py")) {
    throw new Error("packed remote push helper is missing");
  }
}

interface VerifyReleaseOptions {
  tag: string;
  tarball: string;
  mainRef: string;
  cwd?: string;
  run?: CommandRunner;
}

export async function verifyRelease(options: VerifyReleaseOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const run = options.run ?? runCommand;
  const metadata = JSON.parse(await readFile(`${cwd}/package.json`, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (metadata.name !== "claude-code-migrate") throw new Error("package.json name is invalid");
  if (typeof metadata.version !== "string") throw new Error("package.json version is invalid");
  const expectedTarballName = `${metadata.name}-${metadata.version}.tgz`;
  if (basename(options.tarball) !== expectedTarballName) {
    throw new Error(`tarball name must be ${expectedTarballName}`);
  }

  const [head, tagCommit, cli, changelog, tracked] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], { cwd }),
    run("git", ["rev-parse", `${options.tag}^{commit}`], { cwd }),
    run("bun", ["src/index.ts", "--version"], { cwd }),
    readFile(`${cwd}/CHANGELOG.md`, "utf8"),
    run("git", ["ls-files", "--", "src"], { cwd }),
  ]);

  assertReleaseVersions({
    tag: options.tag,
    packageVersion: metadata.version,
    cliVersion: cli.stdout.trim(),
  });
  if (head.stdout.trim() !== tagCommit.stdout.trim()) {
    throw new Error(`${options.tag} does not point at HEAD`);
  }
  changelogSection(changelog, metadata.version);

  try {
    await run("git", ["merge-base", "--is-ancestor", options.tag, options.mainRef], { cwd });
  } catch {
    throw new Error(`${options.tag} is not an ancestor of ${options.mainRef}`);
  }

  const trackedSource = tracked.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((file) => `package/${file}`);
  const expected = [
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
    "package/CHANGELOG.md",
    ...trackedSource,
  ];
  const entries = readTarEntries(await readFile(options.tarball));
  assertPackedContents(entries, expected, metadata.version);
}

function parseArguments(argv: readonly string[]): VerifyReleaseOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value)
      throw new Error("expected --tag, --tarball, and --main-ref values");
    values.set(key, value);
  }
  const tag = values.get("--tag");
  const tarball = values.get("--tarball");
  if (!tag || !tarball)
    throw new Error("usage: verify-release --tag vX.Y.Z --tarball FILE [--main-ref REF]");
  return { tag, tarball, mainRef: values.get("--main-ref") ?? "origin/main" };
}

if (import.meta.main) {
  try {
    const options = parseArguments(process.argv.slice(2));
    await verifyRelease(options);
    console.log(`verified ${options.tag} and ${options.tarball}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

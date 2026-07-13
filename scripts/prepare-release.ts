import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { readReleaseIdentity } from "./release-registry.ts";
import { smokePackage } from "./smoke-package.ts";
import { changelogSection, type CommandRunner, verifyRelease } from "./verify-release.ts";

export interface PreparedRelease {
  readonly name: string;
  readonly version: string;
  readonly tag: string;
  readonly tarball: string;
  readonly shasum: string;
  readonly integrity: string;
  readonly sha256: string;
  readonly checksums: string;
  readonly notes: string;
}

export async function prepareRelease(input: {
  readonly tag: string;
  readonly tarball: string;
  readonly mainRef?: string;
  readonly metadataPath?: string;
  readonly cwd?: string;
  readonly run?: CommandRunner;
  readonly smoke?: typeof smokePackage;
}): Promise<PreparedRelease> {
  const tarball = resolve(input.tarball);
  const directory = dirname(tarball);
  const cwd = input.cwd ?? process.cwd();
  await verifyRelease({
    tag: input.tag,
    tarball,
    mainRef: input.mainRef ?? "origin/main",
    cwd,
    run: input.run,
  });
  await (input.smoke ?? smokePackage)(tarball);

  const identity = await readReleaseIdentity(tarball);
  const bytes = await readFile(tarball);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const checksums = resolve(directory, "SHA256SUMS");
  const notes = resolve(directory, "RELEASE_NOTES.md");
  const changelog = await readFile(resolve(cwd, "CHANGELOG.md"), "utf8");
  await writeFile(checksums, `${sha256}  ${basename(tarball)}\n`, { mode: 0o600 });
  await writeFile(notes, `${changelogSection(changelog, identity.version)}\n`, { mode: 0o600 });

  const prepared: PreparedRelease = {
    ...identity,
    tag: input.tag,
    tarball,
    sha256,
    checksums,
    notes,
  };
  if (input.metadataPath) {
    await writeFile(resolve(input.metadataPath), `${JSON.stringify(prepared, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  return prepared;
}

function parseArguments(argv: readonly string[]): {
  tag: string;
  tarball: string;
  mainRef?: string;
  metadataPath?: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value)
      throw new Error("release preparation arguments are invalid");
    values.set(key, value);
  }
  const tag = values.get("--tag");
  const tarball = values.get("--tarball");
  if (!tag || !tarball) {
    throw new Error(
      "usage: prepare-release --tag TAG --tarball FILE [--main-ref REF] [--metadata FILE]",
    );
  }
  return {
    tag,
    tarball,
    mainRef: values.get("--main-ref"),
    metadataPath: values.get("--metadata"),
  };
}

if (import.meta.main) {
  try {
    const prepared = await prepareRelease(parseArguments(process.argv.slice(2)));
    console.log(JSON.stringify(prepared));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

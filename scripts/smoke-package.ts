import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandRunner, readTarEntries, runCommand } from "./verify-release.ts";

export interface SmokePackageOptions {
  run?: CommandRunner;
  keepTemporaryDirectory?: boolean;
}

export async function smokePackage(
  tarballInput: string,
  options: SmokePackageOptions = {},
): Promise<void> {
  const tarball = isAbsolute(tarballInput) ? tarballInput : resolve(tarballInput);
  const entries = readTarEntries(await readFile(tarball));
  const packageEntry = entries.find((entry) => entry.name === "package/package.json");
  if (!packageEntry) throw new Error("tarball has no package/package.json");
  const metadata = JSON.parse(packageEntry.data.toString()) as { version?: unknown };
  if (typeof metadata.version !== "string") throw new Error("packed package version is invalid");

  const root = await mkdtemp(join(tmpdir(), "ccm-package-smoke-"));
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  const cache = join(root, "npm-cache");
  const run = options.run ?? runCommand;
  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    npm_config_cache: cache,
    npm_config_userconfig: join(root, "empty-npmrc"),
  };

  try {
    await Promise.all(
      [home, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME, cache].map(
        (directory) => mkdir(directory, { recursive: true }),
      ),
    );
    await run(
      "npm",
      [
        "install",
        "--global",
        "--prefix",
        prefix,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        tarball,
      ],
      { env },
    );
    const executable = join(prefix, "bin", "ccm");
    const version = await run(executable, ["--version"], { env });
    if (version.stdout.trim() !== metadata.version) {
      throw new Error(
        `installed CLI version ${version.stdout.trim()} does not match ${metadata.version}`,
      );
    }
    const help = await run(executable, ["--help"], { env });
    if (!help.stdout.includes("Usage: ccm")) throw new Error("installed CLI help smoke failed");
  } finally {
    if (!options.keepTemporaryDirectory) await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const tarball = process.argv[2];
  if (!tarball) {
    console.error("usage: smoke-package TARFILE");
    process.exitCode = 1;
  } else {
    try {
      await smokePackage(tarball);
      console.log(`smoked ${tarball}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

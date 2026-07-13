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

  await smokeInstallTarget(tarball, metadata.version, options);
}

export async function smokeRegistryPackage(
  name: string,
  version: string,
  options: SmokePackageOptions = {},
): Promise<void> {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)) {
    throw new Error("registry package name is invalid");
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("registry package version is invalid");
  await smokeInstallTarget(`${name}@${version}`, version, options);
}

async function smokeInstallTarget(
  installTarget: string,
  expectedVersion: string,
  options: SmokePackageOptions,
): Promise<void> {
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
        installTarget,
      ],
      { env },
    );
    const executable = join(prefix, "bin", "ccm");
    const version = await run(executable, ["--version"], { env });
    if (version.stdout.trim() !== expectedVersion) {
      throw new Error(
        `installed CLI version ${version.stdout.trim()} does not match ${expectedVersion}`,
      );
    }
    const help = await run(executable, ["--help"], { env });
    if (!help.stdout.includes("Usage: ccm")) throw new Error("installed CLI help smoke failed");
  } finally {
    if (!options.keepTemporaryDirectory) await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--registry" && args[1] && args[2] && args.length === 3) {
    try {
      await smokeRegistryPackage(args[1], args[2]);
      console.log(`smoked ${args[1]}@${args[2]} from the registry`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } else if (args[0] && args.length === 1) {
    try {
      await smokePackage(args[0]);
      console.log(`smoked ${args[0]}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } else {
    console.error("usage: smoke-package TARFILE | --registry PACKAGE VERSION");
    process.exitCode = 1;
  }
}

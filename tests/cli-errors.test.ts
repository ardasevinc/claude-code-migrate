import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const projectRoot = join(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);

async function runCli(args: string[], home: string) {
  try {
    const result = await execFileAsync("bun", ["src/index.ts", ...args], {
      cwd: projectRoot,
      env: { ...process.env, HOME: home, NO_COLOR: "1" },
    });
    return { exitCode: 0, ...result };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
  }
}

describe("CLI errors", () => {
  it("fails closed when the existing config cannot be parsed", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-cli-"));
    const configDir = join(home, ".config", "claude-code-migrate");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.toml"), "[target\nhost = broken", "utf8");

    const result = await runCli(["config"], home);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Failed to load config at");
  });

  it("rejects invalid known config values instead of coercing them", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-cli-"));
    const configDir = join(home, ".config", "claude-code-migrate");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "config.toml"),
      '[target]\ntype = "local"\n[providers.claude]\nenabled = "yes"',
      "utf8",
    );

    const result = await runCli(["config"], home);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('target.type must be "ssh"');
  });

  it("rejects misspelled settings and empty policy requirements", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-cli-"));
    const configDir = join(home, ".config", "claude-code-migrate");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "config.toml"),
      '[providers.codex.plugin_policies."example@market"]\nmode = "auto"\ncommmands = [" "]',
      "utf8",
    );

    const result = await runCli(["config"], home);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("commmands is not a recognized setting");
  });

  it("reports command failures on stderr with a nonzero exit", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-cli-"));
    const archive = join(home, "missing.tar.gz");

    const result = await runCli(["restore", archive], home);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Archive not found: ${archive}`);
  });

  it("reports an invalid archive exactly once on stderr", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-cli-"));
    const archive = join(home, "invalid.tar.gz");
    await writeFile(archive, "not an archive", "utf8");

    const result = await runCli(["restore", archive], home);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Archive is invalid or unreadable");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
  });

  it("rejects a configured SSH option before collection or connection", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-cli-"));
    const configDir = join(home, ".config", "claude-code-migrate");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "config.toml"),
      '[target]\ntype = "ssh"\nhost = "-oProxyCommand=touch-pwned"\n',
      "utf8",
    );

    const result = await runCli(["push", "--dry-run"], home);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid SSH target");
  });

  it("maps Commander syntax failures to usage", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-cli-"));
    const result = await runCli(["restore"], home);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("missing required argument");
  });
});

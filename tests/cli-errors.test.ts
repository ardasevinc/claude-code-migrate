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

    expect(result.exitCode).toBe(1);
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

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('target.type must be "ssh"');
  });

  it("reports command failures on stderr with a nonzero exit", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-cli-"));
    const archive = join(home, "missing.tar.gz");

    const result = await runCli(["restore", archive], home);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Archive not found: ${archive}`);
  });
});

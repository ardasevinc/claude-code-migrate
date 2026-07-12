import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createArchive } from "../src/core/archiver.ts";
import { runCcm } from "./integration/harness/index.ts";

const execFileAsync = promisify(execFile);

describe("CLI errors", () => {
  it.each([
    ["codex/config.toml", "[[[not toml"],
    ["codex/hooks.json", '{"hooks":'],
  ])("attributes malformed restore member %s to archive inputs", async (relativePath, content) => {
    const home = await mkdtemp(join(tmpdir(), "ccm-cli-invalid-restore-"));
    const source = join(home, "source");
    const archive = join(home, "invalid-input.tar.gz");
    await writeFile(source, content);
    await createArchive([{ sourcePath: source, relativePath, isSymlink: false }], archive, {
      providers: ["codex"],
    });
    const result = await runCcm(["restore", archive, "codex", "--dry-run"], home);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("Restore inputs are invalid");
    expect(result.stderr).not.toContain("Restore target is invalid");
  });

  it("fails closed when the existing config cannot be parsed", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-cli-"));
    const configDir = join(home, ".config", "claude-code-migrate");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.toml"), "[target\nhost = broken", "utf8");

    const result = await runCcm(["config"], home);

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

    const result = await runCcm(["config"], home);

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

    const result = await runCcm(["config"], home);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("commmands is not a recognized setting");
  });

  it("reports command failures on stderr with a nonzero exit", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-cli-"));
    const archive = join(home, "missing.tar.gz");

    const result = await runCcm(["restore", archive], home);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Archive not found: ${archive}`);
  });

  it("reports an invalid archive exactly once on stderr", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-cli-"));
    const archive = join(home, "invalid.tar.gz");
    await writeFile(archive, "not an archive", "utf8");

    const result = await runCcm(["restore", archive], home);

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

    const result = await runCcm(["push", "--dry-run"], home);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid SSH target");
  });

  it("maps Commander syntax failures to usage", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-cli-"));
    const result = await runCcm(["restore"], home);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("missing required argument");
  });

  it("rejects forbidden archive payloads before mutating auth", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccm-cli-"));
    const codexDir = join(home, ".codex");
    const sourceDir = join(home, "archive-source");
    const archive = join(home, "forbidden.tar.gz");
    await mkdir(codexDir, { recursive: true });
    await mkdir(join(sourceDir, "codex"), { recursive: true });
    await writeFile(join(codexDir, "auth.json"), "original-auth", "utf8");
    await writeFile(join(sourceDir, "codex", "auth.json"), "incoming-auth", "utf8");
    await writeFile(
      join(sourceDir, ".ccm-manifest.json"),
      JSON.stringify({
        version: "1.8.2",
        timestamp: new Date().toISOString(),
        sourceHost: "fixture",
        claudeVersion: null,
        providers: ["codex"],
        files: [
          {
            sourcePath: "/source/auth.json",
            relativePath: "codex/auth.json",
            isSymlink: false,
          },
        ],
      }),
      "utf8",
    );
    await execFileAsync("tar", ["-czf", archive, "-C", sourceDir, "."]);

    const result = await runCcm(["restore", archive], home);

    expect(result.exitCode).toBe(3);
    expect(await readFile(join(codexDir, "auth.json"), "utf8")).toBe("original-auth");
  });
});

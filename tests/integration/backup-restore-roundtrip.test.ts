import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeMachine, runCcm } from "./harness/index.ts";

describe("real backup and restore product boundary", () => {
  it("round-trips managed state, excludes secrets, preserves unmanaged state, and is idempotent", async () => {
    const source = await createFakeMachine("ccm-roundtrip-source-");
    const target = await createFakeMachine("ccm-roundtrip-target-");
    try {
      await seedSource(source.home);
      await seedTargetCanaries(target.home);
      const archive = join(source.root, "roundtrip.tar.gz");

      const backedUp = await runCcm(["backup", "codex", archive], source);
      expect(backedUp.exitCode).toBe(0);
      expect(backedUp.stderr).toBe("");

      const inspected = await runCcm(["inspect", archive, "--files", "--json"], source);
      expect(inspected).toMatchObject({ exitCode: 0, stderr: "" });
      const inspection = JSON.parse(inspected.stdout) as {
        format: string;
        integrity: string;
        files: Array<{ path: string }>;
      };
      expect(inspection).toMatchObject({ format: "v2", integrity: "verified" });
      const archivedPaths = inspection.files.map((file) => file.path);
      expect(archivedPaths).toEqual(
        expect.arrayContaining([
          "codex/config.toml",
          "codex/AGENTS.md",
          "codex/rules/managed.md",
          "codex/skills/operator/SKILL.md",
          "shared/agents/skills/shared/SKILL.md",
        ]),
      );
      expect(archivedPaths).not.toEqual(
        expect.arrayContaining([
          "codex/auth.json",
          "codex/history.jsonl",
          "codex/skills/.system/SECRET",
        ]),
      );

      const verified = await runCcm(["verify", archive, "--json"], source);
      expect(verified).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(verified.stdout)).toMatchObject({ valid: true, integrity: "verified" });

      const restored = await runCcm(["restore", archive, "codex"], target);
      expect(restored).toMatchObject({ exitCode: 0, stderr: "" });
      expect(restored.stdout).toMatch(/Receipt: rcpt_[a-f0-9]{32}/);
      expect(await readFile(join(target.home, ".codex/config.toml"), "utf8")).toBe(
        'model = "gpt-5"\n',
      );
      expect(await readFile(join(target.home, ".codex/rules/managed.md"), "utf8")).toBe(
        "managed source\n",
      );
      expect(await readFile(join(target.home, ".agents/skills/shared/SKILL.md"), "utf8")).toBe(
        "shared source\n",
      );
      expect(await readFile(join(target.home, ".codex/auth.json"), "utf8")).toBe(
        "TARGET-AUTH-CANARY\n",
      );
      expect(await readFile(join(target.home, ".codex/history.jsonl"), "utf8")).toBe(
        "TARGET-HISTORY-CANARY\n",
      );
      expect(await readFile(join(target.home, ".codex/unmanaged-runtime/canary"), "utf8")).toBe(
        "TARGET-UNMANAGED-CANARY\n",
      );
      await expect(access(join(target.home, ".codex/skills/.system/SECRET"))).rejects.toThrow();

      const backupsBefore = await backupNames(target.home);
      const secondRestore = await runCcm(["restore", archive, "codex"], target);
      expect(secondRestore).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
      expect(await backupNames(target.home)).toEqual(backupsBefore);
    } finally {
      await Promise.all([source.dispose(), target.dispose()]);
    }
  });
});

async function seedSource(home: string): Promise<void> {
  await Promise.all([
    mkdir(join(home, ".codex/rules"), { recursive: true }),
    mkdir(join(home, ".codex/agents"), { recursive: true }),
    mkdir(join(home, ".codex/skills/operator"), { recursive: true }),
    mkdir(join(home, ".codex/skills/.system"), { recursive: true }),
    mkdir(join(home, ".agents/skills/shared"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(home, ".codex/config.toml"), 'model = "gpt-5"\n'),
    writeFile(join(home, ".codex/AGENTS.md"), "managed agents\n"),
    writeFile(join(home, ".codex/rules/managed.md"), "managed source\n"),
    writeFile(join(home, ".codex/agents/managed.md"), "managed agent\n"),
    writeFile(join(home, ".codex/skills/operator/SKILL.md"), "operator source\n"),
    writeFile(join(home, ".codex/skills/.system/SECRET"), "SOURCE-SYSTEM-SECRET\n"),
    writeFile(join(home, ".codex/auth.json"), "SOURCE-AUTH-SECRET\n"),
    writeFile(join(home, ".codex/history.jsonl"), "SOURCE-HISTORY-SECRET\n"),
    writeFile(join(home, ".agents/skills/shared/SKILL.md"), "shared source\n"),
  ]);
}

async function seedTargetCanaries(home: string): Promise<void> {
  await mkdir(join(home, ".codex/unmanaged-runtime"), { recursive: true });
  await Promise.all([
    writeFile(join(home, ".codex/auth.json"), "TARGET-AUTH-CANARY\n"),
    writeFile(join(home, ".codex/history.jsonl"), "TARGET-HISTORY-CANARY\n"),
    writeFile(join(home, ".codex/unmanaged-runtime/canary"), "TARGET-UNMANAGED-CANARY\n"),
  ]);
}

async function backupNames(home: string): Promise<string[]> {
  return (await readdir(home)).filter((name) => name.includes(".backup-")).sort();
}

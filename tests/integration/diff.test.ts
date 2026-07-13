import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { armFault, createFakeMachine, readCommandLog, runCcm } from "./harness/index.ts";

interface PlanAction {
  readonly id: string;
  readonly phase: "materialize" | "commit" | "post-commit";
  readonly disposition: "create" | "update" | "merge" | "unchanged" | "preserve";
}

interface PlanJson {
  readonly id: string;
  readonly kind: "push" | "restore";
  readonly actions: readonly PlanAction[];
}

interface DiffJson {
  readonly kind: "diff";
  readonly migrationKind: "push" | "restore";
  readonly planId: string;
  readonly counts: {
    readonly actions: number;
    readonly changed: number;
    readonly materializations: number;
    readonly byDisposition: Record<PlanAction["disposition"], number>;
  };
  readonly actions: readonly PlanAction[];
}

describe("migration diff commands", () => {
  it("projects the exact immutable push plan without mutation", async () => {
    const machine = await createFakeMachine("ccm-diff-push-");
    try {
      await Promise.all([
        mkdir(join(machine.home, ".codex"), { recursive: true }),
        mkdir(join(machine.remoteHome, ".codex"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(machine.home, ".codex/config.toml"), 'model = "gpt-5.6"\n'),
        writeFile(join(machine.remoteHome, ".codex/canary"), "REMOTE-CANARY\n"),
      ]);

      const dryRun = await runCcm(
        ["push", "codex", "operator@example.test", "--dry-run", "--json"],
        machine,
      );
      const diff = await runCcm(
        ["diff", "push", "codex", "operator@example.test", "--json"],
        machine,
      );

      expect(dryRun).toMatchObject({ exitCode: 0, stderr: "" });
      expect(diff).toMatchObject({ exitCode: 0, stderr: "" });
      expect(diff.stdout.trim().split("\n")).toHaveLength(1);
      expectExactProjection(JSON.parse(dryRun.stdout) as PlanJson, JSON.parse(diff.stdout));
      expect(await readFile(join(machine.remoteHome, ".codex/canary"), "utf8")).toBe(
        "REMOTE-CANARY\n",
      );
    } finally {
      await machine.dispose();
    }
  });

  it("projects the exact immutable restore plan without mutation", async () => {
    const source = await createFakeMachine("ccm-diff-restore-source-");
    const target = await createFakeMachine("ccm-diff-restore-target-");
    try {
      await mkdir(join(source.home, ".codex"), { recursive: true });
      await mkdir(join(target.home, ".codex"), { recursive: true });
      await writeFile(join(source.home, ".codex/config.toml"), 'model = "source"\n');
      await writeFile(join(target.home, ".codex/config.toml"), 'model = "target"\n');
      const archive = join(source.root, "diff.tar.gz");
      const backup = await runCcm(["backup", "codex", archive], source);
      expect(backup.exitCode, backup.stderr).toBe(0);

      const dryRun = await runCcm(["restore", archive, "codex", "--dry-run", "--json"], target);
      const diff = await runCcm(["diff", "restore", archive, "codex", "--json"], target);

      expect(dryRun).toMatchObject({ exitCode: 0, stderr: "" });
      expect(diff).toMatchObject({ exitCode: 0, stderr: "" });
      expectExactProjection(JSON.parse(dryRun.stdout) as PlanJson, JSON.parse(diff.stdout));
      expect(await readFile(join(target.home, ".codex/config.toml"), "utf8")).toBe(
        'model = "target"\n',
      );
    } finally {
      await Promise.all([source.dispose(), target.dispose()]);
    }
  });

  it("emits redacted JSON errors with the original exit class", async () => {
    const machine = await createFakeMachine("ccm-diff-errors-");
    try {
      const secretTarget = "user:secret@example.test";
      const invalidPush = await runCcm(["diff", "push", "codex", secretTarget, "--json"], machine);
      expect(invalidPush).toMatchObject({ exitCode: 2, stderr: "" });
      expect(invalidPush.stdout).not.toContain(secretTarget);
      expect(JSON.parse(invalidPush.stdout)).toMatchObject({
        kind: "diff-error",
        migrationKind: "push",
        error: { code: "invalid-request", exitCode: 2 },
      });

      const missingArchive = join(machine.root, "secret-missing.tar.gz");
      const invalidRestore = await runCcm(
        ["diff", "restore", missingArchive, "codex", "--json"],
        machine,
      );
      expect(invalidRestore).toMatchObject({ exitCode: 3, stderr: "" });
      expect(invalidRestore.stdout).not.toContain(missingArchive);
      expect(JSON.parse(invalidRestore.stdout)).toMatchObject({
        kind: "diff-error",
        migrationKind: "restore",
        error: { code: "blocked", exitCode: 3 },
      });
    } finally {
      await machine.dispose();
    }
  });

  it("does not print a success object before SSH cleanup succeeds", async () => {
    const machine = await createFakeMachine("ccm-diff-cleanup-error-");
    let retainedRoot: string | undefined;
    try {
      await mkdir(join(machine.home, ".codex"), { recursive: true });
      await writeFile(join(machine.home, ".codex/config.toml"), 'model = "gpt-5.6"\n');
      await armFault(
        machine,
        "ssh:exit",
        { exitCode: 255, stderr: "cleanup failed\n" },
        { once: false },
      );

      const result = await runCcm(
        ["diff", "push", "codex", "operator@example.test", "--json"],
        machine,
      );
      expect(result).toMatchObject({ exitCode: 5, stderr: "" });
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        kind: "diff-error",
        migrationKind: "push",
        error: { code: "execution-failed", exitCode: 5 },
      });
      const controlPath = (await readCommandLog(machine))
        .flatMap(({ args }) =>
          args.flatMap((argument) => /-oControlPath=([^\s]+)/.exec(argument)?.[1] ?? []),
        )
        .at(0);
      expect(controlPath).toBeDefined();
      retainedRoot = dirname(controlPath as string);
    } finally {
      if (retainedRoot) await rm(retainedRoot, { recursive: true, force: true });
      await machine.dispose();
    }
  });
});

function expectExactProjection(plan: PlanJson, rawDiff: unknown): void {
  const diff = rawDiff as DiffJson;
  expect(diff).toMatchObject({
    kind: "diff",
    migrationKind: plan.kind,
    planId: plan.id,
    counts: { actions: plan.actions.length },
  });
  expect(diff.actions).toEqual(plan.actions);
  expect(diff.counts.changed).toBe(
    plan.actions.filter(
      (action) =>
        action.phase !== "materialize" &&
        action.disposition !== "unchanged" &&
        action.disposition !== "preserve",
    ).length,
  );
  expect(diff.counts.materializations).toBe(
    plan.actions.filter(
      (action) =>
        action.phase === "materialize" &&
        action.disposition !== "unchanged" &&
        action.disposition !== "preserve",
    ).length,
  );
  for (const disposition of ["create", "update", "merge", "unchanged", "preserve"] as const)
    expect(diff.counts.byDisposition[disposition]).toBe(
      plan.actions.filter((action) => action.disposition === disposition).length,
    );
}

import { type MigrationDiffProjection, projectMigrationDiff } from "../core/migration-diff.ts";
import { type CcmExitCode, CliError, ReportedCliError } from "../errors.ts";
import { createRuntimeContext } from "../runtime/context.ts";
import type { PushOptions } from "../types/index.ts";
import { withPushPlan } from "./push.ts";
import { prepareRestorePlan } from "./restore.ts";

interface DiffOptions {
  readonly json?: boolean;
}

interface DiffPushOptions extends DiffOptions {
  readonly profile?: string;
  readonly transport?: PushOptions["transport"];
  readonly providers?: string;
  readonly all?: boolean;
}

export async function diffPushCommand(
  arg1: string | undefined,
  arg2: string | undefined,
  options: DiffPushOptions,
): Promise<void> {
  await reportDiffErrors("push", options, async () => {
    const projection = await withPushPlan(
      arg1,
      arg2,
      {
        dryRun: true,
        json: options.json,
        profile: options.profile,
        transport: options.transport,
        providers: options.providers,
        all: options.all,
        skipVersionCheck: false,
      },
      async ({ planned }) => projectMigrationDiff(planned.plan),
    );
    printMigrationDiff(projection, options);
  });
}

export async function diffRestoreCommand(
  archive: string,
  provider: string | undefined,
  options: DiffOptions,
): Promise<void> {
  await reportDiffErrors("restore", options, async () => {
    const planned = await prepareRestorePlan(archive, provider, createRuntimeContext());
    printMigrationDiff(projectMigrationDiff(planned.plan), options);
  });
}

function printMigrationDiff(diff: MigrationDiffProjection, options: DiffOptions): void {
  if (options.json) {
    console.log(JSON.stringify(diff));
    return;
  }
  console.log(
    `${capitalize(diff.migrationKind)} diff ${diff.planId} (${diff.status}): ${diff.counts.changed}/${diff.counts.actions} planned managed-state change(s)`,
  );
  for (const action of diff.actions)
    console.log(`  ${action.phase}: ${action.operation} ${action.scope} (${action.disposition})`);
}

async function reportDiffErrors(
  migrationKind: "push" | "restore",
  options: DiffOptions,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!options.json) throw error;
    const exitCode: CcmExitCode = error instanceof CliError ? error.exitCode : 5;
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        kind: "diff-error",
        migrationKind,
        error: { code: diffErrorCode(exitCode), exitCode },
      }),
    );
    throw new ReportedCliError(exitCode, { cause: error });
  }
}

function diffErrorCode(exitCode: CcmExitCode): string {
  return (
    {
      1: "failed",
      2: "invalid-request",
      3: "blocked",
      4: "unreachable",
      5: "execution-failed",
    } as const
  )[exitCode];
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

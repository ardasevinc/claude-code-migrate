import { projectMigrationDiff } from "../core/migration-diff.ts";
import { renderMigrationPreview } from "../core/migration-preview.ts";
import { type CcmExitCode, CliError, ReportedCliError } from "../errors.ts";
import { createRuntimeContext } from "../runtime/context.ts";
import type { PushOptions } from "../types/index.ts";
import { withPushPlan } from "./push.ts";
import { prepareRestorePlan } from "./restore.ts";

interface DiffOptions {
  readonly json?: boolean;
  readonly verbose?: boolean;
}

interface DiffPushOptions extends DiffOptions {
  readonly profile?: string;
  readonly autoProfile?: boolean;
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
    const output = await withPushPlan(
      arg1,
      arg2,
      {
        dryRun: true,
        json: options.json,
        profile: options.profile,
        autoProfile: options.autoProfile,
        transport: options.transport,
        providers: options.providers,
        all: options.all,
        skipVersionCheck: false,
      },
      async ({ planned }) =>
        options.json
          ? JSON.stringify(projectMigrationDiff(planned.plan))
          : renderMigrationPreview(planned, options),
    );
    console.log(output);
  });
}

export async function diffRestoreCommand(
  archive: string,
  provider: string | undefined,
  options: DiffOptions,
): Promise<void> {
  await reportDiffErrors("restore", options, async () => {
    const planned = await prepareRestorePlan(archive, provider, createRuntimeContext());
    console.log(
      options.json
        ? JSON.stringify(projectMigrationDiff(planned.plan))
        : renderMigrationPreview(planned, options),
    );
  });
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

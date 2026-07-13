import { Command } from "commander";
import packageMetadata from "../package.json" with { type: "json" };
import { inspectCommand, verifyCommand } from "./commands/archive.ts";
import { backupCommand } from "./commands/backup.ts";
import { configCommand } from "./commands/config.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { pushCommand } from "./commands/push.ts";
import { restoreCommand } from "./commands/restore.ts";
import { recoverCommand, transactionsCommand } from "./commands/transactions.ts";

export function createCli(): Command {
  const program = new Command();

  program.exitOverride();

  program
    .name("ccm")
    .description("Migrate Claude Code and Codex configurations between machines")
    .version(packageMetadata.version);

  program
    .command("config")
    .description("Manage configuration")
    .option("--init", "Create default config file")
    .option("--path", "Show config file path")
    .action(configCommand);

  program
    .command("doctor")
    .description("Check local CCM health and optionally inspect one remote target")
    .option("--remote [target]", "Explicitly inspect a remote SSH target")
    .option("--json", "Print one JSON object", false)
    .action(doctorCommand);

  program
    .command("backup")
    .description("Create a local backup archive")
    .argument("[providerOrOutput]", "Provider name (claude|codex) or output path")
    .argument("[output]", "Output path when provider is specified")
    .option("--dry-run", "Preview files without creating archive", false)
    .option("--force", "Unconditionally replace an existing regular-file archive atomically", false)
    .option("--json", "Print one JSON object", false)
    .option("--verbose", "Show the full dry-run file list", false)
    .action(backupCommand);

  program
    .command("push")
    .description("Push configuration to a remote machine")
    .argument("[providerOrTarget]", "Provider name (claude|codex) or SSH target (user@host)")
    .argument("[target]", "SSH target (user@host) when provider is specified")
    .option("--dry-run", "Preview without transferring", false)
    .option("--json", "Print the push plan as one JSON object (dry-run only)", false)
    .option("--profile <name>", "Use an explicit host-bound profile")
    .option("--transport <mode>", "Transport mode: auto, rsync, or archive", "auto")
    .option("--skip-version-check", "Skip Claude version check", false)
    .option("--providers <providers>", "Comma-separated providers to push (claude,codex)")
    .option("--all", "Push all providers")
    .option("--verbose", "Show the full dry-run file list", false)
    .action(pushCommand);

  program
    .command("inspect")
    .description("Inspect a backup archive without extracting it")
    .argument("<archive>", "Path to archive")
    .option("--files", "Include archived file metadata", false)
    .option("--json", "Print one JSON object", false)
    .action(inspectCommand);

  program
    .command("verify")
    .description("Verify a backup archive without extracting it")
    .argument("<archive>", "Path to archive")
    .option("--json", "Print one JSON object", false)
    .action(verifyCommand);

  program
    .command("transactions")
    .description("List durable local CCM transactions")
    .option("--json", "Print one JSON object", false)
    .action(transactionsCommand);

  program
    .command("recover")
    .description("Resolve a durable local CCM transaction")
    .argument("<transaction>", "Canonical transaction ID")
    .option("--rollback", "Restore the journaled pre-state", false)
    .option("--accept", "Accept only the exact journaled post-state", false)
    .option("--json", "Print one JSON object", false)
    .action(recoverCommand);

  program
    .command("restore")
    .description("Restore from a backup archive")
    .argument("<archive>", "Path to archive")
    .argument("[provider]", "Optional provider (claude|codex)")
    .option("--dry-run", "Preview restore actions without writing files", false)
    .option("--json", "Print the restore plan as one JSON object (dry-run only)", false)
    .option("--verbose", "Show planned restore actions", false)
    .action(restoreCommand);

  return program;
}

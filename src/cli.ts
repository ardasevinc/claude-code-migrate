import { Command } from "commander";
import { backupCommand } from "./commands/backup.ts";
import { configCommand } from "./commands/config.ts";
import { pushCommand } from "./commands/push.ts";
import { restoreCommand } from "./commands/restore.ts";

export function createCli(): Command {
  const program = new Command();

  program
    .name("ccm")
    .description("Migrate Claude Code and Codex configurations between machines")
    .version("1.4.2");

  program
    .command("config")
    .description("Manage configuration")
    .option("--init", "Create default config file")
    .option("--path", "Show config file path")
    .action(configCommand);

  program
    .command("backup")
    .description("Create a local backup archive")
    .argument("[providerOrOutput]", "Provider name (claude|codex) or output path")
    .argument("[output]", "Output path when provider is specified")
    .option("--dry-run", "Preview files without creating archive", false)
    .action(backupCommand);

  program
    .command("push")
    .description("Push configuration to a remote machine")
    .argument("[providerOrTarget]", "Provider name (claude|codex) or SSH target (user@host)")
    .argument("[target]", "SSH target (user@host) when provider is specified")
    .option("--dry-run", "Preview without transferring", false)
    .option("--skip-version-check", "Skip Claude version check", false)
    .option("--providers <providers>", "Comma-separated providers to push (claude,codex)")
    .option("--all", "Push all providers")
    .action(pushCommand);

  program
    .command("restore")
    .description("Restore from a backup archive")
    .argument("<archive>", "Path to archive")
    .argument("[provider]", "Optional provider (claude|codex)")
    .option("--dry-run", "Preview restore actions without writing files", false)
    .action(restoreCommand);

  return program;
}

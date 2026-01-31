import { Command } from "commander";
import { configCommand } from "./commands/config.ts";
import { backupCommand } from "./commands/backup.ts";
import { pushCommand } from "./commands/push.ts";

export function createCli(): Command {
  const program = new Command();

  program
    .name("ccm")
    .description("Migrate Claude Code configurations between machines")
    .version("1.0.0");

  program
    .command("config")
    .description("Manage configuration")
    .option("--init", "Create default config file")
    .option("--path", "Show config file path")
    .action(configCommand);

  program
    .command("backup")
    .description("Create a local backup archive")
    .argument("[output]", "Output path for the archive")
    .option("--dry-run", "Preview files without creating archive", false)
    .action(backupCommand);

  program
    .command("push")
    .description("Push configuration to a remote machine")
    .argument("[target]", "SSH target (user@host)")
    .option("--dry-run", "Preview without transferring", false)
    .option("--skip-version-check", "Skip Claude version check", false)
    .action(pushCommand);

  return program;
}

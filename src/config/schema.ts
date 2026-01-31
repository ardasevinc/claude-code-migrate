import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();

export const CLAUDE_DIR = join(home, ".claude");
export const MCP_CONFIG_PATH = join(home, ".claude.json");
export const CONFIG_DIR = join(home, ".config", "claude-code-migrate");
export const CONFIG_PATH = join(CONFIG_DIR, "config.toml");

export const ALWAYS_INCLUDE = [
  "CLAUDE.md",
  "settings.json",
  "agents",
  "skills",
] as const;

export const INCLUDE_IF_EXISTS = [
  "statusline.ts",
  "statusline.sh",
  "keybindings.json",
  "hooks",
] as const;

export const NEVER_MIGRATE = [
  "plugins",
  "projects",
  "history.jsonl",
  "debug",
  "todos",
  "cache",
  "telemetry",
  "statsig",
  "shell-snapshots",
  "paste-cache",
  "file-history",
  "session-env",
  "plans",
  "tasks",
  "ide",
  "downloads",
] as const;

export const DEFAULT_CONFIG_TOML = `[target]
type = "ssh"
host = "user@example.com"
path = "~/.claude"

[include]
settings_local = false
mcp_config = true

[backup]
path = "~/backups/claude"
`;

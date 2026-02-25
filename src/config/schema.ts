import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();

export const CONFIG_DIR = join(home, ".config", "claude-code-migrate");
export const CONFIG_PATH = join(CONFIG_DIR, "config.toml");

export const DEFAULT_CONFIG_TOML = `[target]
type = "ssh"
host = "user@example.com"

[providers.claude]
enabled = true
settings_local = false
mcp_config = true

[providers.codex]
enabled = true

[backup]
path = "~/backups/ccm"
`;

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

# Host-aware Codex plugin policy. Built-in defaults already keep clearly
# platform-specific plugins off incompatible hosts.
# [providers.codex.plugin_policies."build-ios-apps@openai-curated"]
# mode = "auto" # auto | always | never | preserve
# os = ["darwin"]
# commands = ["xcodebuild"]

[backup]
path = "~/backups/ccm"

# A unique profile whose host matches the target is selected automatically.
# Use --profile <name> to choose explicitly or --no-auto-profile to opt out.
# [profiles.devbox]
# host = "user@devbox"
# claude_md = "profiles/devbox/CLAUDE.md"
# agents_md = "profiles/devbox/AGENTS.md"
`;

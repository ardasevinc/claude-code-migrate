# ccm - Claude Code Migrate

CLI tool for migrating Claude Code configurations between machines via SSH/SCP or local backup archives.

## Installation

```bash
bun install
bun link  # makes `ccm` available globally
```

## Usage

### Initialize config
```bash
ccm config --init
# Edit ~/.config/claude-code-migrate/config.toml
```

### Backup locally
```bash
ccm backup                    # Creates timestamped archive
ccm backup ./my-backup.tar.gz # Custom path
ccm backup --dry-run          # Preview files
```

### Push to remote machine
```bash
ccm push user@host           # Push to specific host
ccm push                     # Use host from config
ccm push --dry-run           # Preview without transferring
ccm push --skip-version-check
```

## What gets migrated

**Always included:**
- `~/.claude/CLAUDE.md`
- `~/.claude/settings.json`
- `~/.claude/agents/`
- `~/.claude/skills/`

**Included if they exist:**
- `~/.claude/statusline.ts`
- `~/.claude/statusline.sh`
- `~/.claude/keybindings.json`
- `~/.claude/hooks/`

**Optional (via config):**
- `~/.claude/settings.local.json`
- `~/.claude.json` (MCP servers only - merged into remote's existing config)

**Never migrated:**
- `plugins/`, `projects/`, `history.jsonl`, `cache/`, `todos/`, etc.

## Config file

Located at `~/.config/claude-code-migrate/config.toml`:

```toml
[target]
type = "ssh"
host = "user@example.com"
path = "~/.claude"

[include]
settings_local = false
mcp_config = true

[backup]
path = "~/backups/claude"
```

## How it works

1. Collects files from `~/.claude/` (resolves symlinks, follows symlink-to-directory)
2. Creates tar.gz archive with manifest
3. For push: uploads via scp, extracts, bulk-copies to destination
4. MCP servers from `~/.claude.json` are **merged** into remote's existing config (local wins on conflicts, other keys preserved)

### MCP server migration

Only the `mcpServers` object is extracted from your local `~/.claude.json` - not the entire file. On the remote, these servers are merged into the existing config rather than overwriting it.

Servers with paths (absolute, relative, or `~/`) will trigger a warning since they may not exist on the target machine.

## License

MIT

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
- `~/.claude.json` (MCP config)

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
4. MCP config (`~/.claude.json`) goes to home dir, not inside `.claude/`

## License

MIT

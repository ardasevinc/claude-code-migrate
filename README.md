# ccm - Claude Code Migrate

CLI tool for migrating AI CLI configurations between machines via SSH/SCP or local backup archives.

Versioning:
- Package uses semver (`1.2.0`, etc.)
- Git release tags use `vX.Y.Z` (example: `v1.2.0`)

Launch providers:
- `claude` (`~/.claude`)
- `codex` (`~/.codex`)

Shared skills are migrated from `~/.agents/skills` when any provider is active.

## Installation

```bash
bun install
bun link
```

## Usage

### Initialize config

```bash
ccm config --init
# Edit ~/.config/claude-code-migrate/config.toml
```

### Backup

```bash
ccm backup                      # all enabled providers + shared
ccm backup codex                # codex + shared
ccm backup codex ./out.tar.gz   # codex + shared to custom path
ccm backup ./out.tar.gz         # all enabled providers + shared
ccm backup --dry-run
```

### Push

```bash
ccm push                        # all enabled providers + shared (host from config)
ccm push codex                  # codex + shared
ccm push user@host              # all enabled providers + shared
ccm push claude user@host       # claude + shared
ccm push --dry-run
```

### Restore

```bash
ccm restore ./ccm-backup.tar.gz        # restore all providers in archive
ccm restore ./ccm-backup.tar.gz codex  # restore only codex
ccm restore ./ccm-backup.tar.gz --dry-run
```

## Config file

Location: `~/.config/claude-code-migrate/config.toml`

```toml
[target]
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
```

## Full Gate

```bash
bun run full-gate
```

`full-gate` runs Biome lint, Biome format check, TypeScript typecheck, and Vitest.

Useful scripts:

```bash
bun run test        # Vitest once
bun run test:watch  # Vitest watch mode
bun run check       # alias for gate
```

## License

MIT

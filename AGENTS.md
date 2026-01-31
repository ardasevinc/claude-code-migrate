# CCM Agent Guide

CLI tool: `ccm` - migrates Claude Code configs between machines.

## Stack
- **Runtime**: Bun (not Node)
- **CLI**: Commander
- **Config**: TOML via smol-toml

## Structure

```
src/
├── index.ts          # Entry point
├── cli.ts            # Commander setup
├── commands/         # CLI commands
│   ├── backup.ts     # Local archive creation
│   ├── push.ts       # SSH push to remote
│   └── config.ts     # Config management
├── core/
│   ├── collector.ts  # File discovery & symlink handling
│   ├── archiver.ts   # Tar.gz creation
│   ├── ssh.ts        # SSH/SCP operations
│   └── version-checker.ts
├── config/
│   ├── schema.ts     # CLAUDE_DIR, paths, include/exclude lists
│   ├── loader.ts     # TOML config loading
│   └── defaults.ts
├── types/index.ts    # TypeScript interfaces
└── utils/logger.ts   # Chalk-based logging
```

## Key files

- `config/schema.ts`: defines `ALWAYS_INCLUDE`, `INCLUDE_IF_EXISTS`, `NEVER_MIGRATE` lists
- `core/collector.ts`: handles symlink-to-directory resolution via `realpath()` + stat
- `core/ssh.ts`: bulk copy via single `cp -r` (not per-file)

## Commands

```bash
bun src/index.ts backup --dry-run
bun src/index.ts push user@host --dry-run
bun src/index.ts config --init
```

## Testing

```bash
bun test  # No tests yet
```

## Notes

- MCP config (`.mcp-config.json` in archive) → `~/.claude.json` on remote (not inside `~/.claude/`)
- Symlinks are resolved and contents copied (not preserved as symlinks)
- `lstat()` used throughout - remember it returns symlink stats, not target stats

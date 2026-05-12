# CCM Agent Guide

CLI tool: `ccm` - migrates AI CLI configs between machines.

Current release line: `1.x` (semver tags use `vX.Y.Z`).

## Stack
- **Runtime**: Bun (not Node)
- **CLI**: Commander
- **Config**: TOML via smol-toml

## Scope
- Providers at launch: `claude`, `codex`
- Shared skills source: `~/.agents/skills`
- Shared lazy skills source: `~/.agents/lazy-skills`
- Shared skill lock file: `~/.agents/.skill-lock.json`

## Structure

```text
src/
├── index.ts
├── cli.ts
├── commands/
│   ├── backup.ts
│   ├── push.ts
│   ├── restore.ts
│   └── config.ts
├── core/
│   ├── arg-parser.ts
│   ├── collector.ts
│   ├── archiver.ts
│   ├── restore.ts
│   ├── ssh.ts
│   ├── mcp.ts
│   └── version-checker.ts
├── config/
│   ├── providers.ts
│   ├── schema.ts
│   ├── loader.ts
│   └── defaults.ts
├── types/index.ts
└── utils/logger.ts
```

## Key files
- `config/providers.ts`: provider definitions, include/exclude rules, shared paths
- `core/collector.ts`: provider-aware collection, shared skill dedup for Claude symlinks
- `core/ssh.ts`: remote deploy, Claude MCP merge, shared skill symlink recreation
- `core/restore.ts`: local restore flow with provider filtering and dry-run support

## Commands

```bash
bun src/index.ts backup --dry-run
bun src/index.ts backup codex --dry-run
bun src/index.ts push claude user@host --dry-run
bun src/index.ts restore ./ccm-backup.tar.gz codex --dry-run
bun src/index.ts config --init
```

## Testing

```bash
bun run check
```

`check` = Biome + typecheck + tests.

## Notes
- Archive layout is provider-scoped: `claude/`, `codex/`, `shared/agents/`
- Claude MCP data is extracted to `claude/.mcp-config.json` in archive and merged into remote `~/.claude.json`
- Shared skills and lazy skills are synced to `~/.agents/skills` and `~/.agents/lazy-skills`; Claude shared-skill symlinks are recreated in `~/.claude/skills`
- Remote paths are convention-based (`~/.claude`, `~/.codex`, `~/.agents`) and not configurable

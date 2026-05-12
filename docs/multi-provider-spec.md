# Multi-Provider Migration Spec

> ccm v2: extending claude-code-migrate to support multiple AI CLI tools.

## Overview

ccm evolves from a Claude Code-only config migrator into a multi-provider AI CLI config migration tool. The architecture uses a **provider pattern** where each supported tool defines its own base directory, include/exclude lists, and special handling logic.

### Providers at Launch

| Provider | Base Directory | Description |
|----------|---------------|-------------|
| `claude` | `~/.claude` | Anthropic Claude Code CLI |
| `codex` | `~/.codex` | OpenAI Codex CLI |

**Shared agent assets** (`~/.agents/skills/`, `~/.agents/lazy-skills/`) are not a standalone provider. They are a dependency automatically pulled in when any provider that uses them is active.

---

## Provider Definitions

### Claude

**Base directory**: `~/.claude`

**Always include**:
- `CLAUDE.md`
- `settings.json`
- `agents/`
- `skills/` (native skills only — symlinks to `~/.agents/` are excluded)

**Include if exists**:
- `statusline.ts`
- `statusline.sh`
- `keybindings.json`
- `hooks/`

**Never migrate**:
- `plugins/`
- `projects/`
- `history.jsonl`
- `debug/`
- `todos/`
- `cache/`
- `telemetry/`
- `statsig/`
- `shell-snapshots/`
- `paste-cache/`
- `file-history/`
- `session-env/`
- `plans/`
- `tasks/`
- `ide/`
- `downloads/`

**Special handling**:
- **MCP config**: Extracted from `~/.claude.json` (separate file). Only the `mcpServers` key is extracted. Path-dependent entries produce warnings.
- **Shared skills dedup**: Skills in `~/.claude/skills/` that are symlinks pointing into `~/.agents/skills/` are detected and excluded from Claude's collection. They are shipped once via the shared skills mechanism.
- **Symlink reconstruction**: On the remote, symlinks are recreated in `~/.claude/skills/` pointing to `~/.agents/skills/` for shared skills.

### Codex

**Base directory**: `~/.codex`

**Always include**:
- `config.toml` (shipped wholesale, including MCP config)
- `AGENTS.md`
- `agents/`
- `rules/`
- `skills/`

**Include if exists**:
- `AGENTS.override.md`

**Never migrate**:
- `auth.json`
- `history.jsonl`
- `log/`
- `sessions/`
- `shell_snapshots/`
- `models_cache.json`
- `tmp/`
- `version.json`
- `.personality_migration`

**Special handling**:
- **MCP config**: Embedded in `config.toml`. The file is migrated wholesale, but path-dependent MCP entries are detected and produce warnings (TOML-aware parsing).
- **Shared skills**: Codex reads from `~/.agents/skills/` and `~/.agents/lazy-skills/` natively (no symlinks needed). When the codex provider is active, shared agent assets are automatically included.

---

## Shared Agent Assets (`~/.agents/`)

Shared agent assets live under `~/.agents/` and are consumed by multiple AI CLI tools:
- **Codex**: Reads from `~/.agents/skills/` and `~/.agents/lazy-skills/` natively via convention.
- **Claude Code**: Accesses via symlinks in `~/.claude/skills/` (created by the Vercel skills tooling or manually).

### What gets migrated
- All skill directories under `~/.agents/skills/`
- All lazy skill directories under `~/.agents/lazy-skills/`
- `~/.agents/.skill-lock.json` (skill registry/metadata)

### Behavior
- Shared skills are **not a standalone provider**. They cannot be pushed independently.
- They are pulled in as a dependency when any enabled provider uses them.
- `ccm push` (all providers) ships shared skills once.
- `ccm push codex` ships codex config + shared skills.
- `ccm push claude` ships claude config + shared skills.

### Remote deployment
- Files are copied to `~/.agents/skills/` on the remote.
- Lazy skills are copied to `~/.agents/lazy-skills/` on the remote.
- `.skill-lock.json` is copied to `~/.agents/`.
- For Claude Code: symlinks are created in `~/.claude/skills/` pointing to `~/.agents/skills/{skill}` for each shared skill.
- For Codex: no symlinks needed (reads from `~/.agents/` directly).

### Cross-provider dedup
When collecting Claude's `skills/` directory, any symlink whose target resolves into `~/.agents/skills/` is excluded from Claude's file list. The actual content is shipped once via the shared skills mechanism, avoiding duplication in archives.

---

## CLI Surface

### Commands

```
ccm push [provider] [target]    Push config to a remote machine
ccm backup [provider] [output]  Create a local backup archive
ccm restore <archive> [provider] Restore from a backup archive
ccm config --init               Create default config file
```

- `ccm push` — pushes all enabled providers + shared skills
- `ccm push codex` — pushes only codex + shared skills
- `ccm push claude` — pushes only claude + shared skills
- `ccm push user@host` — pushes all to specific host (overrides config)
- `ccm push codex user@host` — pushes codex to specific host

### Backup archives

A single combined archive with provider-separated internal structure:

```
ccm-backup-2026-02-25.tar.gz
├── claude/
│   ├── CLAUDE.md
│   ├── settings.json
│   ├── skills/
│   │   └── dokploy/        # native skills only
│   └── ...
├── codex/
│   ├── config.toml
│   ├── AGENTS.md
│   ├── agents/
│   ├── rules/
│   └── ...
└── shared/
    └── agents/
        ├── .skill-lock.json
        ├── lazy-skills/
        │   └── browser-use/
        │       └── ...
        └── skills/
            ├── find-skills/
            ├── interview/
            └── ...
```

- `ccm backup` — archives all providers
- `ccm backup codex` — archives only codex + shared skills
- `ccm restore archive.tar.gz` — restores everything
- `ccm restore archive.tar.gz codex` — restores only codex from archive
- `ccm restore archive.tar.gz --dry-run` — previews restore actions

---

## Configuration

**Location**: `~/.config/claude-code-migrate/config.toml`

```toml
[target]
type = "ssh"
host = "user@example.com"

[providers.claude]
enabled = true
mcp_config = true
settings_local = false

[providers.codex]
enabled = true

[backup]
path = "~/backups/ccm"
```

### Fields

- `target.type` — Connection type. Only `"ssh"` supported.
- `target.host` — Default SSH target (`user@host`). Overridable via CLI argument.
- `providers.<name>.enabled` — Whether this provider is included in default (no-argument) operations.
- `providers.claude.mcp_config` — Whether to extract and migrate MCP server config from `~/.claude.json`.
- `providers.claude.settings_local` — Whether to include `settings.local.json`.
- `backup.path` — Default output directory for backup archives.

Remote paths (`~/.claude`, `~/.codex`, `~/.agents`) are convention-based per provider and not configurable.

---

## Architecture

### Provider Pattern

Each provider implements a common interface:

```typescript
interface Provider {
  name: string;
  baseDir: string;                    // e.g. ~/.codex
  remoteDir: string;                  // e.g. ~/.codex
  alwaysInclude: string[];
  includeIfExists: string[];
  neverMigrate: string[];
  collectFiles(options): FileEntry[];
  getSharedSkillsDependency(): boolean;
  specialHandlers?: SpecialHandler[];  // MCP extraction, symlink detection, etc.
}
```

### Shared skills as dependency

Shared skills collection is triggered by provider dependency, not by direct invocation:

```
push command
  → resolve target providers (all or specified)
  → for each provider: collect files
  → if any provider declares shared skills dependency:
      → collect ~/.agents/skills/ (once)
      → collect ~/.agents/lazy-skills/ (once)
      → collect ~/.agents/.skill-lock.json
  → deduplicate (remove claude symlinks that point to shared skills)
  → archive and push
  → on remote: deploy files + recreate symlinks where needed
```

### Symlink handling

| Scenario | Collection | Deployment |
|----------|-----------|------------|
| Claude native skill (e.g. `dokploy/`) | Collected under claude provider | Copied to `~/.claude/skills/` |
| Claude symlinked skill → `~/.agents/skills/X` | Skipped in claude collection | Symlink created: `~/.claude/skills/X -> ~/.agents/skills/X` |
| Shared skill in `~/.agents/skills/` | Collected as shared dependency | Copied to `~/.agents/skills/` |
| Lazy skill in `~/.agents/lazy-skills/` | Collected as shared dependency | Copied to `~/.agents/lazy-skills/` |
| Codex skill in `~/.codex/skills/` | Collected under codex provider | Copied to `~/.codex/skills/` |

# ccm - Claude Code Migrate

CLI tool for syncing portable Claude Code and Codex setup between machines via SSH/SCP or local
backup archives.

`ccm` is intentionally not a dotdir mirror. It ships the parts of an agent setup that should travel
between hosts, preserves runtime state on the target, and adapts known machine-specific Codex
settings after copy.

Versioning:
- Package uses semver (`1.2.0`, etc.)
- Git release tags use `vX.Y.Z` (example: `v1.2.0`)

Providers:
- `claude` (`~/.claude`)
- `codex` (`~/.codex`)

Shared skills are migrated from `~/.agents/skills` and `~/.agents/lazy-skills` when any provider is active.

## What Syncs

`ccm push` uses overlay semantics: it overwrites/adds selected portable config on the target host,
but does not delete remote-only runtime state such as auth, sessions, logs, history, caches, and
local databases.

Portable surfaces today:

- Claude: `CLAUDE.md`, `settings.json`, `agents/`, native `skills/`, hooks/statusline/keybindings
  when present, and selected MCP config from `~/.claude.json`
- Codex: `config.toml`, `AGENTS.md`, `agents/`, `rules/`, `skills/` except `skills/.system`, and
  local Codex marketplace sources referenced from `config.toml`
- Shared agents: `~/.agents/skills/`, `~/.agents/lazy-skills/`, and
  `~/.agents/.skill-lock.json`

Runtime/local state is not migrated broadly. For example, `auth.json`, sessions, logs, SQLite state,
plugin data, and local caches are preserved on the target.

After pushing Codex, ccm normalizes path-based Codex MCP `command` values when the same binary is
available on the remote `PATH`.

## Host-Aware Codex Plugins

Codex plugin enablement is host-aware. ccm copies portable marketplace sources, probes the target
host, evaluates enabled plugins against policy, and installs missing allowed plugins through the
remote `codex plugin add` command.

Built-in policy keeps clearly platform-specific plugins off incompatible hosts:

| Plugin | Default policy |
| --- | --- |
| `build-ios-apps@openai-curated` | macOS + `xcodebuild` |
| `build-macos-apps@openai-curated` | macOS + `xcodebuild` |
| `test-android-apps@openai-curated` | `adb` available |
| `computer-use@openai-bundled` | macOS GUI host |

Unknown enabled plugins are treated as portable by default. Disallowed plugins are disabled in the
target `config.toml`; they are not uninstalled from the target cache.

`ccm push --dry-run` stays non-mutating, but for Codex it now also probes the target and previews
plugin policy/install decisions.

## Installation

Install the published CLI:

```bash
bun add -g claude-code-migrate
# or
npm install -g claude-code-migrate
```

ccm runs on Bun 1.3.14 or newer on macOS and Linux. npm is a supported installation channel;
using `npm install` does not make the CLI compatible with the Node.js runtime.

For local development from a checkout:

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

New backups use the v2 archive manifest. It records the producing ccm version and, for every
payload file, its canonical path, size, mode, and SHA-256 digest. ccm verifies the finished archive
before publishing it.

### Inspect and verify

```bash
ccm inspect ./ccm-backup.tar.gz          # metadata summary, no destination extraction
ccm inspect ./ccm-backup.tar.gz --files  # include file metadata
ccm inspect ./ccm-backup.tar.gz --json
ccm verify ./ccm-backup.tar.gz
ccm verify ./ccm-backup.tar.gz --json
```

`inspect` exits `0` for a structurally valid v1 or v2 archive. `verify` exits `0` only when v2 file
integrity is verified, `1` for a valid legacy v1 archive whose integrity metadata is unavailable,
and `3` for an invalid, unreadable, or unsupported archive. JSON output follows the same exit
semantics and is suitable for automation.

Legacy v1 backups remain restorable throughout the ccm 1.x release line. To upgrade one, restore
it with a trusted 1.x ccm installation, review the restored files, then create a fresh v2 backup.
Do not treat that conversion as retroactive verification of the v1 archive.

Archive reads and restores use bounded streaming extraction. ccm rejects unsafe paths and entry
types, duplicate or non-portable destinations, malformed manifests, integrity mismatches, and
archives that exceed its compressed, expanded, per-file, entry-count, manifest, or path limits.

Successful and failed mutating restores and pushes also write private execution receipts under
`${XDG_STATE_HOME:-~/.local/state}/ccm/receipts/`. Use the canonical `rcpt_...` filename stem:

```bash
ccm inspect rcpt_0123456789abcdef0123456789abcdef
ccm inspect rcpt_0123456789abcdef0123456789abcdef --json
ccm verify rcpt_0123456789abcdef0123456789abcdef
ccm verify rcpt_0123456789abcdef0123456789abcdef --remote arda@devbox
```

Receipt verification re-observes only the receipt's symbolic managed roots and, when applicable,
Codex plugin state, then compares fingerprints; it does not print file contents. Push receipts
require the original target through `--remote`, and the target must match the receipt's redacted
endpoint binding. Older schema-v1 receipts remain inspectable but report drift verification as
unavailable because they do not carry an observation scope.

### Push

```bash
ccm push                        # all enabled providers + shared (host from config)
ccm push codex                  # codex + shared
ccm push user@host              # all enabled providers + shared
ccm push claude user@host       # claude + shared
ccm push --all user@host        # all providers + shared, regardless of config enablement
ccm push --providers claude,codex user@host
ccm push codex user@host --dry-run           # compact transfer + Codex plugin plan
ccm push codex user@host --dry-run --verbose # full file list when needed
```

### Restore

```bash
ccm restore ./ccm-backup.tar.gz        # restore all providers in archive
ccm restore ./ccm-backup.tar.gz codex  # restore only codex
ccm restore ./ccm-backup.tar.gz --dry-run
```

Restored Codex hook trust is deliberately removed. Review the restored hook commands and approve
them again on the destination host before relying on them.

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

# Optional host-aware Codex plugin overrides.
# Built-in defaults already handle obvious platform-specific OpenAI plugins.
# mode: auto | always | never | preserve
#
# [providers.codex.plugin_policies."build-ios-apps@openai-curated"]
# mode = "auto"
# os = ["darwin"]
# commands = ["xcodebuild"]
#
# [providers.codex.plugin_policies."computer-use@openai-bundled"]
# mode = "never"

[backup]
path = "~/backups/ccm"
```

Codex plugin policy fields:

- `mode = "auto"` evaluates optional host requirements.
- `mode = "always"` keeps the plugin enabled and installs it if available.
- `mode = "never"` disables the plugin on the target.
- `mode = "preserve"` restores the target's previous enabled/disabled value after overlay copy.
- `os = ["darwin" | "linux" | "windows"]` restricts `auto` to specific operating systems.
- `commands = ["xcodebuild"]` requires commands to resolve with `command -v` on the target.
- `gui = true` requires a GUI-capable target.

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

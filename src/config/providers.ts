import { homedir } from "node:os";
import { join } from "node:path";
import type { CollectionPaths, ProviderName } from "../types/index.ts";

export interface ProviderDefinition {
  name: ProviderName;
  baseDir: string;
  remoteDir: string;
  alwaysInclude: string[];
  includeIfExists: string[];
  neverMigrate: string[];
  neverMigratePaths?: string[];
  usesSharedSkills: boolean;
}

const home = homedir();

export const PROVIDER_NAMES: ProviderName[] = ["claude", "codex"];

export const CLAUDE_DIR = join(home, ".claude");
export const CODEX_DIR = join(home, ".codex");
export const CLAUDE_MCP_CONFIG_PATH = join(home, ".claude.json");

export const SHARED_AGENTS_DIR = join(home, ".agents");
export const SHARED_SKILLS_DIR = join(SHARED_AGENTS_DIR, "skills");
export const SHARED_LAZY_SKILLS_DIR = join(SHARED_AGENTS_DIR, "lazy-skills");
export const SHARED_SKILL_LOCK_PATH = join(SHARED_AGENTS_DIR, ".skill-lock.json");

export const SHARED_ARCHIVE_PREFIX = "shared/agents";
export const SHARED_MANAGED_ENTRIES = ["skills", "lazy-skills", ".skill-lock.json"];

export function collectionPathsForHome(home: string): CollectionPaths {
  const sharedAgentsDir = join(home, ".agents");
  return {
    claudeDir: join(home, ".claude"),
    codexDir: join(home, ".codex"),
    claudeMcpConfigPath: join(home, ".claude.json"),
    sharedAgentsDir,
    sharedSkillsDir: join(sharedAgentsDir, "skills"),
    sharedLazySkillsDir: join(sharedAgentsDir, "lazy-skills"),
    sharedSkillLockPath: join(sharedAgentsDir, ".skill-lock.json"),
  };
}

export const DEFAULT_COLLECTION_PATHS: CollectionPaths = collectionPathsForHome(home);

export const PROVIDERS: Record<ProviderName, ProviderDefinition> = {
  claude: {
    name: "claude",
    baseDir: CLAUDE_DIR,
    remoteDir: "~/.claude",
    alwaysInclude: ["CLAUDE.md", "settings.json", "agents", "skills"],
    includeIfExists: ["statusline.ts", "statusline.sh", "keybindings.json", "hooks"],
    neverMigrate: [
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
    ],
    usesSharedSkills: true,
  },
  codex: {
    name: "codex",
    baseDir: CODEX_DIR,
    remoteDir: "~/.codex",
    alwaysInclude: ["config.toml", "AGENTS.md", "agents", "rules", "skills"],
    includeIfExists: ["AGENTS.override.md", "hooks.json"],
    neverMigrate: [
      "auth.json",
      "history.jsonl",
      "log",
      "sessions",
      "shell_snapshots",
      "models_cache.json",
      "tmp",
      "version.json",
      ".personality_migration",
    ],
    neverMigratePaths: ["skills/.system"],
    usesSharedSkills: true,
  },
};

export function isProviderName(value: string | undefined): value is ProviderName {
  return value !== undefined && PROVIDER_NAMES.includes(value as ProviderName);
}

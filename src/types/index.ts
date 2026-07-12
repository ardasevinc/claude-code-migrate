export type ProviderName = "claude" | "codex";

export interface Config {
  target: {
    type: "ssh";
    host: string;
  };
  providers: {
    claude: {
      enabled: boolean;
      settings_local: boolean;
      mcp_config: boolean;
    };
    codex: {
      enabled: boolean;
      plugin_policies: Record<string, CodexPluginPolicy>;
    };
  };
  backup: {
    path: string;
  };
}

export type CodexPluginPolicyMode = "auto" | "always" | "never" | "preserve";

export interface CodexPluginPolicy {
  mode: CodexPluginPolicyMode;
  os?: string[];
  commands?: string[];
  gui?: boolean;
}

export interface FileEntry {
  sourcePath: string;
  relativePath: string;
  isSymlink: boolean;
  originalSymlinkTarget?: string;
  mcpServersOnly?: string;
}

export interface LegacyArchiveManifest {
  version: string;
  timestamp: string;
  sourceHost: string;
  claudeVersion: string | null;
  providers: ProviderName[];
  files: FileEntry[];
}

export interface ArchiveManifestV2File {
  path: string;
  type: "file";
  size: number;
  mode: number;
  sha256: string;
}

export interface ArchiveManifestV2 {
  formatVersion: 2;
  createdAt: string;
  producer: {
    name: "claude-code-migrate";
    version: string;
  };
  providers: ProviderName[];
  files: ArchiveManifestV2File[];
}

export type ArchiveManifest = LegacyArchiveManifest | ArchiveManifestV2;
export type Manifest = LegacyArchiveManifest;

export interface CollectionPaths {
  claudeDir: string;
  codexDir: string;
  claudeMcpConfigPath: string;
  sharedAgentsDir: string;
  sharedSkillsDir: string;
  sharedLazySkillsDir: string;
  sharedSkillLockPath: string;
}

export interface CollectorOptions {
  providers: ProviderName[];
  includeClaudeSettingsLocal: boolean;
  includeClaudeMcpConfig: boolean;
  dryRun?: boolean;
  paths?: Partial<CollectionPaths>;
}

export interface PushOptions {
  dryRun: boolean;
  skipVersionCheck: boolean;
  providers?: string;
  all?: boolean;
  verbose?: boolean;
}

export interface BackupOptions {
  dryRun: boolean;
  force: boolean;
}

export interface RestoreOptions {
  dryRun: boolean;
}

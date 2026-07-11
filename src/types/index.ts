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

export interface Manifest {
  version: string;
  timestamp: string;
  sourceHost: string;
  claudeVersion: string | null;
  providers: ProviderName[];
  files: FileEntry[];
}

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

import type { RuntimeContext } from "../runtime/context.ts";

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
  profiles: Record<string, HostProfile>;
}

export type StructuredScalar = string | number | bigint | boolean | null | Date;
export type StructuredValue =
  | StructuredScalar
  | StructuredValue[]
  | { [key: string]: StructuredValue };

export interface StructuredPatch {
  unset?: string[];
  set?: Record<string, StructuredValue>;
}

export interface HostProfile {
  host: string;
  claude_md?: string;
  agents_md?: string;
  claude?: {
    settings?: StructuredPatch;
  };
  codex?: {
    config?: StructuredPatch;
    plugin_policies?: Record<string, CodexPluginPolicy>;
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

export interface VerifiedArchiveFile {
  path: string;
  size: number;
  mode: number;
  sha256?: string;
}

export interface VerifiedArchive {
  format: "v1" | "v2";
  integrity: "verified" | "unavailable";
  providers: ProviderName[];
  producerVersion: string;
  createdAt: string;
  archiveSha256: string;
  compressedBytes: number;
  expandedBytes: number;
  payloadBytes: number;
  entryCount: number;
  files: VerifiedArchiveFile[];
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
  quiet?: boolean;
  paths?: Partial<CollectionPaths>;
  context?: RuntimeContext;
}

export interface PushOptions {
  dryRun: boolean;
  json?: boolean;
  profile?: string;
  skipVersionCheck: boolean;
  providers?: string;
  all?: boolean;
  verbose?: boolean;
}

export interface BackupOptions {
  dryRun: boolean;
  force: boolean;
  json?: boolean;
  verbose?: boolean;
}

export interface RestoreOptions {
  dryRun: boolean;
  json?: boolean;
  verbose?: boolean;
}

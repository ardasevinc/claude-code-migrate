export interface Config {
  target: {
    type: "ssh";
    host: string;
    path: string;
  };
  include: {
    settings_local: boolean;
    mcp_config: boolean;
  };
  backup: {
    path: string;
  };
}

export interface FileEntry {
  sourcePath: string;
  relativePath: string;
  isSymlink: boolean;
  originalSymlinkTarget?: string;
}

export interface Manifest {
  version: string;
  timestamp: string;
  sourceHost: string;
  claudeVersion: string | null;
  files: FileEntry[];
}

export interface CollectorOptions {
  includeSettingsLocal: boolean;
  includeMcpConfig: boolean;
  dryRun?: boolean;
}

export interface PushOptions {
  dryRun: boolean;
  skipVersionCheck: boolean;
  target?: string;
}

export interface BackupOptions {
  dryRun: boolean;
  output?: string;
}

import type { Config } from "../types/index.ts";

export const DEFAULT_CONFIG: Config = {
  target: {
    type: "ssh",
    host: "user@example.com",
  },
  providers: {
    claude: {
      enabled: true,
      settings_local: false,
      mcp_config: true,
    },
    codex: {
      enabled: true,
    },
  },
  backup: {
    path: "~/backups/ccm",
  },
};

import type { Config } from "../types/index.ts";

export const DEFAULT_CONFIG: Config = {
  target: {
    type: "ssh",
    host: "user@example.com",
    path: "~/.claude",
  },
  include: {
    settings_local: false,
    mcp_config: true,
  },
  backup: {
    path: "~/backups/claude",
  },
};

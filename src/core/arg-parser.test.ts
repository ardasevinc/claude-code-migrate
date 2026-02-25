import { describe, expect, it } from "bun:test";
import type { Config, ProviderName } from "../types/index.ts";
import {
  getEnabledProviders,
  resolveBackupArguments,
  resolvePushArguments,
  resolveRestoreProvider,
} from "./arg-parser.ts";

function makeConfig(enabled: ProviderName[]): Config {
  return {
    target: { type: "ssh", host: "user@example.com" },
    providers: {
      claude: {
        enabled: enabled.includes("claude"),
        settings_local: false,
        mcp_config: true,
      },
      codex: {
        enabled: enabled.includes("codex"),
      },
    },
    backup: { path: "~/backups/ccm" },
  };
}

describe("arg-parser", () => {
  it("resolves enabled providers from config", () => {
    const config = makeConfig(["claude", "codex"]);
    expect(getEnabledProviders(config)).toEqual(["claude", "codex"]);
  });

  it("resolves push arguments for provider + target", () => {
    const resolved = resolvePushArguments("codex", "user@host", ["claude", "codex"]);
    expect(resolved.providers).toEqual(["codex"]);
    expect(resolved.target).toBe("user@host");
  });

  it("resolves push arguments for target-only", () => {
    const resolved = resolvePushArguments("user@host", undefined, ["claude", "codex"]);
    expect(resolved.providers).toEqual(["claude", "codex"]);
    expect(resolved.target).toBe("user@host");
  });

  it("rejects ambiguous push args", () => {
    expect(() => resolvePushArguments("user@host", "other", ["claude"])).toThrow();
  });

  it("resolves backup arguments", () => {
    const resolved = resolveBackupArguments("claude", "./out.tar.gz", ["claude", "codex"]);
    expect(resolved.providers).toEqual(["claude"]);
    expect(resolved.output).toBe("./out.tar.gz");
  });

  it("resolves restore provider", () => {
    expect(resolveRestoreProvider("claude")).toBe("claude");
    expect(resolveRestoreProvider(undefined)).toBeUndefined();
    expect(() => resolveRestoreProvider("unknown")).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import {
  getEnabledProviders,
  resolveBackupArguments,
  resolvePushArguments,
  resolveRestoreProvider,
} from "../../src/core/arg-parser.ts";
import type { Config, ProviderName } from "../../src/types/index.ts";

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
        plugin_policies: {},
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

  it("resolves explicit push provider lists", () => {
    const resolved = resolvePushArguments("user@host", undefined, ["claude"], {
      providers: "claude,codex",
    });

    expect(resolved.providers).toEqual(["claude", "codex"]);
    expect(resolved.target).toBe("user@host");
  });

  it("deduplicates explicit push provider lists", () => {
    const resolved = resolvePushArguments("user@host", undefined, ["claude"], {
      providers: "claude,codex,claude",
    });

    expect(resolved.providers).toEqual(["claude", "codex"]);
  });

  it("resolves all push providers", () => {
    const resolved = resolvePushArguments("user@host", undefined, ["claude"], { all: true });

    expect(resolved.providers).toEqual(["claude", "codex"]);
    expect(resolved.target).toBe("user@host");
  });

  it("rejects ambiguous push args", () => {
    expect(() => resolvePushArguments("user@host", "other", ["claude"])).toThrow();
  });

  it("rejects invalid explicit push provider lists", () => {
    expect(() =>
      resolvePushArguments("user@host", undefined, ["claude"], { providers: "claude,nope" }),
    ).toThrow("Unknown provider 'nope'");
  });

  it("rejects conflicting explicit push provider options", () => {
    expect(() =>
      resolvePushArguments("user@host", undefined, ["claude"], {
        all: true,
        providers: "claude,codex",
      }),
    ).toThrow("Use either --all or --providers");
  });

  it("rejects positional providers with explicit push provider options", () => {
    expect(() =>
      resolvePushArguments("claude", "user@host", ["claude"], {
        providers: "claude,codex",
      }),
    ).toThrow("Do not combine --providers");

    expect(() => resolvePushArguments("claude", "user@host", ["claude"], { all: true })).toThrow(
      "Do not combine --all",
    );
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

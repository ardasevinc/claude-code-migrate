import { describe, expect, it } from "bun:test";
import { resolveProvidersToRestore } from "./restore.ts";

describe("restore helpers", () => {
  it("returns all available providers when none is requested", () => {
    expect(resolveProvidersToRestore(["claude", "codex"], undefined)).toEqual(["claude", "codex"]);
  });

  it("returns only the requested provider when present", () => {
    expect(resolveProvidersToRestore(["claude", "codex"], "codex")).toEqual(["codex"]);
  });

  it("returns empty when requested provider is missing", () => {
    expect(resolveProvidersToRestore(["codex"], "claude")).toEqual([]);
  });
});

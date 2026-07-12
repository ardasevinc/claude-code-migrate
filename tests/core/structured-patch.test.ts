import { describe, expect, it } from "vitest";
import {
  applyStructuredPatch,
  assertCodexProfilePatchAllowed,
  decodeJsonPointer,
} from "../../src/core/structured-patch.ts";
import type { StructuredPatch, StructuredValue } from "../../src/types/index.ts";

const patch = (set: Record<string, StructuredValue>, unset: string[] = []): StructuredPatch => ({
  set,
  unset,
});

describe("structured patches", () => {
  it("decodes strict RFC 6901 escapes", () => {
    expect(decodeJsonPointer("/a~1b/~0tilde/")).toEqual(["a/b", "~tilde", ""]);
    expect(decodeJsonPointer("")).toEqual([]);
  });

  it.each(["no-slash", "/bad~", "/bad~2"])("rejects malformed pointer %s", (pointer) =>
    expect(() => decodeJsonPointer(pointer)).toThrow());

  it("runs unsets first, splices arrays, recursively merges objects, and replaces leaves", () => {
    const source = {
      env: { old: true, keep: true },
      list: ["zero", "one", "two"],
      scalar: "old",
    } satisfies Record<string, StructuredValue>;
    const result = applyStructuredPatch(
      source,
      patch({ env: { old: "new", added: true }, list: ["replacement"], scalar: { nested: true } }, [
        "/env/old",
        "/list/1",
      ]),
    );
    expect(result).toEqual({
      env: { keep: true, old: "new", added: true },
      list: ["replacement"],
      scalar: { nested: true },
    });
    expect(source).toEqual({
      env: { old: true, keep: true },
      list: ["zero", "one", "two"],
      scalar: "old",
    });
  });

  it("supports escaped object keys and missing paths", () => {
    expect(
      applyStructuredPatch(
        { "a/b": { "~key": 1 }, untouched: true },
        patch({ replacement: true }, ["/a~1b/~0key", "/missing/child"]),
      ),
    ).toEqual({ "a/b": {}, untouched: true, replacement: true });
  });

  it("rejects root unset", () => {
    expect(() => applyStructuredPatch({ existing: true }, patch({}, [""]))).toThrow(
      "cannot unset the document root",
    );
  });

  it.each([
    "/list/-",
    "/list/01",
    "/list/9007199254740992",
  ])("rejects invalid array index %s", (pointer) =>
    expect(() => applyStructuredPatch({ list: [1] }, patch({}, [pointer]))).toThrow(
      "Invalid array index",
    ));

  it("rejects scalar traversal", () => {
    expect(() => applyStructuredPatch({ scalar: true }, patch({}, ["/scalar/child"]))).toThrow(
      "Cannot traverse scalar",
    );
  });

  it("rejects prototype keys in pointers and set trees", () => {
    expect(() => decodeJsonPointer("/__proto__/polluted")).toThrow("forbidden");
    const poisoned = JSON.parse('{"constructor":{"polluted":true}}') as Record<
      string,
      StructuredValue
    >;
    expect(() => applyStructuredPatch({}, patch(poisoned))).toThrow("forbidden");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("Codex profile patch boundary", () => {
  it.each([
    "/mcp_servers",
    "/mcp_servers/demo",
    "/mcpServers/demo",
    "/marketplaces/local",
    "/plugins/demo",
    "/hooks",
    "/hooks/state",
    "/hooks/state/demo",
  ])("rejects forbidden unset or parent bypass %s", (pointer) => {
    expect(() => assertCodexProfilePatchAllowed(patch({}, [pointer]))).toThrow(
      "forbidden Codex subtree",
    );
  });

  it("rejects Codex root unset", () => {
    expect(() => assertCodexProfilePatchAllowed(patch({}, [""]))).toThrow("document root");
  });

  it.each([
    { mcp_servers: { demo: {} } },
    { marketplaces: [] },
    { plugins: {} },
    { hooks: { state: { demo: true } } },
    { hooks: null },
  ] as Array<Record<string, StructuredValue>>)("rejects forbidden set %#", (set) => {
    expect(() => assertCodexProfilePatchAllowed(patch(set))).toThrow("forbidden Codex subtree");
  });

  it("allows unrelated config and non-state hook settings", () => {
    expect(() =>
      assertCodexProfilePatchAllowed(
        patch({ model: "gpt", features: { experimental: false }, hooks: { notify: true } }, [
          "/projects/old",
        ]),
      ),
    ).not.toThrow();
  });
});

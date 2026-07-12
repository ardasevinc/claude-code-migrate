import type { StructuredPatch, StructuredValue } from "../types/index.ts";

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

function isRecord(value: unknown): value is Record<string, StructuredValue> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

function assertSafeKey(key: string): void {
  if (FORBIDDEN_KEYS.has(key)) throw new Error(`Structured patch key is forbidden: ${key}`);
}

function clone(value: StructuredValue): StructuredValue {
  if (Array.isArray(value)) return value.map(clone);
  if (value instanceof Date) return value;
  if (!isRecord(value)) return value;
  const output: Record<string, StructuredValue> = {};
  for (const [key, child] of Object.entries(value)) {
    assertSafeKey(key);
    output[key] = clone(child);
  }
  return output;
}

/** Decodes an RFC 6901 JSON pointer, rejecting malformed tilde escapes. */
export function decodeJsonPointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`Invalid RFC 6901 pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .map((token) => {
      let decoded = "";
      for (let index = 0; index < token.length; index += 1) {
        const character = token[index];
        if (character !== "~") {
          decoded += character;
          continue;
        }
        const escapeCode = token[index + 1];
        if (escapeCode === "0") decoded += "~";
        else if (escapeCode === "1") decoded += "/";
        else throw new Error(`Invalid RFC 6901 escape in pointer: ${pointer}`);
        index += 1;
      }
      assertSafeKey(decoded);
      return decoded;
    });
}

function arrayIndex(token: string, pointer: string): number {
  if (!ARRAY_INDEX.test(token)) throw new Error(`Invalid array index in pointer: ${pointer}`);
  const index = Number(token);
  if (!Number.isSafeInteger(index)) throw new Error(`Invalid array index in pointer: ${pointer}`);
  return index;
}

function unsetAt(root: Record<string, StructuredValue>, pointer: string): void {
  const tokens = decodeJsonPointer(pointer);
  if (tokens.length === 0) {
    for (const key of Object.keys(root)) delete root[key];
    return;
  }

  let parent: StructuredValue = root;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index] as string;
    if (Array.isArray(parent)) {
      const childIndex = arrayIndex(token, pointer);
      if (childIndex >= parent.length) return;
      parent = parent[childIndex] as StructuredValue;
    } else if (isRecord(parent)) {
      if (!Object.hasOwn(parent, token)) return;
      parent = parent[token] as StructuredValue;
    } else {
      throw new Error(`Cannot traverse scalar while unsetting pointer: ${pointer}`);
    }
  }

  const leaf = tokens.at(-1) as string;
  if (Array.isArray(parent)) {
    const index = arrayIndex(leaf, pointer);
    if (index < parent.length) parent.splice(index, 1);
  } else if (isRecord(parent)) {
    delete parent[leaf];
  } else {
    throw new Error(`Cannot traverse scalar while unsetting pointer: ${pointer}`);
  }
}

function merge(
  target: Record<string, StructuredValue>,
  patch: Record<string, StructuredValue>,
): void {
  for (const [key, incoming] of Object.entries(patch)) {
    assertSafeKey(key);
    const current = target[key];
    if (isRecord(incoming) && isRecord(current)) merge(current, incoming);
    else if (isRecord(incoming)) {
      const replacement: Record<string, StructuredValue> = {};
      merge(replacement, incoming);
      target[key] = replacement;
    } else target[key] = clone(incoming);
  }
}

/** Applies unsets before a recursive object merge without mutating either input. */
export function applyStructuredPatch(
  document: Record<string, StructuredValue>,
  patch: StructuredPatch,
): Record<string, StructuredValue> {
  const output = clone(document) as Record<string, StructuredValue>;
  for (const pointer of patch.unset ?? []) {
    if (pointer === "") throw new Error("Structured patch cannot unset the document root");
    unsetAt(output, pointer);
  }
  merge(output, patch.set ?? {});
  return output;
}

const FORBIDDEN_CODEX_PATHS = [
  ["mcp_servers"],
  ["mcpServers"],
  ["marketplaces"],
  ["plugins"],
  ["hooks", "state"],
] as const;

function prefixesOverlap(left: readonly string[], right: readonly string[]): boolean {
  const common = Math.min(left.length, right.length);
  for (let index = 0; index < common; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function assertAllowedCodexPath(path: readonly string[], label: string): void {
  const forbidden = FORBIDDEN_CODEX_PATHS.find((candidate) => prefixesOverlap(path, candidate));
  if (forbidden) {
    throw new Error(`${label} overlaps forbidden Codex subtree /${forbidden.join("/")}`);
  }
}

function inspectCodexSet(value: StructuredValue, path: string[]): void {
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertSafeKey(key);
      const childPath = [...path, key];
      if (
        FORBIDDEN_CODEX_PATHS.some(
          (candidate) =>
            candidate.length === childPath.length && prefixesOverlap(childPath, candidate),
        )
      ) {
        assertAllowedCodexPath(childPath, "Codex profile set");
      }
      inspectCodexSet(child, childPath);
    }
    return;
  }
  assertAllowedCodexPath(path, "Codex profile set");
}

/** Rejects direct, descendant, and destructive-parent access to CCM-owned Codex state. */
export function assertCodexProfilePatchAllowed(patch: StructuredPatch): void {
  for (const pointer of patch.unset ?? []) {
    if (pointer === "") throw new Error("Codex profile cannot unset the document root");
    assertAllowedCodexPath(
      decodeJsonPointer(pointer),
      `Codex profile unset ${pointer || "<root>"}`,
    );
  }
  inspectCodexSet(patch.set ?? {}, []);
}

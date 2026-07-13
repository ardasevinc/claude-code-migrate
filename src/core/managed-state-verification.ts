import { createHash } from "node:crypto";
import { type InventoryEntry, inventoryFingerprint } from "./inventory.ts";
import {
  canonicalJson,
  fingerprint,
  type JsonValue,
  type PlanFingerprint,
} from "./migration-plan.ts";
import type { PrivatePushTargetFacts } from "./push-observation.ts";
import { parseJsonWithoutDuplicateKeys } from "./strict-json.ts";

export function managedStateVerificationFingerprint(
  inventory: readonly InventoryEntry[],
  codexPluginList?: Extract<PrivatePushTargetFacts["codexPluginList"], { readonly status: "ok" }>,
): PlanFingerprint {
  return fingerprint("receipt-managed-state-v1", {
    inventory: inventoryFingerprint(inventory),
    codexPluginList:
      codexPluginList === undefined
        ? null
        : {
            installed: [...codexPluginList.installed].sort(),
          },
  });
}

export function claudeMcpManagedEntry(bytes?: Uint8Array): InventoryEntry {
  let mcpServers: JsonValue = {};
  if (bytes !== undefined) {
    try {
      const parsed = parseJsonWithoutDuplicateKeys(Buffer.from(bytes).toString("utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        throw new Error("Claude MCP target must be a JSON object");
      const value = (parsed as Record<string, unknown>).mcpServers;
      if (value !== undefined) {
        if (typeof value !== "object" || value === null || Array.isArray(value))
          throw new Error("Claude MCP target mcpServers must be an object");
        mcpServers = value as JsonValue;
      }
    } catch {
      const invalid = Buffer.from(canonicalJson({ invalid: true }));
      return {
        path: "claude/.mcp-config.json",
        type: "file",
        mode: 0o644,
        size: invalid.byteLength,
        sha256: createHash("sha256").update(invalid).digest("hex"),
      };
    }
  }
  const managed = Buffer.from(canonicalJson({ mcpServers }));
  return {
    path: "claude/.mcp-config.json",
    type: "file",
    mode: 0o644,
    size: managed.byteLength,
    sha256: createHash("sha256").update(managed).digest("hex"),
  };
}

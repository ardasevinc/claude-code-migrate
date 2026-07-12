import { parse, stringify, type TomlTable } from "smol-toml";
import type { StructuredValue } from "../types/index.ts";
import { parseJsonWithoutDuplicateKeys } from "./strict-json.ts";

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

function assertStructured(value: unknown, path = "document"): asserts value is StructuredValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    value instanceof Date
  )
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      assertStructured(child, `${path}[${index}]`);
    });
    return;
  }
  if (!isRecord(value)) throw new Error(`${path} contains an unsupported value`);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${path}.${key} is forbidden`);
    assertStructured(child, `${path}.${key}`);
  }
}

function assertTable(
  value: unknown,
  format: string,
): asserts value is Record<string, StructuredValue> {
  assertStructured(value);
  if (!isRecord(value)) throw new Error(`${format} structured document root must be an object`);
}

export function decodeStructuredJson(source: string): Record<string, StructuredValue> {
  const value = parseJsonWithoutDuplicateKeys(source);
  assertTable(value, "JSON");
  return value;
}

export function encodeStructuredJson(value: Record<string, StructuredValue>): string {
  assertTable(value, "JSON");
  assertJsonCompatible(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function decodeStructuredToml(source: string): Record<string, StructuredValue> {
  const value: unknown = parse(source, { integersAsBigInt: "asNeeded" });
  assertTable(value, "TOML");
  return value;
}

export function encodeStructuredToml(value: Record<string, StructuredValue>): string {
  assertTable(value, "TOML");
  if (containsNull(value)) throw new Error("TOML structured document cannot contain null");
  return stringify(value as unknown as TomlTable);
}

function containsNull(value: StructuredValue): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some(containsNull);
  if (isRecord(value))
    return Object.values(value).some((child) => containsNull(child as StructuredValue));
  return false;
}

function assertJsonCompatible(value: StructuredValue, path = "document"): void {
  if (typeof value === "bigint" || value instanceof Date) {
    throw new Error(`${path} contains a value JSON cannot represent`);
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      assertJsonCompatible(child, `${path}[${index}]`);
    });
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertJsonCompatible(child as StructuredValue, `${path}.${key}`);
    }
  }
}

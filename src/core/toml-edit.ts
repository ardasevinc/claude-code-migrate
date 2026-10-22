import { isDeepStrictEqual } from "node:util";
import { parse, stringify, type TomlTable } from "smol-toml";

export function isTomlTable(value: unknown): value is TomlTable {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/** Keep formatting only when a textual edit has exactly the intended TOML meaning. */
export function editToml(
  source: string,
  edit: (document: TomlTable) => void,
  candidate: string,
): string {
  const options = { integersAsBigInt: "asNeeded" } as const;
  const original = parse(source, options);
  const edited = parse(source, options);
  edit(edited);
  if (isDeepStrictEqual(original, edited)) return source;
  try {
    if (isDeepStrictEqual(parse(candidate, options), edited)) return candidate;
  } catch {
    // Multiline, inline, quoted and dotted TOML forms need structural serialization.
  }
  return stringify(edited);
}

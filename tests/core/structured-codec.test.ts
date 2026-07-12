import { describe, expect, it } from "vitest";
import {
  decodeStructuredJson,
  decodeStructuredToml,
  encodeStructuredJson,
  encodeStructuredToml,
} from "../../src/core/structured-codec.ts";

describe("structured document codecs", () => {
  it("round-trips nested JSON with stable pretty output", () => {
    const decoded = decodeStructuredJson('{"env":{"name":"dev"},"list":[1,true,null]}');
    const encoded = encodeStructuredJson(decoded);
    expect(encoded.endsWith("\n")).toBe(true);
    expect(decodeStructuredJson(encoded)).toEqual(decoded);
  });

  it("rejects duplicate JSON keys and non-object roots", () => {
    expect(() => decodeStructuredJson('{"a":1,"a":2}')).toThrow("Duplicate JSON object key");
    expect(() => decodeStructuredJson("[]")).toThrow("root must be an object");
  });

  it("round-trips TOML tables while allowing TOML integers and dates", () => {
    const decoded = decodeStructuredToml(
      "count = 9007199254740993\nwhen = 2026-07-12T12:00:00Z\n[a]\nb = true\n",
    );
    const encoded = encodeStructuredToml(decoded);
    expect(decodeStructuredToml(encoded)).toEqual(decoded);
  });

  it("enforces format-specific values", () => {
    expect(() => encodeStructuredJson({ tooLarge: 1n })).toThrow("JSON cannot represent");
    expect(() => encodeStructuredToml({ absent: null })).toThrow("cannot contain null");
  });

  it("rejects prototype-bearing structured documents", () => {
    expect(() => decodeStructuredJson('{"__proto__":{"polluted":true}}')).toThrow("forbidden");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

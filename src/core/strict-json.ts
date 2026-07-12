/** Parses JSON while rejecting duplicate keys at every object nesting level. */
export function parseJsonWithoutDuplicateKeys(source: string): unknown {
  let offset = 0;
  const whitespace = () => {
    while (/\s/.test(source[offset] ?? "")) offset += 1;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < source.length) {
      if (source[offset] === "\\") offset += 2;
      else if (source[offset++] === '"') return JSON.parse(source.slice(start, offset)) as string;
    }
    throw new SyntaxError("Unterminated JSON string");
  };
  const value = (): void => {
    whitespace();
    if (source[offset] === "{") {
      offset += 1;
      whitespace();
      const keys = new Set<string>();
      if (source[offset] !== "}") {
        while (true) {
          whitespace();
          if (source[offset] !== '"') throw new SyntaxError("Expected JSON object key");
          const key = string();
          if (keys.has(key)) throw new SyntaxError(`Duplicate JSON object key: ${key}`);
          keys.add(key);
          whitespace();
          if (source[offset++] !== ":") throw new SyntaxError("Expected ':'");
          value();
          whitespace();
          if (source[offset] === "}") break;
          if (source[offset++] !== ",") throw new SyntaxError("Expected ','");
        }
      }
      offset += 1;
      return;
    }
    if (source[offset] === "[") {
      offset += 1;
      whitespace();
      if (source[offset] !== "]") {
        while (true) {
          value();
          whitespace();
          if (source[offset] === "]") break;
          if (source[offset++] !== ",") throw new SyntaxError("Expected ','");
        }
      }
      offset += 1;
      return;
    }
    if (source[offset] === '"') {
      string();
      return;
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      source.slice(offset),
    );
    if (!match) throw new SyntaxError("Invalid JSON value");
    offset += match[0].length;
  };
  value();
  whitespace();
  if (offset !== source.length) throw new SyntaxError("Unexpected JSON input");
  return JSON.parse(source) as unknown;
}

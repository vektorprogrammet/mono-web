import { Schema } from "effect";

const strictJsonDecoder = new TextDecoder("utf-8", { fatal: true });

/** Decodes UTF-8 JSON while rejecting duplicate object member names. */
export const parseJsonWithUniqueMembers = (bytes: Uint8Array): Schema.Json => {
  const text = strictJsonDecoder.decode(bytes);

  const stack: Array<{
    readonly kind: "array" | "object";
    readonly keys?: Set<string>;
    expectKey: boolean;
  }> = [];

  let index = 0;
  let expectingKey = false;

  while (index < text.length) {
    const char = text[index]!;

    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }

    if (char === "{") {
      stack.push({ kind: "object", keys: new Set(), expectKey: true });
      expectingKey = true;
      index += 1;
      continue;
    }

    if (char === "[") {
      stack.push({ kind: "array", expectKey: false });
      expectingKey = false;
      index += 1;
      continue;
    }

    if (char === "}" || char === "]") {
      stack.pop();
      expectingKey = stack.at(-1)?.kind === "object" && stack.at(-1)?.expectKey === true;
      index += 1;
      continue;
    }

    if (char === ",") {
      const top = stack.at(-1);

      if (top?.kind === "object") top.expectKey = true;
      expectingKey = top?.kind === "object";
      index += 1;
      continue;
    }

    if (char === ":") {
      const top = stack.at(-1);

      if (top?.kind === "object") top.expectKey = false;
      expectingKey = false;
      index += 1;
      continue;
    }

    if (char === '"') {
      const start = index;
      index += 1;

      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }

        if (text[index] === '"') {
          index += 1;
          break;
        }

        index += 1;
      }

      if (expectingKey) {
        const key: string = JSON.parse(text.slice(start, index));
        const keys = stack.at(-1)?.keys;

        if (keys?.has(key) === true) throw new SyntaxError("Duplicate JSON object member");
        keys?.add(key);
      }

      continue;
    }

    index += 1;
  }

  return JSON.parse(text);
};

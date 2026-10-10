import { describe, expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { ArticleIdFromText } from "./article-id.js";

const decode = Schema.decodeUnknownResult(ArticleIdFromText);

describe("article id read as PostgreSQL text", () => {
  it("decodes every id that the column admits, including the ids above integer", () => {
    for (const [text, id] of [
      ["1", 1],
      ["2147483647", 2 ** 31 - 1],
      ["2147483648", 2 ** 31],
      ["4294967296", 2 ** 32],
      ["9007199254740991", Number.MAX_SAFE_INTEGER],
    ] as const) {
      expect(Result.getOrUndefined(decode(text))).toBe(id);
    }
  });

  it("refuses text that is no article id", () => {
    for (const text of ["0", "-1", "1.5", "", "abc", "9007199254740992", "9007199254740993"]) {
      expect(Result.isFailure(decode(text)), text).toBe(true);
    }
  });
});

import { describe, expect, it } from "@effect/vitest";
import { DateTime, Schema } from "effect";
import { Instant } from "../time.js";
import { canonicalJson } from "./canonical-json.js";

describe("canonical JSON", () => {
  it("rejects values whose entries are not their encoding, at any depth", () => {
    const instant = DateTime.makeUnsafe("2038-06-13T12:00:00.123Z");

    for (const value of [
      instant,
      DateTime.toDateUtc(instant),
      new Uint8Array([1]),
      { at: [instant] },
    ])
      expect(() => canonicalJson(value)).toThrow("plain data only");

    expect(canonicalJson({ at: Schema.encodeSync(Instant)(instant), id: null })).toBe(
      '{"at":"2038-06-13T12:00:00.123Z","id":null}',
    );
  });
});

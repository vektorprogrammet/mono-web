import { describe, expect, it } from "@effect/vitest";
import { DateTime, Option, Schema } from "effect";
import {
  compareRfc3339Instants,
  Instant,
  isRfc3339Instant,
  normalizeRfc3339Instant,
} from "./time.js";

describe("RFC 3339 instant boundary", () => {
  it("uses Effect DateTime without accepting precision it cannot represent", () => {
    expect(isRfc3339Instant("2026-08-01T00:00:00.999Z")).toBe(true);
    expect(isRfc3339Instant("2026-08-01T00:00:00.000999Z")).toBe(false);
  });

  it("compares and normalizes equivalent explicit-offset instants", () => {
    const utc = "2026-08-01T00:00:00.125Z";
    const offset = "2026-08-01T02:00:00.125+02:00";

    expect(compareRfc3339Instants(utc, offset)).toBe(0);
    expect(normalizeRfc3339Instant(offset)).toBe(utc);
  });
});

describe("Instant", () => {
  const decode = Schema.decodeUnknownOption(Instant);
  const encode = Schema.encodeOption(Instant);

  it("decodes explicit offsets and encodes one canonical UTC spelling", () => {
    expect(Option.flatMap(decode("2026-10-25T02:30:00.1+01:00"), encode)).toEqual(
      Option.some("2026-10-25T01:30:00.100Z"),
    );
  });

  it("rejects text DateTime parses but RFC 3339 forbids, and years beyond four digits", () => {
    for (const input of [
      "Aug 1 2026 10:00 GMT",
      "2099-02-30T00:00:00Z",
      "2099-02-01",
      "2099-02-01T00:00:00.000001Z",
      "0000-01-01T00:30:00+01:00",
      "9999-12-31T23:30:00-01:00",
    ])
      expect(decode(input)).toEqual(Option.none());

    expect(encode(DateTime.makeUnsafe(253_402_300_800_000))).toEqual(Option.none());
  });
});

import { describe, expect, it } from "@effect/vitest";
import { compareRfc3339Instants, isRfc3339Instant, normalizeRfc3339Instant } from "./time.js";

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

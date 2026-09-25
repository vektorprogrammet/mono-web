import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { instantFromOsloDateTimeLocal, osloDateTimeLocalFromInstant } from "./oslo-time";

describe("Oslo datetime-local conversion", () => {
  it("applies the Oslo offset in force on each side of both 2026 daylight-saving changes", () => {
    expect(instantFromOsloDateTimeLocal("2026-01-15T12:00")).toEqual(
      Option.some("2026-01-15T11:00:00.000Z"),
    );
    expect(instantFromOsloDateTimeLocal("2026-07-15T12:00")).toEqual(
      Option.some("2026-07-15T10:00:00.000Z"),
    );
    expect(instantFromOsloDateTimeLocal("2026-03-29T01:59")).toEqual(
      Option.some("2026-03-29T00:59:00.000Z"),
    );
    expect(instantFromOsloDateTimeLocal("2026-03-29T03:00")).toEqual(
      Option.some("2026-03-29T01:00:00.000Z"),
    );
    expect(instantFromOsloDateTimeLocal("2026-10-25T01:59")).toEqual(
      Option.some("2026-10-24T23:59:00.000Z"),
    );
    expect(instantFromOsloDateTimeLocal("2026-10-25T03:00")).toEqual(
      Option.some("2026-10-25T02:00:00.000Z"),
    );
  });

  it("rejects skipped, repeated, impossible, and incomplete wall-clock values", () => {
    for (const value of [
      "2026-03-29T02:30",
      "2026-10-25T02:30",
      "2026-02-30T10:00",
      "2026-01-15",
      "",
    ]) {
      expect(Option.isNone(instantFromOsloDateTimeLocal(value))).toBe(true);
    }
  });

  it("renders stored instants as the Oslo minute that converts back to the same instant", () => {
    expect(osloDateTimeLocalFromInstant("2026-09-15T21:59:59.999Z")).toBe("2026-09-15T23:59");
    expect(osloDateTimeLocalFromInstant("2026-12-31T23:30:00.000Z")).toBe("2027-01-01T00:30");

    for (const instant of ["2026-02-01T08:15:00.000Z", "2026-08-01T08:15:00.000Z"]) {
      expect(instantFromOsloDateTimeLocal(osloDateTimeLocalFromInstant(instant))).toEqual(
        Option.some(instant),
      );
    }
  });
});

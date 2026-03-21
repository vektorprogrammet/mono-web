/**
 * Adapter tests — status integer mapping, date parsing, violation extraction.
 */

import { describe, it, expect } from "vitest"
import { Effect, Schema } from "effect"
import { parseApplicationStatus, parseInterviewStatus } from "../adapter/status.js"
import { DateFromIso, NullableDateFromIso } from "../adapter/dates.js"
import { parseViolations } from "../adapter/errors.js"

describe("parseApplicationStatus", () => {
  const cases: [number, string][] = [
    [-1, "cancelled"],
    [0, "not_received"],
    [1, "received"],
    [2, "invited"],
    [3, "accepted"],
    [4, "completed"],
    [5, "assigned"],
  ]

  for (const [input, expected] of cases) {
    it(`maps ${input} to "${expected}"`, () => {
      expect(parseApplicationStatus(input)).toBe(expected)
    })
  }

  it("throws on unknown status integer", () => {
    expect(() => parseApplicationStatus(99)).toThrow("Unknown application status: 99")
  })
})

describe("parseInterviewStatus", () => {
  const cases: [number, string][] = [
    [0, "pending"],
    [1, "accepted"],
    [2, "request_new_time"],
    [3, "cancelled"],
    [4, "no_contact"],
  ]

  for (const [input, expected] of cases) {
    it(`maps ${input} to "${expected}"`, () => {
      expect(parseInterviewStatus(input)).toBe(expected)
    })
  }

  it("throws on unknown status integer", () => {
    expect(() => parseInterviewStatus(99)).toThrow("Unknown interview status: 99")
  })
})

describe("DateFromIso", () => {
  it("decodes an ISO date string to a Date object", async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknown(DateFromIso)("2026-01-10T12:00:00+01:00"),
    )
    expect(result).toBeInstanceOf(Date)
    expect(result.toISOString()).toContain("2026-01-10")
  })

  it("decodes a date-only string to a Date", async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknown(DateFromIso)("2026-03-21"),
    )
    expect(result).toBeInstanceOf(Date)
  })
})

describe("NullableDateFromIso", () => {
  it("decodes null to null", async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknown(NullableDateFromIso)(null),
    )
    expect(result).toBeNull()
  })

  it("decodes an ISO date string to a Date", async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknown(NullableDateFromIso)("2026-01-10"),
    )
    expect(result).toBeInstanceOf(Date)
  })
})

describe("parseViolations", () => {
  it("extracts field-level errors from API Platform violation format", () => {
    const body = {
      violations: [
        { propertyPath: "email", message: "Invalid email address" },
        { propertyPath: "description", message: "This value is too short." },
      ],
    }
    expect(parseViolations(body)).toEqual({
      email: "Invalid email address",
      description: "This value is too short.",
    })
  })

  it("returns empty object for non-object input", () => {
    expect(parseViolations(null)).toEqual({})
    expect(parseViolations("string")).toEqual({})
    expect(parseViolations(42)).toEqual({})
  })

  it("returns empty object when violations key is absent", () => {
    expect(parseViolations({})).toEqual({})
  })

  it("returns empty object when violations is not an array", () => {
    expect(parseViolations({ violations: "wrong" })).toEqual({})
  })

  it("skips violation entries missing propertyPath or message", () => {
    const body = {
      violations: [
        { message: "No path" },
        { propertyPath: "field" },
        { propertyPath: "ok", message: "Valid" },
      ],
    }
    expect(parseViolations(body)).toEqual({ ok: "Valid" })
  })
})

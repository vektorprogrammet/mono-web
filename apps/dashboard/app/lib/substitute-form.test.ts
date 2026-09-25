import { makeNativeProblem, Problem } from "@vektorprogrammet/http-api";
import { describe, expect, it } from "vitest";
import {
  parseSubstituteForm,
  substituteFailure,
  substituteSemesterLabel,
  weekdays,
} from "./substitute-form";

const form = () => {
  const value = new FormData();

  for (const [key, item] of Object.entries({
    intent: "activate",
    applicationId: "application-0094",
    etag: '"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
    commandId: "substitute-command-0094",
    language: "Norwegian",
    yearOfStudy: "3",
  }))
    value.set(key, item);

  for (const [key] of weekdays) value.set(key, "false");

  return value;
};

describe("substitute coordinator declarations", () => {
  it("accepts an explicit all-unavailable declaration without inventing an eligibility rule", () => {
    const command = parseSubstituteForm(form());
    expect(command.intent).toBe("activate");

    if (command.intent !== "deactivate") expect(command.payload.monday).toBe(false);
  });
  it.each(weekdays)("requires an explicit value for %s", (key) => {
    const value = form();
    value.delete(key);
    expect(() => parseSubstituteForm(value)).toThrow();
    value.set(key, "on");
    expect(() => parseSubstituteForm(value)).toThrow();
  });
  it("rejects absent language, invalid year and duplicated form values", () => {
    for (const [key, invalid] of [
      ["language", ""],
      ["yearOfStudy", "6"],
      ["yearOfStudy", "3.5"],
    ]) {
      const value = form();
      value.set(key, invalid);
      expect(() => parseSubstituteForm(value)).toThrow();
    }

    const value = form();
    value.append("monday", "true");
    expect(() => parseSubstituteForm(value)).toThrow();
  });
  it("deactivation preserves preferences by sending no replacement values", () => {
    const value = form();
    value.set("intent", "deactivate");
    value.delete("language");

    for (const [key] of weekdays) value.delete(key);
    expect(parseSubstituteForm(value)).not.toHaveProperty("payload");
  });
  it("distinguishes stale-version recovery from an unavailable service", () => {
    expect(substituteFailure(makeNativeProblem("precondition.failed")).conflict).toBe(true);
    expect(substituteFailure(makeNativeProblem("internal.error")).conflict).toBe(false);
  });
});

it("labels canonical semesters with Norwegian dates rather than storage identifiers", () => {
  expect(
    substituteSemesterLabel({ startAt: "2023-12-31T23:00:00Z", endAt: "2024-06-30T21:59:59Z" }),
  ).toBe("1. jan. 2024 – 30. juni 2024");
});

it("keeps explicit conflict recovery for the generated SDK's problem value", () => {
  const problem = makeNativeProblem("precondition.failed");
  const failed = Problem.fromWire(problem, {});

  expect(substituteFailure(failed)).toEqual(substituteFailure(problem));
  expect(substituteFailure(failed).conflict).toBe(true);
});

it("does not manufacture conflict or authority decisions from malformed error objects", () => {
  for (const error of [
    { code: "precondition.failed" },
    { ...makeNativeProblem("precondition.failed"), status: 500 },
  ]) {
    expect(substituteFailure(error).conflict).toBe(false);
  }
});

import { describe, expect, it } from "vitest";
import { parseSubstituteForm, substituteFailure, weekdays } from "./substitute-form";
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
    expect(substituteFailure({ code: "precondition.failed" }).conflict).toBe(true);
    expect(substituteFailure({ code: "internal.error" }).conflict).toBe(false);
  });
});

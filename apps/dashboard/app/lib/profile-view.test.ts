import type { UserProfile } from "@vektorprogrammet/sdk/effect";
import { describe, expect, it } from "vitest";
import { loadProfile, projectProfile } from "./profile-view";

const profile = (overrides: Partial<UserProfile> = {}): UserProfile => ({
  personId: "person-17" as UserProfile["personId"],
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.invalid",
  phone: "12345678",
  role: "ROLE_TEAM_MEMBER",
  nameRevision: 0,
  contactRevision: 0,
  ...overrides,
});

describe("profile read projection", () => {
  it("projects only fields warranted by the decoded profile", () => {
    expect(projectProfile(profile())).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.invalid",
      phone: "12345678",
      role: "ROLE_TEAM_MEMBER",
    });
  });

  it("preserves profile API failure instead of returning fixture data", async () => {
    const failure = new Error("profile unavailable");

    await expect(loadProfile(() => Promise.reject(failure))).rejects.toBe(failure);
  });

  it("does not introduce fixture-only facts", () => {
    const projected = JSON.stringify(projectProfile(profile()));

    expect(projected).not.toContain("Fixture Operator");
    expect(projected).not.toContain("Charlottenlund");
    expect(projected).not.toContain("0000 00 00000");
  });
});

import type { UserProfile } from "@vektorprogrammet/sdk";
import { describe, expect, it } from "vitest";
import { loadProfile, projectProfile } from "./profile-view";

const profile = (overrides: Partial<UserProfile> = {}): UserProfile => ({
  id: 17,
  firstName: "Ada",
  lastName: "Lovelace",
  userName: "ada",
  email: "ada@example.invalid",
  phone: "12345678",
  gender: 0,
  fieldOfStudy: {
    id: 5,
    name: "Datateknologi",
    shortName: "MTDT",
  },
  accountNumber: null,
  role: "ROLE_TEAM_MEMBER",
  profilePhoto: "images/profile/ada.png",
  ...overrides,
});

describe("profile read projection", () => {
  it("projects only fields warranted by the decoded profile", () => {
    expect(projectProfile(profile())).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.invalid",
      phone: "12345678",
      study: "Datateknologi",
      role: "ROLE_TEAM_MEMBER",
      profileImage: "/images/profile/ada.png",
    });
  });

  it("keeps absent optional values absent", () => {
    expect(
      projectProfile(profile({ phone: null, fieldOfStudy: null, profilePhoto: null })),
    ).toMatchObject({ phone: null, study: null, profileImage: "" });
  });

  it("does not introduce fixture-only facts", () => {
    const projected = JSON.stringify(projectProfile(profile()));

    expect(projected).not.toContain("Fixture Operator");
    expect(projected).not.toContain("Charlottenlund");
    expect(projected).not.toContain("0000 00 00000");
  });

  it("preserves profile API failure instead of returning fixture data", async () => {
    const failure = new Error("profile unavailable");

    await expect(loadProfile(() => Promise.reject(failure))).rejects.toBe(failure);
  });
});

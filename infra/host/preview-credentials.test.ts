import { describe, expect, it } from "vitest";
import { validatePreviewCredentials } from "./preview-credentials";

const validAdmin = {
  personId: "apex-preview-administrator",
  email: "admin.apex@example.invalid",
  password: "A".repeat(48),
  role: "admin",
} as const;
const validMember = {
  personId: "apex-preview-member",
  email: "member.apex@example.invalid",
  password: "B".repeat(48),
  role: "member",
} as const;

describe("preview credential validation", () => {
  it("accepts exactly the fixed administrator and member mappings", () => {
    expect(validatePreviewCredentials([validMember, validAdmin])).toEqual([
      validAdmin,
      validMember,
    ]);
  });

  it("rejects a malformed identity", () => {
    expect(() => validatePreviewCredentials([validAdmin, { ...validMember, email: 42 }])).toThrow(
      "fixed identity",
    );
  });

  it("rejects duplicate identities", () => {
    expect(() =>
      validatePreviewCredentials([validAdmin, { ...validAdmin, password: "C".repeat(48) }]),
    ).toThrow("unique");
  });

  it("rejects a shared password", () => {
    expect(() =>
      validatePreviewCredentials([validAdmin, { ...validMember, password: validAdmin.password }]),
    ).toThrow("password values must be unique");
  });

  it("rejects an extra identity", () => {
    expect(() =>
      validatePreviewCredentials([
        validAdmin,
        validMember,
        { ...validMember, personId: "unexpected", password: "C".repeat(48) },
      ]),
    ).toThrow("exactly two identities");
  });

  it("rejects unexpected properties", () => {
    expect(() =>
      validatePreviewCredentials([validAdmin, { ...validMember, label: "unexpected" }]),
    ).toThrow("invalid shape");
  });
});

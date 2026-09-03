import { describe, expect, it } from "vitest";
import { validatePreviewCredentials } from "./preview-credentials";
import { readPreviewCredentialRotationConfig } from "./rotate-preview-credentials";

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

describe("preview credential rotation configuration", () => {
  it("uses the exact native dev-main identity policy", () => {
    const config = readPreviewCredentialRotationConfig({
      PREVIEW_CREDENTIAL_FILE: "/tmp/preview-credentials.json",
      BACKEND_PG_URL: "postgresql://postgres@127.0.0.1:5434/vektor_preview",
      BETTER_AUTH_SECRET: "test-secret-with-at-least-32-characters",
      NATIVE_IDENTITY_DEPLOYMENT: "preview",
      NATIVE_IDENTITY_TRUSTED_ORIGINS: '["https://vektor.phibkro.org"]',
      OAUTH_CANONICAL_ORIGIN: "https://vektor.phibkro.org",
      OAUTH_DASHBOARD_ORIGIN: "https://vektor.phibkro.org",
      OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
    });

    expect(config).toEqual({
      credentialFile: "/tmp/preview-credentials.json",
      auth: {
        postgresUrl: "postgresql://postgres@127.0.0.1:5434/vektor_preview",
        secret: "test-secret-with-at-least-32-characters",
        oauth: {
          canonicalOrigin: "https://vektor.phibkro.org",
          dashboardOrigin: "https://vektor.phibkro.org",
          nativeApiResource: "urn:vektorprogrammet:native-api",
        },
        trustedOrigins: ["https://vektor.phibkro.org"],
        secureCookies: true,
      },
    });
  });
});

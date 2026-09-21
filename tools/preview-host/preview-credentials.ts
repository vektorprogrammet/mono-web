import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PREVIEW_CREDENTIAL_IDENTITIES = {
  admin: {
    personId: "apex-preview-administrator",
    email: "admin.apex@example.invalid",
  },
  member: {
    personId: "apex-preview-member",
    email: "member.apex@example.invalid",
  },
} as const;

export type PreviewCredentialRole = keyof typeof PREVIEW_CREDENTIAL_IDENTITIES;

export interface PreviewCredential {
  readonly email: string;
  readonly password: string;
  readonly personId: string;
  readonly role: PreviewCredentialRole;
}

export function validatePreviewCredentials(value: unknown): readonly PreviewCredential[] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("preview credential file must contain exactly two identities");
  }

  const credentials = value.map((entry, index): PreviewCredential => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`preview credential ${index} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    if (
      JSON.stringify(Object.keys(record).sort()) !==
      JSON.stringify(["email", "password", "personId", "role"])
    ) {
      throw new Error(`preview credential ${index} has an invalid shape`);
    }
    if (record.role !== "admin" && record.role !== "member") {
      throw new Error(`preview credential ${index} has an invalid role`);
    }
    const expected = PREVIEW_CREDENTIAL_IDENTITIES[record.role];
    if (record.personId !== expected.personId || record.email !== expected.email) {
      throw new Error(`preview credential ${index} does not match its fixed identity`);
    }
    if (typeof record.password !== "string" || record.password.length < 32) {
      throw new Error(`preview credential ${index} has an invalid password`);
    }
    return {
      email: expected.email,
      password: record.password,
      personId: expected.personId,
      role: record.role,
    };
  });

  for (const property of ["email", "password", "personId", "role"] as const) {
    if (new Set(credentials.map((credential) => credential[property])).size !== 2) {
      throw new Error(`preview credential ${property} values must be unique`);
    }
  }

  return credentials.sort((left, right) =>
    left.role === "admin" ? -1 : right.role === "admin" ? 1 : 0,
  );
}

export function readPreviewCredentials(path: string): readonly PreviewCredential[] {
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error("preview credential file must not be group- or world-readable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("preview credential file is not valid JSON");
  }
  return validatePreviewCredentials(parsed);
}

export function previewIdentitySeedJson(credentials: readonly PreviewCredential[]): string {
  return JSON.stringify(
    credentials.map((credential) => ({
      personId: credential.personId,
      firstName: credential.role === "admin" ? "Astrid" : "Mons",
      lastName: credential.role === "admin" ? "Apex" : "Medlem",
      email: credential.email,
      password: credential.password,
    })),
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const [command, credentialFile, ...extra] = process.argv.slice(2);
  if (
    (command !== "validate" && command !== "seed-json") ||
    credentialFile === undefined ||
    extra.length > 0
  ) {
    throw new Error("usage: preview-credentials.ts <validate|seed-json> <credential-file>");
  }
  const credentials = readPreviewCredentials(credentialFile);
  if (command === "seed-json") {
    process.stdout.write(`${previewIdentitySeedJson(credentials)}\n`);
  }
}

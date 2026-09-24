import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flow, Schema } from "effect";

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

const PreviewCredentialSchema = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("admin"),
    personId: Schema.Literal(PREVIEW_CREDENTIAL_IDENTITIES.admin.personId),
    email: Schema.Literal(PREVIEW_CREDENTIAL_IDENTITIES.admin.email),
    password: Schema.String.check(Schema.isMinLength(32)),
  }),
  Schema.Struct({
    role: Schema.Literal("member"),
    personId: Schema.Literal(PREVIEW_CREDENTIAL_IDENTITIES.member.personId),
    email: Schema.Literal(PREVIEW_CREDENTIAL_IDENTITIES.member.email),
    password: Schema.String.check(Schema.isMinLength(32)),
  }),
]);

const PreviewCredentialsSchema = Schema.Array(PreviewCredentialSchema).check(
  Schema.isLengthBetween(2, 2),
);

export const validatePreviewCredentials = flow(
  Schema.decodeUnknownSync(PreviewCredentialsSchema, { onExcessProperty: "error" }),
  (credentials): readonly PreviewCredential[] => {
    for (const property of ["email", "password", "personId", "role"] as const) {
      if (new Set(credentials.map((credential) => credential[property])).size !== 2) {
        throw new Error(`preview credential ${property} values must be unique`);
      }
    }

    return credentials.toSorted((left, right) =>
      left.role === "admin" ? -1 : right.role === "admin" ? 1 : 0,
    );
  },
);

export function readPreviewCredentials(path: string): readonly PreviewCredential[] {
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error("preview credential file must not be group- or world-readable");
  }

  let parsed: unknown;

  try {
    parsed = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
      readFileSync(path, "utf8"),
    );
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

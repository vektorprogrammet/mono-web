import { readFileSync, statSync } from "node:fs";
import { makeAuthEngine, makeAuthPool } from "../../packages/database/src/auth-engine.ts";

interface PreviewCredential {
  readonly email: string;
  readonly password: string;
  readonly personId: string;
  readonly role: "admin" | "member";
}

function requireCredential(value: unknown, index: number): PreviewCredential {
  if (typeof value !== "object" || value === null) {
    throw new Error(`credential ${index} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.email !== "string" ||
    !record.email.endsWith("@example.invalid") ||
    typeof record.password !== "string" ||
    record.password.length < 16 ||
    typeof record.personId !== "string" ||
    (record.role !== "admin" && record.role !== "member")
  ) {
    throw new Error(`credential ${index} is invalid`);
  }
  return {
    email: record.email,
    password: record.password,
    personId: record.personId,
    role: record.role,
  };
}

const credentialFile = process.env.PREVIEW_CREDENTIAL_FILE;
const postgresUrl = process.env.BACKEND_PG_URL;
const secret = process.env.BETTER_AUTH_SECRET;
const baseURL = process.env.BETTER_AUTH_URL;
if (!credentialFile || !postgresUrl || !secret || !baseURL) {
  throw new Error("preview credential rotation environment is incomplete");
}
if ((statSync(credentialFile).mode & 0o077) !== 0) {
  throw new Error("preview credential file must not be group- or world-readable");
}

const parsed = JSON.parse(readFileSync(credentialFile, "utf8")) as unknown;
if (!Array.isArray(parsed) || parsed.length !== 2) {
  throw new Error("preview credential file must contain exactly two identities");
}
const credentials = parsed.map(requireCredential);
if (new Set(credentials.map(({ role }) => role)).size !== 2) {
  throw new Error("preview credential file must contain one admin and one member");
}

const pool = makeAuthPool({ postgresUrl, secret, baseURL });
const engine = makeAuthEngine({ postgresUrl, secret, baseURL }, pool);
try {
  const context = await engine.$context;
  const replacements = await Promise.all(
    credentials.map(async (credential) => ({
      personId: credential.personId,
      passwordHash: await context.password.hash(credential.password),
    })),
  );
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    for (const replacement of replacements) {
      const updated = await connection.query(
        `UPDATE auth.account
         SET password = $1, "updatedAt" = CURRENT_TIMESTAMP
         WHERE "providerId" = 'credential' AND "userId" = $2`,
        [replacement.passwordHash, replacement.personId],
      );
      if (updated.rowCount !== 1) {
        throw new Error(`credential account was not found for ${replacement.personId}`);
      }
    }
    await connection.query('DELETE FROM auth.session WHERE "userId" = ANY($1::text[])', [
      replacements.map(({ personId }) => personId),
    ]);
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
} finally {
  await pool.end();
}

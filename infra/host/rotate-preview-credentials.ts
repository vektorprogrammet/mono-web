import { makeAuthEngine, makeAuthPool } from "../../packages/database/src/auth-engine.ts";
import { readPreviewCredentials } from "./preview-credentials.ts";

const credentialFile = process.env.PREVIEW_CREDENTIAL_FILE;
const postgresUrl = process.env.BACKEND_PG_URL;
const secret = process.env.BETTER_AUTH_SECRET;
const baseURL = process.env.BETTER_AUTH_URL;
if (!credentialFile || !postgresUrl || !secret || !baseURL) {
  throw new Error("preview credential rotation environment is incomplete");
}
const credentials = readPreviewCredentials(credentialFile);

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

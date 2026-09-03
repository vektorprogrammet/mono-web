import {
  type AuthEngineConfig,
  makeAuthEngine,
  makeAuthPool,
} from "../../packages/database/src/auth-engine.ts";
import { decodeOAuthBackendConfig } from "../../apps/backend/src/config.ts";
import { makeNativeSessionBoundaryPolicy } from "../../apps/backend/src/session-security.ts";
import { readPreviewCredentials } from "./preview-credentials.ts";

export interface PreviewCredentialRotationConfig {
  readonly credentialFile: string;
  readonly auth: AuthEngineConfig;
}

export const readPreviewCredentialRotationConfig = (
  env: Readonly<Record<string, string | undefined>>,
): PreviewCredentialRotationConfig => {
  const credentialFile = env.PREVIEW_CREDENTIAL_FILE;
  const postgresUrl = env.BACKEND_PG_URL;
  const secret = env.BETTER_AUTH_SECRET;
  if (!credentialFile || !postgresUrl || !secret) {
    throw new Error("preview credential rotation environment is incomplete");
  }
  const sessionBoundary = makeNativeSessionBoundaryPolicy(env);
  const { oauth } = decodeOAuthBackendConfig(env, sessionBoundary.trustedOrigins);
  return {
    credentialFile,
    auth: {
      postgresUrl,
      secret,
      oauth,
      trustedOrigins: sessionBoundary.trustedOrigins,
      secureCookies: sessionBoundary.secureCookies,
    },
  };
};

export const rotatePreviewCredentials = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> => {
  const config = readPreviewCredentialRotationConfig(env);
  const credentials = readPreviewCredentials(config.credentialFile);
  const pool = makeAuthPool(config.auth);
  const engine = makeAuthEngine(config.auth, pool);
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
};

if (import.meta.main) {
  await rotatePreviewCredentials();
}

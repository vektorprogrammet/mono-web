import {
  isNativePasswordHash,
  nativeAndLegacyPasswordCodec,
  PasswordHashCapacityError,
  PasswordInputTooLongError,
} from "./password-codec.js";
import { betterAuth, createLocalAccountIssuer } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import type { makePasswordRecovery } from "./password-recovery.js";
import { Pool } from "pg";
import { makeOAuthPlugins, type OAuthProviderRuntimeConfig } from "./oauth-config.js";

/** Better Auth owns sessions and credentials, never Person roles or authorization policy. */
export interface AuthEngineConfig {
  /** Same connection string as BACKEND_PG_URL; auth schema via search_path. */
  readonly postgresUrl: string;
  readonly secret: string;
  readonly oauth: OAuthProviderRuntimeConfig;
  readonly trustedOrigins: ReadonlyArray<string>;
  readonly secureCookies: boolean;
}

export const makeAuthPool = (config: AuthEngineConfig) =>
  new Pool({
    connectionString: config.postgresUrl,
    options: "-c search_path=auth",
    max: 4,
    application_name: "vektorprogrammet-auth",
  });

const passwordUnavailable = (cause: unknown): never => {
  if (cause instanceof PasswordHashCapacityError)
    throw new APIError("SERVICE_UNAVAILABLE", {
      code: "PASSWORD_HASH_CAPACITY",
      message: "Sign-in is temporarily unavailable",
    });
  if (cause instanceof PasswordInputTooLongError)
    throw new APIError("BAD_REQUEST", {
      code: "PASSWORD_TOO_LONG",
      message: "Password exceeds the input limit",
    });
  throw cause;
};
const enginePasswordCodec = {
  hash: (password: string) =>
    nativeAndLegacyPasswordCodec.hash(password).catch(passwordUnavailable),
  verify: (input: { hash: string; password: string }) =>
    nativeAndLegacyPasswordCodec.verify(input).catch(passwordUnavailable),
};

/** Request-scoped evidence only. Account persistence belongs to the successful session lifecycle. */
const makeCredentialLifecycleHooks = (database: Pool) => {
  const verified = new WeakMap<typeof enginePasswordCodec.verify, { hash?: string }>();
  return {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return;
      const evidence: { hash?: string } = {};
      const verify: typeof enginePasswordCodec.verify = async (input) => {
        const valid = await enginePasswordCodec.verify(input);
        if (valid) evidence.hash = input.hash;
        return valid;
      };
      verified.set(verify, evidence);
      return { context: { context: { password: { ...ctx.context.password, verify } } } };
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return;
      const evidence = verified.get(ctx.context.password.verify);
      verified.delete(ctx.context.password.verify);
      const session = ctx.context.newSession;
      const returned = ctx.context.returned;
      if (
        !evidence?.hash ||
        !session ||
        returned instanceof APIError ||
        !returned ||
        typeof returned !== "object" ||
        !("token" in returned) ||
        returned.token !== session.session.token ||
        !("user" in returned) ||
        !returned.user ||
        typeof returned.user !== "object" ||
        !("id" in returned.user) ||
        returned.user.id !== session.user.id
      )
        return;
      try {
        const current = isNativePasswordHash(evidence.hash);
        const replacement = current
          ? evidence.hash
          : await enginePasswordCodec.hash(ctx.body.password);
        // A later reset revokes the session, which already exists. An earlier reset
        // loses this exact-hash predicate; remove its stale session in the same statement.
        const result = await database.query<{ accepted: boolean }>(
          `WITH matched AS (
            ${
              current
                ? 'SELECT id FROM auth."account" WHERE "userId"=$1 AND "accountId"=$1 AND "providerId"=\'credential\' AND issuer=$2 AND password=$3'
                : 'UPDATE auth."account" SET password=$5,"updatedAt"=CURRENT_TIMESTAMP WHERE "userId"=$1 AND "accountId"=$1 AND "providerId"=\'credential\' AND issuer=$2 AND password=$3 RETURNING id'
            }
          ), revoked AS (
            DELETE FROM auth."session" WHERE token=$4 AND NOT EXISTS(SELECT 1 FROM matched) RETURNING id
          ) SELECT EXISTS(SELECT 1 FROM matched) AS accepted`,
          current
            ? [
                session.user.id,
                createLocalAccountIssuer("credential"),
                evidence.hash,
                session.session.token,
              ]
            : [
                session.user.id,
                createLocalAccountIssuer("credential"),
                evidence.hash,
                session.session.token,
                replacement,
              ],
        );
        if (!result.rows[0]?.accepted)
          throw new APIError("UNAUTHORIZED", {
            code: "INVALID_EMAIL_OR_PASSWORD",
            message: "Invalid email or password",
          });
      } catch (cause) {
        // Cookie cleanup also removes the earlier success Set-Cookie header.
        deleteSessionCookie(ctx);
        ctx.context.newSession = null;
        await ctx.context.internalAdapter.deleteSession(session.session.token);
        throw cause;
      }
    }),
  };
};

export const makeAuthEngineOptions = (
  config: AuthEngineConfig,
  database: Pool,
  recovery?: ReturnType<typeof makePasswordRecovery>,
) => ({
  secret: config.secret,
  // Engine diagnostics can contain credential URLs or database parameters. Owned audit is authoritative.
  logger: {
    log: () => {
      process.stderr.write("Identity engine diagnostic\n");
    },
  },
  baseURL: config.oauth.canonicalOrigin,
  basePath: "/api/auth",
  database,
  trustedOrigins: [...config.trustedOrigins],
  plugins: [...makeOAuthPlugins(config.oauth)],
  hooks: makeCredentialLifecycleHooks(database),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
    password: enginePasswordCodec,
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
    ...(recovery
      ? { sendResetPassword: recovery.sendResetPassword, onPasswordReset: recovery.onPasswordReset }
      : {}),
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  advanced: {
    useSecureCookies: config.secureCookies,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax" as const,
      path: "/",
      secure: config.secureCookies,
    },
    database: {
      joins: false,
    },
  },
  user: {
    // auth.user.id IS PersonId - set explicitly at seed/creation time.
    modelName: "user",
  },
});

export const makeAuthEngine = (
  config: AuthEngineConfig,
  database: Pool = makeAuthPool(config),
  recovery?: ReturnType<typeof makePasswordRecovery>,
) => betterAuth(makeAuthEngineOptions(config, database, recovery));

export type AuthEngine = ReturnType<typeof makeAuthEngine>;

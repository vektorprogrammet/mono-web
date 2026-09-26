import { DatabasePgPool, pgQuery } from "./pg-pool.js";
import {
  isNativePasswordHash,
  nativePasswordHash,
  verifyNativeOrLegacyPassword,
  type PasswordHashCapacityError,
  type PasswordInputTooLongError,
} from "./password-codec.js";
import { betterAuth, createLocalAccountIssuer, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { deleteSessionCookie, getSessionCookie } from "better-auth/cookies";
import { PasswordRecovery, PasswordRecoveryLive } from "./password-recovery.js";
import type { GenericEndpointContext } from "better-auth";
import { Pool } from "pg";
import { oauthPlugins, type OAuthProviderRuntimeConfig } from "./oauth-config.js";
import {
  flow,
  Context,
  FiberSet,
  Layer,
  Effect,
  Match,
  Schema,
  Option,
  Predicate,
  type Scope,
} from "effect";

/** Runs the Effect program behind one Better Auth callback as the Promise Better Auth awaits. */
export type BetterAuthCallbackRunner = <A, E>(program: Effect.Effect<A, E>) => Promise<A>;

/**
 * Creates the runner for Better Auth's Promise callbacks: it forks each program into a fiber set
 * that the current scope owns, so closing the scope interrupts the callbacks still running. A
 * failed program rejects with its typed failure, so an `APIError` failure reaches Better Auth.
 */
export const makeBetterAuthCallbackRunner: Effect.Effect<
  BetterAuthCallbackRunner,
  never,
  Scope.Scope
> = FiberSet.makeRuntimePromise();

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

/** The password codec's capacity and input limits, as the API errors Better Auth answers with. */
const passwordUnavailable = Match.type<
  PasswordHashCapacityError | PasswordInputTooLongError
>().pipe(
  Match.tag(
    "PasswordHashCapacityError",
    () =>
      new APIError("SERVICE_UNAVAILABLE", {
        code: "PASSWORD_HASH_CAPACITY",
        message: "Sign-in is temporarily unavailable",
      }),
  ),
  Match.tag(
    "PasswordInputTooLongError",
    () =>
      new APIError("BAD_REQUEST", {
        code: "PASSWORD_TOO_LONG",
        message: "Password exceeds the input limit",
      }),
  ),
  Match.exhaustive,
);

const hashEnginePassword = (password: string) =>
  nativePasswordHash(password).pipe(Effect.mapError(passwordUnavailable));

const verifyEnginePassword = (input: { hash: string; password: string }) =>
  verifyNativeOrLegacyPassword(input).pipe(Effect.mapError(passwordUnavailable));

type PasswordVerifier = (input: { hash: string; password: string }) => Promise<boolean>;

/** Request-scoped evidence only. Account persistence belongs to the successful session lifecycle. */
interface VerifiedCredentialEvidence {
  hash?: string;
}

const makeCredentialLifecycleHooks = (database: Pool, run: BetterAuthCallbackRunner) => {
  const verified = new WeakMap<PasswordVerifier, VerifiedCredentialEvidence>();

  return {
    before: createAuthMiddleware((ctx) =>
      run(
        Effect.gen(function* () {
          let access: { personId: string; revision: number } | undefined;

          if (ctx.path === "/reset-password") {
            access = (yield* pgQuery<{ personId: string; revision: number }>(
              database,
              'SELECT u.id AS "personId",u.access_revision AS revision FROM auth.verification v JOIN auth."user" u ON u.id=v.value WHERE v.identifier=$1 AND NOT u.access_disabled',
              ["reset-password:" + (ctx.body?.token ?? "")],
            )).rows[0];

            if (!access) {
              return yield* Effect.fail(
                new APIError("BAD_REQUEST", { code: "INVALID_TOKEN", message: "Invalid token" }),
              );
            }
          } else if (ctx.path === "/sign-in/email") {
            access = (yield* pgQuery<{ personId: string; revision: number }>(
              database,
              'SELECT id AS "personId",access_revision AS revision FROM auth."user" WHERE lower(email)=lower($1) AND NOT access_disabled',
              [ctx.body?.email ?? ""],
            )).rows[0];

            if (!access) {
              return yield* Effect.fail(
                new APIError("UNAUTHORIZED", {
                  code: "INVALID_EMAIL_OR_PASSWORD",
                  message: "Invalid email or password",
                }),
              );
            }
          } else {
            const cookie = getSessionCookie(ctx.headers ?? new Headers());

            if (cookie !== null) {
              const token = cookie.slice(0, cookie.lastIndexOf("."));
              access = (yield* pgQuery<{ personId: string; revision: number }>(
                database,
                'SELECT "userId" AS "personId",access_revision AS revision FROM auth.usable_human_sessions WHERE token=$1',
                [token],
              )).rows[0];

              // Sign-out must clear the cookies of a revoked or expired session, never refuse them.
              if (!access && ctx.path !== "/request-password-reset" && ctx.path !== "/sign-out") {
                // better-call's `json` answers synchronously, although its type is a Promise.
                if (ctx.path === "/get-session") {
                  return yield* Effect.promise(() => Promise.resolve(ctx.json(null)));
                }

                return yield* Effect.fail(
                  new APIError("UNAUTHORIZED", {
                    code: "INVALID_SESSION",
                    message: "Session unavailable",
                  }),
                );
              }
            }
          }

          if (ctx.path !== "/sign-in/email")
            return { context: { context: { nativeAccessEvidence: access } } };
          const evidence: VerifiedCredentialEvidence = {};

          const verify: PasswordVerifier = (input) =>
            run(
              verifyEnginePassword(input).pipe(
                Effect.tap((valid) =>
                  Effect.sync(() => {
                    if (valid) evidence.hash = input.hash;
                  }),
                ),
              ),
            );

          verified.set(verify, evidence);

          return {
            context: {
              context: {
                nativeAccessEvidence: access,
                password: { ...ctx.context.password, verify },
              },
            },
          };
        }),
      ),
    ),
    after: createAuthMiddleware((ctx) =>
      run(
        Effect.gen(function* () {
          if (ctx.path === "/get-session") {
            const result = ctx.context.returned;

            if (
              result &&
              (result === null || Predicate.isObjectOrArray(result)) &&
              "session" in result &&
              result.session &&
              (result.session === null || Predicate.isObjectOrArray(result.session)) &&
              "id" in result.session
            ) {
              const usable = yield* pgQuery(
                database,
                `SELECT 1 FROM auth.usable_human_sessions WHERE id=$1`,
                [result.session.id],
              );

              if (usable.rowCount !== 1) {
                deleteSessionCookie(ctx);

                // better-call's `json` answers synchronously, although its type is a Promise.
                return yield* Effect.promise(() => Promise.resolve(ctx.json(null)));
              }
            }
          }

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
            !(returned === null || Predicate.isObjectOrArray(returned)) ||
            !("token" in returned) ||
            returned.token !== session.session.token ||
            !("user" in returned) ||
            !returned.user ||
            !(returned.user === null || Predicate.isObjectOrArray(returned.user)) ||
            !("id" in returned.user) ||
            returned.user.id !== session.user.id
          )
            return;
          const verifiedHash = evidence.hash;

          yield* Effect.gen(function* () {
            const usable = yield* pgQuery(
              database,
              `SELECT 1 FROM auth.usable_human_sessions WHERE id=$1`,
              [session.session.id],
            );

            if (usable.rowCount !== 1) {
              return yield* Effect.fail(
                new APIError("UNAUTHORIZED", {
                  code: "INVALID_EMAIL_OR_PASSWORD",
                  message: "Invalid email or password",
                }),
              );
            }

            const current = isNativePasswordHash(verifiedHash);

            const replacement = current
              ? verifiedHash
              : yield* hashEnginePassword(ctx.body.password);

            // A later reset revokes the session, which already exists. An earlier reset
            // loses this exact-hash predicate; remove its stale session in the same statement.
            const result = yield* pgQuery<{ accepted: boolean }>(
              database,
              `WITH matched AS (
            ${
              current
                ? 'SELECT id FROM auth."account" WHERE "userId"=$1 AND "accountId"=$1 AND "providerId"=\'credential\' AND issuer=$2 AND password=$3'
                : 'UPDATE auth."account" SET password=$5,access_revision=(SELECT access_revision FROM auth.usable_human_sessions WHERE token=$4),"updatedAt"=date_trunc(\'milliseconds\',CURRENT_TIMESTAMP,\'UTC\') WHERE "userId"=$1 AND "accountId"=$1 AND "providerId"=\'credential\' AND issuer=$2 AND password=$3 RETURNING id'
            }
          ), revoked AS (
            DELETE FROM auth."session" WHERE token=$4 AND NOT EXISTS(SELECT 1 FROM matched) RETURNING id
          ) SELECT EXISTS(SELECT 1 FROM matched) AS accepted`,
              current
                ? [
                    session.user.id,
                    createLocalAccountIssuer("credential"),
                    verifiedHash,
                    session.session.token,
                  ]
                : [
                    session.user.id,
                    createLocalAccountIssuer("credential"),
                    verifiedHash,
                    session.session.token,
                    replacement,
                  ],
            );

            if (!result.rows[0]?.accepted) {
              return yield* Effect.fail(
                new APIError("UNAUTHORIZED", {
                  code: "INVALID_EMAIL_OR_PASSWORD",
                  message: "Invalid email or password",
                }),
              );
            }
          }).pipe(
            // Any failure ends the new session; a failing cleanup replaces the failure.
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                // Cookie cleanup also removes the earlier success Set-Cookie header.
                deleteSessionCookie(ctx);
                ctx.context.newSession = null;
                yield* Effect.promise(() =>
                  ctx.context.internalAdapter.deleteSession(session.session.token),
                );

                return yield* Effect.failCause(cause);
              }),
            ),
          );
        }),
      ),
    ),
  };
};

const decodeNativeAccessEvidence = flow(
  Schema.decodeUnknownOption(
    Schema.Struct({
      nativeAccessEvidence: Schema.Struct({
        personId: Schema.String,
        revision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
      }),
    }),
  ),
  Option.map((context) => context.nativeAccessEvidence),
);

const makeAccessDatabaseHooks = (
  database: Pool,
  run: BetterAuthCallbackRunner,
): NonNullable<BetterAuthOptions["databaseHooks"]> => {
  const accessRevision = (context: GenericEndpointContext | null, personId?: string) =>
    Effect.gen(function* () {
      const evidence = Option.getOrUndefined(decodeNativeAccessEvidence(context?.context));

      if (evidence && (personId === undefined || personId === evidence.personId))
        return evidence.revision;

      // Internal adapter provisioning has no endpoint context. HTTP and direct API
      // password changes must carry the revision captured before credential work.
      if (context == null && personId !== undefined) {
        const row = (yield* pgQuery<{ revision: number }>(
          database,
          'SELECT access_revision AS revision FROM auth."user" WHERE id=$1 AND NOT access_disabled',
          [personId],
        )).rows[0];

        if (row) return row.revision;
      }

      return yield* Effect.fail(
        new APIError("UNAUTHORIZED", {
          code: "INVALID_SESSION",
          message: "Account access unavailable",
        }),
      );
    });

  return {
    account: {
      create: {
        before: (data, ctx) =>
          run(
            Effect.map(accessRevision(ctx, data.userId), (revision) => ({
              data: { ...data, accessRevision: revision },
            })),
          ),
      },
      update: {
        before: (data, ctx) =>
          run(
            "password" in data
              ? Effect.map(accessRevision(ctx), (revision) => ({
                  data: { ...data, accessRevision: revision },
                }))
              : Effect.succeed({ data }),
          ),
      },
    },
    session: {
      create: {
        before: (data, ctx) =>
          run(
            Effect.gen(function* () {
              const evidence = Option.getOrUndefined(decodeNativeAccessEvidence(ctx?.context));

              const revision =
                evidence?.personId === data.userId
                  ? evidence.revision
                  : (yield* pgQuery<{ revision: number }>(
                      database,
                      'SELECT access_revision AS revision FROM auth."user" WHERE id=$1 AND NOT access_disabled',
                      [data.userId],
                    )).rows[0]?.revision;

              if (revision === undefined) {
                return yield* Effect.fail(
                  new APIError("UNAUTHORIZED", {
                    code: "INVALID_SESSION",
                    message: "Account access unavailable",
                  }),
                );
              }

              return { data: { ...data, accessRevision: revision } };
            }),
          ),
      },
    },
  };
};

export const makeAuthEngineOptions = (
  config: AuthEngineConfig,
  database: Pool,
  run: BetterAuthCallbackRunner,
  recovery?: PasswordRecovery["Service"],
) => {
  const emailAndPassword: NonNullable<BetterAuthOptions["emailAndPassword"]> = {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
    password: {
      hash: (password) => run(hashEnginePassword(password)),
      verify: (input) => run(verifyEnginePassword(input)),
    },
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
  };

  if (recovery !== undefined) {
    emailAndPassword.sendResetPassword = (data) => run(recovery.sendResetPassword(data));
    emailAndPassword.onPasswordReset = (data) => run(recovery.onPasswordReset(data));
  }

  return {
    secret: config.secret,
    logger: {
      log: () => {
        process.stderr.write("Identity engine diagnostic\n");
      },
    },
    baseURL: config.oauth.canonicalOrigin,
    basePath: "/api/auth",
    database,
    trustedOrigins: [...config.trustedOrigins],
    plugins: [...oauthPlugins(config.oauth)],
    hooks: makeCredentialLifecycleHooks(database, run),
    databaseHooks: makeAccessDatabaseHooks(database, run),
    account: {
      additionalFields: {
        accessRevision: {
          type: "number" as const,
          fieldName: "access_revision",
          input: false,
          returned: false,
          required: false,
        },
      },
    },
    emailAndPassword,
    session: {
      additionalFields: {
        accessRevision: {
          type: "number" as const,
          fieldName: "access_revision",
          input: false,
          returned: false,
          required: false,
        },
      },
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
  };
};

export const makeAuthEngine = (
  config: AuthEngineConfig,
  database: Pool,
  run: BetterAuthCallbackRunner,
  recovery?: PasswordRecovery["Service"],
) => betterAuth(makeAuthEngineOptions(config, database, run, recovery));

export type AuthEngine = ReturnType<typeof makeAuthEngine>;

export class NativeAuthEngine extends Context.Service<NativeAuthEngine, AuthEngine>()(
  "@vektorprogrammet/database/NativeAuthEngine",
) {}

export const NativeAuthEngineLive = (config: AuthEngineConfig) =>
  Layer.effect(
    NativeAuthEngine,
    Effect.gen(function* () {
      const pool = yield* DatabasePgPool;
      const recovery = yield* PasswordRecovery;
      const run = yield* makeBetterAuthCallbackRunner;

      return makeAuthEngine(config, pool, run, recovery);
    }),
  ).pipe(Layer.provideMerge(PasswordRecoveryLive(config)));

export const AuthPoolLive = (config: AuthEngineConfig) =>
  Layer.effect(
    DatabasePgPool,
    Effect.acquireRelease(
      Effect.sync(() => makeAuthPool(config)),
      (pool) => Effect.promise(() => pool.end()),
    ),
  );

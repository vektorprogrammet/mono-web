/**
 * EX-0029: required public native APIs in exact stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import assert from "node:assert/strict";
import { createLocalAccountIssuer } from "better-auth";
import type { AuthEngine } from "@vektorprogrammet/database/auth-engine";
import { nativePasswordHash } from "@vektorprogrammet/database/password-codec";
import { Deferred, Effect, Fiber, FiberSet, Schema } from "effect";
import type { SqlClient } from "effect/sql";

export class CredentialRaceBoundaryFailure extends Schema.TaggedError<CredentialRaceBoundaryFailure>()(
  "CredentialRaceBoundaryFailure",
  {
    operation: Schema.Literals([
      "Context",
      "CreateUser",
      "LinkAccount",
      "CreateSession",
      "SignIn",
      "GetSession",
      "Reset",
    ]),
    cause: Schema.Defect(),
  },
) {}

const foreign = <A>(operation: CredentialRaceBoundaryFailure["operation"], run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new CredentialRaceBoundaryFailure({ operation, cause }),
  });

const decodePasswords = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ password: Schema.String })),
);

const decodeSessionCounts = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ n: Schema.Int })),
);

/**
 * Real Better Auth/native SQL regression: reset commits after password verification and before session creation.
 * The case scope owns the callback FiberSet and restores the engine's session hook on success, failure and interruption.
 * Better Auth's Promise ABI has no cancellation signal; closing the callback scope interrupts the waiting hook,
 * while the engine owns any already-started foreign work. No SQL transaction is transported through a Promise.
 * Retire the hook adapter when AuthEngine exposes a native session-creation test boundary.
 */

export const proveCredentialResetRace = Effect.fn("proveCredentialResetRace")(function* (input: {
  readonly engine: AuthEngine;
  readonly sql: SqlClient.SqlClient;
  readonly legacyHash: string;
  readonly password: string;
  readonly resetPassword: string;
  readonly origin: string;
  readonly reset: (email: string) => Effect.Effect<void, CredentialRaceBoundaryFailure>;
}) {
  const context = yield* foreign("Context", () => input.engine.$context);

  const originalCreate = context.internalAdapter.createSession.bind(context.internalAdapter);

  const nativeHash = yield* nativePasswordHash(input.password);

  for (const [personId, hash] of [
    ["race-legacy", input.legacyHash],
    ["race-native", nativeHash],
  ] as const) {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const email = `${personId}@example.invalid`;

        yield* input.sql.unsafe(
          "INSERT INTO public.person_profiles(person_id,first_name,last_name) VALUES($1,'Synthetic','Credential')",
          [personId],
        );

        yield* foreign("CreateUser", () =>
          context.internalAdapter.createUser(
            { id: personId, name: "Synthetic Credential", email, emailVerified: true },
            { method: "email-password" },
          ),
        );

        yield* foreign("LinkAccount", () =>
          context.internalAdapter.linkAccount({
            accountId: personId,
            providerId: "credential",
            issuer: createLocalAccountIssuer("credential"),
            userId: personId,
            password: hash,
          }),
        );

        const reached = yield* Deferred.make<void>();

        const release = yield* Deferred.make<void>();

        const runCallback = yield* FiberSet.makeRuntimePromise();

        yield* Effect.acquireRelease(
          Effect.sync(() => {
            context.internalAdapter.createSession = (...args) =>
              runCallback(
                Effect.gen(function* () {
                  if (args[0] === personId) {
                    yield* Deferred.succeed(reached, undefined);

                    yield* Deferred.await(release);
                  }

                  return yield* foreign("CreateSession", () => originalCreate(...args));
                }),
              );
          }),
          () =>
            Deferred.succeed(release, undefined).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  context.internalAdapter.createSession = originalCreate;
                }),
              ),
            ),
        );

        const login = (password: string) =>
          foreign("SignIn", () =>
            input.engine.api.signInEmail({
              body: { email, password },
              headers: new Headers({ origin: input.origin }),
              asResponse: true,
            }),
          );

        const staleLogin = yield* Effect.forkChild(login(input.password));

        const resetHash = yield* Effect.gen(function* () {
          yield* Deferred.await(reached).pipe(Effect.timeout("10 seconds"));

          yield* input.reset(email);

          const passwords = yield* input.sql
            .unsafe('SELECT password FROM auth."account" WHERE "userId"=$1', [personId])
            .pipe(Effect.flatMap(decodePasswords));

          assert.ok(passwords[0], "reset credential account is required");

          return passwords[0].password;
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));

        const response = yield* Fiber.join(staleLogin);

        assert.equal(response.status, 401, "stale verified password cannot authenticate");

        const cookies = response.headers.getSetCookie();

        assert.ok(
          cookies.length > 0 && cookies.every((value) => /Max-Age=0/iu.test(value)),
          "no live Set-Cookie survives",
        );

        const cookie = cookies.map((value) => value.split(";")[0]).join("; ");

        assert.equal(
          yield* foreign("GetSession", () =>
            input.engine.api.getSession({ headers: new Headers({ cookie }) }),
          ),
          null,
          "stale cookie cannot resolve a session",
        );

        const sessions = yield* input.sql
          .unsafe('SELECT count(*)::int n FROM auth."session" WHERE "userId"=$1', [personId])
          .pipe(Effect.flatMap(decodeSessionCounts));

        assert.equal(sessions[0]?.n, 0, "stale new session removed from database");

        const finalPasswords = yield* input.sql
          .unsafe('SELECT password FROM auth."account" WHERE "userId"=$1', [personId])
          .pipe(Effect.flatMap(decodePasswords));

        assert.equal(finalPasswords[0]?.password, resetHash, "reset hash wins stale upgrade");

        assert.equal((yield* login(input.password)).status, 401, "old password remains denied");

        assert.equal(
          (yield* login(input.resetPassword)).status,
          200,
          "reset password remains usable",
        );
      }),
    );
  }
});

import { describe, expect, it } from "@effect/vitest";
import { IdentitySnapshot, OAuthCredentialAuthority } from "@vektorprogrammet/database";
import {
  Identity,
  IdentityActor,
  IdentityOwnedSessionNotFound,
  type IdentityOperations,
  type IdentityRequestContext,
  IdentitySession,
  IdentitySessionNotFound,
} from "@vektorprogrammet/domain/identity";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { IdempotencyKey, isProblem } from "@vektorprogrammet/rpc/problem";
import { DateTime, Effect, Layer } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import { backendDatabase } from "../../test/database.js";
import { backendTestConfig } from "../../test/config.js";
import { makeBackendTestRpc } from "../test/native-rpc.js";

const token = "better-auth.session_token";

const currentSession = IdentitySession.make({
  sessionId: "session-1",
  createdAt: DateTime.makeUnsafe("2031-09-15T12:00:00.000Z"),
  updatedAt: DateTime.makeUnsafe("2031-09-15T12:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2031-09-16T12:00:00.000Z"),
  ipAddress: "127.0.0.1",
  userAgent: "router-test",
  current: true,
});

const actor = IdentityActor.make({
  personId: PersonId.make("member-1"),
  sessionId: "session-1",
  expiresAt: currentSession.expiresAt,
});

/** An identity engine that knows one session cookie, `valid-session`. */
const identityOperations = (overrides: Partial<IdentityOperations> = {}): IdentityOperations => ({
  signIn: () => Effect.die("unexpected sign-in"),
  resolveSession: (cookieHeader) =>
    cookieHeader?.split(/;\s*/u).includes(`${token}=valid-session`) === true
      ? Effect.succeed(actor)
      : Effect.fail(IdentitySessionNotFound.make()),
  readCurrentSession: () => Effect.succeed(currentSession),
  listSessions: () => Effect.succeed([currentSession]),
  revokeCurrentSession: () => Effect.succeed({ setCookies: [] }),
  revokeSession: () => Effect.succeed({ setCookies: [] }),
  revokeOtherSessions: () => Effect.succeed({ setCookies: [] }),
  revokeAllSessions: () => Effect.succeed({ setCookies: [] }),
  recordSecurityEvent: () => Effect.void,
  signOut: () => Effect.succeed({ setCookies: [] }),
  ...overrides,
});

/** Every session command's request evidence, as the identity snapshot received it. */
interface Recorded {
  readonly revoked: Array<{ readonly operation: string; readonly request: IdentityRequestContext }>;
}

const backendFor = (identity: IdentityOperations, recorded: Recorded = { revoked: [] }) => {
  const database = backendDatabase();

  const snapshot = IdentitySnapshot.of({
    resolveSession: (cookieHeader) =>
      identity
        .resolveSession(cookieHeader)
        .pipe(
          Effect.catchTag("IdentitySessionExpired", () =>
            Effect.fail(IdentitySessionNotFound.make()),
          ),
        ),
    revokeCurrentSession: (_actor, request) =>
      Effect.sync(() => {
        recorded.revoked.push({ operation: "current", request });

        return { setCookies: [] };
      }),
    revokeSession: (_actor, sessionId, request) =>
      identity.revokeSession(undefined, sessionId, request).pipe(
        Effect.tap(() =>
          Effect.sync(() => recorded.revoked.push({ operation: sessionId, request })),
        ),
        Effect.catchTag(["IdentitySessionNotFound", "IdentitySessionExpired"], () =>
          Effect.fail(IdentityOwnedSessionNotFound.make({ sessionId })),
        ),
      ),
    revokeOtherSessions: (_actor, request) =>
      Effect.sync(() => {
        recorded.revoked.push({ operation: "others", request });

        return { setCookies: [] };
      }),
    revokeAllSessions: (_actor, request) =>
      Effect.sync(() => {
        recorded.revoked.push({ operation: "all", request });

        return { setCookies: [] };
      }),
  });

  return makeBackendTestRpc({
    config: backendTestConfig,
    services: Layer.mergeAll(
      database.layer,
      Layer.succeed(Identity, identity),
      Layer.succeed(IdentitySnapshot, snapshot),
      Layer.succeed(
        OAuthCredentialAuthority,
        OAuthCredentialAuthority.of({
          resolve: () => Effect.die("unexpected OAuth credential resolution"),
          resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
        }),
      ),
    ),
    // The browser's user agent is an HTTP header; the audit records it from the request.
    transportHeaders: { "user-agent": "session-rpc-test" },
  });
};

const cookie = { cookie: `theme=dark; ${token}=valid-session` };

const key = (value: string) => IdempotencyKey.make(value.padEnd(22, "0"));

const problemCode = <E>(failure: E) => (isProblem(failure) ? failure.code : failure);

describe("session RPCs", () => {
  it.live("read, list, and revoke the caller's own sessions", () =>
    Effect.gen(function* () {
      const recorded: Recorded = { revoked: [] };
      const client = yield* backendFor(identityOperations(), recorded).client;
      const as = RpcClient.withHeaders(cookie);

      expect(yield* client["system.readSession"]().pipe(as)).toEqual({
        sessionId: "session-1",
        personId: PersonId.make("member-1"),
        createdAt: "2031-09-15T12:00:00.000Z",
        updatedAt: "2031-09-15T12:00:00.000Z",
        expiresAt: "2031-09-16T12:00:00.000Z",
        ipAddress: "127.0.0.1",
        userAgent: "router-test",
        current: true,
      });

      expect(yield* client["system.listSessions"]().pipe(as)).toEqual([
        {
          sessionId: "session-1",
          personId: PersonId.make("member-1"),
          createdAt: "2031-09-15T12:00:00.000Z",
          updatedAt: "2031-09-15T12:00:00.000Z",
          expiresAt: "2031-09-16T12:00:00.000Z",
          ipAddress: "127.0.0.1",
          userAgent: "router-test",
          current: true,
        },
      ]);

      yield* client["system.deleteSession"]({ idempotencyKey: key("delete-current") }).pipe(as);

      yield* client["system.deleteOwnedSession"]({
        idempotencyKey: key("delete-owned"),
        sessionId: "session-2",
      }).pipe(as);

      yield* client["system.revokeOtherSessions"]({ idempotencyKey: key("revoke-others") }).pipe(
        as,
      );

      yield* client["system.revokeAllSessions"]({ idempotencyKey: key("revoke-all") }).pipe(as);

      expect(
        recorded.revoked.map(({ operation, request }) => [operation, request.userAgent]),
      ).toEqual([
        ["current", "session-rpc-test"],
        ["session-2", "session-rpc-test"],
        ["others", "session-rpc-test"],
        ["all", "session-rpc-test"],
      ]);

      expect(problemCode(yield* Effect.flip(client["system.readSession"]()))).toBe(
        "credential.missing",
      );
    }),
  );

  it.live("asks the identity engine only for a Better Auth session cookie", () =>
    Effect.gen(function* () {
      let currentReads = 0;

      const client = yield* backendFor(
        identityOperations({
          resolveSession: () => Effect.succeed(actor),
          readCurrentSession: () =>
            Effect.sync(() => {
              currentReads += 1;

              return currentSession;
            }),
        }),
      ).client;

      for (const value of ["", "theme=dark", "vp.session_token=opaque"]) {
        const failure = yield* Effect.flip(
          client["system.readSession"]().pipe(RpcClient.withHeaders({ cookie: value })),
        );

        expect(problemCode(failure)).toBe("credential.missing");
      }

      expect(currentReads).toBe(0);

      for (const value of [
        "better-auth.session_token=opaque",
        "__Secure-better-auth.session_token=opaque",
      ]) {
        yield* client["system.readSession"]().pipe(RpcClient.withHeaders({ cookie: value }));
      }

      expect(currentReads).toBe(2);
    }),
  );

  it.live("classifies absent and rejected session credentials", () =>
    Effect.gen(function* () {
      const client = yield* backendFor(identityOperations()).client;

      for (const [headers, code] of [
        [{}, "credential.missing"],
        [{ cookie: "theme=dark; vp.session_token=opaque" }, "credential.missing"],
        [{ cookie: `theme=dark; ${token}=unknown-session` }, "credential.invalid"],
        [{ authorization: "Bearer unknown-token" }, "credential.invalid"],
        [{ ...cookie, authorization: "Bearer second-credential" }, "credential.invalid"],
      ] as const) {
        const failure = yield* Effect.flip(
          client["system.listSessions"]().pipe(RpcClient.withHeaders(headers)),
        );

        expect(problemCode(failure)).toBe(code);
      }
    }),
  );

  it.live("conceals missing, non-owned, and already-revoked session ids identically", () =>
    Effect.gen(function* () {
      const owned = new Set(["owned-session"]);
      let revokeCalls = 0;

      const client = yield* backendFor(
        identityOperations({
          revokeSession: (_actor, sessionId) =>
            Effect.suspend(() => {
              revokeCalls += 1;

              return owned.delete(sessionId)
                ? Effect.succeed({ setCookies: [] })
                : Effect.fail(IdentityOwnedSessionNotFound.make({ sessionId }));
            }),
        }),
      ).client;

      const as = RpcClient.withHeaders(cookie);
      const first = { idempotencyKey: key("owned-session-delete"), sessionId: "owned-session" };

      yield* client["system.deleteOwnedSession"](first).pipe(as);

      // The replay answers the stored receipt without revoking again.
      yield* client["system.deleteOwnedSession"](first).pipe(as);

      expect(revokeCalls).toBe(1);

      for (const sessionId of ["owned-session", "missing-session", "another-person-session"]) {
        const failure = yield* Effect.flip(
          client["system.deleteOwnedSession"]({
            idempotencyKey: key(`conceal-${sessionId}`),
            sessionId,
          }).pipe(as),
        );

        expect(problemCode(failure)).toBe("resource.not-found");
      }

      expect(revokeCalls).toBe(4);

      // The same key for another session is another request.
      const conflict = yield* Effect.flip(
        client["system.deleteOwnedSession"]({ ...first, sessionId: "missing-session" }).pipe(as),
      );

      expect(problemCode(conflict)).toBe("resource.not-found");
    }),
  );

  it.live("replays a session command whatever its key names", () =>
    Effect.gen(function* () {
      const recorded: Recorded = { revoked: [] };
      const client = yield* backendFor(identityOperations(), recorded).client;
      const as = RpcClient.withHeaders(cookie);
      const command = { idempotencyKey: key("revoke-others-replay") };

      yield* client["system.revokeOtherSessions"](command).pipe(as);
      yield* client["system.revokeOtherSessions"](command).pipe(as);

      expect(recorded.revoked.map(({ operation }) => operation)).toEqual(["others"]);

      // Another operation under the same key is a different command identity.
      yield* client["system.revokeAllSessions"](command).pipe(as);

      expect(recorded.revoked.map(({ operation }) => operation)).toEqual(["others", "all"]);
    }),
  );
});

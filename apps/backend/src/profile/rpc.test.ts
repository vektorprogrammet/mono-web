import { describe, expect, it } from "@effect/vitest";
import { Database, IdentitySnapshot, OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { ProfileLive } from "@vektorprogrammet/database/profile";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import {
  Organization,
  OrganizationPersistenceError,
  type OrganizationPersonAuthority,
  OrganizationPersonAuthoritySchema,
  PersonId,
} from "@vektorprogrammet/domain/organization";
import { IdempotencyKey, isProblem, StrongETag } from "@vektorprogrammet/rpc/problem";
import { DateTime, Effect, Layer, Schema } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import { backendDatabase } from "../../test/database.js";
import { backendTestConfig } from "../../test/config.js";
import { makeBackendTestRpc } from "../test/native-rpc.js";

const personId = PersonId.make("profile-test-person");

const cookie = { cookie: "better-auth.session_token=profile-test-session" };

const authority = (
  globalAdministrator: "Active" | "Inactive" | "Absent",
  memberships: ReadonlyArray<{ readonly active: boolean; readonly unitLeader: boolean }>,
) =>
  Schema.decodeUnknownSync(OrganizationPersonAuthoritySchema)({
    personId,
    evaluatedAt: "2032-04-01T12:00:00.000Z",
    globalAdministrator,
    memberships: memberships.map((membership, index) => ({
      membershipId: `membership-${index}`,
      teamId: "team-1",
      departmentId: "department-1",
      unitKind: "Team",
      teamScope: "HomeDepartment",
      departmentIndependent: false,
      ...membership,
    })),
    nationalBoardSeats: [],
    delegations: [],
  });

const member = authority("Absent", [{ active: true, unitLeader: false }]);

const actor = new IdentityActor({
  personId,
  sessionId: "profile-test-session",
  expiresAt: DateTime.makeUnsafe("2032-04-02T12:00:00.000Z"),
});

const identity = Identity.of({
  signIn: () => Effect.die("unexpected sign-in"),
  resolveSession: (cookieHeader: string | undefined) =>
    cookieHeader?.includes("profile-test-session") === true
      ? Effect.succeed(actor)
      : Effect.fail(new IdentitySessionNotFound()),
  readCurrentSession: () => Effect.die("unexpected session read"),
  listSessions: () => Effect.die("unexpected session list"),
  revokeCurrentSession: () => Effect.die("unexpected session mutation"),
  revokeSession: () => Effect.die("unexpected session mutation"),
  revokeOtherSessions: () => Effect.die("unexpected session mutation"),
  revokeAllSessions: () => Effect.die("unexpected session mutation"),
  recordSecurityEvent: () => Effect.die("unexpected identity audit"),
  signOut: () => Effect.succeed({ setCookies: [] }),
} satisfies IdentityOperations);

const securityServices = Layer.mergeAll(
  Layer.succeed(Identity, identity),
  Layer.mock(IdentitySnapshot, {
    resolveSession: (cookieHeader) =>
      identity.resolveSession(cookieHeader).pipe(
        Effect.catchTag("IdentitySessionExpired", () => Effect.fail(new IdentitySessionNotFound())),
      ),
  }),
  Layer.succeed(
    OAuthCredentialAuthority,
    OAuthCredentialAuthority.of({
      resolve: () => Effect.die("unexpected OAuth credential resolution"),
      resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
    }),
  ),
);

const seedProfile = (representationRevision: number) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO person_profiles VALUES (${personId},'Ada','Lovelace',7)`;
      yield* sql`INSERT INTO person_contact_profiles VALUES (${personId},'ada@example.invalid','+47 900 00 000',11)`;
      yield* sql`UPDATE public.profile_http_versions SET representation_revision=${representationRevision} WHERE person_id=${personId}`;
    }),
  );

/** The backend over a seeded profile, whose Organization resolves the caller to `resolved`. */
const backendFor = (
  resolved: Effect.Effect<OrganizationPersonAuthority, OrganizationPersistenceError>,
  representationRevision = 3,
) => {
  const database = backendDatabase(seedProfile(representationRevision));
  const organization = Layer.mock(Organization, { resolvePersonAuthority: () => resolved });

  return makeBackendTestRpc(
    backendTestConfig,
    Layer.mergeAll(
      database.layer,
      organization,
      securityServices,
      ProfileLive.pipe(Layer.provide(Layer.merge(database.layer, organization))),
    ),
  );
};

const problemCode = <E>(failure: E) => (isProblem(failure) ? failure.code : failure);

const key = (value: string) => IdempotencyKey.make(value.padEnd(22, "0"));

const staleETag = StrongETag.make(`"vkr2.${"A".repeat(43)}"`);

describe("profile.readOwnProfile", () => {
  it.live.each([
    ["AuthorityInactive", authority("Inactive", [{ active: false, unitLeader: false }])],
    ["NotInScope", authority("Absent", [])],
  ] as const)("answers %s as a typed denial", ([_, resolved]) =>
    Effect.gen(function* () {
      const client = yield* backendFor(Effect.succeed(resolved)).client;

      const failure = yield* Effect.flip(
        client["profile.readOwnProfile"]().pipe(RpcClient.withHeaders(cookie)),
      );

      expect(problemCode(failure)).toBe("authority.denied");
    }),
  );

  it.live("answers an unavailable authority provider as profile.unavailable", () =>
    Effect.gen(function* () {
      const client = yield* backendFor(
        Effect.fail(
          new OrganizationPersistenceError({
            operation: "resolve profile test authority",
            message: "provider unavailable",
          }),
        ),
      ).client;

      const failure = yield* Effect.flip(
        client["profile.readOwnProfile"]().pipe(RpcClient.withHeaders(cookie)),
      );

      expect(problemCode(failure)).toBe("profile.unavailable");
    }),
  );

  it.live("changes its entity tag only after the persisted representation revision changes", () =>
    Effect.gen(function* () {
      const read = (resolved: OrganizationPersonAuthority, representationRevision: number) =>
        Effect.flatMap(backendFor(Effect.succeed(resolved), representationRevision).client, (client) =>
          client["profile.readOwnProfile"]().pipe(RpcClient.withHeaders(cookie)),
        );

      const leader = authority("Absent", [{ active: true, unitLeader: true }]);
      const asMember = yield* read(member, 3);
      const asLeaderWithoutRevision = yield* read(leader, 3);
      const asLeaderAfterRevision = yield* read(leader, 4);

      expect(asMember.profile).toEqual({
        personId,
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.invalid",
        phone: "+47 900 00 000",
        role: "ROLE_TEAM_MEMBER",
        nameRevision: 7,
        contactRevision: 11,
      });
      expect(asLeaderWithoutRevision.profile.role).toBe("ROLE_TEAM_LEADER");
      expect(asLeaderWithoutRevision.etag).toBe(asMember.etag);
      expect(asLeaderAfterRevision.etag).not.toBe(asMember.etag);
    }),
  );
});

describe("profile.updateOwnProfile", () => {
  it.live("applies a merge patch under its entity tag and replays it by key", () =>
    Effect.gen(function* () {
      const client = yield* backendFor(Effect.succeed(member)).client;
      const as = RpcClient.withHeaders(cookie);
      const current = yield* client["profile.readOwnProfile"]().pipe(as);

      const update = (
        idempotencyKey: IdempotencyKey,
        ifMatch: StrongETag,
        request: Parameters<(typeof client)["profile.updateOwnProfile"]>[0]["request"],
      ) => client["profile.updateOwnProfile"]({ idempotencyKey, ifMatch, request }).pipe(as);

      expect(problemCode(yield* Effect.flip(update(key("no-change"), current.etag, {})))).toBe(
        "validation.no-change",
      );

      expect(
        problemCode(yield* Effect.flip(update(key("delete-phone"), current.etag, { phone: null }))),
      ).toBe("validation.field-not-deletable");

      expect(
        problemCode(
          yield* Effect.flip(update(key("stale-tag"), staleETag, { firstName: "Grace" })),
        ),
      ).toBe("precondition.failed");

      const updated = yield* update(key("rename"), current.etag, { firstName: "Grace" });

      expect(updated.profile).toEqual({
        ...current.profile,
        firstName: "Grace",
        // The domain command writes the name and the contact together.
        nameRevision: current.profile.nameRevision + 1,
        contactRevision: current.profile.contactRevision + 1,
      });
      expect(updated.etag).not.toBe(current.etag);

      // A retry answers the first result, although the tag it names is no longer current.
      expect(yield* update(key("rename"), current.etag, { firstName: "Grace" })).toEqual(updated);

      expect(
        problemCode(
          yield* Effect.flip(update(key("rename"), current.etag, { firstName: "Ingrid" })),
        ),
      ).toBe("idempotency.digest-conflict");

      expect(yield* client["profile.readOwnProfile"]().pipe(as)).toEqual(updated);
    }),
  );
});

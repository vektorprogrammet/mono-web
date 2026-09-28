import { administratorDepartmentReach } from "@vektorprogrammet/domain/organization/authority-fixtures";
import { createHash } from "node:crypto";
import { Database, IdentitySnapshot, OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { commandOnboarding } from "@vektorprogrammet/database/onboarding";
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import {
  CredentialEvidenceRef,
  CredentialMechanismSchema,
  CredentialOutcomeSchema,
  PrincipalSchema,
} from "@vektorprogrammet/domain/authz";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import type { OnboardingClaim } from "@vektorprogrammet/domain/onboarding";
import {
  DepartmentId,
  MembershipId,
  Organization,
  PersonId,
  TeamId,
} from "@vektorprogrammet/domain/organization";
import { IdempotencyKey, isProblem, type Problem } from "@vektorprogrammet/rpc/problem";
import { DateTime, Effect, Layer } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { describe, expect, it } from "@effect/vitest";
import { backendDatabase } from "../../test/database.js";
import { backendTestConfig } from "../../test/config.js";
import { makeBackendTestRpc } from "../test/native-rpc.js";

const session = "better-auth.session_token=member-1-session";

// The coordinator leads the department's board, so it holds `admissions.outcomes` there.
const issuerSession = "better-auth.session_token=claim-issuer-session";

// A delegated OAuth bearer of the same Person as the session.
const bearer = "Bearer member-1-bearer";

const departmentId = DepartmentId.make("claim-department");

const bearerOutcome = (request: Request) =>
  request.headers.get("authorization") === bearer
    ? CredentialOutcomeSchema.cases.Accepted.make({
        mechanism: CredentialMechanismSchema.cases.OAuthUserBearer.make({}),
        principal: PrincipalSchema.cases.Person.make({ personId: PersonId.make("member-1") }),
        evidenceRef: CredentialEvidenceRef.make("oauth:Person:member-1-bearer"),
      })
    : CredentialOutcomeSchema.cases.Rejected.make({ reason: "Invalid" });

// Each invitation binds one applicant; the unknown token was never issued.
const tokens = {
  a: `onboard_${"a".repeat(64)}`,
  b: `onboard_${"b".repeat(64)}`,
  unknown: `onboard_${"c".repeat(64)}`,
} as const;

const seed = Database.use((sql) =>
  Effect.gen(function* () {
    // The claim compares expiry with the database clock, so invitations are issued now.
    const issuedAt = DateTime.formatIso(yield* DateTime.now);

    yield* sql`INSERT INTO admission_period_departments (department_id, name) VALUES ('claim-department', 'Trondheim')`;
    yield* sql`INSERT INTO admission_period_semesters (semester_id, start_at, end_at) VALUES ('claim-semester', '2031-08-01T00:00:00.000Z', '2032-01-01T00:00:00.000Z')`;
    yield* sql`
      INSERT INTO admission_periods (admission_period_id, department_id, semester_id, start_at, end_at, last_command_id)
      VALUES ('claim-period', 'claim-department', 'claim-semester', '2031-09-01T08:00:00.000Z', '2031-10-01T20:00:00.000Z', 'claim-period-created')
    `;
    yield* sql`INSERT INTO admission_period_fields_of_study (field_of_study_id, department_id, name) VALUES ('claim-field', 'claim-department', 'Matematikk')`;
    yield* sql`INSERT INTO person_profiles (person_id, first_name, last_name) VALUES ('claim-issuer', 'Cora', 'Coordinator'), ('member-1', 'Mona', 'Member')`;

    for (const applicant of ["a", "b"] as const) {
      yield* sql`
        INSERT INTO admission_applicants (applicant_id, normalized_email, email, first_name, last_name, phone, gender, field_of_study_id, year_of_study)
        VALUES (${`claim-applicant-${applicant}`}, ${`${applicant}@example.invalid`}, ${`${applicant}@example.invalid`}, 'Ada', 'Applicant', '12345678', 0, 'claim-field', 2)
      `;
      yield* sql`
        INSERT INTO admission_applications (application_id, applicant_id, admission_period_id, department_id, field_of_study_id, year_of_study, submitted_at)
        VALUES (${`claim-application-${applicant}`}, ${`claim-applicant-${applicant}`}, 'claim-period', 'claim-department', 'claim-field', 2, '2031-09-15T12:00:00.000Z')
      `;
      yield* sql.withTransaction(
        commandOnboarding({
          coordinator: administratorDepartmentReach(
            "claim-issuer",
            "admissions.outcomes",
            "claim-department",
          ),
          command: {
            applicationId: PublicApplicationIdSchema.make(`claim-application-${applicant}`),
            action: "Issue",
          },
          now: issuedAt,
          invitationId: `claim-invitation-${applicant}`,
          token: tokens[applicant],
          digest: createHash("sha256").update(tokens[applicant]).digest("hex"),
        }),
      );
    }
  }),
);

/** The session cookies name member-1 and the coordinator; nothing else authenticates. */
const sessionActor = (cookieHeader: string | undefined) => {
  const cookies = cookieHeader?.split(/;\s*/u) ?? [];

  const personId = cookies.includes(session)
    ? "member-1"
    : cookies.includes(issuerSession)
      ? "claim-issuer"
      : undefined;

  return personId === undefined
    ? Effect.fail(IdentitySessionNotFound.make({}))
    : Effect.succeed(
        IdentityActor.make({
          personId: PersonId.make(personId),
          sessionId: `${personId}-session`,
          expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
        }),
      );
};

const identity = Identity.of({
  signIn: () => Effect.die("unexpected sign-in"),
  resolveSession: sessionActor,
  readCurrentSession: () => Effect.die("unexpected session read"),
  listSessions: () => Effect.die("unexpected session list"),
  revokeCurrentSession: () => Effect.die("unexpected session mutation"),
  revokeSession: () => Effect.die("unexpected session mutation"),
  revokeOtherSessions: () => Effect.die("unexpected session mutation"),
  revokeAllSessions: () => Effect.die("unexpected session mutation"),
  recordSecurityEvent: () => Effect.die("unexpected identity audit"),
  signOut: () => Effect.succeed({ setCookies: [] }),
} satisfies IdentityOperations);

const fixture = () =>
  Effect.gen(function* () {
    const database = backendDatabase(seed);

    const backend = makeBackendTestRpc({
      config: backendTestConfig,
      services: Layer.mergeAll(
        Layer.mock(IdentitySnapshot, { resolveSession: sessionActor }),
        Layer.succeed(Identity, identity),
        Layer.mock(OAuthCredentialAuthority, {
          resolve: (request) => Effect.succeed(bearerOutcome(request)),
          resolveInTransaction: (request) => Effect.succeed(bearerOutcome(request)),
        }),
        Layer.mock(Organization, {
          resolvePersonAuthority: (personId, evaluatedAt) =>
            Effect.succeed({
              personId,
              evaluatedAt,
              globalAdministrator: "Absent",
              memberships:
                personId === "claim-issuer"
                  ? [
                      {
                        membershipId: MembershipId.make("claim-board-membership"),
                        teamId: TeamId.make("claim-board"),
                        departmentId,
                        active: true,
                        unitLeader: true,
                        unitKind: "DepartmentBoard" as const,
                        teamScope: "HomeDepartment" as const,
                        departmentIndependent: true,
                      },
                    ]
                  : [],
              nationalBoardSeats: [],
              delegations: [],
            }),
        }),
      ).pipe(Layer.provideMerge(database.layer)),
    });

    return { database, client: yield* backend.client };
  });

type Client = Effect.Success<ReturnType<typeof fixture>>["client"];

/** The problem code of a failed call; a transport failure has none. */
const codeOf = (failure: Problem | RpcClientError) =>
  isProblem(failure) ? failure.code : "defect";

/** One claim with the credential headers of a browser or a delegated client. */
const claimWith =
  (client: Client) =>
  (payload: typeof OnboardingClaim.Type, headers: Readonly<Record<string, string>> = {}) =>
    RpcClient.withHeaders(client["onboarding.claim"](payload), headers).pipe(
      Effect.match({
        onSuccess: (result) => result,
        onFailure: (failure) => ({ code: codeOf(failure) }),
      }),
    );

// Links, invitation states, and Persons are the facts a claim may change.
const claimFacts = (database: Effect.Success<ReturnType<typeof fixture>>["database"]) =>
  database.run(
    Database.use((sql) =>
      Effect.gen(function* () {
        const links = yield* sql<{
          readonly applicantId: string;
          readonly personId: string;
          readonly invitationId: string;
        }>`SELECT applicant_id AS "applicantId", person_id AS "personId", invitation_id AS "invitationId" FROM applicant_account_links ORDER BY applicant_id`;

        const invitations = yield* sql<{
          readonly invitationId: string;
          readonly state: string;
        }>`SELECT invitation_id AS "invitationId", state FROM applicant_account_invitations ORDER BY invitation_id`;

        const persons = yield* sql<{
          readonly count: number;
        }>`SELECT count(*)::integer AS count FROM person_profiles`;

        return { links, invitations, persons: persons[0]?.count };
      }),
    ),
  );

const unclaimed = {
  links: [],
  invitations: [
    { invitationId: "claim-invitation-a", state: "Open" },
    { invitationId: "claim-invitation-b", state: "Open" },
  ],
  persons: 2,
};

const claimed = { state: "Claimed", departmentId: "claim-department" };

describe("onboarding claim principal", () => {
  it.live("links the session's Person once, to the invitation its token binds", () =>
    Effect.gen(function* () {
      const { database, client } = yield* fixture();
      const claim = claimWith(client);
      const existing = { mode: "ExistingAccount", token: tokens.a } as const;

      expect(yield* claim(existing, { cookie: session })).toEqual(claimed);
      expect(yield* claim(existing, { cookie: session })).toEqual({
        code: "onboarding.claim-invalid",
      });
      expect(yield* claimFacts(database)).toEqual({
        links: [
          {
            applicantId: "claim-applicant-a",
            personId: "member-1",
            invitationId: "claim-invitation-a",
          },
        ],
        invitations: [
          { invitationId: "claim-invitation-a", state: "Claimed" },
          { invitationId: "claim-invitation-b", state: "Open" },
        ],
        persons: 2,
      });
    }),
  );

  it.live("requires the session before it reads an existing-account token", () =>
    Effect.gen(function* () {
      const { database, client } = yield* fixture();
      const claim = claimWith(client);

      // Without its one principal, the claim answers a valid and an unknown token alike.
      for (const token of [tokens.a, tokens.unknown]) {
        expect(yield* claim({ mode: "ExistingAccount", token })).toEqual({
          code: "credential.missing",
        });
      }

      expect(yield* claimFacts(database)).toEqual(unclaimed);
    }),
  );

  it.live("lets only the browser session make an existing-account claim", () =>
    Effect.gen(function* () {
      const { database, client } = yield* fixture();
      const claim = claimWith(client);
      const existing = { mode: "ExistingAccount", token: tokens.a } as const;

      // The bearer names the session's own Person, yet a delegated bearer cannot claim.
      for (const token of [tokens.a, tokens.unknown]) {
        expect(yield* claim({ mode: "ExistingAccount", token }, { authorization: bearer })).toEqual(
          { code: "credential.invalid" },
        );
      }

      expect(yield* claimFacts(database)).toEqual(unclaimed);
      expect(yield* claim(existing, { cookie: session })).toEqual(claimed);
      expect(yield* claim(existing, { cookie: session })).toEqual({
        code: "onboarding.claim-invalid",
      });
    }),
  );

  it.live("rejects a new-account token presented beside a session or a bearer", () =>
    Effect.gen(function* () {
      const { database, client } = yield* fixture();
      const claim = claimWith(client);

      const created = {
        mode: "NewAccount",
        token: tokens.b,
        password: "correct horse battery",
      } as const;

      for (const [header, credential] of [
        ["cookie", session],
        ["authorization", bearer],
      ] as const) {
        expect(yield* claim(created, { [header]: credential })).toEqual({
          code: "credential.invalid",
        });
      }

      expect(yield* claimFacts(database)).toEqual(unclaimed);
      expect(yield* claim(created)).toEqual(claimed);
    }),
  );
});

describe("onboarding board over RPC and PostgreSQL", () => {
  it.live("lets the department coordinator revoke with the board's tag, and replays it", () =>
    Effect.gen(function* () {
      const { database, client } = yield* fixture();

      const asIssuer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        RpcClient.withHeaders(effect, { cookie: issuerSession });

      const board = yield* asIssuer(client["onboarding.readBoard"]({ departmentId }));

      expect(board.items.map((item) => [item.applicationId, item.state])).toEqual([
        ["claim-application-a", "Open"],
        ["claim-application-b", "Open"],
      ]);

      const revoke = asIssuer(
        client["onboarding.command"]({
          departmentId,
          idempotencyKey: IdempotencyKey.make("onboarding-revoke".padEnd(22, "0")),
          ifMatch: board.etag,
          request: {
            applicationId: PublicApplicationIdSchema.make("claim-application-a"),
            action: "Revoke",
          },
        }),
      );

      const revoked = yield* revoke;

      expect(revoked.etag).not.toBe(board.etag);
      expect(
        revoked.items.find((item) => item.applicationId === "claim-application-a")?.state,
      ).toBe("Revoked");

      // A retry with the same key replays the first answer.
      expect(yield* revoke).toEqual(revoked);

      // The board changed, so its first tag no longer names it.
      const stale = yield* asIssuer(
        client["onboarding.command"]({
          departmentId,
          idempotencyKey: IdempotencyKey.make("onboarding-stale".padEnd(22, "0")),
          ifMatch: board.etag,
          request: {
            applicationId: PublicApplicationIdSchema.make("claim-application-b"),
            action: "Revoke",
          },
        }),
      ).pipe(Effect.flip);

      expect(codeOf(stale)).toBe("precondition.failed");

      // A member without `admissions.outcomes` in the department neither reads nor commands.
      const read = yield* RpcClient.withHeaders(client["onboarding.readBoard"]({ departmentId }), {
        cookie: session,
      }).pipe(Effect.flip);

      expect(codeOf(read)).toBe("authority.denied");
      expect(
        (yield* claimFacts(database)).invitations.map((invitation) => invitation.state),
      ).toEqual(["Revoked", "Open"]);
    }),
  );
});

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
import { IdentityActor, IdentitySessionNotFound } from "@vektorprogrammet/domain/identity";
import { OnboardingClaim, OnboardingClaimResult } from "@vektorprogrammet/domain/onboarding";
import { DepartmentId, Organization, PersonId } from "@vektorprogrammet/domain/organization";
import { NativeProblem } from "@vektorprogrammet/http-api";
import { DateTime, Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { backendDatabase } from "../../test/database.js";
import { decodeBackendConfig } from "../config.js";
import { makeBackendTestHttp } from "../test/native-http.js";

const environment = {
  BACKEND_PG_URL: "postgres://test.invalid/vektorprogrammet",
  BETTER_AUTH_SECRET: "onboarding-claim-test-secret-with-32-characters",
  NATIVE_IDENTITY_DEPLOYMENT: "local",
  NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify(["http://127.0.0.1:5174"]),
  OAUTH_CANONICAL_ORIGIN: "http://127.0.0.1:5174",
  OAUTH_DASHBOARD_ORIGIN: "http://127.0.0.1:5174",
  OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
  PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
  PASSWORD_RESET_DELIVERY_MODE: "disabled",
  RECEIPT_DELIVERY_MODE: "disabled",
} as const;

const session = "better-auth.session_token=member-1-session";

// A delegated OAuth bearer of the same Person as the session.
const bearer = "Bearer member-1-bearer";

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

// The claim compares expiry with the database clock, so invitations are issued now.
const issuedAt = new Date().toISOString();

const seed = Database.use((sql) =>
  Effect.gen(function* () {
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
          departmentId: DepartmentId.make("claim-department"),
          command: {
            applicationId: PublicApplicationIdSchema.make(`claim-application-${applicant}`),
            action: "Issue",
          },
          actor: PersonId.make("claim-issuer"),
          now: issuedAt,
          invitationId: `claim-invitation-${applicant}`,
          token: tokens[applicant],
          digest: createHash("sha256").update(tokens[applicant]).digest("hex"),
        }),
      );
    }
  }),
);

const database = backendDatabase(seed);

const http = makeBackendTestHttp(
  decodeBackendConfig(environment),
  Layer.mergeAll(
    database.layer,
    // The session cookie and the bearer both name member-1; nothing else authenticates.
    Layer.mock(IdentitySnapshot, {
      resolveSession: (cookieHeader) =>
        cookieHeader?.split(/;\s*/u).includes(session) === true
          ? Effect.succeed(
              new IdentityActor({
                personId: PersonId.make("member-1"),
                sessionId: "member-1-session",
                expiresAt: DateTime.makeUnsafe(new Date("2099-01-01T00:00:00.000Z")),
              }),
            )
          : Effect.fail(new IdentitySessionNotFound()),
    }),
    Layer.mock(OAuthCredentialAuthority, {
      resolve: async (request) => bearerOutcome(request),
      resolveInTransaction: (request) => Effect.succeed(bearerOutcome(request)),
    }),
    Layer.mock(Organization, {
      resolvePersonAuthority: (personId, evaluatedAt) =>
        Effect.succeed({ personId, evaluatedAt, globalAdministrator: "Absent", memberships: [] }),
    }),
  ),
  {
    handle: async () => new Response(null, { status: 404 }),
    recordTrustedOriginRejection: async () => undefined,
  },
);

const claim = async (
  body: typeof OnboardingClaim.Encoded,
  headers: Record<string, string> = {},
) => {
  const response = await http.fetch(
    new Request("http://backend.test/api/onboarding/claim", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:5174",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );

  const json: unknown = await response.json();

  if (response.ok)
    return { status: response.status, ...Schema.decodeUnknownSync(OnboardingClaimResult)(json) };

  const code = Schema.decodeUnknownSync(NativeProblem)(json).code;

  // A credential problem also names the credential the claim accepts.
  return response.status === 401
    ? { status: response.status, code, challenge: response.headers.get("www-authenticate") }
    : { status: response.status, code };
};

// Links, invitation states, and Persons are the facts a claim may change.
const claimFacts = () =>
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

describe("onboarding claim principal", () => {
  it("links the session's Person once, to the invitation its token binds", async () => {
    const existing = { mode: "ExistingAccount", token: tokens.a } as const;

    expect(await claim(existing, { cookie: session })).toEqual({
      status: 200,
      state: "Claimed",
      departmentId: "claim-department",
    });
    expect(await claim(existing, { cookie: session })).toEqual({
      status: 400,
      code: "onboarding.claim-invalid",
    });
    expect(await claimFacts()).toEqual({
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
  });

  it("requires the session before it reads an existing-account token", async () => {
    // Without its one principal, the claim answers a valid and an unknown token alike.
    for (const token of [tokens.a, tokens.unknown]) {
      expect(await claim({ mode: "ExistingAccount", token })).toEqual({
        status: 401,
        code: "credential.missing",
        challenge: 'VektorSession realm="native-api"',
      });
    }

    expect(await claimFacts()).toEqual(unclaimed);
  });

  it("lets only the browser session make an existing-account claim", async () => {
    const existing = { mode: "ExistingAccount", token: tokens.a } as const;

    // The bearer names the session's own Person, yet a delegated bearer cannot claim.
    for (const token of [tokens.a, tokens.unknown]) {
      expect(await claim({ mode: "ExistingAccount", token }, { authorization: bearer })).toEqual({
        status: 401,
        code: "credential.invalid",
        challenge: 'VektorSession realm="native-api"',
      });
    }

    expect(await claimFacts()).toEqual(unclaimed);
    expect(await claim(existing, { cookie: session })).toEqual({
      status: 200,
      state: "Claimed",
      departmentId: "claim-department",
    });
    expect(await claim(existing, { cookie: session })).toEqual({
      status: 400,
      code: "onboarding.claim-invalid",
    });
  });

  it("rejects a new-account token presented beside a session or a bearer", async () => {
    const created = {
      mode: "NewAccount",
      token: tokens.b,
      password: "correct horse battery",
    } as const;

    for (const [header, credential] of [
      ["cookie", session],
      ["authorization", bearer],
    ] as const) {
      expect(await claim(created, { [header]: credential })).toEqual({
        status: 401,
        code: "credential.invalid",
        challenge: 'VektorSession realm="native-api"',
      });
    }

    expect(await claimFacts()).toEqual(unclaimed);
    expect(await claim(created)).toEqual({
      status: 200,
      state: "Claimed",
      departmentId: "claim-department",
    });
  });
});

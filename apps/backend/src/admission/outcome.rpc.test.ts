import { Database, IdentitySnapshot } from "@vektorprogrammet/database";
import { AdmissionsLive } from "@vektorprogrammet/database/admissions";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import { DepartmentId, PersonId, SemesterId } from "@vektorprogrammet/domain/organization";
import { IdempotencyKey, isProblem, type Problem } from "@vektorprogrammet/rpc/problem";
import { DateTime, Effect, Layer, Predicate } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { describe, expect, it } from "@effect/vitest";
import { backendDatabase } from "../../test/database.js";
import { backendTestConfig } from "../../test/config.js";
import { makeBackendTestRpc } from "../test/native-rpc.js";

const departmentA = DepartmentId.make("outcome-department-a");

const departmentB = DepartmentId.make("outcome-department-b");

const semesterId = SemesterId.make("outcome-semester");

const leaderA = "outcome-leader-a";

const memberA = "outcome-member-a";

const applicationA = PublicApplicationIdSchema.make("outcome-application-a");

const applicationB = PublicApplicationIdSchema.make("outcome-application-b");

/**
 * Two independent departments with one application each. The leader of department A's board
 * decides its outcomes; a member of another team of A only reads who is on call.
 */
const seed = Database.use((sql) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO admission_period_semesters (semester_id, start_at, end_at) VALUES (${semesterId}, '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z')`;

    for (const [departmentId, suffix] of [
      [departmentA, "a"],
      [departmentB, "b"],
    ] as const) {
      yield* sql`INSERT INTO admission_period_departments (department_id, name) VALUES (${departmentId}, ${`Outcomes ${suffix}`})`;
      yield* sql`INSERT INTO organization_departments (department_id, name, short_name, email, city, independent) VALUES (${departmentId}, ${`Outcomes ${suffix}`}, ${`O${suffix}`}, ${`outcomes-${suffix}@example.invalid`}, 'Trondheim', TRUE)`;
      yield* sql`INSERT INTO admission_periods (admission_period_id, department_id, semester_id, start_at, end_at, last_command_id) VALUES (${`outcome-period-${suffix}`}, ${departmentId}, ${semesterId}, '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'seed')`;
      yield* sql`INSERT INTO admission_period_fields_of_study (field_of_study_id, department_id, name) VALUES (${`outcome-field-${suffix}`}, ${departmentId}, 'Matematikk')`;
      yield* sql`INSERT INTO admission_applicants (applicant_id, normalized_email, email, first_name, last_name, phone, gender, field_of_study_id, year_of_study) VALUES (${`outcome-applicant-${suffix}`}, ${`candidate-${suffix}@example.invalid`}, ${`candidate-${suffix}@example.invalid`}, 'Ada', 'Candidate', '12345678', 0, ${`outcome-field-${suffix}`}, 2)`;
      yield* sql`INSERT INTO admission_applications (application_id, applicant_id, admission_period_id, department_id, field_of_study_id, year_of_study, submitted_at) VALUES (${`outcome-application-${suffix}`}, ${`outcome-applicant-${suffix}`}, ${`outcome-period-${suffix}`}, ${departmentId}, ${`outcome-field-${suffix}`}, 2, '2026-02-01T00:00:00.000Z')`;
    }

    yield* sql`INSERT INTO organization_teams (team_id, department_id, name, kind) VALUES ('outcome-board-a', ${departmentA}, 'Styret', 'DepartmentBoard')`;
    yield* sql`INSERT INTO organization_teams (team_id, department_id, name) VALUES ('outcome-team-a', ${departmentA}, 'Skolekoordinering')`;
    yield* sql`INSERT INTO person_profiles (person_id, first_name, last_name) VALUES (${leaderA}, 'Lise', 'Leader'), (${memberA}, 'Mia', 'Member')`;
    yield* sql`
      INSERT INTO organization_memberships (membership_id, person_id, team_id, start_at, position_id, is_team_leader)
      VALUES
        ('outcome-leader-membership', ${leaderA}, 'outcome-board-a', '2020-01-01T00:00:00.000Z', 'leader', TRUE),
        ('outcome-member-membership', ${memberA}, 'outcome-team-a', '2020-01-01T00:00:00.000Z', NULL, FALSE)
    `;
  }),
);

/** Every session cookie names its person. */
const sessionActor = (cookie: string | undefined) => {
  const person = /better-auth\.session_token=([^;]+)/u.exec(cookie ?? "")?.[1];

  return person === undefined
    ? undefined
    : new IdentityActor({
        personId: PersonId.make(person),
        sessionId: `session-${person}`,
        expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
      });
};

const identitySnapshot = IdentitySnapshot.of({
  resolveSession: (cookie) => {
    const actor = sessionActor(cookie);

    return actor === undefined ? Effect.fail(new IdentitySessionNotFound()) : Effect.succeed(actor);
  },
  revokeCurrentSession: () => Effect.die("unexpected session mutation"),
  revokeSession: () => Effect.die("unexpected session mutation"),
  revokeOtherSessions: () => Effect.die("unexpected session mutation"),
  revokeAllSessions: () => Effect.die("unexpected session mutation"),
});

const identity = Identity.of({
  signIn: () => Effect.die("unexpected sign-in"),
  resolveSession: (cookie: string | undefined) => {
    const actor = sessionActor(cookie);

    return actor === undefined ? Effect.fail(new IdentitySessionNotFound()) : Effect.succeed(actor);
  },
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

    const backend = makeBackendTestRpc(
      backendTestConfig,
      Layer.mergeAll(
        AdmissionsLive,
        OrganizationLive,
        Layer.succeed(IdentitySnapshot, identitySnapshot),
        Layer.succeed(Identity, identity),
      ).pipe(Layer.provideMerge(database.layer)),
    );

    const client = yield* backend.client;

    /** Runs one call as `personId`, with that person's session cookie. */
    const as = <A, E, R>(effect: Effect.Effect<A, E, R>, personId: string) =>
      RpcClient.withHeaders(effect, { cookie: `better-auth.session_token=${personId}` });

    const history = (applicationId: string) =>
      database.run(
        Database.use(
          (sql) =>
            sql<{ readonly revision: number; readonly outcome: string }>`
              SELECT revision, outcome FROM admission_application_outcomes
              WHERE application_id = ${applicationId} ORDER BY revision
            `,
        ),
      );

    return { client, as, history };
  });

const key = (value: string) => IdempotencyKey.make(value.padEnd(22, "0"));

/** The problem code of a failed call; a transport failure has none. */
const codeOf = (failure: Problem | RpcClientError) => (isProblem(failure) ? failure.code : "defect");

describe("admission outcomes over RPC and PostgreSQL", () => {
  it.live("lets the board leader decide, replay, and conflict on a stale version", () =>
    Effect.gen(function* () {
      const { client, as, history } = yield* fixture();

      const scopes = yield* as(client["admissionOutcomes.listScopes"](), leaderA);
      expect(scopes.departments.map((department) => department.departmentId)).toEqual([departmentA]);

      const board = yield* as(
        client["admissionOutcomes.readOutcomes"]({ departmentId: departmentA, semesterId }),
        leaderA,
      );

      if (!Predicate.isTagged(board, "Decide")) throw new Error("The leader decides the board");
      expect(board.entries.map((entry) => entry.applicationId)).toEqual([applicationA]);

      const entry = yield* as(
        client["admissionOutcomes.readOutcome"]({ applicationId: applicationA }),
        leaderA,
      );

      expect(entry.etag).toBe(board.entries[0]?.etag);

      const record = as(
        client["admissionOutcomes.recordOutcome"]({
          applicationId: applicationA,
          idempotencyKey: key("outcomeSubstitute"),
          ifMatch: entry.etag,
          request: { outcome: "Substitute" },
        }),
        leaderA,
      );

      const recorded = yield* record;
      expect(recorded).toMatchObject({ outcome: "Substitute", revision: 1 });
      expect(recorded.etag).not.toBe(entry.etag);
      expect(yield* record).toEqual(recorded);

      const stale = yield* as(
        client["admissionOutcomes.recordOutcome"]({
          applicationId: applicationA,
          idempotencyKey: key("outcomeStale"),
          ifMatch: entry.etag,
          request: { outcome: "Rejected" },
        }),
        leaderA,
      ).pipe(Effect.flip);

      expect(codeOf(stale)).toBe("precondition.failed");
      expect(yield* history(applicationA)).toEqual([{ revision: 1, outcome: "Substitute" }]);
    }),
  );

  it.live("refuses a record on another department's application with authority.denied", () =>
    Effect.gen(function* () {
      const { client, as, history } = yield* fixture();

      // The leader reaches department A only, so the evidence for B's application is refused
      // before any read of its version or any write.
      const denied = yield* as(
        client["admissionOutcomes.recordOutcome"]({
          applicationId: applicationB,
          idempotencyKey: key("outcomeForeign"),
          ifMatch: (yield* as(
            client["admissionOutcomes.readOutcome"]({ applicationId: applicationA }),
            leaderA,
          )).etag,
          request: { outcome: "Admitted" },
        }),
        leaderA,
      ).pipe(Effect.flip);

      expect(codeOf(denied)).toBe("authority.denied");
      expect(yield* history(applicationB)).toEqual([]);
    }),
  );

  it.live("shows a member only who is on call and denies the member's reads and records", () =>
    Effect.gen(function* () {
      const { client, as } = yield* fixture();

      const board = yield* as(
        client["admissionOutcomes.readOutcomes"]({ departmentId: departmentA, semesterId }),
        memberA,
      );

      if (!Predicate.isTagged(board, "ReadOnly")) throw new Error("A member only reads the board");
      expect(board.substitutes).toEqual([]);

      const read = yield* as(
        client["admissionOutcomes.readOutcome"]({ applicationId: applicationA }),
        memberA,
      ).pipe(Effect.flip);

      expect(codeOf(read)).toBe("authority.denied");

      const anonymous = yield* client["admissionOutcomes.listScopes"]().pipe(Effect.flip);

      expect(codeOf(anonymous)).toBe("credential.missing");
    }),
  );
});

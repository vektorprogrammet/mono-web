/** EX-0021: Stable SQL modules carry an upstream unstable annotation.
 * @effect-diagnostics unstableApiUsage:off
 */
import { Redacted } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, it } from "@effect/vitest";
import { startDisposablePostgres } from "@monoweb/postgres";
import { Effect, FileSystem, Path, Schema } from "effect";
import { selectDatabaseMigration } from "../migrations.js";
import { executePostgresMigration } from "../postgres-migration-statements.js";
import { postgresTestClient, withPostgresTestDatabase } from "../test-support/postgres.js";
import { TestPlatform } from "../test-support/platform.js";

const baseline = selectDatabaseMigration("82_admission-outcome-mail");

const preceding = [...baseline.preceding, baseline.migration];

const migration = new URL(
  "../../migrations/0083-application-decision-correction-fence.sql",
  import.meta.url,
);

const readMigration = Effect.fnUntraced(function* (url: URL) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return yield* fs.readFileString(yield* path.fromFileUrl(url));
});

// Seed through the previous schema: a historical decision contradicts today's Ja.
// The upgrade must preserve the historical outcome, never cite that live assessment.
const seed = `
INSERT INTO admission_period_departments(department_id,name) VALUES('evidence-department','Evidence');
INSERT INTO organization_departments(department_id,name,short_name,email,city) VALUES('evidence-department','Evidence','EVD','evidence@example.invalid','Bergen');
INSERT INTO admission_period_semesters(semester_id,start_at,end_at) VALUES('evidence-semester','2031-01-01','2032-01-01');
INSERT INTO admission_periods(admission_period_id,department_id,semester_id,start_at,end_at,last_command_id) VALUES('evidence-period','evidence-department','evidence-semester','2031-01-01','2032-01-01','seed');
INSERT INTO admission_period_fields_of_study(field_of_study_id,department_id,name) VALUES('evidence-field','evidence-department','Math');
INSERT INTO person_profiles(person_id,first_name,last_name) VALUES('evidence-staff','Synthetic','Staff');
INSERT INTO admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study) VALUES('evidence-applicant','evidence-applicant@example.invalid','evidence-applicant@example.invalid','Synthetic','Applicant','90000000',0,'evidence-field',2);
INSERT INTO admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at) VALUES('evidence-application','evidence-applicant','evidence-period','evidence-department','evidence-field',2,'2031-02-01');
INSERT INTO recruitment_interview_schemas(interview_schema_id,name,question_count) VALUES('evidence-schema','Evidence',0);
INSERT INTO recruitment_interviews(interview_id,application_id,department_id,interviewer_person_id,interview_schema_id,assigned_by_person_id,assigned_at,revision) VALUES('evidence-interview','evidence-application','evidence-department','evidence-staff','evidence-schema','evidence-staff','2031-02-01',1);
INSERT INTO recruitment_interview_conducts(interview_id,answers,explanatory_power,role_model,suitability,finalized_by_person_id,finalized_at,interview_revision,recommendation) VALUES('evidence-interview','[]',1,2,3,'evidence-staff','2031-02-02',1,'Ja');
INSERT INTO admission_application_outcomes(application_id,revision,outcome,decided_by_person_id,decided_at,provenance) VALUES('evidence-application',1,'Rejected','evidence-staff','2031-02-03','Decision');
INSERT INTO admission_outcome_announcements(application_id,outcome,outcome_revision,announced_by_person_id,announced_at) VALUES('evidence-application','Rejected',1,'evidence-staff','2031-02-04');
CREATE FUNCTION public.evidence_upgrade_attempt(statement text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE statement; RAISE EXCEPTION 'undo' USING ERRCODE='RB001';
  EXCEPTION WHEN SQLSTATE 'RB001' THEN RETURN 'accepted'; END;
EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE; END $$;
`;

const original = `SELECT jsonb_build_object('application',to_jsonb(a),'outcomes',(SELECT jsonb_agg(to_jsonb(o) ORDER BY revision) FROM admission_application_outcomes o WHERE o.application_id=a.application_id),'announcement',(SELECT to_jsonb(n) FROM admission_outcome_announcements n WHERE n.application_id=a.application_id),'conduct',(SELECT to_jsonb(c) FROM recruitment_interview_conducts c WHERE c.interview_id='evidence-interview'))::text AS bytes FROM admission_applications a WHERE application_id='evidence-application'`;

const upgraded = original.replace("to_jsonb(a)", "to_jsonb(a)-'decision_fence_version'");

const Row = Schema.Struct({ bytes: Schema.String });

const Citation = Schema.Struct({
  basis: Schema.String,
  outcome: Schema.String,
  citation: Schema.String,
  revision: Schema.NullOr(Schema.Int),
  completed: Schema.Boolean,
  closed: Schema.Boolean,
});

const proof = Effect.fnUntraced(function* (pool: SqlClient.SqlClient) {
  yield* pool.withTransaction(
    executePostgresMigration(seed).pipe(Effect.provideService(SqlClient.SqlClient, pool)),
  );

  const before = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(yield* pool.unsafe(original));

  yield* pool.withTransaction(
    executePostgresMigration(yield* readMigration(migration)).pipe(
      Effect.provideService(SqlClient.SqlClient, pool),
    ),
  );

  const after = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(yield* pool.unsafe(upgraded));

  expect(after).toEqual(before);

  const citation = yield* Schema.decodeUnknownEffect(Schema.Array(Citation))(
    yield* pool.unsafe(
      `SELECT basis,outcome,citation_state AS citation,assessment_revision AS revision,interview_completed AS completed,decision_closed AS closed FROM application_admission_evidence WHERE application_id='evidence-application'`,
    ),
  );

  expect(citation).toEqual([
    {
      basis: "Unreviewed",
      outcome: "Rejected",
      citation: "Unavailable",
      revision: null,
      completed: false,
      closed: true,
    },
  ]);

  const frozen = yield* pool.unsafe(
    `SELECT to_jsonb(e)::text AS bytes FROM application_admission_decision_evidence e`,
  );

  yield* pool.unsafe(`SELECT public.fence_application_decision('evidence-application')`);
  expect(
    yield* pool.unsafe(
      `SELECT to_jsonb(e)::text AS bytes FROM application_admission_decision_evidence e`,
    ),
  ).toEqual(frozen);

  for (const statement of [
    `UPDATE application_admission_decision_evidence SET outcome='Admitted' WHERE application_id='evidence-application'`,
    `INSERT INTO admission_application_outcomes(application_id,revision,outcome,decided_by_person_id,decided_at) VALUES('evidence-application',2,'Admitted','evidence-staff','2031-02-05')`,
    `DELETE FROM admission_outcome_announcements WHERE application_id='evidence-application'`,
  ]) {
    const refusal = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ result: Schema.String })),
    )(yield* pool.unsafe(`SELECT public.evidence_upgrade_attempt($1) AS result`, [statement]));

    expect(refusal[0]?.result).not.toBe("accepted");
  }

  expect(
    yield* pool.unsafe(`SELECT count(*)::integer AS total FROM admission_outcome_outbox`),
  ).toEqual([{ total: 0 }]);
});

describe("R2 migration83 historical citation", () => {
  it.live(
    "PGlite preserves exact prior rows and marks uncited outcomes unavailable",
    () => withPostgresTestDatabase(proof, preceding).pipe(Effect.provide(TestPlatform)),
    { timeout: 180_000 },
  );
  it.live(
    "selected PostgreSQL major preserves the same history without inventing current provenance",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const postgres = yield* Effect.acquireRelease(
            Effect.promise(() => startDisposablePostgres({ listen: "socket", maxConnections: 4 })),
            (p) => Effect.promise(() => p.stop()),
          );

          const pool = yield* postgresTestClient({
            url: Redacted.make(postgres.url),
            maxConnections: 2,
          });

          for (const step of preceding)
            yield* pool.withTransaction(
              executePostgresMigration(yield* readMigration(step.url)).pipe(
                Effect.provideService(SqlClient.SqlClient, pool),
              ),
            );
          yield* proof(pool);
        }),
      ).pipe(Effect.provide(TestPlatform)),
    { timeout: 180_000 },
  );
});

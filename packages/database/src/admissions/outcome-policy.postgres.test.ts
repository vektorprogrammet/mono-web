import { expect, layer } from "@effect/vitest";
import {
  type DisposablePostgres,
  selectedPostgresMajor,
  startDisposablePostgres,
} from "@monoweb/postgres";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Path,
  Redacted,
  Schema,
} from "effect";
import { Pool, type QueryResultRow } from "pg";
import {
  Admissions,
  AdmissionOutcome,
  AdmissionOutcomeCommand,
} from "@vektorprogrammet/domain/admissions";
import {
  type PublicApplicationId,
  PublicApplicationIdSchema,
} from "@vektorprogrammet/domain/application";
import { DepartmentId, PersonId, SemesterId } from "@vektorprogrammet/domain/organization";
import { Placements } from "@vektorprogrammet/domain/placements";
import { SchoolId } from "@vektorprogrammet/domain/schools";
import { DatabaseLive } from "../layers.js";
import {
  type DatabaseMigrationDefinition,
  databaseMigrationDefinitions,
  selectDatabaseMigration,
} from "../migrations.js";
import { pgQuery } from "../pg-pool.js";
import { Database, type DatabaseOperations } from "../service.js";
import { TestPlatform } from "../test-support/platform.js";
import { withPostgresTestDatabase } from "../test-support/postgres.js";
import { PlacementsLive } from "../placements/index.js";
import { AdmissionsLive } from "./index.js";

/**
 * Red-first proof of spec 0027 (docs/specs/0027-admission-outcome-policy.md in the effx design
 * repository, falsifiers 1 and 2) on real PostgreSQL, against the handwritten Admissions and
 * Placements services of the accepted source `8152c389`. Every case states an observable law of
 * the approved policy and fails on that source because the source behaves otherwise:
 *
 * - `AdmissionOutcome` is `Admitted | Rejected`; `Substitute` is not an outcome, not a command
 *   value and not an insertable revision, also through direct SQL.
 * - An interview `Ja` is Admitted and `Nei` Rejected without a manual override; `Kanskje` and a
 *   returning assistant without an interview take an explicit Admitted or Rejected decision, and
 *   an unplaced Admitted person is never denied.
 * - `Rejected` cannot be committed for a person with an active placement in the same department
 *   and semester, and a placement cannot be created for a Rejected person. A Rejected write and a
 *   placement create contend on one scope lock, in both orders, on separate connections.
 * - An Admitted assistant without a placement is an eligible coverer, once.
 * - One migration after the accepted `80_days-served-and-certificates` appends exactly one
 *   Admitted, provenance-marked revision with no human decider for each application whose current
 *   outcome is `Substitute`, and rewrites no earlier revision.
 *
 * The suite starts a private cluster of the PostgreSQL major that `VEKTOR_POSTGRES_MAJOR` selects
 * (the highest supported one by default; `VEKTOR_POSTGRES_MAJOR=17` selects 17). The upgrade proof
 * also runs on PGlite. The cases use only the current service operations and SQL; they import no
 * operation of the target design.
 */

class OutcomePolicyCluster extends Context.Service<OutcomePolicyCluster, DisposablePostgres>()(
  "admissions/outcome-policy.postgres.test/OutcomePolicyCluster",
) {}

const cluster = Layer.effect(
  OutcomePolicyCluster,
  Effect.acquireRelease(
    Effect.promise(() => startDisposablePostgres({ listen: "socket", maxConnections: 24 })),
    (postgres) => Effect.promise(() => postgres.stop()),
  ),
);

const database = Layer.unwrap(
  Effect.map(OutcomePolicyCluster, (postgres) =>
    DatabaseLive({
      url: Redacted.make(postgres.url),
      applicationName: "outcome-policy-postgres-test",
      maxConnections: 6,
    }).pipe(Layer.provide(TestPlatform)),
  ),
);

const scope = {
  departmentId: DepartmentId.make("policy-department"),
  semesterId: SemesterId.make("policy-semester"),
};

const otherDepartment = DepartmentId.make("policy-other-department");

const previousSemester = SemesterId.make("policy-previous-semester");

const periodId = "policy-period";

const recruiter = PersonId.make("policy-recruiter");

const interviewer = PersonId.make("policy-interviewer");

const coordinator = PersonId.make("policy-coordinator");

const now = "2026-06-01T10:00:00.000Z";

/** The 64 lowercase hexadecimal digits that placement, command, and capability ids require. */
const hex = (value: number) => value.toString(16).padStart(64, "0");

interface ApplicantSeed {
  readonly key: string;
  /** The interviewer's recommendation of a finalized interview; absent without an interview. */
  readonly recommendation?: "Ja" | "Kanskje" | "Nei";
  /** `current`: active in the scope. `elsewhere`: active only in another department and in another semester, and removed in the scope. */
  readonly placement?: "current" | "elsewhere";
  /** A returning assistant registered without an interview, with a historical placement. */
  readonly returning?: true;
  /** A recorded outcome, as the committed history of the application. */
  readonly outcome?: "Admitted" | "Rejected";
}

const applicantSeeds: ReadonlyArray<ApplicantSeed> = [
  { key: "ja-unplaced", recommendation: "Ja" },
  { key: "ja-placed", recommendation: "Ja", placement: "current" },
  { key: "nei-unplaced", recommendation: "Nei" },
  { key: "nei-placed", recommendation: "Nei", placement: "current" },
  { key: "kanskje-unplaced", recommendation: "Kanskje" },
  { key: "kanskje-placed", recommendation: "Kanskje", placement: "current" },
  { key: "kanskje-elsewhere", recommendation: "Kanskje", placement: "elsewhere" },
  { key: "placed-reject", recommendation: "Kanskje", placement: "current" },
  { key: "returning", returning: true },
  { key: "race-reject-first", recommendation: "Kanskje" },
  { key: "race-place-first", recommendation: "Kanskje" },
  { key: "direct-sql", recommendation: "Kanskje" },
  { key: "cover-unplaced", recommendation: "Kanskje", outcome: "Admitted" },
  { key: "cover-placed", recommendation: "Ja", placement: "current", outcome: "Admitted" },
  { key: "cover-rejected", recommendation: "Nei", outcome: "Rejected" },
  { key: "cover-undecided", recommendation: "Kanskje" },
];

/** A placed assistant who never applied this semester. */
const coverAssistant = "cover-assistant";

const personKeys = [...applicantSeeds.map(({ key }) => key), coverAssistant];

const applicationOf = (key: string) => PublicApplicationIdSchema.make(`policy-application-${key}`);

const personOf = (key: string) => PersonId.make(`policy-person-${key}`);

/** Slot 0: the scope. 1: another department. 2: the scope, removed. 3: the previous semester. */
const placementIdOf = (key: string, slot: number) =>
  `placement-${hex(100 + personKeys.indexOf(key) * 4 + slot)}`;

const insertPlacement = (
  sql: DatabaseOperations,
  placement: {
    readonly id: string;
    readonly person: PersonId;
    readonly department: DepartmentId;
    readonly semester: SemesterId;
    readonly school: SchoolId;
    readonly active: boolean;
    readonly revision: number;
  },
) =>
  sql`INSERT INTO assistant_placements (
    placement_id, person_id, department_id, semester_id, school_id, day, workdays, block, active,
    revision
  ) VALUES (
    ${placement.id}, ${placement.person}, ${placement.department}, ${placement.semester},
    ${placement.school}, 'Monday', 4, '1', ${placement.active}, ${placement.revision}
  )`;

const suiteSeed = Layer.effectDiscard(
  Database.use((sql) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO admission_period_departments (department_id, name)
        VALUES (${scope.departmentId}, 'Policy')`;
      yield* sql`INSERT INTO organization_departments (department_id, name, short_name, email, city)
        VALUES
          (${scope.departmentId}, 'Policy', 'POL', 'policy@example.invalid', 'Trondheim'),
          (${otherDepartment}, 'Elsewhere', 'ELS', 'elsewhere@example.invalid', 'Bergen')`;
      yield* sql`INSERT INTO admission_period_semesters (semester_id, start_at, end_at) VALUES
        (${scope.semesterId}, '2026-01-01', '2027-01-01'),
        (${previousSemester}, '2025-01-01', '2025-12-31')`;
      yield* sql`INSERT INTO admission_periods (
        admission_period_id, department_id, semester_id, start_at, end_at, last_command_id
      ) VALUES (
        ${periodId}, ${scope.departmentId}, ${scope.semesterId}, '2026-01-01', '2027-01-01', 'seed'
      )`;
      yield* sql`INSERT INTO admission_period_fields_of_study (field_of_study_id, department_id, name)
        VALUES ('policy-field', ${scope.departmentId}, 'Math')`;
      yield* sql`INSERT INTO person_profiles (person_id, first_name, last_name) VALUES
        (${recruiter}, 'Rita', 'Recruiter'),
        (${interviewer}, 'Ivar', 'Intervjuer'),
        (${coordinator}, 'Cora', 'Coordinator')`;
      yield* sql`INSERT INTO recruitment_interview_schemas (
        interview_schema_id, name, question_count, active, revision
      ) VALUES ('policy-schema', 'Policy', 0, true, 0)`;

      const schools = yield* sql<{
        readonly schoolId: number;
      }>`INSERT INTO schools_directory_schools (
        name, contact_person, email, phone, language, active
      ) VALUES (
        'Outcome policy school', 'Contact', 'policy-school@example.invalid', '90000002',
        'Norwegian', true
      ) RETURNING school_id::double precision AS "schoolId"`;

      const school = SchoolId.make(schools[0]!.schoolId);

      yield* sql`INSERT INTO schools_directory_departments (school_id, department_id) VALUES
        (${school}, ${scope.departmentId}), (${school}, ${otherDepartment})`;

      const seedPerson = (key: string) =>
        Effect.gen(function* () {
          const person = personOf(key);
          yield* sql`INSERT INTO person_profiles (person_id, first_name, last_name)
            VALUES (${person}, 'Ada', 'Candidate')`;
          yield* sql`INSERT INTO organization_volunteer_affiliations (
            person_id, department_id, status, revision
          ) VALUES (${person}, ${scope.departmentId}, 'Active', 1)`;

          return person;
        });

      for (const [index, seed] of applicantSeeds.entries()) {
        const person = yield* seedPerson(seed.key);
        const applicant = `policy-applicant-${seed.key}`;
        const application = applicationOf(seed.key);
        const email = `policy-${seed.key}@example.invalid`;
        const invitation = `policy-account-invitation-${seed.key}`;

        yield* sql`INSERT INTO admission_applicants (
          applicant_id, normalized_email, email, first_name, last_name, phone, gender,
          field_of_study_id, year_of_study
        ) VALUES (
          ${applicant}, ${email}, ${email}, 'Ada', 'Candidate',
          ${`9000${String(index).padStart(4, "0")}`}, 0, 'policy-field', 2
        )`;
        yield* sql`INSERT INTO admission_applications (
          application_id, applicant_id, admission_period_id, department_id, field_of_study_id,
          year_of_study, submitted_at
        ) VALUES (
          ${application}, ${applicant}, ${periodId}, ${scope.departmentId}, 'policy-field', 2,
          '2026-02-01'
        )`;
        yield* sql`INSERT INTO applicant_account_invitations (
          invitation_id, application_id, applicant_id, token_digest, expires_at, state, issued_by,
          issued_at
        ) VALUES (
          ${invitation}, ${application}, ${applicant}, ${hex(1000 + index)},
          '2027-01-01T00:00:00.000Z', 'Claimed', ${interviewer}, '2026-02-02T00:00:00.000Z'
        )`;
        yield* sql`INSERT INTO applicant_account_links (applicant_id, person_id, linked_at, invitation_id)
          VALUES (${applicant}, ${person}, '2026-02-02T00:00:00.000Z', ${invitation})`;

        const recommendation = seed.recommendation;

        if (recommendation !== undefined) {
          const interview = `policy-interview-${seed.key}`;
          const interviewInvitation = `policy-interview-invitation-${seed.key}`;

          yield* sql`INSERT INTO recruitment_interviews (
            interview_id, application_id, department_id, interviewer_person_id, interview_schema_id,
            assigned_by_person_id, assigned_at, revision
          ) VALUES (
            ${interview}, ${application}, ${scope.departmentId}, ${interviewer}, 'policy-schema',
            ${interviewer}, '2026-02-03T00:00:00.000Z', 1
          )`;
          yield* sql`INSERT INTO recruitment_interview_schedules (
            interview_id, scheduled_at, room, campus, map_link, message, scheduled_by_person_id,
            committed_at, schedule_revision
          ) VALUES (
            ${interview}, '2026-02-10T10:00:00.000Z', 'A-101', 'Gløshaugen',
            'https://example.invalid/map', 'Velkommen', ${interviewer},
            '2026-02-03T00:00:00.000Z', 1
          )`;
          yield* sql`INSERT INTO recruitment_invitations (
            invitation_id, interview_id, schedule_revision, capability_sha256, response_state,
            created_at
          ) VALUES (
            ${interviewInvitation}, ${interview}, 1, ${hex(2000 + index)}, 'Pending',
            '2026-02-03T00:00:00.000Z'
          )`;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE recruitment_invitations
                SET response_state = 'Accepted', responded_at = '2026-02-04T00:00:00.000Z',
                    response_revision = 1
                WHERE invitation_id = ${interviewInvitation}`;
              yield* sql`INSERT INTO recruitment_invitation_response_audit (
                invitation_id, interview_id, schedule_revision, response_revision, response_state,
                response_message, responded_at
              ) VALUES (
                ${interviewInvitation}, ${interview}, 1, 1, 'Accepted', NULL,
                '2026-02-04T00:00:00.000Z'
              )`;
              yield* sql`INSERT INTO recruitment_interview_conducts (
                interview_id, answers, explanatory_power, role_model, suitability,
                finalized_by_person_id, finalized_at, interview_revision, recommendation
              ) VALUES (
                ${interview}, '[]'::jsonb, 7, 8, 9, ${interviewer}, '2026-02-10T11:00:00.000Z', 2,
                ${recommendation}
              )`;
            }),
          );
        }

        if (seed.placement === "current") {
          yield* insertPlacement(sql, {
            id: placementIdOf(seed.key, 0),
            person,
            department: scope.departmentId,
            semester: scope.semesterId,
            school,
            active: true,
            revision: 1,
          });
        }

        if (seed.placement === "elsewhere") {
          yield* sql`INSERT INTO organization_volunteer_affiliations (
            person_id, department_id, status, revision
          ) VALUES (${person}, ${otherDepartment}, 'Active', 1)`;
          yield* insertPlacement(sql, {
            id: placementIdOf(seed.key, 1),
            person,
            department: otherDepartment,
            semester: scope.semesterId,
            school,
            active: true,
            revision: 1,
          });
          yield* insertPlacement(sql, {
            id: placementIdOf(seed.key, 2),
            person,
            department: scope.departmentId,
            semester: scope.semesterId,
            school,
            active: false,
            revision: 2,
          });
          yield* insertPlacement(sql, {
            id: placementIdOf(seed.key, 3),
            person,
            department: scope.departmentId,
            semester: previousSemester,
            school,
            active: true,
            revision: 1,
          });
        }

        if (seed.returning === true) {
          yield* insertPlacement(sql, {
            id: placementIdOf(seed.key, 3),
            person,
            department: scope.departmentId,
            semester: previousSemester,
            school,
            active: false,
            revision: 2,
          });
          yield* sql`INSERT INTO admission_returning_registrations (
            registration_id, application_id, applicant_id, person_id, placement_id, department_id,
            semester_id, admission_period_id, revision, command_id, year_of_study,
            monday_unavailable, tuesday_unavailable, wednesday_unavailable, thursday_unavailable,
            friday_unavailable, position_weeks, preferred_group, language, preferred_school,
            team_interest, team_ids, registered_at
          ) VALUES (
            ${`returning-registration-${hex(1)}`}, ${application}, ${applicant}, ${person},
            ${placementIdOf(seed.key, 3)}, ${scope.departmentId}, ${scope.semesterId}, ${periodId},
            1, 'policy-returning-command', 2, false, false, false, false, false, 4, 'all', 'Norsk',
            NULL, false, '[]'::jsonb, '2026-02-01T09:00:00.000Z'
          )`;
        }

        if (seed.outcome !== undefined) {
          yield* sql`INSERT INTO admission_application_outcomes (
            application_id, revision, outcome, decided_by_person_id, decided_at
          ) VALUES (${application}, 1, ${seed.outcome}, ${recruiter}, '2026-05-01T10:00:00.000Z')`;
        }
      }

      const assistant = yield* seedPerson(coverAssistant);
      yield* insertPlacement(sql, {
        id: placementIdOf(coverAssistant, 0),
        person: assistant,
        department: scope.departmentId,
        semester: scope.semesterId,
        school,
        active: true,
        revision: 1,
      });
    }),
  ),
);

const policy = suiteSeed.pipe(
  Layer.provideMerge(
    Layer.mergeAll(AdmissionsLive, PlacementsLive).pipe(Layer.provideMerge(database)),
  ),
  Layer.provideMerge(cluster),
);

// SAFETY: this is the retired wire value that an old client or a direct caller sends. The cases
// assert that the service refuses it, and `never` keeps the file compiling once the closed type
// drops the label.
const retiredOutcome = "Substitute" as never;

const record = (application: PublicApplicationId, outcome: AdmissionOutcome) =>
  Admissions.use((service) =>
    service.recordAdmissionOutcome(
      { applicationId: application, command: { outcome }, actor: recruiter, now },
      () => Effect.void,
    ),
  );

const readEntry = (application: PublicApplicationId) =>
  Admissions.use((service) => service.readAdmissionOutcome(application));

const historyOf = (application: PublicApplicationId) =>
  Database.use(
    (sql) => sql<{ readonly revision: number; readonly outcome: string }>`SELECT revision, outcome
      FROM admission_application_outcomes WHERE application_id = ${application} ORDER BY revision`,
  );

let commandSequence = 0;

/** A fresh 64-digit command id, so that every created placement has its own id. */
const nextCommandId = () => hex(900_000 + ++commandSequence);

const createPlacement = (key: string) =>
  Effect.gen(function* () {
    const schools = yield* Database.use(
      (sql) => sql<{ readonly schoolId: number }>`SELECT school_id::double precision AS "schoolId"
        FROM schools_directory_schools WHERE name = 'Outcome policy school'`,
    );

    return yield* Placements.use((service) =>
      service.execute(
        {
          mutation: {
            mode: "board",
            scope,
            command: {
              action: "Create",
              personId: personOf(key),
              schoolId: SchoolId.make(schools[0]!.schoolId),
              day: "Monday",
              workdays: 4,
              block: "1",
            },
          },
          actor: coordinator,
          now,
          commandId: nextCommandId(),
        },
        () => Effect.void,
      ),
    );
  });

/**
 * Runs `effect` in a savepoint of the caller's transaction, so that a database rejection leaves
 * the transaction usable. Outside a transaction it is a transaction of its own and commits.
 */
const attempt = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Database.use((sql) => sql.withTransaction(effect)).pipe(Effect.exit);

/** The history is append-only, so a case observes its writes inside a transaction it rolls back. */
const observeRolledBack = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    let observed: { readonly value: A } | undefined;

    const exit = yield* Effect.exit(
      Database.use((sql) =>
        sql.withTransaction(
          Effect.flatMap(effect, (value) => {
            observed = { value };

            return Effect.fail("rolled back" as const);
          }),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(observed).toBeDefined();

    return observed!.value;
  });

const blockedBackends = Database.use(
  (sql) => sql<{ readonly blocked: number }>`SELECT count(*)::int AS blocked FROM pg_stat_activity
    WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
).pipe(Effect.map((rows) => rows[0]?.blocked ?? 0));

/**
 * Runs `holder` in a transaction that stays open, starts `contender` in another transaction on
 * another connection, and reports whether the contender waited on a lock that the holder held
 * before the holder committed, and which of the two committed.
 */
const raceOnScopeLock = <HolderE, HolderR, ContenderE, ContenderR>(
  holder: Effect.Effect<unknown, HolderE, HolderR>,
  contender: Effect.Effect<unknown, ContenderE, ContenderR>,
) =>
  Effect.gen(function* () {
    const holding = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const contenderDone = yield* Deferred.make<void>();

    const holderFiber = yield* Effect.forkChild(
      Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* holder.pipe(Effect.ensuring(Deferred.succeed(holding, undefined)));
            yield* Deferred.await(release);
          }),
        ),
      ).pipe(Effect.exit),
    );

    yield* Deferred.await(holding);

    const contenderFiber = yield* Effect.forkChild(
      Database.use((sql) => sql.withTransaction(contender)).pipe(
        Effect.exit,
        Effect.ensuring(Deferred.succeed(contenderDone, undefined)),
      ),
    );

    let waited = false;

    for (let polls = 0; polls < 200; polls += 1) {
      if (yield* Deferred.isDone(contenderDone)) break;

      if ((yield* blockedBackends) > 0) {
        waited = true;
        break;
      }

      yield* Effect.sleep("25 millis");
    }

    yield* Deferred.succeed(release, undefined);

    const holderExit = yield* Fiber.join(holderFiber);
    const contenderExit = yield* Fiber.join(contenderFiber);

    return {
      waited,
      holderCommitted: Exit.isSuccess(holderExit),
      contenderCommitted: Exit.isSuccess(contenderExit),
    };
  });

/** What the database holds after a race: an active placement in the scope, and the latest outcome. */
const committedState = (key: string) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const placements = yield* sql<{ readonly active: number }>`SELECT count(*)::int AS active
        FROM assistant_placements WHERE person_id = ${personOf(key)}
          AND department_id = ${scope.departmentId} AND semester_id = ${scope.semesterId} AND active`;

      const outcomes = yield* sql<{ readonly outcome: string }>`SELECT outcome
        FROM admission_application_outcomes WHERE application_id = ${applicationOf(key)}
        ORDER BY revision DESC LIMIT 1`;

      return { placed: (placements[0]?.active ?? 0) > 0, outcome: outcomes[0]?.outcome ?? null };
    }),
  );

/** Upgrade proof: the history of 80 migrations is the previous schema; the later ones are the upgrade. */
const baseline = selectDatabaseMigration("80_days-served-and-certificates");

const baselineMigrations: ReadonlyArray<DatabaseMigrationDefinition> = [
  ...baseline.preceding,
  baseline.migration,
];

const laterMigrations: ReadonlyArray<DatabaseMigrationDefinition> =
  databaseMigrationDefinitions.slice(baseline.preceding.length + 1);

const readSql = (migration: DatabaseMigrationDefinition) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    return yield* fs.readFileString(yield* path.fromFileUrl(migration.url));
  });

const select = <R extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: ReadonlyArray<unknown> = [],
) => pgQuery<R>(pool, text, values).pipe(Effect.map(({ rows }) => rows));

/**
 * Application outcome histories of the previous schema. `Substitute` is current for
 * `substitute-current` and `admitted-then-substitute`; it is only history for
 * `substitute-then-admitted` and `substitute-then-rejected`. Later revisions have another decider
 * than the first, so that attributing a new revision to a previous decider is observable.
 */
const upgradeSeed = `
INSERT INTO public.admission_period_departments (department_id, name)
  VALUES ('upgrade-department', 'Upgrade');
INSERT INTO public.organization_departments (department_id, name, short_name, email, city)
  VALUES ('upgrade-department', 'Upgrade', 'UPG', 'upgrade@example.invalid', 'Trondheim');
INSERT INTO public.admission_period_semesters (semester_id, start_at, end_at)
  VALUES ('upgrade-semester', '2026-01-01', '2027-01-01');
INSERT INTO public.admission_periods (
  admission_period_id, department_id, semester_id, start_at, end_at, last_command_id
) VALUES (
  'upgrade-period', 'upgrade-department', 'upgrade-semester', '2026-01-01', '2027-01-01', 'seed'
);
INSERT INTO public.admission_period_fields_of_study (field_of_study_id, department_id, name)
  VALUES ('upgrade-field', 'upgrade-department', 'Math');
INSERT INTO public.person_profiles (person_id, first_name, last_name) VALUES
  ('upgrade-first-decider', 'Rita', 'Recruiter'),
  ('upgrade-second-decider', 'Rolf', 'Recruiter');
INSERT INTO public.admission_applicants (
  applicant_id, normalized_email, email, first_name, last_name, phone, gender, field_of_study_id,
  year_of_study
) VALUES
  ('upgrade-applicant-1', 'upgrade-1@example.invalid', 'upgrade-1@example.invalid', 'Ada', 'One', '90000001', 0, 'upgrade-field', 2),
  ('upgrade-applicant-2', 'upgrade-2@example.invalid', 'upgrade-2@example.invalid', 'Ada', 'Two', '90000002', 0, 'upgrade-field', 2),
  ('upgrade-applicant-3', 'upgrade-3@example.invalid', 'upgrade-3@example.invalid', 'Ada', 'Three', '90000003', 0, 'upgrade-field', 2),
  ('upgrade-applicant-4', 'upgrade-4@example.invalid', 'upgrade-4@example.invalid', 'Ada', 'Four', '90000004', 0, 'upgrade-field', 2),
  ('upgrade-applicant-5', 'upgrade-5@example.invalid', 'upgrade-5@example.invalid', 'Ada', 'Five', '90000005', 0, 'upgrade-field', 2),
  ('upgrade-applicant-6', 'upgrade-6@example.invalid', 'upgrade-6@example.invalid', 'Ada', 'Six', '90000006', 0, 'upgrade-field', 2),
  ('upgrade-applicant-7', 'upgrade-7@example.invalid', 'upgrade-7@example.invalid', 'Ada', 'Seven', '90000007', 0, 'upgrade-field', 2);
INSERT INTO public.admission_applications (
  application_id, applicant_id, admission_period_id, department_id, field_of_study_id,
  year_of_study, submitted_at
) VALUES
  ('substitute-current', 'upgrade-applicant-1', 'upgrade-period', 'upgrade-department', 'upgrade-field', 2, '2026-02-01'),
  ('substitute-then-admitted', 'upgrade-applicant-2', 'upgrade-period', 'upgrade-department', 'upgrade-field', 2, '2026-02-01'),
  ('admitted-then-substitute', 'upgrade-applicant-3', 'upgrade-period', 'upgrade-department', 'upgrade-field', 2, '2026-02-01'),
  ('substitute-then-rejected', 'upgrade-applicant-4', 'upgrade-period', 'upgrade-department', 'upgrade-field', 2, '2026-02-01'),
  ('plain-admitted', 'upgrade-applicant-5', 'upgrade-period', 'upgrade-department', 'upgrade-field', 2, '2026-02-01'),
  ('plain-rejected', 'upgrade-applicant-6', 'upgrade-period', 'upgrade-department', 'upgrade-field', 2, '2026-02-01'),
  ('undecided', 'upgrade-applicant-7', 'upgrade-period', 'upgrade-department', 'upgrade-field', 2, '2026-02-01');
INSERT INTO public.admission_application_outcomes (application_id, revision, outcome, decided_by_person_id, decided_at)
  VALUES ('substitute-current', 1, 'Substitute', 'upgrade-first-decider', '2026-03-01T10:00:00.000Z');
INSERT INTO public.admission_application_outcomes (application_id, revision, outcome, decided_by_person_id, decided_at)
  VALUES ('substitute-then-admitted', 1, 'Substitute', 'upgrade-first-decider', '2026-03-01T10:00:00.000Z');
INSERT INTO public.admission_application_outcomes (application_id, revision, outcome, decided_by_person_id, decided_at)
  VALUES ('substitute-then-admitted', 2, 'Admitted', 'upgrade-second-decider', '2026-03-02T10:00:00.000Z');
INSERT INTO public.admission_application_outcomes (application_id, revision, outcome, decided_by_person_id, decided_at)
  VALUES ('admitted-then-substitute', 1, 'Admitted', 'upgrade-first-decider', '2026-03-01T10:00:00.000Z');
INSERT INTO public.admission_application_outcomes (application_id, revision, outcome, decided_by_person_id, decided_at)
  VALUES ('admitted-then-substitute', 2, 'Substitute', 'upgrade-second-decider', '2026-03-02T10:00:00.000Z');
INSERT INTO public.admission_application_outcomes (application_id, revision, outcome, decided_by_person_id, decided_at)
  VALUES ('substitute-then-rejected', 1, 'Substitute', 'upgrade-first-decider', '2026-03-01T10:00:00.000Z');
INSERT INTO public.admission_application_outcomes (application_id, revision, outcome, decided_by_person_id, decided_at)
  VALUES ('substitute-then-rejected', 2, 'Rejected', 'upgrade-second-decider', '2026-03-02T10:00:00.000Z');
INSERT INTO public.admission_application_outcomes (application_id, revision, outcome, decided_by_person_id, decided_at)
  VALUES ('plain-admitted', 1, 'Admitted', 'upgrade-first-decider', '2026-03-01T10:00:00.000Z');
INSERT INTO public.admission_application_outcomes (application_id, revision, outcome, decided_by_person_id, decided_at)
  VALUES ('plain-rejected', 1, 'Rejected', 'upgrade-first-decider', '2026-03-01T10:00:00.000Z');
`;

/**
 * Observers that stay in the database: PGlite's socket server closes a connection that reports
 * an error, so a statement runs inside a function that answers whether it was accepted or the
 * SQLSTATE that rejected it, and undoes it in both cases.
 */
const observers = `
CREATE FUNCTION public.outcome_policy_attempt(statement text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE changed integer;
BEGIN
  BEGIN
    EXECUTE statement;
    GET DIAGNOSTICS changed = ROW_COUNT;
    RAISE EXCEPTION 'attempt undone' USING ERRCODE = 'RB001';
  EXCEPTION WHEN SQLSTATE 'RB001' THEN
    RETURN 'accepted ' || changed;
  END;
EXCEPTION WHEN OTHERS THEN
  RETURN 'rejected ' || SQLSTATE;
END $$;
CREATE FUNCTION public.outcome_policy_outbox_rows() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE outbox record; counted bigint; total integer := 0;
BEGIN
  FOR outbox IN SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE '%outbox%' LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', outbox.table_name) INTO counted;
    total := total + counted;
  END LOOP;
  RETURN total;
END $$;
`;

interface HistoryRow extends QueryResultRow {
  readonly application_id: string;
  readonly revision: number;
  readonly outcome: string;
  readonly decided_by_person_id: string | null;
  readonly decided_at: string;
}

const readHistory = `SELECT application_id, revision, outcome, decided_by_person_id,
  to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at
  FROM public.admission_application_outcomes ORDER BY application_id COLLATE "C", revision`;

const rowKey = (row: HistoryRow) =>
  `${row.application_id}|${row.revision}|${row.outcome}|${row.decided_by_person_id}|${row.decided_at}`;

/** A revision that has no human decider and carries explicit provenance that its predecessor lacks. */
const readProvenance = `SELECT migrated.application_id AS application, migrated.revision,
  (jsonb_strip_nulls(to_jsonb(migrated) - 'application_id' - 'revision' - 'outcome' - 'decided_by_person_id' - 'decided_at') <> '{}'::jsonb
    AND jsonb_strip_nulls(to_jsonb(migrated) - 'application_id' - 'revision' - 'outcome' - 'decided_by_person_id' - 'decided_at')
      IS DISTINCT FROM jsonb_strip_nulls(to_jsonb(previous) - 'application_id' - 'revision' - 'outcome' - 'decided_by_person_id' - 'decided_at')) AS explicit
  FROM public.admission_application_outcomes AS migrated
  JOIN public.admission_application_outcomes AS previous
    ON previous.application_id = migrated.application_id AND previous.revision = migrated.revision - 1
  WHERE migrated.decided_by_person_id IS NULL
  ORDER BY migrated.application_id COLLATE "C", migrated.revision`;

const readLatest = `SELECT application.application_id AS application, latest.outcome
  FROM public.admission_applications AS application
  LEFT JOIN LATERAL (
    SELECT outcome.outcome FROM public.admission_application_outcomes AS outcome
    WHERE outcome.application_id = application.application_id ORDER BY outcome.revision DESC LIMIT 1
  ) AS latest ON true
  ORDER BY application.application_id COLLATE "C"`;

const insertRevision = (application: string, revision: number, outcome: string) =>
  `INSERT INTO public.admission_application_outcomes (application_id, revision, outcome, decided_by_person_id, decided_at)
   VALUES ('${application}', ${revision}, '${outcome}', 'upgrade-first-decider', '2026-04-01T10:00:00.000Z')`;

const attemptStatement = (pool: Pool, statement: string) =>
  select<{ readonly outcome: string }>(
    pool,
    "SELECT public.outcome_policy_attempt($1) AS outcome",
    [statement],
  ).pipe(Effect.map((rows) => rows[0]?.outcome));

/** Seeds the previous schema, applies the later migrations, and observes the upgraded history. */
const upgrade = (pool: Pool) =>
  Effect.gen(function* () {
    yield* pgQuery(pool, upgradeSeed);
    yield* pgQuery(pool, observers);

    const before = yield* select<HistoryRow>(pool, readHistory);

    const peopleBefore = yield* select<{ readonly total: number }>(
      pool,
      "SELECT count(*)::int AS total FROM public.person_profiles",
    );

    const mailBefore = yield* select<{ readonly total: number }>(
      pool,
      "SELECT public.outcome_policy_outbox_rows() AS total",
    );

    for (const migration of laterMigrations) yield* pgQuery(pool, yield* readSql(migration));

    const after = yield* select<HistoryRow>(pool, readHistory);

    const peopleAfter = yield* select<{ readonly total: number }>(
      pool,
      "SELECT count(*)::int AS total FROM public.person_profiles",
    );

    const mailAfter = yield* select<{ readonly total: number }>(
      pool,
      "SELECT public.outcome_policy_outbox_rows() AS total",
    );

    const provenance = yield* select<{
      readonly application: string;
      readonly revision: number;
      readonly explicit: boolean;
    }>(pool, readProvenance);

    const latest = yield* select<{ readonly application: string; readonly outcome: string | null }>(
      pool,
      readLatest,
    );

    const beforeKeys = new Set(before.map(rowKey));
    const afterKeys = new Set(after.map(rowKey));

    // A new revision of a decided application follows the current one; a Substitute is refused
    // while the same row as an Admitted revision is accepted, so the refusal names the label.
    const control = yield* attemptStatement(pool, insertRevision("plain-rejected", 2, "Admitted"));

    const retired = yield* attemptStatement(
      pool,
      insertRevision("plain-rejected", 2, "Substitute"),
    );

    yield* pgQuery(
      pool,
      "DROP FUNCTION public.outcome_policy_attempt(text); DROP FUNCTION public.outcome_policy_outbox_rows()",
    );

    return {
      appended: after.flatMap((row) =>
        beforeKeys.has(rowKey(row))
          ? []
          : [
              {
                application: row.application_id,
                revision: row.revision,
                outcome: row.outcome,
                decidedBy: row.decided_by_person_id,
              },
            ],
      ),
      rewritten: before.flatMap((row) =>
        afterKeys.has(rowKey(row)) ? [] : [`${row.application_id}#${row.revision}`],
      ),
      provenance,
      latest,
      legacyRevisions: after.filter((row) => row.outcome === "Substitute").length,
      inventedPeople: (peopleAfter[0]?.total ?? 0) - (peopleBefore[0]?.total ?? 0),
      mailRows: (mailAfter[0]?.total ?? 0) - (mailBefore[0]?.total ?? 0),
      directInsert: { control, substituteRejected: retired?.startsWith("rejected ") === true },
    };
  });

const upgradeEvidence = {
  // One Admitted revision for each application whose current outcome was Substitute, appended
  // after the last revision, attributed to nobody.
  appended: [
    { application: "admitted-then-substitute", revision: 3, outcome: "Admitted", decidedBy: null },
    { application: "substitute-current", revision: 2, outcome: "Admitted", decidedBy: null },
  ],
  rewritten: [],
  provenance: [
    { application: "admitted-then-substitute", revision: 3, explicit: true },
    { application: "substitute-current", revision: 2, explicit: true },
  ],
  latest: [
    { application: "admitted-then-substitute", outcome: "Admitted" },
    { application: "plain-admitted", outcome: "Admitted" },
    { application: "plain-rejected", outcome: "Rejected" },
    { application: "substitute-current", outcome: "Admitted" },
    { application: "substitute-then-admitted", outcome: "Admitted" },
    { application: "substitute-then-rejected", outcome: "Rejected" },
    { application: "undecided", outcome: null },
  ],
  // The four preserved literals stay as internal history.
  legacyRevisions: 4,
  inventedPeople: 0,
  mailRows: 0,
  directInsert: { control: "accepted 1", substituteRejected: true },
};

layer(Layer.merge(policy, TestPlatform), { excludeTestServices: true, timeout: "180 seconds" })(
  "admission outcome policy on real PostgreSQL",
  (it) => {
    it.effect("runs on the PostgreSQL major that VEKTOR_POSTGRES_MAJOR selects", () =>
      Effect.gen(function* () {
        const postgres = yield* OutcomePolicyCluster;

        expect(postgres.version).toContain(`PostgreSQL) ${selectedPostgresMajor}.`);
      }),
    );

    it.effect("admits only Admitted and Rejected as an outcome and as a command value", () =>
      Effect.sync(() => {
        expect({
          admitted: Schema.is(AdmissionOutcome)("Admitted"),
          rejected: Schema.is(AdmissionOutcome)("Rejected"),
          substituteOutcome: Schema.is(AdmissionOutcome)("Substitute"),
          substituteCommand: Schema.is(AdmissionOutcomeCommand)({ outcome: "Substitute" }),
        }).toEqual({
          admitted: true,
          rejected: true,
          substituteOutcome: false,
          substituteCommand: false,
        });
      }),
    );

    for (const key of [
      "ja-unplaced",
      "ja-placed",
      "nei-unplaced",
      "nei-placed",
      "kanskje-unplaced",
      "kanskje-placed",
      "returning",
    ]) {
      it.effect(
        `refuses a new Substitute revision for ${key} and keeps it out of the history`,
        () =>
          Effect.gen(function* () {
            const observed = yield* observeRolledBack(
              Effect.gen(function* () {
                const exit = yield* attempt(record(applicationOf(key), retiredOutcome));
                const history = yield* historyOf(applicationOf(key));

                return {
                  refused: Exit.isFailure(exit),
                  substituteRevisions: history.filter((row) => row.outcome === "Substitute").length,
                };
              }),
            );

            expect(observed).toEqual({ refused: true, substituteRevisions: 0 });
          }),
      );
    }

    for (const [key, outcome] of [
      ["ja-unplaced", "Rejected"],
      ["ja-placed", "Rejected"],
      ["nei-unplaced", "Admitted"],
      ["nei-placed", "Admitted"],
    ] as const) {
      it.effect(`does not let a decision override the interview result of ${key}`, () =>
        Effect.gen(function* () {
          const observed = yield* observeRolledBack(
            Effect.gen(function* () {
              const exit = yield* attempt(record(applicationOf(key), outcome));

              return {
                refused: Exit.isFailure(exit),
                revisions: (yield* historyOf(applicationOf(key))).length,
              };
            }),
          );

          expect(observed).toEqual({ refused: true, revisions: 0 });
        }),
      );
    }

    for (const key of ["kanskje-unplaced", "returning"]) {
      it.effect(`takes an explicit Admitted decision for ${key} without a placement`, () =>
        Effect.gen(function* () {
          const observed = yield* observeRolledBack(
            Effect.gen(function* () {
              const before = yield* readEntry(applicationOf(key));
              const admitted = yield* attempt(record(applicationOf(key), "Admitted"));

              return {
                undecidedBefore: before.outcome,
                admitted: Exit.isSuccess(admitted),
                history: yield* historyOf(applicationOf(key)),
                outcome: (yield* readEntry(applicationOf(key))).outcome,
              };
            }),
          );

          expect(observed).toEqual({
            undecidedBefore: null,
            admitted: true,
            history: [{ revision: 1, outcome: "Admitted" }],
            outcome: "Admitted",
          });
        }),
      );
    }

    it.effect(
      "cannot commit Rejected for a person with an active placement in the same department and semester",
      () =>
        Effect.gen(function* () {
          const exit = yield* attempt(record(applicationOf("placed-reject"), "Rejected"));
          const committed = yield* historyOf(applicationOf("placed-reject"));

          expect({ refused: Exit.isFailure(exit), committed }).toEqual({
            refused: true,
            committed: [],
          });
        }),
    );

    it.effect(
      "commits Rejected when the placements are only in another department, another semester, or removed",
      () =>
        Effect.gen(function* () {
          const exit = yield* attempt(record(applicationOf("kanskje-elsewhere"), "Rejected"));
          const committed = yield* historyOf(applicationOf("kanskje-elsewhere"));

          expect({ refused: Exit.isFailure(exit), committed }).toEqual({
            refused: false,
            committed: [{ revision: 1, outcome: "Rejected" }],
          });
        }),
    );

    it.effect("accepts Rejected for a Kanskje applicant only after the placement is removed", () =>
      Effect.gen(function* () {
        const observed = yield* observeRolledBack(
          Effect.gen(function* () {
            const application = applicationOf("kanskje-placed");
            const whilePlaced = yield* attempt(record(application, "Rejected"));

            const removed = yield* attempt(
              Placements.use((service) =>
                service.execute(
                  {
                    mutation: {
                      mode: "board",
                      scope,
                      command: {
                        action: "Remove",
                        placementId: placementIdOf("kanskje-placed", 0),
                      },
                    },
                    actor: coordinator,
                    now,
                    commandId: nextCommandId(),
                  },
                  () => Effect.void,
                ),
              ),
            );

            const afterRemoval = yield* attempt(record(application, "Rejected"));

            return {
              whilePlacedRefused: Exit.isFailure(whilePlaced),
              removed: Exit.isSuccess(removed),
              afterRemovalAccepted: Exit.isSuccess(afterRemoval),
            };
          }),
        );

        expect(observed).toEqual({
          whilePlacedRefused: true,
          removed: true,
          afterRemovalAccepted: true,
        });
      }),
    );

    it.effect("refuses a placement for a person whose outcome is Rejected", () =>
      Effect.gen(function* () {
        const observed = yield* observeRolledBack(
          Effect.gen(function* () {
            const rejected = yield* attempt(record(applicationOf("kanskje-unplaced"), "Rejected"));
            const placement = yield* attempt(createPlacement("kanskje-unplaced"));
            const active = yield* committedState("kanskje-unplaced");

            return {
              rejectedRecorded: Exit.isSuccess(rejected),
              placementRefused: Exit.isFailure(placement),
              placed: active.placed,
            };
          }),
        );

        expect(observed).toEqual({
          rejectedRecorded: true,
          placementRefused: true,
          placed: false,
        });
      }),
    );

    it.effect("keeps the Admitted history untouched when the person is placed afterwards", () =>
      Effect.gen(function* () {
        const observed = yield* observeRolledBack(
          Effect.gen(function* () {
            const application = applicationOf("kanskje-unplaced");
            const admitted = yield* attempt(record(application, "Admitted"));
            const placement = yield* attempt(createPlacement("kanskje-unplaced"));

            return {
              admitted: Exit.isSuccess(admitted),
              placed: Exit.isSuccess(placement),
              history: yield* historyOf(application),
            };
          }),
        );

        expect(observed).toEqual({
          admitted: true,
          placed: true,
          history: [{ revision: 1, outcome: "Admitted" }],
        });
      }),
    );

    it.effect(
      "serializes a Rejected write that came first before a placement create on the scope lock",
      () =>
        Effect.gen(function* () {
          const observed = yield* raceOnScopeLock(
            record(applicationOf("race-reject-first"), "Rejected"),
            createPlacement("race-reject-first"),
          );

          expect({ ...observed, ...(yield* committedState("race-reject-first")) }).toEqual({
            waited: true,
            holderCommitted: true,
            contenderCommitted: false,
            placed: false,
            outcome: "Rejected",
          });
        }),
      30_000,
    );

    it.effect(
      "serializes a placement create that came first before a Rejected write on the scope lock",
      () =>
        Effect.gen(function* () {
          const observed = yield* raceOnScopeLock(
            createPlacement("race-place-first"),
            record(applicationOf("race-place-first"), "Rejected"),
          );

          expect({ ...observed, ...(yield* committedState("race-place-first")) }).toEqual({
            waited: true,
            holderCommitted: true,
            contenderCommitted: false,
            placed: true,
            outcome: null,
          });
        }),
      30_000,
    );

    it.effect("lists an Admitted assistant without a placement as an eligible coverer, once", () =>
      Effect.gen(function* () {
        const board = yield* Placements.use((service) => service.readCoverageBoard(scope));

        const listed = board.coverers
          .flatMap((coverer) =>
            coverer.personId.startsWith("policy-person-cover-") ? [coverer.personId] : [],
          )
          .toSorted();

        expect(listed).toEqual([
          personOf("cover-assistant"),
          personOf("cover-placed"),
          personOf("cover-unplaced"),
        ]);
      }),
    );

    it.effect("rejects a new Substitute revision in direct SQL and accepts an Admitted one", () =>
      Effect.gen(function* () {
        const insert = (outcome: string) =>
          attempt(
            Database.use(
              (sql) => sql`INSERT INTO admission_application_outcomes (
                application_id, revision, outcome, decided_by_person_id, decided_at
              ) VALUES (${applicationOf("direct-sql")}, 1, ${outcome}, ${recruiter}, ${now})`,
            ),
          );

        const control = yield* observeRolledBack(insert("Admitted"));
        const retired = yield* observeRolledBack(insert("Substitute"));

        expect({
          admittedAccepted: Exit.isSuccess(control),
          substituteRejected: Exit.isFailure(retired),
        }).toEqual({ admittedAccepted: true, substituteRejected: true });
      }),
    );

    it.effect(
      "upgrades each current Substitute with one provenance-marked Admitted revision and rewrites no history, on PostgreSQL",
      () =>
        Effect.gen(function* () {
          const postgres = yield* OutcomePolicyCluster;

          const url = yield* Effect.promise(() =>
            postgres.createDatabase("outcome_policy_upgrade"),
          );

          const pool = yield* Effect.acquireRelease(
            Effect.sync(() => new Pool({ connectionString: url, max: 1 })),
            (opened) => Effect.promise(() => opened.end()),
          );

          for (const migration of baselineMigrations)
            yield* pgQuery(pool, yield* readSql(migration));

          expect(yield* upgrade(pool)).toEqual(upgradeEvidence);
        }).pipe(Effect.scoped, Effect.orDie),
      120_000,
    );

    // PGlite creates and migrates the previous schema inside this case, not in the suite Layer.
    it.effect(
      "upgrades each current Substitute with one provenance-marked Admitted revision and rewrites no history, on PGlite",
      () =>
        withPostgresTestDatabase(upgrade, baselineMigrations).pipe(
          Effect.map((evidence) => expect(evidence).toEqual(upgradeEvidence)),
          Effect.orDie,
        ),
      60_000,
    );
  },
);

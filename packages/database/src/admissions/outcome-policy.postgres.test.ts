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
  AdmissionOutcomeEntry,
  AdmissionOutcomeFailure,
  AdmissionOutcomePersistenceError,
} from "@vektorprogrammet/domain/admissions";
import type { OutcomeMailRenderer } from "@vektorprogrammet/domain/admissions/template";
import {
  type PublicApplicationId,
  PublicApplicationIdSchema,
} from "@vektorprogrammet/domain/application";
import { DepartmentId, PersonId, SemesterId } from "@vektorprogrammet/domain/organization";
import { PlacementFailure, Placements } from "@vektorprogrammet/domain/placements";
import { SchoolId } from "@vektorprogrammet/domain/schools";
import { DatabaseLive } from "../layers.js";
import { type DatabaseMigrationDefinition, selectDatabaseMigration } from "../migrations.js";
import { pgQuery } from "../pg-pool.js";
import { Database, type DatabaseOperations } from "../service.js";
import { TestPlatform } from "../test-support/platform.js";
import { withPostgresTestDatabase } from "../test-support/postgres.js";
import { PlacementsLive } from "../placements/index.js";
import { AdmissionsLive } from "./index.js";

/**
 * Real-PostgreSQL proof of spec 0027 (docs/specs/0027-admission-outcome-policy.md in the effx
 * design repository, falsifiers 1 and 2) for the two-step admission outcome policy. The suite
 * was committed red-first against the accepted source `8152c389`, where each case failed because
 * the source behaved otherwise. It now runs the distinct `decideAdmissionOutcome` and
 * `announceAdmissionOutcome` operations of the Admissions service and the Placements service,
 * each in the caller's transaction, and states every law of the approved policy:
 *
 * - `AdmissionOutcome` is `Admitted | Rejected`; `Substitute` is not an outcome, not a command
 *   value and not an insertable revision, also through direct SQL.
 * - Decide takes only the applications that an interview does not derive: `Kanskje` and a
 *   returning assistant without an interview. `Ja` and `Nei` cannot be decided, not even to the
 *   value that they derive, and an unreviewed application has nothing to decide. An unplaced
 *   Admitted person is never denied, and an unannounced decision may be revised against its frozen citation.
 * - Announce derives `Ja` as Admitted and `Nei` as Rejected, announces the decision of `Kanskje`
 *   and returning, and refuses an undecided one before it renders or writes anything. It is
 *   terminal: one announcement, one revision history that takes no further row, one mail
 *   envelope that commits or rolls back with the outcome. Either callback fails the call
 *   unchanged and before any write.
 * - `Rejected`, decided or announced, cannot be committed for a person with an active placement
 *   in the same department and semester, and a placement cannot be created for a Rejected
 *   person. A Rejected write, an announcement and a placement create contend on one scope lock,
 *   in both orders, on separate connections. A later placement never rewrites an announcement.
 * - An Admitted assistant without a placement is an eligible coverer, once.
 * - One migration after the accepted `80_days-served-and-certificates` appends exactly one
 *   Admitted revision with the `SemanticUpgrade` provenance and no human decider for each
 *   application whose current outcome is `Substitute`, announces nothing and rewrites no earlier
 *   revision.
 *
 * The suite starts a private cluster of the PostgreSQL major that `VEKTOR_POSTGRES_MAJOR` selects
 * (the highest supported one by default; `VEKTOR_POSTGRES_MAJOR=17` selects 17). The upgrade proof
 * also runs on PGlite. Authority is resolved by the transport before these operations and is not
 * their input; the HTTP suite proves who may decide and announce.
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
  { key: "unreviewed" },
  { key: "race-announce-reject-first", recommendation: "Nei" },
  { key: "race-announce-place-first", recommendation: "Nei" },
  { key: "race-announce-twice", recommendation: "Nei" },
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
      ) VALUES ('policy-schema', 'Policy', 1, true, 0)`;
      yield* sql`INSERT INTO recruitment_interview_schema_questions (
        interview_schema_id, question_id, ordinal, prompt, kind, alternatives
      ) VALUES ('policy-schema', 'explanation', 0, 'Explain how you would help a pupil.', 'text', '[]'::jsonb)`;

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
            ${interviewer}, '2026-02-03T00:00:00.000Z', 2
          )`;
          yield* sql`INSERT INTO recruitment_interview_question_snapshots (
            interview_id, question_id, ordinal, prompt, kind, alternatives
          ) SELECT ${interview}, question_id, ordinal, prompt, kind, alternatives
            FROM recruitment_interview_schema_questions WHERE interview_schema_id = 'policy-schema'`;
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
                ${interview}, '[{"questionId":"explanation","answer":"Work through a concrete example with the pupil."}]'::jsonb,
                7, 8, 9, ${interviewer}, '2026-02-10T11:00:00.000Z', 2,
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
          // Ja/Nei record the interview-derived outcome, never a human override.
          const derived = recommendation === "Ja" || recommendation === "Nei";
          yield* sql`INSERT INTO admission_application_outcomes (
            application_id, revision, outcome, decided_by_person_id, decided_at, provenance
          ) VALUES (${application}, 1, ${seed.outcome}, ${derived ? null : recruiter},
            '2026-05-01T10:00:00.000Z', ${derived ? "Recommendation" : "Decision"})`;
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

const decideChecked = <E>(
  application: PublicApplicationId,
  outcome: AdmissionOutcome,
  checkPrecondition: (current: AdmissionOutcomeEntry) => Effect.Effect<void, E>,
) =>
  Admissions.use((service) =>
    service.decideAdmissionOutcome(
      { applicationId: application, command: { outcome }, actor: recruiter, now },
      checkPrecondition,
    ),
  );

const decide = (application: PublicApplicationId, outcome: AdmissionOutcome) =>
  decideChecked(application, outcome, () => Effect.void);

/** The bytes are a pure function of the template kind and values, so a case can check what was queued. */
const renderMail: OutcomeMailRenderer = ({ kind, values }) =>
  Effect.succeed({
    subject: `Utfall ${values.firstName} ${values.departmentName}`,
    html: `<p>${kind}</p>`,
    text: `${kind}|${values.schoolName ?? "-"}`,
  });

/** A renderer that no refused announcement may reach: reaching it changes the failure the case sees. */
const unrenderable: OutcomeMailRenderer<"render failed"> = () =>
  Effect.fail("render failed" as const);

const announceChecked = <E, RenderE>(
  application: PublicApplicationId,
  checkPrecondition: (current: AdmissionOutcomeEntry) => Effect.Effect<void, E>,
  render: OutcomeMailRenderer<RenderE>,
) =>
  Admissions.use((service) =>
    service.announceAdmissionOutcome(
      { applicationId: application, actor: coordinator, now },
      checkPrecondition,
      render,
    ),
  );

const announce = (application: PublicApplicationId) =>
  announceChecked(application, () => Effect.void, renderMail);

/** The school of the seeded placements; the announcement names it for an Admitted person who has one. */
const placementSchool = "Outcome policy school";

/** A failure of the operations under test as comparable data; any other failure passes through. */
const describeRefusal = <F>(failure: F) =>
  failure instanceof AdmissionOutcomeFailure ||
  failure instanceof AdmissionOutcomePersistenceError ||
  failure instanceof PlacementFailure
    ? { _tag: failure._tag, code: failure.code, status: failure.status }
    : failure;

/**
 * What `effect` refuses with, run in a savepoint of the caller's transaction so that the
 * transaction stays usable. A call that succeeds fails the case, because it was meant to refuse.
 */
const refusalOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Database.use((sql) => sql.withTransaction(effect)).pipe(Effect.flip, Effect.map(describeRefusal));

const outcomeRefusal = (
  code: AdmissionOutcomeFailure["code"],
  status: AdmissionOutcomeFailure["status"],
) => describeRefusal(new AdmissionOutcomeFailure({ code, status }));

const derivedRefusal = outcomeRefusal("admission-outcome.derived", 422);

const unreviewedRefusal = outcomeRefusal("admission-outcome.unreviewed", 422);

const undecidedRefusal = outcomeRefusal("admission-outcome.undecided", 409);

const placementActiveRefusal = outcomeRefusal("admission-outcome.placement-active", 409);

const finalRefusal = outcomeRefusal("admission-outcome.final", 409);

const notFoundRefusal = outcomeRefusal("resource.not-found", 404);

/** The database refuses a Substitute revision with its CHECK; the service reports an internal failure. */
const storageRefusal = describeRefusal(
  new AdmissionOutcomePersistenceError({ code: "internal.error", status: 500, cause: undefined }),
);

const placementRejectedRefusal = describeRefusal(
  new PlacementFailure({ code: "placement.person-rejected", status: 422 }),
);

const readEntry = (application: PublicApplicationId) =>
  Admissions.use((service) => service.readAdmissionOutcome(application));

const historyOf = (application: PublicApplicationId) =>
  Database.use(
    (sql) => sql<{ readonly revision: number; readonly outcome: string }>`SELECT revision, outcome
      FROM admission_application_outcomes WHERE application_id = ${application} ORDER BY revision`,
  );

/** Every revision with the provenance and decider that the database holds for it. */
const provenanceOf = (application: PublicApplicationId) =>
  Database.use(
    (sql) => sql<{
      readonly revision: number;
      readonly outcome: string;
      readonly provenance: string;
      readonly decidedBy: string | null;
    }>`SELECT revision, outcome, provenance, decided_by_person_id AS "decidedBy"
      FROM admission_application_outcomes WHERE application_id = ${application} ORDER BY revision`,
  );

const announcementsOf = (application: PublicApplicationId) =>
  Database.use(
    (sql) => sql<{
      readonly outcome: string;
      readonly outcomeRevision: number;
      readonly announcedBy: string;
    }>`SELECT outcome, outcome_revision AS "outcomeRevision", announced_by_person_id AS "announcedBy"
      FROM admission_outcome_announcements WHERE application_id = ${application}`,
  );

/** The queued mail envelopes of the application, as the worker will send them. */
const mailOf = (application: PublicApplicationId) =>
  Database.use(
    (sql) => sql<{
      readonly kind: string;
      readonly recipient: string;
      readonly subject: string;
      readonly html: string;
      readonly text: string;
    }>`SELECT kind, payload_json->>'recipient' AS recipient, payload_json->>'subject' AS subject,
        payload_json->>'html' AS html, payload_json->>'text' AS text
      FROM admission_outcome_outbox WHERE application_id = ${application}`,
  );

/** The entry that a reader sees, and everything that the operations wrote for the application. */
const observeApplication = (key: string) =>
  Effect.gen(function* () {
    const application = applicationOf(key);
    const entry = yield* readEntry(application);

    return {
      basis: entry.basis,
      state: entry.state,
      outcome: entry.outcome,
      placed: entry.placed,
      history: yield* provenanceOf(application),
      announcements: yield* announcementsOf(application),
      mail: yield* mailOf(application),
    };
  });

const untouched = { history: [], announcements: [], mail: [] };

/** The three fields of an entry that a decision or an announcement changes. */
const summary = (entry: AdmissionOutcomeEntry) => ({
  outcome: entry.outcome,
  state: entry.state,
  placed: entry.placed,
});

/** A revision that Rekruttering decided. */
const decision = (revision: number, outcome: AdmissionOutcome) => ({
  revision,
  outcome,
  provenance: "Decision",
  decidedBy: recruiter,
});

/** The revision that an interview derived at the announcement; nobody decided it. */
const recommendation = (revision: number, outcome: AdmissionOutcome) => ({
  revision,
  outcome,
  provenance: "Recommendation",
  decidedBy: null,
});

const announcementOf = (outcome: AdmissionOutcome, outcomeRevision: number) => ({
  outcome,
  outcomeRevision,
  announcedBy: coordinator,
});

const mailFor = (key: string, kind: string, school?: string) => ({
  kind,
  recipient: `policy-${key}@example.invalid`,
  subject: "Utfall Ada Policy",
  html: `<p>${kind}</p>`,
  text: `${kind}|${school ?? "-"}`,
});

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

const removePlacement = (key: string) =>
  Placements.use((service) =>
    service.execute(
      {
        mutation: {
          mode: "board",
          scope,
          command: { action: "Remove", placementId: placementIdOf(key, 0) },
        },
        actor: coordinator,
        now,
        commandId: nextCommandId(),
      },
      () => Effect.void,
    ),
  );

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

/**
 * What the database holds after a race: an active placement in the scope, the latest outcome
 * revision, and how many announcements and mail envelopes the application has.
 */
const committedState = (key: string) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const placements = yield* sql<{ readonly active: number }>`SELECT count(*)::int AS active
        FROM assistant_placements WHERE person_id = ${personOf(key)}
          AND department_id = ${scope.departmentId} AND semester_id = ${scope.semesterId} AND active`;

      const outcomes = yield* sql<{ readonly outcome: string }>`SELECT outcome
        FROM admission_application_outcomes WHERE application_id = ${applicationOf(key)}
        ORDER BY revision DESC LIMIT 1`;

      const announcements = yield* sql<{ readonly total: number }>`SELECT count(*)::int AS total
        FROM admission_outcome_announcements WHERE application_id = ${applicationOf(key)}`;

      const mail = yield* sql<{ readonly total: number }>`SELECT count(*)::int AS total
        FROM admission_outcome_outbox WHERE application_id = ${applicationOf(key)}`;

      return {
        placed: (placements[0]?.active ?? 0) > 0,
        outcome: outcomes[0]?.outcome ?? null,
        announced: announcements[0]?.total ?? 0,
        mail: mail[0]?.total ?? 0,
      };
    }),
  );

/** Upgrade proof: the history of 80 migrations is the previous schema; the later ones are the upgrade. */
const baseline = selectDatabaseMigration("80_days-served-and-certificates");

const baselineMigrations: ReadonlyArray<DatabaseMigrationDefinition> = [
  ...baseline.preceding,
  baseline.migration,
];

const laterMigrations: ReadonlyArray<DatabaseMigrationDefinition> = [
  ...selectDatabaseMigration("82_admission-outcome-mail").preceding,
  selectDatabaseMigration("82_admission-outcome-mail").migration,
].slice(baseline.preceding.length + 1);

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

const serviceId = (kind: string, digit: string) => `school-service-${kind}-${digit.repeat(64)}`;

/**
 * Coverage and receipt facts of the previous schema, beside the outcome histories. Migration 0081
 * drops `coverer_kind`, so the records carry both of its values: a withdrawn `Substitute` record
 * and a current `Assistant` record on one absence, and a current `Substitute` record on another.
 * Both absences belong to dated commitments of one confirmed proposal, as every live coverage
 * record does. The receipt is a successful pre-cutover `recordOutcome` answer that names the
 * retired label.
 */
const previousServiceSeed = `
INSERT INTO public.person_profiles (person_id, first_name, last_name) VALUES
  ('upgrade-absent', 'Anna', 'Absent'),
  ('upgrade-cover-one', 'Cora', 'One'),
  ('upgrade-cover-two', 'Cora', 'Two');
INSERT INTO public.schools_directory_schools (school_id, name, contact_person, email, phone, language, active, revision)
  OVERRIDING SYSTEM VALUE VALUES (9701, 'Upgrade school', 'Kontakt', 'school@example.invalid', 'synthetic', 'Norwegian', true, 0);
INSERT INTO public.schools_directory_departments (school_id, department_id, revision)
  VALUES (9701, 'upgrade-department', 0);
INSERT INTO public.school_service_proposals (
  proposal_id, department_id, semester_id, status, revision, created_at, created_by_person_id,
  confirmed_at, confirmed_by_person_id, demand_snapshot, assignment_snapshot, exception_snapshot
) VALUES (
  '${serviceId("proposal", "a")}', 'upgrade-department', 'upgrade-semester', 'Confirmed', 1,
  '2026-02-10T10:00:00.000Z', 'upgrade-first-decider', '2026-02-11T10:00:00.000Z',
  'upgrade-first-decider',
  '[{"schoolId":9701,"day":"Monday","block":"1","requiredVolunteers":1}]'::jsonb,
  '[{"personId":"upgrade-absent","schoolId":9701,"day":"Monday","block":"1"}]'::jsonb,
  '[]'::jsonb
);
INSERT INTO public.school_service_commitments (
  commitment_id, proposal_id, department_id, semester_id, school_id, school_name, day, block,
  service_date, start_time, end_time, required_volunteers, assignment_snapshot, created_at,
  created_by_person_id
) VALUES
  ('${serviceId("commitment", "7")}', '${serviceId("proposal", "a")}', 'upgrade-department',
   'upgrade-semester', 9701, 'Upgrade school', 'Monday', '1', '2026-03-02', '15:00', '17:00', 1,
   '[{"personId":"upgrade-absent","schoolId":9701,"day":"Monday","block":"1"}]'::jsonb,
   '2026-02-12T10:00:00.000Z', 'upgrade-first-decider'),
  ('${serviceId("commitment", "8")}', '${serviceId("proposal", "a")}', 'upgrade-department',
   'upgrade-semester', 9701, 'Upgrade school', 'Monday', '1', '2026-03-09', '15:00', '17:00', 1,
   '[{"personId":"upgrade-absent","schoolId":9701,"day":"Monday","block":"1"}]'::jsonb,
   '2026-02-12T10:00:00.000Z', 'upgrade-first-decider');
INSERT INTO public.school_service_absences (
  absence_id, proposal_id, department_id, semester_id, person_id, school_id, day, block,
  service_date, reporter_person_id, reported_at, commitment_id
) VALUES
  ('${serviceId("absence", "b")}', '${serviceId("proposal", "a")}', 'upgrade-department', 'upgrade-semester',
   'upgrade-absent', 9701, 'Monday', '1', '2026-03-02', 'upgrade-absent', '2026-03-01T08:00:00.000Z',
   '${serviceId("commitment", "7")}'),
  ('${serviceId("absence", "c")}', '${serviceId("proposal", "a")}', 'upgrade-department', 'upgrade-semester',
   'upgrade-absent', 9701, 'Monday', '1', '2026-03-09', 'upgrade-absent', '2026-03-08T08:00:00.000Z',
   '${serviceId("commitment", "8")}');
INSERT INTO public.school_service_coverage_records (
  coverage_id, absence_id, covering_person_id, coverer_kind, recorded_by_person_id, recorded_at
) VALUES
  ('${serviceId("coverage", "d")}', '${serviceId("absence", "b")}', 'upgrade-cover-one', 'Substitute',
   'upgrade-cover-one', '2026-03-01T09:00:00.000Z');
UPDATE public.school_service_coverage_records
  SET withdrawn_by_person_id = 'upgrade-first-decider', withdrawn_at = '2026-03-01T10:00:00.000Z'
  WHERE coverage_id = '${serviceId("coverage", "d")}';
INSERT INTO public.school_service_coverage_records (
  coverage_id, absence_id, covering_person_id, coverer_kind, recorded_by_person_id, recorded_at
) VALUES
  ('${serviceId("coverage", "e")}', '${serviceId("absence", "b")}', 'upgrade-cover-two', 'Assistant',
   'upgrade-cover-two', '2026-03-01T11:00:00.000Z'),
  ('${serviceId("coverage", "f")}', '${serviceId("absence", "c")}', 'upgrade-cover-one', 'Substitute',
   'upgrade-cover-one', '2026-03-08T09:00:00.000Z');
INSERT INTO public.native_http_idempotency_receipts (
  identity_sha256, request_sha256, operation_id, state, status, media_type, body_bytes,
  headers_json, committed_at, full_expires_at
) VALUES (
  '${"1".repeat(64)}', '${"2".repeat(64)}', 'admissionOutcomes.recordOutcome', 'Complete', 200,
  'application/json',
  convert_to('{"applicationId":"substitute-current","outcome":"Substitute","revision":1}', 'UTF8'),
  '{"content-type":"application/json","etag":"\\"previous\\""}'::jsonb,
  '2026-03-01T10:00:00.000Z', '2026-03-02T10:00:00.000Z'
);
`;

const readCoverage = `SELECT coverage_id, absence_id, covering_person_id, recorded_by_person_id,
  to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at,
  withdrawn_by_person_id,
  to_char(withdrawn_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS withdrawn_at
  FROM public.school_service_coverage_records ORDER BY coverage_id COLLATE "C"`;

const readCovererKindColumns = `SELECT count(*)::int AS total FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'school_service_coverage_records'
    AND column_name = 'coverer_kind'`;

/** The whole receipt row, with its body as text, so that any change to it shows. */
const readReceipts = `SELECT identity_sha256, operation_id, state, status, media_type,
  convert_from(body_bytes, 'UTF8') AS body, headers_json::text AS headers,
  to_char(committed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS committed_at
  FROM public.native_http_idempotency_receipts ORDER BY identity_sha256 COLLATE "C"`;

interface CoverageRow extends QueryResultRow {
  readonly coverage_id: string;
  readonly absence_id: string;
  readonly covering_person_id: string;
  readonly recorded_by_person_id: string;
  readonly recorded_at: string;
  readonly withdrawn_by_person_id: string | null;
  readonly withdrawn_at: string | null;
}

interface ReceiptRow extends QueryResultRow {
  readonly identity_sha256: string;
  readonly operation_id: string;
  readonly state: string;
  readonly status: number;
  readonly media_type: string;
  readonly body: string;
  readonly headers: string;
  readonly committed_at: string;
}

/** The column values of one row in select order, so that two reads of a row compare by value. */
const rowText = (row: QueryResultRow) => Object.values(row).join("\u001f");

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

/** A revision with an explicit provenance, to observe which provenance and decider pairs the schema accepts. */
const insertProvenanceRevision = (
  application: string,
  revision: number,
  provenance: string,
  decider: string | null,
) =>
  `INSERT INTO public.admission_application_outcomes (application_id, revision, outcome, decided_by_person_id, decided_at, provenance)
   VALUES ('${application}', ${revision}, 'Admitted', ${decider === null ? "NULL" : `'${decider}'`}, '2026-04-01T10:00:00.000Z', '${provenance}')`;

const readProvenanceLabels = `SELECT provenance, count(*)::int AS total
  FROM public.admission_application_outcomes GROUP BY provenance ORDER BY provenance COLLATE "C"`;

const readSemanticUpgrades = `SELECT application_id AS application, revision
  FROM public.admission_application_outcomes WHERE provenance = 'SemanticUpgrade'
  ORDER BY application_id COLLATE "C", revision`;

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
    yield* pgQuery(pool, previousServiceSeed);
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

    const kindsBefore = yield* select<{ readonly kind: string; readonly total: number }>(
      pool,
      `SELECT coverer_kind AS kind, count(*)::int AS total
        FROM public.school_service_coverage_records GROUP BY coverer_kind ORDER BY coverer_kind COLLATE "C"`,
    );

    const coverageBefore = yield* select<CoverageRow>(pool, readCoverage);
    const receiptsBefore = yield* select<ReceiptRow>(pool, readReceipts);

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

    const coverageAfter = yield* select<CoverageRow>(pool, readCoverage);
    const receiptsAfter = yield* select<ReceiptRow>(pool, readReceipts);

    const kindColumns = yield* select<{ readonly total: number }>(pool, readCovererKindColumns);

    const currentCoverage = yield* select<{ readonly absence: string; readonly total: number }>(
      pool,
      `SELECT absence_id AS absence, count(*)::int AS total
        FROM public.school_service_coverage_records WHERE withdrawn_at IS NULL
        GROUP BY absence_id ORDER BY absence_id COLLATE "C"`,
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

    const labels = yield* select<{ readonly provenance: string; readonly total: number }>(
      pool,
      readProvenanceLabels,
    );

    const upgraded = yield* select<{ readonly application: string; readonly revision: number }>(
      pool,
      readSemanticUpgrades,
    );

    const announcements = yield* select<{ readonly total: number }>(
      pool,
      "SELECT count(*)::int AS total FROM public.admission_outcome_announcements",
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

    // The provenance names who decided: a Decision has a decider, the other two have none.
    const decisionWithoutDecider = yield* attemptStatement(
      pool,
      insertProvenanceRevision("plain-rejected", 2, "Decision", null),
    );

    const recommendationWithDecider = yield* attemptStatement(
      pool,
      insertProvenanceRevision("plain-rejected", 2, "Recommendation", "upgrade-first-decider"),
    );

    const recommendationWithoutDecider = yield* attemptStatement(
      pool,
      insertProvenanceRevision("plain-rejected", 2, "Recommendation", null),
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
      upgraded,
      provenanceLabels: labels,
      announcements: announcements[0]?.total ?? 0,
      coverage: {
        kindsBefore,
        rows: coverageAfter.length,
        rewritten: coverageBefore.filter(
          (row, index) => rowText(row) !== rowText(coverageAfter[index] ?? {}),
        ).length,
        kindColumnAfter: kindColumns[0]?.total,
        currentPerAbsence: currentCoverage,
      },
      receipts: {
        rows: receiptsAfter.length,
        unchanged:
          receiptsBefore.length === receiptsAfter.length &&
          receiptsBefore.every(
            (row, index) => rowText(row) === rowText(receiptsAfter[index] ?? {}),
          ),
        bodies: receiptsAfter.map((row) => row.body),
        operations: receiptsAfter.map((row) => row.operation_id),
      },
      directInsert: {
        control,
        substituteRejected: retired?.startsWith("rejected ") === true,
        decisionWithoutDeciderRejected: decisionWithoutDecider?.startsWith("rejected ") === true,
        recommendationWithDeciderRejected:
          recommendationWithDecider?.startsWith("rejected ") === true,
        recommendationWithoutDecider,
      },
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
  // The migration is the only author of the SemanticUpgrade provenance; the nine earlier
  // revisions keep their Decision provenance, and nothing is announced.
  upgraded: [
    { application: "admitted-then-substitute", revision: 3 },
    { application: "substitute-current", revision: 2 },
  ],
  provenanceLabels: [
    { provenance: "Decision", total: 9 },
    { provenance: "SemanticUpgrade", total: 2 },
  ],
  announcements: 0,
  coverage: {
    // Both values of the dropped discriminator existed before the upgrade.
    kindsBefore: [
      { kind: "Assistant", total: 1 },
      { kind: "Substitute", total: 2 },
    ],
    // Every record keeps its id, absence, covering person, recorder, instants and withdrawal.
    rows: 3,
    rewritten: 0,
    kindColumnAfter: 0,
    // The one-current-record-per-absence rule survives: absence b has its Assistant record,
    // absence c its Substitute-era record.
    currentPerAbsence: [
      { absence: serviceId("absence", "b"), total: 1 },
      { absence: serviceId("absence", "c"), total: 1 },
    ],
  },
  // The pre-cutover receipt keeps its operation id and its stale three-value body byte for byte.
  // The cutover replaces the operation, so the old identity can not replay into the new contract.
  receipts: {
    rows: 1,
    unchanged: true,
    bodies: ['{"applicationId":"substitute-current","outcome":"Substitute","revision":1}'],
    operations: ["admissionOutcomes.recordOutcome"],
  },
  directInsert: {
    control: "accepted 1",
    substituteRejected: true,
    decisionWithoutDeciderRejected: true,
    recommendationWithDeciderRejected: true,
    recommendationWithoutDecider: "accepted 1",
  },
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
          substituteEntryOutcome: Schema.is(AdmissionOutcomeEntry.fields.outcome)("Substitute"),
          undecidedEntryOutcome: Schema.is(AdmissionOutcomeEntry.fields.outcome)(null),
        }).toEqual({
          admitted: true,
          rejected: true,
          substituteOutcome: false,
          substituteCommand: false,
          substituteEntryOutcome: false,
          undecidedEntryOutcome: true,
        });
      }),
    );

    for (const [key, refusal] of [
      ["ja-unplaced", derivedRefusal],
      ["ja-placed", derivedRefusal],
      ["nei-unplaced", derivedRefusal],
      ["nei-placed", derivedRefusal],
      ["kanskje-unplaced", storageRefusal],
      ["kanskje-placed", storageRefusal],
      ["returning", storageRefusal],
    ] as const) {
      it.effect(
        `refuses a new Substitute revision for ${key} and keeps it out of the history`,
        () =>
          Effect.gen(function* () {
            const observed = yield* observeRolledBack(
              Effect.gen(function* () {
                const refused = yield* refusalOf(decide(applicationOf(key), retiredOutcome));
                const history = yield* historyOf(applicationOf(key));

                return {
                  refused,
                  substituteRevisions: history.filter((row) => row.outcome === "Substitute").length,
                  revisions: history.length,
                };
              }),
            );

            expect(observed).toEqual({ refused: refusal, substituteRevisions: 0, revisions: 0 });
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
              const refused = yield* refusalOf(decide(applicationOf(key), outcome));
              const entry = yield* readEntry(applicationOf(key));

              return {
                refused,
                revisions: (yield* historyOf(applicationOf(key))).length,
                effective: entry.outcome,
              };
            }),
          );

          expect(observed).toEqual({
            refused: derivedRefusal,
            revisions: 0,
            effective: outcome === "Rejected" ? "Admitted" : "Rejected",
          });
        }),
      );
    }

    for (const [key, outcome] of [
      ["ja-unplaced", "Admitted"],
      ["ja-placed", "Admitted"],
      ["nei-unplaced", "Rejected"],
      ["nei-placed", "Rejected"],
    ] as const) {
      it.effect(
        `refuses to restate the interview result of ${key} as a decision, because only the announcement settles it`,
        () =>
          Effect.gen(function* () {
            const observed = yield* observeRolledBack(
              Effect.gen(function* () {
                const refused = yield* refusalOf(decide(applicationOf(key), outcome));

                return { refused, after: yield* observeApplication(key) };
              }),
            );

            expect(observed.refused).toEqual(derivedRefusal);
            expect(observed.after).toMatchObject({
              state: "ApplicationSubmitted",
              outcome,
              ...untouched,
            });
          }),
      );
    }

    it.effect("refuses to decide or announce an unreviewed application and writes nothing", () =>
      Effect.gen(function* () {
        const observed = yield* observeRolledBack(
          Effect.gen(function* () {
            const application = applicationOf("unreviewed");

            return {
              admitted: yield* refusalOf(decide(application, "Admitted")),
              rejected: yield* refusalOf(decide(application, "Rejected")),
              announced: yield* refusalOf(
                announceChecked(application, () => Effect.void, unrenderable),
              ),
              after: yield* observeApplication("unreviewed"),
            };
          }),
        );

        expect(observed).toEqual({
          admitted: unreviewedRefusal,
          rejected: unreviewedRefusal,
          announced: unreviewedRefusal,
          after: {
            basis: "Unreviewed",
            state: "ApplicationSubmitted",
            outcome: null,
            placed: false,
            ...untouched,
          },
        });
      }),
    );

    it.effect("refuses to decide or announce an application that does not exist", () =>
      Effect.gen(function* () {
        const missing = PublicApplicationIdSchema.make("policy-application-missing");

        const observed = yield* observeRolledBack(
          Effect.gen(function* () {
            return {
              decided: yield* refusalOf(decide(missing, "Admitted")),
              announced: yield* refusalOf(
                announceChecked(missing, () => Effect.void, unrenderable),
              ),
            };
          }),
        );

        expect(observed).toEqual({ decided: notFoundRefusal, announced: notFoundRefusal });
      }),
    );

    for (const key of ["kanskje-unplaced", "returning"]) {
      it.effect(`takes an explicit Admitted decision for ${key} without a placement`, () =>
        Effect.gen(function* () {
          const observed = yield* observeRolledBack(
            Effect.gen(function* () {
              const before = yield* readEntry(applicationOf(key));
              const decided = yield* decide(applicationOf(key), "Admitted");
              const repeated = yield* decide(applicationOf(key), "Admitted");

              return {
                before: summary(before),
                decided: summary(decided),
                decidedRevision: decided.revision,
                repeated: summary(repeated),
                repeatedRevision: repeated.revision,
                after: yield* observeApplication(key),
              };
            }),
          );

          // Repeating the same explicit decision changes no revision or cited assessment.
          expect(observed).toEqual({
            before: { outcome: null, state: "ApplicationSubmitted", placed: false },
            decided: { outcome: "Admitted", state: "ApplicationSubmitted", placed: false },
            decidedRevision: 1,
            repeated: { outcome: "Admitted", state: "ApplicationSubmitted", placed: false },
            repeatedRevision: 1,
            after: {
              basis: key === "returning" ? "Returning" : "Kanskje",
              state: "ApplicationSubmitted",
              outcome: "Admitted",
              placed: false,
              history: [decision(1, "Admitted")],
              announcements: [],
              mail: [],
            },
          });
        }),
      );
    }

    it.effect(
      "lets Rekruttering revise an unannounced decision against the same frozen citation",
      () =>
        Effect.gen(function* () {
          const observed = yield* observeRolledBack(
            Effect.gen(function* () {
              const application = applicationOf("kanskje-unplaced");

              yield* decide(application, "Admitted");
              yield* decide(application, "Rejected");
              yield* decide(application, "Admitted");

              return yield* observeApplication("kanskje-unplaced");
            }),
          );

          expect(observed).toEqual({
            basis: "Kanskje",
            state: "ApplicationSubmitted",
            outcome: "Admitted",
            placed: false,
            history: [decision(1, "Admitted"), decision(2, "Rejected"), decision(3, "Admitted")],
            announcements: [],
            mail: [],
          });
        }),
    );

    it.effect(
      "checks the fresh entry before any decision write and keeps the callback failure unchanged",
      () =>
        Effect.gen(function* () {
          const observed = yield* observeRolledBack(
            Effect.gen(function* () {
              const before = yield* readEntry(applicationOf("kanskje-unplaced"));

              const failure = yield* Effect.flip(
                decideChecked(applicationOf("kanskje-unplaced"), "Admitted", (current) =>
                  Effect.fail({ code: "precondition.failed", current } as const),
                ),
              );

              return { before, failure, after: yield* observeApplication("kanskje-unplaced") };
            }),
          );

          expect(observed.failure).toEqual({
            code: "precondition.failed",
            current: observed.before,
          });
          expect(observed.after).toEqual({
            basis: "Kanskje",
            state: "ApplicationSubmitted",
            outcome: null,
            placed: false,
            ...untouched,
          });
        }),
    );

    it.effect(
      "cannot commit Rejected for a person with an active placement in the same department and semester",
      () =>
        Effect.gen(function* () {
          const refused = yield* refusalOf(decide(applicationOf("placed-reject"), "Rejected"));
          const committed = yield* historyOf(applicationOf("placed-reject"));

          expect({ refused, committed }).toEqual({
            refused: placementActiveRefusal,
            committed: [],
          });
        }),
    );

    it.effect(
      "commits Rejected when the placements are only in another department, another semester, or removed",
      () =>
        Effect.gen(function* () {
          const exit = yield* attempt(decide(applicationOf("kanskje-elsewhere"), "Rejected"));
          const committed = yield* historyOf(applicationOf("kanskje-elsewhere"));

          expect({ refused: Exit.isFailure(exit), committed }).toEqual({
            refused: false,
            committed: [{ revision: 1, outcome: "Rejected" }],
          });
        }),
    );

    it.effect(
      "treats a placement in another department, another semester, or a removed one as no placement when it announces",
      () =>
        Effect.gen(function* () {
          const observed = yield* observeRolledBack(
            Effect.gen(function* () {
              const application = applicationOf("kanskje-elsewhere");

              yield* decide(application, "Admitted");
              yield* announce(application);

              return yield* observeApplication("kanskje-elsewhere");
            }),
          );

          // The decision is the last revision, whether or not an earlier case committed a Rejected one.
          expect(observed).toMatchObject({
            state: "OutcomeAnnounced",
            outcome: "Admitted",
            placed: false,
            announcements: [announcementOf("Admitted", observed.history.length)],
            mail: [mailFor("kanskje-elsewhere", "AdmittedPlacementPending")],
          });
        }),
    );

    it.effect("accepts Rejected for a Kanskje applicant only after the placement is removed", () =>
      Effect.gen(function* () {
        const observed = yield* observeRolledBack(
          Effect.gen(function* () {
            const application = applicationOf("kanskje-placed");
            const whilePlaced = yield* refusalOf(decide(application, "Rejected"));
            const removed = yield* attempt(removePlacement("kanskje-placed"));
            const afterRemoval = yield* attempt(decide(application, "Rejected"));

            return {
              whilePlaced,
              removed: Exit.isSuccess(removed),
              afterRemovalAccepted: Exit.isSuccess(afterRemoval),
              after: yield* observeApplication("kanskje-placed"),
            };
          }),
        );

        expect(observed).toEqual({
          whilePlaced: placementActiveRefusal,
          removed: true,
          afterRemovalAccepted: true,
          after: {
            basis: "Kanskje",
            state: "ApplicationSubmitted",
            outcome: "Rejected",
            placed: false,
            history: [decision(1, "Rejected")],
            announcements: [],
            mail: [],
          },
        });
      }),
    );

    it.effect("refuses a placement for a person whose outcome is Rejected", () =>
      Effect.gen(function* () {
        const observed = yield* observeRolledBack(
          Effect.gen(function* () {
            const rejected = yield* attempt(decide(applicationOf("kanskje-unplaced"), "Rejected"));
            const placement = yield* refusalOf(createPlacement("kanskje-unplaced"));
            const active = yield* committedState("kanskje-unplaced");

            return {
              rejectedRecorded: Exit.isSuccess(rejected),
              placement,
              placed: active.placed,
            };
          }),
        );

        expect(observed).toEqual({
          rejectedRecorded: true,
          placement: placementRejectedRefusal,
          placed: false,
        });
      }),
    );

    it.effect("keeps the Admitted history untouched when the person is placed afterwards", () =>
      Effect.gen(function* () {
        const observed = yield* observeRolledBack(
          Effect.gen(function* () {
            const application = applicationOf("kanskje-unplaced");
            const admitted = yield* attempt(decide(application, "Admitted"));
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

    for (const [key, basis, outcome, kind, school] of [
      ["ja-unplaced", "Ja", "Admitted", "AdmittedPlacementPending", undefined],
      ["ja-placed", "Ja", "Admitted", "AdmittedWithSchool", placementSchool],
      ["nei-unplaced", "Nei", "Rejected", "Rejected", undefined],
    ] as const) {
      it.effect(
        `announces the interview result of ${key} as ${outcome} once, with one derived revision and one mail envelope`,
        () =>
          Effect.gen(function* () {
            const observed = yield* observeRolledBack(
              Effect.gen(function* () {
                const before = yield* readEntry(applicationOf(key));
                const announced = yield* announce(applicationOf(key));
                const again = yield* refusalOf(announce(applicationOf(key)));

                return {
                  before: summary(before),
                  announced: summary(announced),
                  revisionAdvanced: announced.revision > before.revision,
                  again,
                  after: yield* observeApplication(key),
                };
              }),
            );

            // No decision exists for Ja and Nei: the announcement derives the one revision, and
            // nobody decided it. A second announcement refuses and queues nothing.
            expect(observed).toEqual({
              before: { outcome, state: "ApplicationSubmitted", placed: key === "ja-placed" },
              announced: { outcome, state: "OutcomeAnnounced", placed: key === "ja-placed" },
              revisionAdvanced: true,
              again: finalRefusal,
              after: {
                basis,
                state: "OutcomeAnnounced",
                outcome,
                placed: key === "ja-placed",
                history: [recommendation(1, outcome)],
                announcements: [announcementOf(outcome, 1)],
                mail: [mailFor(key, kind, school)],
              },
            });
          }),
      );
    }

    for (const [key, basis, kind, school] of [
      ["kanskje-unplaced", "Kanskje", "AdmittedPlacementPending", undefined],
      ["returning", "Returning", "AdmittedPlacementPending", undefined],
      ["kanskje-placed", "Kanskje", "AdmittedWithSchool", placementSchool],
    ] as const) {
      it.effect(
        `announces the Admitted decision of ${key} without a second revision, and names the school only for a placed person`,
        () =>
          Effect.gen(function* () {
            const observed = yield* observeRolledBack(
              Effect.gen(function* () {
                const decided = yield* decide(applicationOf(key), "Admitted");
                const announced = yield* announce(applicationOf(key));

                return {
                  announced: summary(announced),
                  revisionAdvanced: announced.revision > decided.revision,
                  after: yield* observeApplication(key),
                };
              }),
            );

            expect(observed).toEqual({
              announced: {
                outcome: "Admitted",
                state: "OutcomeAnnounced",
                placed: key === "kanskje-placed",
              },
              revisionAdvanced: true,
              after: {
                basis,
                state: "OutcomeAnnounced",
                outcome: "Admitted",
                placed: key === "kanskje-placed",
                history: [decision(1, "Admitted")],
                announcements: [announcementOf("Admitted", 1)],
                mail: [mailFor(key, kind, school)],
              },
            });
          }),
      );
    }

    it.effect("announces the Rejected decision of a Kanskje applicant who has no placement", () =>
      Effect.gen(function* () {
        const observed = yield* observeRolledBack(
          Effect.gen(function* () {
            yield* decide(applicationOf("kanskje-unplaced"), "Rejected");
            yield* announce(applicationOf("kanskje-unplaced"));

            return yield* observeApplication("kanskje-unplaced");
          }),
        );

        expect(observed).toEqual({
          basis: "Kanskje",
          state: "OutcomeAnnounced",
          outcome: "Rejected",
          placed: false,
          history: [decision(1, "Rejected")],
          announcements: [announcementOf("Rejected", 1)],
          mail: [mailFor("kanskje-unplaced", "Rejected")],
        });
      }),
    );

    for (const key of ["kanskje-unplaced", "kanskje-placed", "returning"]) {
      it.effect(
        `refuses to announce ${key} before Rekruttering decided it, before it renders or writes anything`,
        () =>
          Effect.gen(function* () {
            const observed = yield* observeRolledBack(
              Effect.gen(function* () {
                const refused = yield* refusalOf(
                  announceChecked(applicationOf(key), () => Effect.void, unrenderable),
                );

                return { refused, after: yield* observeApplication(key) };
              }),
            );

            expect(observed.refused).toEqual(undecidedRefusal);
            expect(observed.after).toMatchObject({
              state: "ApplicationSubmitted",
              outcome: null,
              ...untouched,
            });
          }),
      );
    }

    it.effect(
      "cannot announce Nei for a person with an active placement, and announces it once the placement is removed",
      () =>
        Effect.gen(function* () {
          const observed = yield* observeRolledBack(
            Effect.gen(function* () {
              const application = applicationOf("nei-placed");

              const whilePlaced = yield* refusalOf(
                announceChecked(application, () => Effect.void, unrenderable),
              );

              const stillOpen = yield* observeApplication("nei-placed");
              const removed = yield* attempt(removePlacement("nei-placed"));
              const announced = yield* attempt(announce(application));

              return {
                whilePlaced,
                stillOpen,
                removed: Exit.isSuccess(removed),
                announced: Exit.isSuccess(announced),
                after: yield* observeApplication("nei-placed"),
              };
            }),
          );

          expect(observed).toEqual({
            whilePlaced: placementActiveRefusal,
            stillOpen: {
              basis: "Nei",
              state: "ApplicationSubmitted",
              outcome: "Rejected",
              placed: true,
              ...untouched,
            },
            removed: true,
            announced: true,
            after: {
              basis: "Nei",
              state: "OutcomeAnnounced",
              outcome: "Rejected",
              placed: false,
              history: [recommendation(1, "Rejected")],
              announcements: [announcementOf("Rejected", 1)],
              mail: [mailFor("nei-placed", "Rejected")],
            },
          });
        }),
    );

    for (const key of ["ja-unplaced", "kanskje-unplaced"]) {
      it.effect(
        `makes the announcement of ${key} final: no second announcement and no later decision`,
        () =>
          Effect.gen(function* () {
            const observed = yield* observeRolledBack(
              Effect.gen(function* () {
                const application = applicationOf(key);

                if (key === "kanskje-unplaced") yield* decide(application, "Admitted");

                yield* announce(application);
                const announced = yield* observeApplication(key);

                return {
                  announced,
                  again: yield* refusalOf(announce(application)),
                  admitted: yield* refusalOf(decide(application, "Admitted")),
                  rejected: yield* refusalOf(decide(application, "Rejected")),
                  after: yield* observeApplication(key),
                };
              }),
            );

            expect({
              again: observed.again,
              admitted: observed.admitted,
              rejected: observed.rejected,
            }).toEqual({ again: finalRefusal, admitted: finalRefusal, rejected: finalRefusal });
            expect(observed.after).toEqual(observed.announced);
            expect(observed.after).toMatchObject({
              state: "OutcomeAnnounced",
              outcome: "Admitted",
              announcements: [announcementOf("Admitted", 1)],
            });
            expect(observed.after.history).toHaveLength(1);
            expect(observed.after.mail).toHaveLength(1);
          }),
      );
    }

    it.effect(
      "checks the fresh entry before any announcement write and keeps the callback failure unchanged",
      () =>
        Effect.gen(function* () {
          const observed = yield* observeRolledBack(
            Effect.gen(function* () {
              const before = yield* readEntry(applicationOf("ja-unplaced"));

              const failure = yield* Effect.flip(
                announceChecked(
                  applicationOf("ja-unplaced"),
                  (current) => Effect.fail({ code: "precondition.failed", current } as const),
                  renderMail,
                ),
              );

              return { before, failure, after: yield* observeApplication("ja-unplaced") };
            }),
          );

          expect(observed.failure).toEqual({
            code: "precondition.failed",
            current: observed.before,
          });
          expect(observed.after).toEqual({
            basis: "Ja",
            state: "ApplicationSubmitted",
            outcome: "Admitted",
            placed: false,
            ...untouched,
          });
        }),
    );

    it.effect("rolls the announcement back with its mail when the mail cannot be rendered", () =>
      Effect.gen(function* () {
        const observed = yield* observeRolledBack(
          Effect.gen(function* () {
            const failure = yield* refusalOf(
              announceChecked(applicationOf("ja-unplaced"), () => Effect.void, unrenderable),
            );

            return { failure, after: yield* observeApplication("ja-unplaced") };
          }),
        );

        // The caller's transaction owns the commit: the failure of the renderer leaves neither the
        // derived revision, nor the announcement, nor an envelope behind.
        expect(observed.failure).toBe("render failed");
        expect(observed.after).toMatchObject({ state: "ApplicationSubmitted", ...untouched });
      }),
    );

    it.effect(
      "keeps the announced Rejected outcome final and refuses a placement for the Nei that was announced",
      () =>
        Effect.gen(function* () {
          const observed = yield* observeRolledBack(
            Effect.gen(function* () {
              yield* announce(applicationOf("nei-unplaced"));
              const placement = yield* refusalOf(createPlacement("nei-unplaced"));

              return {
                placement,
                active: (yield* committedState("nei-unplaced")).placed,
                after: yield* observeApplication("nei-unplaced"),
              };
            }),
          );

          expect(observed).toEqual({
            placement: placementRejectedRefusal,
            active: false,
            after: {
              basis: "Nei",
              state: "OutcomeAnnounced",
              outcome: "Rejected",
              placed: false,
              history: [recommendation(1, "Rejected")],
              announcements: [announcementOf("Rejected", 1)],
              mail: [mailFor("nei-unplaced", "Rejected")],
            },
          });
        }),
    );

    for (const key of ["ja-unplaced", "kanskje-unplaced"]) {
      it.effect(
        `never rewrites the announced Admitted outcome of ${key} or its mail when the person is placed afterwards`,
        () =>
          Effect.gen(function* () {
            const observed = yield* observeRolledBack(
              Effect.gen(function* () {
                const application = applicationOf(key);

                if (key === "kanskje-unplaced") yield* decide(application, "Admitted");

                const announced = yield* announce(application);
                const announcedState = yield* observeApplication(key);
                const placement = yield* attempt(createPlacement(key));
                const entry = yield* readEntry(application);

                return {
                  placed: Exit.isSuccess(placement),
                  announcedRevision: announced.revision,
                  entryRevision: entry.revision,
                  announcedState,
                  after: yield* observeApplication(key),
                };
              }),
            );

            // The envelope was built while the person had no placement, and it stays that way.
            expect(observed.placed).toBe(true);
            expect(observed.entryRevision).toBe(observed.announcedRevision);
            expect(observed.after).toEqual({ ...observed.announcedState, placed: true });
            expect(observed.after.mail).toEqual([mailFor(key, "AdmittedPlacementPending")]);
          }),
      );
    }

    it.effect(
      "serializes a Rejected write that came first before a placement create on the scope lock",
      () =>
        Effect.gen(function* () {
          const observed = yield* raceOnScopeLock(
            decide(applicationOf("race-reject-first"), "Rejected"),
            createPlacement("race-reject-first"),
          );

          expect({ ...observed, ...(yield* committedState("race-reject-first")) }).toEqual({
            waited: true,
            holderCommitted: true,
            contenderCommitted: false,
            placed: false,
            outcome: "Rejected",
            announced: 0,
            mail: 0,
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
            decide(applicationOf("race-place-first"), "Rejected"),
          );

          expect({ ...observed, ...(yield* committedState("race-place-first")) }).toEqual({
            waited: true,
            holderCommitted: true,
            contenderCommitted: false,
            placed: true,
            outcome: null,
            announced: 0,
            mail: 0,
          });
        }),
      30_000,
    );

    it.effect(
      "serializes a Nei announcement that came first before a placement create on the scope lock",
      () =>
        Effect.gen(function* () {
          const observed = yield* raceOnScopeLock(
            announce(applicationOf("race-announce-reject-first")),
            createPlacement("race-announce-reject-first"),
          );

          expect({
            ...observed,
            ...(yield* committedState("race-announce-reject-first")),
          }).toEqual({
            waited: true,
            holderCommitted: true,
            contenderCommitted: false,
            placed: false,
            outcome: "Rejected",
            announced: 1,
            mail: 1,
          });
        }),
      30_000,
    );

    it.effect(
      "serializes a placement create that came first before a Nei announcement on the scope lock",
      () =>
        Effect.gen(function* () {
          const observed = yield* raceOnScopeLock(
            createPlacement("race-announce-place-first"),
            announce(applicationOf("race-announce-place-first")),
          );

          expect({
            ...observed,
            ...(yield* committedState("race-announce-place-first")),
          }).toEqual({
            waited: true,
            holderCommitted: true,
            contenderCommitted: false,
            placed: true,
            outcome: null,
            announced: 0,
            mail: 0,
          });
        }),
      30_000,
    );

    it.effect(
      "serializes two announcements of one application on the scope lock: one announcement, one mail",
      () =>
        Effect.gen(function* () {
          const observed = yield* raceOnScopeLock(
            announce(applicationOf("race-announce-twice")),
            announce(applicationOf("race-announce-twice")),
          );

          expect({ ...observed, ...(yield* committedState("race-announce-twice")) }).toEqual({
            waited: true,
            holderCommitted: true,
            contenderCommitted: false,
            placed: false,
            outcome: "Rejected",
            announced: 1,
            mail: 1,
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

    it.effect(
      "lists a Ja applicant who was announced Admitted without a placement as an eligible coverer, once",
      () =>
        Effect.gen(function* () {
          const listed = yield* observeRolledBack(
            Effect.gen(function* () {
              yield* announce(applicationOf("ja-unplaced"));

              const board = yield* Placements.use((service) => service.readCoverageBoard(scope));

              return board.coverers.flatMap((coverer) =>
                coverer.personId === personOf("ja-unplaced") ? [coverer.personId] : [],
              );
            }),
          );

          expect(listed).toEqual([personOf("ja-unplaced")]);
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
      "rejects a revision after the announcement and any rewrite or second announcement of it in direct SQL",
      () =>
        Effect.gen(function* () {
          const observed = yield* observeRolledBack(
            Effect.gen(function* () {
              const announced = applicationOf("ja-unplaced");
              yield* announce(announced);

              const insertRevision = (
                application: PublicApplicationId,
                outcome: AdmissionOutcome,
              ) =>
                attempt(
                  Database.use(
                    (sql) => sql`INSERT INTO admission_application_outcomes (
                      application_id, revision, outcome, decided_by_person_id, decided_at, provenance
                    ) VALUES (${application}, ${application === announced ? 2 : 1}, ${outcome}, ${recruiter}, ${now}, 'Decision')`,
                  ),
                );

              return {
                lateRevision: yield* insertRevision(announced, "Rejected"),
                control: yield* insertRevision(applicationOf("kanskje-unplaced"), "Rejected"),
                rewriteRevision: yield* attempt(
                  Database.use(
                    (sql) => sql`UPDATE admission_application_outcomes SET outcome = 'Rejected'
                      WHERE application_id = ${announced}`,
                  ),
                ),
                rewriteAnnouncement: yield* attempt(
                  Database.use(
                    (sql) => sql`UPDATE admission_outcome_announcements SET outcome = 'Rejected'
                      WHERE application_id = ${announced}`,
                  ),
                ),
                eraseAnnouncement: yield* attempt(
                  Database.use(
                    (sql) => sql`DELETE FROM admission_outcome_announcements
                      WHERE application_id = ${announced}`,
                  ),
                ),
                secondAnnouncement: yield* attempt(
                  Database.use(
                    (sql) => sql`INSERT INTO admission_outcome_announcements (
                      application_id, outcome, outcome_revision, announced_by_person_id, announced_at
                    ) VALUES (${announced}, 'Admitted', 1, ${coordinator}, ${now})`,
                  ),
                ),
                after: yield* observeApplication("ja-unplaced"),
              };
            }),
          );

          // The control revision of another, unannounced application is accepted by the same
          // statement, so the refusals above name the announcement and not the statement.
          expect({
            lateRevisionRejected: Exit.isFailure(observed.lateRevision),
            controlAccepted: Exit.isSuccess(observed.control),
            rewriteRevisionRejected: Exit.isFailure(observed.rewriteRevision),
            rewriteAnnouncementRejected: Exit.isFailure(observed.rewriteAnnouncement),
            eraseAnnouncementRejected: Exit.isFailure(observed.eraseAnnouncement),
            secondAnnouncementRejected: Exit.isFailure(observed.secondAnnouncement),
            history: observed.after.history,
            announcements: observed.after.announcements,
          }).toEqual({
            lateRevisionRejected: true,
            controlAccepted: true,
            rewriteRevisionRejected: true,
            rewriteAnnouncementRejected: true,
            eraseAnnouncementRejected: true,
            secondAnnouncementRejected: true,
            history: [recommendation(1, "Admitted")],
            announcements: [announcementOf("Admitted", 1)],
          });
        }),
    );

    it.effect(
      "accepts a revision only when its provenance and its decider agree: Decision names a person, the others none",
      () =>
        Effect.gen(function* () {
          const insert = (provenance: string, decider: PersonId | null) =>
            attempt(
              Database.use(
                (sql) => sql`INSERT INTO admission_application_outcomes (
                  application_id, revision, outcome, decided_by_person_id, decided_at, provenance
                ) VALUES (${applicationOf("direct-sql")}, 1, 'Admitted', ${decider}, ${now}, ${provenance})`,
              ),
            );

          const observed = yield* observeRolledBack(
            Effect.gen(function* () {
              return {
                decisionWithoutDecider: yield* insert("Decision", null),
                recommendationWithDecider: yield* insert("Recommendation", recruiter),
                semanticUpgradeWithDecider: yield* insert("SemanticUpgrade", recruiter),
                unknownProvenance: yield* insert("Announcement", null),
                decision: yield* insert("Decision", recruiter),
              };
            }),
          );

          expect({
            decisionWithoutDecider: Exit.isFailure(observed.decisionWithoutDecider),
            recommendationWithDecider: Exit.isFailure(observed.recommendationWithDecider),
            semanticUpgradeWithDecider: Exit.isFailure(observed.semanticUpgradeWithDecider),
            unknownProvenance: Exit.isFailure(observed.unknownProvenance),
            decision: Exit.isSuccess(observed.decision),
          }).toEqual({
            decisionWithoutDecider: true,
            recommendationWithDecider: true,
            semanticUpgradeWithDecider: true,
            unknownProvenance: true,
            decision: true,
          });
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

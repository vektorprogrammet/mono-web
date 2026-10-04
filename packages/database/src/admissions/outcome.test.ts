import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Layer, Predicate } from "effect";
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { DepartmentId, PersonId, SemesterId } from "@vektorprogrammet/domain/organization";
import {
  Admissions,
  AdmissionOutcomeFailure,
  type AdmissionOutcome,
} from "@vektorprogrammet/domain/admissions";
import type { OutcomeMailRenderer } from "@vektorprogrammet/domain/admissions/template";
import { Database } from "../service.js";
import { DatabaseTestLive } from "../test-support/platform.js";
import { AdmissionsLive } from "./index.js";

const database = DatabaseTestLive();

const suiteLayer = Layer.merge(database, AdmissionsLive.pipe(Layer.provide(database)));

const scope = {
  departmentId: DepartmentId.make("outcome-department"),
  semesterId: SemesterId.make("outcome-semester"),
};

const applicationId = PublicApplicationIdSchema.make("outcome-application");

const recruiter = PersonId.make("outcome-recruiter");

const coordinator = PersonId.make("outcome-coordinator");

const now = "2026-06-01T10:00:00.000Z";

const decide = (outcome: AdmissionOutcome, at = now) =>
  Admissions.use((service) =>
    service.decideAdmissionOutcome(
      { applicationId, command: { outcome }, actor: recruiter, now: at },
      () => Effect.void,
    ),
  );

/** The bytes are a pure function of the template kind, so the case can check what was queued. */
const render: OutcomeMailRenderer = ({ kind }) =>
  Effect.succeed({
    subject: `Utfall ${kind}`,
    html: `<html><body>${kind}</body></html>`,
    text: kind,
  });

const announce = Admissions.use((service) =>
  service.announceAdmissionOutcome(
    { applicationId, actor: coordinator, now },
    () => Effect.void,
    render,
  ),
);

const readEntry = Admissions.use((service) => service.readAdmissionOutcome(applicationId));

const announcementRows = Database.use(
  (sql) => sql<{ readonly outcome: string; readonly outcomeRevision: number }>`
    SELECT outcome, outcome_revision AS "outcomeRevision"
    FROM public.admission_outcome_announcements WHERE application_id = ${applicationId}`,
);

const envelopeRows = Database.use(
  (sql) => sql<{ readonly total: number }>`
    SELECT count(*)::int AS total FROM public.admission_outcome_outbox
    WHERE application_id = ${applicationId}`,
).pipe(Effect.map((rows) => rows[0]?.total ?? 0));

/** The history is append-only, so a case observes its writes inside a transaction it rolls back. */
const observeRolledBack = <A, E>(effect: Effect.Effect<A, E, Admissions | Database>) =>
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

/** The one interview of the application is finalized with Kanskje, so Rekruttering decides. */
const suiteSeed = Layer.effectDiscard(
  Database.use((sql) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO admission_period_departments(department_id,name) VALUES(${scope.departmentId},'Outcomes')`;
      yield* sql`INSERT INTO organization_departments(department_id,name,short_name,email,city) VALUES(${scope.departmentId},'Outcomes','OUT','outcomes@example.invalid','Trondheim')`;
      yield* sql`INSERT INTO admission_period_semesters(semester_id,start_at,end_at) VALUES(${scope.semesterId},'2026-01-01','2027-01-01')`;
      yield* sql`INSERT INTO admission_periods(admission_period_id,department_id,semester_id,start_at,end_at,last_command_id) VALUES('outcome-period',${scope.departmentId},${scope.semesterId},'2026-01-01','2027-01-01','seed')`;
      yield* sql`INSERT INTO admission_period_fields_of_study(field_of_study_id,department_id,name) VALUES('outcome-field',${scope.departmentId},'Math')`;
      yield* sql`INSERT INTO admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study) VALUES('outcome-applicant','candidate@example.invalid','candidate@example.invalid','Ada','Candidate','12345678',0,'outcome-field',2)`;
      yield* sql`INSERT INTO admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at) VALUES(${applicationId},'outcome-applicant','outcome-period',${scope.departmentId},'outcome-field',2,'2026-02-01')`;
      yield* sql`INSERT INTO person_profiles(person_id,first_name,last_name) VALUES(${recruiter},'Rita','Recruiter'),(${coordinator},'Cora','Coordinator')`;
      yield* sql`INSERT INTO recruitment_interview_schemas(interview_schema_id,name,question_count,active,revision) VALUES('outcome-schema','Outcome',0,true,0)`;
      yield* sql`INSERT INTO recruitment_interviews(interview_id,application_id,department_id,interviewer_person_id,interview_schema_id,assigned_by_person_id,assigned_at,revision) VALUES('outcome-interview',${applicationId},${scope.departmentId},${recruiter},'outcome-schema',${recruiter},'2026-02-03T00:00:00.000Z',1)`;
      yield* sql`INSERT INTO recruitment_interview_schedules(interview_id,scheduled_at,room,campus,map_link,message,scheduled_by_person_id,committed_at,schedule_revision) VALUES('outcome-interview','2026-02-10T10:00:00.000Z','A-101','Gløshaugen','https://example.invalid/map','Velkommen',${recruiter},'2026-02-03T00:00:00.000Z',1)`;
      yield* sql`INSERT INTO recruitment_invitations(invitation_id,interview_id,schedule_revision,capability_sha256,response_state,created_at) VALUES('outcome-invitation','outcome-interview',1,${"a".repeat(64)},'Pending','2026-02-03T00:00:00.000Z')`;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE recruitment_invitations SET response_state='Accepted',responded_at='2026-02-04T00:00:00.000Z',response_revision=1 WHERE invitation_id='outcome-invitation'`;
          yield* sql`INSERT INTO recruitment_invitation_response_audit(invitation_id,interview_id,schedule_revision,response_revision,response_state,response_message,responded_at) VALUES('outcome-invitation','outcome-interview',1,1,'Accepted',NULL,'2026-02-04T00:00:00.000Z')`;
          yield* sql`INSERT INTO recruitment_interview_conducts(interview_id,answers,explanatory_power,role_model,suitability,finalized_by_person_id,finalized_at,interview_revision,recommendation) VALUES('outcome-interview','[]'::jsonb,7,8,9,${recruiter},'2026-02-10T11:00:00.000Z',2,'Kanskje')`;
        }),
      );
    }),
  ),
);

layer(suiteSeed.pipe(Layer.provideMerge(suiteLayer)), {
  excludeTestServices: true,
  timeout: "30 seconds",
})("admission outcome commands in the caller transaction", (it) => {
  it.effect("checks the fresh entry before any write and preserves the callback failure", () =>
    Effect.gen(function* () {
      const result = yield* observeRolledBack(
        Effect.gen(function* () {
          const admissions = yield* Admissions;
          const before = yield* readEntry;

          const failure = yield* Effect.flip(
            admissions.decideAdmissionOutcome(
              { applicationId, command: { outcome: "Admitted" }, actor: recruiter, now },
              (current) => Effect.fail({ code: "precondition.failed", current }),
            ),
          );

          return { before, failure, after: yield* readEntry };
        }),
      );

      expect(result.failure).toEqual({ code: "precondition.failed", current: result.before });
      expect(result.after).toEqual(result.before);
      expect(result.after).toMatchObject({
        basis: "Kanskje",
        state: "ApplicationSubmitted",
        outcome: null,
        placed: false,
        revision: 0,
      });
    }),
  );

  it.effect("leaves no outcome when the caller cannot finish its receipt", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Database.use((sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* decide("Admitted");

              return yield* Effect.fail("receipt-write-failed");
            }),
          ),
        ),
      );

      expect(failure).toBe("receipt-write-failed");
      expect(yield* readEntry).toMatchObject({ outcome: null, revision: 0 });
    }),
  );

  it.effect(
    "appends one decision per change, ignores a repeated outcome, and refuses history edits",
    () =>
      Effect.gen(function* () {
        const result = yield* observeRolledBack(
          Effect.gen(function* () {
            const admitted = yield* decide("Admitted");
            const repeated = yield* decide("Admitted", "2026-06-02T10:00:00.000Z");
            const rejected = yield* decide("Rejected", "2026-06-03T10:00:00.000Z");
            const board = yield* Admissions.use((service) => service.readAdmissionOutcomes(scope));

            const history = yield* Database.use(
              (sql) => sql`SELECT revision, outcome, decided_by_person_id AS "decidedBy", provenance
          FROM admission_application_outcomes WHERE application_id=${applicationId} ORDER BY revision`,
            );

            const rewrite = yield* Effect.flip(
              Database.use(
                (sql) =>
                  sql`UPDATE admission_application_outcomes SET outcome='Rejected' WHERE application_id=${applicationId}`,
              ),
            );

            return {
              admitted,
              repeated,
              rejected,
              board,
              history,
              rewrite: String(
                Predicate.hasProperty(rewrite.cause, "cause") ? rewrite.cause.cause : rewrite.cause,
              ),
            };
          }),
        );

        expect(result.admitted).toMatchObject({
          outcome: "Admitted",
          state: "ApplicationSubmitted",
          revision: 1,
          yearOfStudy: 2,
        });
        expect(result.repeated).toEqual(result.admitted);
        expect(result.rejected).toMatchObject({ outcome: "Rejected", revision: 2 });
        expect(result.board).toEqual({
          admissionPeriodId: "outcome-period",
          entries: [result.rejected],
        });
        expect(result.history).toEqual([
          { revision: 1, outcome: "Admitted", decidedBy: recruiter, provenance: "Decision" },
          { revision: 2, outcome: "Rejected", decidedBy: recruiter, provenance: "Decision" },
        ]);
        expect(result.rewrite).toContain("append-only");
        expect(yield* readEntry).toMatchObject({ outcome: null, revision: 0 });
      }),
  );

  it.effect("refuses to announce before Rekruttering decided a Kanskje application", () =>
    Effect.gen(function* () {
      const observed = yield* observeRolledBack(
        Effect.gen(function* () {
          const refusal = yield* Effect.flip(announce);

          return {
            code: refusal instanceof AdmissionOutcomeFailure ? refusal.code : null,
            announcements: yield* announcementRows,
            envelopes: yield* envelopeRows,
          };
        }),
      );

      expect(observed).toEqual({
        code: "admission-outcome.undecided",
        announcements: [],
        envelopes: 0,
      });
    }),
  );

  it.effect("announces the decision once, with one terminal revision and one envelope", () =>
    Effect.gen(function* () {
      const observed = yield* observeRolledBack(
        Effect.gen(function* () {
          yield* decide("Admitted");
          const announced = yield* announce;

          const again = yield* Effect.flip(announce);
          const lateDecision = yield* Effect.flip(decide("Rejected", "2026-06-04T10:00:00.000Z"));

          const history = yield* Database.use(
            (sql) => sql`SELECT revision, outcome FROM admission_application_outcomes
              WHERE application_id=${applicationId} ORDER BY revision`,
          );

          return {
            announced,
            again: again instanceof AdmissionOutcomeFailure ? again.code : null,
            lateDecision:
              lateDecision instanceof AdmissionOutcomeFailure ? lateDecision.code : null,
            history,
            announcements: yield* announcementRows,
            envelopes: yield* envelopeRows,
          };
        }),
      );

      expect(observed.announced).toMatchObject({
        state: "OutcomeAnnounced",
        outcome: "Admitted",
        revision: 2,
      });
      expect(observed.again).toBe("admission-outcome.final");
      expect(observed.lateDecision).toBe("admission-outcome.final");
      // The decision is the final revision; the announcement adds no outcome row for Kanskje.
      expect(observed.history).toEqual([{ revision: 1, outcome: "Admitted" }]);
      expect(observed.announcements).toEqual([{ outcome: "Admitted", outcomeRevision: 1 }]);
      expect(observed.envelopes).toBe(1);
    }),
  );

  it.effect("refuses to rewrite or delete a terminal announcement", () =>
    Effect.gen(function* () {
      const observed = yield* observeRolledBack(
        Effect.gen(function* () {
          yield* decide("Admitted");
          yield* announce;

          const update = yield* Effect.flip(
            Database.use(
              (sql) =>
                sql`UPDATE public.admission_outcome_announcements SET outcome='Rejected' WHERE application_id=${applicationId}`,
            ),
          );

          return String(
            Predicate.hasProperty(update.cause, "cause") ? update.cause.cause : update.cause,
          );
        }),
      );

      expect(observed).toContain("final");
    }),
  );
});

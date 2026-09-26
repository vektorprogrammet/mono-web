import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect, Exit, Layer, ManagedRuntime, Predicate } from "effect";
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { DepartmentId, PersonId, SemesterId } from "@vektorprogrammet/domain/organization";
import { Admissions, type AdmissionOutcome } from "@vektorprogrammet/domain/admissions";
import { Database } from "../service.js";
import { DatabaseTestLive } from "../test-support/platform.js";
import { AdmissionsLive } from "./index.js";

const database = DatabaseTestLive();

const runtime = ManagedRuntime.make(
  Layer.merge(database, AdmissionsLive.pipe(Layer.provide(database))),
);

afterAll(() => runtime.dispose());

const scope = {
  departmentId: DepartmentId.make("outcome-department"),
  semesterId: SemesterId.make("outcome-semester"),
};

const applicationId = PublicApplicationIdSchema.make("outcome-application");

const recruiter = PersonId.make("outcome-recruiter");

const record = (outcome: AdmissionOutcome, now = "2026-06-01T10:00:00.000Z") =>
  Admissions.use((service) =>
    service.recordAdmissionOutcome(
      { applicationId, command: { outcome }, actor: recruiter, now },
      () => Effect.void,
    ),
  );

const readEntry = Admissions.use((service) => service.readAdmissionOutcome(applicationId));

/** The history is append-only, so a case observes its writes inside a transaction it rolls back. */
const observeRolledBack = async <A, E>(effect: Effect.Effect<A, E, Admissions | Database>) => {
  let observed: { readonly value: A } | undefined;

  const exit = await runtime.runPromiseExit(
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
};

beforeAll(() =>
  runtime.runPromise(
    Database.use((sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO admission_period_departments(department_id,name) VALUES(${scope.departmentId},'Outcomes')`;
        yield* sql`INSERT INTO organization_departments(department_id,name,short_name,email,city) VALUES(${scope.departmentId},'Outcomes','OUT','outcomes@example.invalid','Trondheim')`;
        yield* sql`INSERT INTO admission_period_semesters(semester_id,start_at,end_at) VALUES(${scope.semesterId},'2026-01-01','2027-01-01')`;
        yield* sql`INSERT INTO admission_periods(admission_period_id,department_id,semester_id,start_at,end_at,last_command_id) VALUES('outcome-period',${scope.departmentId},${scope.semesterId},'2026-01-01','2027-01-01','seed')`;
        yield* sql`INSERT INTO admission_period_fields_of_study(field_of_study_id,department_id,name) VALUES('outcome-field',${scope.departmentId},'Math')`;
        yield* sql`INSERT INTO admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study) VALUES('outcome-applicant','candidate@example.invalid','candidate@example.invalid','Ada','Candidate','12345678',0,'outcome-field',2)`;
        yield* sql`INSERT INTO admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at) VALUES(${applicationId},'outcome-applicant','outcome-period',${scope.departmentId},'outcome-field',2,'2026-02-01')`;
        yield* sql`INSERT INTO person_profiles(person_id,first_name,last_name) VALUES(${recruiter},'Rita','Recruiter')`;
      }),
    ),
  ),
);

describe("admission outcome commands in the caller transaction", () => {
  it("checks the fresh entry before any write and preserves the callback failure", async () => {
    const result = await observeRolledBack(
      Effect.gen(function* () {
        const admissions = yield* Admissions;
        const before = yield* readEntry;

        const failure = yield* Effect.flip(
          admissions.recordAdmissionOutcome(
            {
              applicationId,
              command: { outcome: "Substitute" },
              actor: recruiter,
              now: "2026-06-01T10:00:00.000Z",
            },
            (current) => Effect.fail({ code: "precondition.failed", current }),
          ),
        );

        return { before, failure, after: yield* readEntry };
      }),
    );

    expect(result.failure).toEqual({ code: "precondition.failed", current: result.before });
    expect(result.after).toEqual(result.before);
    expect(result.after).toMatchObject({ outcome: null, revision: 0 });
  });

  it("leaves no outcome when the caller cannot finish its receipt", async () => {
    const failure = await runtime.runPromise(
      Effect.flip(
        Database.use((sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* record("Substitute");

              return yield* Effect.fail("receipt-write-failed");
            }),
          ),
        ),
      ),
    );

    expect(failure).toBe("receipt-write-failed");
    expect(await runtime.runPromise(readEntry)).toMatchObject({ outcome: null, revision: 0 });
  });

  it("appends one revision per change, ignores a repeated outcome, and refuses history edits", async () => {
    const result = await observeRolledBack(
      Effect.gen(function* () {
        const substitute = yield* record("Substitute");
        const repeated = yield* record("Substitute", "2026-06-02T10:00:00.000Z");
        const admitted = yield* record("Admitted", "2026-06-03T10:00:00.000Z");
        const board = yield* Admissions.use((service) => service.readAdmissionOutcomes(scope));

        const history = yield* Database.use(
          (sql) => sql`SELECT revision, outcome, decided_by_person_id AS "decidedBy"
            FROM admission_application_outcomes WHERE application_id=${applicationId} ORDER BY revision`,
        );

        const rewrite = yield* Effect.flip(
          Database.use(
            (sql) =>
              sql`UPDATE admission_application_outcomes SET outcome='Rejected' WHERE application_id=${applicationId}`,
          ),
        );

        return {
          substitute,
          repeated,
          admitted,
          board,
          history,
          rewrite: String(
            Predicate.hasProperty(rewrite.cause, "cause") ? rewrite.cause.cause : rewrite.cause,
          ),
        };
      }),
    );

    expect(result.substitute).toMatchObject({ outcome: "Substitute", revision: 1, yearOfStudy: 2 });
    expect(result.repeated).toEqual(result.substitute);
    expect(result.admitted).toMatchObject({ outcome: "Admitted", revision: 2 });
    expect(result.board).toEqual({
      admissionPeriodId: "outcome-period",
      entries: [result.admitted],
    });
    expect(result.history).toEqual([
      { revision: 1, outcome: "Substitute", decidedBy: recruiter },
      { revision: 2, outcome: "Admitted", decidedBy: recruiter },
    ]);
    expect(result.rewrite).toContain("append-only");
    expect(await runtime.runPromise(readEntry)).toMatchObject({ outcome: null, revision: 0 });
  });
});

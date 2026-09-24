import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { DepartmentId, SemesterId } from "@vektorprogrammet/domain/organization";
import { Substitutes, type SubstituteCommand } from "@vektorprogrammet/domain/substitutes";
import { Database } from "../service.js";
import { DatabaseTest } from "../layers.js";
import { SubstitutesLive } from "./index.js";

const database = DatabaseTest();

const runtime = ManagedRuntime.make(
  Layer.merge(database, SubstitutesLive.pipe(Layer.provide(database))),
);

afterAll(() => runtime.dispose());

const scope = {
  departmentId: DepartmentId.make("substitutes-department"),
  semesterId: SemesterId.make("substitutes-semester"),
};

const applicationId = PublicApplicationIdSchema.make("substitutes-application");

const input = {
  monday: true,
  tuesday: false,
  wednesday: false,
  thursday: false,
  friday: false,
  language: "Norwegian" as const,
  yearOfStudy: 3,
};

const command = (value: SubstituteCommand) =>
  Substitutes.use((service) => service.execute(applicationId, value, () => Effect.void));

beforeAll(() =>
  runtime.runPromise(
    Database.use((sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO admission_period_departments(department_id,name) VALUES(${scope.departmentId},'Substitutes')`;
        yield* sql`INSERT INTO organization_departments(department_id,name,short_name,email,city) VALUES(${scope.departmentId},'Substitutes','SUB','substitutes@example.invalid','Trondheim')`;
        yield* sql`INSERT INTO admission_period_semesters(semester_id,start_at,end_at) VALUES(${scope.semesterId},'2026-01-01','2027-01-01')`;
        yield* sql`INSERT INTO admission_periods(admission_period_id,department_id,semester_id,start_at,end_at,last_command_id) VALUES('substitutes-period',${scope.departmentId},${scope.semesterId},'2026-01-01','2027-01-01','seed')`;
        yield* sql`INSERT INTO admission_period_fields_of_study(field_of_study_id,department_id,name) VALUES('substitutes-field',${scope.departmentId},'Math')`;
        yield* sql`INSERT INTO admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study) VALUES('substitutes-applicant','candidate@example.invalid','candidate@example.invalid','Ada','Candidate','12345678',0,'substitutes-field',2)`;
        yield* sql`INSERT INTO admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at) VALUES(${applicationId},'substitutes-applicant','substitutes-period',${scope.departmentId},'substitutes-field',2,'2026-02-01')`;
      }),
    ),
  ),
);

beforeEach(() =>
  runtime.runPromise(
    Database.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM admission_substitute_preferences WHERE application_id=${applicationId}`;
          yield* sql`UPDATE admission_applications SET year_of_study=2,revision=0 WHERE application_id=${applicationId}`;
          yield* command({ action: "activate", input });
        }),
      ),
    ),
  ),
);

describe("complete substitute commands in the caller transaction", () => {
  it("checks the fresh canonical entry before any mutation and preserves callback failure", async () => {
    const result = await runtime.runPromise(
      Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const substitutes = yield* Substitutes;
            const before = yield* substitutes.readEntry(applicationId);

            const failure = yield* Effect.flip(
              substitutes.execute(
                applicationId,
                { action: "edit", input: { ...input, yearOfStudy: 5 } },
                (current) => Effect.fail({ code: "precondition.failed", current }),
              ),
            );

            return { before, failure, after: yield* substitutes.readEntry(applicationId) };
          }),
        ),
      ),
    );

    expect(result.failure).toEqual({ code: "precondition.failed", current: result.before });
    expect(result.after).toEqual(result.before);
    expect(result.after).toMatchObject({ active: true, revision: 1, yearOfStudy: 3 });
  });

  it("rolls preferences and canonical application year back when the caller receipt fails", async () => {
    const before = await runtime.runPromise(
      Substitutes.use((service) => service.readEntry(applicationId)),
    );

    const failure = await runtime.runPromise(
      Effect.flip(
        Database.use((sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* command({
                action: "edit",
                input: { ...input, yearOfStudy: 5, tuesday: true },
              });

              return yield* Effect.fail("receipt-write-failed");
            }),
          ),
        ),
      ),
    );

    expect(failure).toBe("receipt-write-failed");
    expect(
      await runtime.runPromise(Substitutes.use((service) => service.readEntry(applicationId))),
    ).toEqual(before);
  });

  it("retains preferences on deactivation and rejects illegal transitions without changing the applicant profile", async () => {
    const result = await runtime.runPromise(
      Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const alreadyActive = yield* Effect.flip(command({ action: "activate", input }));

            const edited = yield* command({
              action: "edit",
              input: { ...input, yearOfStudy: 4, tuesday: true },
            });

            const inactive = yield* command({ action: "deactivate" });
            const rejected = yield* Effect.flip(command({ action: "edit", input }));
            const pool = yield* Substitutes.use((service) => service.readPool(scope));

            const applicants =
              yield* sql`SELECT year_of_study FROM admission_applicants WHERE applicant_id='substitutes-applicant'`;

            return { alreadyActive, edited, inactive, rejected, pool, applicants };
          }),
        ),
      ),
    );

    expect(result.alreadyActive).toMatchObject({ code: "substitute.already-active", status: 400 });
    expect(result.edited).toMatchObject({ active: true, yearOfStudy: 4, revision: 2 });
    expect(result.inactive).toMatchObject({ active: false, yearOfStudy: 4, revision: 3 });
    expect(result.inactive.preferences).toEqual(result.edited.preferences);
    expect(result.rejected).toMatchObject({ code: "substitute.inactive", status: 400 });
    expect(result.pool.entries).toEqual([result.inactive]);
    expect(result.applicants).toEqual([{ year_of_study: 2 }]);
  });
});

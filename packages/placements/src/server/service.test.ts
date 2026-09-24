import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Database } from "@vektorprogrammet/database";
import { DatabaseTest } from "@vektorprogrammet/database/live";
import { DepartmentId, PersonId, SemesterId } from "@vektorprogrammet/domain/organization";
import { SchoolId } from "@vektorprogrammet/domain/schools";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Placements, type PlacementMutation } from "../contracts.js";
import { PlacementsLive } from "./service.js";

const databaseLayer = DatabaseTest();

const runtime = ManagedRuntime.make(
  Layer.merge(databaseLayer, PlacementsLive.pipe(Layer.provide(databaseLayer))),
);

afterAll(() => runtime.dispose());

const now = "2026-09-06T00:00:00.000Z";

const scope = {
  departmentId: DepartmentId.make("command-department"),
  semesterId: SemesterId.make("command-semester"),
};

const personId = PersonId.make("command-volunteer");

const command = (mutation: PlacementMutation, commandId = "a".repeat(64)) =>
  Placements.use((placements) =>
    placements.execute({ mutation, actor: personId, now, commandId }, () => Effect.void),
  );

const seed = Database.use((sql) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO organization_departments(department_id,name,short_name,email,city) VALUES(${scope.departmentId},'Command department','CMD','command@example.invalid','Trondheim')`;
    yield* sql`INSERT INTO admission_period_semesters(semester_id,start_at,end_at) VALUES(${scope.semesterId},'2026-08-01T00:00:00Z','2026-12-31T00:00:00Z')`;
    yield* sql`INSERT INTO person_profiles(person_id,first_name,last_name) VALUES(${personId},'Command','Volunteer')`;
  }),
);

beforeAll(() => runtime.runPromise(seed));

describe("complete placement commands on the caller transaction", () => {
  it("checks the current affiliation before writing, and does not audit a rejected precondition", async () => {
    const result = await runtime.runPromise(
      Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const placements = yield* Placements;

            const requested = yield* placements.execute(
              {
                mutation: { mode: "affiliation", scope, command: { action: "Request" } },
                actor: personId,
                now,
                commandId: "b".repeat(64),
              },
              (current) =>
                "status" in current && current.status === "Absent" && current.revision === 0
                  ? Effect.void
                  : Effect.fail("wrong-initial-affiliation"),
            );

            const rejected = yield* Effect.flip(
              placements.execute(
                {
                  mutation: { mode: "affiliation", scope, command: { action: "Withdraw" } },
                  actor: personId,
                  now,
                  commandId: "c".repeat(64),
                },
                (current) => Effect.fail({ code: "precondition.failed", current }),
              ),
            );

            const current = yield* placements.readOwnAffiliation(personId, scope.departmentId);

            const audits =
              yield* sql`SELECT revision,action FROM organization_volunteer_affiliation_audit WHERE person_id=${personId} ORDER BY revision`;

            return { requested, rejected, current, audits };
          }),
        ),
      ),
    );

    expect(result.requested).toMatchObject({ status: "Pending", revision: 1 });
    expect(result.rejected).toMatchObject({
      code: "precondition.failed",
      current: { status: "Pending", revision: 1 },
    });
    expect(result.current).toMatchObject({ status: "Pending", revision: 1 });
    expect(result.audits).toEqual([{ revision: 1, action: "Request" }]);
  });

  it("rolls business facts, audit, and notifications back when the caller cannot finish its receipt", async () => {
    const scope = {
      departmentId: DepartmentId.make("rollback-department"),
      semesterId: SemesterId.make("command-semester"),
    };

    const schoolId = await runtime.runPromise(
      Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO organization_departments(department_id,name,short_name,email,city) VALUES(${scope.departmentId},'Rollback department','RBK','rollback@example.invalid','Trondheim')`;
            yield* command({ mode: "affiliation", scope, command: { action: "Request" } });

            const rows = yield* sql<{
              schoolId: number;
            }>`INSERT INTO schools_directory_schools(name,contact_person,email,phone,language,active) VALUES('Command school','Contact','school@example.invalid','12345678','Norwegian',true) RETURNING school_id::double precision AS "schoolId"`;

            const id = SchoolId.make(rows[0]!.schoolId);
            yield* sql`INSERT INTO schools_directory_departments(school_id,department_id) VALUES(${id},${scope.departmentId})`;
            yield* command({
              mode: "board",
              scope,
              command: { action: "Affiliation", personId, transition: "Establish" },
            });
            yield* command({
              mode: "board",
              scope,
              command: {
                action: "Create",
                personId,
                schoolId: id,
                day: "Monday",
                block: "1",
                workdays: 4,
              },
            });
            yield* command({
              mode: "board",
              scope,
              command: {
                action: "SetDemand",
                schoolId: id,
                day: "Monday",
                block: "1",
                requiredVolunteers: 1,
              },
            });

            return id;
          }),
        ),
      ),
    );

    const failure = await runtime.runPromise(
      Effect.flip(
        Database.use((sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const proposal = yield* command(
                { mode: "board", scope, command: { action: "GenerateProposal" } },
                "d".repeat(64),
              );

              if (!("proposal" in proposal) || proposal.proposal === null)
                return yield* Effect.fail("proposal-missing");
              yield* command({
                mode: "board",
                scope,
                command: {
                  action: "ConfirmProposal",
                  proposalId: proposal.proposal.proposalId,
                  reviewedExceptionIds: [],
                },
              });

              return yield* Effect.fail("receipt-write-failed");
            }),
          ),
        ),
      ),
    );

    expect(failure).toBe("receipt-write-failed");

    const observed = await runtime.runPromise(
      Database.use((sql) =>
        Effect.gen(function* () {
          const board = yield* Placements.use((placements) => placements.readBoard(scope));

          const audits =
            yield* sql`SELECT action FROM school_service_audit WHERE department_id=${scope.departmentId} ORDER BY action`;

          const notifications =
            yield* sql`SELECT effect_id FROM school_service_notification_outbox WHERE proposal_id=${`school-service-proposal-${"d".repeat(64)}`}`;

          return { board, audits, notifications };
        }),
      ),
    );

    expect(observed.board.placements).toMatchObject([
      { placementId: `placement-${"a".repeat(64)}`, schoolId, active: true },
    ]);
    expect(observed.board.proposal).toBeNull();
    expect(observed.audits).toEqual([{ action: "SetDemand" }]);
    expect(observed.notifications).toEqual([]);
  });
});

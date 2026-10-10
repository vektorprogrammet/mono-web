import { expect, layer } from "@effect/vitest";
import {
  AdmissionPeriodActorSchema,
  AdmissionPeriodCommandId,
  AdmissionPeriodCommandSchema,
  AdmissionPeriodId,
  admissionPeriodCommandDigest,
} from "@vektorprogrammet/domain/admission-period";
import { DepartmentId, PersonId, SemesterId } from "@vektorprogrammet/domain/organization";
import { Effect } from "effect";
import { Database } from "../service.js";
import { DatabaseTestLive } from "../test-support/platform.js";
import { executeAdmissionPeriodCommand } from "./postgres.js";

/**
 * One fixture per case: the cases share the suite's database, so each owns its ids.
 * The administrator is global, so the commands name their department.
 */
const fixture = (id: string) => {
  const departmentId = DepartmentId.make(`${id}-department`);
  const semesterId = SemesterId.make(`${id}-semester`);
  const admissionPeriodId = AdmissionPeriodId.make(`${id}-period`);

  const actor = AdmissionPeriodActorSchema.cases.GlobalAdmin.make({
    personId: PersonId.make(`${id}-admin`),
    active: true,
  });

  const context = { actor, now: "2035-01-15T00:00:00.000Z", admissionPeriodId };

  const create = AdmissionPeriodCommandSchema.cases.CreateAdmissionPeriod.make({
    commandId: AdmissionPeriodCommandId.make(`${id}-create`),
    departmentId,
    semesterId,
    startAt: "2035-02-01T00:00:00.000Z",
    endAt: "2035-03-01T00:00:00.000Z",
  });

  const revise = AdmissionPeriodCommandSchema.cases.ReviseAdmissionPeriod.make({
    commandId: AdmissionPeriodCommandId.make(`${id}-revise`),
    admissionPeriodId,
    expectedRevision: 0,
    startAt: "2035-02-01T00:00:00.000Z",
    endAt: "2035-03-15T00:00:00.000Z",
  });

  const seed = Database.use((sql) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO admission_period_departments (department_id, name) VALUES (${departmentId}, 'Persistence')`;
      yield* sql`
        INSERT INTO admission_period_semesters (semester_id, start_at, end_at)
        VALUES (${semesterId}, '2035-01-01T00:00:00.000Z', '2035-07-01T00:00:00.000Z')
      `;
    }),
  );

  /** The rows that one period's commands leave behind. */
  const persisted = Database.use((sql) =>
    Effect.all({
      periods: sql<{
        readonly id: string;
        readonly revision: number;
        readonly lastCommandId: string;
        readonly startAt: string;
        readonly endAt: string;
      }>`
        SELECT admission_period_id AS id, revision, last_command_id AS "lastCommandId",
          to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
          to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endAt"
        FROM admission_periods
        WHERE admission_period_id = ${admissionPeriodId}
      `,
      receipts: sql<{
        readonly commandId: string;
        readonly commandSha256: string;
        readonly observation: string;
      }>`
        SELECT command_id AS "commandId", command_sha256 AS "commandSha256",
          observation_json ->> '_tag' AS observation
        FROM admission_period_command_receipts
        WHERE admission_period_id = ${admissionPeriodId}
        ORDER BY command_id
      `,
      audits: sql<{
        readonly commandId: string;
        readonly actorPersonId: string;
        readonly action: string;
        readonly revision: number;
      }>`
        SELECT command_id AS "commandId", actor_person_id AS "actorPersonId", action,
          admission_period_revision AS revision
        FROM admission_period_audit
        WHERE admission_period_id = ${admissionPeriodId}
        ORDER BY admission_period_revision
      `,
    }),
  );

  return { admissionPeriodId, actor, context, create, revise, seed, persisted };
};

layer(DatabaseTestLive(), { excludeTestServices: true, timeout: "30 seconds" })(
  "admission period command persistence",
  (it) => {
    it.effect(
      "persists the period, one command receipt, and one audit row per command, and replays each command exactly",
      () =>
        Effect.gen(function* () {
          const { actor, context, create, revise, seed, persisted, admissionPeriodId } =
            fixture("persists");

          yield* seed;

          const created = yield* executeAdmissionPeriodCommand(create, context);
          const afterCreate = yield* persisted;

          expect(created.replayed).toBe(false);
          expect(created.observation._tag).toBe("Created");
          expect(afterCreate).toEqual({
            periods: [
              {
                id: admissionPeriodId,
                revision: 0,
                lastCommandId: create.commandId,
                startAt: "2035-02-01T00:00:00.000Z",
                endAt: "2035-03-01T00:00:00.000Z",
              },
            ],
            receipts: [
              {
                commandId: create.commandId,
                commandSha256: admissionPeriodCommandDigest(create),
                observation: "Created",
              },
            ],
            audits: [
              {
                commandId: create.commandId,
                actorPersonId: actor.personId,
                action: "AdmissionPeriodCreated",
                revision: 0,
              },
            ],
          });

          const revised = yield* executeAdmissionPeriodCommand(revise, {
            ...context,
            now: "2035-01-16T00:00:00.000Z",
          });

          const afterRevise = yield* persisted;

          expect(revised.replayed).toBe(false);
          expect(revised.observation._tag).toBe("Revised");
          expect(afterRevise).toEqual({
            periods: [
              {
                id: admissionPeriodId,
                revision: 1,
                lastCommandId: revise.commandId,
                startAt: "2035-02-01T00:00:00.000Z",
                endAt: "2035-03-15T00:00:00.000Z",
              },
            ],
            receipts: [
              afterCreate.receipts[0],
              {
                commandId: revise.commandId,
                commandSha256: admissionPeriodCommandDigest(revise),
                observation: "Revised",
              },
            ],
            audits: [
              afterCreate.audits[0],
              {
                commandId: revise.commandId,
                actorPersonId: actor.personId,
                action: "AdmissionPeriodRevised",
                revision: 1,
              },
            ],
          });

          const replayedCreate = yield* executeAdmissionPeriodCommand(create, {
            ...context,
            now: "2035-01-17T00:00:00.000Z",
          });

          const replayedRevise = yield* executeAdmissionPeriodCommand(revise, {
            ...context,
            now: "2035-01-17T00:00:00.000Z",
          });

          expect([replayedCreate.replayed, replayedRevise.replayed]).toEqual([true, true]);
          expect(replayedCreate.observation).toHaveProperty("_tag", "Replayed");
          expect(replayedCreate.observation).toHaveProperty("commandId", create.commandId);
          expect(replayedCreate.observation).toHaveProperty("original", created.observation);
          expect(replayedRevise.observation).toHaveProperty("_tag", "Replayed");
          expect(replayedRevise.observation).toHaveProperty("commandId", revise.commandId);
          expect(replayedRevise.observation).toHaveProperty("original", revised.observation);
          expect(replayedRevise.period).toEqual(revised.period);
          // An exact replay writes no second period revision, receipt, or audit row.
          expect(yield* persisted).toEqual(afterRevise);
        }),
    );

    it.effect(
      "refuses a reused command id with another payload and a stale revision without writing",
      () =>
        Effect.gen(function* () {
          const { context, create, revise, seed, persisted, admissionPeriodId } =
            fixture("refuses");

          yield* seed;
          yield* executeAdmissionPeriodCommand(create, context);

          const before = yield* persisted;

          const conflict = yield* Effect.flip(
            executeAdmissionPeriodCommand(
              { ...create, endAt: "2035-03-02T00:00:00.000Z" },
              context,
            ),
          );

          expect(conflict).toHaveProperty("_tag", "DuplicateAdmissionPeriodCommandConflict");
          expect(conflict).toHaveProperty("commandId", create.commandId);

          const stale = yield* Effect.flip(
            executeAdmissionPeriodCommand({ ...revise, expectedRevision: 5 }, context),
          );

          expect(stale).toHaveProperty("_tag", "StaleAdmissionPeriodRevision");
          expect(stale).toHaveProperty("admissionPeriodId", admissionPeriodId);
          expect(stale).toHaveProperty("expected", 5);
          expect(stale).toHaveProperty("actual", 0);
          expect(yield* persisted).toEqual(before);
        }),
    );
  },
);

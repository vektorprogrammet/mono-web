import { afterAll, describe, expect, it } from "vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  ApplicantIdSchema,
  PublicApplicationIdSchema,
  type PublicApplicationOutboxRequest,
} from "@vektorprogrammet/domain/application";
import { Database } from "@vektorprogrammet/database";
import { DatabaseTestLive } from "@vektorprogrammet/database/test-support/platform";
import { executePublicApplicationCommand } from "@vektorprogrammet/database/application";
import { makeControlledTestRuntime } from "../../packages/database/test/runtime.js";
import { runPublicApplicationOutboxWorker } from "@vektorprogrammet/backend/application/worker";
import { journeyClock } from "../e2e/journey-clock.js";

const runtime = makeControlledTestRuntime(DatabaseTestLive());

afterAll(() => runtime.dispose());

// The command's clock. The semester and the admission period are open around it, and the worker
// runs one minute later; an offset of -721 minutes lands on midnight UTC.
const commandClock = journeyClock("2031-09-15T12:01:00.000Z");

const outboxReferenceFixture = Effect.gen(function* () {
  const database = yield* Database;
  yield* database.unsafe(
    "INSERT INTO admission_period_departments (department_id, name) VALUES ('outbox-department', 'Outbox Department')",
  );
  yield* database.unsafe(`
    INSERT INTO admission_period_semesters (semester_id, start_at, end_at)
    VALUES (
      'outbox-semester',
      '${commandClock.fromNow(-45, -721)}',
      '${commandClock.fromNow(107, -721)}'
    )
  `);
  yield* database.unsafe(`
    INSERT INTO admission_period_fields_of_study (
      field_of_study_id, department_id, name, active
    ) VALUES (
      'outbox-field',
      'outbox-department',
      'Outbox Field',
      TRUE
    )
  `);
  yield* database.unsafe(`
    INSERT INTO admission_periods (
      admission_period_id, department_id, semester_id, start_at, end_at,
      revision, last_command_id
    ) VALUES (
      'outbox-period',
      'outbox-department',
      'outbox-semester',
      '${commandClock.fromNow(-14, -721)}',
      '${commandClock.fromNow(16, -721)}',
      0,
      'outbox-period-seed'
    )
  `);
});

describe("public application delivery worker", () => {
  it("releases an interrupted applicant worker claim before shutdown", async () => {
    let starts = 0;
    let stops = 0;

    const evidence = await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const database = yield* Database;
          yield* outboxReferenceFixture;
          yield* executePublicApplicationCommand(
            {
              commandId: "worker-application-submit",
              departmentId: "outbox-department",
              firstName: "Grace",
              lastName: "Hopper",
              phone: "+47 87654321",
              email: "grace.worker@example.invalid",
              gender: 0,
              fieldOfStudyId: "outbox-field",
              yearOfStudy: 4,
              availability: {
                mondayUnavailable: false,
                tuesdayUnavailable: true,
                wednesdayUnavailable: false,
                thursdayUnavailable: false,
                fridayUnavailable: false,
                positionWeeks: 4,
                preferredGroup: "all",
                language: "Norsk",
              },
            },
            {
              now: commandClock.now,
              applicantId: ApplicantIdSchema.make("worker-applicant"),
              applicationId: PublicApplicationIdSchema.make("worker-application"),
              activationToken: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
            },
          );
          yield* database`
            UPDATE admission_application_outbox
            SET status = 'Processing',
              claim_id = 'stale-worker-claim',
              claimed_at = '2031-09-15T10:00:00.000Z'
            WHERE command_id = 'worker-application-submit' AND ordinal = 0
          `;
          const deliveryStarted = yield* Deferred.make<void>();

          const interpreter = {
            deliver: (
              request: PublicApplicationOutboxRequest,
              ordinal: number,
              attempts: number,
            ) =>
              request.commandId === "worker-application-submit"
                ? Deferred.succeed(deliveryStarted, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed({
                    effectId: request.effectId,
                    kind: request._tag,
                    ordinal,
                    attempts,
                    status: "Delivered" as const,
                  }),
          };

          const fiber = yield* Effect.forkScoped(
            TestClock.setTime(Date.parse(commandClock.fromNow(0, 1))).pipe(
              Effect.andThen(
                runPublicApplicationOutboxWorker(interpreter, {
                  workerId: "database-test-worker",
                  pollIntervalMilliseconds: 5,
                  staleClaimMilliseconds: 60_000,
                  onStart: () => {
                    starts += 1;
                  },
                  onStop: () => {
                    stops += 1;
                  },
                }),
              ),
              Effect.provide(TestClock.layer()),
            ),
          );

          yield* Deferred.await(deliveryStarted);

          const processing = yield* database<{
            readonly status: string;
            readonly claim_id: string | null;
          }>`
            SELECT status, claim_id
            FROM admission_application_outbox
            WHERE command_id = 'worker-application-submit' AND ordinal = 0
          `;

          yield* Fiber.interrupt(fiber);

          const released = yield* database<{
            readonly status: string;
            readonly claim_id: string | null;
            readonly last_failure_tag: string | null;
          }>`
            SELECT status, claim_id, last_failure_tag
            FROM admission_application_outbox
            WHERE command_id = 'worker-application-submit' AND ordinal = 0
          `;

          return { processing: processing[0], released: released[0] };
        }),
      ),
    );

    expect(evidence.processing?.status).toBe("Processing");
    expect(evidence.processing?.claim_id).toMatch(/^database-test-worker:/);
    expect(evidence.released).toEqual({
      status: "Pending",
      claim_id: null,
      last_failure_tag: "InterruptedPublicApplicationOutboxClaim",
    });
    expect({ starts, stops }).toEqual({ starts: 1, stops: 1 });
  });
});

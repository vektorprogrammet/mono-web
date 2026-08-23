import { afterAll, describe, expect, it } from "vitest";
import {
  deliverNextPublicApplicationOutbox,
  executePublicApplicationCommand,
  makeRecordingPublicApplicationEffectInterpreter,
  publicApplicationActivationDigest,
  runPublicApplicationOutboxWorker,
} from "@vektorprogrammet/domain/application";
import { Database } from "@vektorprogrammet/domain/database";
import { Economy } from "@vektorprogrammet/domain/receipt";
import { EconomyLive } from "@vektorprogrammet/domain/receipt/postgres";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { DatabaseTest } from "./layers.js";

const databaseLayer = DatabaseTest();
const runtime = ManagedRuntime.make(
  Layer.merge(databaseLayer, EconomyLive.pipe(Layer.provide(databaseLayer))),
);

afterAll(async () => {
  await runtime.dispose();
});

describe("DatabaseTest", () => {
  it("constructs the complete schema before it exposes the capability", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database.health;
        const migrations = yield* database<{
          readonly migration_id: number;
          readonly name: string;
        }>`
          SELECT migration_id, name
          FROM vektorprogrammet_schema_migrations
          ORDER BY migration_id
        `;
        const tables = yield* database<{ readonly table_name: string }>`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN (
              'economy_receipts',
              'admission_periods',
              'admission_applications'
            )
          ORDER BY table_name
        `;
        return {
          revision: database.schemaRevision,
          migrations,
          tables: tables.map((row) => row.table_name),
        };
      }),
    );

    expect(evidence).toEqual({
      revision: "4_receipt-authority-upgrade-replay",
      migrations: [
        { migration_id: 1, name: "receipt-authority" },
        { migration_id: 2, name: "admission-period-authority" },
        { migration_id: 3, name: "public-applicant-admission" },
        { migration_id: 4, name: "receipt-authority-upgrade-replay" },
      ],
      tables: ["admission_applications", "admission_periods", "economy_receipts"],
    });
  });

  it("reuses one capability and reruns the manifest without duplicate migrations", async () => {
    const first = await runtime.runPromise(Database);
    await runtime.runPromise(Database.use((database) => database.migrate));
    const second = await runtime.runPromise(Database);
    const rows = await runtime.runPromise(
      Database.use(
        (database) =>
          database<{ readonly migration_count: string }>`
          SELECT count(*)::text AS migration_count
          FROM vektorprogrammet_schema_migrations
        `,
      ),
    );

    expect(second).toBe(first);
    expect(rows).toEqual([{ migration_count: "4" }]);
  });

  it("runs the Economy authority contract against PGlite", async () => {
    const command = {
      _tag: "SubmitReceipt" as const,
      commandId: "pglite-command-submit",
      actor: {
        personId: "pglite-owner",
        departmentId: "pglite-department",
        active: true,
        approvalScope: { _tag: "None" as const },
      },
      departmentId: "pglite-department",
      paymentAccountCiphertext: "ciphertext:v1:pglite-account",
      description: "PGlite authority contract",
      amountOre: 12_345,
      receiptDate: "2026-08-23",
      file: {
        fileRef: "pglite-file",
        objectKey: "temporary/pglite-file",
        contentType: "application/pdf",
        byteLength: 256,
        sha256: "c".repeat(64),
      },
    };
    const context = {
      receiptId: "pglite-receipt",
      visualId: "PGLITE-0001",
      now: "2026-08-23T12:00:00.000Z",
    };
    const execute = Economy.use(({ executeReceipt }) => executeReceipt(command, context));

    const first = await runtime.runPromise(execute);
    const replay = await runtime.runPromise(execute);

    expect(first.observation.status).toBe("Pending");
    expect(first.observation.replayed).toBe(false);
    expect(first.replayed).toBe(false);
    expect(replay.observation).toEqual({ ...first.observation, replayed: true });
    expect(replay.replayed).toBe(true);
  });

  it("returns failed applicant effects to the durable retry queue", async () => {
    const interpreter = makeRecordingPublicApplicationEffectInterpreter();
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database.unsafe(
          "INSERT INTO admission_period_departments (department_id, name) VALUES ('outbox-department', 'Outbox Department')",
        );
        yield* database.unsafe(`
          INSERT INTO admission_period_semesters (semester_id, start_at, end_at)
          VALUES (
            'outbox-semester',
            '2031-08-01T00:00:00.000Z',
            '2031-12-31T00:00:00.000Z'
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
            '2031-09-01T00:00:00.000Z',
            '2031-10-01T00:00:00.000Z',
            0,
            'outbox-period-seed'
          )
        `);
        yield* executePublicApplicationCommand(
          {
            commandId: "outbox-application-submit",
            departmentId: "outbox-department",
            firstName: "Ada",
            lastName: "Lovelace",
            phone: "+47 12345678",
            email: "ada.outbox@example.invalid",
            gender: 1,
            fieldOfStudyId: "outbox-field",
            yearOfStudy: 3,
          },
          {
            now: "2031-09-15T12:00:00.000Z",
            applicantId: "outbox-applicant",
            applicationId: "outbox-application",
            activationToken: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
          },
        );
        const rows = yield* database<{
          readonly effect_id: string;
          readonly payload_json: unknown;
        }>`
          SELECT effect_id, payload_json
          FROM admission_application_outbox
          WHERE command_id = 'outbox-application-submit'
          ORDER BY ordinal
        `;
        const firstEffectId = rows[0]?.effect_id;
        if (firstEffectId === undefined) throw new Error("missing applicant outbox effect");
        const applicantRows = yield* database<{ readonly activation_digest: string | null }>`
          SELECT activation_digest
          FROM admission_applicants
          WHERE applicant_id = 'outbox-applicant'
        `;
        interpreter.failOnce(firstEffectId);
        const failed = yield* deliverNextPublicApplicationOutbox(
          "outbox-failed-claim",
          "2031-09-15T12:00:01.000Z",
          interpreter,
        );
        const failedRows = yield* database<{
          readonly status: string;
          readonly claim_id: string | null;
          readonly last_failure_tag: string | null;
        }>`
          SELECT status, claim_id, last_failure_tag
          FROM admission_application_outbox
          WHERE effect_id = ${firstEffectId}
        `;
        const retried = yield* deliverNextPublicApplicationOutbox(
          "outbox-retry-claim",
          "2031-09-15T12:00:02.000Z",
          interpreter,
        );
        const deliveredRows = yield* database<{ readonly payload_json: unknown }>`
          SELECT payload_json
          FROM admission_application_outbox
          WHERE effect_id = ${firstEffectId}
        `;
        return {
          activationPayload: rows[0]?.payload_json,
          applicantDigest: applicantRows[0]?.activation_digest,
          failed,
          failedRow: failedRows[0],
          retried,
          deliveredPayload: deliveredRows[0]?.payload_json,
        };
      }),
    );

    expect(evidence.activationPayload).toMatchObject({
      activationToken: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
    });
    expect(evidence.applicantDigest).toBe(
      publicApplicationActivationDigest("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"),
    );
    expect(evidence.failed).toMatchObject({
      _tag: "Failed",
      failureTag: "PublicApplicationEffectDeliveryError",
    });
    expect(evidence.failedRow).toEqual({
      status: "Failed",
      claim_id: null,
      last_failure_tag: "PublicApplicationEffectDeliveryError",
    });
    expect(evidence.retried).toMatchObject({ _tag: "Delivered" });
    expect(evidence.deliveredPayload).toEqual({});
  });

  it("releases an interrupted applicant worker claim before shutdown", async () => {
    let starts = 0;
    let stops = 0;
    const evidence = await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const database = yield* Database;
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
            },
            {
              now: "2031-09-15T12:01:00.000Z",
              applicantId: "worker-applicant",
              applicationId: "worker-application",
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
          const interpreter = {
            deliver: (
              request: {
                readonly commandId: string;
                readonly effectId: string;
                readonly _tag:
                  | "SendApplicantActivationOrConfirmation"
                  | "CreateAdmissionSubscription"
                  | "WriteApplicationAudit";
              },
              ordinal: number,
              attempts: number,
            ) =>
              request.commandId === "worker-application-submit"
                ? Effect.never
                : Effect.succeed({
                    effectId: request.effectId,
                    kind: request._tag,
                    ordinal,
                    attempts,
                    status: "Delivered" as const,
                  }),
          };
          const fiber = yield* Effect.forkScoped(
            runPublicApplicationOutboxWorker(interpreter, {
              workerId: "database-test-worker",
              pollIntervalMilliseconds: 5,
              staleClaimMilliseconds: 60_000,
              now: () => "2031-09-15T12:02:00.000Z",
              onStart: () => {
                starts += 1;
              },
              onStop: () => {
                stops += 1;
              },
            }),
          );
          yield* Effect.sleep("50 millis");
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

  it("acquires, migrates, and releases one shared database capability", async () => {
    let acquisitionCount = 0;
    let migrationCount = 0;
    let releaseCount = 0;
    const observedRuntime = ManagedRuntime.make(
      DatabaseTest(undefined, {
        onAcquire: () => {
          acquisitionCount += 1;
        },
        onMigration: () => {
          migrationCount += 1;
        },
        onRelease: () => {
          releaseCount += 1;
        },
      }),
    );

    try {
      await Promise.all(
        Array.from({ length: 32 }, () =>
          observedRuntime.runPromise(Database.use((database) => database.health)),
        ),
      );
      expect({ acquisitionCount, migrationCount, releaseCount }).toEqual({
        acquisitionCount: 1,
        migrationCount: 1,
        releaseCount: 0,
      });
    } finally {
      await observedRuntime.dispose();
    }

    expect(releaseCount).toBe(1);
  });
});

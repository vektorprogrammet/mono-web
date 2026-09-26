import { afterAll, describe, expect, it } from "vitest";
import { Database } from "./service.js";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { sha256Hex } from "@vektorprogrammet/domain/shared-kernel";
import {
  ReceiptId,
  ReceiptSettlementCommandRequestSchema,
  Economy,
} from "@vektorprogrammet/domain/receipt";
import { EconomyLive } from "@vektorprogrammet/database/receipt/postgres";
import { Predicate, Effect, Layer } from "effect";
import { DatabaseTestLive } from "./test-support/platform.js";
import { makeControlledTestRuntime } from "../test/runtime.js";

const databaseLayer = DatabaseTestLive();

const runtime = makeControlledTestRuntime(
  Layer.merge(databaseLayer, EconomyLive.pipe(Layer.provide(databaseLayer))),
);

const ownerPersonId = PersonId.make("settlement-test-owner");

const settlerPersonId = PersonId.make("settlement-test-settler");

const deniedPersonId = PersonId.make("settlement-test-denied");

const departmentId = DepartmentId.make("settlement-test-department");

const authorizationInstant = "2038-06-15T12:00:00.000Z";

const paymentDestination = "ciphertext:v1:settlement-test-destination";

const principal = (personId: PersonId) => ({ personId, authorizationInstant });

const command = (
  commandId: string,
  receiptId: string,
  expectedRevision: number,
  externalReference: string,
) =>
  ReceiptSettlementCommandRequestSchema.cases.RecordReceiptSettlement.make({
    commandId,
    receiptId: ReceiptId.make(receiptId),
    expectedRevision,
    externalAuthority: "settlement-test-bank",
    externalReference,
    settledAt: "2038-06-15T11:00:00.000Z",
  });

afterAll(async () => {
  await runtime.dispose();
});

describe("Receipt settlement evidence in PGlite", () => {
  it("records immutable evidence once with CAS, replay, reference, authority, and queue boundaries", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const economy = yield* Economy;

        yield* database`
          INSERT INTO public.person_profiles (person_id, first_name, last_name)
          VALUES
            (${ownerPersonId}, 'Settlement', 'Owner'),
            (${settlerPersonId}, 'Settlement', 'Settler'),
            (${deniedPersonId}, 'Settlement', 'Denied')
        `;
        yield* database`
          INSERT INTO public.organization_departments (
            department_id, name, short_name, email, city
          ) VALUES (
            ${departmentId}, 'Settlement Test Department', 'STD',
            'settlement-test@example.invalid', 'Bergen'
          )
        `;
        yield* database`
          INSERT INTO public.organization_teams (team_id, department_id, name)
          VALUES ('settlement-test-team', ${departmentId}, 'Settlement Test Team')
        `;
        yield* database`
          INSERT INTO public.organization_memberships (
            membership_id, person_id, team_id, start_at
          ) VALUES
            ('settlement-test-settler-membership', ${settlerPersonId},
              'settlement-test-team', '2038-01-01T00:00:00.000Z'),
            ('settlement-test-denied-membership', ${deniedPersonId},
              'settlement-test-team', '2038-01-01T00:00:00.000Z')
        `;
        yield* database`
          INSERT INTO public.economy_receipt_settlement_grants (
            settlement_grant_id, person_id, scope, department_id, start_at
          ) VALUES (
            'settlement-test-grant', ${settlerPersonId}, 'Department', ${departmentId},
            '2038-01-01T00:00:00.000Z'
          )
        `;
        yield* database`
          INSERT INTO public.economy_receipts (
            receipt_id, visual_id, owner_person_id, department_id, amount_ore,
            currency, description, receipt_date, submitted_at, status, approved_at,
            payment_account_ciphertext, file_ref, file_object_key, file_content_type,
            file_byte_length, file_sha256, revision
          ) VALUES
            ('settlement-test-receipt-1', 'SETTLEMENT-1', ${ownerPersonId}, ${departmentId},
              12345, 'NOK', 'Recorded settlement', '2038-06-14',
              '2038-06-14T10:00:00.000Z', 'Approved', '2038-06-14T11:00:00.000Z',
              ${paymentDestination}, 'settlement-test-file-1', 'temporary/settlement-test-1',
              'application/pdf', 128, ${"a".repeat(64)}, 0),
            ('settlement-test-receipt-2', 'SETTLEMENT-2', ${ownerPersonId}, ${departmentId},
              2000, 'NOK', 'Duplicate external reference', '2038-06-14',
              '2038-06-14T10:00:00.000Z', 'Approved', '2038-06-14T11:00:00.000Z',
              ${paymentDestination}, 'settlement-test-file-2', 'temporary/settlement-test-2',
              'application/pdf', 128, ${"b".repeat(64)}, 0),
            ('settlement-test-receipt-3', 'SETTLEMENT-3', ${ownerPersonId}, ${departmentId},
              3000, 'NOK', 'Stale revision', '2038-06-14',
              '2038-06-14T10:00:00.000Z', 'Approved', '2038-06-14T11:00:00.000Z',
              ${paymentDestination}, 'settlement-test-file-3', 'temporary/settlement-test-3',
              'application/pdf', 128, ${"c".repeat(64)}, 1),
            ('settlement-test-receipt-4', 'SETTLEMENT-4', ${ownerPersonId}, ${departmentId},
              4000, 'NOK', 'Concurrent record', '2038-06-14',
              '2038-06-14T10:00:00.000Z', 'Approved', '2038-06-14T11:00:00.000Z',
              ${paymentDestination}, 'settlement-test-file-4', 'temporary/settlement-test-4',
              'application/pdf', 128, ${"d".repeat(64)}, 0),
            ('settlement-test-receipt-5', 'SETTLEMENT-5', ${ownerPersonId}, ${departmentId},
              5000, 'NOK', 'Not approved', '2038-06-14',
              '2038-06-14T10:00:00.000Z', 'Pending', NULL,
              ${paymentDestination}, 'settlement-test-file-5', 'temporary/settlement-test-5',
              'application/pdf', 128, ${"e".repeat(64)}, 0)
        `;

        const recorded = yield* economy.recordReceiptSettlement(
          command("settlement-test-command-1", "settlement-test-receipt-1", 0, "reference-1"),
          principal(settlerPersonId),
        );

        const immutableUpdate = yield* Effect.exit(database`
          UPDATE public.economy_receipt_settlements
          SET external_reference = 'mutated-reference'
          WHERE settlement_id = ${recorded.settlement.settlementId}
        `);

        const replay = yield* economy.recordReceiptSettlement(
          command("settlement-test-command-1", "settlement-test-receipt-1", 0, "reference-1"),
          principal(settlerPersonId),
        );

        const changedReplay = yield* Effect.flip(
          economy.recordReceiptSettlement(
            command(
              "settlement-test-command-1",
              "settlement-test-receipt-1",
              0,
              "changed-reference",
            ),
            principal(settlerPersonId),
          ),
        );

        const duplicateReference = yield* Effect.flip(
          economy.recordReceiptSettlement(
            command("settlement-test-command-2", "settlement-test-receipt-2", 0, "reference-1"),
            principal(settlerPersonId),
          ),
        );

        const staleRevision = yield* Effect.flip(
          economy.recordReceiptSettlement(
            command("settlement-test-command-3", "settlement-test-receipt-3", 0, "reference-3"),
            principal(settlerPersonId),
          ),
        );

        const unapproved = yield* Effect.flip(
          economy.recordReceiptSettlement(
            command("settlement-test-command-4", "settlement-test-receipt-5", 0, "reference-5"),
            principal(settlerPersonId),
          ),
        );

        const concealedAuthority = yield* Effect.flip(
          economy.recordReceiptSettlement(
            command("settlement-test-command-5", "settlement-test-receipt-2", 0, "reference-2"),
            principal(deniedPersonId),
          ),
        );

        const concurrent = yield* Effect.all(
          [
            economy
              .recordReceiptSettlement(
                command(
                  "settlement-test-command-6a",
                  "settlement-test-receipt-4",
                  0,
                  "reference-4a",
                ),
                principal(settlerPersonId),
              )
              .pipe(
                Effect.match({
                  onFailure: (error) => ({ _tag: "Failure" as const, error }),
                  onSuccess: (value) => ({ _tag: "Success" as const, value }),
                }),
              ),
            economy
              .recordReceiptSettlement(
                command(
                  "settlement-test-command-6b",
                  "settlement-test-receipt-4",
                  0,
                  "reference-4b",
                ),
                principal(settlerPersonId),
              )
              .pipe(
                Effect.match({
                  onFailure: (error) => ({ _tag: "Failure" as const, error }),
                  onSuccess: (value) => ({ _tag: "Success" as const, value }),
                }),
              ),
          ],
          { concurrency: "unbounded" },
        );

        const queue = yield* economy.listReceiptsForSettlement(
          settlerPersonId,
          authorizationInstant,
        );

        const owned = yield* economy.listOwnedReceipts(ownerPersonId);

        const finance = yield* economy.readReceiptSettlementForFinance(
          "settlement-test-receipt-1",
          settlerPersonId,
          authorizationInstant,
        );

        const outbox = yield* database<{
          readonly effectType: string;
          readonly commandId: string;
          readonly ordinal: number;
          readonly status: string;
          readonly attempts: number;
        }>`
          SELECT effect_type AS "effectType", command_id AS "commandId", ordinal, status, attempts
          FROM public.economy_receipt_outbox
          WHERE command_id = 'settlement-test-command-1'
        `;

        const audit = yield* database<{
          readonly commandId: string;
          readonly action: string;
          readonly actorPersonId: string;
          readonly receiptRevision: number;
        }>`
          SELECT
            command_id AS "commandId",
            action,
            actor_person_id AS "actorPersonId",
            receipt_revision AS "receiptRevision"
          FROM public.economy_receipt_audit
          WHERE command_id = 'settlement-test-command-1'
        `;

        yield* database`
          INSERT INTO public.economy_receipts (
            receipt_id, visual_id, owner_person_id, department_id, amount_ore, currency,
            description, receipt_date, submitted_at, status, approved_at, payment_account_ciphertext,
            file_ref, file_object_key, file_content_type, file_byte_length, file_sha256, revision
          ) SELECT 'settlement-page-' || lpad(n::text, 3, '0'), 'SETTLEMENT-PAGE-' || n,
            owner_person_id, department_id, amount_ore, currency, description, receipt_date,
            '2038-06-13T10:00:00Z', 'Approved', '2038-06-13T11:00:00.123Z', payment_account_ciphertext,
            'settlement-page-file-' || n, 'settlement-page-object-' || n,
            file_content_type, file_byte_length, file_sha256, 0
          FROM public.economy_receipts CROSS JOIN generate_series(0, 51) AS n
          WHERE receipt_id = 'settlement-test-receipt-1'
        `;

        const firstPage = yield* economy.listReceiptsForSettlement(
          settlerPersonId,
          authorizationInstant,
        );

        if (firstPage.nextCursor === undefined)
          throw new Error("Settlement page lost continuation");
        yield* economy.recordReceiptSettlement(
          command("settlement-page-command", "settlement-page-000", 0, "page-reference"),
          principal(settlerPersonId),
        );

        const nextPage = yield* economy.listReceiptsForSettlement(
          settlerPersonId,
          authorizationInstant,
          firstPage.nextCursor,
        );

        const deniedPage = yield* economy.listReceiptsForSettlement(
          deniedPersonId,
          authorizationInstant,
          firstPage.nextCursor,
        );

        const pagination = {
          first: firstPage.items.map((row) => row.receiptId),
          next: nextPage.items.map((row) => row.receiptId),
          nextCursor: nextPage.nextCursor,
          denied: deniedPage,
        };

        return {
          pagination,
          recorded,
          replay,
          immutableUpdate: immutableUpdate._tag,
          changedReplay: changedReplay._tag,
          duplicateReference: duplicateReference._tag,
          staleRevision: staleRevision._tag,
          unapproved: unapproved._tag,
          concealedAuthority: concealedAuthority._tag,
          concurrent: concurrent.map((result) =>
            Predicate.isTagged(result, "Success") ? "Accepted" : result.error._tag,
          ),
          queue: queue.items.map(({ receiptId }) => receiptId),
          ownerSettlement: owned.items.find(
            ({ receiptId }) => receiptId === "settlement-test-receipt-1",
          )?.settlement,
          finance,
          outbox,
          audit,
        };
      }),
    );

    expect(evidence.pagination.first).toEqual(
      Array.from({ length: 50 }, (_, index) => `settlement-page-${String(index).padStart(3, "0")}`),
    );
    expect(evidence.pagination.next).toEqual([
      "settlement-page-050",
      "settlement-page-051",
      "settlement-test-receipt-2",
      "settlement-test-receipt-3",
    ]);
    expect(evidence.pagination.nextCursor).toBeUndefined();
    expect(evidence.pagination.denied).toEqual({ items: [] });
    expect(evidence.recorded).toMatchObject({
      replayed: false,
      outboxCount: 1,
      observation: { receiptId: "settlement-test-receipt-1", revision: 1, replayed: false },
      settlement: {
        receiptId: "settlement-test-receipt-1",
        amountOre: 12345,
        currency: "NOK",
        paymentDestinationFingerprint: sha256Hex(new TextEncoder().encode(paymentDestination)),
        externalAuthority: "settlement-test-bank",
        externalReference: "reference-1",
        settledAt: "2038-06-15T11:00:00.000Z",
        recordedByPersonId: settlerPersonId,
        recordedAt: authorizationInstant,
        receiptRevision: 1,
      },
    });
    expect(evidence.replay).toMatchObject({
      replayed: true,
      outboxCount: 0,
      observation: { receiptId: "settlement-test-receipt-1", revision: 1, replayed: true },
    });
    expect(evidence.immutableUpdate).toBe("Failure");
    expect(evidence.changedReplay).toBe("DuplicateReceiptCommandConflict");
    expect(evidence.duplicateReference).toBe("DuplicateExternalSettlementReference");
    expect(evidence.staleRevision).toBe("StaleReceiptRevision");
    expect(evidence.unapproved).toBe("InvalidReceiptTransition");
    expect(evidence.concealedAuthority).toBe("ReceiptNotFound");
    expect(evidence.concurrent.sort()).toEqual(["Accepted", "ReceiptAlreadySettled"]);
    expect(evidence.queue).toEqual(["settlement-test-receipt-2", "settlement-test-receipt-3"]);
    expect(evidence.ownerSettlement).toEqual(evidence.recorded.settlement);
    expect(evidence.finance).toEqual(evidence.recorded.settlement);
    expect(evidence.outbox).toEqual([
      {
        effectType: "NotifyReceiptSettled",
        commandId: "settlement-test-command-1",
        ordinal: 0,
        status: "Pending",
        attempts: 0,
      },
    ]);
    expect(evidence.audit).toEqual([
      {
        commandId: "settlement-test-command-1",
        action: "ReceiptSettled",
        actorPersonId: settlerPersonId,
        receiptRevision: 1,
      },
    ]);
  }, 15_000);
});

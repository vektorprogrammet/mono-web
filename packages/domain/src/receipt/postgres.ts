import { readApplicableAuthorizationRules } from "../authz/postgres.js";
import { composeCapabilityEvidence } from "../authz/rules.js";
import { Database, type DatabaseShape } from "../database/service.js";
import {
  lockPersonAuthorization,
  resolveOrganizationPersonAuthorityWithSql,
} from "../organization/authority-postgres.js";
import { Effect, Schema } from "effect";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "../tutor/evidence.js";
import {
  mapReceiptApprovalActor,
  mapReceiptOwnerActor,
  mapReceiptSubmissionPrincipal,
  projectReceiptAuthority,
} from "./authority.js";
import { resolveReceiptAuthorityWithSql } from "./authority-postgres.js";
import {
  AmbiguousPaymentSelection,
  DuplicateReceiptCommandConflict,
  ReceiptAlreadyExists,
  ReceiptAuthorityDenied,
  ReceiptDecodeError,
  ReceiptNotFound,
  ReceiptPersistenceError,
  ReceiptScopeDenied,
  StaleReceiptRevision,
  type ReceiptAuthorityMappingError,
  type ReceiptAuthorityResolutionError,
  type ReceiptFailure,
} from "./errors.js";
import type { ReceiptImportResult, ReceiptQuarantineReason } from "./import.js";
import {
  Receipt,
  ReceiptCommandPrincipalSchema,
  ReceiptCommandRequestSchema,
  ReceiptObservationSchema,
  ReceiptSubmissionAllocationSchema,
  type ReceiptCommandPrincipal,
  type ReceiptSubmissionAllocation,
} from "./schema.js";
import type { ReceiptTransactionResult } from "./service.js";
import { decideReceipt, type ReceiptDecisionContext, type ReceiptOutboxRequest } from "./update.js";

interface CommandReceiptRow {
  readonly command_sha256: string;
  readonly observation_json: unknown;
}

interface ReceiptImportLedgerRow {
  readonly source_watermark: string;
  readonly source_digest: string;
  readonly target_semantic_identity: string;
  readonly destination_identity: string | null;
  readonly result: "Accepted" | "Quarantined";
  readonly reconciliation_result: string;
  readonly reasons_json: unknown;
}

const persistenceError = (operation: string, cause: unknown) =>
  new ReceiptPersistenceError({ operation, message: String(cause) });

const receiptFromRow = (
  row: typeof Receipt.Encoded,
): Effect.Effect<Receipt, ReceiptPersistenceError> =>
  Schema.decodeUnknownEffect(Receipt)(row, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError((cause) => persistenceError("decode receipt row", cause)));

const findReceipt = (
  sql: DatabaseShape,
  receiptId: string,
): Effect.Effect<Receipt | undefined, ReceiptPersistenceError> =>
  sql<typeof Receipt.Encoded>`
    SELECT
      receipt_id AS "receiptId",
      visual_id AS "visualId",
      owner_person_id AS "ownerPersonId",
      department_id AS "departmentId",
      amount_ore::text AS "amountOre",
      currency,
      description,
      to_char(receipt_date, 'YYYY-MM-DD') AS "receiptDate",
      to_char(
        submitted_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) AS "submittedAt",
      status,
      CASE WHEN refund_date IS NULL THEN NULL
        ELSE to_char(
          refund_date AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      END AS "refundDate",
      payment_account_ciphertext AS "paymentAccountCiphertext",
      json_build_object(
        'fileRef', file_ref,
        'objectKey', file_object_key,
        'contentType', file_content_type,
        'byteLength', file_byte_length::text,
        'sha256', file_sha256
      ) AS file,
      revision
    FROM economy_receipts
    WHERE receipt_id = ${receiptId}
    FOR UPDATE
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.succeed(undefined) : receiptFromRow(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) => Effect.fail(persistenceError("read receipt", cause))),
  );

const findCommandReceipt = (
  sql: DatabaseShape,
  commandId: string,
): Effect.Effect<CommandReceiptRow | undefined, ReceiptPersistenceError> =>
  sql<CommandReceiptRow>`
    SELECT command_sha256, observation_json
    FROM economy_receipt_command_receipts
    WHERE command_id = ${commandId}
  `.pipe(
    Effect.map((rows) => rows[0]),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read command receipt", cause)),
    ),
  );

const insertReceipt = (
  sql: DatabaseShape,
  receipt: Receipt,
): Effect.Effect<void, ReceiptPersistenceError> =>
  sql`
    INSERT INTO economy_receipts (
      receipt_id, visual_id, owner_person_id, department_id,
      amount_ore, currency, description, receipt_date, submitted_at,
      status, refund_date, payment_account_ciphertext,
      file_ref, file_object_key, file_content_type, file_byte_length,
      file_sha256, revision
    ) VALUES (
      ${receipt.receiptId}, ${receipt.visualId}, ${receipt.ownerPersonId}, ${receipt.departmentId},
      ${receipt.amountOre}, ${receipt.currency}, ${receipt.description}, ${receipt.receiptDate}, ${receipt.submittedAt},
      ${receipt.status}, ${receipt.refundDate}, ${receipt.paymentAccountCiphertext},
      ${receipt.file.fileRef}, ${receipt.file.objectKey}, ${receipt.file.contentType}, ${receipt.file.byteLength},
      ${receipt.file.sha256}, ${receipt.revision}
    )
  `.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", (cause) => Effect.fail(persistenceError("insert receipt", cause))),
  );
const storeReceipt = (
  sql: DatabaseShape,
  receipt: Receipt,
  previous: Receipt | undefined,
): Effect.Effect<void, ReceiptFailure> => {
  if (previous === undefined) return insertReceipt(sql, receipt);

  return sql<{ readonly revision: number }>`
    UPDATE economy_receipts SET
      amount_ore = ${receipt.amountOre},
      description = ${receipt.description},
      receipt_date = ${receipt.receiptDate},
      status = ${receipt.status},
      refund_date = ${receipt.refundDate},
      file_ref = ${receipt.file.fileRef},
      file_object_key = ${receipt.file.objectKey},
      file_content_type = ${receipt.file.contentType},
      file_byte_length = ${receipt.file.byteLength},
      file_sha256 = ${receipt.file.sha256},
      revision = ${receipt.revision}
    WHERE receipt_id = ${receipt.receiptId}
      AND revision = ${previous.revision}
    RETURNING revision
  `.pipe(
    Effect.flatMap((rows) =>
      rows.length === 1
        ? Effect.void
        : Effect.fail(
            new StaleReceiptRevision({
              receiptId: receipt.receiptId,
              expected: previous.revision,
              actual: previous.revision,
            }),
          ),
    ),
    Effect.catchTag("SqlError", (cause) => Effect.fail(persistenceError("update receipt", cause))),
  );
};

const storeOutbox = (
  sql: DatabaseShape,
  requests: ReadonlyArray<ReceiptOutboxRequest>,
): Effect.Effect<void, ReceiptPersistenceError> =>
  Effect.forEach(
    requests,
    (request, ordinal) =>
      sql`
      INSERT INTO economy_receipt_outbox (
        effect_id, effect_type, receipt_id, command_id, ordinal, payload_json
      ) VALUES (
        ${request.effectId}, ${request._tag}, ${request.receiptId},
        ${request.commandId}, ${ordinal}, ${sql.json(request)}
      )
    `.pipe(Effect.asVoid),
    { discard: true },
  ).pipe(
    Effect.catchTag("SqlError", (cause) => Effect.fail(persistenceError("insert outbox", cause))),
  );

export const storeReceiptImportResult = (
  result: ReceiptImportResult,
): Effect.Effect<void, ReceiptPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const provenance = result.provenance;
    const targetSemanticIdentity = result.targetSemanticIdentity;
    let importResult = result._tag === "AcceptedReceiptImport" ? "Accepted" : "Quarantined";
    let reconciliationResult = result.reconciliation;
    let reasons: { reasons: ReadonlyArray<string> } = {
      reasons: result._tag === "QuarantinedReceiptImport" ? result.reasons : [],
    };
    const importLockKey = canonicalJson({
      sourceRepository: provenance.sourceRepository,
      sourceRevision: provenance.sourceRevision,
      snapshotId: provenance.snapshotId,
      sourcePrimaryKey: result.sourcePrimaryKey,
      sourceOccurrence: result.sourceOccurrence,
      transformationRevision: provenance.transformationRevision,
    });

    const isExactReplay = (existing: ReceiptImportLedgerRow): boolean =>
      existing.source_watermark === provenance.sourceWatermark &&
      existing.source_digest === provenance.sourceDigest &&
      existing.target_semantic_identity === targetSemanticIdentity &&
      existing.destination_identity === provenance.destinationIdentity &&
      existing.result === importResult &&
      existing.reconciliation_result === reconciliationResult &&
      canonicalJson(existing.reasons_json) === canonicalJson(reasons);

    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${importLockKey}, 0))`.pipe(
            Effect.asVoid,
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("lock receipt import", cause)),
            ),
          );
          const prior = yield* sql<ReceiptImportLedgerRow>`
            SELECT
              source_watermark, source_digest, target_semantic_identity, destination_identity,
              result, reconciliation_result, reasons_json
            FROM economy_receipt_import_ledger
            WHERE source_repository = ${provenance.sourceRepository}
              AND source_revision = ${provenance.sourceRevision}
              AND snapshot_id = ${provenance.snapshotId}
              AND source_primary_key = ${result.sourcePrimaryKey}
              AND source_occurrence = ${result.sourceOccurrence}
              AND transformation_revision = ${provenance.transformationRevision}
          `.pipe(
            Effect.map((rows) => rows[0]),
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("read receipt import ledger", cause)),
            ),
          );
          if (prior?.result === "Accepted") {
            if (!isExactReplay(prior)) {
              return yield* Effect.fail(
                persistenceError(
                  "conflicting receipt import replay",
                  `${provenance.sourceRepository}:${result.sourcePrimaryKey}`,
                ),
              );
            }
            return;
          }
          if (result._tag === "AcceptedReceiptImport") {
            const destinationLockKeys = [
              `receipt:${result.receipt.receiptId}`,
              `visual:${result.receipt.visualId}`,
            ].sort();
            yield* Effect.forEach(
              destinationLockKeys,
              (destinationLockKey) =>
                sql`
                  SELECT pg_advisory_xact_lock(hashtextextended(${destinationLockKey}, 0))
                `.pipe(
                  Effect.asVoid,
                  Effect.catchTag("SqlError", (cause) =>
                    Effect.fail(persistenceError("lock receipt import identity", cause)),
                  ),
                ),
              { discard: true },
            );
            const collisions = yield* sql<{
              readonly receipt_id: string;
              readonly visual_id: string;
            }>`
              SELECT receipt_id, visual_id
              FROM economy_receipts
              WHERE receipt_id = ${result.receipt.receiptId}
                 OR visual_id = ${result.receipt.visualId}
              FOR UPDATE
            `.pipe(
              Effect.catchTag("SqlError", (cause) =>
                Effect.fail(persistenceError("check receipt import identity", cause)),
              ),
            );
            if (collisions.length > 0) {
              const collisionReasons: ReceiptQuarantineReason[] = [];
              if (collisions.some((row) => row.receipt_id === result.receipt.receiptId)) {
                collisionReasons.push("DestinationIdentityCollision");
              }
              if (collisions.some((row) => row.visual_id === result.receipt.visualId)) {
                collisionReasons.push("DuplicateVisualId");
              }
              importResult = "Quarantined";
              reconciliationResult = "NotApplicable";
              reasons = { reasons: collisionReasons };
            }
          }
          const existing = yield* sql<ReceiptImportLedgerRow>`
          SELECT
            source_watermark, source_digest, target_semantic_identity, destination_identity,
            result, reconciliation_result, reasons_json
          FROM economy_receipt_import_ledger
          WHERE source_repository = ${provenance.sourceRepository}
            AND source_revision = ${provenance.sourceRevision}
            AND snapshot_id = ${provenance.snapshotId}
            AND source_primary_key = ${result.sourcePrimaryKey}
            AND source_occurrence = ${result.sourceOccurrence}
            AND transformation_revision = ${provenance.transformationRevision}
        `.pipe(
            Effect.map((rows) => rows[0]),
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("read receipt import ledger", cause)),
            ),
          );
          if (existing !== undefined) {
            const exactReplay = isExactReplay(existing);
            if (!exactReplay) {
              return yield* Effect.fail(
                persistenceError(
                  "conflicting receipt import replay",
                  `${provenance.sourceRepository}:${result.sourcePrimaryKey}`,
                ),
              );
            }
            return;
          }

          if (result._tag === "AcceptedReceiptImport" && importResult === "Accepted") {
            yield* insertReceipt(sql, result.receipt);
          }
          yield* sql`
          INSERT INTO economy_receipt_import_ledger (
            source_repository, source_revision, snapshot_id, source_watermark,
            source_primary_key, source_occurrence, source_digest, transformation_revision,
            target_semantic_identity, destination_identity, result,
            reconciliation_result, reasons_json
          ) VALUES (
            ${provenance.sourceRepository}, ${provenance.sourceRevision},
            ${provenance.snapshotId}, ${provenance.sourceWatermark},
            ${result.sourcePrimaryKey}, ${result.sourceOccurrence}, ${provenance.sourceDigest},
            ${provenance.transformationRevision}, ${targetSemanticIdentity},
            ${provenance.destinationIdentity}, ${importResult},
            ${reconciliationResult}, ${sql.json(reasons)}
          )
        `.pipe(
            Effect.asVoid,
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("insert receipt import ledger", cause)),
            ),
          );
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("receipt import transaction", cause)),
        ),
      );
  });

export const executeReceiptCommand = (
  input: unknown,
  principalInput: ReceiptCommandPrincipal,
  allocationInput?: ReceiptSubmissionAllocation,
): Effect.Effect<ReceiptTransactionResult, ReceiptFailure, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const command = yield* Schema.decodeUnknownEffect(ReceiptCommandRequestSchema)(input, {
            onExcessProperty: "error",
          }).pipe(Effect.mapError((cause) => new ReceiptDecodeError({ message: String(cause) })));
          const principal = yield* Schema.decodeUnknownEffect(ReceiptCommandPrincipalSchema)(
            principalInput,
            { onExcessProperty: "error" },
          ).pipe(Effect.mapError((cause) => new ReceiptDecodeError({ message: String(cause) })));
          const commandEnvelope = {
            schema: "ReceiptCommandRequest/v2" as const,
            principalPersonId: principal.personId,
            request: command,
          };
          const commandJson = canonicalJson(commandEnvelope);
          const commandDigest = sha256Hex(canonicalJsonBytes(commandEnvelope));

          yield* sql`
            SELECT pg_catalog.pg_advisory_xact_lock(
              pg_catalog.hashtextextended(${`receipt-command:${command.commandId}`}, 0)
            )
          `.pipe(
            Effect.asVoid,
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("lock command receipt", cause)),
            ),
          );
          const stored = yield* findCommandReceipt(sql, command.commandId);
          if (stored !== undefined) {
            if (stored.command_sha256 !== commandDigest) {
              return yield* new DuplicateReceiptCommandConflict({
                commandId: command.commandId,
              });
            }
            const storedObservation = yield* Schema.decodeUnknownEffect(ReceiptObservationSchema)(
              stored.observation_json,
              { onExcessProperty: "error" },
            ).pipe(
              Effect.mapError((cause) => persistenceError("decode stored observation", cause)),
            );
            return {
              observation: { ...storedObservation, replayed: true },
              replayed: true,
              outboxCount: 0,
            };
          }

          const allocation =
            command._tag === "SubmitReceipt"
              ? yield* Schema.decodeUnknownEffect(ReceiptSubmissionAllocationSchema)(
                  allocationInput,
                  { onExcessProperty: "error" },
                ).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ReceiptDecodeError({
                        message: `decode Receipt submission allocation: ${String(cause)}`,
                      }),
                  ),
                )
              : undefined;
          let receiptId: string;
          if (command._tag === "SubmitReceipt") {
            if (allocation === undefined) {
              return yield* new ReceiptDecodeError({
                message: "Receipt submission allocation is required",
              });
            }
            receiptId = allocation.receiptId;
          } else {
            receiptId = command.receiptId;
          }
          const previous = yield* findReceipt(sql, receiptId);
          if (command._tag === "SubmitReceipt" && previous !== undefined) {
            return yield* new ReceiptAlreadyExists({ receiptId });
          }
          if (
            previous === undefined &&
            (command._tag === "RefundReceipt" || command._tag === "RejectReceipt")
          ) {
            return yield* new ReceiptScopeDenied({ receiptId, departmentId: "" });
          }
          if (
            previous === undefined &&
            (command._tag === "RevisePendingReceipt" || command._tag === "WithdrawPendingReceipt")
          ) {
            return yield* new ReceiptNotFound({ receiptId });
          }

          yield* lockPersonAuthorization(sql, principal.personId).pipe(
            Effect.mapError((cause) => persistenceError(cause.operation, cause.message)),
          );
          const organization = yield* resolveOrganizationPersonAuthorityWithSql(
            sql,
            principal.personId,
            principal.authorizationInstant,
            "ForShare",
          ).pipe(
            Effect.mapError((cause) =>
              cause._tag === "OrganizationDecodeError"
                ? new ReceiptDecodeError({
                    message: `${cause.operation}: ${cause.message}`,
                  })
                : persistenceError(cause.operation, cause.message),
            ),
          );

          let authorizedCommand: unknown;
          if (command._tag === "SubmitReceipt") {
            const directAuthority = yield* resolveReceiptAuthorityWithSql(
              sql,
              principal.personId,
              principal.authorizationInstant,
              organization,
              "ForShare",
            ).pipe(
              Effect.mapError((cause: ReceiptAuthorityResolutionError) =>
                cause._tag === "ReceiptPersistenceError"
                  ? cause
                  : cause._tag === "ReceiptDecodeError"
                    ? cause
                    : new ReceiptDecodeError({
                        message: `Receipt authority projection mismatch for ${cause.personId}`,
                      }),
              ),
            );
            const canonicalDepartment =
              command.departmentId ??
              (
                yield* mapReceiptSubmissionPrincipal(directAuthority).pipe(
                  Effect.mapError((cause: ReceiptAuthorityMappingError) =>
                    cause._tag === "AmbiguousReceiptPaymentAuthority"
                      ? new AmbiguousPaymentSelection({
                          personId: cause.personId,
                          departmentIds: cause.departmentIds,
                        })
                      : cause,
                  ),
                )
              ).actor.departmentId;
            const requestScope = {
              domain: "Receipt" as const,
              departmentId: canonicalDepartment,
            };
            const applicable = yield* readApplicableAuthorizationRules(
              sql,
              principal.personId,
              "submitReceipt",
              principal.authorizationInstant,
              requestScope,
              "ForShare",
            ).pipe(
              Effect.mapError((cause) =>
                cause._tag === "AuthzPersistenceError"
                  ? persistenceError(cause.operation, cause.message)
                  : new ReceiptDecodeError({
                      message: `${cause.entity}: ${cause.message}`,
                    }),
              ),
            );
            const composition = composeCapabilityEvidence(
              "submitReceipt",
              { paymentAuthorities: directAuthority.paymentAuthorities },
              applicable.rules,
              {
                personId: principal.personId,
                authorizationInstant: principal.authorizationInstant,
                requestScope,
                tagAssignments: applicable.tagAssignments,
              },
            );
            if (composition.decision._tag === "Deny") {
              return yield* new ReceiptAuthorityDenied({
                personId: principal.personId,
                operation: "Submission",
                departmentId: canonicalDepartment,
              });
            }
            const composedAuthority = projectReceiptAuthority(
              organization,
              composition.evidence.paymentAuthorities ?? [],
              [],
            );
            const submission = yield* mapReceiptSubmissionPrincipal(
              composedAuthority,
              canonicalDepartment,
            ).pipe(
              Effect.mapError((cause: ReceiptAuthorityMappingError) =>
                cause._tag === "AmbiguousReceiptPaymentAuthority"
                  ? new AmbiguousPaymentSelection({
                      personId: cause.personId,
                      departmentIds: cause.departmentIds,
                    })
                  : cause,
              ),
            );
            authorizedCommand = {
              ...command,
              actor: submission.actor,
              departmentId: canonicalDepartment,
              paymentAccountCiphertext: submission.paymentAccountCiphertext,
            };
          } else if (command._tag === "RefundReceipt" || command._tag === "RejectReceipt") {
            const current = previous as Receipt;
            const directAuthority = yield* resolveReceiptAuthorityWithSql(
              sql,
              principal.personId,
              principal.authorizationInstant,
              organization,
              "ForShare",
            ).pipe(
              Effect.mapError((cause: ReceiptAuthorityResolutionError) =>
                cause._tag === "ReceiptPersistenceError"
                  ? cause
                  : cause._tag === "ReceiptDecodeError"
                    ? cause
                    : new ReceiptDecodeError({
                        message: `Receipt authority projection mismatch for ${cause.personId}`,
                      }),
              ),
            );
            const requestScope = {
              domain: "Receipt" as const,
              departmentId: current.departmentId,
            };
            const applicable = yield* readApplicableAuthorizationRules(
              sql,
              principal.personId,
              "approveReceipt",
              principal.authorizationInstant,
              requestScope,
              "ForShare",
            ).pipe(
              Effect.mapError((cause) =>
                cause._tag === "AuthzPersistenceError"
                  ? persistenceError(cause.operation, cause.message)
                  : new ReceiptDecodeError({
                      message: `${cause.entity}: ${cause.message}`,
                    }),
              ),
            );
            const composition = composeCapabilityEvidence(
              "approveReceipt",
              { approvalGrants: directAuthority.approvalGrants },
              applicable.rules,
              {
                personId: principal.personId,
                authorizationInstant: principal.authorizationInstant,
                requestScope,
                tagAssignments: applicable.tagAssignments,
              },
            );
            if (composition.decision._tag === "Deny") {
              return yield* new ReceiptAuthorityDenied({
                personId: principal.personId,
                operation: "DepartmentApproval",
                departmentId: current.departmentId,
              });
            }
            const composedAuthority = projectReceiptAuthority(
              organization,
              [],
              composition.evidence.approvalGrants ?? [],
            );
            const actor = yield* mapReceiptApprovalActor(
              composedAuthority,
              current.departmentId,
            );
            authorizedCommand = { ...command, actor };
          } else {
            const current = previous as Receipt;
            const actor = yield* mapReceiptOwnerActor(
              projectReceiptAuthority(organization, [], []),
              current.departmentId,
            );
            authorizedCommand = { ...command, actor };
          }

          const decisionContext: ReceiptDecisionContext = {
            receiptId,
            visualId: allocation?.visualId ?? previous?.visualId ?? receiptId,
            now: principal.authorizationInstant,
          };
          const decision = yield* decideReceipt(previous, authorizedCommand, decisionContext);
          yield* storeReceipt(sql, decision.receipt, previous);
          yield* sql`
            INSERT INTO economy_receipt_command_receipts (
              command_id, command_sha256, command_json, observation_json,
              receipt_id, committed_at
            ) VALUES (
              ${command.commandId}, ${commandDigest}, ${sql.json(JSON.parse(commandJson))},
              ${sql.json(decision.observation)}, ${decision.receipt.receiptId},
              ${principal.authorizationInstant}
            )
          `.pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("insert command receipt", cause)),
            ),
          );
          yield* storeOutbox(sql, decision.outbox);
          yield* sql`
            INSERT INTO economy_receipt_audit (
              command_id, receipt_id, actor_person_id, action,
              receipt_revision, occurred_at
            ) VALUES (
              ${command.commandId}, ${decision.receipt.receiptId},
              ${principal.personId}, ${decision.auditAction},
              ${decision.receipt.revision}, ${principal.authorizationInstant}
            )
          `.pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("insert audit", cause)),
            ),
          );

          return {
            observation: decision.observation,
            replayed: false,
            outboxCount: decision.outbox.length,
          };
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("receipt transaction", cause)),
        ),
      );
  });

import {
  PrincipalSchema,
  AuthorityVersion,
  RECEIPT_DOMAIN_ID,
  type CanonicalResourceContext,
  type ReceiptAccessFacts,
} from "@vektorprogrammet/domain/authz";
import { readApplicableAuthorizationRules } from "../authz/postgres.js";
import { composeCapabilityEvidence } from "@vektorprogrammet/domain/authz";
import type { AuthzRule, AuthzTagAssignment } from "@vektorprogrammet/domain/authz";
import { AdvisoryLockKey, lockAdvisory } from "../advisory-lock.js";
import { Database, type DatabaseOperations } from "../service.js";
import {
  lockPersonAuthorization,
  resolveOrganizationPersonAuthorityForRead,
  resolveOrganizationPersonAuthorityWithSql,
} from "../organization/authority-postgres.js";
import type { OrganizationAuthorityInstant } from "@vektorprogrammet/domain/organization";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { Equal, flow, Predicate, Effect, Schema } from "effect";
import {
  canonicalJson,
  canonicalJsonBytes,
  sha256Hex,
} from "@vektorprogrammet/domain/shared-kernel";
import {
  mapExistingReceiptApprovalActor,
  mapReceiptOwnerActor,
  mapReceiptSubmissionPrincipal,
  projectReceiptAuthority,
} from "@vektorprogrammet/domain/receipt";
import {
  makeReceiptApprovalContext,
  evaluateReceiptApprovalCandidates,
  receiptApprovalSelectionDecision,
  RECEIPT_PAGE_SIZE,
  decodeReceiptCursor,
  type ReceiptPage,
  type ReceiptApprovalSelectionEvidence,
  selectAuthorizedReceiptFileForApproval,
  type ReceiptApprovalCandidate,
} from "@vektorprogrammet/domain/receipt";
import {
  resolveReceiptAuthorityForRead,
  resolveReceiptAuthorityWithSql,
} from "./authority-postgres.js";
import {
  AmbiguousPaymentSelection,
  DuplicateReceiptCommandConflict,
  InactiveActor,
  ReceiptAlreadyExists,
  ReceiptAuthorityDenied,
  ReceiptDecodeError,
  ReceiptNotFound,
  ReceiptPersistenceError,
  receiptCompositionFailure,
  ReceiptScopeDenied,
  StaleReceiptRevision,
  type ReceiptApprovalFileReadFailure,
  type ReceiptApprovalListFailure,
  type ReceiptAuthorityMappingError,
  type ReceiptAuthorityResolutionError,
  type ReceiptFailure,
} from "@vektorprogrammet/domain/receipt";
import type {
  ReceiptImportResult,
  ReceiptListItem,
  ReceiptQuarantineReason,
} from "@vektorprogrammet/domain/receipt";
import { listApproverReceipts, type ReceiptCandidateRow } from "./projections.js";
import { receiptCursorPage } from "./cursor.js";
import {
  Receipt,
  ReceiptFileSchema,
  ReceiptId,
  ReceiptStatusSchema,
  ReceiptCommandPrincipalSchema,
  type AuthorizedReceiptCommandSchema,
  ReceiptCommandRequestSchema,
  ReceiptSettlementCommandRequestSchema,
  ReceiptObservationSchema,
  ReceiptSubmissionAllocationSchema,
  type ReceiptCommandPrincipal,
  type ReceiptFile,
  type ReceiptStatus,
  type ReceiptSubmissionAllocation,
} from "@vektorprogrammet/domain/receipt";
import {
  ReceiptMutationAuthorization,
  ReceiptMutationAuthorizationTarget,
  type ReceiptTransactionResult,
} from "@vektorprogrammet/domain/receipt";
import {
  authorizeReceiptMutationAccess,
  decideReceipt,
  type ReceiptDecisionContext,
  type ReceiptOutboxRequest,
} from "@vektorprogrammet/domain/receipt";

interface CommandReceiptRow {
  readonly command_sha256: string;
  readonly command_json: unknown;
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

const ReceiptApprovalFileReadRowSchema = Schema.Struct({
  receiptId: ReceiptId,
  ownerPersonId: PersonId,
  departmentId: DepartmentId,
  status: ReceiptStatusSchema,
  revision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  file: ReceiptFileSchema,
});

type ReceiptApprovalFileReadRow = typeof ReceiptApprovalFileReadRowSchema.Type;

/**
 * Historical command receipts are retained verbatim because `command_sha256`
 * authenticates their original request. This decoder is intentionally private:
 * native callers cannot issue the retired command variant.
 */
const HistoricalRefundReceiptCommandRequestSchema = Schema.TaggedUnion({
  RefundReceipt: {
    commandId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    receiptId: ReceiptId,
    expectedRevision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  },
});

const StoredReceiptCommandEnvelopeSchema = Schema.Struct({
  schema: Schema.String,
  principalPersonId: PersonId,
  request: Schema.Union([
    ReceiptCommandRequestSchema,
    HistoricalRefundReceiptCommandRequestSchema,
    ReceiptSettlementCommandRequestSchema,
  ]),
});

const persistenceError = (operation: string, cause: unknown) =>
  new ReceiptPersistenceError({ operation, message: String(cause), cause });

const receiptFromRow = (
  row: typeof Receipt.Encoded,
): Effect.Effect<Receipt, ReceiptPersistenceError> =>
  Schema.decodeEffect(Receipt)(row, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError((cause) => persistenceError("decode receipt row", cause)));

const findReceipt = (
  sql: DatabaseOperations,
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
      CASE WHEN approved_at IS NULL THEN NULL
        ELSE to_char(
          approved_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      END AS "approvedAt",
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
  sql: DatabaseOperations,
  commandId: string,
): Effect.Effect<CommandReceiptRow | undefined, ReceiptPersistenceError> =>
  sql<CommandReceiptRow>`
    SELECT command_sha256, command_json, observation_json
    FROM economy_receipt_command_receipts
    WHERE command_id = ${commandId}
  `.pipe(
    Effect.flatMap((rows) => {
      const row = rows[0];

      if (row === undefined) return Effect.succeed(undefined);

      return Schema.decodeUnknownEffect(StoredReceiptCommandEnvelopeSchema)(row.command_json, {
        onExcessProperty: "error",
      }).pipe(
        Effect.as(row),
        Effect.mapError((cause) => persistenceError("decode stored command receipt", cause)),
      );
    }),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read command receipt", cause)),
    ),
  );

const insertReceipt = (
  sql: DatabaseOperations,
  receipt: Receipt,
): Effect.Effect<void, ReceiptPersistenceError> =>
  sql`
    INSERT INTO economy_receipts (
      receipt_id, visual_id, owner_person_id, department_id,
      amount_ore, currency, description, receipt_date, submitted_at,
      status, approved_at, payment_account_ciphertext,
      file_ref, file_object_key, file_content_type, file_byte_length,
      file_sha256, revision
    ) VALUES (
      ${receipt.receiptId}, ${receipt.visualId}, ${receipt.ownerPersonId}, ${receipt.departmentId},
      ${receipt.amountOre}, ${receipt.currency}, ${receipt.description}, ${receipt.receiptDate}, ${receipt.submittedAt},
      ${receipt.status}, ${receipt.approvedAt}, ${receipt.paymentAccountCiphertext},
      ${receipt.file.fileRef}, ${receipt.file.objectKey}, ${receipt.file.contentType}, ${receipt.file.byteLength},
      ${receipt.file.sha256}, ${receipt.revision}
    )
  `.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", (cause) => Effect.fail(persistenceError("insert receipt", cause))),
  );

const storeReceipt = (
  sql: DatabaseOperations,
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
      approved_at = ${receipt.approvedAt},
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
  sql: DatabaseOperations,
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

/** All native and reviewed importers serialize ownership of a legacy source receipt. */
export const lockReceiptImportSource = (
  sql: DatabaseOperations,
  sourceRepository: string,
  sourcePrimaryKey: string,
): Effect.Effect<void, ReceiptPersistenceError> =>
  lockAdvisory(sql, AdvisoryLockKey.receiptImportSource(sourceRepository, sourcePrimaryKey)).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("lock receipt source ownership", cause)),
    ),
  );

export const storeReceiptImportResult = (
  result: ReceiptImportResult,
): Effect.Effect<void, ReceiptPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const provenance = result.provenance;
    const targetSemanticIdentity = result.targetSemanticIdentity;

    let importResult = Predicate.isTagged(result, "AcceptedReceiptImport")
      ? "Accepted"
      : "Quarantined";

    let reconciliationResult = result.reconciliation;

    let reasons = {
      reasons: Predicate.isTagged(result, "QuarantinedReceiptImport") ? result.reasons : [],
    };

    const isExactReplay = (existing: ReceiptImportLedgerRow): boolean =>
      existing.source_watermark === provenance.sourceWatermark &&
      existing.source_digest === provenance.sourceDigest &&
      existing.target_semantic_identity === targetSemanticIdentity &&
      existing.destination_identity === provenance.destinationIdentity &&
      existing.result === importResult &&
      (existing.reconciliation_result === reconciliationResult ||
        (importResult === "Accepted" && existing.reconciliation_result === "Reconciled")) &&
      canonicalJson(existing.reasons_json) === canonicalJson(reasons);

    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* lockReceiptImportSource(sql, provenance.sourceRepository, result.sourcePrimaryKey);
          yield* lockAdvisory(sql, AdvisoryLockKey.receiptImportOccurrence(result)).pipe(
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
              return yield* persistenceError(
                "conflicting receipt import replay",
                `${provenance.sourceRepository}:${result.sourcePrimaryKey}`,
              );
            }

            return;
          }

          if (Predicate.isTagged(result, "AcceptedReceiptImport")) {
            const sourceOwners = yield* sql<{ readonly destination_identity: string }>`
              SELECT destination_identity FROM economy_receipt_import_ledger
              WHERE source_repository = ${provenance.sourceRepository}
                AND source_primary_key = ${result.sourcePrimaryKey} AND result = 'Accepted'
              FOR SHARE
            `.pipe(
              Effect.catchTag("SqlError", (cause) =>
                Effect.fail(persistenceError("read receipt source ownership", cause)),
              ),
            );

            const sourceCollision = sourceOwners.some(
              (row) => row.destination_identity !== result.receipt.receiptId,
            );

            const destinationLockKeys = [
              AdvisoryLockKey.importedReceipt(result.receipt.receiptId),
              AdvisoryLockKey.importedReceiptVisual(result.receipt.visualId),
            ].sort();

            yield* Effect.forEach(
              destinationLockKeys,
              (destinationLockKey) =>
                lockAdvisory(sql, destinationLockKey).pipe(
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

            if (sourceCollision || collisions.length > 0) {
              const collisionReasons: ReceiptQuarantineReason[] = [];

              if (sourceCollision) collisionReasons.push("SourceIdentityCollision");

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
              return yield* persistenceError(
                "conflicting receipt import replay",
                `${provenance.sourceRepository}:${result.sourcePrimaryKey}`,
              );
            }

            return;
          }

          if (Predicate.isTagged(result, "AcceptedReceiptImport") && importResult === "Accepted") {
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

/**
 * Reconcile the exact imported occurrence against a locked fresh fact and an
 * external byte/projection observation. The marker is a last observation, never
 * authority to skip subsequent reads. A failed observation durably returns it
 * to Pending. Filesystem and SQL do not form a distributed transaction.
 */
export const reconcileReceiptImport = (
  expected: Extract<ReceiptImportResult, { readonly _tag: "AcceptedReceiptImport" }>,
  observe: (receipt: Receipt) => Effect.Effect<boolean, ReceiptPersistenceError>,
): Effect.Effect<boolean, ReceiptPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const p = expected.provenance;

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const ledger = yield* sql<{ readonly source_digest: string; readonly result: string }>`
        SELECT source_digest, result FROM economy_receipt_import_ledger
        WHERE source_repository = ${p.sourceRepository} AND source_revision = ${p.sourceRevision}
          AND snapshot_id = ${p.snapshotId} AND source_primary_key = ${expected.sourcePrimaryKey}
          AND source_occurrence = ${expected.sourceOccurrence}
          AND transformation_revision = ${p.transformationRevision}
          AND source_watermark = ${p.sourceWatermark}
          AND destination_identity = ${p.destinationIdentity}
          AND target_semantic_identity = ${expected.targetSemanticIdentity}
        FOR UPDATE
      `;

          if (
            ledger.length !== 1 ||
            ledger[0]?.source_digest !== p.sourceDigest ||
            ledger[0]?.result !== "Accepted"
          ) {
            return yield* persistenceError(
              "reconcile receipt import",
              "exact accepted occurrence required",
            );
          }

          const actual = yield* findReceipt(sql, expected.receipt.receiptId);

          // The import result carries a plain receipt; Equal compares models only with models.
          const matches =
            actual !== undefined && Equal.equals(actual, new Receipt(expected.receipt));

          const observed =
            matches && actual !== undefined
              ? yield* observe(actual).pipe(Effect.catch(() => Effect.succeed(false)))
              : false;

          yield* sql`
        UPDATE economy_receipt_import_ledger SET reconciliation_result = ${observed ? "Reconciled" : "Pending"}
        WHERE source_repository = ${p.sourceRepository} AND source_revision = ${p.sourceRevision}
          AND snapshot_id = ${p.snapshotId} AND source_primary_key = ${expected.sourcePrimaryKey}
          AND source_occurrence = ${expected.sourceOccurrence}
          AND transformation_revision = ${p.transformationRevision}
      `;

          return observed;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("reconcile receipt import", cause)),
        ),
      );
  });

/**
 * Rule-aware approval projection. Session identity and the instant are explicit
 * query inputs; every authority source is read without locks in one snapshot.
 */
export const listReceiptsForApproval = (
  personId: PersonId,
  authorizationInstant: OrganizationAuthorityInstant,
  status?: ReceiptStatus,
  after?: string,
): Effect.Effect<ReceiptPage<ReceiptListItem>, ReceiptApprovalListFailure, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY
          `.pipe(Effect.asVoid);

          const organization = yield* resolveOrganizationPersonAuthorityForRead(
            personId,
            authorizationInstant,
          ).pipe(
            Effect.mapError((cause) =>
              Predicate.isTagged(cause, "OrganizationPersistenceError")
                ? persistenceError(
                    "resolve Receipt approval list Organization authority",
                    cause.message,
                  )
                : new ReceiptDecodeError({
                    message: `${cause.operation}: ${cause.message}`,
                  }),
            ),
          );

          const directAuthority = yield* resolveReceiptAuthorityForRead(
            personId,
            authorizationInstant,
            organization,
          ).pipe(
            Effect.mapError((cause) =>
              Predicate.isTagged(cause, "ReceiptPersistenceError")
                ? cause
                : Predicate.isTagged(cause, "ReceiptDecodeError")
                  ? cause
                  : new ReceiptDecodeError({
                      message: `Receipt authority projection mismatch for ${cause.personId}`,
                    }),
            ),
          );

          let position = after === undefined ? undefined : yield* decodeReceiptCursor(after);
          const visible: Array<ReceiptCandidateRow> = [];

          let evidence: ReceiptApprovalSelectionEvidence = {
            receiptIds: [],
            candidateSeen: false,
            denialReason: undefined,
            inactiveGrantSeen: directAuthority.approvalGrants.length > 0,
          };

          while (
            visible.length <= RECEIPT_PAGE_SIZE &&
            directAuthority.organizationAuthority === "Active"
          ) {
            const candidates = yield* listApproverReceipts(status, position);

            const applicable = yield* Effect.forEach(candidates, (candidate) =>
              readApplicableAuthorizationRules(
                sql,
                PrincipalSchema.cases.Person.make({ personId }),
                "approveReceipt",
                authorizationInstant,
                makeReceiptApprovalContext(candidate, organization, directAuthority, []),
                "None",
              ).pipe(
                Effect.mapError((cause) =>
                  Predicate.isTagged(cause, "AuthzPersistenceError")
                    ? persistenceError(cause.operation, cause.message)
                    : new ReceiptDecodeError({
                        message: `${cause.entity}: ${cause.message}`,
                      }),
                ),
              ),
            );

            const ruleById = new Map<string, AuthzRule>();
            const assignmentById = new Map<string, AuthzTagAssignment>();

            for (const result of applicable) {
              for (const rule of result.rules) ruleById.set(rule.ruleId, rule);

              for (const assignment of result.tagAssignments) {
                assignmentById.set(assignment.assignmentId, assignment);
              }
            }

            const batch = evaluateReceiptApprovalCandidates(
              organization,
              directAuthority,
              candidates,
              Array.from(ruleById.values()),
              Array.from(assignmentById.values()),
            );

            const selectedReceiptIds = new Set(batch.receiptIds);

            for (const candidate of candidates) {
              if (selectedReceiptIds.has(candidate.receiptId)) visible.push(candidate);

              if (visible.length > RECEIPT_PAGE_SIZE) break;
            }

            evidence = {
              receiptIds: [],
              candidateSeen: evidence.candidateSeen || batch.candidateSeen,
              denialReason: evidence.denialReason ?? batch.denialReason,
              inactiveGrantSeen: evidence.inactiveGrantSeen || batch.inactiveGrantSeen,
            };

            if (candidates.length <= RECEIPT_PAGE_SIZE) break;
            const last = candidates[candidates.length - 1]!;
            position = { timestamp: last.cursorTimestamp, receiptId: last.receiptId };
          }

          const decision = receiptApprovalSelectionDecision(directAuthority, {
            ...evidence,
            receiptIds: visible.map((row) => row.receiptId),
          });

          if (Predicate.isTagged(decision, "Deny")) {
            const compositionFailure = receiptCompositionFailure(
              decision.reason,
              personId,
              "approveReceipt",
            );

            if (compositionFailure !== undefined) return yield* compositionFailure;

            if (decision.reason === "AuthorityInactive") {
              return yield* new InactiveActor({ personId });
            }

            return yield* new ReceiptScopeDenied({
              receiptId: "approval-projection",
              departmentId: "",
            });
          }

          return receiptCursorPage(visible);
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("list Receipt approval snapshot", cause)),
        ),
      );
  });

/**
 * Resolves one canonical approver-visible file on the caller's repeatable-read,
 * read-only transaction. The request credential, row, Organization authority,
 * direct authority, and rules must share that caller-owned snapshot.
 */
export const readReceiptFileForApproval = (
  receiptId: string,
  personId: PersonId,
  authorizationInstant: OrganizationAuthorityInstant,
): Effect.Effect<ReceiptFile, ReceiptApprovalFileReadFailure, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;

    const rows = yield* sql<ReceiptApprovalFileReadRow>`
      SELECT
        receipt_id AS "receiptId",
        owner_person_id AS "ownerPersonId",
        department_id AS "departmentId",
        status,
        revision,
        json_build_object(
          'fileRef', file_ref,
          'objectKey', file_object_key,
          'contentType', file_content_type,
          'byteLength', file_byte_length::integer,
          'sha256', file_sha256
        ) AS file
      FROM economy_receipts
      WHERE receipt_id = ${receiptId}
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read Receipt approval file metadata", cause)),
      ),
    );

    const selected = rows[0];

    if (selected === undefined) return yield* new ReceiptNotFound({ receiptId });

    const row = yield* Schema.decodeEffect(ReceiptApprovalFileReadRowSchema)(selected, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError((cause) => persistenceError("decode Receipt approval file metadata", cause)),
    );

    const candidate: ReceiptApprovalCandidate = {
      receiptId: row.receiptId,
      ownerPersonId: row.ownerPersonId,
      departmentId: row.departmentId,
      status: row.status,
      revision: row.revision,
    };

    const organization = yield* resolveOrganizationPersonAuthorityWithSql(
      sql,
      personId,
      authorizationInstant,
      "None",
    ).pipe(
      Effect.mapError((cause) =>
        Predicate.isTagged(cause, "OrganizationPersistenceError")
          ? persistenceError("resolve Receipt approval file Organization authority", cause.message)
          : new ReceiptDecodeError({
              message: `${cause.operation}: ${cause.message}`,
            }),
      ),
    );

    const directAuthority = yield* resolveReceiptAuthorityWithSql(
      sql,
      personId,
      authorizationInstant,
      organization,
      "None",
    ).pipe(
      Effect.mapError((cause) =>
        Predicate.isTagged(cause, "ReceiptPersistenceError")
          ? cause
          : Predicate.isTagged(cause, "ReceiptDecodeError")
            ? cause
            : new ReceiptDecodeError({
                message: `Receipt authority projection mismatch for ${cause.personId}`,
              }),
      ),
    );

    const applicable = yield* readApplicableAuthorizationRules(
      sql,
      PrincipalSchema.cases.Person.make({ personId }),
      "approveReceipt",
      authorizationInstant,
      makeReceiptApprovalContext(candidate, organization, directAuthority, []),
      "None",
    ).pipe(
      Effect.mapError((cause) =>
        Predicate.isTagged(cause, "AuthzPersistenceError")
          ? persistenceError(cause.operation, cause.message)
          : new ReceiptDecodeError({
              message: `${cause.entity}: ${cause.message}`,
            }),
      ),
    );

    const decision = selectAuthorizedReceiptFileForApproval(
      organization,
      directAuthority,
      candidate,
      applicable.rules,
      applicable.tagAssignments,
    );

    if (Predicate.isTagged(decision, "Deny")) {
      const compositionFailure = receiptCompositionFailure(
        decision.reason,
        personId,
        "approveReceipt",
      );

      if (compositionFailure !== undefined) return yield* compositionFailure;

      if (decision.reason === "AuthorityInactive") {
        return yield* new InactiveActor({ personId });
      }

      return yield* new ReceiptScopeDenied({
        receiptId: candidate.receiptId,
        departmentId: candidate.departmentId,
      });
    }

    if (!decision.value.receiptIds.includes(candidate.receiptId)) {
      return yield* new ReceiptScopeDenied({
        receiptId: candidate.receiptId,
        departmentId: candidate.departmentId,
      });
    }

    return row.file;
  });

const authorizeReceiptMutationWithSql = (
  sql: DatabaseOperations,
  target: ReceiptMutationAuthorizationTarget,
  principal: ReceiptCommandPrincipal,
): Effect.Effect<ReceiptMutationAuthorization, ReceiptFailure> =>
  Effect.gen(function* () {
    const current = Predicate.isTagged(target, "SubmitReceipt")
      ? undefined
      : yield* findReceipt(sql, target.receiptId);

    if (!Predicate.isTagged(target, "SubmitReceipt") && current === undefined) {
      return yield* new ReceiptNotFound({ receiptId: target.receiptId });
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
        Predicate.isTagged(cause, "OrganizationDecodeError")
          ? new ReceiptDecodeError({
              message: `${cause.operation}: ${cause.message}`,
            })
          : persistenceError(cause.operation, cause.message),
      ),
    );

    let authorization: ReceiptMutationAuthorization;

    if (Predicate.isTagged(target, "SubmitReceipt")) {
      const directAuthority = yield* resolveReceiptAuthorityWithSql(
        sql,
        principal.personId,
        principal.authorizationInstant,
        organization,
        "ForShare",
      ).pipe(
        Effect.mapError((cause: ReceiptAuthorityResolutionError) =>
          Predicate.isTagged(cause, "ReceiptPersistenceError")
            ? cause
            : Predicate.isTagged(cause, "ReceiptDecodeError")
              ? cause
              : new ReceiptDecodeError({
                  message: `Receipt authority projection mismatch for ${cause.personId}`,
                }),
        ),
      );

      const canonicalDepartment =
        target.departmentId ??
        (yield* mapReceiptSubmissionPrincipal(directAuthority).pipe(
          Effect.mapError((cause: ReceiptAuthorityMappingError) =>
            Predicate.isTagged(cause, "AmbiguousReceiptPaymentAuthority")
              ? new AmbiguousPaymentSelection({
                  personId: cause.personId,
                  departmentIds: cause.departmentIds,
                })
              : cause,
          ),
        )).actor.departmentId;

      const context: CanonicalResourceContext<ReceiptAccessFacts> = {
        domainId: RECEIPT_DOMAIN_ID,
        departmentId: canonicalDepartment,
        resource: null,
        facts: {
          ownerPersonId: principal.personId,
          state: "Pending",
          approverPersonIds: [],
          approverServicePrincipalIds: [],
          internalEvidenceEnabled: false,
        },
        authorityVersion: AuthorityVersion.make(
          `receipt-creation:${canonicalDepartment}:${principal.authorizationInstant}`,
        ),
      };

      const applicable = yield* readApplicableAuthorizationRules(
        sql,
        PrincipalSchema.cases.Person.make({ personId: principal.personId }),
        "submitReceipt",
        principal.authorizationInstant,
        context,
        "ForShare",
      ).pipe(
        Effect.mapError((cause) =>
          Predicate.isTagged(cause, "AuthzPersistenceError")
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
          principal: PrincipalSchema.cases.Person.make({ personId: principal.personId }),
          authorizationInstant: principal.authorizationInstant,
          context,
          tagAssignments: applicable.tagAssignments,
        },
      );

      if (Predicate.isTagged(composition.decision, "Deny")) {
        const compositionFailure = receiptCompositionFailure(
          composition.decision.reason,
          principal.personId,
          "submitReceipt",
        );

        if (compositionFailure !== undefined) return yield* compositionFailure;

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
          Predicate.isTagged(cause, "AmbiguousReceiptPaymentAuthority")
            ? new AmbiguousPaymentSelection({
                personId: cause.personId,
                departmentIds: cause.departmentIds,
              })
            : cause,
        ),
      );

      authorization = ReceiptMutationAuthorization[target._tag]({
        principal,
        actor: submission.actor,
        departmentId: canonicalDepartment,
        paymentAccountCiphertext: submission.paymentAccountCiphertext,
      });
    } else if (
      Predicate.isTagged(target, "ApproveReceipt") ||
      Predicate.isTagged(target, "RejectReceipt") ||
      Predicate.isTagged(target, "ReopenRejectedReceipt")
    ) {
      const receipt = current!;

      const directAuthority = yield* resolveReceiptAuthorityWithSql(
        sql,
        principal.personId,
        principal.authorizationInstant,
        organization,
        "ForShare",
      ).pipe(
        Effect.mapError((cause: ReceiptAuthorityResolutionError) =>
          Predicate.isTagged(cause, "ReceiptPersistenceError")
            ? cause
            : Predicate.isTagged(cause, "ReceiptDecodeError")
              ? cause
              : new ReceiptDecodeError({
                  message: `Receipt authority projection mismatch for ${cause.personId}`,
                }),
        ),
      );

      const unresolvedContext = makeReceiptApprovalContext(
        receipt,
        organization,
        directAuthority,
        [],
      );

      const applicable = yield* readApplicableAuthorizationRules(
        sql,
        PrincipalSchema.cases.Person.make({ personId: principal.personId }),
        "approveReceipt",
        principal.authorizationInstant,
        unresolvedContext,
        "ForShare",
      ).pipe(
        Effect.mapError((cause) =>
          Predicate.isTagged(cause, "AuthzPersistenceError")
            ? persistenceError(cause.operation, cause.message)
            : new ReceiptDecodeError({
                message: `${cause.entity}: ${cause.message}`,
              }),
        ),
      );

      const context = makeReceiptApprovalContext(
        receipt,
        organization,
        directAuthority,
        applicable.rules,
      );

      const composition = composeCapabilityEvidence(
        "approveReceipt",
        { approvalGrants: directAuthority.approvalGrants },
        applicable.rules,
        {
          principal: PrincipalSchema.cases.Person.make({ personId: principal.personId }),
          authorizationInstant: principal.authorizationInstant,
          context,
          tagAssignments: applicable.tagAssignments,
        },
      );

      if (Predicate.isTagged(composition.decision, "Deny")) {
        const compositionFailure = receiptCompositionFailure(
          composition.decision.reason,
          principal.personId,
          "approveReceipt",
        );

        if (compositionFailure !== undefined) return yield* compositionFailure;
      }

      const composedAuthority = projectReceiptAuthority(
        organization,
        [],
        composition.evidence.approvalGrants ?? [],
      );

      const actor = yield* mapExistingReceiptApprovalActor(
        composedAuthority,
        receipt.receiptId,
        receipt.departmentId,
      );

      authorization = ReceiptMutationAuthorization[target._tag]({
        principal,
        actor,
        current: receipt,
      });
    } else {
      const receipt = current!;

      const actor = yield* mapReceiptOwnerActor(
        projectReceiptAuthority(organization, [], []),
        receipt.departmentId,
      );

      authorization = ReceiptMutationAuthorization[target._tag]({
        principal,
        actor,
        current: receipt,
      });
    }

    yield* authorizeReceiptMutationAccess(authorization);

    return authorization;
  });

export const authorizeReceiptMutation = (
  target: ReceiptMutationAuthorizationTarget,
  principalInput: ReceiptCommandPrincipal,
): Effect.Effect<ReceiptMutationAuthorization, ReceiptFailure, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;

    const principal = yield* Schema.decodeEffect(ReceiptCommandPrincipalSchema)(principalInput, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => new ReceiptDecodeError({ message: String(cause) })));

    return yield* authorizeReceiptMutationWithSql(sql, target, principal);
  });

const decodeReceiptCommand = flow(
  Schema.decodeUnknownEffect(ReceiptCommandRequestSchema, {
    onExcessProperty: "error",
  }),
  Effect.mapError((cause) => new ReceiptDecodeError({ message: String(cause) })),
);

const decodeReceiptPrincipal = (input: typeof ReceiptCommandPrincipalSchema.Encoded) =>
  Schema.decodeEffect(ReceiptCommandPrincipalSchema)(input, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError((cause) => new ReceiptDecodeError({ message: String(cause) })));

const targetFromCommand = (
  command: typeof ReceiptCommandRequestSchema.Type,
): ReceiptMutationAuthorizationTarget =>
  Predicate.isTagged(command, "SubmitReceipt")
    ? ReceiptMutationAuthorizationTarget.SubmitReceipt({ departmentId: command.departmentId })
    : ReceiptMutationAuthorizationTarget[command._tag]({ receiptId: command.receiptId });

const authorizationMatchesCommand = (
  authorization: ReceiptMutationAuthorization,
  command: typeof ReceiptCommandRequestSchema.Type,
): boolean => {
  if (authorization._tag !== command._tag) return false;

  if (Predicate.isTagged(authorization, "SubmitReceipt")) {
    return (
      Predicate.isTagged(command, "SubmitReceipt") &&
      (command.departmentId === undefined || command.departmentId === authorization.departmentId)
    );
  }

  return (
    !Predicate.isTagged(command, "SubmitReceipt") &&
    authorization.current.receiptId === command.receiptId
  );
};

const executeAuthorizedReceiptCommandWithSql = (
  sql: DatabaseOperations,
  command: typeof ReceiptCommandRequestSchema.Type,
  authorization: ReceiptMutationAuthorization,
  allocationInput?: ReceiptSubmissionAllocation,
): Effect.Effect<ReceiptTransactionResult, ReceiptFailure> =>
  Effect.gen(function* () {
    if (!authorizationMatchesCommand(authorization, command)) {
      return yield* new ReceiptDecodeError({
        message: "Receipt mutation authorization does not match the command",
      });
    }

    const principal = authorization.principal;

    const commandEnvelope = {
      schema: "ReceiptCommandRequest/v2" as const,
      principalPersonId: principal.personId,
      request: command,
    };

    const commandJson = canonicalJson(commandEnvelope);
    const commandDigest = sha256Hex(canonicalJsonBytes(commandEnvelope));

    yield* lockAdvisory(sql, AdvisoryLockKey.receiptCommand(command.commandId)).pipe(
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
      ).pipe(Effect.mapError((cause) => persistenceError("decode stored observation", cause)));

      const replayedReceipt = yield* findReceipt(sql, storedObservation.receiptId);

      if (replayedReceipt === undefined) {
        return yield* new ReceiptNotFound({ receiptId: storedObservation.receiptId });
      }

      return {
        observation: { ...storedObservation, replayed: true },
        receipt: replayedReceipt,
        replayed: true,
        outboxCount: 0,
      };
    }

    const allocation = Predicate.isTagged(command, "SubmitReceipt")
      ? yield* Schema.decodeUnknownEffect(ReceiptSubmissionAllocationSchema)(allocationInput, {
          onExcessProperty: "error",
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ReceiptDecodeError({
                message: `decode Receipt submission allocation: ${String(cause)}`,
              }),
          ),
        )
      : undefined;

    let receiptId: string;
    let previous: Receipt | undefined;
    let authorizedCommand: typeof AuthorizedReceiptCommandSchema.Type;

    if (Predicate.isTagged(command, "SubmitReceipt")) {
      if (!Predicate.isTagged(authorization, "SubmitReceipt")) {
        return yield* new ReceiptDecodeError({
          message: "Receipt submission authorization does not match the command",
        });
      }

      if (allocation === undefined) {
        return yield* new ReceiptDecodeError({
          message: "Receipt submission allocation is required",
        });
      }

      receiptId = allocation.receiptId;
      previous = yield* findReceipt(sql, receiptId);

      if (previous !== undefined) {
        return yield* new ReceiptAlreadyExists({ receiptId });
      }

      authorizedCommand = {
        ...command,
        actor: authorization.actor,
        departmentId: authorization.departmentId,
        paymentAccountCiphertext: authorization.paymentAccountCiphertext,
      };
    } else {
      if (Predicate.isTagged(authorization, "SubmitReceipt")) {
        return yield* new ReceiptDecodeError({
          message: "Existing Receipt authorization does not match the command",
        });
      }

      receiptId = command.receiptId;
      previous = authorization.current;
      authorizedCommand = { ...command, actor: authorization.actor };
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
      Effect.catchTag("SqlError", (cause) => Effect.fail(persistenceError("insert audit", cause))),
    );

    return {
      observation: decision.observation,
      receipt: decision.receipt,
      replayed: false,
      outboxCount: decision.outbox.length,
    };
  });

/**
 * Executes a mutation already authorized on the caller's transaction
 * connection. Native HTTP replay invokes authority resolution before deciding
 * whether this effect runs.
 */
export const executeAuthorizedReceiptCommand = (
  input: typeof ReceiptCommandRequestSchema.Encoded,
  authorization: ReceiptMutationAuthorization,
  allocationInput?: ReceiptSubmissionAllocation,
): Effect.Effect<ReceiptTransactionResult, ReceiptFailure, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const command = yield* decodeReceiptCommand(input);

    return yield* executeAuthorizedReceiptCommandWithSql(
      sql,
      command,
      authorization,
      allocationInput,
    );
  });

export const executeReceiptCommand = (
  input: typeof ReceiptCommandRequestSchema.Encoded,
  principalInput: typeof ReceiptCommandPrincipalSchema.Encoded,
  allocationInput?: ReceiptSubmissionAllocation,
): Effect.Effect<ReceiptTransactionResult, ReceiptFailure, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const command = yield* decodeReceiptCommand(input);
          const principal = yield* decodeReceiptPrincipal(principalInput);

          const authorization = yield* authorizeReceiptMutationWithSql(
            sql,
            targetFromCommand(command),
            principal,
          );

          return yield* executeAuthorizedReceiptCommandWithSql(
            sql,
            command,
            authorization,
            allocationInput,
          );
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("receipt transaction", cause)),
        ),
      );
  });

/** Owner-only metadata selection precedes all private-file IO. */
export const readOwnedReceiptFile = (receiptId: string, personId: string) =>
  Effect.gen(function* () {
    const sql = yield* Database;

    const rows = yield* sql`
      SELECT department_id AS "departmentId", revision, status, file_ref AS "fileRef", file_object_key AS "objectKey",
        file_content_type AS "contentType", file_byte_length::integer AS "byteLength",
        file_sha256 AS "sha256"
      FROM economy_receipts
      WHERE receipt_id = ${receiptId} AND owner_person_id = ${personId} AND status <> 'Withdrawn'
    `;

    if (rows[0] === undefined) return undefined;
    const { departmentId, revision, status, ...file } = rows[0];

    return {
      file: yield* Schema.decodeUnknownEffect(ReceiptFileSchema)(file),
      departmentId: String(departmentId),
      status: String(status),
      revision: Number(revision),
    };
  }).pipe(Effect.mapError((cause) => persistenceError("read owned receipt file", cause)));

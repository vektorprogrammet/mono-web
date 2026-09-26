import { readFile } from "node:fs/promises";
import { Effect, Predicate, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import {
  decodeReviewedReceiptSnapshot,
  importLegacyReceipts,
  Receipt,
  ReceiptCohortFailure,
  ReceiptQuarantineReason,
  receiptEvidenceDigest,
  type ReceiptImportProvenance,
  type ReceiptImportResult,
  type ReceiptReviewEntry,
  type ReceiptSourceRow,
  type ReviewedReceiptSnapshot,
} from "@vektorprogrammet/domain/receipt";
import { canonicalJson } from "@vektorprogrammet/domain/shared-kernel";
import { AdvisoryLockKey, lockAdvisory } from "../advisory-lock.js";
import { Database, type DatabaseOperations } from "../service.js";
import { lockReceiptImportSource, storeReceiptImportResult } from "./postgres.js";

export { ReceiptCohortFailure } from "@vektorprogrammet/domain/receipt";

/** The orchestration layer additionally binds its file and cryptographic implementation. */
export const receiptImportSourceDigest = async (): Promise<string> =>
  receiptEvidenceDigest(
    await Promise.all(
      [
        "./reviewed-cohort.ts",
        "./postgres.ts",
        "../../../domain/src/receipt/review.ts",
        "../../../domain/src/receipt/import.ts",
        "../../../domain/src/receipt/schema.ts",
        "../../../domain/src/time.ts",
        "../../../domain/src/shared-kernel/canonical-json.ts",
        "../../migrations/0067-reviewed-receipt-cohort.sql",
      ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
    ),
  );

type AcceptedResult = Extract<ReceiptImportResult, { readonly _tag: "AcceptedReceiptImport" }>;

type ImportEntry = Extract<ReceiptReviewEntry, { readonly _tag: "Import" }>;

export interface ResolvedReviewedReceipt {
  readonly row: ReceiptSourceRow;
  readonly entry: ImportEntry;
  readonly receiptId: string;
  readonly ownerPersonId: PersonId | null;
  readonly departmentId: DepartmentId | null;
  readonly provenance: ReceiptImportProvenance;
}

export interface ReviewedReceiptReport {
  readonly snapshotKey: string;
  readonly replay: boolean;
  readonly input: number;
  readonly accepted: number;
  readonly quarantined: number;
  readonly excluded: number;
  readonly occurrences: readonly {
    readonly sourcePrimaryKey: string;
    readonly disposition: "Accepted" | "Quarantined" | "Excluded";
    readonly reasons: readonly string[];
  }[];
  /** Private custody data: never encode this field into operator output. */
  readonly acceptedResults: readonly AcceptedResult[];
}

const ResultIdentityFields = {
  sourcePrimaryKey: Schema.String,
  sourceOccurrence: Schema.Literal(0),
  targetSemanticIdentity: Schema.String,
  provenance: Schema.Struct({
    sourceRepository: Schema.String,
    sourceRevision: Schema.String,
    snapshotId: Schema.String,
    sourceWatermark: Schema.String,
    transformationRevision: Schema.String,
    sourceDigest: Schema.String,
    destinationIdentity: Schema.String,
  }),
};

const AcceptedResultSchema = Schema.TaggedStruct("AcceptedReceiptImport", {
  ...ResultIdentityFields,
  receipt: Receipt.insert,
  reconciliation: Schema.Literal("Pending"),
});

const PreparedResultSchema = Schema.Union([
  AcceptedResultSchema,
  Schema.TaggedStruct("QuarantinedReceiptImport", {
    ...ResultIdentityFields,
    reasons: Schema.Array(ReceiptQuarantineReason).pipe(Schema.check(Schema.isMinLength(1))),
    reconciliation: Schema.Literal("NotApplicable"),
  }),
]);

const OccurrenceSchema = Schema.Struct({
  sourcePrimaryKey: Schema.String,
  disposition: Schema.Literals(["Accepted", "Quarantined", "Excluded"]),
  reasons: Schema.Array(
    Schema.Union([ReceiptQuarantineReason, Schema.Literal("ExcludedByReview")]),
  ),
  acceptedResult: Schema.NullOr(AcceptedResultSchema),
});

const References = Schema.Struct({
  departments: Schema.Array(
    Schema.Struct({ sourceDepartmentId: Schema.String, departmentId: DepartmentId }),
  ),
});

const immutable = <T>(value: T): T => {
  if (Predicate.isObjectOrArray(value)) {
    for (const item of Object.values(value)) immutable(item);
    Object.freeze(value);
  }

  return value;
};

const invalid = (code: string) => new ReceiptCohortFailure({ code });

const decodeAccepted = Schema.decodeUnknownSync(AcceptedResultSchema, {
  onExcessProperty: "error",
});

const encodeInsertedReceipt = Schema.encodeSync(Receipt.insert);

const readLedger = Effect.fnUntraced(function* (
  sql: DatabaseOperations,
  result: ReceiptImportResult,
) {
  const p = result.provenance;

  const ledger = yield* sql<{
    readonly result: "Accepted" | "Quarantined";
    readonly reasons_json: Schema.Json;
    readonly source_digest: string;
    readonly destination_identity: string;
    readonly target_semantic_identity: string;
    readonly source_watermark: string;
  }>`
    SELECT result, reasons_json, source_digest, destination_identity,
      target_semantic_identity, source_watermark
    FROM public.economy_receipt_import_ledger
    WHERE source_repository = ${p.sourceRepository} AND source_revision = ${p.sourceRevision}
      AND snapshot_id = ${p.snapshotId} AND source_primary_key = ${result.sourcePrimaryKey}
      AND source_occurrence = ${result.sourceOccurrence}
      AND transformation_revision = ${p.transformationRevision}
    FOR SHARE
  `;

  const stored = ledger[0];

  if (
    ledger.length !== 1 ||
    !stored ||
    stored.source_digest !== p.sourceDigest ||
    stored.destination_identity !== p.destinationIdentity ||
    stored.target_semantic_identity !== result.targetSemanticIdentity ||
    stored.source_watermark !== p.sourceWatermark
  )
    return yield* Effect.fail(invalid("PersistedEvidenceConflict"));

  const decoded = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ reasons: Schema.Array(ReceiptQuarantineReason) }),
  )(stored.reasons_json).pipe(Effect.mapError(() => invalid("PersistedEvidenceConflict")));

  return { disposition: stored.result, reasons: decoded.reasons };
});

const readReport = Effect.fnUntraced(function* (
  sql: DatabaseOperations,
  snapshotKey: string,
  replay: boolean,
  expectedCount: number,
): Effect.fn.Return<ReviewedReceiptReport, ReceiptCohortFailure | SqlError> {
  const rows = yield* sql`
    SELECT source_primary_key AS "sourcePrimaryKey", disposition,
      reasons_json AS reasons, accepted_result_json AS "acceptedResult"
    FROM public.receipt_cohort_occurrences WHERE snapshot_key = ${snapshotKey}
    ORDER BY source_primary_key
  `;

  const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(OccurrenceSchema))(rows).pipe(
    Effect.mapError(() => invalid("PersistedEvidenceConflict")),
  );

  if (decoded.length !== expectedCount)
    return yield* Effect.fail(invalid("PersistedEvidenceConflict"));
  const counts = { Accepted: 0, Quarantined: 0, Excluded: 0 };
  const acceptedResults: AcceptedResult[] = [];

  for (const row of decoded) {
    counts[row.disposition] += 1;

    if (row.disposition === "Accepted") {
      if (
        row.acceptedResult === null ||
        row.acceptedResult.sourcePrimaryKey !== row.sourcePrimaryKey
      )
        return yield* Effect.fail(invalid("PersistedEvidenceConflict"));
      const persisted = yield* readLedger(sql, row.acceptedResult);

      if (persisted.disposition !== "Accepted" || persisted.reasons.length !== 0)
        return yield* Effect.fail(invalid("PersistedEvidenceConflict"));
      acceptedResults.push(row.acceptedResult);
    } else if (row.acceptedResult !== null) {
      return yield* Effect.fail(invalid("PersistedEvidenceConflict"));
    }
  }

  return {
    snapshotKey,
    replay,
    input: decoded.length,
    accepted: counts.Accepted,
    quarantined: counts.Quarantined,
    excluded: counts.Excluded,
    occurrences: decoded.map(({ acceptedResult: _acceptedResult, ...row }) => row),
    acceptedResults,
  };
});

const resolveEvidence = Effect.fnUntraced(function* (
  sql: DatabaseOperations,
  snapshot: ReviewedReceiptSnapshot,
) {
  const r = snapshot.review;

  const personSnapshots = yield* sql`
    SELECT snapshot_key FROM public.person_cohort_snapshots
    WHERE snapshot_key = ${r.personSnapshotKey} AND source_repository = ${r.sourceRepository}
      AND source_revision = ${r.sourceRevision} FOR SHARE
  `;

  if (personSnapshots.length !== 1) return yield* Effect.fail(invalid("PersonSnapshotConflict"));

  const references = yield* sql<{
    readonly source_revision: string;
    readonly reference_digest: string;
    readonly source_id_mappings: Schema.Json;
  }>`
    SELECT source_revision, reference_digest, source_id_mappings
    FROM public.historical_service_reference_provenance
    WHERE source_repository = ${r.sourceRepository} AND snapshot_id = ${r.referenceSnapshotId}
    FOR SHARE
  `;

  const reference = references[0];

  if (
    !reference ||
    reference.source_revision !== r.sourceRevision ||
    reference.reference_digest !== r.referenceDigest
  )
    return yield* Effect.fail(invalid("ReferenceProvenanceConflict"));

  const mappings = yield* Schema.decodeUnknownEffect(References)(reference.source_id_mappings).pipe(
    Effect.mapError(() => invalid("ReferenceProvenanceConflict")),
  );

  const departments = new Map(
    mappings.departments.map((row) => [row.sourceDepartmentId, row.departmentId]),
  );

  if (departments.size !== mappings.departments.length)
    return yield* Effect.fail(invalid("ReferenceProvenanceConflict"));

  const people = yield* sql<{
    readonly occurrence_id: string;
    readonly source_user_id: string;
    readonly person_id: string;
  }>`
    SELECT a.occurrence_id, a.source_user_id, i.person_id
    FROM public.person_cohort_accepted_mappings a
    JOIN public.person_cohort_imports i USING (source_repository, source_user_id)
    JOIN public.person_cohort_occurrences o ON o.snapshot_key = a.snapshot_key AND o.occurrence_id = a.occurrence_id
    JOIN public.person_profiles p ON p.person_id = i.person_id
    WHERE a.snapshot_key = ${r.personSnapshotKey} AND a.source_repository = ${r.sourceRepository}
      AND o.disposition = 'Accepted' FOR SHARE OF a, i, o, p
  `;

  const acceptedPeople = new Map(people.map((row) => [row.occurrence_id, row]));

  const nativeDepartments = yield* sql<{ readonly department_id: string }>`
    SELECT department_id FROM public.organization_departments FOR SHARE
  `;

  const nativeDepartmentIds = new Set(nativeDepartments.map((row) => row.department_id));
  const rows = new Map(snapshot.rows.map((row) => [row.sourcePrimaryKey, row]));
  const resolved: ResolvedReviewedReceipt[] = [];

  for (const entry of r.entries) {
    if (!Predicate.isTagged(entry, "Import")) continue;
    const row = rows.get(entry.sourcePrimaryKey)!;

    const person =
      entry.person === null ? undefined : acceptedPeople.get(entry.person.occurrenceId);

    const ownerPersonId =
      person !== undefined &&
      entry.person !== null &&
      person.source_user_id === row.sourceUserId &&
      person.source_user_id === entry.person.sourceUserId &&
      person.person_id === entry.person.personId
        ? PersonId.make(person.person_id)
        : null;

    const departmentId =
      departments.get(entry.department.sourceDepartmentId) === entry.department.departmentId &&
      nativeDepartmentIds.has(entry.department.departmentId)
        ? entry.department.departmentId
        : null;

    const receiptId = `receipt-${receiptEvidenceDigest([r.sourceRepository, row.sourcePrimaryKey])}`;
    resolved.push({
      row,
      entry,
      receiptId,
      ownerPersonId,
      departmentId,
      provenance: {
        sourceRepository: r.sourceRepository,
        sourceRevision: r.sourceRevision,
        snapshotId: r.snapshotId,
        sourceWatermark: r.sourceWatermark,
        transformationRevision: r.transformationRevision,
        sourceDigest: entry.sourceRowDigest,
        destinationIdentity: receiptId,
      },
    });
  }

  return immutable(resolved);
});

/** Verify callback identities and classify accepted facts again from trusted review values. */
const validatePrepared = (
  resolved: readonly ResolvedReviewedReceipt[],
  input: readonly ReceiptImportResult[],
): readonly ReceiptImportResult[] => {
  const results = immutable(
    Schema.decodeUnknownSync(Schema.Array(PreparedResultSchema))(structuredClone(input), {
      onExcessProperty: "error",
    }),
  );

  const bySource = new Map(results.map((result) => [result.sourcePrimaryKey, result]));

  if (results.length !== resolved.length || bySource.size !== resolved.length)
    throw invalid("InvalidPreparedResults");

  const classified = importLegacyReceipts(
    resolved.map((item) => {
      const result = bySource.get(item.row.sourcePrimaryKey);

      if (
        !result ||
        result.sourceOccurrence !== 0 ||
        canonicalJson(result.provenance) !== canonicalJson(item.provenance)
      )
        throw invalid("InvalidPreparedResults");

      const accepted = Predicate.isTagged(result, "AcceptedReceiptImport")
        ? decodeAccepted(result)
        : null;

      if (
        Predicate.isTagged(result, "QuarantinedReceiptImport") &&
        item.entry.payment.commitment === null &&
        !result.reasons.includes("MissingPaymentAccount")
      )
        throw invalid("InvalidPreparedResults");

      if (
        accepted !== null &&
        (item.entry.payment.commitment === null ||
          accepted.receipt.file.sha256 !== item.entry.file.sha256 ||
          accepted.receipt.file.byteLength !== item.entry.file.byteLength ||
          accepted.receipt.file.contentType !== item.entry.file.contentType)
      )
        throw invalid("InvalidPreparedResults");

      return {
        receiptId: item.receiptId,
        provenance: item.provenance,
        row: {
          sourcePrimaryKey: item.row.sourcePrimaryKey,
          ownerPersonId: item.ownerPersonId,
          departmentId: item.departmentId,
          visualId: item.row.visualId,
          amountDecimal: item.row.amountDecimal,
          description: item.row.description,
          receiptDate: item.entry.receiptDate,
          submittedAt: item.entry.submittedAt,
          status: item.row.status,
          refundDate: item.entry.approvedAt,
          paymentAccountCiphertext: accepted?.receipt.paymentAccountCiphertext ?? null,
          file: accepted?.receipt.file ?? null,
        },
      };
    }),
  );

  for (const expected of classified) {
    const actual = bySource.get(expected.sourcePrimaryKey)!;

    if (
      actual.targetSemanticIdentity !== expected.targetSemanticIdentity ||
      (Predicate.isTagged(actual, "AcceptedReceiptImport") &&
        !(
          Predicate.isTagged(expected, "AcceptedReceiptImport") &&
          canonicalJson(actual) ===
            canonicalJson({ ...expected, receipt: encodeInsertedReceipt(expected.receipt) })
        ))
    )
      throw invalid("InvalidPreparedResults");

    // A quarantine does not retain custody objects. Their absence here cannot
    // erase intrinsic owner, amount, date, status, or batch-collision findings.
    if (
      Predicate.isTagged(actual, "QuarantinedReceiptImport") &&
      Predicate.isTagged(expected, "QuarantinedReceiptImport") &&
      expected.reasons.some(
        (reason) =>
          reason !== "MissingFile" &&
          reason !== "MissingPaymentAccount" &&
          !actual.reasons.includes(reason),
      )
    )
      throw invalid("InvalidPreparedResults");
  }

  return results;
};

const entryReviewDigest = (snapshot: ReviewedReceiptSnapshot, entry: ReceiptReviewEntry) =>
  receiptEvidenceDigest({
    entry,
    attestedBy: snapshot.review.attestedBy,
    evidenceRef: snapshot.review.evidenceRef,
    referenceDigest: snapshot.review.referenceDigest,
  });

/** SQL owns the cohort; private staging runs only after immutable provenance preflight. */
export const importReviewedReceiptCohort = Effect.fn("importReviewedReceiptCohort")(function* (
  input: ReviewedReceiptSnapshot,
  prepare: (
    rows: readonly ResolvedReviewedReceipt[],
  ) => Effect.Effect<readonly ReceiptImportResult[], ReceiptCohortFailure>,
): Effect.fn.Return<ReviewedReceiptReport, ReceiptCohortFailure, Database> {
  const snapshot = yield* Effect.try({
    try: () => immutable(decodeReviewedReceiptSnapshot(structuredClone(input))),
    catch: (error) => (error instanceof ReceiptCohortFailure ? error : invalid("InvalidSnapshot")),
  });

  const r = snapshot.review;
  const snapshotKey = receiptEvidenceDigest([r.sourceRepository, r.snapshotId]);
  const snapshotDigest = receiptEvidenceDigest(snapshot);
  const sql = yield* Database;

  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* lockAdvisory(sql, AdvisoryLockKey.reviewedReceiptImport);

        const sourceKeys = snapshot.rows.map((row) => row.sourcePrimaryKey).sort();

        for (const sourceKey of sourceKeys)
          yield* lockReceiptImportSource(sql, r.sourceRepository, sourceKey);

        const prior = yield* sql<{ readonly snapshot_digest: string }>`
      SELECT snapshot_digest FROM public.receipt_cohort_snapshots WHERE snapshot_key = ${snapshotKey}
    `;

        if (prior[0]) {
          if (prior[0].snapshot_digest !== snapshotDigest)
            return yield* Effect.fail(invalid("SnapshotConflict"));

          return yield* readReport(sql, snapshotKey, true, snapshot.rows.length);
        }

        const resolved = yield* resolveEvidence(sql, snapshot);
        const resolvedBySource = new Map(resolved.map((row) => [row.row.sourcePrimaryKey, row]));

        const bindings = yield* sql<{
          readonly source_primary_key: string;
          readonly source_digest: string;
          readonly review_digest: string;
          readonly transformation_revision: string;
          readonly accepted_result_json: Schema.Json;
        }>`
      SELECT b.source_primary_key, b.source_digest, b.review_digest, b.transformation_revision,
        o.accepted_result_json
      FROM public.receipt_cohort_source_bindings b
      JOIN public.receipt_cohort_occurrences o USING (snapshot_key, source_primary_key)
      WHERE b.source_repository = ${r.sourceRepository} FOR SHARE OF b, o
    `;

        const boundSources = new Map(bindings.map((row) => [row.source_primary_key, row]));
        const reused = new Map<string, AcceptedResult>();

        for (const entry of r.entries) {
          const binding = boundSources.get(entry.sourcePrimaryKey);

          if (!binding) continue;

          if (
            binding.source_digest !== entry.sourceRowDigest ||
            binding.review_digest !== entryReviewDigest(snapshot, entry) ||
            binding.transformation_revision !== r.transformationRevision
          )
            return yield* Effect.fail(invalid("SourceConflict"));

          const accepted = yield* Effect.try({
            try: () => decodeAccepted(binding.accepted_result_json),
            catch: () => invalid("PersistedEvidenceConflict"),
          });

          const current = resolvedBySource.get(entry.sourcePrimaryKey);

          if (
            !current ||
            current.ownerPersonId !== accepted.receipt.ownerPersonId ||
            current.departmentId !== accepted.receipt.departmentId ||
            current.receiptId !== accepted.receipt.receiptId ||
            accepted.sourcePrimaryKey !== entry.sourcePrimaryKey
          )
            return yield* Effect.fail(invalid("SourceConflict"));
          reused.set(entry.sourcePrimaryKey, accepted);
        }

        // Never adopt an earlier native acceptance without its immutable original
        // fact snapshot. Native edits make reconstructing that history unsound.
        const nativeOwners = yield* sql<{
          readonly source_primary_key: string;
          readonly destination_identity: string;
          readonly source_revision: string;
          readonly snapshot_id: string;
          readonly source_occurrence: number;
          readonly transformation_revision: string;
          readonly source_digest: string;
          readonly source_watermark: string;
          readonly target_semantic_identity: string;
        }>`
      SELECT source_primary_key, destination_identity, source_revision, snapshot_id,
        source_occurrence, transformation_revision, source_digest, source_watermark, target_semantic_identity
      FROM public.economy_receipt_import_ledger
      WHERE source_repository = ${r.sourceRepository} AND result = 'Accepted'
        AND ${sql.in("source_primary_key", sourceKeys)} FOR SHARE
    `;

        const ownedSources = new Set<string>();

        for (const owner of nativeOwners) {
          const accepted = reused.get(owner.source_primary_key);

          if (
            !accepted ||
            ownedSources.has(owner.source_primary_key) ||
            owner.destination_identity !== accepted.provenance.destinationIdentity ||
            owner.source_revision !== accepted.provenance.sourceRevision ||
            owner.snapshot_id !== accepted.provenance.snapshotId ||
            owner.source_occurrence !== accepted.sourceOccurrence ||
            owner.transformation_revision !== accepted.provenance.transformationRevision ||
            owner.source_digest !== accepted.provenance.sourceDigest ||
            owner.source_watermark !== accepted.provenance.sourceWatermark ||
            owner.target_semantic_identity !== accepted.targetSemanticIdentity
          )
            return yield* Effect.fail(invalid("SourceConflict"));
          ownedSources.add(owner.source_primary_key);
        }

        if (ownedSources.size !== reused.size) return yield* Effect.fail(invalid("SourceConflict"));

        // Persist the immutable review before invoking any filesystem-writing callback.
        yield* sql`
      INSERT INTO public.receipt_cohort_snapshots (
        snapshot_key, source_repository, snapshot_id, source_revision, receipt_source_revision,
        source_watermark, transformation_revision, person_snapshot_key, reference_snapshot_id,
        reference_digest, snapshot_digest, review_json, occurrence_count
      ) VALUES (
        ${snapshotKey}, ${r.sourceRepository}, ${r.snapshotId}, ${r.sourceRevision}, ${r.receiptSourceRevision},
        ${r.sourceWatermark}, ${r.transformationRevision}, ${r.personSnapshotKey}, ${r.referenceSnapshotId},
        ${r.referenceDigest}, ${snapshotDigest}, ${sql.json(r)}, ${snapshot.rows.length}
      )
    `;
        const fresh = immutable(resolved.filter((row) => !reused.has(row.row.sourcePrimaryKey)));
        const prepared = fresh.length === 0 ? [] : yield* prepare(fresh);

        const checked = yield* Effect.try({
          try: () => validatePrepared(fresh, prepared),
          catch: () => invalid("InvalidPreparedResults"),
        });

        const results = new Map(checked.map((result) => [result.sourcePrimaryKey, result]));

        for (const entry of r.entries) {
          let disposition: "Accepted" | "Quarantined" | "Excluded" = "Excluded";

          let reasons: readonly string[] = Predicate.isTagged(entry, "Excluded")
            ? ["ExcludedByReview"]
            : [];

          let accepted: AcceptedResult | null = null;

          if (Predicate.isTagged(entry, "Import")) {
            const result =
              reused.get(entry.sourcePrimaryKey) ?? results.get(entry.sourcePrimaryKey)!;

            if (!reused.has(entry.sourcePrimaryKey)) yield* storeReceiptImportResult(result);
            const persisted = yield* readLedger(sql, result);
            disposition = persisted.disposition;
            reasons = persisted.reasons;

            if (disposition === "Accepted") {
              if (!Predicate.isTagged(result, "AcceptedReceiptImport"))
                return yield* Effect.fail(invalid("PersistedEvidenceConflict"));
              accepted = result;
            }
          }

          yield* sql`
        INSERT INTO public.receipt_cohort_occurrences (
          snapshot_key, source_primary_key, source_row_digest, disposition, reasons_json, accepted_result_json
        ) VALUES (
          ${snapshotKey}, ${entry.sourcePrimaryKey}, ${entry.sourceRowDigest}, ${disposition},
          ${sql.json(reasons)}, ${accepted === null ? null : sql.json(Schema.encodeSync(AcceptedResultSchema)(decodeAccepted(accepted)))}
        )
      `;

          if (accepted !== null && !reused.has(entry.sourcePrimaryKey))
            yield* sql`
        INSERT INTO public.receipt_cohort_source_bindings (
          source_repository, source_primary_key, source_digest, review_digest,
          transformation_revision, destination_identity, snapshot_key
        ) VALUES (
          ${r.sourceRepository}, ${entry.sourcePrimaryKey}, ${entry.sourceRowDigest},
          ${entryReviewDigest(snapshot, entry)}, ${r.transformationRevision},
          ${accepted.receipt.receiptId}, ${snapshotKey}
        )
      `;
        }

        return yield* readReport(sql, snapshotKey, false, snapshot.rows.length);
      }),
    )
    .pipe(
      Effect.mapError((error) =>
        error instanceof ReceiptCohortFailure ? error : invalid("PersistenceFailure"),
      ),
      Effect.catchDefect(() => Effect.fail(invalid("PersistenceFailure"))),
    );
});

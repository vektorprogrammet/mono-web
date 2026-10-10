/**
 * EX-0021: required public native SQL APIs in exact stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import { Data, Effect, FileSystem, flow, Option, Path, Schema } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { AdvisoryLockKey, lockAdvisory } from "../advisory-lock.js";
import { withTypedTransactionFailures } from "../service.js";
import {
  canonicalJson,
  canonicalJsonBytes,
  sha256Hex,
} from "@vektorprogrammet/domain/shared-kernel";
import { DepartmentId, SemesterId } from "@vektorprogrammet/domain/organization";
import { SchoolId } from "@vektorprogrammet/domain/schools";

import {
  CurrentAssignmentReview,
  CurrentAssignmentSnapshot,
  ReconciledCurrentAssignmentSnapshot,
} from "@vektorprogrammet/domain/placements";

export const currentAssignmentImportSourceDigest = Effect.fn("currentAssignmentImportSourceDigest")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const sources = yield* Effect.forEach(
      [
        new URL("./current-assignment-cohort.ts", import.meta.url),
        new URL(
          "current-assignment-contracts.ts",
          import.meta.resolve("@vektorprogrammet/domain/placements"),
        ),
      ],
      (url) => Effect.flatMap(path.fromFileUrl(url), (file) => fs.readFileString(file)),
      { concurrency: "unbounded" },
    );

    return digest(sources);
  },
);

const Id = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/)));

const Digest = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)));

const Day = Schema.Literals(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);

const Block = Schema.Literals(["1", "2", "Both"]);

const LegacyAssignmentRow = Schema.Struct({
  sourceAssignmentId: Id,
  sourceRowDigest: Digest,
  sourceUserId: Id,
  sourceDepartmentId: Id,
  sourceSemesterId: Id,
  sourceSchoolId: Id,
  affiliationEvidenceRef: Id,
  placementEvidenceRef: Id,
  day: Day,
  workdays: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(1)),
    Schema.check(Schema.isLessThanOrEqualTo(8)),
  ),
  block: Block,
  active: Schema.Boolean,
});

type AssignmentSnapshot = CurrentAssignmentSnapshot | ReconciledCurrentAssignmentSnapshot;

type CurrentAssignmentMapping = CurrentAssignmentSnapshot["mappings"][number];

type LegacyAssignmentRow = typeof LegacyAssignmentRow.Type;

type NativeBlock = "1" | "2" | "Both";

export class CurrentAssignmentFailure extends Data.TaggedError("CurrentAssignmentFailure")<{
  readonly code:
    | "InvalidSnapshot"
    | "SnapshotConflict"
    | "SourceIdentityConflict"
    | "ReferenceProvenanceMissing"
    | "ReferenceProvenanceConflict"
    | "PersonSnapshotConflict"
    | "PersistenceFailure";
}> {
  override get message(): string {
    return this.code;
  }
}

const CurrentAssignmentReason = Schema.Literals([
  "Imported",
  "ExactReplay",
  "InvalidRow",
  "Inactive",
  "DuplicateSource",
  "MappingMissing",
  "MappingAmbiguous",
  "SourceReferenceMismatch",
  "PersonReconciliationMissing",
  "NativeReferenceMissing",
  "SchoolDepartmentMismatch",
  "DuplicateTarget",
  "PlacementOverlap",
  "TargetConflict",
]);

export type CurrentAssignmentReason = typeof CurrentAssignmentReason.Type;

export interface CurrentAssignmentOccurrence {
  readonly occurrenceId: string;
  readonly disposition: "Accepted" | "Quarantined";
  readonly reason: CurrentAssignmentReason;
}

const decodeOccurrenceRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      occurrenceId: Schema.String,
      disposition: Schema.Literals(["Accepted", "Quarantined"]),
      reason: CurrentAssignmentReason,
    }),
  ),
);

export interface CurrentAssignmentReport {
  readonly snapshotKey: string;
  readonly input: number;
  readonly accepted: number;
  readonly quarantined: number;
  readonly occurrences: ReadonlyArray<CurrentAssignmentOccurrence>;
  readonly currentState: "EstablishedThroughCanonicalAffiliationAndPlacement";
  readonly audit: "ImportProvenanceOnly";
}

const digest = flow(canonicalJsonBytes, sha256Hex);

const declaredSnapshotDigest = (snapshot: AssignmentSnapshot): string => {
  const { snapshotDigest: _snapshotDigest, ...unsignedSnapshot } = snapshot;

  return digest(unsignedSnapshot);
};

export const currentAssignmentPlacementId = (
  sourceRepository: string,
  sourceAssignmentId: string,
): string =>
  `placement-${digest(["current-assignment-placement", sourceRepository, sourceAssignmentId])}`;

const sourceIdOf = flow(
  Schema.decodeUnknownOption(Schema.Struct({ sourceAssignmentId: Schema.String })),
  Option.map((row) => row.sourceAssignmentId),
  Option.getOrUndefined,
);

const increment = (counts: Map<string, number>, key: string | undefined) => {
  if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
};

const sourceRowDigest = ({
  sourceRowDigest: _sourceRowDigest,
  ...row
}: LegacyAssignmentRow): string => digest(row);

const targetSlots = (
  mapping: CurrentAssignmentMapping,
  block: NativeBlock,
): ReadonlyArray<string> =>
  (block === "Both" ? (["1", "2"] as const) : [block]).map((slot) =>
    canonicalJson([mapping.personId, mapping.schoolId, mapping.semesterId, slot]),
  );

const referencesMatch = (row: LegacyAssignmentRow, mapping: CurrentAssignmentMapping): boolean =>
  row.sourceAssignmentId === mapping.sourceAssignmentId &&
  row.sourceUserId === mapping.sourceUserId &&
  row.sourceDepartmentId === mapping.sourceDepartmentId &&
  row.sourceSemesterId === mapping.sourceSemesterId &&
  row.sourceSchoolId === mapping.sourceSchoolId;

export const decodeCurrentAssignmentSnapshot = flow(
  Schema.decodeUnknownOption(CurrentAssignmentSnapshot, { onExcessProperty: "error" }),
  Option.getOrThrowWith(() => new CurrentAssignmentFailure({ code: "InvalidSnapshot" })),
  (snapshot) => {
    try {
      if (
        new Set(snapshot.occurrences.map(({ occurrenceId }) => occurrenceId)).size !==
          snapshot.occurrences.length ||
        snapshot.snapshotDigest !== declaredSnapshotDigest(snapshot)
      )
        throw new Error();

      return snapshot;
    } catch {
      throw new CurrentAssignmentFailure({ code: "InvalidSnapshot" });
    }
  },
);

const ReviewedAssignmentEnvelope = Schema.Struct({
  sourceAssignmentId: Id,
  sourceSemesterId: Id,
  sourceRowDigest: Digest,
  active: Schema.Boolean,
  affiliationEvidenceRef: Id,
  placementEvidenceRef: Id,
  block: Schema.Unknown,
});

export const decodeReconciledCurrentAssignmentSnapshot = flow(
  Schema.decodeUnknownOption(ReconciledCurrentAssignmentSnapshot, { onExcessProperty: "error" }),
  Option.getOrThrowWith(() => new CurrentAssignmentFailure({ code: "InvalidSnapshot" })),
  (snapshot) => {
    try {
      const review = snapshot.review;
      const entries = new Map(review.assignments.map((entry) => [entry.sourceAssignmentId, entry]));
      const sourceIds = new Set<string>();

      if (
        snapshot.snapshotDigest !== declaredSnapshotDigest(snapshot) ||
        review.sourceRevision !== snapshot.sourceRevision ||
        review.sourceWatermark !== snapshot.sourceWatermark ||
        review.assignments.length !== snapshot.occurrences.length ||
        new Set(snapshot.occurrences.map(({ occurrenceId }) => occurrenceId)).size !==
          snapshot.occurrences.length
      )
        throw new Error();

      for (const occurrence of snapshot.occurrences) {
        // Invalid operational values remain available for quarantine, but review identity cannot vary.
        const row = Option.getOrThrowWith(
          Schema.decodeUnknownOption(ReviewedAssignmentEnvelope)(occurrence.row),
          () => new CurrentAssignmentFailure({ code: "InvalidSnapshot" }),
        );

        const entry = entries.get(row.sourceAssignmentId);

        if (
          sourceIds.has(row.sourceAssignmentId) ||
          !entry ||
          row.sourceSemesterId !== review.sourceSemesterId ||
          row.active !== entry.active ||
          row.affiliationEvidenceRef !== entry.affiliationEvidenceRef ||
          row.placementEvidenceRef !== entry.placementEvidenceRef ||
          (row.active && row.block === "Both" && entry.bothBlocksShareDay !== true)
        )
          throw new Error();
        sourceIds.add(row.sourceAssignmentId);
      }

      if (
        snapshot.mappings.some(
          (mapping) =>
            !sourceIds.has(mapping.sourceAssignmentId) ||
            mapping.sourceSemesterId !== review.sourceSemesterId,
        )
      )
        throw new Error();

      return snapshot;
    } catch {
      throw new CurrentAssignmentFailure({ code: "InvalidSnapshot" });
    }
  },
);

const rowDigestMatches = (row: LegacyAssignmentRow): boolean =>
  row.sourceRowDigest === sourceRowDigest(row);

const assignmentSourceDigest = (
  snapshot: AssignmentSnapshot,
  row: LegacyAssignmentRow,
  mapping: CurrentAssignmentMapping,
): string =>
  snapshot.synthetic
    ? digest({ row, mapping })
    : digest({
        row,
        mapping,
        review: snapshot.review,
        referenceDigest: snapshot.referenceDigest,
        personSnapshotKey: snapshot.personSnapshotKey,
      });

const ReferenceMappings = Schema.Struct({
  departments: Schema.Array(Schema.Struct({ sourceDepartmentId: Id, departmentId: DepartmentId })),
  semesters: Schema.Array(Schema.Struct({ sourceSemesterId: Id, semesterId: SemesterId })),
  schools: Schema.Array(Schema.Struct({ sourceSchoolId: Id, schoolId: SchoolId })),
  relationships: Schema.Array(
    Schema.Struct({
      sourceDepartmentId: Id,
      sourceSchoolId: Id,
      departmentId: DepartmentId,
      schoolId: SchoolId,
    }),
  ),
});

const encodeReview = Schema.encodeEffect(Schema.fromJsonString(CurrentAssignmentReview));

const decodeProvenanceRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      source_revision: Schema.String,
      reference_digest: Schema.String,
      source_id_mappings: Schema.Unknown,
    }),
  ),
);

const decodeSnapshotRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ snapshot_digest: Schema.String })),
);

const decodeImportRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ source_assignment_id: Schema.String, source_digest: Schema.String }),
  ),
);

const decodeReferenceRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      department_exists: Schema.Boolean,
      semester_exists: Schema.Boolean,
      school_active: Schema.Boolean,
      school_department_exists: Schema.Boolean,
    }),
  ),
);

const decodeAffiliationRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ status: Schema.String, revision: Schema.Int })),
);

const decodeAffiliationProvenanceRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ source_repository: Schema.String })),
);

const validateReconciledProvenance = Effect.fnUntraced(function* (
  tx: SqlClient.SqlClient,
  snapshot: ReconciledCurrentAssignmentSnapshot,
) {
  const evidence = (yield* tx
    .unsafe<{
      source_revision: string;
      reference_digest: string;
      source_id_mappings: unknown;
    }>(
      `SELECT source_revision, reference_digest, source_id_mappings
     FROM public.historical_service_reference_provenance
    WHERE source_repository = $1 AND snapshot_id = $2 FOR SHARE`,
      [snapshot.sourceRepository, snapshot.snapshotId],
    )
    .pipe(Effect.flatMap(decodeProvenanceRows)))[0];

  if (!evidence) return yield* new CurrentAssignmentFailure({ code: "ReferenceProvenanceMissing" });

  if (
    evidence.source_revision !== snapshot.sourceRevision ||
    evidence.reference_digest !== snapshot.referenceDigest
  )
    return yield* new CurrentAssignmentFailure({ code: "ReferenceProvenanceConflict" });

  const parsed = Schema.decodeUnknownOption(ReferenceMappings)(evidence.source_id_mappings, {
    onExcessProperty: "error",
  });

  if (Option.isNone(parsed))
    return yield* new CurrentAssignmentFailure({ code: "ReferenceProvenanceConflict" });
  const references = parsed.value;

  const departments = new Map(
    references.departments.map(({ sourceDepartmentId, departmentId }) => [
      sourceDepartmentId,
      departmentId,
    ]),
  );

  const semesters = new Map(
    references.semesters.map(({ sourceSemesterId, semesterId }) => [sourceSemesterId, semesterId]),
  );

  const schools = new Map(
    references.schools.map(({ sourceSchoolId, schoolId }) => [sourceSchoolId, schoolId]),
  );

  const relationships = new Set(
    references.relationships.map(({ sourceDepartmentId, sourceSchoolId }) =>
      canonicalJson([sourceDepartmentId, sourceSchoolId]),
    ),
  );

  const semesterId = semesters.get(snapshot.review.sourceSemesterId);

  if (
    departments.size !== references.departments.length ||
    semesters.size !== references.semesters.length ||
    schools.size !== references.schools.length ||
    relationships.size !== references.relationships.length ||
    !semesterId ||
    references.relationships.some(
      ({ sourceDepartmentId, sourceSchoolId, departmentId, schoolId }) =>
        departments.get(sourceDepartmentId) !== departmentId ||
        schools.get(sourceSchoolId) !== schoolId,
    ) ||
    snapshot.mappings.some(
      (mapping) =>
        departments.get(mapping.sourceDepartmentId) !== mapping.departmentId ||
        semesters.get(mapping.sourceSemesterId) !== mapping.semesterId ||
        schools.get(mapping.sourceSchoolId) !== mapping.schoolId,
    )
  )
    return yield* new CurrentAssignmentFailure({ code: "ReferenceProvenanceConflict" });

  const semester = yield* tx.unsafe(
    `SELECT 1 FROM public.admission_period_semesters
    WHERE semester_id = $1
      AND $2::date BETWEEN (start_at AT TIME ZONE 'UTC')::date AND (end_at AT TIME ZONE 'UTC')::date
    FOR SHARE`,
    [semesterId, snapshot.review.asOf],
  );

  if (!semester.length) return yield* new CurrentAssignmentFailure({ code: "InvalidSnapshot" });

  const personSnapshot = yield* tx.unsafe(
    `SELECT 1 FROM public.person_cohort_snapshots
    WHERE snapshot_key = $1 AND source_repository = $2 AND source_revision = $3 AND snapshot_id = $4
    FOR SHARE`,
    [
      snapshot.personSnapshotKey,
      snapshot.sourceRepository,
      snapshot.sourceRevision,
      snapshot.snapshotId,
    ],
  );

  if (!personSnapshot.length)
    return yield* new CurrentAssignmentFailure({ code: "PersonSnapshotConflict" });

  return relationships;
});

const cohortReport = (tx: SqlClient.SqlClient, snapshotKey: string) =>
  tx
    .unsafe<CurrentAssignmentOccurrence>(
      `SELECT occurrence_id AS "occurrenceId", disposition, reason
     FROM public.current_assignment_occurrences
    WHERE snapshot_key = $1
    ORDER BY occurrence_id`,
      [snapshotKey],
    )
    .pipe(
      Effect.flatMap(decodeOccurrenceRows),
      Effect.map((rows): CurrentAssignmentReport => {
        const accepted = rows.filter(({ disposition }) => disposition === "Accepted").length;

        return {
          snapshotKey,
          input: rows.length,
          accepted,
          quarantined: rows.length - accepted,
          occurrences: rows,
          currentState: "EstablishedThroughCanonicalAffiliationAndPlacement",
          audit: "ImportProvenanceOnly",
        };
      }),
    );

/** Canonical current facts and immutable provenance commit together; nested reports are provisional until the caller commits. */
const importAssignmentCohort = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  snapshot: AssignmentSnapshot,
) {
  const snapshotKey = digest([snapshot.sourceRepository, snapshot.snapshotId]);
  const snapshotDigest = snapshot.snapshotDigest;

  const decoded = snapshot.occurrences.map((occurrence) => ({
    ...occurrence,
    value: Option.getOrUndefined(
      Schema.decodeUnknownOption(LegacyAssignmentRow)(occurrence.row, {
        onExcessProperty: "error",
      }),
    ),
  }));

  const mappingsBySource = new Map<string, CurrentAssignmentMapping[]>();

  for (const mapping of snapshot.mappings) {
    const mappings = mappingsBySource.get(mapping.sourceAssignmentId);

    if (mappings === undefined) mappingsBySource.set(mapping.sourceAssignmentId, [mapping]);
    else mappings.push(mapping);
  }

  const sourceCounts = new Map<string, number>();
  const targetCounts = new Map<string, number>();

  for (const occurrence of decoded) {
    increment(sourceCounts, sourceIdOf(occurrence.row));
  }

  const importInTransaction = Effect.fnUntraced(function* (tx: SqlClient.SqlClient) {
    yield* lockAdvisory(tx, AdvisoryLockKey.currentAssignmentImport);

    const prior = yield* tx
      .unsafe<{ snapshot_digest: string }>(
        `SELECT snapshot_digest FROM public.current_assignment_snapshots WHERE snapshot_key = $1`,
        [snapshotKey],
      )
      .pipe(Effect.flatMap(decodeSnapshotRows));

    if (prior[0] && prior[0].snapshot_digest !== snapshotDigest)
      return yield* new CurrentAssignmentFailure({ code: "SnapshotConflict" });

    const sourceRelationships = snapshot.synthetic
      ? undefined
      : yield* validateReconciledProvenance(tx, snapshot);

    if (prior[0]) {
      if (!snapshot.synthetic) {
        const review = yield* tx.unsafe(
          `SELECT 1 FROM public.current_assignment_reviews
          WHERE snapshot_key = $1 AND reference_digest = $2 AND person_snapshot_key = $3
            AND source_semester_id = $4 AND as_of = $5::date AND review = $6::jsonb`,
          [
            snapshotKey,
            snapshot.referenceDigest,
            snapshot.personSnapshotKey,
            snapshot.review.sourceSemesterId,
            snapshot.review.asOf,
            yield* encodeReview(snapshot.review),
          ],
        );

        if (!review.length)
          return yield* new CurrentAssignmentFailure({ code: "SnapshotConflict" });
      }

      return yield* cohortReport(tx, snapshotKey);
    }

    for (const occurrence of decoded) {
      const row = occurrence.value;

      if (!row?.active || !rowDigestMatches(row)) continue;
      const mappings = mappingsBySource.get(row.sourceAssignmentId) ?? [];

      if (mappings.length !== 1 || !referencesMatch(row, mappings[0]!)) continue;

      if (
        sourceRelationships &&
        !sourceRelationships.has(canonicalJson([row.sourceDepartmentId, row.sourceSchoolId]))
      )
        continue;

      for (const slot of targetSlots(mappings[0]!, row.block)) increment(targetCounts, slot);
    }

    // Share the canonical writer protocol before reading or writing any target state.
    yield* tx`SELECT department_id FROM public.organization_departments
      WHERE ${tx.in("department_id", [...new Set(snapshot.mappings.map(({ departmentId }) => departmentId))].sort())}
      ORDER BY department_id FOR UPDATE`;

    const acceptedImports = yield* tx
      .unsafe<{
        source_assignment_id: string;
        source_digest: string;
      }>(
        `SELECT source_assignment_id, source_digest
       FROM public.current_assignment_imports
      WHERE source_repository = $1`,
        [snapshot.sourceRepository],
      )
      .pipe(Effect.flatMap(decodeImportRows));

    const importedBySource = new Map(
      acceptedImports.map((row) => [row.source_assignment_id, row.source_digest] as const),
    );

    for (const occurrence of decoded) {
      const sourceAssignmentId = sourceIdOf(occurrence.row);

      const previousDigest = sourceAssignmentId
        ? importedBySource.get(sourceAssignmentId)
        : undefined;

      if (previousDigest === undefined) continue;
      const mappings = sourceAssignmentId ? (mappingsBySource.get(sourceAssignmentId) ?? []) : [];
      const mapping = mappings.length === 1 ? mappings[0] : undefined;

      if (
        !occurrence.value ||
        !mapping ||
        !referencesMatch(occurrence.value, mapping) ||
        !rowDigestMatches(occurrence.value) ||
        previousDigest !== assignmentSourceDigest(snapshot, occurrence.value, mapping)
      )
        return yield* new CurrentAssignmentFailure({ code: "SourceIdentityConflict" });
    }

    yield* tx.unsafe(
      `INSERT INTO public.current_assignment_snapshots
       (snapshot_key, source_repository, source_revision, snapshot_id, source_watermark,
        transformation_revision, snapshot_digest, occurrence_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        snapshotKey,
        snapshot.sourceRepository,
        snapshot.sourceRevision,
        snapshot.snapshotId,
        snapshot.sourceWatermark,
        snapshot.transformationRevision,
        snapshotDigest,
        snapshot.occurrences.length,
      ],
    );

    if (!snapshot.synthetic)
      yield* tx.unsafe(
        `INSERT INTO public.current_assignment_reviews
         (snapshot_key, source_kind, reference_digest, person_snapshot_key, source_semester_id, as_of, review)
       VALUES ($1,'ReviewedLegacy',$2,$3,$4,$5::date,$6::jsonb)`,
        [
          snapshotKey,
          snapshot.referenceDigest,
          snapshot.personSnapshotKey,
          snapshot.review.sourceSemesterId,
          snapshot.review.asOf,
          yield* encodeReview(snapshot.review),
        ],
      );

    for (const occurrence of decoded) {
      const row = occurrence.value;
      const mappings = row ? (mappingsBySource.get(row.sourceAssignmentId) ?? []) : [];
      const mapping = mappings.length === 1 ? mappings[0] : undefined;
      let reason: CurrentAssignmentReason;
      let sourceDigest: string | undefined;
      let placementId: string | undefined;
      let createAffiliation = false;

      if (!row || !rowDigestMatches(row)) reason = "InvalidRow";
      else if (!row.active) reason = "Inactive";
      else if ((sourceCounts.get(row.sourceAssignmentId) ?? 0) > 1) reason = "DuplicateSource";
      else if (mappings.length === 0) reason = "MappingMissing";
      else if (mappings.length > 1) reason = "MappingAmbiguous";
      else if (!referencesMatch(row, mapping!)) reason = "SourceReferenceMismatch";
      else if (
        sourceRelationships &&
        !sourceRelationships.has(canonicalJson([row.sourceDepartmentId, row.sourceSchoolId]))
      )
        reason = "SchoolDepartmentMismatch";
      else {
        sourceDigest = assignmentSourceDigest(snapshot, row, mapping!);
        placementId = currentAssignmentPlacementId(
          snapshot.sourceRepository,
          row.sourceAssignmentId,
        );
        const previous = importedBySource.get(row.sourceAssignmentId);

        if (previous === sourceDigest) reason = "ExactReplay";
        else {
          const personEvidence = yield* tx.unsafe(
            `SELECT 1 FROM public.person_cohort_accepted_mappings a
            JOIN public.person_cohort_imports i USING (source_repository, source_user_id)
            WHERE a.source_repository = $1 AND a.source_user_id = $2 AND i.person_id = $3
              AND ($4::text IS NULL OR a.snapshot_key = $4)
            FOR SHARE`,
            [
              snapshot.sourceRepository,
              row.sourceUserId,
              mapping!.personId,
              snapshot.synthetic ? null : snapshot.personSnapshotKey,
            ],
          );

          if (!personEvidence.length) reason = "PersonReconciliationMissing";
          else {
            const references = (yield* tx
              .unsafe<{
                department_exists: boolean;
                semester_exists: boolean;
                school_active: boolean;
                school_department_exists: boolean;
              }>(
                `SELECT
                 EXISTS(SELECT 1 FROM public.organization_departments WHERE department_id = $1) AS department_exists,
                 EXISTS(SELECT 1 FROM public.admission_period_semesters WHERE semester_id = $2) AS semester_exists,
                 COALESCE((SELECT active FROM public.schools_directory_schools WHERE school_id = $3), false) AS school_active,
                 EXISTS(SELECT 1 FROM public.schools_directory_departments
                         WHERE school_id = $3 AND department_id = $1) AS school_department_exists`,
                [mapping!.departmentId, mapping!.semesterId, mapping!.schoolId],
              )
              .pipe(Effect.flatMap(decodeReferenceRows)))[0]!;

            if (
              !references.department_exists ||
              !references.semester_exists ||
              !references.school_active
            )
              reason = "NativeReferenceMissing";
            else if (!references.school_department_exists) reason = "SchoolDepartmentMismatch";
            else if (
              targetSlots(mapping!, row.block).some((slot) => (targetCounts.get(slot) ?? 0) > 1)
            )
              reason = "DuplicateTarget";
            else {
              const affiliation = (yield* tx
                .unsafe<{ status: string; revision: number }>(
                  `SELECT status, revision
                   FROM public.organization_volunteer_affiliations
                  WHERE person_id = $1 AND department_id = $2
                  FOR SHARE`,
                  [mapping!.personId, mapping!.departmentId],
                )
                .pipe(Effect.flatMap(decodeAffiliationRows)))[0];

              const affiliationProvenance = yield* tx
                .unsafe<{ source_repository: string }>(
                  `SELECT source_repository
                 FROM public.current_assignment_affiliation_imports
                WHERE person_id = $1 AND department_id = $2
                FOR SHARE`,
                  [mapping!.personId, mapping!.departmentId],
                )
                .pipe(Effect.flatMap(decodeAffiliationProvenanceRows));

              const deterministicPlacement = yield* tx.unsafe(
                `SELECT 1 FROM public.assistant_placements WHERE placement_id = $1 FOR SHARE`,
                [placementId],
              );

              const overlappingPlacement = yield* tx`SELECT 1
                 FROM public.assistant_placements
                WHERE active AND person_id = ${mapping!.personId}
                  AND school_id = ${mapping!.schoolId} AND semester_id = ${mapping!.semesterId}
                  AND (${tx.in("block", row.block === "Both" ? ["1", "2"] : [row.block])} OR block = 'Both')
                FOR SHARE`;

              if (affiliation) {
                if (
                  affiliation.status !== "Active" ||
                  affiliation.revision !== 1 ||
                  affiliationProvenance.length !== 1 ||
                  affiliationProvenance[0]!.source_repository !== snapshot.sourceRepository
                )
                  reason = "TargetConflict";
                else if (deterministicPlacement.length) reason = "TargetConflict";
                else if (overlappingPlacement.length) reason = "PlacementOverlap";
                else reason = "Imported";
              } else if (affiliationProvenance.length || deterministicPlacement.length) {
                reason = "TargetConflict";
              } else if (overlappingPlacement.length) reason = "PlacementOverlap";
              else {
                createAffiliation = true;
                reason = "Imported";
              }
            }
          }
        }
      }

      const accepted = reason === "Imported" || reason === "ExactReplay";
      yield* tx.unsafe(
        `INSERT INTO public.current_assignment_occurrences
         (snapshot_key, occurrence_id, disposition, reason)
       VALUES ($1,$2,$3,$4)`,
        [snapshotKey, occurrence.occurrenceId, accepted ? "Accepted" : "Quarantined", reason],
      );

      if (reason === "Imported" && row && mapping && sourceDigest && placementId) {
        if (createAffiliation)
          yield* tx.unsafe(
            `INSERT INTO public.organization_volunteer_affiliations
             (person_id, department_id, status, revision)
           VALUES ($1,$2,'Active',1)`,
            [mapping.personId, mapping.departmentId],
          );
        yield* tx.unsafe(
          `INSERT INTO public.assistant_placements
           (placement_id, person_id, department_id, semester_id, school_id, day, workdays,
            block, active, revision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,1)`,
          [
            placementId,
            mapping.personId,
            mapping.departmentId,
            mapping.semesterId,
            mapping.schoolId,
            row.day,
            row.workdays,
            row.block,
          ],
        );
        yield* tx.unsafe(
          `INSERT INTO public.current_assignment_imports
           (source_repository, source_assignment_id, source_user_id, source_department_id,
            source_semester_id, source_school_id, source_row_digest, person_id, department_id,
            semester_id, school_id, day, workdays, block, affiliation_evidence_ref,
            placement_evidence_ref, placement_id, source_digest, snapshot_key, occurrence_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [
            snapshot.sourceRepository,
            row.sourceAssignmentId,
            row.sourceUserId,
            row.sourceDepartmentId,
            row.sourceSemesterId,
            row.sourceSchoolId,
            row.sourceRowDigest,
            mapping.personId,
            mapping.departmentId,
            mapping.semesterId,
            mapping.schoolId,
            row.day,
            row.workdays,
            row.block,
            row.affiliationEvidenceRef,
            row.placementEvidenceRef,
            placementId,
            sourceDigest,
            snapshotKey,
            occurrence.occurrenceId,
          ],
        );

        if (createAffiliation)
          yield* tx.unsafe(
            `INSERT INTO public.current_assignment_affiliation_imports
             (source_repository, person_id, department_id, source_assignment_id, snapshot_key,
              occurrence_id)
           VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              snapshot.sourceRepository,
              mapping.personId,
              mapping.departmentId,
              row.sourceAssignmentId,
              snapshotKey,
              occurrence.occurrenceId,
            ],
          );
      }
    }

    const result = yield* cohortReport(tx, snapshotKey);

    if (result.input !== snapshot.occurrences.length)
      return yield* new CurrentAssignmentFailure({ code: "PersistenceFailure" });

    return result;
  });

  return yield* withTypedTransactionFailures(sql.withTransaction)(importInTransaction(sql)).pipe(
    Effect.catchTags({
      SqlError: () => Effect.fail(new CurrentAssignmentFailure({ code: "PersistenceFailure" })),
      SchemaError: () => Effect.fail(new CurrentAssignmentFailure({ code: "PersistenceFailure" })),
    }),
  );
});

export const importCurrentAssignmentCohort = Effect.fn("importCurrentAssignmentCohort")(function* (
  sql: SqlClient.SqlClient,
  input: typeof CurrentAssignmentSnapshot.Encoded,
) {
  const snapshot = yield* Effect.try({
    try: () => decodeCurrentAssignmentSnapshot(input),
    catch: () => new CurrentAssignmentFailure({ code: "InvalidSnapshot" }),
  });

  return yield* importAssignmentCohort(sql, snapshot);
});

export const importReconciledCurrentAssignmentCohort = Effect.fn(
  "importReconciledCurrentAssignmentCohort",
)(function* (sql: SqlClient.SqlClient, input: typeof ReconciledCurrentAssignmentSnapshot.Encoded) {
  const snapshot = yield* Effect.try({
    try: () => decodeReconciledCurrentAssignmentSnapshot(input),
    catch: () => new CurrentAssignmentFailure({ code: "InvalidSnapshot" }),
  });

  return yield* importAssignmentCohort(sql, snapshot);
});

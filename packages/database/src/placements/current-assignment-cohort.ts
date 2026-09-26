import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { flow, Option, Schema } from "effect";
import type { Pool, PoolClient } from "pg";
import { canonicalJson } from "@vektorprogrammet/domain/evidence";
import { DepartmentId, SemesterId } from "@vektorprogrammet/domain/organization";
import { SchoolId } from "@vektorprogrammet/domain/schools";

import {
  CurrentAssignmentSnapshot,
  ReconciledCurrentAssignmentSnapshot,
} from "@vektorprogrammet/domain/placements";

export const currentAssignmentImportSourceDigest = async (): Promise<string> =>
  digest(
    await Promise.all([
      readFile(new URL("./current-assignment-cohort.ts", import.meta.url), "utf8"),
      readFile(
        new URL(
          "current-assignment-contracts.ts",
          import.meta.resolve("@vektorprogrammet/domain/placements"),
        ),
        "utf8",
      ),
    ]),
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

export class CurrentAssignmentFailure extends Error {
  constructor(
    readonly code:
      | "InvalidSnapshot"
      | "SnapshotConflict"
      | "SourceIdentityConflict"
      | "ReferenceProvenanceMissing"
      | "ReferenceProvenanceConflict"
      | "PersonSnapshotConflict"
      | "PersistenceFailure",
  ) {
    super(code);
    this.name = "CurrentAssignmentFailure";
  }
}

export type CurrentAssignmentReason =
  | "Imported"
  | "ExactReplay"
  | "InvalidRow"
  | "Inactive"
  | "DuplicateSource"
  | "MappingMissing"
  | "MappingAmbiguous"
  | "SourceReferenceMismatch"
  | "PersonReconciliationMissing"
  | "NativeReferenceMissing"
  | "SchoolDepartmentMismatch"
  | "DuplicateTarget"
  | "PlacementOverlap"
  | "TargetConflict";

export interface CurrentAssignmentOccurrence {
  readonly occurrenceId: string;
  readonly disposition: "Accepted" | "Quarantined";
  readonly reason: CurrentAssignmentReason;
}

export interface CurrentAssignmentReport {
  readonly snapshotKey: string;
  readonly input: number;
  readonly accepted: number;
  readonly quarantined: number;
  readonly occurrences: ReadonlyArray<CurrentAssignmentOccurrence>;
  readonly currentState: "EstablishedThroughCanonicalAffiliationAndPlacement";
  readonly audit: "ImportProvenanceOnly";
}

const digest = flow(canonicalJson, (json) => createHash("sha256").update(json).digest("hex"));

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
  Option.getOrThrowWith(() => new CurrentAssignmentFailure("InvalidSnapshot")),
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
      throw new CurrentAssignmentFailure("InvalidSnapshot");
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
  Option.getOrThrowWith(() => new CurrentAssignmentFailure("InvalidSnapshot")),
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
        const row = Schema.decodeUnknownSync(ReviewedAssignmentEnvelope)(occurrence.row);
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
      throw new CurrentAssignmentFailure("InvalidSnapshot");
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

const validateReconciledProvenance = async (
  tx: PoolClient,
  snapshot: ReconciledCurrentAssignmentSnapshot,
): Promise<ReadonlySet<string>> => {
  const evidence = (
    await tx.query<{
      source_revision: string;
      reference_digest: string;
      source_id_mappings: unknown;
    }>(
      `SELECT source_revision, reference_digest, source_id_mappings
       FROM public.historical_service_reference_provenance
      WHERE source_repository = $1 AND snapshot_id = $2 FOR SHARE`,
      [snapshot.sourceRepository, snapshot.snapshotId],
    )
  ).rows[0];

  if (!evidence) throw new CurrentAssignmentFailure("ReferenceProvenanceMissing");

  if (
    evidence.source_revision !== snapshot.sourceRevision ||
    evidence.reference_digest !== snapshot.referenceDigest
  )
    throw new CurrentAssignmentFailure("ReferenceProvenanceConflict");

  const parsed = Schema.decodeUnknownOption(ReferenceMappings)(evidence.source_id_mappings, {
    onExcessProperty: "error",
  });

  if (Option.isNone(parsed)) throw new CurrentAssignmentFailure("ReferenceProvenanceConflict");
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
    throw new CurrentAssignmentFailure("ReferenceProvenanceConflict");

  const semester = await tx.query(
    `SELECT 1 FROM public.admission_period_semesters
      WHERE semester_id = $1
        AND $2::date BETWEEN (start_at AT TIME ZONE 'UTC')::date AND (end_at AT TIME ZONE 'UTC')::date
      FOR SHARE`,
    [semesterId, snapshot.review.asOf],
  );

  if (!semester.rowCount) throw new CurrentAssignmentFailure("InvalidSnapshot");

  const personSnapshot = await tx.query(
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

  if (!personSnapshot.rowCount) throw new CurrentAssignmentFailure("PersonSnapshotConflict");

  return relationships;
};

const cohortReport = async (
  tx: PoolClient,
  snapshotKey: string,
): Promise<CurrentAssignmentReport> => {
  const rows = await tx.query<CurrentAssignmentOccurrence>(
    `SELECT occurrence_id AS "occurrenceId", disposition, reason
       FROM public.current_assignment_occurrences
      WHERE snapshot_key = $1
      ORDER BY occurrence_id`,
    [snapshotKey],
  );

  const accepted = rows.rows.filter(({ disposition }) => disposition === "Accepted").length;

  return {
    snapshotKey,
    input: rows.rows.length,
    accepted,
    quarantined: rows.rows.length - accepted,
    occurrences: rows.rows,
    currentState: "EstablishedThroughCanonicalAffiliationAndPlacement",
    audit: "ImportProvenanceOnly",
  };
};

/** One serialized transaction establishes canonical current facts and immutable import provenance. */
const importAssignmentCohort = async (
  pool: Pool,
  snapshot: AssignmentSnapshot,
  client?: PoolClient,
): Promise<CurrentAssignmentReport> => {
  const snapshotKey = digest([snapshot.sourceRepository, snapshot.snapshotId]);
  const snapshotDigest = snapshot.snapshotDigest;

  const decoded = snapshot.occurrences.map((occurrence) => {
    try {
      return {
        ...occurrence,
        value: Schema.decodeUnknownSync(LegacyAssignmentRow)(occurrence.row, {
          onExcessProperty: "error",
        }),
      };
    } catch {
      return { ...occurrence, value: undefined };
    }
  });

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

  const tx = client ?? (await pool.connect());
  const ownsTransaction = client === undefined;

  try {
    if (ownsTransaction) await tx.query("BEGIN");
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('native-current-assignment-import', 0))",
    );

    const prior = await tx.query<{ snapshot_digest: string }>(
      `SELECT snapshot_digest FROM public.current_assignment_snapshots WHERE snapshot_key = $1`,
      [snapshotKey],
    );

    if (prior.rows[0] && prior.rows[0].snapshot_digest !== snapshotDigest)
      throw new CurrentAssignmentFailure("SnapshotConflict");

    const sourceRelationships = snapshot.synthetic
      ? undefined
      : await validateReconciledProvenance(tx, snapshot);

    if (prior.rows[0]) {
      if (!snapshot.synthetic) {
        const review = await tx.query(
          `SELECT 1 FROM public.current_assignment_reviews
            WHERE snapshot_key = $1 AND reference_digest = $2 AND person_snapshot_key = $3
              AND source_semester_id = $4 AND as_of = $5::date AND review = $6::jsonb`,
          [
            snapshotKey,
            snapshot.referenceDigest,
            snapshot.personSnapshotKey,
            snapshot.review.sourceSemesterId,
            snapshot.review.asOf,
            JSON.stringify(snapshot.review),
          ],
        );

        if (!review.rowCount) throw new CurrentAssignmentFailure("SnapshotConflict");
      }

      const result = await cohortReport(tx, snapshotKey);

      if (ownsTransaction) await tx.query("COMMIT");

      return result;
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
    await tx.query(
      `SELECT department_id FROM public.organization_departments
        WHERE department_id = ANY($1::text[]) ORDER BY department_id FOR UPDATE`,
      [[...new Set(snapshot.mappings.map(({ departmentId }) => departmentId))].sort()],
    );

    const acceptedImports = await tx.query<{
      source_assignment_id: string;
      source_digest: string;
    }>(
      `SELECT source_assignment_id, source_digest
         FROM public.current_assignment_imports
        WHERE source_repository = $1`,
      [snapshot.sourceRepository],
    );

    const importedBySource = new Map(
      acceptedImports.rows.map((row) => [row.source_assignment_id, row.source_digest] as const),
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
        throw new CurrentAssignmentFailure("SourceIdentityConflict");
    }

    await tx.query(
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
      await tx.query(
        `INSERT INTO public.current_assignment_reviews
           (snapshot_key, source_kind, reference_digest, person_snapshot_key, source_semester_id, as_of, review)
         VALUES ($1,'ReviewedLegacy',$2,$3,$4,$5::date,$6::jsonb)`,
        [
          snapshotKey,
          snapshot.referenceDigest,
          snapshot.personSnapshotKey,
          snapshot.review.sourceSemesterId,
          snapshot.review.asOf,
          JSON.stringify(snapshot.review),
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
          const personEvidence = await tx.query(
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

          if (!personEvidence.rowCount) reason = "PersonReconciliationMissing";
          else {
            const references = (
              await tx.query<{
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
            ).rows[0]!;

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
              const affiliation = (
                await tx.query<{ status: string; revision: number }>(
                  `SELECT status, revision
                     FROM public.organization_volunteer_affiliations
                    WHERE person_id = $1 AND department_id = $2
                    FOR SHARE`,
                  [mapping!.personId, mapping!.departmentId],
                )
              ).rows[0];

              const affiliationProvenance = await tx.query<{ source_repository: string }>(
                `SELECT source_repository
                   FROM public.current_assignment_affiliation_imports
                  WHERE person_id = $1 AND department_id = $2
                  FOR SHARE`,
                [mapping!.personId, mapping!.departmentId],
              );

              const deterministicPlacement = await tx.query(
                `SELECT 1 FROM public.assistant_placements WHERE placement_id = $1 FOR SHARE`,
                [placementId],
              );

              const overlappingPlacement = await tx.query(
                `SELECT 1
                   FROM public.assistant_placements
                  WHERE active AND person_id = $1 AND school_id = $2 AND semester_id = $3
                    AND (block = ANY($4::text[]) OR block = 'Both')
                  FOR SHARE`,
                [
                  mapping!.personId,
                  mapping!.schoolId,
                  mapping!.semesterId,
                  row.block === "Both" ? ["1", "2"] : [row.block],
                ],
              );

              if (affiliation) {
                if (
                  affiliation.status !== "Active" ||
                  affiliation.revision !== 1 ||
                  affiliationProvenance.rows.length !== 1 ||
                  affiliationProvenance.rows[0]!.source_repository !== snapshot.sourceRepository
                )
                  reason = "TargetConflict";
                else if (deterministicPlacement.rowCount) reason = "TargetConflict";
                else if (overlappingPlacement.rowCount) reason = "PlacementOverlap";
                else reason = "Imported";
              } else if (affiliationProvenance.rowCount || deterministicPlacement.rowCount) {
                reason = "TargetConflict";
              } else if (overlappingPlacement.rowCount) reason = "PlacementOverlap";
              else {
                createAffiliation = true;
                reason = "Imported";
              }
            }
          }
        }
      }

      const accepted = reason === "Imported" || reason === "ExactReplay";
      await tx.query(
        `INSERT INTO public.current_assignment_occurrences
           (snapshot_key, occurrence_id, disposition, reason)
         VALUES ($1,$2,$3,$4)`,
        [snapshotKey, occurrence.occurrenceId, accepted ? "Accepted" : "Quarantined", reason],
      );

      if (reason === "Imported" && row && mapping && sourceDigest && placementId) {
        if (createAffiliation)
          await tx.query(
            `INSERT INTO public.organization_volunteer_affiliations
               (person_id, department_id, status, revision)
             VALUES ($1,$2,'Active',1)`,
            [mapping.personId, mapping.departmentId],
          );
        await tx.query(
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
        await tx.query(
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
          await tx.query(
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

    const result = await cohortReport(tx, snapshotKey);

    if (result.input !== snapshot.occurrences.length)
      throw new CurrentAssignmentFailure("PersistenceFailure");

    if (ownsTransaction) await tx.query("COMMIT");

    return result;
  } catch (cause) {
    if (ownsTransaction) await tx.query("ROLLBACK");
    throw cause instanceof CurrentAssignmentFailure
      ? cause
      : new CurrentAssignmentFailure("PersistenceFailure");
  } finally {
    if (ownsTransaction) tx.release();
  }
};

export const importCurrentAssignmentCohort = async (
  pool: Pool,
  input: typeof CurrentAssignmentSnapshot.Encoded,
): Promise<CurrentAssignmentReport> =>
  importAssignmentCohort(pool, decodeCurrentAssignmentSnapshot(input));

export const importReconciledCurrentAssignmentCohort = async (
  pool: Pool,
  input: typeof ReconciledCurrentAssignmentSnapshot.Encoded,
  client?: PoolClient,
): Promise<CurrentAssignmentReport> =>
  importAssignmentCohort(pool, decodeReconciledCurrentAssignmentSnapshot(input), client);

import { createHash } from "node:crypto";
import { flow, Option, Schema } from "effect";
import type { Pool, PoolClient } from "pg";
import { canonicalJson } from "@vektorprogrammet/domain/evidence";
import { DepartmentId, PersonId, SemesterId } from "@vektorprogrammet/domain/organization";
import { SchoolId } from "@vektorprogrammet/domain/schools";

const Id = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/)));

const Label = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
);

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

const CurrentAssignmentMapping = Schema.Struct({
  sourceAssignmentId: Id,
  sourceUserId: Id,
  sourceDepartmentId: Id,
  sourceSemesterId: Id,
  sourceSchoolId: Id,
  personId: PersonId,
  departmentId: DepartmentId,
  semesterId: SemesterId,
  schoolId: SchoolId,
});

export const CurrentAssignmentSnapshot = Schema.Struct({
  sourceRepository: Label,
  sourceRevision: Id,
  snapshotId: Id,
  sourceWatermark: Id,
  snapshotDigest: Digest,
  transformationRevision: Id,
  synthetic: Schema.Literal(true),
  occurrences: Schema.Array(Schema.Struct({ occurrenceId: Id, row: Schema.Unknown })).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(1000)),
  ),
  mappings: Schema.Array(CurrentAssignmentMapping).pipe(Schema.check(Schema.isMaxLength(1000))),
});

export type CurrentAssignmentSnapshot = typeof CurrentAssignmentSnapshot.Type;

type LegacyAssignmentRow = typeof LegacyAssignmentRow.Type;

type CurrentAssignmentMapping = typeof CurrentAssignmentMapping.Type;

type NativeBlock = "1" | "2" | "Both";

export class CurrentAssignmentFailure extends Error {
  constructor(
    readonly code:
      | "InvalidSnapshot"
      | "SnapshotConflict"
      | "SourceIdentityConflict"
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

const declaredSnapshotDigest = (snapshot: CurrentAssignmentSnapshot): string => {
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
export const importCurrentAssignmentCohort = async (
  pool: Pool,
  input: typeof CurrentAssignmentSnapshot.Encoded,
): Promise<CurrentAssignmentReport> => {
  const snapshot = decodeCurrentAssignmentSnapshot(input);
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

    if (!occurrence.value) continue;
    const mappings = mappingsBySource.get(occurrence.value.sourceAssignmentId) ?? [];

    if (mappings.length !== 1 || !referencesMatch(occurrence.value, mappings[0]!)) continue;

    for (const slot of targetSlots(mappings[0]!, occurrence.value.block))
      increment(targetCounts, slot);
  }

  const tx = await pool.connect();

  try {
    await tx.query("BEGIN");
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('native-current-assignment-import', 0))",
    );

    const prior = await tx.query<{ snapshot_digest: string }>(
      `SELECT snapshot_digest FROM public.current_assignment_snapshots WHERE snapshot_key = $1`,
      [snapshotKey],
    );

    if (prior.rows[0]) {
      if (prior.rows[0].snapshot_digest !== snapshotDigest)
        throw new CurrentAssignmentFailure("SnapshotConflict");
      const result = await cohortReport(tx, snapshotKey);
      await tx.query("COMMIT");

      return result;
    }

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
        occurrence.value.sourceRowDigest !== sourceRowDigest(occurrence.value) ||
        previousDigest !== digest({ row: occurrence.value, mapping })
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

    for (const occurrence of decoded) {
      const row = occurrence.value;
      const mappings = row ? (mappingsBySource.get(row.sourceAssignmentId) ?? []) : [];
      const mapping = mappings.length === 1 ? mappings[0] : undefined;
      let reason: CurrentAssignmentReason;
      let sourceDigest: string | undefined;
      let placementId: string | undefined;
      let createAffiliation = false;

      if (!row || row.sourceRowDigest !== sourceRowDigest(row)) reason = "InvalidRow";
      else if (!row.active) reason = "Inactive";
      else if ((sourceCounts.get(row.sourceAssignmentId) ?? 0) > 1) reason = "DuplicateSource";
      else if (mappings.length === 0) reason = "MappingMissing";
      else if (mappings.length > 1) reason = "MappingAmbiguous";
      else if (!referencesMatch(row, mapping!)) reason = "SourceReferenceMismatch";
      else {
        sourceDigest = digest({ row, mapping });
        placementId = currentAssignmentPlacementId(
          snapshot.sourceRepository,
          row.sourceAssignmentId,
        );
        const previous = importedBySource.get(row.sourceAssignmentId);

        if (previous === sourceDigest) reason = "ExactReplay";
        else {
          const personEvidence = await tx.query(
            `SELECT 1 FROM public.person_cohort_imports
              WHERE source_repository = $1 AND source_user_id = $2 AND person_id = $3
              FOR SHARE`,
            [snapshot.sourceRepository, row.sourceUserId, mapping!.personId],
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
    await tx.query("COMMIT");

    return result;
  } catch (cause) {
    await tx.query("ROLLBACK");
    throw cause instanceof CurrentAssignmentFailure
      ? cause
      : new CurrentAssignmentFailure("PersistenceFailure");
  } finally {
    tx.release();
  }
};

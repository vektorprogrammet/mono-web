import { createHash } from "node:crypto";
import { Schema } from "effect";
import type { Pool, PoolClient } from "pg";
import { canonicalJson } from "@vektorprogrammet/domain/evidence";
import { DepartmentId, PersonId, SemesterId } from "@vektorprogrammet/domain/organization";
import { SchoolId } from "@vektorprogrammet/domain/schools";

const Id = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/)));
const Sha256 = /^[a-f0-9]{64}$/;
const Label = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
);
const LegacyServiceRow = Schema.Struct({
  sourceHistoryId: Id,
  sourceUserId: Id,
  sourceDepartmentId: Id,
  sourceSemesterId: Id,
  sourceSchoolId: Id,
  workdays: Schema.String.pipe(Schema.check(Schema.isPattern(/^[1-8]$/))),
  block: Schema.Literals(["Bolk 1", "Bolk 2", "Bolk 1, Bolk 2"]),
  day: Schema.Literals(["Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag"]),
});
const HistoricalServiceMapping = Schema.Struct({
  sourceHistoryId: Id,
  sourceUserId: Id,
  sourceDepartmentId: Id,
  sourceSemesterId: Id,
  sourceSchoolId: Id,
  personId: PersonId,
  departmentId: DepartmentId,
  semesterId: SemesterId,
  schoolId: SchoolId,
  evidenceRef: Id,
});
const HistoricalServiceReferenceMappings = Schema.Struct({
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
const HistoricalServiceSnapshotFields = {
  sourceRepository: Label,
  sourceRevision: Id,
  snapshotId: Id,
  transformationRevision: Id,
  occurrences: Schema.Array(
    Schema.Struct({
      occurrenceId: Id,
      row: Schema.Unknown,
      sourceRowDigest: Schema.optional(Schema.Unknown),
    }),
  ).pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(10_000))),
  mappings: Schema.Array(HistoricalServiceMapping).pipe(Schema.check(Schema.isMaxLength(10_000))),
};
export const HistoricalServiceSnapshot = Schema.Union([
  Schema.Struct({ ...HistoricalServiceSnapshotFields, sourceKind: Schema.Literal("Synthetic") }),
  Schema.Struct({
    ...HistoricalServiceSnapshotFields,
    sourceKind: Schema.Literal("LegacyBackup"),
    referenceDigest: Schema.String.pipe(Schema.check(Schema.isPattern(Sha256))),
  }),
]);
export type HistoricalServiceSnapshot = typeof HistoricalServiceSnapshot.Type;
type LegacyServiceRow = typeof LegacyServiceRow.Type;
type HistoricalServiceMapping = typeof HistoricalServiceMapping.Type;
type NativeBlock = "1" | "2" | "Both";
type NativeDay = "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday";

export class HistoricalServiceFailure extends Error {
  constructor(
    readonly code:
      | "InvalidSnapshot"
      | "SnapshotConflict"
      | "SourceIdentityConflict"
      | "ReferenceProvenanceMissing"
      | "ReferenceProvenanceConflict"
      | "PersistenceFailure",
  ) {
    super(code);
    this.name = "HistoricalServiceFailure";
  }
}

export type HistoricalServiceReason =
  | "Imported"
  | "ExactReplay"
  | "InvalidRow"
  | "DuplicateSource"
  | "MappingMissing"
  | "MappingAmbiguous"
  | "SourceReferenceMismatch"
  | "PersonReconciliationMissing"
  | "NativeReferenceMissing"
  | "SchoolDepartmentMismatch"
  | "DuplicateTarget"
  | "TargetConflict";

export interface HistoricalServiceOccurrence {
  readonly occurrenceId: string;
  readonly disposition: "Accepted" | "Quarantined";
  readonly reason: HistoricalServiceReason;
}

export interface HistoricalServiceReport {
  readonly snapshotKey: string;
  readonly input: number;
  readonly accepted: number;
  readonly quarantined: number;
  readonly occurrences: ReadonlyArray<HistoricalServiceOccurrence>;
  readonly currentState: "Unchanged";
  readonly historicalAffiliation: "DerivedFromAcceptedService";
}

const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export const historicalServiceSourceRowDigest = (row: unknown): string => digest(row);
const declaredRowDigest = (value: unknown): string | undefined =>
  typeof value === "string" && Sha256.test(value) ? value : undefined;
const sourceIdOf = (row: unknown): string | undefined =>
  typeof row === "object" &&
  row !== null &&
  "sourceHistoryId" in row &&
  typeof row.sourceHistoryId === "string"
    ? row.sourceHistoryId
    : undefined;
const increment = (counts: Map<string, number>, key: string | undefined) => {
  if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
};
const nativeDay = (day: LegacyServiceRow["day"]): NativeDay =>
  ({
    Mandag: "Monday",
    Tirsdag: "Tuesday",
    Onsdag: "Wednesday",
    Torsdag: "Thursday",
    Fredag: "Friday",
  })[day] as NativeDay;
const nativeBlock = (block: LegacyServiceRow["block"]): NativeBlock =>
  ({ "Bolk 1": "1", "Bolk 2": "2", "Bolk 1, Bolk 2": "Both" })[block] as NativeBlock;
const targetSlots = (
  mapping: HistoricalServiceMapping,
  block: NativeBlock,
): ReadonlyArray<string> =>
  (block === "Both" ? (["1", "2"] as const) : [block]).map(
    (slot) => `${mapping.personId}:${mapping.schoolId}:${mapping.semesterId}:${slot}`,
  );
const referencesMatch = (row: LegacyServiceRow, mapping: HistoricalServiceMapping): boolean =>
  row.sourceHistoryId === mapping.sourceHistoryId &&
  row.sourceUserId === mapping.sourceUserId &&
  row.sourceDepartmentId === mapping.sourceDepartmentId &&
  row.sourceSemesterId === mapping.sourceSemesterId &&
  row.sourceSchoolId === mapping.sourceSchoolId;

export const decodeHistoricalServiceSnapshot = (input: unknown): HistoricalServiceSnapshot => {
  try {
    const snapshot = Schema.decodeUnknownSync(HistoricalServiceSnapshot)(input, {
      onExcessProperty: "error",
    });
    if (
      new Set(snapshot.occurrences.map(({ occurrenceId }) => occurrenceId)).size !==
      snapshot.occurrences.length
    )
      throw new Error();
    return snapshot;
  } catch {
    throw new HistoricalServiceFailure("InvalidSnapshot");
  }
};

const cohortReport = async (
  tx: PoolClient,
  snapshotKey: string,
): Promise<HistoricalServiceReport> => {
  const rows = await tx.query<HistoricalServiceOccurrence>(
    `SELECT occurrence_id AS "occurrenceId", disposition, reason
       FROM public.historical_service_occurrences
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
    currentState: "Unchanged",
    historicalAffiliation: "DerivedFromAcceptedService",
  };
};

/** History and reconciliation evidence share the caller transaction when supplied. */
export const importHistoricalServiceCohort = async (
  pool: Pool,
  input: unknown,
  client?: PoolClient,
): Promise<HistoricalServiceReport> => {
  const snapshot = decodeHistoricalServiceSnapshot(input);
  const snapshotKey = digest([snapshot.sourceRepository, snapshot.snapshotId]);
  const snapshotDigest = digest(snapshot);
  const decoded = snapshot.occurrences.map((occurrence) => {
    const rawRowDigest = historicalServiceSourceRowDigest(occurrence.row);
    const sourceRowDigest = declaredRowDigest(occurrence.sourceRowDigest);
    const digestMismatch =
      snapshot.sourceKind === "LegacyBackup" && sourceRowDigest !== rawRowDigest;
    try {
      return {
        ...occurrence,
        rawRowDigest,
        sourceRowDigest,
        digestMismatch,
        value: digestMismatch
          ? undefined
          : Schema.decodeUnknownSync(LegacyServiceRow)(occurrence.row, {
              onExcessProperty: "error",
            }),
      };
    } catch {
      return { ...occurrence, rawRowDigest, sourceRowDigest, digestMismatch, value: undefined };
    }
  });
  const mappingsBySource = new Map<string, HistoricalServiceMapping[]>();
  for (const mapping of snapshot.mappings) {
    const mappings = mappingsBySource.get(mapping.sourceHistoryId);
    if (mappings === undefined) mappingsBySource.set(mapping.sourceHistoryId, [mapping]);
    else mappings.push(mapping);
  }
  const sourceCounts = new Map<string, number>();
  const targetCounts = new Map<string, number>();
  for (const occurrence of decoded) {
    increment(sourceCounts, sourceIdOf(occurrence.row));
    if (!occurrence.value) continue;
    const mappings = mappingsBySource.get(occurrence.value.sourceHistoryId) ?? [];
    if (mappings.length !== 1 || !referencesMatch(occurrence.value, mappings[0]!)) continue;
    for (const slot of targetSlots(mappings[0]!, nativeBlock(occurrence.value.block)))
      increment(targetCounts, slot);
  }

  const tx = client ?? (await pool.connect());
  const ownsTransaction = client === undefined;
  try {
    if (ownsTransaction) await tx.query("BEGIN");
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('native-historical-service-import', 0))",
    );
    const prior = await tx.query<{ snapshot_digest: string }>(
      `SELECT snapshot_digest FROM public.historical_service_snapshots WHERE snapshot_key = $1`,
      [snapshotKey],
    );
    if (prior.rows[0]?.snapshot_digest !== undefined && prior.rows[0].snapshot_digest !== snapshotDigest)
      throw new HistoricalServiceFailure("SnapshotConflict");

    let sourceRelationships: ReadonlySet<string> | undefined;
    if (snapshot.sourceKind === "LegacyBackup") {
      const evidence = (
        await tx.query<{
          source_revision: string;
          reference_digest: string;
          source_id_mappings: unknown;
        }>(
          `SELECT source_revision, reference_digest, source_id_mappings
             FROM public.historical_service_reference_provenance
            WHERE source_repository = $1 AND snapshot_id = $2
            FOR SHARE`,
          [snapshot.sourceRepository, snapshot.snapshotId],
        )
      ).rows[0];
      if (!evidence) throw new HistoricalServiceFailure("ReferenceProvenanceMissing");
      if (
        evidence.source_revision !== snapshot.sourceRevision ||
        evidence.reference_digest !== snapshot.referenceDigest
      )
        throw new HistoricalServiceFailure("ReferenceProvenanceConflict");

      let references: typeof HistoricalServiceReferenceMappings.Type;
      try {
        references = Schema.decodeUnknownSync(HistoricalServiceReferenceMappings)(
          evidence.source_id_mappings,
          { onExcessProperty: "error" },
        );
      } catch {
        throw new HistoricalServiceFailure("ReferenceProvenanceConflict");
      }
      const departments = new Map(
        references.departments.map(({ sourceDepartmentId, departmentId }) => [
          sourceDepartmentId,
          departmentId,
        ] as const),
      );
      const semesters = new Map(
        references.semesters.map(({ sourceSemesterId, semesterId }) => [
          sourceSemesterId,
          semesterId,
        ] as const),
      );
      const schools = new Map(
        references.schools.map(({ sourceSchoolId, schoolId }) => [sourceSchoolId, schoolId] as const),
      );
      sourceRelationships = new Set(
        references.relationships.map(({ sourceDepartmentId, sourceSchoolId }) =>
          canonicalJson([sourceDepartmentId, sourceSchoolId]),
        ),
      );
      if (
        departments.size !== references.departments.length ||
        semesters.size !== references.semesters.length ||
        schools.size !== references.schools.length ||
        sourceRelationships.size !== references.relationships.length ||
        references.relationships.some(
          ({ sourceDepartmentId, sourceSchoolId, departmentId, schoolId }) =>
            departments.get(sourceDepartmentId) !== departmentId ||
            schools.get(sourceSchoolId) !== schoolId,
        ) ||
        snapshot.mappings.some(
          ({ sourceDepartmentId, departmentId, sourceSemesterId, semesterId, sourceSchoolId, schoolId }) =>
            departments.get(sourceDepartmentId) !== departmentId ||
            semesters.get(sourceSemesterId) !== semesterId ||
            schools.get(sourceSchoolId) !== schoolId,
        )
      )
        throw new HistoricalServiceFailure("ReferenceProvenanceConflict");
    }
    if (prior.rows[0]) {
      const result = await cohortReport(tx, snapshotKey);
      if (ownsTransaction) await tx.query("COMMIT");
      return result;
    }

    const acceptedImports = await tx.query<{
      source_history_id: string;
      source_digest: string;
      raw_row_digest: string | null;
      source_kind: "Synthetic" | "LegacyBackup";
      person_id: string;
      school_id: string;
      semester_id: string;
      block: NativeBlock;
    }>(
      `SELECT history.source_history_id, history.source_digest, occurrence.raw_row_digest,
              snapshot.source_kind, history.person_id, history.school_id::text,
              history.semester_id, history.block
         FROM public.assistant_service_history history
         JOIN public.historical_service_occurrences occurrence
           ON (history.snapshot_key, history.occurrence_id) =
              (occurrence.snapshot_key, occurrence.occurrence_id)
         JOIN public.historical_service_snapshots snapshot
           ON snapshot.snapshot_key = history.snapshot_key
        WHERE history.source_repository = $1`,
      [snapshot.sourceRepository],
    );
    const importedBySource = new Map(
      acceptedImports.rows.map((row) => [row.source_history_id, row] as const),
    );
    const importedTargets = new Set(
      acceptedImports.rows.flatMap((row) =>
        (row.block === "Both" ? (["1", "2"] as const) : [row.block]).map(
          (slot) => `${row.person_id}:${row.school_id}:${row.semester_id}:${slot}`,
        ),
      ),
    );
    for (const occurrence of decoded) {
      const sourceHistoryId = sourceIdOf(occurrence.row);
      const previous = sourceHistoryId ? importedBySource.get(sourceHistoryId) : undefined;
      if (previous !== undefined && !occurrence.digestMismatch) {
        const mappings = sourceHistoryId ? (mappingsBySource.get(sourceHistoryId) ?? []) : [];
        const mapping = mappings.length === 1 ? mappings[0] : undefined;
        if (
          !occurrence.value ||
          !mapping ||
          !referencesMatch(occurrence.value, mapping) ||
          previous.source_kind !== snapshot.sourceKind ||
          (snapshot.sourceKind === "LegacyBackup" &&
            previous.raw_row_digest !== occurrence.rawRowDigest) ||
          previous.source_digest !== digest({ row: occurrence.value, mapping })
        )
          throw new HistoricalServiceFailure("SourceIdentityConflict");
      }
    }

    await tx.query(
      `INSERT INTO public.historical_service_snapshots
         (snapshot_key, source_repository, snapshot_id, source_revision,
          transformation_revision, snapshot_digest, occurrence_count, source_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        snapshotKey,
        snapshot.sourceRepository,
        snapshot.snapshotId,
        snapshot.sourceRevision,
        snapshot.transformationRevision,
        snapshotDigest,
        snapshot.occurrences.length,
        snapshot.sourceKind,
      ],
    );

    for (const occurrence of decoded) {
      const row = occurrence.value;
      const mappings = row ? (mappingsBySource.get(row.sourceHistoryId) ?? []) : [];
      const mapping = mappings.length === 1 ? mappings[0] : undefined;
      let reason: HistoricalServiceReason;
      let sourceDigest: string | undefined;
      if (!row) reason = "InvalidRow";
      else if ((sourceCounts.get(row.sourceHistoryId) ?? 0) > 1) reason = "DuplicateSource";
      else if (mappings.length === 0) reason = "MappingMissing";
      else if (mappings.length > 1) reason = "MappingAmbiguous";
      else if (!referencesMatch(row, mapping!)) reason = "SourceReferenceMismatch";
      else {
        sourceDigest = digest({ row, mapping });
        const previous = importedBySource.get(row.sourceHistoryId);
        if (previous?.source_digest === sourceDigest) reason = "ExactReplay";
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
                school_exists: boolean;
                school_department_exists: boolean;
              }>(
                `SELECT
                   EXISTS(SELECT 1 FROM public.organization_departments WHERE department_id = $1) AS department_exists,
                   EXISTS(SELECT 1 FROM public.admission_period_semesters WHERE semester_id = $2) AS semester_exists,
                   EXISTS(SELECT 1 FROM public.schools_directory_schools WHERE school_id = $3) AS school_exists,
                   EXISTS(SELECT 1 FROM public.schools_directory_departments
                           WHERE school_id = $3 AND department_id = $1) AS school_department_exists`,
                [mapping!.departmentId, mapping!.semesterId, mapping!.schoolId],
              )
            ).rows[0]!;
            if (
              !references.department_exists ||
              !references.semester_exists ||
              !references.school_exists
            )
              reason = "NativeReferenceMissing";
            else if (
              !references.school_department_exists ||
              (sourceRelationships !== undefined &&
                !sourceRelationships.has(
                  canonicalJson([row.sourceDepartmentId, row.sourceSchoolId]),
                ))
            )
              reason = "SchoolDepartmentMismatch";
            else {
              const slots = targetSlots(mapping!, nativeBlock(row.block));
              if (slots.some((slot) => (targetCounts.get(slot) ?? 0) > 1))
                reason = "DuplicateTarget";
              else if (slots.some((slot) => importedTargets.has(slot))) reason = "TargetConflict";
              else reason = "Imported";
            }
          }
        }
      }

      const accepted = reason === "Imported" || reason === "ExactReplay";
      await tx.query(
        `INSERT INTO public.historical_service_occurrences
           (snapshot_key, occurrence_id, disposition, reason, raw_row_digest, source_row_digest)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          snapshotKey,
          occurrence.occurrenceId,
          accepted ? "Accepted" : "Quarantined",
          reason,
          occurrence.rawRowDigest,
          occurrence.sourceRowDigest ?? null,
        ],
      );
      if (reason === "Imported" && row && mapping && sourceDigest) {
        await tx.query(
          `INSERT INTO public.assistant_service_history
             (source_repository, source_history_id, source_user_id, person_id, department_id,
              semester_id, school_id, day, workdays, block, source_digest, evidence_ref,
              snapshot_key, occurrence_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            snapshot.sourceRepository,
            row.sourceHistoryId,
            row.sourceUserId,
            mapping.personId,
            mapping.departmentId,
            mapping.semesterId,
            mapping.schoolId,
            nativeDay(row.day),
            Number(row.workdays),
            nativeBlock(row.block),
            sourceDigest,
            mapping.evidenceRef,
            snapshotKey,
            occurrence.occurrenceId,
          ],
        );
        for (const slot of targetSlots(mapping, nativeBlock(row.block))) importedTargets.add(slot);
      }
    }

    const result = await cohortReport(tx, snapshotKey);
    if (result.input !== snapshot.occurrences.length)
      throw new HistoricalServiceFailure("PersistenceFailure");
    if (ownsTransaction) await tx.query("COMMIT");
    return result;
  } catch (cause) {
    if (ownsTransaction) await tx.query("ROLLBACK");
    throw cause instanceof HistoricalServiceFailure
      ? cause
      : new HistoricalServiceFailure("PersistenceFailure");
  } finally {
    if (ownsTransaction) tx.release();
  }
};

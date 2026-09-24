import { createHash } from "node:crypto";
import type {
  PersonCohortReport,
  PersonCohortSnapshot,
} from "@vektorprogrammet/database/person-cohort";
import { canonicalJson } from "@vektorprogrammet/domain/evidence";
import {
  CurrentAssignmentReview,
  type ReconciledCurrentAssignmentSnapshot,
} from "@vektorprogrammet/placements/contracts";
import { decodeReconciledCurrentAssignmentSnapshot } from "@vektorprogrammet/placements/server";
import { flow, Schema } from "effect";
import { buildLegacyReferences } from "./legacy-cutover-references";
import type { LegacySourceSnapshot } from "./legacy-source-snapshot";

const repository = "vektorprogrammet/vektorprogrammet";
const digest = flow(canonicalJson, (json) => createHash("sha256").update(json).digest("hex"));
const personSourceId = Schema.decodeUnknownSync(Schema.Struct({ sourceUserId: Schema.String }));

const days: Readonly<Record<string, string>> = {
  Mandag: "Monday",
  Tirsdag: "Tuesday",
  Onsdag: "Wednesday",
  Torsdag: "Thursday",
  Fredag: "Friday",
};
const blocks: Readonly<Record<string, string>> = {
  "Bolk 1": "1",
  "Bolk 2": "2",
  "Bolk 1, Bolk 2": "Both",
};

/** Reviewed source rows become candidates. Placements owns acceptance and quarantine. */
export const buildLegacyCurrentAssignmentSnapshot = (
  source: LegacySourceSnapshot,
  personReport: PersonCohortReport,
  personSnapshot: PersonCohortSnapshot,
  reviewInput: CurrentAssignmentReview,
  identity: {
    readonly snapshotId: string;
    readonly transformationRevision: string;
    readonly referenceDigest: string;
  },
): ReconciledCurrentAssignmentSnapshot => {
  const review = Schema.decodeUnknownSync(CurrentAssignmentReview)(reviewInput, {
    onExcessProperty: "error",
  });
  const { credentials: _credentials, ...personAndServiceSource } = source;
  const sourceRevision = digest(personAndServiceSource);
  const references = buildLegacyReferences(source);

  if (
    review.sourceRevision !== sourceRevision ||
    identity.referenceDigest !== references.referenceDigest
  )
    throw new Error("Assignment review does not match the source snapshot");

  const semesterMapping = references.mappings.semesters.find(
    ({ sourceSemesterId }) => sourceSemesterId === review.sourceSemesterId,
  );
  const semester = references.rows.semesters.find(
    ({ semester_id }) => semester_id === semesterMapping?.semesterId,
  );
  const asOf = new Date(`${review.asOf}T00:00:00.000Z`);

  if (
    !semester ||
    !/^\d{4}-\d{2}-\d{2}$/.test(review.asOf) ||
    !Number.isFinite(asOf.getTime()) ||
    asOf.toISOString().slice(0, 10) !== review.asOf ||
    asOf.getTime() < Date.parse(semester.start_at) ||
    asOf.getTime() > Date.parse(semester.end_at)
  )
    throw new Error("Assignment review date must be inside the selected source semester");

  const selected = source.history.filter(
    ({ semesterId }) =>
      semesterId !== null && `legacy-semester:${String(semesterId)}` === review.sourceSemesterId,
  );
  const selectedIds = new Set(selected.map(({ id }) => `legacy-history:${String(id)}`));
  const entries = new Map(review.assignments.map((entry) => [entry.sourceAssignmentId, entry]));

  if (
    selected.length === 0 ||
    selectedIds.size !== selected.length ||
    entries.size !== review.assignments.length ||
    entries.size !== selectedIds.size ||
    review.assignments.some(({ sourceAssignmentId }) => !selectedIds.has(sourceAssignmentId))
  )
    throw new Error("Assignment review must cover each selected source row exactly once");

  if (
    personSnapshot.sourceRepository !== repository ||
    personSnapshot.sourceRevision !== sourceRevision ||
    personSnapshot.snapshotId !== identity.snapshotId ||
    personReport.snapshotKey !== digest([repository, identity.snapshotId])
  )
    throw new Error("Assignment projection requires the matching Person reconciliation");

  const acceptedOccurrences = new Set(
    personReport.occurrences
      .filter(({ disposition }) => disposition === "Accepted")
      .map(({ occurrenceId }) => occurrenceId),
  );
  const acceptedUsers = new Set(
    personSnapshot.occurrences
      .filter(({ occurrenceId }) => acceptedOccurrences.has(occurrenceId))
      .map(({ row }) => personSourceId(row).sourceUserId),
  );
  const people = new Map(
    personSnapshot.mappings
      .filter(({ sourceUserId }) => acceptedUsers.has(sourceUserId))
      .map(({ sourceUserId, personId }) => [sourceUserId, personId]),
  );
  const departments = new Map(
    references.mappings.departments.map(({ sourceDepartmentId, departmentId }) => [
      sourceDepartmentId,
      departmentId,
    ]),
  );
  const semesters = new Map(
    references.mappings.semesters.map(({ sourceSemesterId, semesterId }) => [
      sourceSemesterId,
      semesterId,
    ]),
  );
  const schools = new Map(
    references.mappings.schools.map(({ sourceSchoolId, schoolId }) => [sourceSchoolId, schoolId]),
  );

  const occurrences = selected.map((sourceRow) => {
    const sourceAssignmentId = `legacy-history:${String(sourceRow.id)}`;
    const entry = entries.get(sourceAssignmentId)!;
    const sourceRowDigest = digest(sourceRow);

    if (entry.sourceRowDigest !== sourceRowDigest)
      throw new Error("Assignment review contains a changed source row");
    if (entry.active && sourceRow.bolk === "Bolk 1, Bolk 2" && entry.bothBlocksShareDay !== true)
      throw new Error("An active combined-block assignment requires explicit weekday confirmation");

    const row = {
      sourceAssignmentId,
      sourceUserId: sourceRow.userId === null ? null : `legacy-user:${String(sourceRow.userId)}`,
      sourceDepartmentId:
        sourceRow.departmentId === null ? null : `legacy-department:${String(sourceRow.departmentId)}`,
      sourceSemesterId: review.sourceSemesterId,
      sourceSchoolId:
        sourceRow.schoolId === null ? null : `legacy-school:${String(sourceRow.schoolId)}`,
      active: entry.active,
      affiliationEvidenceRef: entry.affiliationEvidenceRef,
      placementEvidenceRef: entry.placementEvidenceRef,
      // Unknown values stay invalid. Only the importer can quarantine them.
      day: sourceRow.day !== null && Object.hasOwn(days, sourceRow.day) ? days[sourceRow.day] : null,
      block: sourceRow.bolk !== null && Object.hasOwn(blocks, sourceRow.bolk) ? blocks[sourceRow.bolk] : null,
      workdays:
        sourceRow.workdays !== null && /^[1-8]$/.test(sourceRow.workdays)
          ? Number(sourceRow.workdays)
          : sourceRow.workdays,
    };

    return {
      occurrenceId: `legacy-history-row-${String(sourceRow.id)}`,
      row: { ...row, sourceRowDigest: digest(row) },
    };
  });

  const mappings = occurrences.flatMap(({ row }) => {
    if (row.sourceUserId === null || row.sourceDepartmentId === null || row.sourceSchoolId === null)
      return [];
    const personId = people.get(row.sourceUserId);
    const departmentId = departments.get(row.sourceDepartmentId);
    const semesterId = semesters.get(row.sourceSemesterId);
    const schoolId = schools.get(row.sourceSchoolId);

    if (personId === undefined || departmentId === undefined || semesterId === undefined || schoolId === undefined)
      return [];

    return [{
      sourceAssignmentId: row.sourceAssignmentId,
      sourceUserId: row.sourceUserId,
      sourceDepartmentId: row.sourceDepartmentId,
      sourceSemesterId: row.sourceSemesterId,
      sourceSchoolId: row.sourceSchoolId,
      personId,
      departmentId,
      semesterId,
      schoolId,
    }];
  });

  const snapshot = {
    sourceRepository: repository,
    sourceRevision,
    snapshotId: identity.snapshotId,
    sourceWatermark: review.sourceWatermark,
    transformationRevision: identity.transformationRevision,
    synthetic: false,
    review,
    referenceDigest: identity.referenceDigest,
    personSnapshotKey: personReport.snapshotKey,
    occurrences,
    mappings,
  };

  return decodeReconciledCurrentAssignmentSnapshot({ ...snapshot, snapshotDigest: digest(snapshot) });
};

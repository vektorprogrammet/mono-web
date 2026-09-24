import { Schema } from "effect";
import { canonicalJsonBytes, sha256Hex } from "../tutor/evidence.js";
import { compareRfc3339Instants, Rfc3339InstantSchema } from "../time.js";
import { appointmentStateAt } from "./lifecycle.js";
import { DepartmentId, PersonId } from "./schema.js";

const Id = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/)));
const Label = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256)));
const Digest = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)));
const Kind = Schema.Literals(["TeamMembership", "BoardMembership"]);
const bounded = <S extends Schema.Constraint>(schema: S) => Schema.Array(schema).pipe(Schema.check(Schema.isMaxLength(1000)));

export const OrganizationReview = Schema.Struct({
  sourceRevision: Id,
  sourceWatermark: Id,
  asOf: Rfc3339InstantSchema,
  attestedBy: Id,
  evidenceRef: Id,
  memberships: bounded(Schema.Struct({
    sourceKind: Kind,
    sourceId: Id,
    sourceRowDigest: Digest,
    decision: Schema.Literals(["Excluded", "Historical", "Current", "Future"]),
    startAt: Schema.optional(Rfc3339InstantSchema),
    endAt: Schema.optional(Schema.NullOr(Rfc3339InstantSchema)),
    evidenceRef: Id,
  })),
});
export type OrganizationReview = typeof OrganizationReview.Type;

const Occurrence = Schema.Struct({
  occurrenceId: Id,
  sourceKind: Kind,
  sourceId: Id,
  sourceRowDigest: Digest,
  row: Schema.Unknown,
});
export type OrganizationSourceOccurrence = typeof Occurrence.Type;

export const ReviewedOrganizationSnapshot = Schema.Struct({
  sourceRepository: Label,
  sourceRevision: Id,
  snapshotId: Id,
  sourceWatermark: Id,
  transformationRevision: Id,
  snapshotDigest: Digest,
  referenceDigest: Digest,
  personSnapshotKey: Digest,
  review: OrganizationReview,
  departments: bounded(Schema.Unknown),
  teams: bounded(Schema.Unknown),
  boards: bounded(Schema.Unknown),
  positions: bounded(Schema.Unknown),
  occurrences: bounded(Occurrence).pipe(Schema.check(Schema.isMinLength(1))),
  mappings: Schema.Struct({
    persons: bounded(Schema.Struct({ sourceUserId: Id, personId: PersonId })),
    departments: bounded(Schema.Struct({ sourceDepartmentId: Id, departmentId: DepartmentId })),
  }),
});
export type ReviewedOrganizationSnapshot = typeof ReviewedOrganizationSnapshot.Type;

export class OrganizationCohortFailure extends Error {
  readonly name = "OrganizationCohortFailure";
  constructor(readonly code: "InvalidSnapshot" | "InvalidReview" | "SnapshotConflict" | "SourceConflict" | "ReferenceProvenanceConflict" | "PersonSnapshotConflict" | "NoAcceptedAppointments") {
    super(code);
  }
}

export const organizationEvidenceDigest = (value: unknown): string => sha256Hex(canonicalJsonBytes(value));

export const organizationSnapshotDigest = (input: unknown): string => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new OrganizationCohortFailure("InvalidSnapshot");
  const { snapshotDigest: _digest, ...snapshot } = input;
  return organizationEvidenceDigest(snapshot);
};

export const reviewedOrganizationTargetId = (
  kind: "Team" | "Board" | "Position" | "TeamMembership" | "BoardMembership",
  sourceRepository: string,
  sourceId: string,
): string => `org-${organizationEvidenceDigest([kind, sourceRepository, sourceId])}`;

export const validateOrganizationReview = (input: unknown, occurrences: ReadonlyArray<OrganizationSourceOccurrence>): OrganizationReview => {
  let review: OrganizationReview;
  try { review = Schema.decodeUnknownSync(OrganizationReview)(input, { onExcessProperty: "error" }); }
  catch { throw new OrganizationCohortFailure("InvalidReview"); }
  const keys = new Set<string>();
  const entries = new Map(review.memberships.map(entry => [JSON.stringify([entry.sourceKind, entry.sourceId]), entry]));
  if (entries.size !== review.memberships.length || entries.size !== occurrences.length) throw new OrganizationCohortFailure("InvalidReview");
  for (const occurrence of occurrences) {
    const key = JSON.stringify([occurrence.sourceKind, occurrence.sourceId]);
    const entry = entries.get(key);
    if (keys.has(key) || !entry || entry.sourceRowDigest !== occurrence.sourceRowDigest) throw new OrganizationCohortFailure("InvalidReview");
    keys.add(key);
    if (entry.decision === "Excluded") {
      if (entry.startAt !== undefined || entry.endAt !== undefined) throw new OrganizationCohortFailure("InvalidReview");
      continue;
    }
    if (entry.startAt === undefined || entry.endAt === undefined || (entry.endAt !== null && compareRfc3339Instants(entry.endAt, entry.startAt) <= 0)) throw new OrganizationCohortFailure("InvalidReview");
    const state = appointmentStateAt({ startAt: entry.startAt, endAt: entry.endAt, suspended: false }, review.asOf);
    if (state !== (entry.decision === "Historical" ? "Ended" : entry.decision)) throw new OrganizationCohortFailure("InvalidReview");
  }
  return review;
};

export const decodeReviewedOrganizationSnapshot = (input: unknown): ReviewedOrganizationSnapshot => {
  let snapshot: ReviewedOrganizationSnapshot;
  try { snapshot = Schema.decodeUnknownSync(ReviewedOrganizationSnapshot)(input, { onExcessProperty: "error" }); }
  catch { throw new OrganizationCohortFailure("InvalidSnapshot"); }
  if (organizationSnapshotDigest(snapshot) !== snapshot.snapshotDigest || new Set(snapshot.occurrences.map(row => row.occurrenceId)).size !== snapshot.occurrences.length || new Set(snapshot.mappings.persons.map(row => row.sourceUserId)).size !== snapshot.mappings.persons.length || new Set(snapshot.mappings.departments.map(row => row.sourceDepartmentId)).size !== snapshot.mappings.departments.length) throw new OrganizationCohortFailure("InvalidSnapshot");
  if (snapshot.review.sourceRevision !== snapshot.sourceRevision || snapshot.review.sourceWatermark !== snapshot.sourceWatermark) throw new OrganizationCohortFailure("InvalidReview");
  validateOrganizationReview(snapshot.review, snapshot.occurrences);
  return snapshot;
};

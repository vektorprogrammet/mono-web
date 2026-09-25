import type {
  PersonCohortReport,
  PersonCohortSnapshot,
} from "@vektorprogrammet/database/person-cohort";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import {
  decodeReviewedOrganizationSnapshot,
  organizationSnapshotDigest,
  validateOrganizationReview,
  type OrganizationReview,
  type ReviewedOrganizationSnapshot,
} from "@vektorprogrammet/domain/organization";
import { flow, Schema } from "effect";
import { buildLegacyReferences } from "./legacy-cutover-references";
import type { LegacySourceSnapshot } from "./legacy-source-snapshot";

const repository = "vektorprogrammet/vektorprogrammet";

const digest = flow(canonicalJsonBytes, sha256Hex);

const personSourceId = Schema.decodeUnknownSync(Schema.Struct({ sourceUserId: Schema.String }));

/** Bind the complete raw selection before the cutover opens its target transaction. */
export const reviewLegacyOrganizationSource = (
  source: LegacySourceSnapshot,
  reviewInput: OrganizationReview,
) => {
  if (
    source.teams === undefined ||
    source.positions === undefined ||
    source.teamMemberships === undefined ||
    source.executiveBoards === undefined ||
    source.executiveBoardMemberships === undefined
  )
    throw new Error("Organization projection requires all five selected source tables");

  const {
    credentials: _credentials,
    receipts: _receipts,
    paymentAccounts: _paymentAccounts,
    ...selectedSource
  } = source;

  const sourceRevision = digest(selectedSource);

  const occurrences = [
    ...source.teamMemberships.map((row) => ({
      occurrenceId: `legacy-team-membership-row-${String(row.id)}`,
      sourceKind: "TeamMembership" as const,
      sourceId: String(row.id),
      sourceRowDigest: digest(row),
      row,
    })),
    ...source.executiveBoardMemberships.map((row) => ({
      occurrenceId: `legacy-board-membership-row-${String(row.id)}`,
      sourceKind: "BoardMembership" as const,
      sourceId: String(row.id),
      sourceRowDigest: digest(row),
      row,
    })),
  ];

  const review = validateOrganizationReview(reviewInput, occurrences);

  if (review.sourceRevision !== sourceRevision)
    throw new Error("Organization review does not match the source snapshot");

  if (occurrences.length === 0)
    throw new Error("Requested organization source has no appointments");

  return {
    sourceRevision,
    sourceWatermark: review.sourceWatermark,
    review,
    departments: source.departments,
    teams: source.teams,
    boards: source.executiveBoards,
    positions: source.positions,
    occurrences,
  };
};

/** Project source evidence only. Organization owns classification, identities, and canonical writes. */
export const buildLegacyOrganizationSnapshot = (
  source: LegacySourceSnapshot,
  personReport: PersonCohortReport,
  personSnapshot: PersonCohortSnapshot,
  reviewInput: OrganizationReview,
  identity: {
    readonly snapshotId: string;
    readonly transformationRevision: string;
    readonly referenceDigest: string;
  },
): ReviewedOrganizationSnapshot => {
  const reviewed = reviewLegacyOrganizationSource(source, reviewInput);
  const references = buildLegacyReferences(source);

  if (identity.referenceDigest !== references.referenceDigest)
    throw new Error("Organization projection requires the matching reference snapshot");

  if (
    personSnapshot.sourceRepository !== repository ||
    personSnapshot.sourceRevision !== reviewed.sourceRevision ||
    personSnapshot.snapshotId !== identity.snapshotId ||
    personSnapshot.transformationRevision !== identity.transformationRevision ||
    personReport.snapshotKey !== digest([repository, identity.snapshotId])
  )
    throw new Error("Organization projection requires the matching Person reconciliation");

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

  const persons = personSnapshot.mappings
    .filter(({ sourceUserId }) => acceptedUsers.has(sourceUserId))
    .map(({ sourceUserId, personId }) => ({ sourceUserId, personId }));

  const snapshot = {
    ...reviewed,
    sourceRepository: repository,
    snapshotId: identity.snapshotId,
    transformationRevision: identity.transformationRevision,
    referenceDigest: identity.referenceDigest,
    personSnapshotKey: personReport.snapshotKey,
    mappings: { persons, departments: references.mappings.departments },
  };

  return decodeReviewedOrganizationSnapshot({
    ...snapshot,
    snapshotDigest: organizationSnapshotDigest(snapshot),
  });
};

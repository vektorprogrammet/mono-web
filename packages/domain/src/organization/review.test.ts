import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { classifyReviewedOrganization } from "./review-classification.js";
import { DepartmentId, PersonId } from "./schema.js";
import { OrganizationReview, organizationEvidenceDigest, validateOrganizationReview, type OrganizationSourceOccurrence, type ReviewedOrganizationSnapshot } from "./review.js";

const row = { id: 1, userId: 7, teamId: 10, positionId: 1, isTeamLeader: true, isSuspended: false };

const occurrence: OrganizationSourceOccurrence = { occurrenceId: "team-1", sourceKind: "TeamMembership", sourceId: "1", row, sourceRowDigest: organizationEvidenceDigest(row) };

const review = { sourceRevision: "rev", sourceWatermark: "watermark", asOf: "2026-09-01T00:00:00Z", attestedBy: "reviewer", evidenceRef: "evidence", memberships: [{ sourceKind: "TeamMembership", sourceId: "1", sourceRowDigest: occurrence.sourceRowDigest, decision: "Current", startAt: "2026-08-01T00:00:00Z", endAt: null, evidenceRef: "interval" }] };

it("binds every review to the complete raw row rather than two matching digest claims", () => {
  expect(() => validateOrganizationReview(review, [{ ...occurrence, row: { ...row, isSuspended: true } }])).toThrow("InvalidReview");
  expect(() => validateOrganizationReview({ ...review, memberships: [] }, [occurrence])).toThrow("InvalidReview");
  expect(() => validateOrganizationReview({ ...review, memberships: [...review.memberships, ...review.memberships] }, [occurrence])).toThrow("InvalidReview");
});

it("enforces half-open reviewed intervals and explicit excluded variants", () => {
  const historical = { ...review, memberships: [{ ...review.memberships[0], decision: "Historical", endAt: review.asOf }] };
  expect(validateOrganizationReview(historical, [occurrence]).memberships[0]?.decision).toBe("Historical");
  expect(() => validateOrganizationReview({ ...historical, memberships: [{ ...historical.memberships[0], decision: "Current" }] }, [occurrence])).toThrow("InvalidReview");
  expect(() => validateOrganizationReview({ ...review, memberships: [{ ...review.memberships[0], decision: "Excluded" }] }, [occurrence])).toThrow("InvalidReview");
  expect(() => validateOrganizationReview({ ...review, memberships: [{ sourceKind: "TeamMembership", sourceId: "1", sourceRowDigest: occurrence.sourceRowDigest, decision: "Current", evidenceRef: "interval" }] }, [occurrence])).toThrow("InvalidReview");
});

it("preserves reviewed titles and suspension while boards cannot grant leadership", () => {
  const boardRow = { id: 1, userId: 7, boardId: 2, positionName: "Chair", isTeamLeader: true };
  const boardOccurrence: OrganizationSourceOccurrence = { occurrenceId: "board-1", sourceKind: "BoardMembership", sourceId: "1", row: boardRow, sourceRowDigest: organizationEvidenceDigest(boardRow) };
  const suspendedRow = { ...row, isSuspended: "1" };
  const teamOccurrence = { ...occurrence, row: suspendedRow, sourceRowDigest: organizationEvidenceDigest(suspendedRow) };

  const reviewed = Schema.decodeUnknownSync(OrganizationReview)({ ...review, memberships: [
    { ...review.memberships[0], sourceRowDigest: teamOccurrence.sourceRowDigest },
    { ...review.memberships[0], sourceKind: "BoardMembership", sourceRowDigest: boardOccurrence.sourceRowDigest },
  ] });

  const snapshot: ReviewedOrganizationSnapshot = {
    sourceRepository: "repo", sourceRevision: "rev", snapshotId: "snapshot", sourceWatermark: "watermark", transformationRevision: "transform", snapshotDigest: "a".repeat(64), referenceDigest: "b".repeat(64), personSnapshotKey: "c".repeat(64), review: reviewed,
    occurrences: [teamOccurrence, boardOccurrence], departments: [], teams: [{ id: 10, departmentId: 1, name: "Team", active: true }], positions: [{ id: 1, name: "Coordinator" }], boards: [{ id: 2, name: "National board" }], mappings: { persons: [{ sourceUserId: "legacy-user:7", personId: PersonId.make("person-canonical") }], departments: [{ sourceDepartmentId: "legacy-department:1", departmentId: DepartmentId.make("native-department") }] },
  };

  const result = classifyReviewedOrganization(snapshot, { "7": "person-canonical" }, [{ id: 1, name: "Department", shortName: "DEP", email: "department@example.invalid", city: "City" }]);
  expect(result.appointments.map(item => [item.occurrence.sourceKind, item.positionName, item.membership.isTeamLeader, item.membership.isSuspended])).toEqual([
    ["TeamMembership", "Coordinator", true, true], ["BoardMembership", "Chair", false, false],
  ]);
});

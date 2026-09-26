import { createHash } from "node:crypto";
import { canonicalJson } from "@vektorprogrammet/domain/shared-kernel";
import { describe, expect, it } from "vitest";
import { flow, Schema } from "effect";
import {
  currentAssignmentPlacementId,
  decodeCurrentAssignmentSnapshot,
  decodeReconciledCurrentAssignmentSnapshot,
} from "./current-assignment-cohort.js";

const digest = flow(Schema.decodeUnknownSync(Schema.Json), (value) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex"),
);

const signed = <T extends object>(body: T) => ({ ...body, snapshotDigest: digest(body) });

const fixtureBody = {
  sourceRepository: "synthetic",
  sourceRevision: "revision",
  snapshotId: "snapshot",
  sourceWatermark: "watermark",
  transformationRevision: "0109",
  synthetic: true,
  occurrences: [{ occurrenceId: "one", row: {} }],
  mappings: [],
};

describe("synthetic current assignment boundary", () => {
  const fixture = signed(fixtureBody);

  it("retains invalid rows for quarantine but rejects invalid snapshot evidence", () => {
    expect(decodeCurrentAssignmentSnapshot(fixture).occurrences).toEqual(fixtureBody.occurrences);
    expect(() =>
      decodeCurrentAssignmentSnapshot(
        signed({
          ...fixtureBody,
          occurrences: [...fixtureBody.occurrences, ...fixtureBody.occurrences],
        }),
      ),
    ).toThrow("InvalidSnapshot");
    expect(() =>
      decodeCurrentAssignmentSnapshot({ ...fixture, snapshotDigest: "0".repeat(64) }),
    ).toThrow("InvalidSnapshot");
    expect(() =>
      decodeCurrentAssignmentSnapshot(signed({ ...fixtureBody, synthetic: false })),
    ).toThrow("InvalidSnapshot");
  });

  it("keeps source namespaces distinct even when their delimiters collide", () => {
    expect(currentAssignmentPlacementId("source:a", "b")).not.toBe(
      currentAssignmentPlacementId("source", "a:b"),
    );
  });
});

const reviewedRow = {
  sourceAssignmentId: "assignment-1",
  sourceUserId: "user-1",
  sourceDepartmentId: "department-1",
  sourceSemesterId: "semester-1",
  sourceSchoolId: "school-1",
  affiliationEvidenceRef: "affiliation-evidence",
  placementEvidenceRef: "placement-evidence",
  active: true,
  block: "Both",
  day: "Monday",
  workdays: 6,
};

const review = {
  sourceRevision: fixtureBody.sourceRevision,
  sourceWatermark: fixtureBody.sourceWatermark,
  sourceSemesterId: reviewedRow.sourceSemesterId,
  asOf: "2026-09-24",
  attestedBy: "reviewer",
  evidenceRef: "review-evidence",
  assignments: [
    {
      sourceAssignmentId: reviewedRow.sourceAssignmentId,
      sourceRowDigest: digest({ id: 1, bolk: "both", day: "Monday" }),
      active: reviewedRow.active,
      affiliationEvidenceRef: reviewedRow.affiliationEvidenceRef,
      placementEvidenceRef: reviewedRow.placementEvidenceRef,
      bothBlocksShareDay: true,
    },
  ],
};

const reviewedBody = {
  ...fixtureBody,
  synthetic: false,
  review,
  referenceDigest: "a".repeat(64),
  personSnapshotKey: "b".repeat(64),
  occurrences: [
    { occurrenceId: "one", row: { ...reviewedRow, sourceRowDigest: digest(reviewedRow) } },
  ],
};

describe("reviewed current assignment boundary", () => {
  it("keeps reviewed raw evidence separate from the normalized row and retains malformed operational values", () => {
    expect(decodeReconciledCurrentAssignmentSnapshot(signed(reviewedBody)).review).toEqual(review);
    const malformed = { ...reviewedRow, sourceUserId: null, sourceSchoolId: null, day: null };

    const snapshot = signed({
      ...reviewedBody,
      occurrences: [
        { occurrenceId: "one", row: { ...malformed, sourceRowDigest: digest(malformed) } },
      ],
    });

    expect(decodeReconciledCurrentAssignmentSnapshot(snapshot).occurrences).toEqual(
      snapshot.occurrences,
    );
  });

  it("requires one matching review entry for every occurrence", () => {
    for (const assignments of [
      [],
      [...review.assignments, ...review.assignments],
      [{ ...review.assignments[0], sourceAssignmentId: "unknown-assignment" }],
    ]) {
      expect(() =>
        decodeReconciledCurrentAssignmentSnapshot(
          signed({
            ...reviewedBody,
            review: { ...review, assignments },
          }),
        ),
      ).toThrow("InvalidSnapshot");
    }
  });

  it("rejects inconsistent revision, watermark, semester, date, active decisions, and evidence", () => {
    for (const changed of [
      { ...review, sourceRevision: "other-revision" },
      { ...review, sourceWatermark: "other-watermark" },
      { ...review, sourceSemesterId: "other-semester" },
      { ...review, asOf: "2026-02-30" },
      { ...review, assignments: [{ ...review.assignments[0], active: false }] },
      { ...review, assignments: [{ ...review.assignments[0], affiliationEvidenceRef: "other" }] },
      { ...review, assignments: [{ ...review.assignments[0], placementEvidenceRef: "other" }] },
    ]) {
      expect(() =>
        decodeReconciledCurrentAssignmentSnapshot(
          signed({
            ...reviewedBody,
            review: changed,
          }),
        ),
      ).toThrow("InvalidSnapshot");
    }
  });

  it("requires explicit shared-day confirmation for active combined-block rows", () => {
    const { bothBlocksShareDay: _, ...unconfirmed } = review.assignments[0]!;
    expect(() =>
      decodeReconciledCurrentAssignmentSnapshot(
        signed({
          ...reviewedBody,
          review: { ...review, assignments: [unconfirmed] },
        }),
      ),
    ).toThrow("InvalidSnapshot");
  });
});

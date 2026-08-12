import { PREVIEW_IDENTITY, PREVIEW_RESOURCE_ALLOW_LIST, PREVIEW_TAGS } from "./identity.ts";

export const PREVIEW_STATES = [
  "Absent",
  "Requested",
  "Validating",
  "SeedReady",
  "Planned",
  "Applying",
  "Seeding",
  "Live",
  "Retiring",
  "NeedsOperator",
  "Failed",
] as const;
export type PreviewState = (typeof PREVIEW_STATES)[number];

export type PreviewEvent =
  | "opened"
  | "reopened"
  | "synchronize"
  | "closed"
  | "reconcile"
  | "main-dev"
  | "schedule"
  | "cancelled";

const transitions: Record<PreviewState, Partial<Record<PreviewEvent, PreviewState>>> = {
  Absent: { opened: "Requested", reopened: "Requested", reconcile: "Requested" },
  Requested: { opened: "Validating", reopened: "Validating", synchronize: "Validating", reconcile: "Validating" },
  Validating: { opened: "SeedReady", reopened: "SeedReady", synchronize: "SeedReady", reconcile: "SeedReady" },
  SeedReady: { opened: "Planned", reopened: "Planned", synchronize: "Planned", reconcile: "Planned" },
  Planned: { opened: "Applying", reopened: "Applying", synchronize: "Applying", reconcile: "Applying" },
  Applying: { opened: "Seeding", reopened: "Seeding", synchronize: "Seeding", reconcile: "Seeding", cancelled: "Retiring", closed: "Retiring" },
  Seeding: { opened: "Live", reopened: "Live", synchronize: "Live", reconcile: "Live", cancelled: "Retiring", closed: "Retiring" },
  Live: { synchronize: "Retiring", closed: "Retiring", reconcile: "Retiring", cancelled: "Retiring" },
  Retiring: { closed: "Absent", reconcile: "Absent", synchronize: "Absent", cancelled: "NeedsOperator" },
  NeedsOperator: { reconcile: "Requested", closed: "Retiring" },
  Failed: { reconcile: "Requested", closed: "Retiring" },
};

export function transitionPreview(state: PreviewState, event: PreviewEvent): PreviewState {
  const next = transitions[state][event];
  if (!next) throw new Error(`Illegal preview transition: ${state} + ${event}`);
  return next;
}

export type PreviewLedger = {
  readonly key: `${string}#${number}:p20:p20`;
  readonly repository: string;
  readonly pullRequest: number;
  readonly target: "p20";
  readonly stage: "p20";
  readonly attempt: 0 | 1 | 2;
  readonly state: PreviewState;
  readonly sourceSha: string;
  readonly generation: string;
};

export function ledgerKey(repository: string, pullRequest: number): PreviewLedger["key"] {
  if (repository !== PREVIEW_IDENTITY.repository || pullRequest !== PREVIEW_IDENTITY.pullRequest) {
    throw new Error("Preview ledger identity mismatch");
  }
  return `${repository}#${pullRequest}:p20:p20`;
}

export function assertOrphanCandidate(candidate: {
  readonly name: string;
  readonly stage: string;
  readonly tags: Record<string, string>;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly ownershipIds: readonly string[];
  readonly closedObservations: number;
  readonly generationStable: boolean;
  readonly leaseActive: boolean;
}): void {
  if (
    candidate.stage !== PREVIEW_IDENTITY.stage ||
    candidate.tags.app !== PREVIEW_TAGS.app ||
    candidate.tags.stage !== PREVIEW_TAGS.stage ||
    candidate.tags.pr !== PREVIEW_TAGS.pr ||
    candidate.tags.target !== PREVIEW_TAGS.target ||
    (!candidate.name.startsWith(`${PREVIEW_IDENTITY.resourcePrefix}-`) && candidate.name !== PREVIEW_IDENTITY.containerInstance) ||
    !PREVIEW_RESOURCE_ALLOW_LIST.includes(candidate.resourceKind as never) ||
    !candidate.ownershipIds.includes(candidate.resourceId) ||
    candidate.closedObservations < 2 ||
    !candidate.generationStable ||
    candidate.leaseActive
  ) {
    throw new Error("Candidate does not satisfy the exact safe orphan predicate");
  }
}

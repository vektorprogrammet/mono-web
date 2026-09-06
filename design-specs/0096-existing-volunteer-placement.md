# 0096 — Existing-volunteer manual placement

Status: frozen for local implementation, 2026-09-06. Parent: ddd7c91f. See [continuation plan](../docs/migration/continuation-plan.md).

## Felt journey and ownership

A department coordinator explicitly establishes a volunteer affiliation for an existing canonical Person, selects department/semester and an active associated school, creates a placement, reloads, edits and removes it while preserving the person and unrelated/historical placements. Affiliation is Organization-owned with provenance and lifecycle; team membership is not affiliation. Reuse canonical Person, School, Department and Semester references with database integrity. Do not clone names/contact or infer identity from email. Candidate selection must not expose a global private-person directory to department leaders: supply an authorized establishment/discovery path and explicitly explain its authority. Existing native account holders are the first cohort; applicant conversion/activation is a separate contract.

## Legacy source and behavior

Inspect SchoolAdminController, AssistantHistoryController, AssistantHistory entity and CreateAssistantHistoryType under apps/server before coding. The source assessment is in workspace docs/assistant-placement-boundaries-2026-09-06.md. Preserve explicit historical semesters, Monday–Friday, 1–8 workdays, block 1/2/both and legitimate separate blocks at the same school. Do not impose unverified capacity or acceptance-status eligibility. Define duplicate/overlap semantics from inspected source and record any required amendment before implementation. Preserve existing credentials; no activation email or applicant account mutation in this cohort.

## Authority and transition contract

Active department leaders or global admins manage their authorized scope; inactive, wrong-department and anonymous actors reject. Reads expose only intended scoped records. Resolve item scope from persisted references. Establish/revoke affiliation with actor provenance; retain historical placements when affiliation becomes inactive, and reject new placement against inactive affiliation. Reuse native HTTP ETags, conditional mutation, idempotency receipt transactions, fresh authorization before replay, typed problems and private no-store headers. Concurrent commands cannot silently lose updates or create accidental duplicates. Reuse Effect/Layer services, native HttpApi/generated SDK and existing Foldkit/React Router components. No new framework or global mutable authority.

## Acceptance

Run real PostgreSQL/backend/generated SDK/production dashboard/Chromium with synthetic loopback resources: coordinator establishes affiliation, creates/edits/removes placement, reloads and independently checks database values. Exercise historical semester and separate blocks; rejection of invalid values, wrong school scope, inactive affiliation, wrong/inactive roles, forged scope, revoked-authority exact replay, stale and concurrent writes, exact/conflicting retries. Preserve drafts and show actionable conflict recovery; keyboard/mobile/Axe verification. Run appropriate domain/backend/API/SDK/dashboard tests, types, lint/format, generated contract/docs checks. Evidence pins a clean source commit and records cleanup and unsupported boundaries. Coordinate with root before any heavy job.

## Boundaries

One isolated writer owns this spec. Do not edit original checkouts, another worktree, finance implementation or root roadmap/state. No applicant linking, automated scheduler, provider calls, real data, deployment or remote changes. Report reproduced defects and bounded amendments. Commit source by explicit paths and deliver commit IDs, commands/evidence and unresolved risks; stop owned processes after evidence retention.

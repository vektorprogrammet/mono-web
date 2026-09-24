# Requested interview rebooking

Status: frozen for local implementation and acceptance.
Production, provider access, and external delivery remain unauthorized.

## Goal

An applicant requests a new interview time. Authorized staff select a replacement time through the existing scheduling board.
The applicant receives a fresh invitation and can respond to it. The system preserves the previous schedule, invitation, and response evidence.
This slice completes that existing journey. It does not introduce general rescheduling or reminder policy.

## Source boundary

`RecruitmentScheduleCommand` already carries the interview, observed revision, time, location, and message.
The scheduling board already exposes the schedule, response state, response message, and revision.
The invitation model already has invitation identities, schedule revisions, and supersession.
The current schedule store and command receipts permit only one schedule per interview. Current UI gates also reject an existing schedule.
Reuse these domain, persistence, HTTP, SDK, and Foldkit boundaries rather than creating a parallel workflow.

## Behavioral contract

1. Preserve initial scheduling. Permit a replacement only when the current invitation has the applicant response `RequestedNewTime`.
   Pending, accepted, rejected, completed, and cancelled interviews do not acquire a general rescheduling permission.
2. Preserve existing current-actor, interview ownership, department scope, and eligible-interviewer requirements.
   The transaction rechecks authority and the observed interview revision. A retained session or replay cannot preserve revoked authority.
3. The replacement uses a valid future time and the existing location and message validation.
   The scheduling command and its public response keep their existing interface unless a demonstrated invariant requires a complete caller migration.
4. A successful replacement commits one new schedule and invitation, supersedes the old invitation, advances the interview revision, and resets the current response to Pending.
   State, command receipts, audit facts, and notification work commit together. No partial replacement can survive a failed transaction.
5. Preserve old schedules, invitation responses and messages, command receipts, audit records, and immutable notification envelopes.
   Do not overwrite an old schedule to make a foreign key fit. Do not fabricate a second interview, application, assessment, or onboarding decision.
6. The old applicant capability cannot read or mutate the replacement. Its existing invalid or superseded-link behavior remains safe.
   The new capability addresses only the new invitation. Capabilities must not appear in staff projections, audit messages, or public failure details.
7. Exact command replay returns the original outcome without another schedule, invitation, audit event, or notification.
   Current authority precedes replay. An original successful HTTP request can retry with its original revision precondition and idempotency key.
   A changed payload under that key conflicts. Replaying an earlier schedule after a later replacement cannot restore an old schedule or capability.
8. Repeated request-and-rebook cycles work. At most one current invitation exists for an interview.
   Concurrent replacement commands cannot both win. Cancellation, staffing changes, applicant responses, and delivery claims cannot bypass the current-state guards.
9. Staff boards, assignment reads, interview conduct, reports, and applicant progress use the current schedule and invitation without duplicate rows.
   Preserve questionnaire snapshots, assessments, staffing ownership, and later onboarding facts.
10. Superseded invitation and requested-time response work cannot start a new provider attempt after replacement commits.
    Preserve existing claim fences and recovery. Already in-flight delivery may finish its original attempt, but its acknowledgement cannot modify replacement facts.
    A local recording adapter proves local dispatch and acknowledgement only. It does not prove external mail arrival or exactly-once delivery.
11. Staff can see the requested message and previous schedule, enter a replacement, and observe the new Pending invitation through visible controls.
    Transient failure retains the draft and request identity for retry. A stale editor cannot overwrite newer state and retains its draft for explicit recovery.
    Pending controls prevent duplicate submission. Reload shows the committed current schedule.
12. A forward migration accepts existing scheduled interviews and their responses without loss. Accepted migrations remain unchanged.
    The existing current-invitation and historical schedule relationships remain enforced by the database.

## Acceptance

Use synthetic identities, loopback services, disposable PostgreSQL, and the existing local notification recording boundary.
The parent owns runtime execution and admits one heavy job at a time.

- Reproduce RequestedNewTime followed by rejected replacement on the committed baseline through native HTTP and PostgreSQL.
- Exercise initial scheduling, applicant new-time request, replacement, old-link denial, fresh-link response, and a second replacement cycle.
- Upgrade pre-change populated storage with the forward migration. Preserve old records and their relationships.
- Prove exact HTTP replay, changed-payload conflict, stale revision, revoked authority, wrong scope, and disallowed response or terminal states.
- Prove atomic rollback and same-request recovery. Force overlapping replacement and relevant lifecycle or delivery transactions.
- Check superseded pending, failed, recovered, and in-flight notification behavior without changing stored envelopes or acknowledging replacement work.
- Read the current schedule through boards, conduct, report or progress paths affected by the storage change. Historical rows cannot duplicate current projections.
- Complete the staff and applicant journey through the actual browser. Check retained drafts, keyboard submission, reload, narrow layout, and accessibility.
- Run affected maintained journeys, focused behavior regressions, type checks, and generated contract checks.
- Keep source-bound acceptance evidence outside the repository. Distinguish runtime proof, static review, and external-provider limitations.

## Exclusions

No reminder cadence, SMS policy, interview no-show state, arbitrary accepted-interview rescheduling, or coordinator-card redesign belongs to this slice.
No production data access, credential changes, remote publication, deployment, or external mail belongs to this slice.

## Completion

Update STATE.md, the system document, and changelog after acceptance.
Remove the completed specification and disposable scripts, runtimes, and clean integrated worktrees after preserving acceptance evidence.
Commit locally. Do not push or deploy.

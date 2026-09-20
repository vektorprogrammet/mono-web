# 0108 - Interview completion receipt

Status: frozen for local implementation, 2026-09-20. Production release unclaimed.

Baseline: `1c21d680` (`migration/assistant-operations-0906`).

## Goal and product boundary

When the assigned primary interviewer completes a native interview for the first time, the same PostgreSQL transaction records one applicant completion-receipt effect. A local acknowledged worker delivers that effect with a stable idempotency key. A failed attempt stays retryable.

This receipt confirms that the interview was recorded. It is not an admission decision. It does not accept or reject the applicant. It does not create a Person, role, affiliation, placement, co-interviewer designation, or historical classification.

Legacy source: `apps/server/src/App/Interview/Infrastructure/Subscriber/InterviewSubscriber.php` dispatches `sendInterviewReceipt` only from the first `InterviewConductedEvent`. Its recipient is the applicant, its reply address is the interviewer, and its subject is `Vektorprogrammet intervju`. The legacy template directs the applicant to `Min side` and repeats personal and practical information. Native public applications do not own the legacy weekday, double-position, preferred-group, or language fields. The native receipt must not invent them or leak private interview answers, scores, or recommendations.

## Journey

1. An authorized primary interviewer opens an accepted, scheduled interview and completes every required question, score, and explicit recommendation.
2. The finalize command commits the conduct, lifecycle receipt, audit entry, and one `SendInterviewCompletionReceipt` outbox row atomically.
3. The command response reports the receipt as `Pending`; it never claims delivery.
4. A worker claims the outbox row, validates it against the canonical finalization receipt, interview, conduct, applicant contact, and interviewer contact, then sends one immutable first-attempt envelope through the configured notification gateway.
5. The transport acknowledges delivery. PostgreSQL records `Delivered`, the provider reference, and the delivery time, then removes the retained payload.
6. On reload, the dashboard and applicant progress still show the canonical interview-completed state. Notification state is not a second application status.

## Receipt envelope

The immutable delivery request contains only:

- `effectId`, `commandId`, `interviewId`, `applicationId`, and completed interview revision;
- recipient email and applicant display name;
- interviewer display name and reply-to email;
- the fixed semantic kind `SendInterviewCompletionReceipt`.

The delivery adapter owns presentation text, including the subject and link to the applicant page. The request does not contain interview answers, score values, recommendation, phone numbers, capabilities, session data, or an admission outcome.

The effect identity is derived from the canonical finalization command digest. Replaying the same command returns the stored observation and creates no second outbox row. Reusing the command id with different content remains a conflict.

## Failure and concurrency rules

- Finalization and outbox insertion are one transaction. Neither may commit alone.
- Only the first valid `NotCompleted -> Completed` transition creates the effect. Corrections, reads, reloads, imports, and historical reconciliation create none.
- Claims use `FOR UPDATE SKIP LOCKED`. A claimed row has one claim owner.
- Delivery uses `effectId` as the transport idempotency key.
- Rejected, timed-out, or interrupted delivery becomes `Failed` and remains retryable. A stale `Processing` claim returns to `Pending`.
- A successful retry updates the existing row. It does not create another business event.
- Malformed or source-inconsistent envelopes are quarantined, not sent.
- Unauthorized, unlinked, wrong-department, co-interviewer, stale-revision, cancelled, unscheduled, or unaccepted attempts create no conduct, receipt, audit, or outbox row.

## Acceptance

A clean synthetic local rehearsal must show:

1. Browser finalization through the generated SDK and native API commits one completed conduct and one completion outbox row.
2. The response reports `notificationState: "Pending"`; reload shows the completed state without exposing private assessment data to the applicant.
3. A loopback HTTP recipient receives exactly one request with `idempotency-key = effectId`, the bounded envelope above, and no forbidden keys.
4. PostgreSQL records the acknowledged provider reference and delivery time, then clears `payload_json`.
5. An identical finalize replay creates no additional effect or delivery.
6. A forced delivery failure remains retryable; restart delivers the same effect identity once acknowledged.
7. A concurrent double claim has one winner. A tampered source or payload is quarantined without network access.
8. Focused domain, database, backend, HTTP API, SDK, and dashboard checks pass. Generated native API artifacts remain current.

## Explicit non-goals

No coordinator admission decision. No acceptance or rejection message. No placement or affiliation mutation. No co-interviewer assignment. No historical import delivery. No production data, recipient, provider credential, remote push, deployment, or cutover. No legacy dual-write. Production notification transport and cutover require separate operator authority.

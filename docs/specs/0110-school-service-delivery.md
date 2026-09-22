# 0110 — School demand to delivered teaching service

Status: frozen for local implementation, 2026-09-22. Production release is not authorized.

## Goal

A department coordinator can turn school demand and existing active placements into one human-confirmed roster. The system then notifies each assigned volunteer and records one delivered teaching occurrence.

## Authority

Only an active leader for the selected department, or an active global administrator, can read or change the service board. Authority is evaluated again inside each command transaction.

## Owned facts

The native system owns these facts for one department and semester:

- demand for one active school, weekday, and block;
- immutable roster proposals generated from active native placements;
- explicit exception review and human confirmation;
- notification outbox state for each assigned volunteer;
- immutable delivered teaching occurrences;
- audit history for each change.

Existing affiliation and placement facts remain authoritative inputs. A proposal never creates or changes a placement.

## Journey

1. The coordinator records the required volunteer count for a school, weekday, and block. A count of zero removes that demand slot.
2. The coordinator creates a proposal. The proposal snapshots current demand and active placements. A `Both` placement contributes one assignment to each block.
3. The proposal lists every mismatch as one stable exception: unfilled demand, demand exceeded, or an assignment without demand.
4. The coordinator confirms the proposal. The command must name exactly the current exception identifiers. This makes skipped exception review unrepresentable.
5. Confirmation creates one durable notification outbox request for each unique assigned volunteer in the same transaction as the roster, audit, and HTTP command receipt.
6. A configured worker delivers each notification after commit. Failed delivery remains visible and retryable.
7. The coordinator records a delivered occurrence for one confirmed school, weekday, and block. The submitted attendee identifiers must equal the confirmed roster for that slot. Absence and substitute handling are a later journey.

## Invariants

- Demand scope, school association, placement scope, proposal scope, and occurrence scope must match.
- Proposal assignment and exception snapshots are immutable.
- Only a draft proposal can be confirmed.
- Confirmation is an explicit command. Proposal generation never confirms a roster.
- Exception review must be exact: no missing or invented exception identifiers.
- An occurrence cannot be recorded from a draft proposal or an unrostered slot.
- An occurrence date must be inside the selected semester.
- Duplicate occurrence recording for the same confirmed proposal, school, weekday, block, and date is rejected.
- Every mutation is conditional, idempotent, audited, and transaction-bound.

## Observable completion

A real local browser/API/PostgreSQL run must show:

- a demand slot saved;
- an active placement projected into a draft proposal;
- an unfilled slot shown as an exception;
- confirmation rejected when exception review is incomplete;
- confirmation accepted after exact review;
- one notification delivered through an acknowledged loopback transport;
- one delivered occurrence stored with the confirmed attendee;
- a stale concurrent command rejected without changing durable state;
- an unauthorized department actor rejected;
- page reload preserving demand, proposal, confirmation, delivery state, and occurrence.

## Exclusions

- automatic admission decisions;
- automatic placement or matching;
- absence reporting and substitute dispatch;
- certificates and longitudinal reports;
- production data, credentials, providers, deployment, or cutover.

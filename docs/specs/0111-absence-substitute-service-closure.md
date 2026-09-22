# 0111 — Absence, substitute coverage, and service closure

Status: frozen for local implementation, 2026-09-22. Production remains unchanged.

Baseline: `6cea758ebcb959509b416f2ddd963a9d505dccf2` on `migration/absence-dispatch-0922`.

## Goal

Close one school-service outcome when a scheduled volunteer cannot teach.

The journey starts with a confirmed roster slot. It ends with one immutable teaching occurrence and explicit coverage history.

## Existing boundary

The native system already provides these facts:

- a confirmed school-service proposal with a frozen roster;
- one acknowledged roster notification for each assigned volunteer;
- an active, scoped substitute pool;
- one immutable teaching occurrence with exact attendance.

The legacy system has no absence or substitute-dispatch workflow. Its substitute flag and mutable assistant history do not define this contract.

## Actors and authority

- A scheduled volunteer can report their own absence.
- A coordinator can report an absence for a volunteer in their managed department.
- A coordinator can dispatch, withdraw, acknowledge, and close coverage in their managed department.
- A substitute can read and answer only offers addressed to them.
- The delivery worker can deliver notifications. It cannot create business facts.
- Global administration remains an explicit grant. Team labels never grant coverage authority.

Every command resolves current authority inside its transaction. Stale browser authority is insufficient.

## Facts

The implementation must keep these facts separate:

1. **Absence report** — the scheduled person, confirmed slot, service date, reporter, and report time.
2. **Substitute offer** — one selected eligible person, dispatch time, dispatcher, and immutable notification identity.
3. **Offer response** — accepted or declined by the addressed person.
4. **Coverage acknowledgement** — an authorized coordinator acknowledges one accepted offer.
5. **Teaching occurrence** — the people who actually taught the confirmed slot on the service date.
6. **Service closure** — the scheduled person, absence, substitute outcome, occurrence, and closer.
7. **Delivery state** — attempts and provider result for the dispatch notification.

Pool membership is not an offer. Acceptance is not coordinator acknowledgement. Notification delivery is not teaching attendance.

## Service date and slot

An absence targets one person in one confirmed proposal assignment.

The target includes school, weekday, teaching block, and a `YYYY-MM-DD` service date. The date must:

- fall inside the selected semester;
- match the assignment weekday;
- have no existing occurrence for the same proposal, slot, and date.

A report contains no medical reason or free text. This journey does not collect sensitive absence details.

The same absence target can be replayed with the same idempotency key. A distinct duplicate is rejected without another durable row.

## Candidate eligibility

A coordinator selects one candidate at a time. The system does not broadcast offers.

At dispatch time, the selected person must:

- have an active volunteer affiliation in the department;
- have active substitute-pool membership for the semester;
- be available on the slot weekday;
- not be the absent person;
- not already have an active placement for the same weekday and block;
- have no other acknowledged coverage for the same date and block.

Eligibility is rechecked in the dispatch transaction. The offer keeps an immutable eligibility snapshot for later review.

Only one unresolved offer can exist for an absence. An authorized coordinator can withdraw an offered or accepted offer before acknowledgement.

## Response and acknowledgement

Only the addressed candidate can accept or decline an offered offer.

A response is final. A declined or withdrawn offer permits a new sequential offer. At most one accepted offer can exist for an absence.

A coordinator can acknowledge only the accepted offer that is still current. Acknowledgement fixes the substitute for service closure.

Stale, duplicate, wrong-person, cross-scope, and forged commands change no business row, audit row, or outbox row.

## Notification delivery

Dispatch commits the offer, audit entry, and immutable notification envelope in one transaction.

Provider failure does not roll back the offer. The visible delivery state becomes failed and keeps the attempt count and failure tag.

Retry uses the same effect identity and payload. A stale processing claim is recoverable. A malformed or forged envelope is quarantined.

The dashboard must not describe an offer as accepted or acknowledged because its notification was delivered.

## Service closure

A coordinator records one teaching occurrence for the confirmed slot and service date.

Expected attendance equals:

```text
confirmed roster
− people with an absence for this slot and date
+ substitutes with acknowledged coverage for those absences
```

The submitted attendee set must match that result exactly. Duplicate people are invalid.

An absence can close without a substitute. Its outcome is `Uncovered`, and the absent person is not recorded as attending.

A pending offer or an accepted but unacknowledged offer blocks closure. Declined and withdrawn offers do not block closure.

Occurrence recording and service closure commit atomically. Closure stores `Covered` or `Uncovered` for every absence.

The occurrence, absence, offer response, acknowledgement, and closure history are immutable. Later correction requires a separate explicit authority and journey.

## HTTP and concurrency

Every mutation requires `If-Match` and `Idempotency-Key`.

- A stale ETag returns `412` and preserves the submitted draft.
- The same key and request returns the original response.
- The same key with different content returns `409`.
- Conflicting accepted offers return one winner and one deterministic conflict.
- A serialization or deadlock conflict returns the established transaction problem.

Reads are private and use `private, no-store`. The generated OpenAPI and SDK are the only client contract.

## Dashboard journey

The authenticated volunteer surface shows:

- the user's confirmed upcoming roster slots;
- the user's reported absences;
- substitute offers addressed to the user;
- delivery and response state without private directory data.

The coordinator placement surface shows:

- absences for the selected department and semester;
- eligible substitute candidates;
- offer, response, delivery, and acknowledgement state;
- service closure and immutable outcome history.

Forms prevent duplicate submission. A stale response keeps the user's draft and requires explicit refresh and acceptance of the new version.

Desktop and 390-pixel mobile layouts must have no horizontal overflow. Keyboard operation, focus order, labels, status messages, and Axe checks must pass.

## Acceptance journey

Use synthetic local PostgreSQL, the real generated HTTP and SDK clients, the real dashboard, Chromium, and a loopback notification provider.

1. Confirm a roster containing two scheduled volunteers.
2. Sign in as one scheduled volunteer and report absence for a valid service date.
3. Reload and observe the same durable absence.
4. Sign in as the scoped coordinator and dispatch one eligible substitute.
5. Stop the provider, observe failed delivery, restart it, and observe delivery with the same effect identity.
6. Sign in as a different substitute and prove the offer is not visible or answerable.
7. Sign in as the addressed substitute and accept the offer once.
8. Use two coordinator sessions to prove stale acknowledgement changes nothing.
9. Refresh, acknowledge the accepted offer, and reload the durable state.
10. Record exact attendance with the remaining roster member and the substitute.
11. Observe one immutable occurrence and one `Covered` service closure.
12. Run a second absence through decline, sequential redispatch, withdrawal, and `Uncovered` closure.
13. Prove wrong-department, wrong-person, inactive-pool, overlap, duplicate, and stale commands have no side effects.
14. Prove desktop, mobile, keyboard, reload, and accessibility behavior on both actor surfaces.

## Evidence boundary

Focused checks can prove domain transitions, database constraints, HTTP semantics, and generated-contract parity.

Only the real local browser, API, PostgreSQL, and notification journey proves this complete slice. It does not prove production readiness.

No production data, provider, deployment, credential, or cutover action is authorized by this specification.

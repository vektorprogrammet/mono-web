# 0102 — Reopen a rejected expense claim

Status: frozen for local implementation, 2026-09-06. Production release unclaimed.
Base: `24c61a39b680eca0b666df8bd1701ee1efc0e8e9`.
Amends the Rejected-is-terminal rule in [0037](0037-receipt-scoped-approval.md)
and its shared owner/approval Receipt transition model. Refunded and Withdrawn
remain terminal. No generic status setter is introduced.

## Goal and felt journey

An authorized economy approver reopens a rejected receipt for correction. Its
owner edits the same claim, and an approver resolves it again. Keep one identity,
the full audit trail and exact retry/concurrency semantics throughout.

1. An active department/global receipt approver selects rejected claims in the
   existing native approval list and opens one within their current scope.
2. `Åpne for korrigering` issues the explicit semantic reopen command at the shown
   revision. It changes Rejected → Pending once, advances revision once and writes
   one durable audit fact. Success is confirmed by a fresh native list read.
3. The owner reloads their own list and can revise the now-Pending claim through
   the existing owner edit journey. Reopening itself does not change its content.
4. An authorized approver refunds or rejects the corrected Pending claim through
   the existing command. The observed final state and immutable history retain
   the first rejection, reopening, correction and final decision.

## Source and intentional boundaries

Legacy revision `d05c261e9f73297f70ad228635c85ab566c51526`:

- `src/AppBundle/Controller/ReceiptController.php:155–184` accepts status changes
  including Rejected → Pending, retaining the same receipt/content. Same-state
  submission does not create effects.
- `app/Resources/views/receipt_admin/receipts_table_individual.html.twig:87–122`
  provides the status selector and Save action to administrators.
- `ReceiptController.php:106–139` requires owner identity and Pending for owner
  editing. The owner cannot self-reopen a rejection.
- `src/AppBundle/EventSubscriber/ReceiptSubscriber.php:35–53` logs reopening and
  flashes confirmation; reopening sends no owner email. Refund/rejection does.
- The rejection email suggests registering a new expense or contacting economy;
  this is not a source for automatic resubmission or predecessor linking.

Native Receipt currently only mutates Pending receipts. 0037 intentionally made
Rejected terminal; this amendment changes that one explicit law to restore the
verified correction journey under native scoped authority. The legacy generic
status setter can also reopen Refunded while retaining a refund date; that is
not copied. Production route-rule data was not inspected, so this contract uses
the established native Department/Global approval capability, not an inferred
legacy role boundary.

## Ownership and invariants

| Input/fact     | Canonical owner                                         | Rule                                                                                                                                                                          |
| -------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reopen command | Receipt                                                 | Explicit ReopenRejectedReceipt operation; strict decoded request, receipt identity, expected revision and command identity.                                                   |
| Authority      | Identity/Organization → existing receipt approval scope | Active in-scope approver required before first execution and receipt replay; owner-only authority is insufficient.                                                            |
| State          | Existing Receipt row                                    | Only Rejected → Pending; one revision increment. No new receipt or generic status mutation.                                                                                   |
| Content        | Existing Receipt                                        | Keep owner, department, original submission instant, amount, date, description, payment authority, visual ID and attachment unchanged on reopening. Refund date remains null. |
| History        | Existing command receipt/audit transaction              | Record reopening through the existing audit mechanism, with actor/time/revision provenance; preserve all prior evidence.                                                      |
| Delivery       | Existing acknowledged receipt outbox                    | No notification or file effect for reopening. Existing later refund/reject effects still occur exactly once per accepted command.                                             |

No mandatory free-text reason, owner self-reopening, new notification, payment
operation, linked replacement receipt, historical import rewrite or role change.
Reuse the existing Effect Receipt model/update, service, native HTTP resource
conditions, generated SDK, owner/approval lists, form retry handling and outbox.
There must be one transition definition and one generated API contract, not a
second receipt lifecycle maintained beside the first.

The UI must retain a pending command's identity for ambiguous retry, rotate it
when a confirmed command or changed command payload warrants a new identity,
and show a safe conflict/refresh path. No optimistic state transition. A reopened
claim may disappear from a Rejected-only filter; announce success accessibly and
make the updated Pending state inspectable.

## Acceptance gates and falsifiers

- Real PostgreSQL + native API/SDK + production dashboard + Chromium journey:
  rejected claim → scoped approver reopen → owner reload and revise same claim
  → approver resolve again → reload and independent SQL history observation.
- Each accepted transition increments once. Reopening preserves all content and
  identity fields and produces exactly one audit/receipt, zero notification or
  file effects. Subsequent rejection/refund uses the existing acknowledged local
  transport; distinguish acknowledgement from human delivery or bank payment.
- Current wrong-department, owner-only, inactive/revoked authority cannot reopen;
  revoked authority cannot obtain success from an old command receipt.
- Pending, Refunded and Withdrawn cannot reopen. Unknown fields, missing/stale
  revision, changed replay and attempted browser-supplied authority are rejected
  without mutation/audit/outbox writes.
- Exact replay after success is stable. Concurrent reopen attempts have one
  winner; stale owner edits or approval decisions cannot overwrite a newer row.
- Real induced persistence failure rolls back state, command receipt and audit;
  retry after removing the fault is possible without duplicate effects.
- Owner revision remains unavailable while Rejected and becomes available only
  after the authorized reopen. A repeated rejection again removes owner controls.
- Historical rejection remains in audit; no imported historical notification is
  replayed or reconstructed as a reopening side effect.
- Keyboard/mobile and Axe over affected views; browser error capture, production
  build and bounded artifact sensitive-data scan. Unit/property/static checks are
  distinct from actual network/persistence/browser observations.
- Gate a clean committed artifact; retain exact revision and sanitized evidence,
  stop owned processes, and remove private manifests/data after rehearsal.

## Scope

Local synthetic implementation and loopback rehearsals only. No production data,
provider configuration, deployment, credentials, remote PR/push or bank operation.
Full finance parity, real record/file/payment-key reconciliation, reopening paid
claims, administrator arbitrary edits/deletion and production cutover remain open.

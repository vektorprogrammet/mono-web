# 0114 — Expense settlement evidence

Status: frozen for local implementation, 2026-09-22. Production remains unchanged.

Baseline: `2cd025c4` on `migration/finance-operations-0922`.

## Goal

Record durable evidence for one externally settled expense claim without initiating a bank payment.

This journey separates claim approval from payment evidence. It does not add a bank provider, ledger, payroll, procurement, or production authority.

## Decisions

A claim decision and a settlement are separate facts.

- `Pending` can become `Approved`, `Rejected`, or `Withdrawn` under the existing rules.
- `Rejected` can return to `Pending` under the existing reopen rule.
- An `Approved` claim remains approved after settlement.
- Settlement evidence is a separate immutable record.

The current native `Refunded` decision becomes `Approved`. Existing native or imported rows do not gain settlement evidence during this change.

Receipt approval authority does not grant settlement authority. A new effective-dated settlement grant has `Department` or `Global` scope. A current organization relationship and an active settlement grant are both required.

## External boundary

The payment occurs outside the native system. A finance actor records evidence only after the external payment succeeds.

The native system does not:

- read or decrypt a bank account for the finance actor;
- call a bank or payment provider;
- infer payment from approval, a receipt status, or an import row;
- reconcile bank statements;
- retry or reverse an external payment.

## Settlement evidence

The server records one settlement for one approved claim. The record contains:

- a server-issued settlement identity;
- the receipt identity;
- the approved amount and `NOK`, copied from the locked claim;
- a SHA-256 fingerprint of the claim's stored payment destination;
- a trimmed external authority name;
- a trimmed external transaction reference;
- the external settlement instant;
- the recording Person and transaction instant;
- the resulting receipt revision.

The caller supplies only the external authority, external reference, settlement instant, and expected receipt revision. The settlement instant cannot be after the recording instant.

The pair of external authority and external reference identifies one external payment. The database prevents the same payment from settling two claims. A settled claim cannot receive a second settlement record.

Settlement evidence is immutable. Correction, reversal, chargeback, batch payment, and partial payment are outside this journey.

## Commands and reads

The clean native contract uses these operations:

- approve a pending claim;
- list claims visible to the current settlement grant;
- record settlement evidence for one approved and unsettled claim;
- read settlement evidence through owner and authorized finance projections.

The former `refund` command and `Refunded` status are removed. The dashboard uses `Godkjent`, not `Refundert`, until settlement evidence exists.

A settlement command requires an idempotency key and the visible receipt revision. The command locks the current receipt, authority, and external reference in one transaction. It records the settlement, receipt revision, command receipt, audit row, and owner notification outbox work atomically.

An idempotent replay returns the first response. A concurrent duplicate returns an in-flight response or the first completed response. A changed body with the same idempotency identity fails without another write.

## Authority and concealment

A department settlement grant covers approved claims in that department. A global settlement grant covers all departments.

An anonymous caller, ordinary member, receipt owner, receipt approver without a settlement grant, inactive grantee, expired grantee, or grantee from another department cannot record settlement evidence.

An unknown or out-of-scope receipt is concealed as not found. Settlement queue rows and settlement details use the same policy. A hidden dashboard control is not authority.

## Dashboard journey

The existing expense area distinguishes claim approval from settlement.

- An approver marks a pending claim as approved or rejected.
- A settlement actor opens the settlement queue.
- The queue shows approved claims without settlement evidence in the actor's scope.
- The actor enters the external authority, reference, and settlement instant.
- A confirmation names the claim, amount, and external reference.
- After recording, the row shows immutable settlement evidence.
- The owner view shows `Godkjent` and the recorded settlement details as separate facts.

The surface remains usable with a keyboard and at a 390-pixel viewport. Pending, failure, empty, replay, and stale-revision states remain explicit.

## Contract generation

Domain schemas are the source for HTTP response types. Regenerate OpenAPI, backend metadata, and the SDK. Do not edit generated outputs by hand.

## Acceptance journey

Use synthetic local PostgreSQL, seeded native identity and organization authority, the generated SDK, the real backend, the real dashboard, and Chromium.

1. Submit one expense claim and approve it with the existing scoped approval authority.
2. Prove that approval changes the claim to `Approved` and creates no settlement evidence.
3. Sign in as a different Person with an explicit department settlement grant.
4. List the approved claim in the settlement queue.
5. Record an external authority, unique transaction reference, and past settlement instant.
6. Observe the exact immutable evidence in the finance and owner views.
7. Prove that the amount, currency, destination fingerprint, actor, timestamps, and revision match PostgreSQL.
8. Prove that an approver without a settlement grant cannot settle the claim.
9. Prove anonymous, ordinary, inactive, expired, wrong-department, owner-only, and unknown-receipt denials.
10. Prove that pending, rejected, withdrawn, and already-settled claims cannot receive settlement evidence.
11. Prove stale revision, duplicate external reference, idempotent replay, changed replay, and concurrent duplicate behavior.
12. Prove notification failure, restart, and acknowledged retry without another settlement write.
13. Prove desktop, mobile, keyboard, reload, and accessibility behavior.
14. Prove that the journey performs no external network or provider action.

## Evidence boundary

Focused checks can prove schemas, transitions, SQL constraints, authority, generated contracts, and deterministic fingerprints.

Only the local browser, API, and PostgreSQL journey proves this complete slice. It does not prove that an external payment occurred.

This specification does not authorize production data, providers, credentials, deployment, grant assignment, payment, or cutover actions.

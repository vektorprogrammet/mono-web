# 0097 — Acknowledged receipt notification delivery

Status: frozen for local implementation, 2026-09-06. Parent: ddd7c91f. See [continuation plan](../docs/migration/continuation-plan.md).

## Felt journey

A native receipt submission or refund/rejection produces the intended recipient notification through an explicit configured acknowledged transport. A transport failure must not be represented as Delivered. An operator can retry pending delivery without duplicating the business mutation; historical imports produce zero notification attempts. Delivery means the configured transport acknowledged acceptance, not proof a human read mail.

## Ownership and sources

Inspect canonical receipt outbox/effect Services, backend auxiliaryEffects composition, contact delivery adapter, receipt authority/profile and legacy ReceiptSubscriber. Reuse the existing outbox and authoritative SQL audit; no second queue/audit registry or in-memory recording production success. Resolve recipients from authorized canonical facts with explicit configuration for any economy recipient policy; never guess a team title/email. Keep payloads/private payment and file storage material out of public errors/logs. Concrete transport belongs at composition root, portable domain effects remain abstract. Missing configuration fails loudly or leaves work pending, never silently delivered. Define retry, stable delivery identity, acknowledgement, crash/ambiguous response and receiver deduplication semantics honestly; no unsupported exactly-once claim. Preserve independent SQL audit semantics.

## Acceptance

Use real native API/PostgreSQL and an actual loopback HTTP delivery sink; reuse existing local runner patterns. Exercise submission, refund and rejection recipients/content; forced transport rejection, timeout/ambiguous acknowledgement, retry and restart, concurrent drain if supported; prove mutation is not duplicated and outbox state tracks acknowledged delivery. Verify configured destination/token boundaries and no redirects to uncontrolled destinations. Observe zero notification attempts for synthetic historical import at the effect boundary. Test missing/invalid configuration, revoked approval scope and no private material in evidence. Run targeted domain/backend tests/types/format/lint and regression import journey where affected. Evidence pins a clean commit, names transport acceptance limits and cleans resources. Request root heavy-job admission before runtime builds/runners.

## Boundaries

One isolated writer owns this spec. Local code and synthetic loopback only: no provider credentials, real recipients, real data, production config or remote effects. Do not edit placement implementation or root roadmap/state. Account migration/recovery, payment-key migration, receipt reopening and production writer fencing remain separate contracts. Before broad changes record a bounded spec amendment. Deliver committed source, exact evidence, unrun boundaries and stopped owned processes.

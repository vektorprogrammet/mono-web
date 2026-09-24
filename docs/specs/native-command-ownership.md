# Native command ownership

Status: frozen for local implementation and acceptance.

## Goal

Apply the approved architecture review without changing native business behavior or production authority.
HTTP callers use complete business commands. Runtime roots own execution. Verification programs do not belong to reusable product libraries.

## Contract

- Preserve the existing Placements, coverage, and Recruitment user journeys and canonical HTTP/SDK contracts.
- Preserve current authority before replay, lock ordering, stale-write rejection, exact replay, conflicting-command rejection, and one committing transaction.
- Preserve atomic business facts, audit, immutable history, outbox entries, and transport response receipts.
- HTTP owns request decoding, credential resolution, protocol preconditions, response receipts, and response encoding. It does not sequence low-level business mutations.
- Reuse the existing Economy complete-command precedent and Effect services. A forwarding wrapper does not satisfy this contract.
- Trial domain-oriented locality in Placements only. Keep executable roots in apps, browser workflows in their app, and one authoritative HTTP contract and generated SDK.
- Keep browser-safe contracts separate from PostgreSQL adapters. Enforce the selected import boundaries, including relative imports.
- Move cross-application executable proofs to explicit tooling ownership. Preserve their real PostgreSQL/provider-seam checks and cleanup.
- Remove overlapping receipt entry paths and the Schools initial-load forwarding helper after checking every caller. Preserve workflow loading and cancellation.
- Compose the existing recruitment delivery worker with explicit provider configuration, lifecycle supervision, and shutdown. Local development must keep external delivery disabled.
- Correct the duplicate workflow environment keys identified by the review without running or publishing the workflow.
- Do not merge Admissions and Recruitment, conflate distinct eligibility rules, replace outbox mechanisms, or treat static unused-code candidates as deletion authority.
- Do not provision infrastructure, access production data, use provider credentials, send external messages, or deploy.

## Acceptance

1. Inventory affected exports, callers, runtime roots, and maintained verification commands before implementation.
2. Existing mounted HTTP/PostgreSQL journeys preserve authorization, replay, stale revisions, concurrency, rollback, audit, and outbox outcomes.
3. Exercise the real native browser journey through the changed service boundary with synthetic local resources.
4. Exercise worker start, recovery, local delivery acknowledgement, cancellation, and shutdown through the selected composition. Prove local development sends no external effects.
5. Run relocated proof entry points against owned disposable resources. No launch-only forwarding or product-to-proof dependency remains in the affected scope.
6. Verify unchanged generated HTTP/SDK contracts, affected type checks, focused regressions, lint, and formatting.
7. Demonstrate smaller caller knowledge and supported exports. Verify browser-to-PostgreSQL, product-to-proof, and sibling-to-private-module violations are rejected.
8. Record exact source-bound evidence and limits outside the repository. Update architecture and migration state, then remove this completed specification.

## Review source

The operator supplied `/tmp/architecture-findings-2026-09-24T15-49-42-636Z.html`.
Its cycle, clone, and unused-code counts are bounded research observations, not runtime or deployment acceptance.

# Reimbursement golden journey

Status: frozen for local implementation.

## Goal

A volunteer submits a claim and a private receipt through the native dashboard.
A scoped approver reviews it. A separately authorized finance actor records evidence of an external settlement.
The volunteer sees that evidence after a fresh sign-in.
Approval does not prove payment. The program does not execute a payment.

This slice qualifies and repairs the existing receipt boundaries. It does not replace them with another framework.
The [expense contract](../system.md#expense-reimbursement) owns business meaning.

## Scope and exclusions

Use synthetic people, disposable local PostgreSQL, private local files, and a loopback notification provider.
Use the actual native Bun composition and dashboard controls for the primary journey.
Fixtures create prerequisites only: people, credentials, authority, and organizational references.
Fixtures do not create the claim, approval, settlement evidence, or successful delivery outcomes.

No production access, provider credentials, payment execution, deployment, or cutover belongs in this slice.
Current-data reconciliation and unresolved operational policies remain separate gates.
No dependency upgrade, new queue framework, test sharding, or documentation platform belongs in this slice.

## Observable acceptance

1. The volunteer uploads private bytes and submits the claim through the dashboard.
2. Another volunteer and wrong-scope staff cannot read the claim or attachment.
3. A scoped approver reads the attachment and approves the claim through the dashboard.
4. Approval leaves the claim Approved. Approval authority does not grant settlement authority.
5. A separately authorized actor records settlement evidence through the dashboard.
6. A fresh volunteer session shows the same claim and settlement evidence.
7. Reloads, repeated submissions, and overlapping commands preserve committed facts without duplicate decisions or evidence.
8. Stale or unauthorized commands preserve prior business state, audit, and outbox facts.
9. The private bytes survive a native process restart and remain accessible only through authorized reads.
10. Notification failure preserves the business decision. Unattended recovery delivers the retained notification without another business command.
11. Independent PostgreSQL and file observations bind the browser actors and claim to the same committed facts and exact bytes.
12. Sanitized evidence identifies the unchanged committed source and every required checkpoint.
13. Failure or interruption fails the command and releases owned processes, listeners, databases, credentials, and private files.
14. Visual inspection covers the actual owner, approver, and settlement surfaces, including narrow layout and keyboard access.

## Resource bounds

Reuse existing limits and ownership mechanisms. Record their authoritative source and executable evidence.
Repair a missing bound at its owning boundary rather than raising machine limits.

- Attachments have an explicit byte limit enforced before unbounded materialization. Use bounded transfer buffers or streaming where supported.
- Delivery has fixed concurrency, bounded provider deadlines, and explicit retry semantics. Preserve per-receipt ordering and ambiguity handling.
- Collection reads and client rendering have explicit result bounds or pagination. A bound must not silently hide required operational records.
- Process ownership and count are explicit. No process starts per claim, retry, or poll.
- Avoid avoidable copies and per-item allocations. Reuse startup resources where ownership permits it.
- Do not claim allocation-free JavaScript or third-party behavior without measurements.
- Record process and memory observations during the real journey and after cleanup. Only one heavy acceptance job runs at a time.

## Reuse and documentation

Start with the existing receipt owner, approval, settlement, and delivery-recovery runners.
Reuse the established disposable-resource lifecycle and source-bound evidence formats where they fit.
Keep this journey separate from the school-service and recruitment stories.

Provide one discoverable receipt consumer and maintainer guide with a public-import executable example.
Reuse the accepted module-documentation pattern and compiler checks.
Explain authority, transaction boundaries, file custody, replay, delivery recovery, resource limits, and supported changes.
Link canonical declarations and business rules rather than copying their schemas or constants.

## Ownership and completion

Each writer owns a separate worktree. Shared integration files have one owner.
The integrating parent owns root command registration, shared state, changelog, integration, and final acceptance.
Writers request the single heavy-runtime slot before browser, PostgreSQL acceptance, or large builds.
No runtime grant authorizes overlapping jobs.

The slice is complete only when the continuous journey and its resource-bound checks pass on integrated source.
Retain failure evidence outside the repository. Retire this specification after its contract is represented by code, guides, and acceptance records.

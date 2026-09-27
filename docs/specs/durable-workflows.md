# Durable workflows

Status: frozen for implementation on 2026-09-26 (operator decision). Remove this specification when the flows below run on it, and `docs/architecture.md` and the effect-house overlay describe when to use it.

## Problem

A database transaction can't include work in another system. The review found two such flows where a partial failure left the system stuck:
- OAuth client provisioning spans adapter calls and a transaction.
- Refresh-token rotation happens in Better Auth before local tracking.

Outbox delivery covers "commit, then deliver". It doesn't cover a multi-step flow whose steps each touch a different system and must either all complete or be compensated.

## Decision

Use Effect Cluster **workflows** (`effect/unstable/cluster`, pinned `effect@4.0.0-rc.116`) for multi-step flows across systems:
- Each activity's result is persisted, and a replay after a crash or failure skips completed activities.
- A failed step runs compensation for the completed ones.
- Idempotency comes from the workflow execution id, derived from the command's idempotency key.

Cluster **entities** (single writer per id) are out of scope. The command-and-lock model in [commands and concurrency](commands-and-concurrency.md) stays the general mechanism, and entities are reconsidered only if its declared locks prove insufficient.

This fills the gap that [infrastructure ports](infrastructure-ports.md) reserved: "Durable workflows, reminders, and scheduled jobs … use Effect cluster in a later specification". Reminders and schedules (`ClusterCron`, `DeliverAt`) are a later slice.

## Scope

1. **OAuth client provisioning:** create the client, create the resource, then bind the service principal, as one workflow with compensation. Retrying the same manifest resumes it, and the confidential secret is returned exactly once.
2. **Refresh-token rotation:** where the provider rotation can't join the local transaction, a workflow or an idempotent recovery record makes a retry of the same old token within a bounded window return the already-issued rotation. Real token replay still revokes the family. If OAuthFix already solved this with an idempotent window, keep that, and record why a workflow isn't needed.
3. Workflow message storage uses the repository's PostgreSQL, through the Cluster SQL storage Layer, behind the `Database` port. Runners start from the backend composition root, and on hosts that scale to zero they use a bounded drain trigger, like the outbox.

## Done when

1. Fault injection at each activity boundary (a test Layer that fails activity N) ends every run either completed or fully compensated; there is no stuck state.
2. Retrying a failed provisioning with the same manifest completes it without a duplicate client, and the secret is returned exactly once.
3. The Cluster storage tables are created by a numbered migration, and the version pin is re-audited on any `effect` bump.
4. `just check` and the hosted workflows pass.

## Order

After OAuthFix lands: it may resolve the rotation case more simply. Before any new provider-crossing flow.

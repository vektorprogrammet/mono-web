# 0107 - Reconciled Account import

Status: frozen for local implementation, 2026-09-22. Production use is not authorized.

Baseline: `436afa052ab7caf5dd5b686ed621c1a19199fc23` on
`migration/assistant-operations-0906`.

## Goal

Import a supported legacy credential into one native Account only after the same
legacy identity has an accepted Person reconciliation. Keep legacy aliases and
unsupported credentials outside the native authentication surface.

## Journey

1. An operator-controlled synthetic Person snapshot resolves a legacy source user
   to one Person.
2. A separate synthetic credential snapshot presents the active source user,
   canonical private email, password hash, explicit Person mapping, and email
   ownership evidence.
3. The Account import accepts the row only when source repository, source user, and
   Person match the immutable accepted Person reconciliation.
4. The imported credential signs in through the real native authentication path.
   Username and company-email aliases do not sign in.
5. Replay, concurrent first import, recovery, and restore preserve one Account and
   one immutable evidence chain.

## Acceptance boundary

- A profile without accepted Person-reconciliation evidence is quarantined as
  `PersonReconciliationMissing`; no auth user, account, audit event, or credential
  import row is written.
- A supported PHP bcrypt `$2y$` cost-12 credential with matching active source,
  Person evidence, mapping, and email attestation creates exactly one native auth
  user and credential account.
- Inactive rows, missing passwords, unsupported hashes, ambiguous mappings,
  duplicate source/email/target values, unattested email, existing auth targets,
  and email conflicts remain quarantined without partial auth writes.
- Legacy username and company-email aliases are reported as unsupported, are not
  stored as native login identities, and cannot authenticate.
- Exact replay is stable. Two concurrent first imports commit one Account/evidence
  set. Changed replay or changed source identity fails closed.
- A forced persistence failure rolls back the auth user, account, audit, occurrence,
  and import writes together. Accepted evidence remains immutable.
- The disposable CLI rejects non-private input files, non-loopback PostgreSQL,
  non-disposable database names, non-local deployment, and non-synthetic mode.

## Evidence

Run the focused database checks and the owned PostgreSQL identity-cohort rehearsal
from a clean exact commit. The rehearsal must exercise the native auth HTTP path,
password reset/session revocation, backup/restore, and both native and retained
legacy password verification.

## Excluded

No production snapshot, credential, provider, email, deployment, writer transfer,
or remote effect. Real cohort mapping and production import require separate
operator authority.

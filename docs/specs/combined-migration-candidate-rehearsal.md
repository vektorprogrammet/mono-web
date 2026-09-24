# Combined migration candidate rehearsal

Status: frozen for local implementation and acceptance.

## Goal

An operator can rehearse one coherent migration candidate through the existing import boundaries and native application services.
The candidate uses one immutable synthetic source, reviewed evidence, one PostgreSQL target, and private receipt files.
A separate run of the authorized historical backup establishes only the facts that backup contains.
No production access, provider operation, deployment, or writer transfer is authorized.

## Journey

1. Create private disposable MariaDB and PostgreSQL instances through the existing rehearsal runtime.
2. Read the synthetic source with the existing SELECT-only snapshot reader.
3. Bind Organization, current-assignment, and receipt reviews to the same base source evidence and accepted Person cohort.
4. Run the existing cutover command for references, People, Organization, historical service, current assignments, and Accounts.
5. Run the existing receipt CLI against that target with explicit private-file and payment-account custody.
6. Exercise native sign-in and scoped operational reads with the imported identities.
7. Exercise replay, interruption between phases, file-promotion recovery, and database plus file restore.
8. Retain a private source-bound report, then remove owned databases, processes, secrets, and temporary files.

## Constraints

- Reuse the existing source reader, cutover, reviewed importers, native services, and disposable database runtime.
- Do not replace the import contracts or add a general orchestration platform.
- SQL and private files remain separate commit domains. A committed SQL phase does not mean the complete candidate succeeded.
- The synthetic source has no concurrent writer during acceptance. Separate reader transactions must agree on source evidence.
- Changed source evidence must fail closed before another phase can report success.
- Native edits, credentials, and receipt ciphertext survive replay. Missing or conflicting private bytes remain observable until recovery.
- Reports contain counts, dispositions, checks, source provenance, and evidence limits. They contain no personal source data, credentials, or payment-account plaintext.
- Incomplete imports, unresolved work, and synthetic evidence never imply production readiness.
- Historical membership does not grant current authority. Reviewed current leadership has department scope only.
- Legacy refunded status does not establish native settlement evidence.

## Acceptance

The combined synthetic journey must establish these observations through real MariaDB, PostgreSQL, private bytes, and native application boundaries:

- All selected source occurrences have an accounted disposition, including quarantine and explicit exclusion examples.
- References, Person mappings, Accounts, appointments, assignments, history, and receipts share one candidate and one target.
- A supported imported credential signs in through native authentication and resolves to its accepted Person.
- Imported users can read their own profiles and permitted operational records. Unrelated users cannot read private receipts.
- Current leadership has only the reviewed department scope. Historical leadership cannot obtain current coordinator authority.
- Exact replay preserves later native edits and does not duplicate imported facts or fabricate import-time notifications, audit events, grants, or settlements.
- SQL rollback leaves no partial candidate facts after a failed cutover transaction.
- An interruption after SQL import leaves the receipt phase incomplete. A fresh process can resume it without losing SQL facts.
- A file-promotion failure cannot report complete acceptance. A fresh CLI process can recover it with the same reviewed evidence.
- A logical PostgreSQL restore and private-file restore preserve the candidate, encrypted accounts, ownership, and subsequent replay behavior.
- The report binds the tested executable source, schema revision, candidate evidence, and named successful checks.
- Owned runtime resources stop and private temporary data is removed after success or failure.

The historical-backup journey must run separately through the existing authorized backup rehearsal.
Its report must name the actual imported cohorts and unresolved cohorts.
It must not invent current assignments, current authority, private receipt bytes, mailbox ownership, or settlement evidence.
If the authorized artifact is unavailable, report the missing input and completed synthetic evidence separately.

## Completion

Run the actual combined command and historical command, when its authorized artifact exists.
Run affected type checks, scoped lint, and formatting checks.
Retain source-bound evidence outside the product repository.
Update existing migration documentation with the command, observed results, and remaining gates.
No production-readiness claim follows from this local acceptance.

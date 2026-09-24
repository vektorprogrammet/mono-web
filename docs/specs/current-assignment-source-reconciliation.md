# Current assignment source reconciliation

Status: frozen for local implementation and rehearsal. Production access and cutover remain unauthorized.

## Goal

An operator can reconcile reviewed legacy assignments through the supported Placements import boundary.
The cutover command imports references, accepted People, historical service, reviewed current assignments, and Accounts in one target transaction.
A historical backup alone never establishes current assignments.

## Source contract

The existing SELECT-only reader remains the source of six-table, consistent snapshots.
The source revision hashes the snapshot without credential material, as the existing cutover command does.
A separate review declares the source revision, source watermark, source semester, effective date, reviewer, and evidence reference.
The effective date must be a valid date inside the mapped semester. No clock-based semester selection is permitted.
Every source assignment in the selected semester needs exactly one review entry. Unknown, duplicate, missing, or changed entries reject the review.
An empty selected semester rejects reconciliation. Other semesters never become current placements through this command.
Each entry pins the raw source-row digest, an active decision, and separate affiliation and placement evidence references.
Combined-block rows require explicit confirmation that their one weekday applies to both blocks. The importer does not invent a split.
The review is supplied evidence, not independent proof of currentness, freshness, or operator authority.

## Shared interface

`@vektorprogrammet/placements/contracts` exposes the portable `CurrentAssignmentReview` schema and existing synthetic snapshot contract.
The review has these fields:

- `sourceRevision`, `sourceWatermark`, `sourceSemesterId`, `asOf` (`YYYY-MM-DD`), `attestedBy`, and `evidenceRef`.
- `assignments`: entries with `sourceAssignmentId`, `sourceRowDigest`, `active`, `affiliationEvidenceRef`, and `placementEvidenceRef`.
- Each entry can contain `bothBlocksShareDay: true`, required for an active combined-block assignment.

The new `ReconciledCurrentAssignmentSnapshot` retains the existing snapshot fields except `synthetic`.
It requires `synthetic: false`, `review: CurrentAssignmentReview`, `referenceDigest`, and `personSnapshotKey`.
Both snapshot variants use the existing canonical digest rule. The synthetic decoder continues to reject real-source input.
`@vektorprogrammet/placements/server` exposes the existing synthetic import and a separate `importReconciledCurrentAssignmentCohort` command.
The real command accepts `(pool, input, client?)`. An explicit client keeps transaction custody with the cutover command.
No database package imports Placements. Cross-application assignment runners move to verification tooling.

## Behavior

1. The source adapter resolves Person identities only through accepted Person occurrences and their mappings.
2. The importer checks reference provenance from the same source revision and snapshot. Native existence alone is insufficient.
3. The importer checks the bound Person snapshot and the exact accepted source-user mapping.
4. Placements owns import validation, transaction sequencing, target conflicts, canonical writes, and append-only provenance.
5. The real import retains its review and source classification in an append-only ledger. Existing migrations remain unchanged.
6. Every selected occurrence has an accepted or quarantined disposition. Invalid legacy values and unresolved Person mappings never create canonical facts.
7. Selected current rows do not enter the historical service import. A current-only source does not require fabricated historical rows.
8. Exact replay preserves later native changes. Changed source identities, review, references, or snapshot content fail without partial writes.
9. Existing conflict, overlap, concurrency, and rollback guarantees remain. Inactive rows do not compete for active target slots.
10. Import creates no human decision audits, service occurrences, notification envelopes, or authority grants.
11. The cutover requires an explicit assignment choice: `NotRequested` or a decoded review. The CLI accepts `--current-assignments=none` or a review file path.
12. Reports distinguish historical-only import, reviewed assignments, quarantine, and scope dates. They omit credentials and raw personal fields.

## Acceptance

- Run the existing synthetic assignment rehearsal through the relocated public boundary. Its real-source and ambient-provider refusals remain.
- Run the real reader and cutover against disposable MariaDB and PostgreSQL with faithful synthetic legacy tables.
- Observe normalized canonical placements, accepted-Person dependence, reference provenance, inactive and malformed rows, and combined-block confirmation.
- Exercise missing, changed, duplicate, wrong-semester, and invalid-date review evidence. Rejected review input leaves the target unchanged.
- Exercise current-only source, whole-cutover rollback, exact replay after native changes, and concurrent replay.
- Check append-only review retention and absence of fabricated audit, authority, attendance, or notification facts.
- Check affected types, lint, formatting, and focused regression tests. Reuse existing runners and import rules instead of a new migration framework.
- Record exact source revision and local evidence. Faithful synthetic fixtures do not establish production parity or current live assignments.

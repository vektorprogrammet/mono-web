# Legacy backup Person migration rehearsal

Status: frozen for local implementation on 2026-09-23. Production access and cutover remain unauthorized.

## Goal

Given the private legacy MySQL snapshot whose SHA-256 is
`0ee71a6d3009181f1711ca9ee73917a8945c340d1ecd9f729ba12ecd57a88df5`, restore the
snapshot into an isolated local source database, derive the existing native Person
cohort contract, and import that cohort into a clean disposable PostgreSQL database.
The rehearsal must use the same Person import path intended for final migration.

The operator receives a bounded report of schema identity, source classifications,
import outcomes, replay, and restore. The report contains no source row values or
personal data.

## Boundaries

- The original SQL file is read-only input. The rehearsal must not modify it.
- Source and derived private files live outside the repository in an owner-only
  directory. Directories use mode `0700`; files use mode `0600`.
- The restored MySQL service and disposable PostgreSQL service are reachable only
  from the local rehearsal process. They expose no public listener.
- Source rows, names, email addresses, phone numbers, password material, free text,
  and file paths must not enter stdout, stderr, test snapshots, screenshots,
  committed files, or agent output.
- Product packages do not import migration-tool code. Source extraction belongs to
  the temporary migration tooling; the existing Person cohort contract and importer
  remain the native write boundary.
- No mail, SMS, storage, payment, OAuth, DNS, Cloudflare, or other external provider
  is used.
- This journey migrates Person and profile identity only. Credentials, aliases,
  affiliations, placements, receipts, private files, and active operations remain
  later cohorts.

## Accepted source shape

The rehearsal must independently reproduce these source-shape facts before reading
business rows:

- 65 tables in total;
- 48 Doctrine entity tables;
- 16 relation tables;
- one `migration_versions` table;
- 349 columns;
- 94 foreign keys;
- the 71 applied migration identifiers match the 71 declared legacy migrations.

A mismatch stops before target writes and reports only structural differences.

## Person derivation

Each legacy user occurrence receives exactly one disposition:

- accepted for a new native Person and profile;
- accepted as an exact replay;
- inactive and intentionally excluded;
- quarantined with one existing `PersonCohortReason` reason code.

Technical Person identifiers may be derived deterministically from immutable legacy
source identifiers. Business facts must not be inferred. Email ownership must be
explicitly supported by the accepted legacy row and must not be guessed through a
username or alias. Duplicate source identifiers, duplicate email ownership, invalid
profile values, target conflicts, and ambiguous mappings are quarantined.

The derived cohort records the source snapshot digest and source-row digests. The
private cohort artifact is decoded by `PersonCohortSnapshot` before target writes.

## Acceptance

1. A single bounded local command validates source custody and checksum, restores the
   legacy snapshot, verifies the accepted structural shape, derives the private
   Person cohort, migrates a clean native PostgreSQL database, and emits one
   aggregate JSON report.
2. Every legacy user occurrence is represented once in the aggregate classification
   counts. Accepted plus excluded plus quarantined equals the source count.
3. Every accepted source occurrence has immutable import provenance and one native
   Person mapping. No excluded or quarantined occurrence creates a Person, profile,
   account, credential, affiliation, placement, or authority record.
4. Re-running the exact source and mapping against the same target is an exact replay
   with no additional Person, profile, mapping, provenance, audit, or authority row.
5. A changed source row under the same source identity is rejected or quarantined;
   it never mutates accepted provenance silently.
6. Concurrent identical imports serialize to one accepted result and one replay.
7. Failure before commit leaves no partial Person, profile, mapping, or provenance
   writes.
8. Backup and restore of the migrated PostgreSQL database preserves the aggregate
   report and replay result.
9. The operator-visible report includes only source checksum, schema fingerprint,
   tool revision, native schema revision, counts, reason codes, and aggregate
   digests. A scan verifies that no sampled source value appears in it.
10. The restored source database, private cohort artifact, disposable target,
    credentials, and temporary directory are removed after verification. The source
    SQL file remains byte-identical.

## Done

The journey is complete only when the real private backup has passed the acceptance
path on a clean disposable source and target, the resulting application state can be
read through the native profile boundary, and cleanup has been observed. Synthetic
fixtures alone do not satisfy this contract.

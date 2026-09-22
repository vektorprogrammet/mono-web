# Current assistant assignment reconciliation

Status: frozen for local implementation, 2026-09-22. Production use is not authorized.

Baseline: `c8c5eb27` on `migration/assistant-operations-0906`.

## Goal

Import an operator-controlled synthetic snapshot of current legacy assistant assignments into the existing native volunteer-affiliation and placement authorities only after every source identity has explicit accepted reconciliation evidence.

An accepted source assignment creates one current volunteer affiliation and one current school placement. The import keeps these as separate canonical facts. It does not infer current state from historical service.

## Source contract

The immutable snapshot declares source repository, source revision, snapshot identity, source watermark, transformation revision, and its canonical digest.

Each occurrence declares:

- a stable source-assignment identity and source-row digest;
- source user, department, semester, and school identities;
- explicit source evidence that the assistant affiliation and placement are current;
- teaching day, workday count, teaching block, and active state.

Mappings explicitly bind source user to Person, source department to Department, source semester to SemesterRef, and source school to School. The importer never derives one mapping from another.

The source-user mapping must match an immutable accepted `person_cohort_imports` record for the same source repository, source user, and Person. Existing native profile or Account rows are not substitutes for that evidence.

## Accepted behavior

A guarded local CLI decodes the complete snapshot before persistence. Invalid rows are retained as quarantined occurrences rather than partially written canonical facts.

For each accepted occurrence, one PostgreSQL transaction under an advisory lock:

1. records append-only snapshot, occurrence, mapping, and disposition evidence;
2. establishes the existing `organization_volunteer_affiliations` row as Active at revision 1 when no canonical affiliation exists;
3. creates the existing `assistant_placements` row as active at revision 1 with a deterministic destination identity;
4. preserves the exact Person, department, semester, school, day, workdays, and block values;
5. records import provenance without fabricating a human operational audit action.

Several accepted placements may share one imported affiliation. An importer-created affiliation is replayable only through its own provenance. A pre-existing canonical affiliation or placement without matching import provenance is a target conflict, even when its values happen to match.

Exact replay returns the same dispositions and writes nothing. A changed snapshot under the same source identity, a changed accepted occurrence, duplicate source or destination identity, ambiguous mapping, missing Person evidence, missing native reference, inactive source assignment, placement overlap, or conflicting canonical target is quarantined or rejected before canonical mutation. No accepted subset survives a transaction failure.

Concurrent first execution is serialized and produces one canonical result. Snapshot and accepted source evidence are append-only at the database boundary. Backup and restore reproduce canonical and import evidence byte-for-byte.

## Guardrails

The CLI accepts only explicit synthetic mode, a numeric loopback PostgreSQL URL, a disposable database name, and a protected regular input file. It rejects ambient provider configuration and production-like targets.

The journey must not create or modify Accounts, credentials, historical assistant service, admissions, applications, demand, absence, service occurrence, receipts, private files, settlement evidence, notifications, HTTP contracts, SDK operations, or dashboard routes.

It must not access production data, a remote database, providers, deployment, or remote branches.

## Falsifiers

The implementation is incomplete if any of these observations fail:

- a valid row backed by accepted Person evidence and explicit reference mappings creates exactly one Active affiliation and one active placement in the existing canonical tables;
- two placements for one Person and department create one affiliation, not two;
- every invalid, inactive, unresolved, ambiguous, duplicate, overlapping, or conflicting occurrence leaves canonical affiliation and placement state unchanged;
- an existing unowned canonical fact cannot be adopted by the importer;
- exact replay is byte-stable and changed replay is rejected;
- simultaneous first imports converge on one result;
- an injected failure rolls back canonical and provenance writes together;
- historical service, credentials, receipts, and other excluded authorities remain unchanged;
- PostgreSQL backup and restore preserve all imported canonical facts and reconciliation evidence;
- focused type, behavior, lint, format, and source-manifest checks pass;
- the exact clean committed revision completes the synthetic PostgreSQL rehearsal and reports no production effects.

## Completion

After the accepted behavior is represented by code, observable checks, `docs/system.md`, and `STATE.md`, remove this file. Retain no runtime evidence or temporary artifact in the repository.

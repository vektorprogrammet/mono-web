# Design spec 0047 — Admissions Effect Model authority

## Metadata

| Field | Value |
|---|---|
| Goal | Make admission-period and public-application persistence records authoritative Effect v4 Models while keeping Admissions business authority and PostgreSQL requirements explicit |
| Status | Frozen revision 0047.1 before implementation |
| Depends on | Frozen architecture 0045.1; journey specs 0038 and 0039; base `086e9a5` |
| Scope | `packages/domain/src/admission-period/**`, `packages/domain/src/application/**`, `packages/domain/src/admissions/**`, and focused tests in those directories |
| Journey slice | `intent://journey:admissions:model-authority:v1` — create/revise/list an admission period, resolve eligibility, and submit/replay a public application |
| Out of scope | Economy, Organization, Database package, shared exports/capability graph, backend composition, SDK, apps, migrations, and production cutover |

## Purpose

The existing Admissions journeys already establish the business rules. This slice changes representation authority only: each persisted domain fact is declared once with `Model.Class`, and all database and JSON variants are derived from that declaration. Command, observation, projection, catalog, confirmation, and effect payloads remain intentionally distinct named boundary schemas whose persisted fields come from the Models.

## Authoritative persisted Models

| Fact | Authority | Required variants and privacy |
|---|---|---|
| Admission period | `AdmissionPeriod` | `select`, `insert`, `update`, `json`, `jsonCreate`, `jsonUpdate`; identity, department, and semester are immutable; revision and last command are application-generated; no generated field is caller-controlled |
| Admission semester | `AdmissionSemester` | `select`, `insert`, and read JSON; no update variant for the reference fact |
| Admission department | `AdmissionDepartment` | `select`, `insert`, and read JSON; no update variant for the reference fact |
| Field of study | `AdmissionFieldOfStudy` | `select`, `insert`, and read JSON; active state is represented as a strict boolean |
| Applicant record | `ApplicantRecord` | `select`, `insert`, `update`, and read JSON; raw email and activation digest are sensitive and absent from every JSON variant; nullable activation state remains distinct from optional command fields |
| Public application | `PublicApplication` | `select`, `insert`, and read JSON with an empty update variant; activation digest is private and immutable; revision remains an integer and is initialized to zero |

SQL selects alias columns to the Model's camel-case encoded shape and decode directly through the Model. No independent row interface or second persisted `Schema.Struct` may model one of these facts. Join-only catalog rows, command receipt metadata, and outbox claim metadata remain adapter/protocol shapes rather than domain facts.

All instants use `Rfc3339InstantSchema` and `isRfc3339Instant` from `packages/domain/src/time.ts`. Integer fields remain integer schemas and numeric SQL values; no float transport is introduced.

## Boundary transforms

The following schemas remain separate because they describe messages or observations, not persisted facts:

- `CreateAdmissionPeriodInputSchema` and `ReviseAdmissionPeriodInputSchema` derive period field schemas from `AdmissionPeriod.jsonCreate`, `AdmissionPeriod.jsonUpdate`, and `AdmissionPeriod.update`.
- `AdmissionPeriodCommandSchema`, `AdmissionPeriodObservationSchema`, and `AdmissionPeriodProjectionSchema` remain named transforms over Model fields.
- `SubmitPublicApplicationInputSchema` and `SubmitPublicApplicationCommandSchema` derive applicant field schemas from `ApplicantRecord` variants while retaining the public command's exact field set and server-owned IDs.
- `PublicApplicationSubmitObservationSchema`, `PublicApplicationCatalogSchema`, and `PublicApplicationConfirmationSchema` remain named transport/projection schemas and never become persistence authorities.
- Outbox/effect schemas continue to carry only the fields required by their ordered effect contract; private payloads remain excluded from evidence.

Strict unknown/excess-property decoding remains enabled at external and persisted boundaries.

## Authority and Layer contract

`Admissions` remains the sole coherent domain Service for admission-period management and public-application lifecycle/catalog/confirmation operations. Its methods expose typed domain failures and do not expose SQL or a database client. The `AdmissionsLive` Layer captures the structural `Database` requirement once and provides it to private PostgreSQL programs; its public type still requires `Database`. SQL imports and transaction execution remain inside live adapters. No request-local Layer, runtime, or concrete SQL dependency is introduced.

Every owned caller uses the Admissions authority contract. Direct PostgreSQL programs remain available only as the private implementation seam needed by the Layer and preserve their visible `Database` requirement for composition.

## Preserved journey invariants

### Admission-period management

- active DepartmentLeader or GlobalAdmin only; department scope is enforced;
- global admins must select a department and department leaders cannot cross scope;
- linked semester and period windows are ordered and period bounds stay inside the semester;
- one period per `(departmentId, semesterId)`;
- create starts at revision `0`; accepted revision increments exactly once;
- stable period identity and existing application references survive revision/close;
- command identity is advisory-lock protected; identical canonical replay returns the stored observation with no writes/effects; digest conflict is typed;
- row locking and revision CAS permit one winner for concurrent revisions;
- eligibility remains `semester.startAt <= now < semester.endAt && period.startAt <= now < period.endAt`; eligibility is derived, never stored;
- audit and ordered outbox rows are written in the same transaction.

### Public application lifecycle

- public input is exact and strict; email is trim-plus-lowercase normalized;
- department, eligible period, active field, and field scope are resolved in the transaction;
- normalized email identity is advisory-lock protected and unique;
- duplicate applicant-period submissions are rejected by policy and database constraint;
- applicant profile, application snapshot, command receipt, audit, and ordered outbox commit atomically;
- application revision is zero and accepted applications retain their admission-period identity;
- identical command replay returns the original opaque observation without duplicate rows/effects; digest conflict is typed;
- activation snapshot is persisted as a digest, never raw activation material;
- effects remain ordered: activation/confirmation, subscription, audit; delivered payload cleanup and quarantine semantics remain unchanged;
- confirmation exposes only the opaque application identifier and no applicant PII or activation material.

## Focused evidence

Focused tests in the owned directories prove:

1. every persisted Model exposes the expected variant field keys, with immutable/generated/private fields absent from update/create/JSON variants;
2. selected encoded rows decode strictly through the Model and excess fields, invalid instants, invalid integers, and malformed nullable values fail;
3. Model construction/decode does not mutate input objects or nested values;
4. existing admission decision, command replay/locking/CAS, lifecycle, projection, outbox, audit, import/quarantine, and activation-snapshot tests retain their observable contracts.

Tests are added or adapted but are not run in this isolated authority wave. Integration validation is owned by the lead after all authority commits are composed.

## Integration notes (not edited here)

The integration lead must export the new Model classes/derived boundary schemas through the existing domain entry points as needed, preserve the existing capability graph, and provide `AdmissionsLive` with `Database` in the backend composition root. No shared export, backend, SDK, app, or root manifest changes belong to this slice.

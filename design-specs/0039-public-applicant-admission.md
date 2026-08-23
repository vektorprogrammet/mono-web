# Design spec 0039 — Public applicant admission

> **Summary:** A prospective applicant opens the modern homepage, selects an eligible department, enters the legacy-visible identity and study fields, and submits one application through the canonical SDK to the native Effect/PostgreSQL authority. The authority normalizes email identity, resolves the currently eligible admission period and department-scoped field of study, prevents duplicate applications transactionally, persists the applicant and application atomically, and emits ordered activation/confirmation/subscription effects. The browser observes a confirmation containing only an opaque application reference. A real disposable PostgreSQL and Chromium journey proves accepted submission, exact replay, duplicate and closed-window rejection, privacy, effects, and cleanup without Symfony, provider, production, or external delivery access.

## Metadata

| Field | Value |
|---|---|
| Goal | Replace the public applicant submission and confirmation journey |
| Status | Frozen and accepted for isolated remote implementation; no local browser execution or production cutover authority |
| Depends on | Design spec 0038 at `f0a2e79`; ADR 0004; ADR 0005 |
| Actor | Anonymous prospective applicant |
| Journey authority | `intent://journey:applicant:submit-public-application:v1`; parity projection `intent://journey:parity:applicant_admission:v1` |
| Environment | Isolated remote CI; loopback-bound homepage and native API; disposable PostgreSQL 17; recording-only effects; one real Chromium worker |

## Source authority and corrections

The legacy public form establishes these visible inputs: first name, last name, phone, email, gender (`0` man, `1` woman), department-scoped field of study, and year of study (`1..5`). Submission resolves an active admission period, reuses an existing user by email, persists the application, emits `ApplicationCreatedEvent`, and redirects to confirmation. New users receive an activation/confirmation message; subscription creation is best-effort.

This contract does not preserve legacy defects: duplicate checks without a database constraint, inconsistent strict/inclusive boundary rules, ambiguous overlapping periods, boolean `NotBlank` behavior, persistence before fallible synchronous email, account-role mutation hidden inside submission, or PII-bearing confirmation. Spec 0038's half-open semester-and-period eligibility remains canonical. Migration prose that lists weekday/preferences on the new-applicant form or claims authentication is required is stale and not authoritative for this journey.

The original local evidence environment is superseded. An attempted workstation run caused unacceptable memory pressure before homepage readiness. The behavioral contract is unchanged, but its real PostgreSQL and Chromium proof must run in isolated remote CI with bounded one-shot processes, hard timeouts, resource telemetry, and cleanup evidence. Local browser or PostgreSQL execution is not authorized.

## User journey

1. A visitor opens `/assistenter` on the modern homepage.
2. The loader calls `applications.catalog()` through the canonical SDK. It shows only departments with a currently eligible admission period and each department's allowed fields of study. No hard-coded city-open map or unknown deadline remains.
3. The visitor selects a department and enters first name, last name, phone, email, gender, field of study, and year of study.
4. The browser creates one stable `commandId` before serialization and submits through a React Router action. It supplies no applicant ID, user ID, admission-period ID, status, role, activation code, or effect authority.
5. The HTTP adapter rate-limits the request, strictly decodes the JSON, normalizes email, and invokes `PublicApplicationAuthority`.
6. One PostgreSQL transaction locks command identity and normalized applicant identity, resolves the eligible period and department-scoped field, creates or reuses the applicant identity, rejects an existing application for the same period, persists the application, command receipt, audit row, and ordered outbox requests, then commits.
7. The API returns only `{ _tag: "Submitted", commandId, applicationId }`. It never returns applicant identity, email, activation material, internal user ID, or admission-period identity.
8. The homepage renders a confirmation using the opaque application ID and clears the form only after acceptance.
9. Recording-only interpreters deliver ordered `SendApplicantActivationOrConfirmation`, `CreateAdmissionSubscription`, and `WriteApplicationAudit` effects without external network access. Same-command replay does not duplicate them.

## Canonical model

```text
Applicant = {
  id,
  normalizedEmail,
  firstName,
  lastName,
  phone,
  gender,
  fieldOfStudyId,
  yearOfStudy,
  activationDigest?
}

PublicApplication = {
  id,
  applicantId,
  admissionPeriodId,
  departmentId,
  fieldOfStudyId,
  submittedAt,
  revision: 0
}

SubmitPublicApplication = {
  commandId,
  departmentId,
  firstName,
  lastName,
  phone,
  email,
  gender,
  fieldOfStudyId,
  yearOfStudy
}
```

The database is the truth model. Email normalization is trim plus Unicode-safe lowercase. Raw email remains private applicant data; the normalized value is used for identity and unique lookup. The browser-visible application ID is opaque and stable.

## Laws

| Law | Required behavior |
|---|---|
| Eligibility | Resolve exactly one period where semester and period both satisfy `start <= now < end` |
| Field scope | Field of study must be active and belong to the selected department |
| Identity | One applicant identity per normalized email |
| Duplicate | At most one application per applicant and admission period, enforced by a database constraint |
| Replay | Same `commandId` and canonical bytes returns the original opaque observation without new rows/effects |
| Conflict | Same `commandId` with different canonical bytes is rejected |
| Concurrency | Concurrent same-email submissions for one period yield one application; identical command replay is stable, different commands yield one accepted and one typed duplicate |
| Atomicity | Applicant, application, receipt, audit, and outbox commit together or not at all |
| Effects | Provider work occurs only after commit through ordered durable outbox requests |
| Privacy | Public responses, browser HTML, logs, and evidence contain no applicant PII or activation material |
| Historical identity | Closing or revising the admission period never changes an accepted application's period reference |

An existing applicant may update the submitted profile fields only as part of an accepted new-period application. The transaction updates the canonical applicant profile and stores the submitted field/year snapshot on the new application. A duplicate submission in the same period never mutates profile data.

## Validation

- names: trimmed, non-empty, bounded to 100 Unicode scalar values each;
- email: syntactically valid, trimmed, bounded to 254 characters;
- phone: normalized visible string, non-empty, bounded to 32 characters; no country-specific number inference;
- gender: exact integer `0 | 1`, preserving the legacy contract without using truthiness;
- year of study: exact integer `1..5`;
- department and field IDs: stable non-empty strings;
- unknown or excess JSON members are rejected;
- request body size is bounded before JSON decoding.

## Canonical API and SDK

Native endpoints:

- `GET /api/applications/catalog` — public `{ departments: [{ departmentId, name, closesAt, fieldsOfStudy }] }` derived from eligible periods and reference tables;
- `POST /api/applications` — strict complete submission command;
- `GET /api/applications/:applicationId/confirmation` — opaque existence confirmation only; no PII.

Canonical SDK:

- `applications.catalog()`;
- `applications.submit(input)`;
- `applications.confirmation(applicationId)`.

This is a clean replacement of spec 0038's deliberately minimal proof payload. No compatibility overload or alternate minimal submit remains. The 0038 runner is migrated to the complete command.

## Meaningful rejections

The browser/API proof observes typed rejection for:

- no eligible admission period;
- unknown department;
- unknown, inactive, or cross-department field of study;
- duplicate application for the same normalized email and period;
- malformed email, phone, name, gender, year, IDs, JSON, content type, or excess fields;
- body above the configured byte limit;
- rate limit exceeded;
- replayed command ID with different bytes;
- concurrent duplicate submission;
- durable PostgreSQL failure.

All rejected commands leave applicant profiles, applications, command receipts, audit, outbox, and effect state unchanged. User-facing messages do not reveal whether an email already exists outside the selected period.

## Effects and account activation

Accepted submission emits, in order:

1. `SendApplicantActivationOrConfirmation`;
2. `CreateAdmissionSubscription`;
3. `WriteApplicationAudit`.

The effect request may contain private delivery material in the protected outbox payload, but evidence records only effect IDs, kinds, order, attempts, and delivery state. Recording-only proof interpreters run without external network access. Provider adapters and production account activation are not authorized by this slice. Account-login capability remains a later identity journey; this slice proves durable activation intent, not delivered email or successful login.

## Migration and compatibility

The native schema stores stable IDs and includes explicit legacy-ID mapping columns/tables suitable for a deterministic importer. No production import or dual write is authorized. Existing Symfony routes and data remain untouched. The accepted generic parity receipt proves its exact Symfony revisions only; it does not prove this native journey.

Existing minimal rows from spec 0038 are disposable proof data, not production authority. Migration `0002` replaces that proof shape without preserving a second parallel application model. Tests and runners move to the complete contract in one cutover.

## Evidence and definition of done

One deterministic remote CI runner starts disposable PostgreSQL, the native API, a one-shot built homepage, and one Chromium worker with a fixed clock and recording effects. The runner has hard process and job timeouts, captures bounded resource and failure diagnostics, and emits secret-free evidence proving:

- eligible department/field catalog comes from PostgreSQL, not static city flags;
- the real homepage form submits every required field through the SDK;
- accepted submission renders opaque confirmation and a fresh database read shows applicant/application linkage;
- exact replay returns the same application ID with no duplicate rows/effects;
- same-email/same-period duplicate is typed and does not mutate the applicant;
- two concurrent different commands yield exactly one application;
- closing the period rejects a new applicant while preserving the accepted application reference;
- validation, field scope, malformed/excess/body-limit, replay-conflict, rate-limit, and PostgreSQL failure paths;
- ordered outbox delivery, retry without duplicate provider effect, and audit identity;
- page and evidence contain no submitted names, email, phone, activation bytes, database credentials, or raw outbox payload;
- Axe finds no serious or critical violations in form, error, and confirmation states;
- cleanup removes disposable database/temp roots, releases ports, and terminates every process it owns.

The journey is falsified if it calls Symfony, renders fixture application state, uses the hard-coded city-open map, accepts browser-selected identity/status/period authority, performs provider delivery in-request, exposes PII in confirmation/evidence, permits duplicate applications, bypasses the SDK, mocks PostgreSQL, or cannot clean up. Focused package gates and root `check-types`, `lint`, `build`, and `test` must pass on the committed artifact; unrelated pre-existing failures require exact evidence.

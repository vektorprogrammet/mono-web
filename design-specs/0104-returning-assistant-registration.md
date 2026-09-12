# 0104 — Returning-assistant registration and authoritative classification

Status: contract revised for implementation, 2026-09-12. Production release unclaimed.

## Goal and product boundary

A person with a canonical native account and authoritative prior assistant
participation can register for a next/open native admission period as a returning
assistant. The registration is a real application journey with the complete
practical availability and preference fields of the legacy existing-assistant form.
It does not create an assistant role, volunteer affiliation, team membership,
interview, or admission decision.

The coordinator report remains default-all completed native interviews. It offers
an explicit classification filter with `Returning` and `Unknown` only. Excluding
Returning is **not** a first-time population: remaining rows are `Unknown`, never
`FirstTime` or a claimed legacy-equivalent population. No `FirstTime` value exists
without an authoritative writer that proves it.

## Legacy semantics and safe native differences

The legacy authenticated route (`ApplicationAdmission::createApplicationForExistingAssistant`)
qualifies a signed-in user when **any** assistant-history row exists. It resolves
the target department from the user's current field-of-study department, resolves
that department's current active admission period, reuses the user's existing
application for that period when present, sets `previousParticipation=true`, and
attaches the repository's latest conducted interview. The existing-user form
captures year, unavailable weekdays, double/single position, semester block,
language, preferred school, team interest, and potential teams. The legacy
subscriber sends the existing-assistant confirmation template and creates an
admission subscription.

Native has no primary-department rule in organization authority/directory and no
native study profile on Person. Native therefore uses a linked applicant's
canonical `fieldOfStudyId` and the authoritative
`admission_period_fields_of_study(field_of_study_id, department_id)` mapping to
resolve the current study department. This is explicit native source data, not a
membership/history guess. If the authenticated Person has no Applicant→Person
link, or the linked applicant's field mapping is absent/ambiguous/inactive, the
journey denies rather than guessing. A person may have prior history in any
historical department or semester; history department and semester do not need to
match the target period. Target admission period is selected explicitly from open
periods in the canonical current study department.

Native assistant participation is read from canonical `assistant_placements` rows
(the 0032 placement table), including retained inactive rows. Any valid placement
for the linked Person qualifies. A future import may project legacy AssistantHistory
into these rows, but an imported projection is not a second eligibility authority.
Team membership and volunteer affiliation without an assistant placement never
qualify. Native does not reproduce the legacy interview repository's accidental
ascending-first “latest” behavior: a new-period application creates no interview;
when a canonical application for the same period already has a conduct, it remains
attached and untouched.

The legacy confirmation/subscription outcome is not dropped. Native reuses the
existing acknowledged application outbox and delivery worker: an authenticated
returning submission emits the existing applicant confirmation notification (with
no activation token) and the existing department admission-subscription effect,
plus the existing application audit effect. The native adapter may use its current
confirmation template rather than the legacy Symfony template; template parity is
not claimed. Delivery remains durable, retryable, and explicitly observable.

## Frozen authority and data model

1. Resolve the authenticated session to exactly one canonical native `PersonId`.
   Require an existing Applicant→Person link for that Person and lock the linked
   applicant before reading or writing. A submitted PersonId is never accepted;
   email equality is not identity proof. Every command first re-resolves the live
   session and eligibility/current-period authority, before looking up its receipt.
   A prior receipt is never replayed to a now-revoked or otherwise ineligible
   identity.
2. Under that identity lock, require at least one canonical active or inactive
   `assistant_placements` row for the Person. Placement is the authoritative
   participation fact. No placement means denied with zero mutation, even if the
   person has a team membership or volunteer affiliation.
3. Resolve current department and field from the linked applicant's current
   `fieldOfStudyId` through the native field-of-study mapping. Require exactly one
   canonical department mapping and an active field. If the linked applicant
   relation is absent or more than one link is observed for a Person, deny with a
   typed identity-ambiguous error; never use arbitrary `LIMIT 1`. Resolve the
   selected `admissionPeriodId` to that department and its semester. Only periods
   open at `now` are eligible. Clients cannot submit a separate department, field,
   or applicant identity. Missing, closed, ambiguous, or cross-department mappings
   deny without mutation.
4. Reuse the canonical `(applicant_id, admission_period_id)` application row. If
   absent, create exactly one row with the linked applicant's canonical identity
   and field mapping. If present, preserve its original public submission,
   receipt, and audit records; update only the canonical application year/revision
   under the existing application revision rules as the legacy flow did. The
   returning preferences have their own versioned current row, and each revision
   records immutable provenance to Person, linked Applicant, placement, target
   department/semester/period, and the triggering command. There is no mutable
   `previousParticipation` flag.
5. Persist a proper returning-preferences model, not substitute preferences. It
   stores year of study (1–5), unavailable weekdays Monday–Friday, single/double
   position (4 or 8 weeks), semester block (`all`, `block-1`, `block-2`), teaching
   language (`Norsk`, `Engelsk`, or `Norsk og engelsk`), preferred school
   (optional text up to 255 characters), team-interest choice, and zero or more
   selected native team IDs. Selected teams must belong to the resolved department
   and are retained in a versioned child relation. The UI reads/writes all
   fields; names, email, phone, gender, and field-of-study identity remain
   canonical applicant/profile data, not client-controlled returning fields.
6. A command receipt/digest and PostgreSQL transaction make the journey
   idempotent. Lock command, linked applicant, and target application in a stable
   order. Exact replay returns the stored observation for a still-authorized
   identity; conflicting replay rejects. Reapplication creates one new preferences
   revision (or replays the same revision), never a duplicate application. The
   command includes the caller's expected current preferences revision; a stale
   expected revision fails with a typed precondition conflict instead of silently
   overwriting a concurrent edit. Concurrent commands yield one serializable
   current revision and preserve every immutable prior revision.
7. Persist the returning registration/provenance and preference revision before
   enqueueing the reused notification, department subscription, and application
   audit effects. Effects are acknowledged by the existing worker and idempotency
   keys. No effect grants role, affiliation, placement, interview access,
   acceptance, or report inclusion by itself.

## Report classification contract

The report projects all completed native interviews in the selected exact period,
then joins the current canonical application to returning provenance. It derives
`Returning` if an immutable returning registration exists for that application;
otherwise it derives `Unknown`. Missing placement/history/provenance remains
Unknown. No email/account inference or mutable classification is performed. Filter
values are `all`, `Returning`, and `Unknown`; default is `all`. Existing
Ja/Kanskje/Nei recommendation and score semantics remain unchanged. Returning
classification does not change 0103 period membership or become an admission
decision. Existing public Unknown rows may gain Returning provenance only through
this authenticated, placement-eligible, identity-locked journey.

## HTTP, UI, and source reuse

Add schema-driven authenticated options/read and submit endpoints under the
existing admissions group. Use the canonical session resolver, admissions and
organization authorities, placement persistence, existing application revision
and receipt/outbox helpers, generated SDK, and dashboard form/error/loading
conventions. The dashboard must show the resolved current study department,
explicit eligible target period, all practical fields including preferred school,
and clear errors for missing placement, missing linked applicant/study mapping,
unavailable period, duplicate/replay, and invalid team scope. Do not add a public
checkbox or arbitrary account lookup.

## Acceptance and falsifiers

Against synthetic PostgreSQL/backend/dashboard resources, observe:

- a linked Person with any retained active/inactive assistant placement can load
  an open next-period option in the canonical current study department and submit
  every practical field; reload preserves the application, preferences revision,
  immutable provenance, and team choices;
- prior-placement department/semester differing from target still qualifies;
  team-only/affiliation-only person, missing Applicant→Person link, missing or
  ambiguous field mapping, anonymous user, cross-department team, closed period,
  and stale account link are denied with zero returning/application mutation;
- an existing public application in the target period is reused, its public
  receipt/audit remain intact, its returning preferences are versioned, and the
  associated prior interview/conduct remains untouched;
- exact command replay is stable, conflicting replay rejects, and concurrent
  reapplication yields one canonical application and one current preferences
  revision with immutable prior revisions retained;
- notification, subscription, and audit outbox effects are present, acknowledged,
  retryable, and do not create role/affiliation/placement effects;
- a later finalized interview is classified Returning through immutable provenance;
  an ordinary completed application is Unknown; filtering Returning out never
  labels the remainder FirstTime; report exact-period rows, recommendations,
  scores, and reload remain unchanged;
- independent SQL confirms canonical placement eligibility, current field mapping,
  versioned provenance/preferences, no prior conduct mutation, and no report writes.

Local synthetic resources only. No production data, credentials, providers,
remote push/PR, deployment, or production cutover is authorized.

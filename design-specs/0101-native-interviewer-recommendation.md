# 0101 — Native interviewer recommendation

Status: frozen for local implementation, 2026-09-06. Production release unclaimed.
Base: `aeda5e05b42b29c8df975fd5bad8a6dd285d3726`.
Amends the three-axis-only conduct input/read shape in [0063](0063-native-interview-conduct.md).

## Goal and journey

An assigned interviewer records an explicit assessment of whether the applicant
would suit the assistant role, finalizes the interview, and sees that exact
recommendation after a fresh read and reload. Preserve the existing native
conduct journey and its authority rather than adding an admission decision.

1. An active assigned interviewer opens `/dashboard/intervjuer`, selects their
   scheduled interview with an accepted invitation, and answers its questions.
2. Alongside the existing three numeric scores, a labelled required choice asks
   `Passer denne studenten til å være vektorassistent?`: `Ja`, `Kanskje`, `Nei`.
   Nothing is preselected or inferred from numeric scores.
3. Finalization validates the recommendation and stores it atomically with the
   immutable conduct, native receipt and audit. Missing/invalid input is rejected
   without finalizing or losing the local form.
4. A fresh native observation and reload show the exact recorded recommendation.
   Historical native conduct predating this amendment displays `Ikke registrert`;
   it must never invent `Kanskje`, `Nei`, or a score-derived value.
5. Same-command replay preserves the result; conflicting payload reuse and stale
   concurrent finalization fail through the existing typed conflict protocol.

## Source and correction to the continuation sequence

Legacy checkout revision `d05c261e9f73297f70ad228635c85ab566c51526`:

- `src/AppBundle/Entity/InterviewScore.php:39`: required stored `suitableAssistant`
  string, distinct from explanatory power, role-model and suitability scores.
- `src/AppBundle/Form/Type/InterviewScoreType.php:34`: single choice exactly
  Ja/Kanskje/Nei, labelled as suitability for the assistant role.
- Conduct/show/interviewed templates display that recommendation for authorized
  interview readers; `Service/InterviewCounter.php` counts the three values.
- `Service/ApplicationManager.php:16` derives admission from active school history;
  `Model/ApplicationStatus.php:11` has interview progress and school assignment,
  not separate assistant Accepted/Rejected/Waitlisted decisions.
- `Entity/User.php:501` tests active-semester assistant history. Invitation
  `ACCEPTED` is agreement to an interview time, not admission.

Native `packages/domain/src/recruitment/schema.ts` and `conduct-postgres.ts`
currently persist only three numeric ratings. The unmounted tutor prototype's
recommendation does not establish a live native capability.

Therefore an explicit coordinator admission decision is a potential new product
workflow, not a demonstrated missing legacy transition. This contract restores
the demonstrated recommendation gap. It neither invents a new decision state nor
labels a recommendation as an admission or waitlist decision.

## Ownership and invariants

| Fact | Authority | Rule |
| --- | --- | --- |
| Recommendation | Recruitment interview conduct | One explicit enum value per newly finalized interview; no independent duplicate record or score threshold. |
| Historical absence | Existing immutable native conduct | Represent as absent/not recorded on reads; never backfill an invented assessment. |
| New finalization | Existing Recruitment command | Required recommendation at decoded input and storage boundary; old rows remain readable. |
| Person, affiliation, placement | Existing identity/Organization/placement authorities | Recommendation creates no account, role, affiliation or school placement and changes no eligibility rule. |
| Access | Existing conduct authorization | Assigned active interviewer and current scope required before reads/writes/replay; no authority expansion. |
| Notification | None in this amendment | No mail, SMS, outbox or provider effect. Internal recommendation stays out of applicant-facing responses. |

Reuse existing Effect Schemas, Model fields, conduct SQL transaction, immutable
records, command receipts, SDK generation, Foldkit model/messages/update/view,
and UI primitives. Numeric 0..10 score ranges remain governed by 0063. The form's
finite state remains owned by Foldkit. No new runtime/library or framework swap.

New insert validity must not be weakened to accommodate historical nulls. Use a
migration-compatible representation that distinguishes historical absence from
required new input; do not disable immutability constraints or silently default.

## Acceptance gates and falsifiers

- Each choice round-trips through the real native endpoint and PostgreSQL;
  one complete real Chromium journey uses production dashboard, native SDK/API,
  current migration chain, sign-in, keyboard selection, finalization and reload.
- Existing pre-amendment conduct remains readable and immutable with explicit
  not-recorded display; no historic row is rewritten to make tests pass.
- Missing, null, unknown and score-inferred recommendations cannot finalize new
  conduct. Rejected commands leave conduct/receipt/audit unchanged.
- Wrong actor, wrong department, suspended/revoked authority and replay after
  authority removal cannot expose or change the recommendation.
- Duplicate replay is stable; changed payload with the same command identity and
  competing finalization cannot overwrite a stored recommendation.
- Independent SQL observation confirms recommendation, answers, scores, audit,
  and one finalization. Direct invalid new storage writes are rejected.
- Failure/retry retains local form values; confirmation comes from fresh reads.
- Applicant-facing application/response/onboarding projections never leak it.
- Browser observation includes desktop/mobile, keyboard and Axe. Record page
  errors and retained artifact scanning. Unit/static evidence is separate.
- Rehearsal must observe the current `public` domain schema. The historical 0063
  runner's stale `auth.recruitment_*` assumptions must be repaired if reused.
- Gate committed clean source, retain exact revision, stop all owned resources,
  remove private synthetic manifests/databases, and keep sanitized evidence.

## Boundaries

Local synthetic implementation/rehearsal only. No real applicant data, provider,
production credential, external PR/push or deployment authority. This does not
establish full recruitment parity, coordinator recommendation reporting,
co-interviewer privileges, editable finalized interviews, applicant progress,
automatic scheduling, admissions decisions, statistics or legacy cutover.

The accepted continuation plan governs subsequent journeys. Any new admission
decision workflow needs an explicit product contract separate from recommendation.

# 0103 — Coordinator report of completed native interviews

Status: frozen for local implementation, 2026-09-07. Production release unclaimed.
Product baseline: `8fd62e29773357177dad15a0c1eedc3fbf3ee083`.

## Goal and journey

An active department coordinator reviews already finalized native interviews for
an explicitly selected admission period, compares recorded recommendations and
scores, and reloads the report without changing any interview or applicant.

1. A currently authorized department leader follows **Fullførte intervjuer** in
   the interview navigation to `/dashboard/intervjuer/rapport`.
2. The report offers admission periods belonging to that leader's one resolved
   active department, including closed historical periods. The user explicitly
   selects a period; absence of a selection never means all departments or all
   periods. An empty department/period has an explanatory empty state.
3. The table shows one row per finalized native interview in the exact selected
   period: applicant name, completion time, exact recommendation and the three
   recorded numeric scores. A total score is a pure sum of those three scores.
   No answers, contact details, special-needs data or account-link identifiers
   are returned by this report.
4. Recommendation is exactly Ja/Kanskje/Nei. Historical finalized conduct with
   no recorded recommendation displays **Ikke registrert**, separately from all
   three values. Non-finalized interviews never appear as historical absence.
5. The coordinator can sort by applicant name, recommendation or numeric total,
   and filter by recommendation, including Ikke registrert. Sorting is stable
   with an immutable row identity as the final tie-breaker. Controls, selected
   period and view state survive reload through the route's explicit state.
6. The displayed result count comes from the same authorized, filtered rows.
   There is no count of hidden self-assessments and no separate category-count
   feature. Loading, failed reads and retry have explicit states; a failed or
   superseded request cannot present old data as the newly selected period.

## Source and deliberate parity boundary

Legacy checkout `d05c261e9f73297f70ad228635c85ab566c51526`:

- `src/AppBundle/Controller/AdmissionAdminController.php:117–144` selects an
  admission period for the interviewed-applicant board.
- `src/AppBundle/Entity/Repository/ApplicationRepository.php:102–114` selects
  interviewed applications in that exact period with previousParticipation=false.
- `app/Resources/views/admission_admin/interviewed_applications_table.html.twig`
  displays applicant rows, total count, score sum and recommendation; its layout
  implements sortable columns. Self-assessments are hidden by the template.
- The Ja/Kanskje/Nei counts computed by `Service/InterviewCounter.php` are shown
  only in an unused bulk-navigation partial. Per-choice counts are not verified
  as currently rendered legacy behavior. The explicit recommendation filter in
  this contract is a small native reporting addition, not that legacy claim.
- `Service/ApplicationAdmission.php:38–54,121–137` sets previousParticipation=true
  in a separate authenticated returning-assistant flow backed by assistant
  history. `Application.php:156` defaults false; `AssistantController.php:125–141`
  also redirects recognized historical assistants out of public submission.
  It is not a public yes/no answer, and legacy email matching is not adopted.

Native public submission is the only current product application writer
(`application/postgres.ts`, `Admissions.executePublicApplication`). Its receipt
and PublicApplicationSubmitted audit establish origin, not proof of never having
served. Placement and onboarding create no application. The native returning
application/history-reuse workflow and previous-participation classification are
absent. Therefore this report deliberately includes **all completed native
interviews in the selected period**, not a claimed first-time-only population.
The view explains this briefly: **Tidligere deltakelse er ikke klassifisert i
denne oversikten.** No checkbox, classification field, inferred flag or backfill
is introduced. Exact legacy population equivalence remains open.

The native 0–10 scores remain governed by0063; legacy's numeric scale differs.
Showing their actual sum does not establish numerical scoring parity or an
admission decision. This is a recommendation report, not the entire legacy board:
contact/preferences, special needs, exports and full interview detail are separate.

## Authority, observations and ownership

| Fact or boundary         | Authoritative source and invariant                                                                                                                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reader                   | Existing canonical recruitment department authority: active department leader in exactly one resolved active department. Ordinary assigned interviewers, suspended/ended membership, inactive team/department and admin-only authority do not gain coordinator reporting access. No new global-admin bypass or multi-department policy. |
| Selected period          | Canonical admission period and its department. Validate scope before returning period metadata or results. Include historical closed periods deliberately; do not inherit the current-open-period assignment restriction.                                                                                                               |
| Population               | Applications in that exact period joined to immutable completed conducts. Database relationships, not applicant email or client authority, establish membership.                                                                                                                                                                        |
| Known self               | Immutable Applicant→Person association and the existing pure known-self predicate. Exclude proven self before projecting rows, filters, ordering or totals. Missing association remains unknown; a different linked Person remains eligible.                                                                                            |
| Concurrent identity link | Reuse applicant custody and0037 link-version behavior, with deterministic lock ordering across a batch. Hold consistent observation through the read; a concurrent link must not expose a newly known self-assessment through a stale pre-lock snapshot. GET introduces no persistent writes.                                           |
| Recommendation/scores    | Existing immutable conduct. Derive display, sorting and total from that one record; no new report table or copied assessment authority.                                                                                                                                                                                                 |
| HTTP/SDK                 | Dedicated schema-driven read endpoint and truthful AccessSpec, generated through existing tools. Scope and current authority apply before any conditional success. Private/no-store responses; no browser fan-out through assigned-interviewer-only detail endpoints.                                                                   |
| Effects                  | None. Reporting writes no conduct, application, command receipt, audit, notification, account, affiliation or placement record.                                                                                                                                                                                                         |

Keep the existing raw conduct endpoint's assigned-interviewer and self-denial
rules unchanged. This contract grants a coordinator the explicitly limited
report projection, not full answers or completed-interview editing authority.

Reuse current Effect domain/services and PostgreSQL layers, authority resolvers,
admission-period management observations, generated SDK, established dashboard
navigation/layout, and existing form/table/loading patterns. Use a single owner
for report state; no parallel caches or duplicated manually maintained API shapes.
No framework replacement or new infrastructure is justified by this journey.

## Acceptance gates and falsifiers

- A real ordinary assigned interviewer finalizes an interview; a different,
  non-assigned active department leader reads it through production dashboard,
  native SDK/API and real PostgreSQL. Reload shows persisted observations.
- Ja, Kanskje, Nei and immutable historical absence are observed; scores and
  totals match independent SQL. Incomplete interviews and other periods or
  departments cannot enter the result. Historical closed and empty periods work.
- Actual keyboard sorting/filtering and period changes preserve view state on
  reload. Numeric sorting is numeric, ties deterministic, and displayed count
  matches the filtered authorized population. Labels distinguish absent history.
- Anonymous, ordinary member, admin-only, ambiguous department, wrong department,
  revoked/ended/suspended leader and inactive team/department are denied through
  direct requests. Revocation is enforced even with a previous conditional token.
- A reader's linked self-assessment is absent from every report observation and
  count. Different-Person and absent-link cases remain correct. A real concurrent
  link/read rehearsal exercises deterministic applicant custody; stale snapshots
  cannot reveal a known-self recommendation.
- Existing raw conduct access is not widened for the reporting coordinator, and
  applicant-facing projections still exclude recommendation and numeric scores.
- Before/after database snapshots establish no report effects or changes to
  conduct/history/command receipts/audits and related application authorities.
- Failure/retry and competing period selections cannot mislabel stale results.
  Production browser checks include actual viewport captures, visible keyboard
  focus, accessible sort state, mobile layout, Axe and captured page errors.
- Reuse existing native seed/runtime tooling. Validate fixture inputs before
  expensive startup, exercise real boundaries, retain sanitized evidence with
  exact clean revision, and remove owned processes/private runtime data.
- Unit/property tests, type checks, generated freshness and formatting/lint are
  distinct gates. Report skipped checks and remaining parity gaps explicitly.

## Scope and delivery

One complete read-only reporting journey in an isolated writer worktree, followed
by independent review and committed-source acceptance. Local synthetic resources
only; no production data, remote PR/push, provider configuration or deployment.
Returning-assistant registration/classification, completed-conduct editing,
co-interviewer privileges, applicant progress and production cutover remain open.

# 0094 — Native substitute pool

Status: frozen for local implementation. Parent: clean consolidation `694cc34f0cd7b9def78b2d9c988a6998d849d4f4`.

## Goal and felt journey

A department coordinator opens Vikarer, explicitly selects department and semester, sees the current substitute pool, adds an existing application to it with declared availability, edits its weekday availability / teaching language / year of study, and removes it from the pool. Reloading shows the persisted result; removal preserves the application and its recruitment history. An authorized team member can read the pool but cannot mutate it. Historical semesters remain selectable.

This is a pool-management journey, not absence reporting, dispatch, school placement, automatic allocation, applicant account activation, or production cutover. It requires no outbound notification or provider effect. The current applicant identity remains the identity; do not invent a PersonId/BetterAuth linkage.

## Source contract

Inspected checked-in Symfony behavior:

- `apps/server/src/App/Admission/Api/Resource/AdminSubstituteResource.php`: team-member pool read; team-leader activation, modification and deactivation.
- `apps/server/src/App/Admission/Api/State/AdminSubstituteListProvider.php` and `ApplicationRepository::findSubstitutesByAdmissionPeriod`: department + semester via admission period; only active substitutes in the pool.
- `AdminSubstituteActivateProcessor`: application exists and is not already active; mark it a substitute. `AdminSubstituteEditProcessor`: only active pool members may be edited. `AdminSubstituteDeactivateProcessor` and `SubstituteController::deleteSubstituteAction`: deactivate without deleting the application.
- `apps/server/src/App/Admission/Form/ModifySubstituteType.php`: Monday–Friday availability, year of study, language Norsk / Engelsk / Norsk og engelsk.

Native root facts already exist in application/applicant, admission period, Organization department/semester/authority and Profile models. Native public applications currently do not collect teaching language or weekday availability. Consequently first activation must explicitly collect them; missing values must not silently become unavailable weekdays or a guessed language. This is an explicit native interaction adaptation. Profile/contact editing, offered by a separate legacy nested form, is not part of this API-backed journey.

## Ownership and invariants

1. Application and admission period are the authority for applicant identity, department and semester. Resolve scope from persisted references for item actions; never trust an actor-supplied department to authorize another application's mutation.
2. Preserve canonical applicant names/contact and existing application year-of-study ownership. Do not fork names, email, department, semester or year-of-study into a hand-synchronized substitute record. Any new availability/language/pool-state representation has one authoritative home keyed by the application, with foreign-key integrity. Return types derive from runtime schemas and canonical model fields.
3. A pool member is an existing application. No invented admission acceptance, interview completion, native login account, or team membership eligibility gate. The coordinator selects among actual applications in the selected admission-period scope. Do not expose all candidate applications to a read-only member merely to populate a management control.
4. Use the current native Organization authority model: active department leadership or active global administrator may manage; active department membership or active global administrator may read. Deny inactive, wrong-department and unauthenticated actors. Read-only controls cannot substitute for backend enforcement. Multiple memberships are evaluated for the requested department, not the first membership.
5. Weekdays are explicit booleans (all false is a legitimate declaration, not an invented availability rule); language has exactly the three observed meanings. Reuse the existing canonical year-of-study schema. Reject unknown/excess fields, wrong types, invalid identifiers and invalid language. If preferences were never supplied, represent that explicitly and require completion before activation.
6. Repeated fresh activation of an active entry and editing an inactive entry reject. Deactivation preserves the application and known preferences. Re-activation can reuse displayed prior preferences only through an explicit submitted request. Determine deactivation-on-inactive behavior from the inspected legacy implementation and document it; do not silently change the command contract.
7. Use existing native HTTP semantics: strong ETags for selected item representations, required conditional mutation headers where applicable, scoped idempotency receipts, no-store authenticated responses and typed problems. Exact authorized retries replay the original result; changed payload/key reuse conflicts; stale fresh edits reject. Fresh authorization precedes replay, while fresh version preconditions run only for newly executed commands. Concurrent activation cannot create duplicate membership or lose an edit. Keep mutation, state and command receipt atomic.
8. Do not duplicate or weaken existing HTTP transport, access policy, SDK generation or PostgreSQL lifecycle mechanisms. Reuse the established Effect domain/Layer, native HttpApi contract, generated SDK and Foldkit/React Router dashboard integration. Preserve the current stack; this is not a framework migration.

## Product behavior

- Replace the unavailable Vikarer route with a working native journey in the established dashboard design. Department and semester selection is explicit and reflected in the URL; only authorized choices are offered. Empty pool, no matching applications, invalid scope, loading, denied and backend failure states have honest Norwegian copy.
- Members can read active pool entries and declared availability; leaders can select an actual eligible application, supply required preferences, activate, edit and remove. No placeholder people or success messages after failed writes. Preserve entered data after rejection and prevent repeated pending submissions. Version conflicts offer a clear refresh/retry path without silently overwriting.
- Filter options come from canonical native departments/semesters/admission periods, not hardcoded current-year fixtures. A selected semester with no period is an honest empty/unavailable scope, not a newly created admission period.
- Keep controls keyboard-operable, labelled and responsive; show results in the actual post-action viewport. Use the existing owned components and design tokens. Browser navigation must not grant private session authority to an uncontrolled API origin.

## Executable acceptance

Build and run a committed clean artifact using the real native backend, PostgreSQL and browser/dashboard runtime. Synthetic data and loopback services only. Reuse existing real dashboard journey runners and their login/session conventions. No real email, provider call, deployment or production data.

Required observations:

1. Leader signs in, chooses department A / historical semester, sees real candidate, declares availability/language, activates, reloads and sees persisted member. A second semester remains unchanged.
2. Edit weekdays/language/year, reload and verify canonical persisted values; deactivate and reload empty pool while application, recruitment rows and preferences remain. Re-activate with explicit preferences and verify.
3. Read-only member can see the pool but direct mutation is denied; wrong-department leader, inactive authority, anonymous and forged scope requests cannot read/mutate protected records. Exercise revoked-authority exact replay against the real database too.
4. Exact authorized retry does not add a second write/receipt. Changed request under the same key conflicts. Two concurrent activations cannot duplicate; two edits from the same selected version produce one accepted update and one conflict. Invalid/inactive edit leaves state unchanged.
5. Required explicit preferences and invalid language/year/types/excess fields fail without persisting invented defaults. Submitted failed draft is retained, pending duplicate click is suppressed, feedback remains visible, and Axe passes primary observed states. Include keyboard navigation.
6. Verify generated OpenAPI/SDK/access catalogs/docs and appropriate domain/backend/frontend tests/types/lint/format. Existing parity reports remain honest about unsupported broader migration claims.
7. Evidence records exact source SHA, actual runtime and database observations, rejection cases, resource cleanup and unrun boundaries. Stop all owned processes and remove only owned disposable databases. No success-with-skipped gates.

## Boundaries and delivery

One isolated engineer worktree owns implementation; root owns integration and independent acceptance. No edits to original `mono-web`, `mono-web-v02-runtime`, completed `mono-web-consolidation`, or other agents' files. No remote PR, push, deployment, credential change, live database mutation or merge is authorized by this local feature contract.

Potential defects discovered on this journey are reported with reproduced evidence and fixed at their source within a bounded explicit amendment. Do not expand into applicant onboarding, school allocation, finance cutover, password recovery or an unrelated tooling rewrite. The original migration inventory remains a dated assessment.

## Implementation amendment — canonical application revision (2026-09-06)

Real PostgreSQL activation exposed an older submission-only constraint: `admission_applications.revision = 0`. The canonical `PublicApplication` Model already permits nonnegative revisions. The required application-owned year edit now exposes that field's update variant and migration 0031 widens only the application revision constraint to `revision >= 0`. Substitute commands advance it atomically with preferences. Submission audit and command receipts remain immutable; acceptance includes original submission replay after a year edit and rejection of negative application revisions. This introduces no applicant identity/account workflow.

Fresh deactivation of an inactive entry returns 400, matching `AdminSubstituteDeactivateProcessor`; an authorized exact HTTP command retry replays its original accepted result.

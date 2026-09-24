# Substitutes operational journey

## Outcome and ownership

Substitutes owns admission-backed pool membership, declared weekday preferences, and the canonical application year of study.
Placements retains affiliation, assignment conflicts, offers, responses, acknowledgements, attendance, and occurrence-linked absence closure.
The existing coverage adapter joins active substitute preferences through the application and applicant account link to the candidate Person.
The journey must prove that supported pool activation changes that Person's coverage eligibility.
No new lifecycle, inferred attendance, or fixture-created successful business outcome is permitted.

## Bounded paths

- `packages/domain/src/substitutes/{schema,service,index}.ts`: portable schemas and complete service contract.
- `packages/database/src/substitutes/{postgres,service,index,service.test}.ts`: schema-derived queries, private persistence, complete locked commands, and regression checks.
- `packages/domain/src/substitutes/README.md` and `packages/database/src/substitutes/examples.ts`: consumer and maintainer guide with an executable public-import example.
- `apps/backend/src/substitutes/http.ts`, `apps/backend/src/main.ts`, and `apps/backend/src/cloudflare-worker.ts`: transport cutover and service composition.
- Existing backend test or runner composition sites that the added service requirement makes incomplete.
- `tools/e2e/placement-check.ts`, `tools/e2e/golden-school-service.mjs`, and `apps/dashboard/e2e/native-placement.spec.ts`: existing runner, independent observer, and continuous browser journey.

No Placements product files, sibling files, root manifests, generated API contracts, shared guide tooling, or production resources are in scope.

## Contract

The portable Substitutes service exposes complete pool reads, entry selection, and activate/edit/deactivate commands.
The database Layer captures Database and hides low-level locks and mutation helpers.
The caller authenticates and resolves current authority inside the command transaction before receipt lookup.
The service holds the application lock across the fresh snapshot, transport precondition callback, domain transition, and canonical writes.
The caller commits the result and response receipt together.
The service does not open a competing transaction, retry, deliver notifications, or grant authority.
Read scope, candidate concealment, HTTP status, ETag, receipt replay, and preference preservation remain unchanged.
Query requests and results derive from the owning schemas through SqlSchema.
Persistence errors preserve transaction-conflict classification without exposing internal causes.

## Observable acceptance

1. Regression checks reject stale preconditions without writes and roll back business writes when caller receipt completion fails.
2. A scoped command and query preserve activation, edit, deactivation, canonical year, and inactive preferences.
3. The browser activates the linked application's pool membership through existing controls.
4. Independent PostgreSQL observations establish no active pool or eligible Person before activation, then the correct application-backed eligibility afterward.
5. The same journey reports absence, offers eligible cover, accepts as the addressed Person, acknowledges as coordinator, records actual attendance, and closes that absence against its occurrence.
6. Wrong-recipient, assignment-conflict, stale-command, and delivery-failure/recovery controls remain effective.
7. Acceptance, acknowledgement, attendance, and commitment completion remain separate persisted facts.
8. Evidence binds to committed source. Disposable processes, database files, and credential manifests are removed.

The heavy PostgreSQL/browser run requires the parent's slot. Focused compiler, example, and regression checks can run separately.
The parent owns integration, shared documentation, changelog, and final project-wide validation.

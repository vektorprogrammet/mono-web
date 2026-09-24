# Golden school-service journey

Status: accepted locally and retired as an active implementation contract.
The [functional testing plan](../web-system-functional-testing.md#local-school-service-gate) documents the executable gate.
[STATE.md](../../STATE.md#functional-journey-automation) records the tested artifacts and acceptance limits.

This is slice A of the [web-system functional testing plan](../web-system-functional-testing.md).
Freeze this contract when its implementation PR opens. Record any later scope change explicitly.

## Goal

One local command exercises a continuous school-service workflow through the real web application.
The same command must be suitable for later credential-free CI execution.

A volunteer requests affiliation. A coordinator approves the request and plans school service.
The coordinator records actual attendance and completion. The volunteer then reads the resulting service record.
Persisted facts, authorized reads, and displayed outcomes must agree throughout the workflow.

This specification tests functionality, not visual design or usability.

## Business authority

The following sections define the behavior under test:

- [Business facts](../system.md#business-facts)
- [School administration](../system.md#school-administration)
- [School demand and placement](../system.md#school-demand-and-placement)
- [Dated school service](../system.md#dated-school-service)
- [Authority model](../system.md#authority-model)
- [Durable effects](../system.md#durable-effects)

Those sources own business rules. The runner must not invent additional policy.

## Starting system

Use an isolated PostgreSQL server, native backend, production-built dashboard, and real browser.
Use canonical migrations and synthetic identities only.
The scenario owns its database, ports, sessions, files, notification receiver, and processes.
No resource belongs to the operator's interactive demonstration or a shared deployment.

Create prerequisite Person and Account records, a department, a semester, and current coordinator authority.
Use separate native sessions for the volunteer, coordinator, and an actor outside the authorized scope.
The fixture may create a school when school creation is outside this journey's declared steps.
The fixture must not create the affiliation, placement, demand, roster, commitment, attendance, or terminal outcome under test.

Time inputs must satisfy the existing semester and service contracts.
The runner must not disable time rules, authority checks, database constraints, or required notification work.

## Required journey

| Step             | Actor and action                                                           | Required observation                                                                        |
| ---------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Affiliation      | Volunteer requests affiliation with the department                         | Pending request survives a fresh read; no coordinator authority appears                     |
| Approval         | Coordinator approves that request                                          | Volunteer becomes eligible under the existing affiliation contract                          |
| Placement        | Coordinator assigns the volunteer to the school and semester               | Assignment is visible to the authorized coordinator and survives reload                     |
| Demand           | Coordinator records compatible school demand                               | The selected school, weekday, block, semester, and required count agree                     |
| Proposal         | Coordinator generates and reviews the service proposal                     | Proposal references the actual preceding facts; no hidden fixture replaces them             |
| Confirmation     | Coordinator confirms the reviewed proposal                                 | The roster snapshot and required notification work commit together                          |
| Dated commitment | Coordinator schedules a date and interval from the confirmed roster        | The commitment preserves its demand and assignments; the volunteer sees their dated service |
| Service outcome  | Coordinator records sufficient actual attendance and completes the service | One supported terminal decision and its evidence persist                                    |
| Independent read | Volunteer reloads or opens a fresh authenticated context                   | The volunteer sees the resulting service record without coordinator-only authority          |

Use actual controls for the required user actions.
Use stable roles, labels, or narrow functional selectors, not layout coordinates or component internals.
Selecting an account through preview role controls does not establish native authorization.

## Required rejection cases

The first slice includes these bounded counterexamples:

1. An out-of-scope actor cannot perform the coordinator operation through the actual HTTP boundary.
2. A commitment with insufficient attendance cannot become Completed.
3. A stale or repeated terminal command cannot create another terminal outcome or overwrite the accepted decision.

Exercise the user-facing failure where the application provides that interaction.
Use a direct authenticated HTTP attempt for forbidden actions that the UI correctly does not expose.
Label that evidence as an HTTP authorization check, not a browser interaction.

Check committed facts after each rejection.
The denial must leave no unauthorized business mutation or unintended notification work.
Do not require the absence of legitimate security diagnostics.

## Evidence and completion criteria

The slice is complete only when all conditions hold:

1. One documented local command runs the complete scenario without manual setup beyond the declared toolchain.
2. The command tests an exact committed source artifact and records its identity.
3. Native sign-in and separate actor sessions supply the real application authority.
4. Every required journey step runs; an environment guard cannot silently skip acceptance.
5. The browser performs the declared actions against the real native backend and PostgreSQL database.
6. The runner reads committed facts through an independent connection and checks the referenced business invariants.
7. Required history, command receipts, and outbox evidence agree with the accepted decisions.
8. Reloads and independent actor reads agree with persisted facts.
9. All rejection cases fail honestly and preserve the accepted business state.
10. The notification receiver records the correct logical effect without claiming real-provider acceptance.
11. Removing a required step or breaking a business outcome makes the gate fail.
12. The runner retains sanitized failure evidence and closes owned resources after success, failure, and interruption.
13. The report distinguishes browser, HTTP, database, and loopback-provider observations.
14. No visual snapshot comparison, layout preference, or usability score determines functional acceptance.

Observe a deliberate failure with a disposable change or existing fault seam.
Do not add a permanent production backdoor solely to prove that the test can fail.
The gate must also fail if browser evidence is absent, even when API checks pass.

## Reuse and ownership

Start from the [placement acceptance parent](../../tools/e2e/placement-check.ts) and its [browser child](../../apps/dashboard/e2e/run-real-native-placement.mjs).
The parent already owns the database and backend. The child owns the dashboard and browser.
Retain one lifecycle owner for each resource.
Reuse the existing parity-compatible receipt format where it fits.
Native CI must not require external legacy authority files.

The [architecture](../architecture.md#ownership) assigns durable journey tooling to `tools/e2e`.
If the existing temporary parent must move, migrate its callers in the same slice.
Do not retain a second implementation or compatibility alias.
Do not turn that move into a general runner-framework rewrite.

Database observers assert semantic facts rather than publicizing table structure as a product contract.
Transport diagnostics must not pin an incidental internal request sequence.
The browser driver may change when the page structure changes.

## Explicit exclusions

- PGlite qualification and performance claims belong to slice C of the development plan.
- CI workflow wiring belongs to slice B; this slice supplies its runnable command and evidence contract.
- Generated client sequences belong to slice D.
- Absence, substitution, cancellation, and unfulfilled-service journeys receive separate bounded contracts.
- Recruitment, reimbursement, and migration acceptance remain separate workflows.
- Client design, visual regression baselines, and usability evaluation are not acceptance gates here.
- Production data, provider credentials, deployment, and external notifications are not authorized by this specification.

The business authority above and the executable gate remain current.
This retired contract records the accepted slice boundary.

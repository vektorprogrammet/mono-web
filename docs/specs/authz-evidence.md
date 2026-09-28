# Authorization evidence

Status: rollout (2026-09-28), on branch `refactor/authz-evidence-organization`. The operator
approved the full refactor after the pilot. Nine evidence types cover Organization administration,
team interest, onboarding, admission outcomes, placement boards, schools, recruitment maintenance,
days served, certificates, team applications, and social-event creation. Receipts and content stay
as they are, for the reasons under [Deliberately left](#deliberately-left).

Remove this specification when every domain command that needs authority takes evidence that only
its interpreter constructs, and `AGENTS.md#construction-over-trust` names the construction.

## Goal

A command that needs authority cannot be called without proof that the authority was checked.
Today the proof is a convention: a check returns `void`, and the call site must remember to run it
before the command. Forgetting it compiles.

## Evidence (measured on `f433ea9`)

- 14 exported authorize helpers in `apps/backend/src` and `packages/database/src` return `void` or
  a value that any module can construct. They have 123 call sites outside tests.
- Organization administration: `authorizeCreate` in `apps/backend/src/organization/http.ts`
  resolves the authority, maps it to `OrganizationActor`, and evaluates the AccessSpec with a
  global grant only for an administrator. The service then takes the `OrganizationActor` union. Any
  module can build `{ _tag: "OrganizationAdministrator", personId }`, and
  `packages/database/src/database.test.ts` does. The adapter therefore decodes the actor again and
  runs `authorizeOrganizationActor`, a runtime tag check.
- `OrganizationApiHttpOptions.resolveActor` is wired in `apps/backend/src/router.ts` and never
  called.
- Receipts already pass a `ReceiptMutationAuthorization` value into the command, but its
  constructors are exported, so it is not evidence yet.

## Design

Evidence is a value whose type carries a brand that no exported constructor provides. The
interpreter of the context is the only function that returns it, as a `Result` whose failure is
the existing typed denial. A command takes the narrow evidence type, not the actor union.

```ts
// packages/domain/src/organization/authority.ts
export interface OrganizationAdministratorEvidence {
  readonly [brand]: "OrganizationAdministratorEvidence";
  readonly actor: OrganizationAdministrator;
}

export const requireOrganizationAdministrator: (
  authority: OrganizationPersonAuthority,
) => Result.Result<OrganizationAdministratorEvidence, OrganizationRoleDenied>;

// packages/domain/src/organization/service.ts
createDepartment(command, administrator: OrganizationAdministratorEvidence)
```

The trusted kernel is the interpreter, plus the adapter that reads the authority facts. A caller
that fabricates an `OrganizationPersonAuthority` can still mint evidence; branding the authority
at its reader closes that, and belongs to the rollout.

What stays:

- The AccessSpec interpreter in `packages/domain/src/authz`. It decides credentials, concealment,
  time and scope, and `docs/model/authority.als` verifies it. Evidence carries its result; it does
  not replace it.
- The HTTP contract and the generated SDK. The homepage, OAuth user and service bearers, and the
  placements reference depend on them.
- The audit row. `actor_json` keeps the shape `{ _tag: "OrganizationAdministrator", personId }`.

## Pilot scope

- Add `OrganizationAdministratorEvidence` and `requireOrganizationAdministrator`.
- `createDepartment`, `createTeam`, and `createFieldOfStudy` take the evidence, in the service
  contract, the PostgreSQL adapter, and the HTTP handler.
- Delete `authorizeOrganizationActor`, `decodeOrganizationActor`, `organizationActorFrom`, and the
  unused `resolveActor` option with its router wiring.
- The authorization-rules proof observes `requireOrganizationAdministrator`, with the same
  observed tags as before.

## Falsifiers and pilot results

Measured on the pilot commit, with PostgreSQL 18 and `effect` 4.0.0-rc.116.

1. A create command rejects an `OrganizationActor`, an `OrganizationAdministrator`, an
   `OrganizationMember`, and a literal `{ actor }` at the type level: `expectTypeOf(...).not.toExtend`
   negative controls in `packages/domain/src/organization/authority-evidence.test.ts`, which
   `check-types` compiles. The compiler also found a forged administrator literal in
   `packages/database/runtime/organization-postgres-proof-main.ts`, now minted from an authority.
2. Property test (`it.prop`, seed 28092026, 200 runs): evidence exists exactly when
   `globalAdministrator` is `Active`, for the same person, in agreement with
   `mapOrganizationAuthorityToOrganizationActor`, while memberships and board seats vary through
   `Arbitrary.schema`. `Arbitrary.schema(OrganizationPersonAuthoritySchema)` itself exhausts on the
   RFC 3339 instant filter (0 runs, 501 discards), so the instant and delegations come from the
   fixtures.
3. Backend organization tests (14) and database organization tests (45) pass on PostgreSQL. The
   PGlite test now asserts the stored `actor_json` shape. The authorization-rules proof output is
   identical before and after, except process ids and timestamps.
4. Stryker 10.0.0, `coverageAnalysis: off`, over `requireOrganizationAdministrator` and its
   neighbours in `authority.ts`: 18 of 18 mutants killed.
5. Hand-applied mutants of `authorizeCreate`: granting no scope fails 2 backend tests. Always
   granting the global scope passes every test, and is equivalent: a member is still answered
   `authority.denied`, now by the missing evidence instead of the AccessSpec.

Stryker 10 with Vitest 5 does not see failures of tests nested in `describe`: the same assertion
killed every mutant at top level and none inside a `describe`. Its score overstates survivors in
such suites. The pilot test file is flat for this reason. Check the runner version for this before
Stryker joins the checks.

Invocation, from `packages/domain`, with Stryker installed outside the catalog and its `vitest`
resolved to the repository's copy: a Vitest config that includes `src/organization/**/*.test.ts`,
and a Stryker config with `testRunner: "vitest"`, `inPlace: true`, `concurrency: 1`,
`coverageAnalysis: "off"`, and `mutate: ["src/organization/authority.ts:<range>"]`.

## Rollout results

Each evidence type is an interface with a type-only brand (`declare const …Brand: unique symbol`)
and exactly one constructor, marked with a `// SAFETY:` comment. The command takes the evidence,
not a person id.

| Evidence                                    | Minted by                                                        | Consumed by                                                          |
| ------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| `OrganizationAdministratorEvidence`         | `requireOrganizationAdministrator` (domain)                      | `createDepartment`, `createTeam`, `createFieldOfStudy`               |
| `TeamInterestReadScope`                     | `requireTeamInterestScope` (domain)                              | `listTeamInterestRegistrations`                                      |
| `DepartmentReach<C>`                        | `requireDepartmentReach` (domain)                                | onboarding commands, `recordAdmissionOutcome`, placement board and coverage mutations |
| `SocialEventCreation`                       | `requireSocialEventCreation` (domain)                            | `SocialEvents.create`                                                |
| `SchoolCommandAuthorization`                | `authorizeSchoolCommand` (database, in the transaction)          | `executeCommand`                                                     |
| `RecruitmentMaintenanceAuthorization`       | `authorizeMaintenance` (database)                                | `maintainRecruitment`                                                |
| `DaysServedConfirmationAuthorization`       | `authorizeDaysServedConfirmation` (database)                     | `confirmDaysServed`                                                  |
| `CertificateIssueAuthorization`             | `authorizeCertificateIssue` (database)                           | `issueCertificate`                                                   |
| `TeamApplicationAuthorization<A>`           | `authorizeTeamApplicationAction` (database)                      | `deleteApplication`, `reviseIntake`                                  |

Deleted: `authorizeOrganizationActor`, `decodeOrganizationActor`, `organizationActorFrom`,
`resolveActor`, `CertificateCommandTarget`, `authorizeCertificateCommand`, `TeamInterestFilter`,
and the second authorization inside `executeSchoolCommand`. Commands whose evidence carries a
department (`DepartmentReach`, `SocialEventCreation`) fail when the locked row belongs to another
department: admission outcomes answer `authority.denied`, and placements and social events die,
because the handler minted the evidence for the row's own department.

Measured on `c2bb975`, with PostgreSQL 18:

- Type checks pass for domain, database, backend, dashboard, `tools/e2e`, and `tools/verification`.
- Focused Vitest suites pass: domain (organization, authz, placements, admissions: 165 tests),
  database (onboarding, admissions, placements, recruitment, schools, team applications including
  PgBouncer, organization, `database.test.ts`), backend (organization, onboarding, admission,
  placements, recruitment, schools, directory, team applications), and the onboarding delivery
  test of `tools/verification`.
- Property tests in `packages/domain/src/authz/reach-evidence.test.ts`: `requireDepartmentReach`
  agrees with `reaches`, with department administration for global-administrator capabilities,
  with `canManagePlacements`, and with `admissionOutcomePermission === "Decide"`; the team interest
  scope agrees with first-membership semantics; social-event creation agrees with its grant check.
  Generated inputs reach both outcomes (127 grants and 173 denials in one measured run).
- The authorization-rules proof output is unchanged apart from process ids and timestamps.
- Browser and golden journeys, each exit 0 on a clean tree with PostgreSQL 18 and Chromium:

  | Journey                        | Exercises                                                 | Revision  | Seconds |
  | ------------------------------ | --------------------------------------------------------- | --------- | ------- |
  | `just e2e organization`        | administrator evidence; member denied 403; replay         | `c2bb975` | 67      |
  | `just e2e schools`             | school directory authority matrix                         | `416850c` | 83      |
  | `just e2e social-events`       | social-event creation                                     | `416850c` | 77      |
  | `just e2e substitutes`         | admission outcomes                                        | `416850c` | 76      |
  | `just e2e onboarding`          | coordinator invitation; wrong department denied           | `416850c` | 77      |
  | `just e2e recruitment`         | recruitment session                                       | `416850c` | 55      |
  | `just golden school-service`   | placement board, coverage, forbidden step (26 steps)      | `416850c` | 118     |
  | `just golden team-application` | intake revision, deletion, delivery recovery              | `3a55e3a` | 88      |

  The first team-application run at `416850c` hung for 25 minutes before its first page. The
  base `f433ea9` passed, and a rerun of `416850c` passed in 91 s. The cause was the readiness probe
  of `tools/e2e/golden-harness.ts`, fixed in `3a55e3a`. No journey drives team interest in a
  browser (`tools/conventions/src/journeys.ts` excludes its spec); the database and backend tests
  cover it.

## Deliberately left

- Receipts. `ReceiptMutationAuthorization` is minted in the committing transaction, and the pure
  `decideCommand` re-checks access on the locked receipt. Sealing the constructor removes neither
  check, so it adds a brand without deleting code.
- Content. The database adapter resolves authority itself, in the transaction. The handler-side
  `authorizeContentOperation` is a second gate in front of it, not the authority.
- `authorizeAnonymous` and `authorizePerson` in `apps/backend/src/rpc/problem.ts`. They check
  the credential, not authority. `authorizeAnonymous` has no production consumer; a test keeps it
  consistent with the AccessSpec. The `authorizePerson` sites that run after a domain call only
  shape the response.
- `OrganizationPersonAuthority` is not branded at its reader. A caller that fabricates an authority
  can still mint evidence. Branding it touches every reader of the fact port and is its own slice.

Stryker is not in the root catalog. Stryker 10 with Vitest 5 runs no test nested in `describe` for a
mutant (upstream stryker-js issue #6210; fix proposed in PR #6214). A locally patched runner kills
18 of 18 mutants in `describe` as well. Stryker joins the catalog, `just`, and hosted Checks once a
release contains the fix, so that no check exists that nothing runs.

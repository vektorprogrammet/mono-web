# Authorization evidence

Status: pilot (2026-09-28), on branch `refactor/authz-evidence-organization`. The operator asked for one
context first. The pilot covers the three Organization administration create commands. The
operator has not approved the rollout to the other contexts.

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

## Rollout, after operator approval

One context per branch, in order of call sites: the person and anonymous helpers of
`apps/backend/src/http-api/problem.ts` (44), content, admission, recruitment, team applications,
schools, placements certificates, receipts (seal the existing constructors). Each branch deletes the
context's void helper and its runtime re-check in the adapter.

Stryker is not in the root catalog. The pilot runs it outside the catalog and reports the score. It
joins the catalog, `just`, and hosted Checks only with the rollout, so that no check exists that
nothing runs.

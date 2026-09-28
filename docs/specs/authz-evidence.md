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

## Falsifiers

1. A call of a create command with an object literal, an `OrganizationMember`, or an
   `OrganizationActor` fails to type check (`@ts-expect-error` negative controls in
   `packages/domain/src/organization/authority.test.ts`).
2. For every `OrganizationPersonAuthority` that `Arbitrary.schema` generates, evidence exists
   exactly when `globalAdministrator` is `Active`, it names the same person, and it agrees with
   `mapOrganizationAuthorityToOrganizationActor` (property test).
3. A member who calls the create endpoints still receives `authority.denied`, and nothing is
   written (existing backend and PostgreSQL tests).
4. Stryker, run over the pilot module, leaves no surviving mutant in
   `requireOrganizationAdministrator`.

## Rollout, after operator approval

One context per branch, in order of call sites: the person and anonymous helpers of
`apps/backend/src/http-api/problem.ts` (44), content, admission, recruitment, team applications,
schools, placements certificates, receipts (seal the existing constructors). Each branch deletes the
context's void helper and its runtime re-check in the adapter.

Stryker is not in the root catalog. The pilot runs it outside the catalog and reports the score. It
joins the catalog, `just`, and hosted Checks only with the rollout, so that no check exists that
nothing runs.

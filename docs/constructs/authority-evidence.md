# authority-evidence

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Checks a resolved authority and returns the evidence that a command which needs that authority takes; nothing else constructs it. The [index](../constructs.md) lists every category.

## `requireOrganizationAdministrator`

Checks that a resolved authority holds active global administration, and returns the evidence that the Organization administration commands require.

```ts
requireOrganizationAdministrator(
  authority: OrganizationPersonAuthority
): Result.Result<OrganizationAdministratorEvidence, OrganizationRoleDenied>
```

- Inputs: `authority: OrganizationPersonAuthority`
- Output: `Result.Result<OrganizationAdministratorEvidence, OrganizationRoleDenied>`
- Errors: `OrganizationRoleDenied`
- Requirements: none
- Side effects: none
- Source: [packages/domain/src/organization/authority.ts:263](../../packages/domain/src/organization/authority.ts#L263)

**How it works**

It is the only constructor of `OrganizationAdministratorEvidence`. An active global
administrator yields evidence whose actor names the same person; an inactive or absent grant
yields `OrganizationRoleDenied` for that person. It reads only `globalAdministrator` and
`personId`: memberships, board seats, and delegations confer no organization administration.

**Use**

```ts
const administrator = yield* Effect.fromResult(requireOrganizationAdministrator(authority));
yield* organization.createDepartment(command, administrator);
```

**Avoid**

Passing an `OrganizationActor` to a create command, or checking its tag at the call site:
any module can build an actor, so the command could not trust it. Resolve the authority and
require the evidence here.

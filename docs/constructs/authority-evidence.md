# authority-evidence

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Checks a resolved authority and returns the evidence that a command which needs that authority takes; nothing else constructs it. The [index](../constructs.md) lists every category.

## `requireDepartmentReach`

Checks that a resolved authority reaches one department with a capability, and returns the evidence that a department-scoped command requires.

```ts
requireDepartmentReach<C extends OrganizationCapability>(
  authority: OrganizationPersonAuthority,
  capability: C,
  departmentId: DepartmentId
): Result.Result<DepartmentReach<C>, DepartmentReachDenied>
```

- Inputs:
  - `authority: OrganizationPersonAuthority`
  - `capability: C`
  - `departmentId: DepartmentId`
- Output: `Result.Result<DepartmentReach<C>, DepartmentReachDenied>`
- Errors: `DepartmentReachDenied`
- Requirements: none
- Side effects: none
- Source: [packages/domain/src/authz/reach.ts:194](../../packages/domain/src/authz/reach.ts#L194)

**How it works**

It is the only constructor of `DepartmentReach` and decides exactly as `reaches`
with a department target: a board leadership of the independent department, a national board
leadership, a delegation over the department or the organization, or an active global
administrator where the capability admits one. A team leadership never reaches a department.

**Use**

```ts
const coordinator = yield* Effect.fromResult(
  requireDepartmentReach(authority, "placements.coordinate", departmentId),
);
yield* placements.execute({ mutation, coordinator, now, commandId });
```

**Avoid**

Checking `reaches` at the call site and passing a department and a person to the
command: the command then trusts that some caller checked, for that department. Require the
evidence, and take the department from it.

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
- Source: [packages/domain/src/organization/authority.ts:271](../../packages/domain/src/organization/authority.ts#L271)

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

## `requireTeamInterestScope`

Checks what team interest a resolved authority may read, narrowed to one requested department, and returns the scope that the listing requires.

```ts
requireTeamInterestScope(
  authority: OrganizationPersonAuthority,
  input: { readonly requested: DepartmentId | undefined; readonly departments: ReadonlyArray<DepartmentId> }
): Result.Result<TeamInterestReadScope, TeamInterestScopeDenied>
```

- Inputs:
  - `authority: OrganizationPersonAuthority`
  - `input: { readonly requested: DepartmentId | undefined; readonly departments: ReadonlyArray<DepartmentId> }`
- Output: `Result.Result<TeamInterestReadScope, TeamInterestScopeDenied>`
- Errors: `TeamInterestScopeDenied`
- Requirements: none
- Side effects: none
- Source: [packages/domain/src/organization/authority.ts:366](../../packages/domain/src/organization/authority.ts#L366)

**How it works**

It is the only constructor of `TeamInterestReadScope`. A reach over the organization
reads every department in `departments`, also while there is none; a department reach reads
that department; a team leader's reach reads the team where no department reach covers it. A
person with no reach, or with none in the requested department or its teams, is denied.

**Use**

```ts
const scope = yield* Effect.fromResult(
  requireTeamInterestScope(authority, { requested, departments }),
);
yield* organization.listTeamInterestRegistrations(scope, semesterId);
```

**Avoid**

Computing the departments and teams in a handler and passing them to the listing as a
filter: the listing then reads whatever scope a caller names. Require the scope here.

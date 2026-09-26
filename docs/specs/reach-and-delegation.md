# Reach and delegation (O8-11 to O8-15)

Status: frozen for implementation on 2026-09-26.
Branch `feat/reach-delegation-0926`. Retire this contract when the work lands on `main`.

Sources: `STATE.md` (decision rows "Reach and delegation (O8-11 to O8-14)" and O8-15 to O8-18), `docs/system.md`
(Organization administration, Membership and governance, Authority model, Expense reimbursement),
[the authority model](../model/authority.als), which is the verified source of truth, and
[the context map](../model/contexts.cml) (AccessControl `Delegations`, Organization `Team` and `Department`).

## Decisions

- O8-11: only Styret positions reach their department. An ordinary team leader acts within the own team. This removes access (section 8).
- O8-12: department work for a team is an explicit, named, time-bounded delegation: team T holds capability C in area A for the interval I.
- O8-13: the global-administrator grant keeps its organisational actions.
- O8-14: Styret leadership manages the delegations of its department's teams. Hovedstyret's leader or a global administrator manages them for national teams.
- O8-15: any current member of the national Økonomi team approves or rejects receipt claims. Only its leader, the finance lead, records settlement.
- A Styret seat is derived from team leadership and implies no global-administrator grant.

## 1. Sites that gave a team leader department reach (base `c231379c`)

Each site read `OrganizationAuthorityMembership.teamLeader` (`organization_memberships.is_team_leader`) or the `DepartmentLeader`
actor that `mapOrganizationAuthorityToAdmissionPeriodActor` derived from it. An active leader of any ordinary team in department D reached all of D.

| #   | Site                                                                                                                                                                                                                                                                                                                                                                                     | What a team leader in D got                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | `packages/domain/src/organization/authority.ts:133` `mapOrganizationAuthorityToAdmissionPeriodActor` (and the recruitment alias at `:184`)                                                                                                                                                                                                                                               | the `DepartmentLeader(D)` actor that sites 2 to 6 consume                                    |
| 2   | admission periods: `packages/domain/src/admission-period/update.ts:56,67,192`, `packages/database/src/admission-period/postgres.ts:210,363,573`, `apps/backend/src/admission/http-access.ts:18`, `http-commands.ts:190`, `http-reads.ts:88`, `apps/backend/src/authority.ts:442,490`                                                                                                   | create, revise, and list the admission periods of D                                          |
| 3   | admission outcomes: `packages/domain/src/admissions/outcome.ts:103`, `apps/backend/src/admission/outcome-http.ts:125`, `packages/database/src/admissions/outcome.ts:41`                                                                                                                                                                                                                 | decide the admission outcomes of D                                                           |
| 4   | recruitment: `packages/database/src/recruitment/postgres.ts:228-232`, `scheduling-postgres.ts:260,271`, `report-postgres.ts:23-41`, `maintenance-postgres.ts:57-63`, the raw SQL resolver in `http-postgres.ts:213-306`, `apps/backend/src/recruitment/http-access.ts:184`, `http-commands.ts:329`, `http-reads.ts:127`, `apps/backend/src/authority.ts:458,520`                   | assign and staff interviews, read every interview and the interview report of D              |
| 5   | placements: `packages/domain/src/placements/policy.ts:60` `canManagePlacements`                                                                                                                                                                                                                                                                                                          | coordinate the placements, rosters, and coverage of D                                        |
| 6   | onboarding: `apps/backend/src/onboarding/http.ts:180`                                                                                                                                                                                                                                                                                                                                    | invite the admitted applicants of D to claim an account                                      |
| 7   | schools: `packages/domain/src/schools/administration.ts:126,136`                                                                                                                                                                                                                                                                                                                         | administer schools and capacity in D                                                         |
| 8   | appointments: `packages/database/src/organization/lifecycle-postgres.ts:33-37,53,69-71,85-96`                                                                                                                                                                                                                                                                                           | appoint, revise, end, suspend, and reinstate in every team of D, and read their appointments |
| 9   | people directory: `packages/domain/src/organization/directory.ts:127-150`                                                                                                                                                                                                                                                                                                                | read the people directory of D                                                               |
| 10  | mailing recipients: `packages/database/src/organization/mailing-lists-postgres.ts:42-57`, `apps/backend/src/organization/http.ts:662-676`                                                                                                                                                                                                                                                | read the copyable recipients of D                                                            |
| 11  | team interest: `apps/backend/src/organization/http.ts:662-676,759`                                                                                                                                                                                                                                                                                                                       | read the team-interest registrations of D                                                    |
| 12  | content: `packages/domain/src/content/actor.ts:37-84` (`ContentPublisher`)                                                                                                                                                                                                                                                                                                               | publish, unpublish, pin, and revise the articles of D                                        |
| 13  | profile role: `packages/domain/src/organization/authority.ts:197-217` (`ROLE_TEAM_LEADER`), read by the dashboard navigation, `shell.server.ts:20`, and `preview-role-override.ts:72`                                                                                                                                                                                                    | the leader navigation                                                                        |

Kept within the team: the own team's applications (`packages/domain/src/team-application/policy.ts:48`) and appointments.

## 2. One resolver

Facts. `resolveOrganizationPersonAuthorityWithSql` (`packages/database/src/organization/authority-postgres.ts`) reads, inside the caller's
transaction and with the existing `ForShare` locks, the extended `OrganizationPersonAuthority` (`packages/domain/src/organization/authority.ts`):

```ts
OrganizationAuthorityMembership = { membershipId, teamId, departmentId, active, unitLeader,
  unitKind: "Team" | "DepartmentBoard", teamScope: "HomeDepartment" | "National", departmentIndependent }
OrganizationPersonAuthority = { personId, evaluatedAt, globalAdministrator, memberships,
  nationalBoardSeats: [{ membershipId, boardId, active, unitLeader }],
  delegations: [Delegation] } // the delegations of the person's teams
```

Interpretation. `packages/domain/src/authz/reach.ts` is the one interpreter; AccessControl owns it and the `Delegations` aggregate.
`ORGANIZATION_CAPABILITIES` in `packages/domain/src/authz/delegation.ts` is the one registry. Each entry states whether an ordinary team's
leader holds the capability within the team, whether a board's leader holds it where the board sits, whether the global-administrator grant
holds it everywhere (O8-13: exactly what the grant had), and how a delegation may carry it.

| Capability               | Team leader | Board leader | Global administrator | Delegation                                | Gates (section 1)                 |
| ------------------------ | ----------- | ------------ | -------------------- | ----------------------------------------- | --------------------------------- |
| `admissions.periods`     | -           | yes          | yes                  | in the team's area                        | 2                                 |
| `admissions.outcomes`    | -           | yes          | yes                  | in the team's area                        | 3, 6                              |
| `recruitment.interviews` | -           | yes          | yes                  | in the team's area                        | 4 (the recruitment actor still refuses a global administrator) |
| `placements.coordinate`  | -           | yes          | yes                  | in the team's area                        | 5                                 |
| `schools.administer`     | -           | yes          | yes                  | in the team's area                        | 7                                 |
| `appointments.manage`    | own team    | yes          | yes                  | in the team's area                        | 8                                 |
| `people.read`            | -           | yes          | yes                  | in the team's area                        | 9, 10                             |
| `team-interest.read`     | own team    | yes          | yes                  | in the team's area                        | 11                                |
| `content.publish`        | -           | yes          | yes                  | in the team's area                        | 12                                |
| `receipts.approve`       | -           | -            | -                    | national teams, whole organization only   | O8-15                             |
| `receipts.settle`        | -           | -            | -                    | as approve, and to the leaders only       | O8-15                             |
| `delegations.manage`     | -           | yes          | yes                  | never                                     | new                               |
| `organization.govern`    | -           | yes          | yes                  | never                                     | new, only an organization-wide reach covers it |

- Seats. A team's leader acts at the team. A department board's leader acts in its department, only while the department is independent.
  The national board's leader and a global administrator act in the whole organization.
- Containment (`scopeCovers`). The organization covers everything. A department covers itself and its teams. A team covers itself.
- Delegated reach (`delegationsReaching`). An active delegation of C, from its start inclusive to its end exclusive, gives C in its area to each
  person with an active membership of the delegated team (started, not ended, not suspended, active team and department).
  `LeadersOnly` also requires the leadership. The delegation must still conform to the registry and to the team's current area
  (`delegationConforms`), so a reclassified team or a changed registry fails closed.
- API: `reaches`, `reachScopes`, `reachedDepartments` (All or department ids), `reachedTeams`, `delegationsReaching`, `holdsDepartmentReach`,
  `leadsUnit`, and `leadsAnyTeam`.
- `mapOrganizationAuthorityToDepartmentActor(authority, capability, departmentId)` replaces the admission-period and recruitment mappers.
  An active global administrator comes first (O8-13), then `DepartmentAdministrator(D)` if the capability reaches D, then `Member(D)` for an
  active membership in D, else the existing denials. The actor `DepartmentLeader` is renamed `DepartmentAdministrator` everywhere, with
  the requirement ids `organization.single-department-administrator` and `recruitment.assigned-interviewer-or-administrator`.
- Profile role (a navigation projection). `ROLE_ADMIN` for an active grant, `ROLE_DEPARTMENT_ADMINISTRATOR` for any reach beyond one team
  through a board leadership or a delegation, `ROLE_TEAM_LEADER` for the leader of an ordinary team, else `ROLE_TEAM_MEMBER`.
  The HTTP `UserRoleSchema` derives from the domain `ProfileRoleSchema`. Department pages need `ROLE_DEPARTMENT_ADMINISTRATOR`.
- Every ad-hoc check in section 1 is gone; the raw SQL resolver in `recruitment/http-postgres.ts` uses the shared projection.
- Enforcement. The Oxlint rule `anti-slop/no-leadership-reach` rejects a `unitLeader` read and SQL `is_team_leader` text in product source,
  except in `authz/reach.ts`, the Organization adapters that persist and project memberships, test support, and tests (`oxlint.config.ts`).

## 3. How Styret, national teams, and independence are known

Explicit reviewed data, with defaults that fail closed:

- `organization_teams.kind` (`Team` or `DepartmentBoard`, default `Team`), with at most one board per department and a board always local.
- `organization_teams.team_scope` (`HomeDepartment` or `National`, default `HomeDepartment`).
- `organization_departments.independent` (default `false`).

No code path reads a team name. An unclassified team is an ordinary local team, and a department that is not recognised has no governing Styret
(Hovedstyret and global administrators govern it). Right after the migration, only global administrators reach a department.

Two Organization lifecycle commands set the data, with the same endpoint, receipts, and history as appointments:
`ClassifyTeam { teamId, unitKind, teamScope, expectedRevision }` and `RecogniseDepartment { departmentId, independent, expectedRevision }`.
Both need `organization.govern` over the whole organization: a global administrator or Hovedstyret's leader. The admin section of
`/dashboard/team` shows them. The reviewed import keeps creating ordinary teams; an operator classifies the legacy Styret teams afterwards.

Local development seeds classify each leader persona that needs department reach as the leader of its department's board in an independent
department (`just seed` and the journey seeds). Denial personas stay ordinary team leaders.

## 4. Derived Styret seats

Each current leader of a local team sits on the Styret of its home department; each current leader of a national team sits on Hovedstyret
(`DerivedBoards`, Q1 to Q3). A derived seat is not stored. It starts and ends with the leadership and confers membership and certificate
issuance, never administration or a global-administrator grant. No capability in the registry is held by a board member without leadership, so
Q2 holds by construction. The certificates slice adds the seat list with its first consumer.
A Styret or Hovedstyret seat never sets `globalAdministrator` (K3); the grant is read only from `organization_global_administrator_grants`.

## 5. Delegation aggregate

- Table `organization_delegations`: `delegation_id`, `name`, `team_id`, `capability` (the delegable set), `area` (`Department` or
  `Organization`) with `area_department_id`, `holders` (`AllMembers` or `LeadersOnly`), `start_at`, nullable `end_at`, and `revision`.
  Checks: an ordered interval, settlement only to leaders, receipt capabilities only for the whole organization, millisecond instants.
  A trigger allows only an earlier end with the next revision and forbids deletion.
- History `organization_delegation_history`: command id, digest, actor, delegation, team, action (`IssueDelegation` or `EndDelegation`),
  reason, time, and the before, after, and result JSON. It is append-only.
- Domain (`packages/domain/src/authz/delegation.ts`): `Delegation`, `DelegationArea`, `DelegationCommand`, and one exhaustive
  `transitionDelegation`. Issuing needs an active ordinary team whose area covers the requested area and a capability that the registry
  delegates there. Ending never extends a delegation and never ends it before now.
- Executor (`packages/database/src/authz/delegation-postgres.ts`), the flow of `executeOrganizationLifecycle`: decode, command lock
  (`AdvisoryLockKey.delegationCommand`), person lock, account check, authority `ForShare`, team row `FOR SHARE` or delegation row `FOR UPDATE`,
  `delegations.manage` over the team's area (its home department, or the organization for a national team), digest with replay or conflict,
  transition, then state, history, and receipt in one transaction.
- Read `readDelegationManagement`: the teams in the person's `delegations.manage` reach, their departments, their delegations with the derived
  state (`Future`, `Current`, `Ended`), and history. It is denied when nothing is manageable.
- HTTP: `GET /api/organization/delegations` (`organization.readDelegationManagement`) and `POST /api/organization/delegations/commands`
  (`organization.executeDelegation`), with capability `organization.manage-delegations`, scope resolver `organization.delegation-management`,
  and the problem union of the lifecycle commands. OpenAPI and the SDK operation index regenerate from the contract.
- Dashboard: `/dashboard/delegeringer` with the `vektor-delegation-management` Foldkit element, and the department link "Delegeringer".

## 6. O8-15: Økonomi approves, the finance lead settles

The economy team is whichever national team holds two national delegations, issued by Hovedstyret's leader or a global administrator:
`receipts.approve` to all members for the whole organization, and `receipts.settle` to the leaders only. `projectReceiptAuthority`
(`packages/domain/src/receipt/authority.ts`) turns each reaching delegation into an approval or settlement fact keyed `delegation:<id>`,
beside the person's Economy grants. The approval list, approval queue, and settlement queue work unchanged. A member approves, rejects, and
reopens; settlement stays concealed as not found for a member. The person-keyed Economy grants stay until the receipt seeds and the golden
reimbursement journey use the delegations (STATE.md, Known gaps).

## 7. Migration

`packages/database/migrations/0076-reach-and-delegation.sql` (id 76, the next free id on `bac4dedd`):
team `kind` and `team_scope` with the one-board index and the local-board check; department `independent`; `organization_memberships_target`
without `NOT is_team_leader` for national-board rows, so Hovedstyret has a leader (and `transitionAppointment` no longer rejects it);
lifecycle history actions `ClassifyTeam` and `RecogniseDepartment` with target kind `Department`; the delegation table, guard, and history.

## 8. Access removed

For a person whose authority is an active leadership of an ordinary team T in department D, without a board leadership or a delegation:

- admission periods of D (create, revise, list);
- admission outcome decisions of D (a member of D still reads the list);
- interview assignment, staffing, the full scheduling board, and the interview report of D;
- placement coordination of D, and applicant account invitations of D;
- school administration of D;
- appointments in D's other teams (T's appointments stay; the candidate list keeps the names of people with a membership in D);
- the people directory and the mailing recipients of D;
- team-interest registrations of D's other teams (T's registrations stay);
- publishing, unpublishing, pinning, and revising others' articles in D (own drafts stay);
- the department pages "Fullførte intervjuer", "Intervjubemanning", "Søkerkontoer", "Attester", "Linjer", and the applicants board.

Until an operator enters the data, the same holds for Styret leaders of departments that are not yet recognised as independent, and for every
leader of a team that is not yet classified as a board, which includes all imported data. Global administrators keep what they had.
Added: Hovedstyret's leader (a national-board appointment with leadership) reaches every department. A global administrator appoints the first one.

## 9. Alloy predicates per code rule

| Code rule                                                            | Predicates                                                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| role type from unit kind and leadership; the capability registry     | `capabilityTable`, `typeFollowsPosition`                                                        |
| seat per unit; Styret only while independent; Hovedstyret everywhere | `boardsSitWhereTheyServe`, K1, K2, X1, X2                                                       |
| a team leader reaches only its team                                  | `teamRolesStayInTheirTeam` (L), mutant `leadersAdministerTheirDepartment`                       |
| a board member or derived seat has no administration                 | `derivedSeatConfersNoAdministration` (Q2), mutant `styretMembersAdministerTheDepartment`        |
| a delegation carries only delegable capabilities                     | `delegationsCarryDelegableActions`, K3 mutant `delegationsMayCarrySystemAdministration`         |
| the delegation area lies inside the team's area; national by scope   | `delegationsStayInTheirTeamArea`, `teamAreaIsItsScope` (mutant `nationalByHome`)                |
| the manager needs `delegations.manage` over the team's area          | `delegationsIssuedOverTheTeamArea` (mutant `delegationsIssuedAtTheHome`)                        |
| a delegation reaches only its team, its area, and its interval       | `delegatedReach`, `delegationActive`, M1, M2, M3                                                |
| leaders-only delegations; settlement only to leaders                 | `LeaderDelegation`, `settlementReachesLeaders`, `scenarioEconomyMemberApprovesButDoesNotSettle` |
| authority is resolved per request, never cached                      | `effectiveByOwnState`                                                                           |
| the global-administrator grant is an explicit list, apart from roles | `grantCapabilitiesExplicit`, K3                                                                 |

The code is stricter than the model in two places: receipt delegations act only in the whole organization, and only an ordinary team holds a delegation.

## 10. Tests (red on `main`, green on the branch)

- `packages/domain/src/organization/authority.test.ts`: an ordinary team leader gets no department administration; a department board
  governs only while the department is independent; Hovedstyret's leader administers every department without a grant.
- `packages/domain/src/authz/reach.test.ts`: a delegation gives exactly C in A during [start, end), nothing at the end, nothing for another
  capability or area, nothing to a suspended or ended member, only leaders for `LeadersOnly`, nothing after its team is reclassified;
  settlement only through leaders-only national delegations; transitions reject an area outside the team's area, a board, settlement to all
  members, and an extending end.
- `packages/database/src/organization/leader-reach.test.ts`: a team leader appoints within the own team and nowhere else in D, and gets no
  department mailing recipients. On `main` both checks fail: the appointment in the other team succeeds and the recipients are returned.
- `packages/database/src/authz/delegation-postgres.test.ts`: a Styret leader manages delegations only for the teams of its department;
  Hovedstyret's leader and a global administrator manage national teams; replay and conflict; a delegation gives exactly C in D during I and
  nothing after its end; a suspended member gets nothing; an Økonomi member approves but cannot settle, the finance lead settles, and an
  ordinary team's member gets no approval. Without the receipt change the member's approval is denied (`ReceiptScopeDenied`).
- `apps/backend/src/organization/team-interest.http.test.ts`: a team leader reads only the own team's registrations; a global administrator
  gets an empty success while no department exists (a regression that the identity browser suite found).
- `apps/backend/src/placements/http.test.ts`: the placement coordinator acts through a `placements.coordinate` delegation.
- Existing tests that tested department work now use a Styret leader of an independent department; tests that pinned the old leader rule changed.
- The delegation API does not exist on `main`, so its tests fail there by absence.

## 11. Answers (Main, 2026-09-26)

1. Receipt person grants: kept in this slice; the retirement is a STATE.md gap.
2. The `DepartmentLeader` actor: renamed `DepartmentAdministrator` everywhere.
3. Governance commands: a global administrator and Hovedstyret's leader.
4. Membership-derived department access (content editing, social events, schools directory, receipt approver relationship, the recruitment
   `Member` actor): unchanged and recorded as a STATE.md gap.
5. Team interest: department reach reads the department; an ordinary team's leader reads the own team's registrations.
6. Derived seats: specified and tested for Q2; the seat list comes with the certificates slice.

## 12. STATE.md rows and the cutover obligation

- The decision rows O8-11 to O8-14 and O8-15 record what is done. O8-16 (certificates by Hovedstyret) is open; O8-17 (Rekruttering decides
  admission outcomes) needs an `admissions.outcomes` delegation per department, an operator step; O8-18 is done.
- Known gaps: the receipt person grants; the membership-derived department access in answer 4; derived seats without a list; routes without a
  department act in the single department of the person's active memberships, so Hovedstyret's leader and an organization-wide delegation
  must name a department there (the requests fail closed); the four-valued profile role is a coarse projection.
- Before cutover: classify the legacy Styret teams and the national teams, and recognise independent departments, by explicit command.
  Until then no imported team leader reaches a department.

## 13. Commits

1. `docs(specs)`: this contract.
2. `feat(organization)!`: the reach interpreter, the board, national-team, and independence facts with their commands, and every section 1 site.
3. `feat(organization)`: delegation management (executor, read, HTTP, SDK, dashboard).
4. `feat(receipts)`: the Økonomi delegations approve and settle (O8-15).
5. `build(lint)`: leadership facts stay in the reach interpreter.
6. `docs`: `docs/system.md` and `STATE.md`.
7. `fix(organization)`: an organization-wide reach authorizes the team-interest and mailing-list reads while no department exists.

## 14. Landing

- If `build/lead-constructs-0926` lands first, rebase and run `just migration-manifest write` so the checksum manifest records migration 76.
  Its lint rule shares `tools/oxlint/anti-slop/index.ts`, `UPSTREAM.txt`, `provenance.json`, and `oxlint.config.ts` with the rule here; the hunks sit apart.
- Operator steps after landing, per environment: classify each department board and national team and recognise the independent departments;
  issue the Økonomi delegations (`receipts.approve` to all members, `receipts.settle` to the leaders) and any Rekruttering `admissions.outcomes` delegation.
- Not run: `just proof authorization-rules` needs a disposable PostgreSQL at `DATABASE_URL` and is red on `main` in the shared migration proof.
  `just golden reimbursement` and `just e2e interview-response` fail at their known `main` assertions only.

# Design spec 0055 - person-keyed authorization authorities

## Metadata

| Field | Value |
|---|---|
| Goal | Provide authority-owned person-to-role resolution before the native Identity cutover |
| Status | Contract remains frozen; implementation is present at integrated branch `f07b86d7babc041ee5f947b41381de094586e9d6`; runtime and acceptance evidence are pending |
| Base | `dd3aaf6` |
| Depends on | 0040 logical capability topology, 0045 Effect Model/Service authority, current Organization, Admissions, Recruitment, Profile, and Economy models |
| Required by | 0054 native Identity authority via Better Auth |
| Operator boundary | No production import, production data change, credential change, deployment, or external effect |

## Dependency amendment for spec 0054

This contract is a mandatory prerequisite for spec 0054. Spec 0054 cannot satisfy its actor-resolution contract before this contract satisfies its definition of done.
For revisions after `dd3aaf6`, the normative dependency set of spec 0054 includes spec 0055.

This dependency does not remove or reduce a requirement in spec 0054. Identity still owns credentials, sessions, and the authenticated `PersonId` only.

The `*_AUTH_TOKENS` maps still leave production wiring. No bearer-token fallback remains after the cutover.

Spec 0054 keeps its session-expiry, revocation, cookie, Profile, HTTP, SDK, and browser requirements. This contract adds the missing authorization source after session resolution.

## Problem

Spec 0054 resolves a valid session to `PersonId`. It then requires each authority to resolve that person to its actor.

The current native services do not provide this resolution. Their HTTP adapters read role facts from bearer-token maps.

Organization persists memberships, teams, departments, leader flags, suspension state, and active intervals. It does not persist a global-administrator grant.

A single person can have memberships in multiple teams and departments. A single actor row cannot represent that state without loss.

Receipt approval scope and payment authority are not Organization facts. Economy must own these receipt-specific facts.

An empty person-role resolver is not a safe cutover. It changes all authenticated role-gated requests into denials.

## Decision

Authorization uses this flow:

```text
request Cookie
    |
    v
Identity session resolution
    |
    v
PersonId + one authorization instant
    |
    +-------------------+------------------+
    |                   |                  |
    v                   v                  v
Organization        Economy           Profile
projection          receipt facts     display data
    |                   |
    +---------+---------+
              |
              v
      request-specific actor
```

Identity returns `PersonId`. Identity does not return a role, department, approval scope, membership, or payment fact.

Each protected request captures one `authorizationInstant`. All authority projections for that request use this instant.

The authority layer creates a request-specific actor from canonical state. It does not store one lossy role beside the Identity account.

## Organization authority

### Canonical state

Organization remains the authority for these facts:

- departments and their active state
- teams and their active state
- membership intervals
- membership suspension
- the team-leader flag
- global-administrator grants

Existing Organization tables remain canonical for all membership facts. No new table copies a member role, leader role, team, or department.

The only new Organization role state is a minimal global-administrator grant. This fact does not exist in the current Organization model.

A global-administrator grant has these semantic fields:

- a stable grant ID
- a `PersonId`
- an inclusive `startAt`
- an optional exclusive `endAt`
- a nonnegative revision

The authority rejects overlapping active grant intervals for one person. The authority retains ended grants as history.

A grant is a human assertion. The grant is not a fact derived from Identity, Profile, or an authentication method.

### Organization person projection

Organization computes `OrganizationPersonAuthority` for one `PersonId` and one `authorizationInstant`.

```text
OrganizationPersonAuthority
├─ personId
├─ evaluatedAt
├─ globalAdministrator: Active | Inactive | Absent
└─ memberships[]
   ├─ membershipId
   ├─ teamId
   ├─ departmentId
   ├─ active: boolean
   └─ teamLeader: boolean
```

The `memberships` collection contains each resolvable membership for the person. The collection has stable ordering by `departmentId`, `teamId`, and `membershipId`.

A membership is active at instant `t` only when all these conditions are true:

1. `startAt <= t`.
2. `endAt` is absent, or `t < endAt`.
3. The membership is not suspended.
4. The referenced team is active.
5. The referenced department is active.

A global-administrator grant is active at instant `t` when `startAt <= t` and `t < endAt`. An absent `endAt` means no upper bound.

The global-administrator status is `Active` when an active grant exists. It is `Inactive` when only ended or future grants exist.

The status is `Absent` when the person has no global-administrator grant. This distinction preserves inactive-actor behavior.

The projection keeps all resolvable departments and teams. It never selects a primary membership or primary department.

### Organization Service contract

The Organization Service adds one query:

```text
resolvePersonAuthority(personId, authorizationInstant)
  -> OrganizationPersonAuthority
```

The PostgreSQL interpreter computes the result from canonical Organization state. Test Layers can provide a synthetic projection.

The query is not an Identity query. The `auth` schema is not an input to this query.

## Economy receipt authority

Economy persists only facts that Organization cannot derive. These facts are specific to receipt submission or approval.

Economy can persist these authority records:

- a payment authority for one person and one department
- a department approval grant for one person and one department
- a global receipt approval grant for one person

A payment authority contains the encrypted payment account value. It also contains an active interval and a revision.

An approval grant contains an active interval and a revision. A department grant contains its department ID.

Economy does not copy these Organization facts:

- membership activity
- membership suspension
- the team-leader flag
- team activity
- department activity
- the global Organization administrator grant

Economy resolves receipt authority from its records and the Organization projection. Both inputs use the same `authorizationInstant`.

A payment authority requires active Organization authority in its department. A global administrator still requires a separate Economy payment authority.

A receipt approval grant is usable only while the grant is active. A department approval also requires active Organization authority in that department.

A global receipt approval grant also requires active Organization authority. It does not require membership in the receipt department.

A global receipt approval grant is receipt-specific. A global Organization administrator does not receive it by implication.

This model preserves the current explicit receipt approval law. It does not turn Organization roles into hidden Economy policy.

## Request-specific actor mappings

### Shared rules

A missing or invalid session produces `UnauthenticatedActor` and HTTP 401. An authenticated person without authority produces a typed denial and HTTP 403.

A caller-supplied department can select an authorized scope. It cannot create authority.

If a route has canonical department state, that state selects the department. Examples include an application, an interview, and an existing receipt.

A list query evaluates all authorized scopes. It does not select one membership and discard the other memberships.

### Admission actor

The mapper creates existing `AdmissionPeriodActor` values as follows:

| Request scope | Organization projection | Existing actor |
|---|---|---|
| Any department | Active global administrator | `GlobalAdmin { personId, active: true }` |
| Any department | Inactive global administrator and no active global grant | `GlobalAdmin { personId, active: false }` |
| Department `D` | At least one active leader membership in `D` | `DepartmentLeader { personId, departmentId: D, active: true }` |
| Department `D` | No active membership and at least one inactive leader membership in `D` | `DepartmentLeader { personId, departmentId: D, active: false }` |
| Department `D` | Active membership in `D`, with no active leader membership in `D` | `Member { personId, departmentId: D, active: true }` |
| Department `D` | Only inactive member memberships in `D` | `Member { personId, departmentId: D, active: false }` |
| Department `D` | No Organization authority record in `D` | Typed scope or role denial |

Admission management lists use the union of all authorized departments. Global administrators receive the global projection.

The mapper creates one existing actor for each department transition. It does not invent one department for a multi-department person.

### Recruitment actor

Recruitment uses the same mapping as Admissions. This preserves the existing `RecruitmentActor = AdmissionPeriodActor` contract.

Recruitment first reads the canonical department from the application, interview, or admission period. It then creates the actor for that department.

Recruitment board queries use all authorized departments. A duplicate application or interview appears once in the result.

Invitation-response capabilities keep their separate capability authority. This contract does not convert those capabilities into session roles.

### Organization actor

An active global administrator maps to `OrganizationAdministrator { personId }`.

Every other authenticated person maps to `OrganizationMember { personId }`. Existing Organization transitions reject that actor when administrator authority is required.

Organization does not infer administrator authority from team leadership. Membership count does not change administrator authority.

### Receipt actor and principal

Receipt owner operations use the authenticated `PersonId`. An owner list does not require one selected department.

Owner operations require at least one active Organization authority. Historical authority produces the existing inactive-actor denial.

A new receipt submission selects one active payment authority. The selection must match active Organization authority in the same department.

If multiple payment authorities are available, the request must select a department. Economy rejects a missing selection as ambiguous.

For an existing receipt, its immutable department selects the scope. The caller cannot replace this department.

The mapper creates the existing `ReceiptActor` as follows:

| Operation | Authority facts | Existing actor fields |
|---|---|---|
| Submit in `D` | Active Organization authority and active payment authority in `D` | `personId`, `departmentId: D`, `active: true`, `approvalScope: None` |
| Approve in `D` | Active Organization authority in `D` and active Economy approval grant for `D` | `personId`, `departmentId: D`, `active: true`, `approvalScope: Department(D)` |
| Approve any receipt | Active Organization authority and active global Economy receipt approval grant | `personId`, receipt department, `active: true`, `approvalScope: Global` |
| Known payment or approval authority is inactive | Applicable department and approval scope | Existing `ReceiptActor` fields with `active: false` |
| No applicable authority record | None | Typed scope or role denial |

The receipt principal adds the payment-account ciphertext only for submission. The `ReceiptActor` never carries this value.

### Profile actor and dashboard role

Profile reads and updates profile data for the authenticated `PersonId`. It gets role facts only from Organization.

Profile maps the complete Organization projection to the existing dashboard role:

| Organization projection | Dashboard role |
|---|---|
| Active global administrator | `ROLE_ADMIN` |
| At least one active leader membership | `ROLE_TEAM_LEADER` |
| At least one active membership | `ROLE_TEAM_MEMBER` |
| No active Organization authority | Typed inactive or role denial |

This role is a coarse dashboard projection. The projection does not replace the full Organization authority value.

Profile does not read Admission, Recruitment, Receipt, or Identity role records. This rule preserves the capability graph in spec 0040.

## Active-at-time and concurrency laws

Each protected operation captures `authorizationInstant` once. Session resolution and all authority queries use that value.

Each authority uses half-open intervals, `[startAt, endAt)`. An authority is inactive at its exact `endAt` value.

A protected command resolves authority in the same database transaction as its state transition. The transaction reads all relevant authority rows.

The command locks the applicable membership, team, department, and grant rows. An authority change gets an incompatible lock on the same rows.

A concurrent authority change and command have one database order. If the authority change commits first, the command uses the new authority state.

If the command commits first, its audit records the accepted actor and `authorizationInstant`. The later authority change does not rewrite history.

A command must not use a role cache from a session cookie. A command must not use a projection from an earlier request.

Read projections use one database snapshot. A list cannot mix authority facts from different snapshots.

A retry recomputes the authority projection. A retry does not reuse the actor from the failed attempt.

Spec 0054 keeps its stronger session-revocation laws. This contract does not add a grace period after logout or session expiry.

## Disposable seed and backfill contract

This contract authorizes only disposable local data. It does not authorize a production import or production backfill.

The disposable seed creates these records in dependency order:

1. Person and Profile rows.
2. Organization departments and teams.
3. Organization memberships.
4. Minimal Organization global-administrator grants.
5. Economy payment authorities and receipt approval grants.
6. Better Auth users and credential accounts from spec 0054.

A disposable backfill can read the existing test token maps as evidence input. It never stores a bearer token.

The backfill groups input by `PersonId`. It rejects conflicting facts for the same person, department, authority kind, or active interval.

For Organization members and leaders, the backfill checks existing membership state. It does not write a copied member or leader row.

For global Organization administrators, the backfill writes the minimal administrator grant. For Economy, it writes only receipt-specific authority records.

The backfill fails when a referenced person, department, team, membership, or payment authority is absent. It does not create placeholder authority.

The backfill output is deterministic for byte-identical input. Stable IDs and stable row order do not depend on bearer-token order.

A later production import requires a separate frozen contract and operator authority. Spec 0054 cannot use disposable backfill evidence as production-import approval.

## Equivalence evidence

The equivalence proof uses current disposable token fixtures as the old behavior oracle. The proof does not add a runtime compatibility path.

For each accepted protected fixture journey, the proof records these facts:

- the old token-derived `PersonId`
- the old actor and scope
- the new session-derived `PersonId`
- the new authority projection
- the new request-specific actor and scope
- the HTTP and domain result

The new path must preserve every old accepted journey. It must also preserve every old role, active-state, and cross-department rejection.

The proof includes persons with these authority shapes:

- one member membership
- one leader membership
- memberships in multiple teams in one department
- memberships in multiple departments
- a global Organization administrator grant
- a department receipt approval grant
- a global receipt approval grant
- multiple payment authorities
- a suspended membership
- an ended membership and grant

The proof includes concurrent revocation and command cases. The observed result must match one valid database order.

The proof fails if two old tokens for one person contain conflicting authority facts. The implementation must not select one token by input order.

### Equivalence falsifier

One counterexample fails the cutover. A counterexample is one current accepted journey that gets a different actor, scope, active state, or result.

A current rejected journey that becomes accepted is also a counterexample. An omitted protected journey is a counterexample.

## Falsifiers

This contract is incomplete if one condition occurs:

- A role, department, membership, approval scope, or payment fact is stored in the `auth` schema.
- A new table copies Organization member or team-leader facts.
- A person with multiple active memberships is reduced to one primary department.
- Profile derives its role from Admission, Recruitment, Receipt, or Identity.
- Economy infers a receipt approval grant from an Organization role.
- Economy copies membership activity instead of reading Organization authority.
- A protected command uses authority facts from an earlier request.
- A revocation that commits before a command can still authorize that command.
- An authenticated person without authority receives 401 instead of a typed 403 denial.
- An empty production projection replaces all accepted protected journeys with denials.
- A bearer-token map remains in production wiring after spec 0054 completes.
- Disposable seed or backfill evidence is presented as production-import approval.
- The equivalence proof omits a currently accepted native journey.

## Evidence plan

The implementation evidence contains these parts:

1. Focused model checks for all actor mappings.
2. PostgreSQL checks for interval boundaries and multi-membership queries.
3. PostgreSQL concurrency checks for grant or membership revocation against a protected command.
4. HTTP checks for 401, 403, multi-department selection, and scope denial.
5. Equivalence evidence for all current Admission, Recruitment, Organization, Receipt, and Profile fixtures.
6. The spec 0054 browser journey with person-keyed authorities and no token-map requests.

PGlite can prove deterministic schema and model behavior. Only PostgreSQL evidence proves the required locking and transaction order.

## Definition of done

1. This frozen contract precedes implementation commits for person-keyed authorization.
2. Spec 0054 records this contract as a mandatory prerequisite before its implementation is complete.
3. Organization persists only the minimal global-administrator grant as new role state.
4. Organization computes a complete, multi-membership person projection from canonical state.
5. Organization, Admission, Recruitment, and Profile map that projection as this contract specifies.
6. Economy persists only receipt-specific payment and approval authority facts.
7. Receipt maps Economy and Organization facts without copied membership state.
8. Every protected adapter resolves the session cookie to `PersonId` before authority resolution.
9. Focused PostgreSQL evidence proves active-at-time and concurrency laws.
10. Disposable seed and backfill evidence satisfies the equivalence contract.
11. No production code reads `*_AUTH_TOKENS` after spec 0054 completes.
12. No production import, production data change, credential change, deployment, or external effect occurs.
13. All existing protected native journeys remain accepted or rejected with equivalent authority.
14. Spec 0054 retains all of its original requirements and falsifiers.

# Design spec 0056 - declarative authorization rules

## Metadata

| Field | Value |
|---|---|
| Goal | Let operators grant surfaced capabilities through persistent rules that inject typed evidence facts into the pure capability algebra |
| Status | Frozen before implementation |
| Base | `dd3aaf67cfaf822abf82d8617bf504f7ca1a0788` |
| Depends on | 0055 person-keyed authorization authorities, 0040 logical capability topology, 0045 Effect Model/Service authority |
| Required by | 0054 native Identity authority via Better Auth |
| Operator boundary | No production import, production data change, credential change, deployment, or external effect |

## Dependency amendment for spec 0054

This contract extends spec 0055. For revisions after `dd3aaf6`, the normative dependency set of spec 0054 includes spec 0055 and this contract.

This dependency does not remove or reduce a requirement in spec 0054 or spec 0055. Identity still owns credentials, sessions, and the authenticated `PersonId` only. Each domain authority still owns its person-keyed facts.

## Problem

Spec 0055 makes every authorization fact a person-keyed record owned by one domain authority. Organization owns memberships and the administrator grant. Economy owns payment and approval authority.

Some legitimate grants have no home in that model:

- a person who approves receipts across departments without an Economy approval row
- an ad hoc delegation of one capability for one recruitment cycle
- a seasonal duty assigned to a changing group of people

Encoding each case as new schema repeats the lossy-role design that spec 0055 removed. Hand-writing a service branch for each case forks authorization logic.

Operators need a way to grant surfaced capabilities to persons or groups as plain data. The grants need time bounds, revision, and removal.

Stored verdicts do not solve this. A persisted `Allow` or `Deny` bypasses the pure capability algebra and becomes a second authorization engine.

## Decision

Authorization rules are database state. Evaluation compiles applicable rules into typed evidence facts of kinds that already exist. The capability functions stay pure. They consume the same evidence shapes with and without rules.

```text
request Cookie
    |
    v
Identity session resolution              (spec 0054)
    |
    v
PersonId + one authorizationInstant      (spec 0055)
    |
    v
authority projections + applicable rules   <- this contract
    |
    v
composed evidence facts
    |
    v
pure capability function -> Decision
```

A rule adds an input to the algebra. It never adds a branch to it. A rule never stores a verdict, a policy expression, or executable logic.

## Rule model

### AuthzRule

An authorization rule has these semantic fields:

- a stable rule ID
- a `capability_id` from the compile-time `CAPABILITY_IDS` registry
- an effect kind: `delegate`, `parameter`, or `requirement`
- one subject: a `PersonId` or a tag ID
- a scope: `Global`, `Department`, or `Receipt`
- a department ID, present when the scope is `Department`
- a `params` JSON value constrained by the target capability slot declarations
- an inclusive `startAt`
- an optional exclusive `endAt`
- a nonnegative revision

The `CAPABILITY_IDS` registry is a compile-time constant. Each entry names one surfaced capability function and declares its rule-receptive evidence slots and parameter slots. A rule can target only a registered capability.

Decode rejects a rule with an unknown capability ID, an unknown scope, an unknown effect kind, or a `params` value that violates the slot declaration. No writer persists such a row.

A rule is active at instant `t` when `startAt <= t` and `t < endAt`. An absent `endAt` means no upper bound.

Unlike a spec 0055 grant, a rule has no overlapping-active constraint. Multiple applicable rules compose.

The scope selects where a rule can apply:

- `Global` applies wherever the capability is reachable.
- `Department` applies only when the request resolves to the rule's department.
- `Receipt` applies to every operation inside the Receipt domain, regardless of department.

The scope gates only the rule. It never replaces the canonical scope selection of spec 0055. An existing receipt still carries its immutable department.

The subject selects whom a rule can apply to:

- a `PersonId` subject applies only for that person
- a tag subject applies only for persons holding an active assignment of that tag at the instant

### Effect kinds

The effect kind states what the rule contributes when it applies:

| Kind | Contribution |
|---|---|
| `delegate` | one authority fact of an existing kind, filling one declared evidence slot |
| `parameter` | one value for one declared parameter slot |
| `requirement` | one typed precondition added to the decision's requirement set |

A `delegate` fact is indistinguishable from a directly held grant of the same kind. The receiving slot decides activity exactly as it does for a direct grant.

### Parameter fills and ambiguity

A `parameter` rule fills exactly one declared parameter slot. Identical fills from multiple rules collapse into one fill.

If two applicable rules fill the same slot with different values in one request, the fill is `Ambiguous`. `Ambiguous` composes to `Deny`. Spec 0055 treats an unresolved selection as ambiguous and rejects it. This contract follows the same law.

### Requirements

A `requirement` rule contributes one typed precondition. The decision keeps its normal outcome only while every composed precondition holds. A failed precondition denies the request.

## Tag model

A tag groups persons for rule targeting. A tag has these semantic fields:

- a stable tag ID
- a unique name
- a nonnegative revision

A tag assignment links one tag to one person:

- a stable assignment ID
- the tag ID
- the `PersonId`
- an inclusive `startAt`
- an optional exclusive `endAt`
- a nonnegative revision

All intervals are half-open, `[startAt, endAt)`. An assignment is inactive at its exact `endAt` value. Ended assignments remain as history.

Detachment ends the assignment interval. Removal deletes the row. Both make the tag inert for that person at the next evaluation.

A tag confers nothing by itself. Only a rule that references the tag has an effect.

## Composition laws

The laws below govern every evaluation.

1. Rules synthesize evidence facts of existing authority kinds only. A rule introduces no new evidence type into the algebra.
2. Every composed requirement must still hold. A rule can add requirements. It cannot remove one.
3. With no applicable rule, the composed evidence equals the direct authority projection of spec 0055. The decision is unchanged.
4. Expired, removed, and tag-detached rules are inert immediately. Evaluation derives applicability from the rows at one `authorizationInstant`. No cache, session state, or earlier projection participates.
5. Command paths evaluate rules inside the same locked transaction as their state transition. Rule rows and tag assignment rows join the spec 0055 lock set. A concurrent rule change and command have one database order.
6. A retry recomputes rule applicability. A retry does not reuse the composed facts of the failed attempt.

## Capability slot declarations

Each capability function declares which evidence slots accept rule-sourced facts. The declaration lives beside the capability's `CAPABILITY_IDS` registry entry and is a compile-time constant.

Initial declarations:

| Capability | Rule-receptive slots | Accepted rule effects |
|---|---|---|
| `approveReceipt` | Economy department approval grant; Economy global receipt approval grant | `delegate` |
| `submitReceipt` | Economy payment authority | `delegate` |
| `reviewApplicants` | none | none |

`approveReceipt` accepts a rule-sourced Economy approval fact. `submitReceipt` accepts a rule-sourced payment authority. `reviewApplicants` accepts no rule-sourced fact initially.

A capability with no receptive slots ignores every rule that names it. An undeclared slot receives no rule fact, even when a rule targets that capability.

New receptive slots require a frozen contract change. They are not operator data.

## Disposable seed and backfill contract

This contract authorizes only disposable local data. It does not authorize a production import or production backfill.

The disposable seed extends the spec 0055 order. It creates these records after the spec 0055 steps:

7. Tags.
8. Tag assignments.
9. Authorization rules.

The backfill input groups rules by subject. It rejects a rule whose subject person, subject tag, or referenced department is absent. It rejects an unknown capability ID before persistence.

The backfill fails when a rule's `params` value violates the target slot declaration. It does not coerce or drop the value.

The backfill output is deterministic for byte-identical input. Stable IDs and stable row order do not depend on input order.

A later production import requires a separate frozen contract and operator authority.

## Equivalence evidence

Spec 0055 remains the old-behavior oracle. With zero applicable rules, every spec 0055 journey keeps its actor, scope, active state, and result.

For each accepted protected fixture journey with rules enabled, the proof records:

- the applicable rules and their subjects
- the composed evidence facts per slot
- the resulting actor, scope, and decision
- the HTTP and domain result

### Equivalence falsifier

One counterexample fails the extension. A counterexample is one spec 0055 journey whose result differs when rules are present, unless a rule legitimately grants the journey through a declared slot.

## Falsifiers

This contract inherits every falsifier in spec 0055. It is incomplete if one more condition occurs:

- An expired, removed, or tag-detached rule changes any Decision.
- A rule produces `Allow` without composing through a declared evidence slot.
- Any writer accepts an unknown capability ID.
- A rule reads or writes the `auth` schema.
- A tag confers Organization or Economy authority without a rule referencing it.

## Evidence plan

The implementation evidence contains these parts:

1. Pure truth tables per capability: direct facts, applicable rules, and the expected Decision, with explicit rule columns for activity, effect kind, subject match, scope match, and slot declaration.
2. Focused model checks for decode rejection of unknown capability IDs, scopes, effect kinds, and invalid `params`.
3. Focused model checks for parameter-fill collapse and `Ambiguous` denial.
4. PostgreSQL checks for half-open interval boundaries on rules and tag assignments at exact `endAt` instants.
5. PostgreSQL concurrency checks for rule expiry, removal, and tag detachment against a protected command.
6. HTTP checks for 401 and for 403 denials with stable reason tags: missing authority, inactive actor, ambiguous parameter fill, and failed composed requirement.
7. Zero-rule equivalence evidence for all spec 0055 Admission, Recruitment, Organization, Receipt, and Profile fixtures.
8. The spec 0054 browser journey with rules present and no behavioral change.

PGlite can prove deterministic schema and model behavior. Only PostgreSQL evidence proves the required locking and transaction order.

## Definition of done

1. This frozen contract precedes implementation commits for declarative authorization rules.
2. Spec 0054 records spec 0055 and this contract as mandatory prerequisites before its implementation is complete.
3. Authorization rules persist as database state with exactly the specified semantic fields and no verdict column.
4. Every rule capability ID comes from the compile-time `CAPABILITY_IDS` registry; decoders and writers reject unknown IDs and scopes.
5. Each protected capability function declares its rule-receptive slots; undeclared slots receive no rule-sourced facts.
6. Rules synthesize only evidence facts of existing authority kinds; every composed requirement holds in each accepted decision.
7. Expired, removed, and tag-detached rules are inert at every evaluation instant.
8. Protected commands evaluate rules inside the same locked transaction as spec 0055.
9. Conflicting parameter fills deny as `Ambiguous` with a typed 403 denial.
10. Tags confer nothing outside rules; Organization and Economy authority remain person-keyed direct facts.
11. Rules and tags touch no `auth` schema table.
12. Disposable seed and backfill evidence satisfies the determinism and rejection contract.
13. The evidence plan is complete, including truth tables with rule columns, PostgreSQL interval and concurrency checks, and HTTP reason-tag checks.
14. Zero-rule behavior is equivalent to spec 0055 outcomes, and no production import, production data change, credential change, deployment, or external effect occurs.

# SDK State Domain Analysis — PDDL → TypeScript

Companion to `2026-03-20-sdk-pddl-domain.pddl`. Explains the domain model
and how PDDL preconditions translate to SDK type-level constraints.

## What the PDDL captures

The domain models **4 state machines** and **1 CRUD domain**:

| Domain | Type | States | Actions | Complexity |
|--------|------|--------|---------|------------|
| Application | Computed DAG | 7 (derived from Interview + User) | 3 | High — status is a projection |
| Interview | Product type (Scheduling × Completion) | 5 × 3 = 15 (7 reachable) | 11 | High — reschedule cycle, dual dimensions |
| Receipt | Simple DAG | 3 | 3 | Low — no cycles, terminal states |
| Membership | 3 independent booleans | 2³ = 8 combinations | 7 | Medium — independent dimensions |
| Survey | CRUD | No state machine | Standard CRUD | Low — role-gated only |

## Key design insights from the contracts

### 1. Application status is computed, not stored

The database has no `status` column. Status is derived:

```
status(app) = f(app.interview, app.user.assistantHistories)
```

This means the SDK must either:
- **(A)** Compute status client-side from the API response (replicate PHP logic)
- **(B)** Have the API return a computed `status` field (recommended)

The PDDL models the computed status as `app-has-status` predicates, but
preconditions on actions reference the derived state, not raw fields.

**SDK implication:** The Application type should be a discriminated union on
computed status. Available actions change per status variant.

### 2. Interview has two orthogonal dimensions

```
InterviewState = SchedulingStatus × CompletionStatus
```

Not all combinations are reachable. The PDDL encodes this via preconditions —
e.g., `conduct-interview` requires both `accepted-interview` scheduling AND
`not-conducted` completion.

**SDK implication:** Model as a product type with runtime validation, or flatten
to the 7 reachable combined states as a discriminated union.

### 3. Receipt is trivially simple

```
pending → refunded | rejected
```

Both transitions are terminal. No cycles.

**SDK implication:** Three-variant discriminated union. `approve()` and
`reject()` only available on `pending` variant.

### 4. Membership dimensions are independent

```
MembershipState = Active × Suspended × Leader
```

Unlike the other domains, these dimensions don't form a state machine — they're
independent toggles with ordering constraints (must demote before suspending a
leader).

**SDK implication:** Three boolean flags with action guards, not a discriminated
union. Use conditional types or runtime checks.

## PDDL → TypeScript type mapping

### Pattern: Discriminated union with action methods

Each PDDL state becomes a variant. Each PDDL action becomes a method available
only on the variants whose preconditions it satisfies.

```typescript
// Receipt — simplest example
type Receipt =
  | { status: "pending"; approve(): Promise<Receipt>; reject(): Promise<Receipt> }
  | { status: "refunded"; readonly refundDate: Date }
  | { status: "rejected" };
```

The `approve()` and `reject()` methods exist only on the `pending` variant.
TypeScript's type narrowing ensures you can't call `approve()` on a
`refunded` receipt.

### Pattern: Computed status projection

```typescript
// Application — status derived from Interview + User state
type Application =
  | { status: "not-received" }
  | { status: "received"; assignInterview(): Promise<Application> }
  | { status: "invited"; interview: PendingInterview }
  | { status: "accepted"; interview: AcceptedInterview }
  | { status: "completed"; interview: ConductedInterview; assignToSchool(): Promise<Application> }
  | { status: "assigned"; readonly user: ActiveAssistant }
  | { status: "cancelled"; interview: CancelledInterview };
```

The SDK computes status from the API response and returns the appropriate
variant. Actions are only available on valid states.

### Pattern: Product type with guards

```typescript
// Interview — two independent dimensions
type Interview = {
  scheduling: SchedulingStatus;
  completion: CompletionStatus;
  // Actions available based on combined state:
  schedule: scheduling extends "no-contact" ? () => Promise<Interview> : never;
  accept: scheduling extends "pending" ? () => Promise<Interview> : never;
  conduct: scheduling extends "accepted" & completion extends "not-conducted"
    ? (score: Score, answers: Answer[]) => Promise<Interview>
    : never;
  // etc.
};
```

In practice, this is better expressed as a flattened union of reachable states:

```typescript
type Interview =
  | { state: "unconfirmed"; scheduling: "no-contact"; schedule(): Promise<Interview> }
  | { state: "pending"; scheduling: "pending"; /* applicant actions via response code */ }
  | { state: "accepted"; scheduling: "accepted"; conduct(s: Score, a: Answer[]): Promise<Interview> }
  | { state: "reschedule-requested"; scheduling: "request-new-time"; reschedule(): Promise<Interview> }
  | { state: "conducted"; completion: "conducted"; readonly score: Score }
  | { state: "cancelled"; scheduling: "cancelled" };
```

### Pattern: Independent dimensions with ordering constraints

```typescript
// Membership — three independent toggles
type Membership = {
  active: boolean;        // temporal (computed from semester range)
  suspended: boolean;     // toggle
  leader: boolean;        // flag

  // Actions gated by combined state:
  suspend(): this["suspended"] extends false
    ? this["leader"] extends false   // must demote first
      ? Promise<Membership>
      : never
    : never;

  promote(): this["active"] extends true
    ? this["suspended"] extends false
      ? Promise<Membership>
      : never
    : never;
};
```

## Auth predicates → SDK middleware

The PDDL models auth as predicates:

```
(actor-in-department ?d)
(actor-has-role ?r)
(actor-is-admin)
```

These don't become type constraints — they become runtime middleware:

1. **Role check:** SDK fetches user role on init. Actions requiring elevated
   roles are hidden from the UI (but still enforced server-side).
2. **Department scoping:** SDK filters entities to the user's department by
   default. Admin users see all departments.

```typescript
type SdkContext = {
  role: RoleLevel;
  departmentId: number | null;  // null = admin, sees all
};
```

## Invariants the SDK should enforce

From `implicit-invariants.md`, these should be enforced client-side:

| ID | Rule | SDK enforcement |
|----|------|-----------------|
| APP-1 | One application per user per period | Check before showing "Apply" button |
| APP-2 | Application must have admission period | Required field in create form |
| INTERVIEW-1 | Score required when conducting | Form validation on conduct action |
| INTERVIEW-6 | Schema required before conduct | Disable conduct button if no schema |
| RECEIPT-1 | Only pending→refunded/rejected | Type narrowing (discriminated union) |
| DATA-7 | startDate < endDate on periods | Form validation |
| DATA-9 | Non-negative school capacity | Form validation |

## What the PDDL does NOT model

- **Bulk operations** (bulk assign interviews) — modeled as repeated single actions
- **Side effects** (email notifications, Slack messages) — server-side concerns
- **Temporal logic** (semester ranges, date comparisons) — requires PDDL 2.2+
- **Pagination/filtering** — read operations, not state transitions
- **File uploads** (receipts, profile photos) — orthogonal to state
- **Survey response collection** — CRUD, no state machine

## Next steps

1. Validate PDDL actions against actual API endpoints (1:1 mapping check)
2. Decide: computed status client-side vs server-side `status` field
3. Design TypeScript discriminated unions for Application and Interview
4. Implement SDK wrapper that returns typed state objects from API responses
5. Add runtime role/department gating to SDK context

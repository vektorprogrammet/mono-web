# Team Membership Contract

Membership state is a combination of an explicit boolean (`isSuspended`) and temporal logic (start/end semester). A membership is "active" only when both conditions are met.

## State space

```
Active(m, now) ≡ ¬m.isSuspended
                ∧ m.startSemester.startDate ≤ now
                ∧ (m.endSemester = null ∨ now ≤ m.endSemester.endDate)
```

## Transitions

| Precondition | Operation | Postcondition |
|---|---|---|
| `user ≠ null ∧ team ≠ null ∧ startSemester ≠ null` | `CreateMembership(user, team, start)` | `m.isSuspended = false ∧ m.endSemester = null ∧ Active(m, now) iff start.startDate ≤ now` |
| `Active(m, now)` | `Suspend(m)` | `m.isSuspended = true ∧ ¬Active(m, now)` |
| `m.isSuspended = true` | `Unsuspend(m)` | `m.isSuspended = false ∧ Active(m, now) iff temporal condition holds` |
| `Active(m, now)` | `EndMembership(m, endSemester)` | `m.endSemester = endSemester ∧ (endSemester.endDate < now → ¬Active(m, now))` |
| `m.isTeamLeader = false` | `PromoteToLeader(m)` | `m.isTeamLeader = true` |
| `m.isTeamLeader = true` | `DemoteFromLeader(m)` | `m.isTeamLeader = false` |

## Invariants

1. **Temporal ordering:** `m.endSemester ≠ null → m.endSemester ≥ m.startSemester`.
2. **Leader requires active:** `m.isTeamLeader = true → Active(m, now)` (enforced by business logic, not DB constraint).
3. **Suspension is reversible:** Unlike `CANCELLED` in other domains, suspension can be toggled.

## User activation contract

User account activation is a separate toggle:

| Precondition | Operation | Postcondition |
|---|---|---|
| `user.isActive = true` | `Deactivate(user)` | `user.isActive = false` (locked out of all routes) |
| `user.isActive = false` | `Activate(user)` | `user.isActive = true` |

### Role hierarchy

```
USER < TEAM_MEMBER < TEAM_LEADER < ADMIN
```

Linear hierarchy. Each level includes all permissions of levels below it. Roles are assigned via the `roles` many-to-many relation on User.

## Implementation notes

- Temporal activation means the dashboard must know the current semester to correctly display active vs inactive memberships.
- Suspension + temporal end = two independent ways a membership becomes inactive. The UI should distinguish these (suspended shows "paused", ended shows "former member").
- `deletedTeamName` caches the team name if the team entity is later deleted — display this for historical memberships.

# Team Membership Contract

Membership state has three independent dimensions: suspension, temporal range, and position. The code's `isActive()` method checks only the temporal dimension — suspension is a separate concern checked independently by callers.

## State space

### Temporal activation (what `isActive()` checks)

```
TemporallyActive(m, semester) =
    semester.startDate >= m.startSemester.startDate
    AND (m.endSemester = null OR semester.endDate <= m.endSemester.endDate)
```

The `semester` parameter comes from `team.department.getCurrentOrLatestAdmissionPeriod().getSemester()` — not from `now()`. This is semester containment, not point-in-time comparison.

### Suspension (separate dimension)

```
isSuspended: boolean (default false)
```

**Important:** `isActive()` does NOT check `isSuspended`. A suspended member can be "active" by `isActive()`. The UI must check both dimensions independently:
- Temporally active AND not suspended = **active member**
- Temporally active AND suspended = **paused** (show "suspended" badge)
- Not temporally active = **former member** (regardless of suspension)

## Transitions

| Operation | Guard | Effect | Constraint |
|---|---|---|---|
| `CreateMembership(user, team, start, position)` | `user != null, team != null, startSemester != null, position != null` | `isSuspended = false, endSemester = null, isTeamLeader = false` | **Position required:** every membership has a `Position`. |
| `Suspend(m)` | `isSuspended = false` | `isSuspended = true` | **Leader implies active:** callers must demote before suspending a leader. Not auto-enforced. |
| `Unsuspend(m)` | `isSuspended = true` | `isSuspended = false` | |
| `EndMembership(m, endSemester)` | *(no guard — simple setter)* | `m.endSemester = endSemester` | **Temporal ordering:** `endSemester >= startSemester`. **Leader implies active:** callers must demote before ending a leader's membership. |
| `PromoteToLeader(m)` | `isTeamLeader = false` | `isTeamLeader = true` | **Leader implies active:** member should be temporally active and not suspended. Not enforced by DB or entity. |
| `DemoteFromLeader(m)` | `isTeamLeader = true` | `isTeamLeader = false` | |

**Suspension is reversible:** Unlike `CANCELLED` in other domains, suspension can be toggled freely.

## Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `startSemester` | Semester | yes | When membership began |
| `endSemester` | Semester? | no | When membership ended (null = indefinite) |
| `isSuspended` | boolean | yes (default false) | Paused membership |
| `isTeamLeader` | boolean | yes (default false) | Leadership flag |
| `position` | Position | yes (NotNull) | Role/position within the team |
| `deletedTeamName` | string? | no | Cached team name if team entity is deleted |

## User activation contract

User account activation is a separate toggle (simple `setActive()` on User, no guards):

| Operation | Guard | Effect |
|---|---|---|
| `Deactivate(user)` | `user.isActive = true` | `user.isActive = false` (locked out of all routes) |
| `Activate(user)` | `user.isActive = false` | `user.isActive = true` |

### Role hierarchy

```
ROLE_USER (assistant) < TEAM_MEMBER < TEAM_LEADER < ADMIN
```

Linear hierarchy. Each level includes all permissions of levels below it. Roles are assigned via the `roles` many-to-many relation on User. PHP constants in `Roles.php`.

## Implementation notes

- The dashboard needs the current semester to display active vs inactive memberships. Use `GET /api/admin/semesters` to find the current one, or derive from the department's latest admission period.
- Suspension + temporal end = two independent ways a membership becomes inactive. The UI should distinguish these (suspended shows "paused", ended shows "former member").
- `deletedTeamName` caches the team name if the team entity is deleted — display this for historical memberships.
- `isActive()` crashes if the team's department has no admission periods (null dereference in the chain `team.department.getCurrentOrLatestAdmissionPeriod().getSemester()`). The dashboard should handle this gracefully.

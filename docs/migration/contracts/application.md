# Application Lifecycle Contract

The application's status is **computed**, not stored. It's derived from the state of the linked Interview entity and the User's assistant history. This means the "state machine" is really a projection over multiple entities.

## State space

```
S = { NOT_RECEIVED, RECEIVED, INVITED, ACCEPTED, COMPLETED, ASSIGNED, CANCELLED }
```

PHP constants use longer names: `APPLICATION_NOT_RECEIVED(0)`, `APPLICATION_RECEIVED(1)`, `INVITED_TO_INTERVIEW(2)`, `INTERVIEW_ACCEPTED(3)`, `INTERVIEW_COMPLETED(4)`, `ASSIGNED_TO_SCHOOL(5)`, `CANCELLED(-1)`. See `ApplicationStatus.php`.

## State derivation

Evaluated top-to-bottom; first match wins.

```
status(app) =
  | ASSIGNED            if app.user.isActiveAssistant()
  | COMPLETED           if app.user.hasBeenAssistant() OR app.interview?.interviewed
  | if app.interview != null:
      match interview.interviewStatus:
        | ACCEPTED        -> ACCEPTED
        | CANCELLED       -> CANCELLED
        | PENDING         -> INVITED
        | NO_CONTACT      -> RECEIVED
        | REQUEST_NEW_TIME -> RECEIVED
  | RECEIVED            if app.admissionPeriod != null
  | NOT_RECEIVED        otherwise
```

`ASSIGNED` and `COMPLETED` are checked first — they override any interview state because they check user-level properties. `CANCELLED` is inside the match block, not a top-level override: an active assistant with a cancelled interview still shows `ASSIGNED`.

## Transition graph

```
NOT_RECEIVED -> RECEIVED -> [SendConfirmation] -> INVITED -> ACCEPTED -> COMPLETED -> ASSIGNED
                   ^                                  |
                   |                              CANCELLED
                   |
            AssignInterview (status stays RECEIVED until confirmation sent)
```

No cycles. `CANCELLED` is terminal. `ASSIGNED` is the goal state.

## Transitions

| Operation | Guard | Effect | Constraint |
|---|---|---|---|
| `CreateApplication(user, admissionPeriod)` | `user != null, admissionPeriod.isActive(), no existing app for this user+period` | `app.interview = null, status = RECEIVED` | **Uniqueness:** one per user+period. Enforced by email check (`ApplicationAdmission`), not DB constraint — race conditions possible. |
| `AssignInterview(app, interview)` | `status = RECEIVED, app.interview = null, interview.scheduled != null, interview.interviewer != null` | `app.interview = interview. Status remains RECEIVED (interview starts at NO_CONTACT). Becomes INVITED only after SendConfirmation sets interviewStatus to PENDING.` | **Interview coupling:** `status in {INVITED, ACCEPTED, COMPLETED}` implies `interview != null`. |
| `AcceptInterview(app.interview)` | `status = INVITED, interview.interviewStatus = PENDING, request.code = interview.responseCode` | `interview.interviewStatus = ACCEPTED, status = ACCEPTED` | |
| `ConductInterview(interview, score, answers)` | `status = ACCEPTED, interview.interviewed = false, all score fields non-null (explanatoryPower, roleModel, suitability, suitableAssistant)` | `interview.interviewed = true, interview.conducted = now(), status = COMPLETED` | **Score completeness:** `interviewed = true` implies all four score fields non-null. |
| `AssignToSchool(user, school, semester, workdays, bolk)` | `status = COMPLETED, school != null, semester.isActive(), no existing assignment for user+school+semester` | `AssistantHistory created, user.isActiveAssistant() = true, status = ASSIGNED` | **User override:** `isActiveAssistant()` forces `ASSIGNED` regardless of interview state — retroactive. |
| `Cancel(app.interview)` | `interview != null, interview.interviewed = false` | `interview.interviewStatus = CANCELLED, status = CANCELLED` | |

**Returning assistants:** `createApplicationForExistingAssistant()` creates an application and attaches the user's last interview from a previous cycle, bypassing the normal flow. If the old interview was `CANCELLED`, the new application inherits that status.

**Monotonicity:** Under normal flow, status only increases (`NOT_RECEIVED < RECEIVED < ... < ASSIGNED`). Exception: `CANCELLED` is reachable from `INVITED` or `ACCEPTED`.

## Implementation notes

- Status is computed in `ApplicationManager::getApplicationStatus()`, not stored in the database.
- The dashboard must replicate this computation client-side, or the API must expose a computed `status` field in the response. Recommend: API returns computed status as a read-only field.
- Cancel in the API/applicant path requires `PENDING` interview status. The admin legacy controller has no guard — it cancels from any state.

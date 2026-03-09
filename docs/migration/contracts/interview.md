# Interview Lifecycle Contract

The interview has an explicit `interviewStatus` field (integer) and a separate `interviewed` boolean. Together these define two orthogonal state dimensions: scheduling status and completion status.

## State space

### Scheduling status

```
SchedulingStatus = { PENDING(0), ACCEPTED(1), REQUEST_NEW_TIME(2), CANCELLED(3), NO_CONTACT(4) }
```

See `InterviewStatusType.php` for canonical values. Note the non-sequential ordering — `NO_CONTACT` is 4 (highest), `PENDING` is 0 (default). These integer values are stored in the database.

### Completion

```
Completion = { not_conducted, draft, conducted }
  where conducted  = (interviewed = true)
        draft      = (interviewed = false AND interviewScore != null)
```

The `draft` state means an interviewer saved scores without finalizing. The entity method `isDraft()` checks this condition.

### Combined state

```
State = SchedulingStatus x Completion
```

Not all combinations are reachable. Valid states:

| SchedulingStatus | Completion | Meaning |
|-----------------|------------|---------|
| NO_CONTACT | not_conducted | Created, no confirmation sent |
| PENDING | not_conducted | Confirmation sent, awaiting response |
| ACCEPTED | not_conducted | Applicant confirmed, interview upcoming |
| ACCEPTED | draft | Scores saved but not finalized |
| ACCEPTED | conducted | Interview completed and scored |
| REQUEST_NEW_TIME | not_conducted | Applicant requested reschedule |
| CANCELLED | not_conducted | Interview cancelled |

## Transition graph

```
NO_CONTACT --> PENDING --> ACCEPTED --> CONDUCTED (terminal)
    |            |  ^          |
    |            |  |          v
    |            |  +-- REQUEST_NEW_TIME
    |            |
    +--+---------+----------> CANCELLED
       |                         | (internal only: setCancelled(false)
       |                         v  reverts to ACCEPTED — not user-facing)
       +-- any non-conducted state can reach CANCELLED via admin cancel
```

The `PENDING <-> REQUEST_NEW_TIME` loop is the **reschedule cycle**.

## Transitions

| Operation | Guard | Effect | Constraint |
|---|---|---|---|
| `SendConfirmation(interview)` | `interviewStatus = NO_CONTACT, scheduled != null, interviewer != null, responseCode != null` | `interviewStatus = PENDING, confirmation email sent` | **Response code immutability:** `responseCode` set once at creation, never changes. |
| `AcceptInterview()` | `interviewStatus = PENDING, request.code = responseCode` | `interviewStatus = ACCEPTED` | |
| `RequestNewTime()` | `interviewStatus = PENDING, request.code = responseCode` | `interviewStatus = REQUEST_NEW_TIME` | |
| `Reschedule(interview, newScheduled)` | `interviewStatus = REQUEST_NEW_TIME, newScheduled != null` | `interviewStatus = PENDING, scheduled = newScheduled, lastScheduleChanged = now()` | |
| `Cancel()` — API/applicant | `interviewStatus = PENDING, interviewed = false` | `interviewStatus = CANCELLED` | |
| `Cancel()` — admin legacy | `interviewed = false (no status guard)` | `interviewStatus = CANCELLED` | |
| `Conduct(interview, score, answers)` | `interviewStatus = ACCEPTED` *(intended, not enforced in code)*, `interviewed = false, all score fields non-null (explanatoryPower, roleModel, suitability, suitableAssistant), len(answers) = len(interviewSchema.questions)` | `interviewed = true, conducted = now(), interviewScore = score, interviewAnswers = answers` | **Score completeness:** `interviewed = true` implies all four score fields non-null. |
| `SaveDraft(interview, score)` | `interviewed = false, score != null` | `interviewScore = score, interviewed remains false (isDraft() = true)` | |

**Schedule/reschedule:** Both use `resetStatus()` which sets `interviewStatus = PENDING` unconditionally — no guard checking current status. The `NO_CONTACT -> PENDING` distinction exists only in the SendConfirmation workflow.

## Reminder contract

Backend scheduler concern — not a dashboard feature.

| Operation | Guard | Effect | Constraint |
|---|---|---|---|
| `SendReminder(interview)` | `interviewStatus = PENDING, numAcceptInterviewRemindersSent < 3, now() - lastScheduleChanged > 24h` | `numAcceptInterviewRemindersSent += 1, email sent (+ SMS if scheduled - now() < 24h)` | **Reminder cap:** `<= 3` (enforced by caller, not entity). |

## Code divergences from expected behavior

These are NOT enforced in the current codebase. The dashboard should decide per-case whether to add enforcement or match existing behavior:

- **No `interviewStatus` guard on conduct.** Any scheduling status can be conducted. Intended: only `ACCEPTED`.
- **Reschedule does not reset reminders.** Neither `setScheduled()` nor `resetStatus()` touches `numAcceptInterviewRemindersSent`.
- **`CANCELLED` is reversible.** `setCancelled(false)` calls `acceptInterview()`, setting status to `ACCEPTED`. Used internally before conducting a previously-cancelled interview. Not user-facing.
- **`setStatus()` bypass.** Allows setting any integer value 0-4 directly, bypassing transition methods.

## Implementation notes

- The reschedule cycle means the UI must handle re-entry: same interview goes `PENDING -> REQUEST_NEW_TIME -> PENDING -> ...` potentially multiple times.
- The `responseCode` in confirmation emails allows unauthenticated status changes. The dashboard must not expose this code — it's for email links only.
- SMS vs email for reminders depends on `interview.scheduled - now() < 24h`. The dashboard doesn't need to implement this — it's a backend scheduler concern.
- `Interview::__construct()` sets `conducted = new DateTime()` at creation time. This is likely a legacy artifact — don't rely on this field until `interviewed = true`.

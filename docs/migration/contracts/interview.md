# Interview Lifecycle Contract

The interview has an explicit `interviewStatus` field (integer) and a separate `interviewed` boolean. Together these define two orthogonal state dimensions: scheduling status and completion status.

## State space

### Scheduling status

```
SchedulingStatus = { NO_CONTACT(0), PENDING(4), ACCEPTED(1), REQUEST_NEW_TIME(2), CANCELLED(3) }
```

### Completion

```
Completion = { not_conducted, conducted }
  where conducted ≡ (interviewed = true)
```

### Combined state

```
State = SchedulingStatus × Completion
```

Not all combinations are reachable. Valid states:

| SchedulingStatus | Completion | Meaning |
|-----------------|------------|---------|
| NO_CONTACT | not_conducted | Created, no confirmation sent |
| PENDING | not_conducted | Confirmation sent, awaiting response |
| ACCEPTED | not_conducted | Applicant confirmed, interview upcoming |
| ACCEPTED | conducted | Interview completed and scored |
| REQUEST_NEW_TIME | not_conducted | Applicant requested reschedule |
| CANCELLED | not_conducted | Interview cancelled |

## Transition graph

```
                    ┌─────────────────────────────┐
                    │                             │
                    v                             │
NO_CONTACT ──→ PENDING ──→ ACCEPTED ──→ CONDUCTED (terminal)
                  │  ↑          │
                  │  │          v
                  │  └── REQUEST_NEW_TIME
                  │
                  v
              CANCELLED (terminal)
```

The `PENDING ↔ REQUEST_NEW_TIME` loop is the **reschedule cycle**. An applicant can request a new time, admin reschedules, status resets to PENDING. This can repeat.

## Transitions as Hoare triples

### Send confirmation

```
{interview.interviewStatus = NO_CONTACT
 ∧ interview.scheduled ≠ null
 ∧ interview.interviewer ≠ null
 ∧ interview.responseCode ≠ null}

SendConfirmation(interview)

{interview.interviewStatus = PENDING
 ∧ confirmationEmail.sent = true}
```

### Accept (by applicant)

Triggered via email link with response code.

```
{interview.interviewStatus = PENDING
 ∧ request.code = interview.responseCode}

interview.acceptInterview()

{interview.interviewStatus = ACCEPTED}
```

### Request new time (by applicant)

```
{interview.interviewStatus = PENDING
 ∧ request.code = interview.responseCode}

interview.requestNewTime()

{interview.interviewStatus = REQUEST_NEW_TIME}
```

### Reschedule (by admin)

This is the cycle entry point. Admin sets new datetime, resets status.

```
{interview.interviewStatus = REQUEST_NEW_TIME
 ∧ newScheduled ≠ null}

Reschedule(interview, newScheduled)

{interview.scheduled = newScheduled
 ∧ interview.interviewStatus = PENDING
 ∧ interview.lastScheduleChanged = now()
 ∧ interview.numAcceptInterviewRemindersSent = 0}
```

### Cancel

```
{interview.interviewStatus ∈ {NO_CONTACT, PENDING, ACCEPTED, REQUEST_NEW_TIME}
 ∧ interview.interviewed = false}

interview.cancel()

{interview.interviewStatus = CANCELLED}
```

### Conduct interview

```
{interview.interviewStatus = ACCEPTED
 ∧ interview.interviewed = false
 ∧ score.explanatoryPower ≠ null
 ∧ score.roleModel ≠ null
 ∧ score.suitability ≠ null
 ∧ |answers| = |interview.interviewSchema.questions|}

Conduct(interview, score, answers)

{interview.interviewed = true
 ∧ interview.conducted = now()
 ∧ interview.interviewScore = score
 ∧ interview.interviewAnswers = answers}
```

## Reminder contract

Reminders are sent to applicants who haven't responded to confirmation.

```
{interview.interviewStatus = PENDING
 ∧ interview.numAcceptInterviewRemindersSent < 3
 ∧ now() - interview.lastScheduleChanged > 24h}

SendReminder(interview)

{interview.numAcceptInterviewRemindersSent' = interview.numAcceptInterviewRemindersSent + 1
 ∧ (interview.scheduled - now() < 24h → sms.sent = true)
 ∧ email.sent = true}
```

## Invariants

1. **Response code immutability:** `responseCode` is set once at creation (random hex), never changes.
2. **Reminder cap:** `numAcceptInterviewRemindersSent <= 3`.
3. **Conducted gate:** `interviewed = true` only reachable from `interviewStatus = ACCEPTED`.
4. **Score completeness:** `interviewed = true → interviewScore ≠ null ∧ all score fields ≠ null`.
5. **Reschedule resets reminders:** Rescheduling zeroes the reminder counter.
6. **Terminal states:** `CANCELLED` and `conducted` are absorbing — no transitions out.

## Implementation notes

- The reschedule cycle means the UI must handle re-entry: same interview goes PENDING → REQUEST_NEW_TIME → PENDING → ... potentially multiple times.
- The `responseCode` in confirmation emails allows unauthenticated status changes. The dashboard must not expose this code — it's for email links only.
- SMS vs email for reminders depends on `interview.scheduled - now() < 24h`. The dashboard doesn't need to implement this — it's a backend scheduler concern.

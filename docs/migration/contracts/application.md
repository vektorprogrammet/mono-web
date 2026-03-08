# Application Lifecycle Contract

The application's status is **computed**, not stored. It's derived from the state of the linked Interview entity and the User's assistant history. This means the "state machine" is really a projection over multiple entities.

## State space

```
S = { NOT_RECEIVED, RECEIVED, INVITED, ACCEPTED, COMPLETED, ASSIGNED, CANCELLED }
```

## State derivation

```
status(app) =
  | CANCELLED           if app.interview?.isCancelled()
  | ASSIGNED            if app.user.isActiveAssistant()
  | COMPLETED           if app.user.hasBeenAssistant() ∨ app.interview?.interviewed
  | ACCEPTED            if app.interview?.interviewStatus = ACCEPTED
  | INVITED             if app.interview ≠ null
  | RECEIVED            if app.admissionPeriod ≠ null
  | NOT_RECEIVED        otherwise
```

Evaluated top-to-bottom; first match wins. Note: `ASSIGNED` and `COMPLETED` can override any interview state because they check user-level properties.

## Transition graph (DAG)

```
NOT_RECEIVED → RECEIVED → INVITED → ACCEPTED → COMPLETED → ASSIGNED
                                         ↓
                                     CANCELLED
```

No cycles. `CANCELLED` is a terminal state. `ASSIGNED` is the goal state.

## Transitions as Hoare triples

### Create application

```
{user ≠ null
 ∧ admissionPeriod.isActive()
 ∧ ¬∃ app' : app'.user = user ∧ app'.admissionPeriod = admissionPeriod}

CreateApplication(user, admissionPeriod)

{app.user = user
 ∧ app.admissionPeriod = admissionPeriod
 ∧ app.interview = null
 ∧ status(app) = RECEIVED}
```

### Assign interview

```
{status(app) = RECEIVED
 ∧ app.interview = null
 ∧ interview.scheduled ≠ null
 ∧ interview.interviewer ≠ null}

AssignInterview(app, interview)

{app.interview = interview
 ∧ status(app) = INVITED}
```

### Interview accepted (by applicant)

Triggered when applicant responds to confirmation email.

```
{status(app) = INVITED
 ∧ app.interview.interviewStatus ∈ {NO_CONTACT, PENDING}}

app.interview.acceptInterview()

{app.interview.interviewStatus = ACCEPTED
 ∧ status(app) = ACCEPTED}
```

### Conduct interview

```
{status(app) = ACCEPTED
 ∧ app.interview.interviewStatus = ACCEPTED
 ∧ app.interview.interviewed = false
 ∧ score.explanatoryPower ≠ null
 ∧ score.roleModel ≠ null
 ∧ score.suitability ≠ null}

ConductInterview(app.interview, score, answers)

{app.interview.interviewed = true
 ∧ app.interview.interviewScore = score
 ∧ app.interview.interviewAnswers = answers
 ∧ status(app) = COMPLETED}
```

### Assign to school

```
{status(app) = COMPLETED
 ∧ school ≠ null
 ∧ semester.isActive()
 ∧ ¬∃ ah : ah.user = app.user ∧ ah.semester = semester ∧ ah.school = school}

AssignToSchool(app.user, school, semester, workdays, bolk)

{∃ ah : ah.user = app.user ∧ ah.school = school ∧ ah.semester = semester
 ∧ app.user.isActiveAssistant() = true
 ∧ status(app) = ASSIGNED}
```

### Cancel

```
{status(app) ∈ {INVITED, ACCEPTED}
 ∧ app.interview ≠ null
 ∧ ¬app.interview.interviewed}

app.interview.cancel()

{app.interview.interviewStatus = CANCELLED
 ∧ status(app) = CANCELLED}
```

## Invariants

1. **Uniqueness:** At most one application per user per admission period.
2. **Interview coupling:** `status ∈ {INVITED, ACCEPTED, COMPLETED}` implies `app.interview ≠ null`.
3. **Score completeness:** `interview.interviewed = true` implies all three score fields are non-null.
4. **Monotonicity:** Under normal flow, status only increases (NOT_RECEIVED < RECEIVED < ... < ASSIGNED). Exception: CANCELLED is reachable from INVITED or ACCEPTED.
5. **User override:** `user.isActiveAssistant()` forces ASSIGNED regardless of interview state. This means creating an AssistantHistory record changes the application status retroactively.

## Implementation notes

- Status is computed in `ApplicationManager::getApplicationStatus()`, not stored in the database.
- The dashboard must replicate this computation client-side, or the API must expose a computed `status` field in the response.
- Recommend: API returns computed status as a read-only field alongside the raw entity data.

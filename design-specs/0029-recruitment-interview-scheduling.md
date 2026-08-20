# Goal-1 design spec 0029 - recruitment interview scheduling

> **Summary:** An authorized team member schedules an assigned interview. The dashboard uses the real Symfony server and shows the stored schedule after a fresh read.

## Metadata

| Field | Value |
|---|---|
| Goal | Goal-1 recruitment capability slice |
| Lifecycle state | Frozen |
| User role | Team member or team leader |
| Dependency | Recruitment assignment at `95fc81dff77f159d4bc67ba7e6a4732ee7ed5427` |
| Journey authority | Pending accepted-intent revision |

## User journey

1. The user signs in.
2. The dashboard loads assigned interviews from the real Symfony server.
3. The user opens one assigned interview.
4. The user enters the interview time, room, campus, map link, sender, recipient, and message.
5. The user submits the schedule.
6. The Symfony server stores the schedule and creates the candidate response capability.
7. The dashboard performs a new server read.
8. The dashboard shows the stored time, room, campus, and pending response status.

## Constraints

- The browser must use the React dashboard and the Foldkit interview model.
- The dashboard must use the TypeScript SDK.
- The server operation is `POST /api/admin/interviews/{id}/schedule`.
- The request uses `datetime`, not `interviewTime`.
- The request contains all fields required by the schedule event.
- The implementation must remove the nonexistent `/assigned` SDK operations and migrate every caller.
- The server and browser gate must use deterministic non-production data.
- The browser gate must not contact live email or SMS providers.
- The final observation must come from a new server read.
- Candidate acceptance, cancellation, and new-time requests are separate journeys.

## Definition of done

The slice is complete when all these statements are true:

- An authorized user can load an assigned interview from Symfony.
- The schedule form validates every required field before it sends a request.
- A valid submission receives the Symfony success response.
- A new read shows the stored schedule and pending response status.
- An invalid date produces a validation error and no database change.
- A user without access cannot read or schedule the interview.
- The local proof captures the notification effect without external delivery.
- The SDK type check, lint check, and unit tests pass.
- The dashboard type check, lint check, and unit tests pass.
- The real Symfony browser journey passes against a disposable database.

## Falsifiers

The slice is not complete if one of these conditions occurs:

- The dashboard uses the synthetic interview fixture as acceptance evidence.
- The SDK calls a route that Symfony does not expose.
- The SDK sends `PUT` or the `interviewTime` field.
- The dashboard reports success without a fresh server read.
- The schedule omits data that the notification effect requires.
- The browser gate can send a live notification.
- A failed schedule request changes the database.

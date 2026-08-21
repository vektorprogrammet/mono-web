# Goal-1 design spec 0031 - recruitment invitation response

> **Summary:** An applicant opens a scheduled interview invitation. The applicant confirms, rejects, or requests another time. The team leader and interviewer see the stored response after fresh reads.

## Metadata

| Field | Value |
|---|---|
| Goal | Goal-1 recruitment capability slice |
| Lifecycle state | Frozen |
| User role | Applicant |
| Observers | Team member, team leader, and assigned interviewer |
| Dependency | 0029 recruitment interview scheduling |
| Journey authority | Pending accepted-intent revision |

## User journey

1. The applicant opens the capability link from the scheduled interview.
2. The dashboard reads the current interview and response capability from Symfony.
3. The dashboard shows the scheduled time, room, campus, and response actions.
4. The applicant selects confirm, reject, or request another time.
5. The applicant submits the selected response.
6. Symfony stores the response in the disposable database.
7. The dashboard performs a new server read.
8. The dashboard shows the stored response state.
9. The team leader performs a new server read and sees the same state.
10. The assigned interviewer performs a new server read. A rejected interview is absent from the assigned list.

## Constraints

- The browser must use the React dashboard and the existing Foldkit interview model.
- The dashboard must use the TypeScript SDK.
- The capability link contains the existing opaque `responseCode`.
- The applicant does not need an authenticated dashboard session.
- The applicant cannot read another interview through the capability link.
- The UI must not expose the raw response code after route decoding.
- The implementation must use the authoritative Symfony response operations.
- Confirm, reject, and request-new-time remain distinct domain transitions.
- A transition must obey the current interview scheduling state.
- A repeated request must follow the legacy idempotency or rejection behavior.
- The final state must come from a fresh server read.
- The browser gate must use deterministic non-production data.
- The browser gate must not contact live email or SMS providers.
- The implementation must not add a compatibility endpoint or dual-write path.

## Definition of done

The slice is complete when all these statements are true:

- A valid pending invitation shows the scheduled interview.
- The applicant can confirm the invitation.
- The applicant can reject the invitation.
- The applicant can request another time.
- A fresh applicant read shows the stored response.
- A fresh team-leader read shows the same response.
- A fresh interviewer read shows the stored state, or omits an interview that the applicant rejected.
- An expired, unknown, or malformed capability does not reveal interview data.
- An invalid transition does not change the database.
- The response code does not appear in rendered text, logs, or proof artifacts.
- The SDK type check, lint check, and focused tests pass.
- The dashboard type check, lint check, and focused tests pass.
- The real Symfony browser journey passes against a disposable database.
- The runner emits an accepted 0030 evidence receipt.

## Falsifiers

The slice is not complete if one of these conditions occurs:

- The dashboard uses a synthetic response fixture as acceptance evidence.
- The SDK calls a route that Symfony does not expose.
- The UI changes state before Symfony accepts the response.
- The UI reports success without a fresh server read.
- One response transition accidentally performs another transition.
- An invalid response changes the database.
- One capability reads or changes another interview.
- The browser output contains the response code.
- The browser gate can send a live notification.

# Goal-1 design spec 0028 - recruitment applicant assignment

> **Summary:** A team leader reviews new applicants and assigns one applicant to an interviewer. The journey uses the real Symfony server and a disposable database.

## Metadata

| Field | Value |
|---|---|
| Goal | Goal-1 recruitment capability slice |
| Lifecycle state | Frozen |
| User role | Team leader |
| Journey authority | `intent://journey/recruitment:review-applicants:v1` |
| Dependency | Accepted journey authority at `4646a4123d4ed6c397528d7956fa14cd02a72cf6` |

## User journey

1. The team leader signs in.
2. The dashboard loads the applicant list for the current semester.
3. The team leader selects the new-applicant filter.
4. The dashboard shows the applicant status, interview status, interviewer, and interview time.
5. The team leader opens the assignment dialog for an unassigned applicant.
6. The dashboard loads the available interviewers and interview schemas.
7. The team leader selects one interviewer and one schema.
8. The team leader submits the assignment.
9. The Symfony server stores the assignment in the database.
10. The refreshed applicant list shows the selected interviewer and the new interview status.

## Constraints

- The browser must use the React dashboard.
- The dashboard must use the TypeScript SDK.
- The SDK must decode the real Symfony response shapes.
- The write request must use the Symfony `interviewSchemaId` field.
- The final observation must come from a new server read.
- Fixture mode cannot prove this contract.
- The test database must not contain production data.

## Definition of done

The slice is complete when all these statements are true:

- A team leader can sign in through `/api/login`.
- `/dashboard/sokere?status=new` shows records from the real Symfony server.
- The assignment dialog shows real interviewer and schema choices.
- `POST /api/admin/interviews/assign` returns success for a valid selection.
- A new API read shows the selected interviewer for the assigned applicant.
- The SDK type check, lint check, and unit tests pass.
- The dashboard type check, lint check, and unit tests pass.

## Falsifiers

The slice is not complete if one of these conditions occurs:

- The dashboard uses a fixture response.
- The SDK rejects a valid Symfony response.
- The request sends `schemaId` instead of `interviewSchemaId`.
- The server returns success but a new read does not show the assignment.
- The browser hides a decode or transport error behind an empty list.

# 0110 - Native social-event creation

Status: frozen for local implementation, 2026-09-21. Production release unclaimed.

Baseline: `0d9771b6c1c159b086f66b8ed43497d04d0e6b28` (`migration/assistant-operations-0906`).

## Goal and product boundary

An authenticated team member opens Arrangementer for an authorized department and semester. The member creates one social event and observes it after reload.

The journey preserves these legacy fields:

- title.
- description.
- optional event link.
- start and end time.
- department and semester.
- audience: team members only, or assistants and team members.

The journey does not add invitations, registration, attendance, capacity, reminders, or notifications. The checked-in legacy application has no such social-event behavior.

Legacy source:

- `apps/server/src/App/Content/Controller/SocialEventController.php` lists and creates events.
- `apps/server/src/App/Content/Form/SocialEventType.php` defines the fields and two audience choices.
- `apps/server/src/App/Content/Infrastructure/Entity/SocialEvent.php` owns the event data.
- `apps/server/src/App/Content/Infrastructure/Repository/SocialEventRepository.php` orders scoped events by start time.
- `apps/server/templates/social_event/social_event_list.twig` shows the list, time status, and audience.
- `apps/server/src/App/Content/Api/State/AdminSocialEventCreateProcessor.php` attempts a department check before create.

The legacy HTML controller trusts any selected department and semester for a team member. It does not enforce department scope.

The legacy API check derives department from field of study, not active Organization membership. Native authority corrects both defects.

## Contract

1. Add one `SocialEventsApi` group named `social-events` to the external Effect HTTP API.
2. Add exactly the three operations in the HTTP contract below.
3. The scope operation returns authorized departments and all canonical semesters.
4. Read canonical semesters from `admission_period_semesters`. Do not create a second semester owner.
5. Return all existing departments to an active global administrator.
6. Otherwise, return distinct departments from the person's active Organization memberships.
7. Resolve the authenticated person and complete Organization authority before every operation.
8. Permit an active global administrator to use any existing department.
9. Permit an active team member to use a department from the member's active memberships.
10. Deny an inactive person, unaffiliated person, or member from another department.
11. Derive authority from persisted Organization facts. Do not trust a role or department supplied by the client.
12. Resolve the credential, one Organization projection, canonical scope, selected rows, and `observedAt` for each scope or list request in one read-only `REPEATABLE READ` transaction.
13. Treat that read transaction's snapshot as the authorization instant. A revocation committed before the snapshot wins; a concurrent revocation cannot make the row query observe a later database view.
14. Reauthorize each list and create request. The dashboard scope choices are not authority.
15. Resolve one authority instant, credential, department, semester, and complete Organization projection inside the create transaction.
16. Use one serializable transaction for the authority decision, idempotency decision, event, command receipt, audit, and HTTP response receipt.
17. Apply authority and concealment before every receipt lookup. Revoked authority always wins over replay.
18. Reject an unknown department or semester before every receipt lookup.
19. Store one canonical event with its department, semester, audience, title, description, link, start time, and end time.
20. Generate one opaque event identity during the first accepted command. Store revision `0` with that event.
21. Derive the event ETag from representation kind `social-event`, event identity, and revision.
22. Accept only trimmed, nonempty titles with at most 255 characters.
23. Accept descriptions with at most 5000 characters. An empty description remains valid.
24. Accept a null link or a trimmed link with at most 250 characters. Display the saved link as text.
25. Accept only valid RFC 3339 instants. Reject an end time before the start time.
26. The time-order rejection is a native correctness correction. The legacy source has no equivalent constraint.
27. Use the native idempotency identity tuple from `0080.1-native-http-semantics.md`.
28. The tuple contains credential subject, qualified operation ID, normalized collection target, and idempotency key.
29. Calculate the request digest from the decoded semantic request with JCS.
30. Return `409 idempotency.in-flight` and `Retry-After: 1` when the advisory lock is held.
31. Return the first response capsule for a complete matching receipt.
32. Return `409 idempotency.digest-conflict` when the same identity has different content.
33. Retain the complete response capsule for 24 hours. Then retain a tombstone.
34. Return `409 idempotency.response-expired` for a matching tombstone.
35. Return the created representation with `201`, `Cache-Control: no-store`, `Vary: Origin`, ETag, and Location.
36. Return the same allowlisted response capsule for an exact replay.
37. Order the list by start time and then by event identity in ascending order.
38. Derive time labels from the list response's one `observedAt` instant.
39. Show `Har vært` when `startAt < observedAt`.
40. Show `Skjer innen en uke` when `observedAt <= startAt < observedAt + 7 days`.
41. Show no legacy time label when `startAt >= observedAt + 7 days`.
42. Display `Kun teammedlemmer` for the team-only audience.
43. Display `Teammedlemmer og assistenter` for the wider audience.
44. Return no list rows when the selected scope has no events.
45. A denied or malformed request creates no event, receipt, audit row, or external effect.
46. A successful create writes one event, one domain command receipt, and one audit record.
47. PostgreSQL rejects updates and deletes of domain command receipts and audit records.
48. This journey creates no outbox effect and performs no network or provider call.
49. Generate the OpenAPI document and SDK from the canonical HTTP contract.
50. Add a Foldkit dashboard route at `/dashboard/arrangementer`.
51. The Foldkit Model owns scope, list, form draft, pending command, failure, and success state.
52. Preserve the form draft after a rejected create.
53. Reject repeated submission while the command is pending.
54. After success, clear the pending command and request the scoped list again.
55. Do not add or replace an event row from the create response.
56. Render the created event only from the successful list response.
57. Keep edit and delete controls absent until their separate mutation contract exists.

### HTTP contract

The endpoint group is `HttpApiGroup.make("social-events")`. Its generated qualified operation IDs, methods, paths, access specifications, inputs, outputs, and closed problem unions are:

| Qualified operation ID    | Method and path                | Access specification                                                                  | Input                                                                 | Success                                             |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------- |
| `social-events.readScope` | `GET /api/social-events/scope` | capability `social-events.read-scope`; resolver `social-events.scope`; `SnapshotRead` | no path, query, or body                                               | `200 privateReadResponse(SocialEventScopeResource)` |
| `social-events.list`      | `GET /api/social-events`       | capability `social-events.read`; resolver `social-events.list`; `SnapshotRead`        | strict query `{ departmentId: DepartmentId, semesterId: SemesterId }` | `200 privateReadResponse(SocialEventListResource)`  |
| `social-events.create`    | `POST /api/social-events`      | capability `social-events.create`; resolver `social-events.create`; `Transaction`     | `IdempotencyHeaders` and strict `CreateSocialEventRequest` JSON       | `201 createdMutationResponse(SocialEventResource)`  |

The strict wire schemas are:

- `SocialEventAudience`: exactly `"TeamMembers"` or `"AssistantsAndTeamMembers"`.
- `SocialEventResource`: `{ eventId: SocialEventId, revision: 0, departmentId: DepartmentId, semesterId: SemesterId, audience: SocialEventAudience, title: string, description: string, link: string | null, startAt: RFC3339 instant, endAt: RFC3339 instant }`.
- `SocialEventScopeResource`: `{ observedAt: RFC3339 instant, departments: ReadonlyArray<{ departmentId: DepartmentId, name: string }>, semesters: ReadonlyArray<{ semesterId: SemesterId, startAt: RFC3339 instant, endAt: RFC3339 instant }> }`.
- `SocialEventListResource`: `{ observedAt: RFC3339 instant, departmentId: DepartmentId, semesterId: SemesterId, events: ReadonlyArray<SocialEventResource> }`.
- `CreateSocialEventRequest`: `{ departmentId: DepartmentId, semesterId: SemesterId, audience: SocialEventAudience, title: string, description: string, link: string | null, startAt: RFC3339 instant, endAt: RFC3339 instant }`; unknown properties are rejected.

The create response Location is exactly `/api/social-events/{eventId}`, where `{eventId}` is the encoded created identity. It is the canonical identity URI; this slice does not add a fourth detail-read operation.

The endpoint problem schemas are closed unions:

- `SocialEventsReadScopeProblem`: `request.malformed`, `header.malformed`, `credential.missing`, `credential.invalid`, `authority.denied`, `origin.denied`, `internal.error`, `dependency.unavailable`, and `organization.unavailable`.
- `SocialEventsListProblem`: every `SocialEventsReadScopeProblem` variant plus `scope.invalid`.
- `SocialEventsCreateProblem`: `request.malformed`, `header.malformed`, `credential.missing`, `credential.invalid`, `authority.denied`, `origin.denied`, `idempotency-key.invalid`, `idempotency.in-flight`, `idempotency.digest-conflict`, `idempotency.response-expired`, `request.too-large`, `media-type.unsupported`, `validation.failed`, `scope.invalid`, `internal.error`, `dependency.unavailable`, `organization.unavailable`, and `idempotency.unavailable`.

### Access algebra

The exhaustive `AccessSpec` values use the exact 0077.2 field order:

- `social-events.readScope`: `External; [BetterAuthCookie, OAuthUserBearer]; [Person]; One(social-events.read-scope); social-events.scope; []; Reveal; SnapshotRead`.
- `social-events.list`: `External; [BetterAuthCookie, OAuthUserBearer]; [Person]; One(social-events.read); social-events.list; []; Reveal; SnapshotRead`.
- `social-events.create`: `External; [BetterAuthCookie, OAuthUserBearer]; [Person]; One(social-events.create); social-events.create; []; Reveal; Transaction`.

Add the three capability types and three resolver IDs to the closed 0055.1 registries. Derive their candidate grants only from the same complete Organization projection used by the operation:

- An active global administrator gets `social-events.read-scope` at `Domain(social-events)` and gets `social-events.read` plus `social-events.create` at `Global`.
- Each active membership gets `social-events.read-scope` at `Domain(social-events)` and gets `social-events.read` plus `social-events.create` at `Department(membership.departmentId)`.
- Duplicate read-scope grants collapse. An inactive global-administrator or membership fact contributes no grant.

`social-events.scope` resolves exactly `Domain(social-events)`. `social-events.list` resolves exactly `Department(query.departmentId)`. `social-events.create` resolves exactly `Department(body.departmentId)`. The access evaluator selects only a candidate grant whose capability type and resolved scope match under 0055.1. After that decision, the handler validates that the department and semester exist in the same transaction snapshot. The scope response filters its department rows from the complete Organization projection; the access grant itself never expands that row set.

`scope.invalid` reuses the frozen 0080.1 registry member exactly: type `urn:vektorprogrammet:problem:v0.2:scope.invalid`, title `Invalid scope`, status `422`, and detail `The selected department, semester or school is not available in this scope.` No second problem definition is allowed.

## Acceptance

The disposable journey uses PostgreSQL, the native backend, the generated SDK, the dashboard server, and real Chromium.

1. Seed two departments, two semesters, a global administrator, active members, an inactive member, and an unaffiliated person.
2. Sign in as an active member and open Arrangementer.
3. Observe only departments from that member's active memberships.
4. Observe both canonical semesters from the native scope response.
5. Select one authorized department and one semester.
6. Observe the empty state without placeholder events.
7. Create a team-only event with every field.
8. Observe one `201` response with the exact cache, Vary, ETag, and Location headers.
9. Observe a scoped list `GET` after the successful `POST`.
10. Render the created event only after that list response.
11. Observe the saved title, description, link text, times, department, semester, and audience.
12. Create a wider-audience event with an empty description and a null link.
13. Observe the wider audience text and the two preserved optional values after reload.
14. Create two events with equal start times. Observe ascending event-identity order.
15. Create events before, at, and after the request instant.
16. Create events before, at, and after the exact seven-day boundary.
17. Observe the two half-open legacy label intervals and the unlabeled later events.
18. Replay the first command and observe its original status, body, ETag, and Location.
19. Observe no second event after the exact replay.
20. Race two matching commands. Observe one accepted result and one bounded in-flight conflict.
21. Replay the command with changed content. Observe a digest conflict without a write.
22. Rehearse an expired response capsule. Observe the tombstone conflict without a write.
23. Submit an end time before the start time. Observe a typed field failure without a write.
24. Show that a member cannot list or create events for another department.
25. Show that inactive and unaffiliated people cannot list or create events.
26. Show that the global administrator can use both seeded departments.
27. Submit unknown department and semester identities. Observe no receipt lookup or write.
28. Hold a list before its read snapshot, commit membership revocation, and release it. Observe denial and no event rows.
29. Hold a list after its snapshot authority decision, then concurrently revoke the membership and insert an event. Release it and observe one internally consistent pre-revocation snapshot that excludes the later event; observe denial on the next list.
30. Revoke membership at the create barrier. Observe denial and no event, receipt, or audit.
31. Revoke authority after a successful create. Observe denial instead of replayed response bytes.
32. Query PostgreSQL after each negative case. Make sure that event, receipt, and audit counts did not change.
33. Reload the page and make sure that no browser-only state supplied an event row.
34. Make sure that the desktop and mobile pages have keyboard access and no horizontal overflow.
35. Record the executable revision, commands, checksums, negative cases, unavailable boundaries, and cleanup result.
36. Store the acceptance manifest at `evidence/functional-parity/0110/acceptance-manifest.json`.

## Explicit non-goals

- No event edit or delete operation.
- No invitation, registration, attendance, capacity, waitlist, reminder, or notification.
- No assistant-facing event list or audience enforcement outside the operator list.
- No active external link navigation.
- No import of legacy event rows or reconciliation of null legacy scopes.
- No production data, credential, provider, remote push, deployment, or cutover.

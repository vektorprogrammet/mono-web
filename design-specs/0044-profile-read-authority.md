# Design spec 0044 — profile read authority

## Metadata

| Field      | Value                                                                          |
| ---------- | ------------------------------------------------------------------------------ |
| Goal       | Replace production profile fixture projection with authenticated API authority |
| Status     | Frozen                                                                         |
| Actor      | Authenticated member                                                           |
| Dependency | `GET /api/me`, typed SDK decoding, dashboard authentication                    |
| Evidence   | Focused projection and loader tests; browser evidence remains held             |
| Scope hold | No browser or E2E execution without explicit operator authorization            |

## Problem

The profile route calls `GET /api/me`, but a failed request silently renders fixture identity and history. A successful request also merges API fields into fixture-only department, activity history, account, and image values. Production can therefore display invented profile facts.

## User journey

1. An authenticated member opens `/dashboard/profile`.
2. The loader reads the member through the authenticated SDK client.
3. The page displays only fields warranted by the decoded API response.
4. Data unavailable from the current API is named as unavailable instead of being copied from fixtures.
5. A profile API failure remains visible and does not render fixture identity.

Fixture mode remains an explicit test-only authority.

## Constraints

- Keep `GET /api/me` and its Effect Schema as the profile boundary.
- Do not broaden identity authority or implement profile mutation.
- Do not infer department or activity history from unrelated records.
- Do not run browser or E2E verification locally.
- Preserve the existing authenticated request boundary.

## Definition of done

1. Production profile loading contains no fixture fallback.
2. API failure does not return fixture data.
3. The production projection contains only API-warranted identity, contact, study, role, and photo fields.
4. Unavailable department and activity history are explicitly visible as unavailable.
5. Fixture data remains reachable only when fixture mode is explicitly enabled.
6. Focused tests prove projection of present values, projection of absent optional values, and absence of fixture canaries.
7. Dashboard type checks and lint pass on the committed revision.
8. Browser verification is recorded as blocked, not claimed.

## Falsifiers

- A production error renders `Fixture Operator` or another fixture value.
- A fixture department, account number, or history row is merged into an API response.
- Missing optional API fields are presented as known facts.
- The loader uses an unauthenticated client.
- Source or evidence claims the browser journey passed locally.

# 0113 — School survey operations

Status: frozen for local implementation, 2026-09-22. Production remains unchanged.

Baseline: `e158a960d6d1b2cae52e80cd0c6e9381fbcfcba3` on `migration/survey-admin-0922`.

## Goal

Run one school survey from scoped definition through anonymous response, closure, results, and CSV export.

The journey closes the current survey administration gap for the existing School audience. It does not add Team or Assistant surveys.

## Actors and authority

A current department leader can manage surveys for that department. An active global administrator can manage every department.

The department is the operational owner. The system records the Person who creates or closes the survey. A former leader, inactive administrator, ordinary member, anonymous caller, or leader from another department has no management authority.

Every management request resolves current Person and organization authority in the same transaction as the survey read or write. An unknown or out-of-scope survey is concealed as not found where disclosure would reveal another department's data.

A result policy is explicit at creation:

- `DepartmentManagers` allows current department leaders and global administrators.
- `GlobalAdministrators` allows only active global administrators.

## Survey definition

A manager creates an open School survey with:

- department and semester;
- title and completion text;
- result policy;
- an ordered list of Text, List, Radio, or Check questions;
- required or optional status, help text, and ordered alternatives where applicable.

The department must participate in the selected admission period semester. The server issues the survey, question, and alternative identities. The create command is idempotent.

A created survey is open immediately. Definition editing, copy, deletion, draft publication, popup messages, and notification delivery are outside this journey. This avoids changing a questionnaire after responses exist.

## Audience policy

This journey supports only `School` surveys.

The public form keeps the existing policy. It lists active schools in the survey department that have an active placement in the survey semester. Submission validates that policy again in the write transaction.

School responses stay anonymous. The system stores the selected school, submission time, and answers, but no respondent identity. Idempotency makes one submitted command durable; anonymous participants are not tracked across distinct commands.

A closed survey is unavailable through the public form and rejects new responses without a write.

## Lifecycle

The lifecycle is:

```text
Open -> Closed
```

Closing requires the expected current revision. The first accepted close records the actor and instant. A stale revision or second close fails without changing responses or history.

## Results and export

An authorized manager can read results for an open or closed survey. The result projection includes:

- definition and lifecycle metadata;
- response count;
- ordered question metadata;
- one anonymous row per response with school, submission time, and ordered answers.

The dashboard shows the same projection. It does not claim statistical significance or infer missing answers.

The CSV export is a pure representation of the authorized result projection. It has one header row and one row per response. Columns are submission time, school, then the ordered questions. Check values use a stable separator. The response uses a CSV content type, a deterministic filename, and `Cache-Control: private, no-store`.

No export file is stored and no delivery provider is called.

## Dashboard journey

One Foldkit Model owns survey administration state, events, commands, loading, errors, and stale-response rejection.

The authenticated dashboard lets a manager:

1. select an authorized department and semester;
2. list surveys and response counts;
3. create one School survey and its questions;
4. open the public response link;
5. close the survey with its visible revision;
6. inspect results;
7. download the CSV export.

The management surface is absent or denied for an unauthorized actor. Desktop and 390-pixel mobile layouts must not overflow. Labels, keyboard use, focus, errors, and pending states remain usable.

## Contract generation

Domain schemas are the source for HTTP response types. Regenerate OpenAPI, backend metadata, and the SDK. Do not edit generated outputs by hand.

## Acceptance journey

Use synthetic local PostgreSQL, seeded native identity and organization authority, the generated SDK, the real backend, the real dashboard, and Chromium.

1. Sign in as a scoped department leader.
2. Create an open School survey with all four question kinds.
3. Observe it in the scoped list with zero responses.
4. Submit one anonymous public response for an eligible school.
5. Observe one response and the exact ordered answers in the authorized result view.
6. Download CSV and compare its facts with the result projection.
7. Close the survey with the visible revision.
8. Prove that the public form is unavailable and a direct submission makes no write.
9. Prove wrong-department, ordinary-member, inactive-authority, anonymous, and confidential-result denials.
10. Prove stale close, repeated close, validation failure, idempotent replay, and concurrent duplicate commands have no extra effect.
11. Prove desktop, mobile, keyboard, reload, and accessibility behavior.

## Evidence boundary

Focused checks can prove schemas, transitions, SQL constraints, authority decisions, generated contracts, and CSV encoding.

Only the local browser, API, and PostgreSQL journey proves this complete slice. It does not prove production readiness.

This specification does not authorize production data, providers, deployment, credentials, notifications, or cutover actions.

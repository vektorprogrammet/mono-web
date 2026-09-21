# 0111 - Native school survey participation

Status: frozen for local implementation, 2026-09-21. Production release unclaimed.

Baseline: `0179948921c48fb376d48b962923c0abaf7c0807` (`migration/assistant-operations-0906`).

Revision 1, 2026-09-21: the contract now fixes ingress routing, wire schemas, database relations, canonical digests, and replay precedence. This revision follows pre-implementation review.

Revision 2, 2026-09-21: post-implementation review defines one reversible, route-safe representation for every opaque survey ID and requires safe own-key handling for opaque question IDs.

## Goal and product boundary

An anonymous school participant opens one imported survey, selects an eligible school, answers its questions, and sends one response.

The participant sees the configured completion text after the database commits the response. The journey needs no account, session, email, SMS, or other external effect.

This slice supports school surveys only. Team and assistant surveys remain separate journeys because their identity and affiliation rules differ.

This slice reads imported survey definitions. It does not add survey authoring, editing, copying, deletion, results, CSV export, popups, or notifications.

## Legacy source

The accepted behavior comes from these sources:

- `SurveyController::showAction` at `GET|POST /undersokelse/{id}`.
- `SurveyExecuteType` for the school selector and question collection.
- `SurveyAnswerType` for `text`, `list`, `radio`, and `check` questions.
- `SurveyManager::initializeSurveyTaken` for one answer slot per question.
- `Survey`, `SurveyQuestion`, `SurveyQuestionAlternative`, `SurveyTaken`, and `SurveyAnswer` for persistence.
- `takeSurvey.html.twig` and `finish_page.html.twig` for the participant journey.

The legacy API processor is not the contract. It omits the school and accepts incomplete answer sets.

The native journey preserves the stricter legacy form behavior. It corrects two unsafe legacy behaviors:

- It rejects answer values that are not configured alternatives.
- It displays completion content as text. It does not interpret imported content as trusted HTML.

## Canonical native model

Add a native survey owner with these records:

1. An imported survey definition has an opaque survey ID, department ID, semester ID, semester label, title, completion text, and audience.
2. The audience is one of `School`, `Team`, and `Assistant`. This journey selects only `School`.
3. A question has an opaque question ID, type, label, optional help text, required flag, position, and ordered alternatives.
4. A response has an opaque response ID, survey ID, department ID, school ID, and database transaction timestamp.
5. An answer belongs to one response, one survey, and one question. Scalar questions store one value. Check questions store ordered values.

Database constraints must make these states impossible:

- Two questions in one survey have the same position.
- Two alternatives in one question have the same position or value.
- One response has two answers for one question.
- An answer references a question from a different survey.
- A response references a school outside the survey department.
- A response has no survey, department, school, or timestamp.
- A stored audience or question type is outside its closed set.

The response stores the survey department. Composite foreign keys bind it to the survey and the school-department relation.

Each answer stores the survey ID. Composite foreign keys bind it to both its response and its survey question.

Survey import and administration are not public operations in this slice. The runtime journey can seed synthetic imported definitions directly.

Native positions are canonical after import. A future importer must persist positions from a reviewed manifest because legacy collections have no stable order.

## School eligibility

The list contains each school that meets all these conditions at the read instant:

- The school belongs to the survey department.
- The school is active.
- The school has at least one active native assistant placement in the survey semester.

The service sorts schools by name and then by school ID. The submit transaction resolves eligibility again. A stale browser selection cannot widen the scope.

## HTTP contract

Add a public native `surveys` API group with these operation IDs:

- `readSchoolSurvey`: `GET /api/surveys/{surveyId}`.
- `submitSchoolSurveyResponse`: `POST /api/surveys/{surveyId}/responses`.

Both operations accept an anonymous principal and no credential. They use an explicit anonymous access specification.

`readSchoolSurvey` returns this strict resource:

- `surveyId`, `departmentId`, `semesterId`, `semesterLabel`, and `title`.
- `schools`: ordered `{ schoolId, name }` records.
- `questions`: an ordered discriminated union.
- `Text` questions contain `questionId`, `label`, nullable `help`, and `required`.
- `List`, `Radio`, and `Check` questions contain the same fields and ordered string `alternatives`.

The read resource does not contain completion text, prior responses, or respondent data.

The submit payload contains `schoolId` and an `answers` array. It uses this strict answer union:

- `Text`, `List`, and `Radio`: `{ kind, questionId, value }`.
- `Check`: `{ kind: "Check", questionId, values }`.

The submit operation requires `Idempotency-Key`. The service normalizes before it computes the command digest.

The normalized array follows question position. Check values follow configured alternative position. Input order cannot cause a false digest conflict.

The first accepted command returns `201` with `responseId`, `submittedAt`, and `completionText`. It includes `Location` and `ETag`.

`Location` is `/api/surveys/{surveyId}/responses/{responseId}`. This slice does not add a public response-read operation.

An exact replay returns the same status, headers, and body while the survey and school remain eligible.

Current validation runs before receipt lookup. Eligibility loss therefore returns `422`, even for a previously accepted key.

A reused key with different normalized input returns `409`. Concurrent identical commands create one response.

Expired or in-flight receipts use the shared native semantics. All responses use `Cache-Control: no-store`, `Vary: Origin`, and the shared problem format.

## Validation and failure behavior

The native service applies these rules in the submit transaction:

1. The survey ID must resolve to an imported `School` survey.
2. The selected school must satisfy the current eligibility rule.
3. Each question ID can occur at most once.
4. Each question ID must belong to the path survey.
5. The answer `kind` must equal the stored question type.
6. Every required question must have a nonempty answer.
7. Optional empty text answers are omitted.
8. List and radio answers must equal one configured alternative.
9. Check answers must contain unique configured alternatives.
10. A required check answer must contain at least one value.
11. Request objects reject unknown properties.

The service trims text before validation and storage. Limits count UTF-8 bytes after trimming:

| Value                               |      Maximum |
| ----------------------------------- | -----------: |
| Survey ID, question ID, response ID |    128 bytes |
| Semester label                      |    100 bytes |
| Survey title                        |    255 bytes |
| Completion text                     |  4,096 bytes |
| Question label or help text         |  1,000 bytes |
| Alternative                         |    500 bytes |
| Text answer                         |  4,096 bytes |
| Questions per survey                |          100 |
| Alternatives per question           |          100 |
| Selected check values               |          100 |
| Complete submit body                | 65,536 bytes |

An imported definition that exceeds a field or collection limit cannot enter the native tables.

Use these observable failures:

- Unknown or non-school survey: `404 resource.not-found`.
- Ineligible or unknown school: `422 validation.failed`.
- Missing, duplicate, cross-survey, malformed, or invalid answers: `422 validation.failed`.
- Invalid idempotency header: `400 idempotency-key.invalid`.
- Digest conflict or in-flight command: `409` with the shared idempotency code.
- Oversized request: `413 request.too-large`.
- Unsupported media type: `415 media-type.unsupported`.
- Survey or eligibility persistence failure: `503 dependency.unavailable`.
- Native receipt persistence failure: `503 idempotency.unavailable`.

Validation failures write no response, answer, or completed receipt.

## Browser journey

Add the public route `/undersokelse/:surveyId` to the native dashboard server.

Add `/undersokelse` to `infra/alchemy/preview/surface-apex.ts`. The apex dispatcher must route the page and its React Router data requests to the dashboard.

The route uses the generated SDK through a server bridge. The browser does not call the backend origin directly.

The page displays:

- The survey title and semester label.
- One required school selector.
- Ordered question labels and help text.
- A textarea for `Text`.
- A select for `List`.
- A radio group for `Radio`.
- A checkbox group for `Check`.
- Required and optional semantics that assistive technology can observe.
- One `Send inn` button.

The loader generates the command ID before submission and puts it in a hidden form field. The action validates and forwards this exact ID.

After a rejected command, the action preserves the command ID and entered values. A network retry therefore replays the same command.

After acceptance, the route replaces the form with the completion text and one link to the home page. It does not show response IDs or prior answers.

The route works at 390 CSS pixels and desktop width. Keyboard users can reach every control and submit the form. Labels, error summaries, focus, and live status are accessible.

No React local state owns the survey. The browser form, route action, and server response own the interaction.

## Required runtime evidence

Run one disposable PostgreSQL, native backend, generated SDK build, dashboard server, and real headless Chromium.

The runtime must prove these behaviors:

1. An anonymous participant opens a seeded school survey without a session cookie.
2. The form displays eligible schools and all four question types in stored position order.
3. The participant sends valid required and optional answers.
4. The page displays the configured completion text only after the commit.
5. PostgreSQL contains one response and the exact normalized answers.
6. An exact replay returns the first receipt and creates no new rows.
7. Reordered answer entries and check values replay the first receipt.
8. A changed replay returns the digest conflict.
9. Two concurrent identical commands create one response.
10. Missing required answers write nothing.
11. An unknown, duplicate, cross-survey, wrong-kind, or invalid answer writes nothing.
12. A duplicate check value writes nothing.
13. An inactive, foreign-department, no-placement, and unknown school each fail.
14. A school that loses eligibility after form load fails at submit time.
15. Eligibility loss after a commit takes precedence over exact replay.
16. An unknown survey and a seeded non-school survey return `404`.
17. The apex dispatcher routes the page and its data action to the dashboard.
18. Desktop and mobile views have no horizontal overflow.
19. Keyboard submission works and the page has no detected accessibility violation.
20. The generated SDK is the browser-server transport.
21. The backend receives no cookie, bearer token, or object capability for this journey.
22. Cleanup removes the database, temporary files, ports, and browser process.

The evidence manifest must name the exact clean source revision. It must separate runtime evidence from type checks and unit tests.

## Exclusions

- No production data or legacy database access.
- No production credentials, provider changes, remote push, deployment, or cutover.
- No survey administration, result views, CSV export, popup behavior, or notification delivery.
- No team-member or assistant response flow.
- No migration of historical survey responses.
- No raw HTML rendering for completion content.
- No claim that native survey data replaced the legacy owner.

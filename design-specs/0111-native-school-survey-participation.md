# 0111 - Native school survey participation

Status: frozen for local implementation, 2026-09-21. Production release unclaimed.

Baseline: `0179948921c48fb376d48b962923c0abaf7c0807` (`migration/assistant-operations-0906`).

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

1. A school-survey definition has an opaque survey ID, department ID, semester ID, semester label, title, completion text, and ordered questions.
2. A question has an opaque question ID, type, label, optional help text, required flag, position, and ordered alternatives.
3. A response has an opaque response ID, survey ID, school ID, and database transaction timestamp.
4. An answer belongs to one response and one question. Text, list, and radio questions store one value. Check questions store an ordered value list.

Database constraints must make these states impossible:

- Two questions in one survey have the same position.
- Two alternatives in one question have the same position or value.
- One response has two answers for one question.
- A response references a school outside the survey department.
- A response has no survey, school, or timestamp.
- A stored question type is outside `Text`, `List`, `Radio`, and `Check`.

Survey import and administration are not public operations in this slice. The runtime journey can seed a synthetic imported definition directly.

## School eligibility

The list contains each school that meets all these conditions at the read instant:

- The school belongs to the survey department.
- The school is active.
- The school has at least one active native assistant placement in the survey semester.

The service sorts schools by name and then by school ID. The submit transaction resolves eligibility again. A stale browser selection cannot widen the scope.

## HTTP contract

Add a public native `surveys` API group with these operations:

- `GET /api/surveys/{surveyId}` reads one school-survey form.
- `POST /api/surveys/{surveyId}/responses` creates or replays one anonymous response.

Both operations accept an anonymous principal and no credential. They use an explicit anonymous access specification.

The read response contains the survey definition, eligible schools, question order, and alternatives. It never contains prior responses or respondent data.

The submit request contains the school ID and exactly one answer entry for each answered question. Each entry names its question ID.

The submit operation requires `Idempotency-Key`. The command digest includes the survey ID, school ID, and canonical answer payload.

The first accepted command returns `201` with a response ID and database timestamp. An exact replay returns the same status, headers, and body.

A reused key with different input returns `409`. Concurrent identical commands create one response. Expired or in-flight receipts use the shared native semantics.

All responses use `Cache-Control: no-store`, `Vary: Origin`, and the shared problem format. The created response includes `Location` and `ETag` headers.

## Validation and failure behavior

The native service applies these rules in the submit transaction:

1. The survey ID must resolve to a school survey.
2. The selected school must satisfy the current eligibility rule.
3. Each question ID can occur at most once.
4. Unknown question IDs fail the command.
5. Every required question must have a nonempty answer.
6. Optional empty text answers are omitted.
7. List and radio answers must equal one configured alternative.
8. Check answers must contain unique configured alternatives.
9. A required check answer must contain at least one value.
10. Text answers and imported labels must obey explicit byte limits.
11. Request objects reject unknown properties.

Use these observable failures:

- Unknown or non-school survey: `404 resource.not-found`.
- Ineligible or unknown school: `422 validation.failed`.
- Missing, duplicate, unknown, malformed, or invalid answers: `422 validation.failed`.
- Invalid idempotency header: `400 idempotency-key.invalid`.
- Digest conflict or in-flight command: `409` with the shared idempotency code.
- Oversized request: `413 request.too-large`.
- Unsupported media type: `415 media-type.unsupported`.
- Database failure: `503 dependency.unavailable`.

Validation failures write no response, answer, or completed receipt.

## Browser journey

Add the public route `/undersokelse/:surveyId` to the native dashboard server.

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

The action generates one command ID for one deliberate submission. It preserves entered values and displays field errors after a rejected command.

After acceptance, the route replaces the form with the completion text and one link to the home page. It does not show response IDs or prior answers.

The route works at 390 CSS pixels and desktop width. Keyboard users can reach every control and submit the form. Labels, error summaries, focus, and live status are accessible.

No React local state owns the survey. The browser form, route action, and server response own the interaction.

## Required runtime evidence

Run one disposable PostgreSQL, native backend, generated SDK build, dashboard server, and real headless Chromium.

The runtime must prove these behaviors:

1. An anonymous participant opens a seeded school survey without a session cookie.
2. The form displays eligible schools and all four question types in source order.
3. The participant sends valid required and optional answers.
4. The page displays the configured completion text only after the commit.
5. PostgreSQL contains one response and the exact normalized answers.
6. An exact replay returns the first receipt and creates no new rows.
7. A changed replay returns the digest conflict.
8. Two concurrent identical commands create one response.
9. Missing required answers write nothing.
10. An unknown question, duplicate question, invalid alternative, and duplicate check value each write nothing.
11. An inactive, foreign-department, no-placement, and unknown school each fail.
12. A school that loses eligibility after form load fails at submit time.
13. An unknown survey and a seeded non-school counterexample return `404`.
14. Desktop and mobile views have no horizontal overflow.
15. Keyboard submission works and the page has no detected accessibility violation.
16. The generated SDK is the browser-server transport.
17. The backend receives no cookie, bearer token, or object capability for this journey.
18. Cleanup removes the database, temporary files, ports, and browser process.

The evidence manifest must name the exact clean source revision. It must separate runtime evidence from type checks and unit tests.

## Exclusions

- No production data or legacy database access.
- No production credentials, provider changes, remote push, deployment, or cutover.
- No survey administration, result views, CSV export, popup behavior, or notification delivery.
- No team-member or assistant response flow.
- No migration of historical survey responses.
- No raw HTML rendering for completion content.
- No claim that native survey data replaced the legacy owner.

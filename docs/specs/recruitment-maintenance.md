# Recruitment maintenance

Status: frozen for local implementation and acceptance. Production and provider actions remain unauthorized.

## Goal

A coordinator maintains interview questionnaires and staffing through the native dashboard without changing existing recruitment outcomes.

This slice completes questionnaire authoring and interviewer/co-interviewer changes. It preserves assignment, scheduling, invitations, conduct, reports, corrections, and onboarding.

## Authority and ownership

Interview questionnaires are global reusable definitions. Do not invent department ownership or copy the legacy route-level authorization gaps.

A current global administrator can create, revise, activate, and deactivate a questionnaire. Existing authorized assignment readers can select active questionnaires.

A current department leader can change staffing for an interview in that department. A current global administrator can do this across departments.

Ordinary membership, directory visibility, and an existing browser session do not grant maintenance authority. Resolve current authority inside the transaction, including before replay.

## Questionnaire behavior

- Provide a usable native authoring form for the existing text, list, radio, and checkbox question kinds.
- An author can name a questionnaire, add/remove/reorder questions, edit prompts and help text, and maintain ordered alternatives where applicable.
- Reuse the current question-definition schema. Preserve unique question identities, contiguous order, and valid alternatives. Derive question counts from the accepted definitions.
- Creation and revision have explicit command identities. Revision names the observed version and records a reason.
- Activation controls future assignment selection. Deactivation preserves every existing interview and its evidence. No destructive questionnaire deletion.
- Assignment captures one coherent question definition under concurrent authoring. Existing interviews retain their immutable question snapshots and answers after edits or deactivation.
- Existing interview projections must not substitute a changed live question count for their saved question snapshot.
- Preserve historical empty or unavailable snapshots as explicit unavailable evidence. Do not manufacture answers or silently replace historical questions.
- Retain author, time, reason, revision, and changed definitions as immutable maintenance history.

## Interview staffing behavior

- Provide a native form to set the required primary interviewer and optional co-interviewer together.
- The selected people must meet current native eligibility for the interview department. They must be distinct and must not be the linked applicant.
- An explicit empty co-interviewer removes the co-interviewer. The primary interviewer remains required; no destructive unassignment or interview deletion.
- Permit changes only before completion or cancellation. Reject terminal interviews without changing their recorded assessment or outcome.
- Require the observed interview revision and a reason. Preserve interview and application identities, question snapshots, schedules, invitation capabilities, responses, assessments, reports, and onboarding facts.
- Staffing changes do not reschedule an interview or send an applicant invitation. Existing immutable delivery envelopes remain unchanged.
- Existing native conduct and scheduling authority must use the new assignment immediately. A removed interviewer without separate authority cannot retain access through an old session or cached command receipt.
- Preserve actor, time, reason, old staffing, new staffing, and revision in immutable history.

## Boundary requirements

Use the existing Recruitment service, domain schemas, PostgreSQL adapter, HTTP transaction receipts, generated SDK, and Foldkit architecture.

Keep one source for every cross-process contract. Generate OpenAPI and SDK artifacts. Use the existing same-origin dashboard API proxy.

All state, revisions, audit, business receipts, and HTTP response receipts commit together. Do not add a second repository or transaction mechanism.

Same-command retries return the accepted result without duplicate mutation or history. Conflicting reuse fails. Concurrent stale edits cannot overwrite a winner.

The database must serialize candidate eligibility, authority changes, assignment, authoring, and conduct at their existing locking boundaries. Keep a consistent lock order.

A failed commit leaves no partial state or receipt. The same request can succeed after recovery. Wrong-scope reads expose no confidential interview or history.

The dashboard keeps drafts on failure, makes stale conflicts explicit, locks conflicting controls during submission, and refreshes authoritative revisions after success.

Use accessible labels and keyboard-operable forms. The 390px layout must not overflow horizontally.

## Acceptance

Exercise committed source through real local PostgreSQL, native HTTP, generated SDK, the dashboard server, and Chromium.

1. Create a questionnaire with all supported question kinds. Revise order, alternatives, and help text; reload and observe persisted definitions and history.
2. Assign an interview using the questionnaire. Revise/deactivate the source and prove the interview snapshot remains unchanged; new assignments use the current active definition only.
3. Replace primary and co-interviewers, then remove the co-interviewer. Observe preserved interview/invitation identity and current access for old and new actors.
4. Reject ordinary members, wrong departments, revoked actors, ineligible candidates, duplicate/self staffing, stale revisions, and terminal interviews without partial writes.
5. Prove replay, conflicting key reuse, overlapping edits, and forced commit-failure rollback followed by identical-request recovery.
6. Exercise current scheduling, invitation responses, conduct, assessment corrections, reports, and onboarding through the existing relevant checks. Never equate fixture mocks with boundary proof.
7. Observe keyboard submission, pending controls, error recovery, retained selections, narrow layout, and automated accessibility results on the actual dashboard.
8. Run affected type checks, focused behavioral regressions, and generated API checks. Report exactly which gates ran.

## Exclusions

No standalone team recruitment, survey authoring, mailing-list controls, reminders, no-show policy, historical import, provider deployment, production access, or cutover.

## Acceptance record

After acceptance, update STATE.md, the system document, and changelog with the implemented behavior and evidence limits.

Remove this completed contract and disposable probe scripts. Preserve source-bound evidence outside the repository. Commit the accepted slice locally; do not push or deploy.

# Recruitment to first placement

## Frozen scope

This local journey starts with a public application and ends with a fresh volunteer session that displays the first school placement.
The journey uses only native applications, disposable PostgreSQL, synthetic people, and a loopback delivery provider.
It does not require legacy data or production access.

The fixture creates staff accounts, scoped authority, an admission period, interview questions, and a school.
It does not create applications, interviews, recommendations, invitations, applicant accounts, affiliations, or placements.

## Business boundaries

1. The public applicant submits an application through the homepage.
2. Authorized staff assign and arrange the interview through the dashboard.
3. The applicant responds through the delivered interview link.
4. Staff complete the interview and record a recommendation through the dashboard.
5. Authorized staff issue an account invitation through onboarding.
6. The applicant claims the account through the delivered link.
7. The applicant requests affiliation.
8. A leader with authority for that department approves affiliation.
9. The leader creates the first school placement.
10. A fresh volunteer login and reload display that placement.

A recommendation does not approve affiliation or create a placement.
An account invitation does not create credentials before the applicant claims it.
An interview response is not an admission decision.
This journey does not define a new accepted state, team recruitment policy, or no-show policy.

## Observable contract

Independent PostgreSQL observations verify each important transition and its history, command receipts, or outbox where applicable.
The journey checks confidentiality with a second actor and rejects wrong-scope and other-applicant commands without changed facts.
Reload and repeated commands do not create duplicate business decisions.
A local delivery failure preserves the business decision; recovery delivers the original invitation without another decision.
Browser evidence binds the same continuous actors and application to the final placement.
Visual evidence stays outside the strict upload inventory.

## Reuse and ownership

- `tools/e2e/run-real-native-recruitment-assignment.mjs`: assignment API, session, migration, and persistence precedents.
- `tools/e2e/placement-check.ts`: disposable lifecycle, process cleanup, source identity, and receipt production.
- `tools/e2e/golden-school-service-evidence.mjs`: bounded evidence inventory and credential exclusion conventions.
- `apps/dashboard/e2e/run-real-native-placement.mjs`: dashboard build, Playwright invocation, and cleanup.
- `apps/dashboard/e2e/native-recruitment-*.spec.ts`: supported assignment, schedule, response, and completion controls.
- `apps/dashboard/e2e/native-onboarding.spec.ts`: invitation, account claim, affiliation, and placement controls.
- `apps/homepage/e2e/public-applicant-admission.spec.ts`: public application controls.

The new journey has a separate identity, observer, browser scenario, and evidence step list.
It does not extend the school-service journey.
The writer owns journey-specific files and narrow recruitment/onboarding product fixes.
The parent owns root scripts and shared documentation.
The delivery writer owns backend configuration, process startup, and delivery workers.

## Acceptance

Commit the candidate before the full local runtime run.
Run only with the parent's heavy-runtime slot.
Retain sanitized source-bound evidence after disposable resource cleanup.
Keep the existing school-service failure-injection and cleanup gates unchanged.

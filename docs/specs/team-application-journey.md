# Team application journey

Status: frozen for local implementation.

## Goal

A visitor applies to one team through the native public site.
The applicant receives a receipt. The team mailbox receives the application.
Current members of that team read the application in the dashboard.
The current leader of that team opens or closes intake and can delete an application.

This slice replaces the legacy standalone team application at functional parity.
It adds no review outcome, hiring state, appointment, or interview.
The legacy `TeamApplicationController` in the sibling Symfony repository records the replaced behavior.

## Operator decisions

These decisions were made on 2026-09-25:

- Native replaces the legacy flow at parity. Review remains read and delete only.
- Only a current leader of the application's team can delete it. Legacy lets any control-panel member call the delete endpoint. Native does not keep that gap.
- The system does not purge applications automatically. Retention remains an open privacy decision in `STATE.md`.
- The system keeps each distinct submission. Only a replay of one request, by idempotency key, is a duplicate.

The legacy form has no consent notice or consent record. This slice keeps that parity. The missing notice remains an open privacy decision.

## Scope and exclusions

Use synthetic people, disposable local PostgreSQL, and a loopback notification provider.
Fixtures create prerequisites only: people, credentials, departments, teams, and memberships.
Fixtures do not create applications, intake settings, deletions, or delivery outcomes.

No production access, provider credentials, deployment, legacy data import, or cutover belongs in this slice.
No duplicate detection, retention purge, review status, reminder, or new team-content system belongs in this slice.
Import of legacy team applications is a separate reconciliation task.

## Observable acceptance

### Intake

1. A team accepts applications only when `acceptApplication` is true and the deadline is absent or in the future.
2. The public team page shows an application link only for an open team.
3. An anonymous visitor submits name, email, phone, year of study, field of study, biography, and motivation.
4. The fields keep the legacy requirements: all are required, the email is valid, and the field of study has at most 45 characters.
5. A closed team, an inactive team, or an unknown team rejects the submission without changes.
6. A valid submission stores one application for that team with its submission instant.
7. An exact replay of one request returns the original result without a second application or notification.
8. A second distinct submission from the same person creates a second application.

### Notification

9. The applicant receipt goes to the applicant email. Its reply address is the team email, or the department email if the team has none.
10. The team notification goes to the team email, or the department email if the team has none. It contains the application and replies to the applicant.
11. Both notifications commit with the application in one transaction. Delivery happens after commit through the durable outbox.
12. A provider failure keeps the application. Unattended recovery delivers the retained notifications without another submission.
13. The confirmation page states that the application was received. It does not claim delivery.

### Staff access

14. A current, nonsuspended member of the team can list and read the team's applications.
15. A member of another team, a former member, a suspended member, and an anonymous caller cannot read them.
16. The current leader of the team can delete an application. The deletion removes the application and its private fields.
17. A team member who is not the current leader cannot delete an application. The denial changes nothing.
18. The current leader of the team can open or close intake and set or clear the deadline.
19. Intake-setting changes require the observed revision. A stale change fails without changes.
20. Deletions and intake changes record attributable audit history. Audit history does not retain applicant contact details or free text.
21. Authority applies at each request, including requests from existing sessions.

### Evidence

22. One continuous browser journey drives the public page, the form, the dashboard list, the detail view, intake closure, and deletion.
23. Independent PostgreSQL observations bind the browser actions to stored applications, audit, and outbox facts.
24. Failure or interruption fails the command and releases owned processes, listeners, databases, and credentials.

## Boundaries

Reuse the existing Organization team, department, and membership records.
Reuse the established public intake, idempotency, audit, outbox, and worker patterns.
Keep the application separate from team interest, admission applications, memberships, and appointments.
A team application does not create a Person, an Account, or a membership.

Use the generated HTTP contract and SDK for frontend calls.
Keep lifecycle rules in the domain. Keep dashboard workflow state in one Foldkit Model where the dashboard uses Foldkit.
Apply explicit bounds to collection reads, text fields, and delivery, as in the reimbursement journey.

## Documentation

Update the intended [system document](../system.md) with the enduring behavior.
Record the exercised revision, evidence, and open privacy decisions in [STATE.md](../../STATE.md).
Retire this specification after code, documents, and acceptance records represent its contract.

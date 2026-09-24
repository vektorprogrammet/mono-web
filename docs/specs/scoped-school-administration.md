# Scoped school administration

Status: frozen for local implementation and acceptance. Production and provider actions remain unauthorized.

## Goal

A school coordinator maintains partner-school facts through the native dashboard without changing placement demand or rosters.

## Business boundary

Schools owns the school identity, name, contact person, email, phone, language, active status, and department associations.
A capacity plan belongs to one school, department, and semester. It records nonnegative Monday–Friday counts.
Capacity is not placement demand. This journey never creates or modifies placements, demand blocks, rosters, commitments, or notifications.
Existing school identities and historical references remain intact. There is no school deletion command.

## Authority

A current global administrator can administer all schools.
Otherwise, current department leadership authorizes maintenance within its department scope.
Directory membership alone grants no maintenance authority.
Shared school and contact changes require authority over every current associated department.
Association changes require authority over the union of the current and requested departments.
An unassociated existing school requires global authority before association or maintenance.
New schools and replacement association sets require at least one department.
Capacity changes require current leadership for the plan department, or current global administration.
The school must have that department association. New capacity changes require an active school.
The server resolves current authority inside the committing transaction, including before replay.

## User journey

1. Open the native school directory and its maintenance controls.
2. Create a school with its contact details, language, active status, and department associations.
3. Revise school details or contacts and explicitly activate or deactivate the school.
4. Change department associations without changing the school identity.
5. Select an associated department and a semester. Create or revise the five weekday capacity counts.
6. Refresh the page and observe the saved values, revisions, and attributable history.

The interface shows only authorized maintenance choices. The server remains authoritative.
Deactivation preserves capacity, placement, demand, and historical records. It does not silently cancel ongoing service.
An association cannot be removed while capacity or other dependent records reference it.
The interface reports denial, invalid input, stale versions, and persistence failure. It never displays an uncommitted success.
Pending commands disable conflicting controls. Keyboard interaction and a 390px viewport remain usable.

## Consistency

Complete commands own each business change. Model variants do not define generic CRUD or partial PATCH behavior.
Commands require a nonblank reason and an explicit observed revision where a record already exists.
Creation cannot overwrite an existing capacity plan for the same school, department, and semester.
Exact replay returns the recorded result without another revision or history event.
Changed payloads under one request identity fail. Stale commands cannot overwrite a newer value.
School rows serialize association, shared-detail, and capacity eligibility changes where those facts interact.
Current state, revision, business receipt, attributable history, and HTTP response receipt commit or roll back together.
No provider effect belongs to these commands.

## Architecture

Extend the existing Schools domain service, PostgreSQL Layer, native HTTP contract, generated SDK, and Foldkit dashboard.
Reuse the Economy complete-command transaction boundary and the existing HTTP identity and replay mechanism.
Read database projections through shared schemas and the existing SqlSchema conventions.
Keep transport preconditions and HTTP receipts outside domain contracts.
Preserve existing directory scope and legacy provenance. Use a forward database migration.
Do not add another repository layer, authorization mechanism, queue, or framework.

## Acceptance

- Exercise school creation, detail/contact revision, active status, associations, and weekday capacity through the real dashboard, API, and PostgreSQL.
- Exercise administrator and scoped leader success. Deny ordinary members, outsiders, inactive authority, and cross-department changes.
- For a shared school, deny scalar changes from a leader who lacks one associated department. Permit that leader's own capacity plan.
- Deny an association change that adds an unauthorized department or removes a referenced association.
- Distinguish two departments and two semesters. Capacity edits leave other plans and placement demand unchanged.
- Reject negative or fractional capacity, blank required fields, invalid references, and stale versions without partial writes.
- Exercise exact replay, conflicting payloads, and two overlapping connections with competing revisions.
- Revoke leadership and deny both new commands and replay through the existing session.
- Force a transaction failure. Observe unchanged state, revision, history, and receipts. Retry the same request successfully after recovery.
- Inspect the real narrow layout and keyboard interaction. Run relevant existing checks and regenerate the API contract.

## Completion

After acceptance, update the system document, STATE.md, and changelog with the observed scope and limits.
Remove this completed contract and disposable proof scripts. Preserve source-bound evidence outside the repository.
Commit the completed slice. Do not push or deploy.

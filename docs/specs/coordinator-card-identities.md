# Coordinator card identities

Status: frozen for local implementation and acceptance.
Production access, provider delivery, and deployment remain unauthorized.

## Goal

A scoped coordinator can identify the absent person, actual attendees, and deciding actor from the existing school-service cards.
The cards expose facts already available through their authorized API responses. This slice changes presentation, not authority or lifecycle rules.

## Contract

- Each absence card identifies the absent person separately from substitutes, reporters, and other actors.
- Each terminal commitment card identifies the actor who recorded its terminal decision.
- If a terminal outcome records actual attendance, the card lists those people. Planned assignments never substitute for actual attendance.
- If no attendance exists, the card states that fact. Cancellation does not invent an occurrence or imply attendance.
- Reuse the current identity display convention and authorized response fields. Do not invent names or add a separate identity lookup.
- Preserve the terminal outcome, time, reason, evidence source, existing controls, and current authorization boundaries.
- Render identity text safely and keep long identifiers readable on a narrow screen. Keep headings and lists accessible.
- Reload and normal board refresh retain these facts from the server. Rejected reads do not retain another scope's visible identities.

## Acceptance

Use synthetic data and loopback services. The parent owns runtime execution and runs only one heavy job at a time.

- Exercise the existing absence and terminal read paths through the actual dashboard and native backend with disposable PostgreSQL.
- Observe the absent person, deciding actor, and actual attendee identities, including attendance that differs from the planned roster.
- Cover Completed, Cancelled, and Unfulfilled outcomes, including no attendance. Check that cards do not invent people.
- Check reload, narrow layout, keyboard access, and automated accessibility findings on the changed surface.
- Reuse maintained runtime tooling. Run relevant existing checks; add a regression only for an uncertain observable boundary.
- Retain source-bound evidence outside the repository. Distinguish real runtime observations from static checks and provider claims.

## Exclusions

No new API, database migration, permission, lifecycle state, report, export, identity-resolution service, or external effect belongs to this slice.

## Completion

Update STATE.md, the system document, and changelog after acceptance. Commit locally; do not push or deploy.
Preserve acceptance evidence before removing disposable runtimes, scripts, clean integrated worktrees, and this completed specification.

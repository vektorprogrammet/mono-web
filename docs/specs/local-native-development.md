# Local native development

Status: frozen for local implementation and acceptance.

## Goal

A developer runs the homepage, dashboard, and native Bun backend through `bun dev`.
The backend uses an explicitly selected, dedicated local PostgreSQL database.
No cloud account, provider credential, legacy server, or deployment is required.

## Contract

- Reuse package tasks and Turbo for process ownership. Do not create a second PostgreSQL supervisor.
- Require `BACKEND_PG_URL` and `BETTER_AUTH_SECRET`. Reject non-loopback database URLs before startup.
- Use loopback HTTP listeners and coherent frontend, session, OAuth, and backend origins.
- Keep ports configurable for isolated acceptance. Use separate ports for all three processes.
- Preserve local database and private-file contents across restart. Do not reset or seed accounts automatically.
- Disable external delivery in this local composition. Local acceptance does not prove provider delivery.
- Permit homepage development with uncommitted changes. Keep the clean-source requirement for release builds.
- Serve the homepage through the local Node development runtime. Accept loopback homepage hosts only in development.
- Show an honest working-tree identity during development, not an exact-commit claim.
- Preserve existing authorization and authenticated-ingress boundaries. Do not weaken them to make public commands pass.
- Stop owned application children on interruption or startup failure. Do not stop existing services.

## Acceptance

Run the canonical command against a new synthetic database in an isolated local PostgreSQL cluster.
Reuse the native identity seed and existing synthetic authority setup.
Verify homepage rendering, dashboard sign-in, and an authorized database-backed dashboard page in Chromium.
Verify restart persistence, a missing-configuration failure, and release-build rejection of a dirty source tree.
Verify process shutdown and preserve evidence outside the repository.
Document exact local configuration and seed commands in the existing README.

## Limits

No production source data, shared database changes, external mail, cloud provisioning, deployment, or remote publication.
The operator deferred provider selection and provisioning until migration cutover preparation.

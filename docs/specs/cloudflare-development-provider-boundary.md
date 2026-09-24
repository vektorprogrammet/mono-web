# Cloudflare development provider boundary

Status: superseded by operator direction on 2026-09-24. Not accepted or authorized for deployment.

The operator selected portable Bun hosting with PostgreSQL. Development remains local without paid infrastructure provisioning.
Production infrastructure selection and provisioning are deferred until migration cutover preparation. Free managed plans remain optional evaluation candidates.
The previous Worker, Hyperdrive, and Cloudflare-only composition requirements below are historical, not an active implementation mandate.
The private-file and mail behaviors remain relevant. Their production providers are not selected by this document.

## Goal

Run the native backend in a Cloudflare development environment.

The environment uses the workstation PostgreSQL service. Cloudflare Hyperdrive reaches PostgreSQL through an authenticated private tunnel.

The application owns provider-neutral service contracts. Cloudflare-specific code supplies Layers at the composition root.

## User journey

1. An operator starts the Cloudflare development environment.
2. The backend applies the existing PostgreSQL migration graph through Hyperdrive.
3. A user signs in through the real native authentication path.
4. A user submits a receipt and uploads its private file.
5. The backend stores the file in a private R2 bucket.
6. An authorized approver reads the same file through the backend.
7. A native email-producing journey submits one email through the mail service.
8. The Cloudflare email provider accepts the message and returns a provider reference.
9. The operator restarts the Worker and repeats the reads without lost state.

## Authority boundary

The domain and application code can request email delivery. It cannot select a vendor or read provider credentials.

The existing `ReceiptFileService` contract remains the authority for private receipt files. The domain cannot access R2 bindings.

The existing `Database` contract remains the authority for PostgreSQL access. The domain cannot access Hyperdrive bindings.

The Cloudflare composition root owns these concrete resources:

- the Hyperdrive binding;
- the private R2 bucket binding;
- the email binding;
- the required secrets and identifiers.

## Constraints

- Keep one modular backend. Do not create a microservice.
- Keep the Bun composition root for local and retained operational tools.
- Add a Cloudflare Worker composition root for the development environment.
- Use Alchemy for Cloudflare resources and deployment state.
- Use the workstation NixOS PostgreSQL service. Do not run a second PostgreSQL instance.
- Use an authenticated Cloudflare private tunnel. Do not expose port 5432 to the public Internet.
- Use TLS from Hyperdrive to PostgreSQL.
- Use a dedicated PostgreSQL role and database for this environment.
- Keep the R2 bucket private. The browser must not receive R2 credentials or unrestricted object URLs.
- Keep provider code outside `packages/domain` and `packages/http-api`.
- Fail during startup when a required binding or secret is absent.
- Do not send production messages or read production data in this phase.
- Do not deploy until the operator approves the exact Cloudflare account, domain, database role, and sender identity.

## Mail contract

The provider-neutral mail service accepts one immutable delivery request.

A request contains these values:

- a stable delivery ID;
- one sender mailbox;
- one recipient mailbox;
- an optional reply-to mailbox;
- a subject;
- a text body.

A successful result contains a provider reference. A failure distinguishes permanent rejection, temporary unavailability, and an ambiguous provider outcome.

The service does not own templates, recruitment policy, receipt policy, retry policy, or authorization.

The application builds the message. The existing outbox owns retry and replay where the journey has an outbox.

This contract does not claim an SMS provider. SMS remains a separate provider decision.

## Private-file contract

The R2 Layer implements the existing private receipt-file behavior.

The Layer must preserve these properties:

- staged bytes are not visible as committed files;
- promotion is idempotent for the same effect ID and digest;
- conflicting replay fails;
- committed bytes match the recorded length and SHA-256 digest;
- unauthorized callers cannot read files;
- a restart does not lose staged or committed state;
- the object key does not contain a user-supplied filename.

## Development database contract

The NixOS PostgreSQL service owns the database process.

A dedicated role owns one dedicated database. The role has no authority over other workstation databases.

Cloudflare Access authenticates the tunnel connection. Hyperdrive owns connection pooling for Worker requests.

The Worker receives the Hyperdrive connection string through its binding. The application does not copy host, port, user, and password fields.

## Acceptance checks

The implementation is accepted only when all checks pass.

1. Domain and HTTP packages contain no Cloudflare imports.
2. The Cloudflare Worker starts with the required bindings.
3. The Worker rejects startup with a clear error for each absent binding.
4. Hyperdrive reaches the workstation PostgreSQL service through the authenticated tunnel.
5. The real migration graph completes on the dedicated development database.
6. The real dashboard, API, authentication, and PostgreSQL path completes.
7. A receipt upload, promotion, authorized read, and restart complete against R2.
8. A conflicting receipt-file replay fails without overwriting committed bytes.
9. One allowlisted development email reaches an operator-approved recipient.
10. A duplicate delivery ID does not produce an unbounded duplicate-send path.
11. No public database listener, R2 credential, or provider credential appears in the browser bundle.
12. The Bun build, type check, lint, format, and focused package checks pass.

## Rollback checks

The development deployment must not become a production dependency.

Destroying the Worker must not delete the workstation PostgreSQL service. Destroying the Worker must not delete retained private files by default.

The operator can revoke the Cloudflare Access service token. Revocation must stop new Hyperdrive connections.

No production DNS record, production database, or production sender changes during this contract.

## Completion

After acceptance, update `docs/system.md`, `docs/architecture.md`, and `STATE.md` with the implemented facts. Then remove this specification.

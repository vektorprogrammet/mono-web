# Native password recovery operations

Contract: [0054.2](../../design-specs/0054.2-native-password-recovery.md). This
implementation has a synthetic local PostgreSQL/browser/HTTP-mailbox observation;
it does not establish production email delivery or authorize a real cohort cutover.

## Compose one credential engine

Set `PASSWORD_RECOVERY_ENGINE=native` for the native cohort. Unset disables the dashboard recovery journey. Native AuthLive still owns the
backend recovery endpoints and their durable outbox; delivery requires the explicit
operator adapter and drain command below. The native dashboard rejects `legacy-symfony` and unknown selections
at startup and before native sign-in. The retained legacy adapter and dynamic code
route remain source for a separately authorized cutover; do not use them to reset
Better Auth credentials.

Build this journey with `DASHBOARD_MOUNT=/`: the frozen callback is
`{OAUTH_DASHBOARD_ORIGIN}/tilbakestill-passord`. Use the same mount when starting the
built dashboard. The server derives its mount from the built artifact and rejects
an explicitly different runtime mount. `OAUTH_DASHBOARD_ORIGIN` must be an exact
member of `NATIVE_IDENTITY_TRUSTED_ORIGINS`; `OAUTH_CANONICAL_ORIGIN` identifies the
backend. `API_URL` identifies that backend for the dashboard server.

Run `bun run start` in `apps/dashboard` after building its SDK and dashboard
artifacts. This starts the shared [logging-safe server](../../apps/dashboard/server.mjs),
which serves client assets and React Router SSR without request URL access logs.
Do not substitute `react-router-serve`: its default access log includes reset-token
queries. SSR/credential engine error diagnostics are bounded; the identity audit
owns the security event details.

## Deliver accepted reset requests

The backend accepts known-user requests only after its identity outbox and request
audit commit. That HTTP response does not mean an email was sent.

The acknowledged HTTP delivery adapter takes these explicit environment inputs:

| Variable                             | Meaning                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `PASSWORD_RESET_DELIVERY_URL`        | Approved HTTPS receiver endpoint; numeric loopback HTTP is allowed for local rehearsal. No embedded credentials, query or fragment. |
| `PASSWORD_RESET_DELIVERY_TOKEN`      | Receiver bearer credential, injected privately.                                                                                     |
| `PASSWORD_RESET_DELIVERY_TIMEOUT_MS` | Bounded acknowledgement timeout, 1–30000 milliseconds.                                                                              |
| `PASSWORD_RESET_DELIVERY_SENDER`     | Approved sender mailbox.                                                                                                            |

All four settings must be supplied together. An absent authority never marks mail
delivered. The adapter sends sender, effect ID, canonical recipient, the Better Auth
callback URL and expiry as JSON, with the effect ID in `Idempotency-Key`. An HTTP
2xx is the configured receiver acknowledgement; redirects are rejected. The
receiver must define what that acknowledgement commits, authenticate the sender,
protect recipient/token data, and document retention and duplicate handling. Delivery
is at least once unless the selected receiver proves idempotency. Neither an HTTP
acknowledgement nor this synthetic proof establishes human receipt of an email.

With the same backend/database/origin environment and delivery configuration, run
from the repository root:

```sh
bun run apps/backend/src/password-recovery/drain-main.ts --once
```

This operator command attempts one eligible effect. Pending and failed rows are
claimed with `SKIP LOCKED`; processing claims older than 60 seconds become eligible
again. A delivery attempt has a new claim fence. Invalid, expired or mismatched
verification state is quarantined without sending. Delivery status and its audit
commit together after the external acknowledgement. Inspect its bounded result
(`Delivered`, `Empty`, `Failed`, `Quarantined`, or `LostClaim`) and retry failed work
after addressing the delivery failure. CLI success means `Delivered` or `Empty`;
it does not assert that every queued or quarantined effect is complete.

A failed audit/status commit after external acceptance leaves a stale claim for
recovery and can cause duplicate email delivery. Do not clear or relabel failed
rows to manufacture a delivered result.

## Interpret reset outcomes

A successful reset response means Better Auth changed the password, consumed the
link, revoked all sessions, and the owned success audit completed. A reset 5xx has
an unknown outcome for the caller: the credential can already be changed, and a
session-deletion failure can leave old sessions live. The page directs the person
to request a new link. Recovery is not an atomic transaction across the credential
engine, session deletion, audit and mail receiver.

Reproduce the synthetic journey on a committed clean tree with:

```sh
bun run infra/host/password-recovery-check.ts
```

It starts disposable PostgreSQL, the actual backend, production dashboard and an
authenticated loopback HTTP mailbox. It observes normal credential rate limits,
so the full run waits several minutes. It exercises the operator command, browser
policy retry, old-password/session rejection, concurrent token consumption, expiry,
corrupted effects, stale claims, and injected enqueue/audit/session failures. Durable
evidence excludes reset tokens, credentials, recipient addresses and callback URLs.

Production release still requires an approved mail authority, an attested password
cohort migration with sign-in/reset ownership together, and separate deployment and
cutover authorization. No production provider, recipient, database or deployment is
selected by this document.

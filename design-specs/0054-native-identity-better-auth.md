# Design spec 0054 - native Identity authority via Better Auth

## Metadata

| Field | Value |
|---|---|
| Goal | Replace Symfony credentials/sessions and the fixture login path with one native Identity authority built on Better Auth, without giving it roles or access policy |
| Status | Contract remains frozen; implementation is present at integrated branch `f07b86d7babc041ee5f947b41381de094586e9d6`; runtime and acceptance evidence are pending |
| Base | `88ed2d6` |
| Depends on | 0039 database capability, 0040 capability topology, 0045 Effect Model/Service authority, 0053 Profile self-edit (proven pattern for actor-bound commands) |
| Operator boundary | No production data, remote PostgreSQL, provider, credential, deployment, or external notification effect. Disposable local PostgreSQL and Chromium evidence only |

## Problem

The native backend has no login endpoint. `POST /api/login` exists only as an E2E
fixture (`apps/dashboard/e2e/fixtures/login-api.mjs`); the SDK posts it blindly,
and the dashboard stores whatever opaque token the fixture mints in the
`jwt_token` cookie. Production actor resolution on the backend is a set of
static environment token maps (`ADMISSION_AUTH_TOKENS`,
`RECEIPT_AUTH_TOKENS`, `RECRUITION_*`, `ORGANIZATION_AUTH_TOKENS`) keyed by
bearer strings with no lifecycle: no expiry, no revocation, no password, no
audit. Symfony still owns `/login_check`, `/login`, and `/sso/login`.

Three illegal states are representable today:

1. Any string present in an env map authenticates forever.
2. The dashboard trusts a token whose issuer is a test fixture.
3. Identity truth lives in Symfony while every other authority is native.

## Decision: Auth as an Effect Service; Better Auth as its engine

**Auth is a first-class domain Service**, exactly like Profile and
Organization (spec 0045): a typed interface in `packages/domain`, consumed by
portable programs through `Auth.use(...)`. **better-auth never leaks above the
Layer boundary.** The concrete interpretation lives beside the other database
engines in `packages/database` (`AuthLive`), depends on the vektorprogrammet
`Database` capability for storage, wraps better-auth as its session/credential
engine, and is selected by composition roots (`apps/backend/src/main.ts`) -
never constructed inside request handlers.

```text
Portable programs            Effect seams                    Engines
(routes, workers)
      │                            │                             │
      │ Auth.use(...)              │ Service interface           │
      ├──────────────────────────► │ packages/domain/src/auth    │
      │                            │   service.ts, schema.ts,    │
      │                            │   errors.ts                 │
      │                            │             ▲               │
      │                            │             │ Layer.effect  │
      │ Database.use(...) ─────────┼─────► AuthLive               │
      │                            │       packages/database     │
      │                            │       wraps better-auth     │
      │                            │       + pg Pool/Kysely      │
```

Use [Better Auth](https://better-auth.com) `^1.7.1` (verified current release,
2026-08-18) as the engine instead of hand-rolling password hashing, session
issuance, cookie attributes, rotation, and revocation - a maintained, audited
dependency confined below the seam. What it owns and what it must never own
is frozen below.

### Ownership split (capability boundaries preserved)

```text
better-auth engine (inside AuthLive)   Native Effect authorities (unchanged)
├─ email+password credentials          ├─ Organization: departments, teams,
│   (account table, hashing)           │   memberships, ROLES
├─ sessions                            ├─ Profile: names + contacts
│   (issue, refresh, revoke)           ├─ Admissions, Recruitment, Economy …
└─ auth.* tables in the                └─ ALL authorization decisions
    dedicated "auth" schema                (never read from auth schema)
```

better-auth stores **identity and session state only**. Roles, department
membership, and access policy remain owned by the Organization/Profile/etc.
authorities per specs 0040/0045. Nothing in the `auth` schema is consulted for
authorization beyond "which person is this session".

### Frozen contracts

1. **One database.** Better Auth uses the same disposable authoritative
   PostgreSQL via the `pg` Pool/Kysely adapter. Its tables live in schema
   `auth` (connection `options=-c search_path=auth`). Domain tables stay in
   `public`, untouched.
2. **Schema is a checked-in derivation.** The Better Auth core schema
   (user/session/account/verification) is generated once with
   `npx auth@latest generate`, committed as
   `packages/database/migrations/0015-native-identity-better-auth.sql` scoped to
   the `auth` schema, and applied by the existing migration runner so PGlite
   previews receive the byte-identical schema. Upgrading Better Auth requires
   regenerating that file in the same commit as the version bump - the
   generation command is recorded in the file header comment.
3. **Identity linkage.** `auth.user.id` IS the `PersonId`
   (`person_profiles.person_id`). User rows are created by seed/import with
   `id` set to the existing personId (`advanced.database.generateId` override);
   no separate numeric identity, no join table, no nullable back-reference.
   A session therefore resolves to a person by construction, not by lookup.
4. **Single authentication surface.** The native backend mounts the Better Auth
   handler at `/api/auth/*` (catch-all, standard Request/Response). The
   dashboard login form posts to `/api/auth/sign-in/email`. The E2E login
   fixture and the SDK `POST /api/login` call are deleted in the cutover -
   no compatibility endpoint, no dual write.
5. **Actor resolution replaces env token maps.** A request carries the Better
   Auth session cookie; the backend extracts the session token and resolves
   `{ personId }` from `auth.session JOIN auth.user` (expiry-checked) through
   a new typed `Identity` Service. Role is then derived exactly as today from
   the admission/receipt/organization principal records owned by their
   authorities - those principals lose their token-keyed maps and become
   person-keyed lookups. Test Layers may inject synthetic `Identity`
   interpretations (the seam stays explicit); the env maps are removed from
   production wiring entirely.
6. **Dashboard session reads.** `requireAuth` stays the single dashboard gate.
   It forwards the incoming cookie to the backend's new strict
   `GET /api/me/session` (returns the actor projection or 401) and fails closed
   on anything else. The `jwt_token` cookie name dies with this slice;
   `expiredSessionRedirect` semantics are preserved.
7. **Session policy.** Cookie: httpOnly, SameSite=Lax, Secure in production
   (host-shared across dashboard/backend loopback ports, matching today's
   behavior). Expiry 7 days, `updateAge` 1 day, defaults otherwise. Password
   policy minimums are configured in the Better Auth instance, not scattered.
8. **No social providers, no SSO, no plugins** in this slice. `SsoController`
   parity is explicitly deferred with the rest of Symfony removal follow-ups
   that need external providers (operator boundary).

### Explicit exclusions

This slice does not import production passwords (no bcrypt-to-scrypt migration
job; first native login requires password reset via a later slice), does not
cut over password-reset email flows, does not add 2FA/passkey, does not deploy
anything, and does not change Profile/Organization schemas.

## Evidence

Real-browser journey on disposable PostgreSQL:

1. start backend + dashboard; open `/login`;
2. submit seeded credentials; observe redirect to `/dashboard`;
3. observe `Set-Cookie: better-auth.session_token` (httpOnly) issued by the
   native backend, zero requests to any fixture port or Symfony;
4. reload; session persists via cookie; `/api/me` returns stored values;
5. logout; observe session revoked (row gone/expired) and `/dashboard` redirects to `/login`;
6. replay a captured old session cookie; observe 401 fail-closed;
7. wrong password ten times; observe rate-limit rejection (Better Auth built-in);
8. automated accessibility check on the login page.

PostgreSQL proof: two concurrent requests sharing one session token after
logout - exactly zero succeed.

## Definition of done

1. This frozen contract precedes implementation commits.
2. `better-auth@^1.7.1` pinned; instance configured per §Frozen contracts.
3. Migration `0015` applies the generated `auth` schema through the existing
   runner; PGlite and PostgreSQL receive identical DDL.
4. `auth.user.id = PersonId` holds for every seeded row (checked by constraint
   plus focused test).
5. `/api/auth/*` is the only authentication surface; the fixture login server,
   `POST /api/login` SDK call, and `jwt_token` cookie are removed.
6. Backend resolves actors exclusively through the `Identity` Service; no
   production code reads `*_AUTH_TOKENS` env maps (test Layer injection only).
7. Dashboard `requireAuth` gates on `GET /api/me/session`; failure redirects.
8. Focused model, HTTP, SDK, and browser checks pass; root type/lint/build/test
   gates pass on the committed revision.

## Falsifiers

This slice is incomplete if one condition occurs:

- Any request authorizes by consulting an env token map outside a test Layer.
- A session resolves to a person absent from `person_profiles`.
- Role or permission data is read from the `auth` schema.
- A fixture issues a session accepted by production code.
- The dashboard renders authenticated content from a stale/revoked session.
- Logout leaves the session row usable.
- A second copy of Better Auth schema drifts from the regenerated migration.
- A stubbed-transport run is presented as real-browser journey evidence.

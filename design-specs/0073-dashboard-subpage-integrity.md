# 0073 — Dashboard Subpage Integrity

## Goal

Every navigation link in the dashboard resolves to a real, working route for the
signed-in persona, and the shell always presents the signed-in actor's real
identity — never mock data.

## Falsifiers (each must be falsifiable by a test or browser check)

1. **Every nav href resolves.** For each role-appropriate persona (admin,
   member), every audited href rendered in `apps/dashboard/app/routes/dashboard.tsx`
   returns HTTP 200 when allowed or an explicit HTTP 403 when the native
   authorization boundary denies it. No audited route returns 404 or 5xx.
2. **No nav link to a nonexistent route.** A route-level test walks
   `mainLinks`/`adminLinks` plus `profileLinks` and asserts that each href maps
   to an existing React Router route module.
3. **Member identity menu always present.** A signed-in member (non-admin)
   always sees the profile dropdown (Profil / Mine Utlegg / Logg ut) —
   `dashboardShellVisibility` must not gate `showIdentityMenu` on admin-only
   signals. `loadDashboardShell` must return a real Better Auth session
   identity when the organization profile boundary denies the actor.
4. **Landing data is warranted.** The dashboard index renders either a decoded
   actor summary or an explicit unavailable state — never `mockDashboard`
   constants ("Admin", "NTNU", 95/12/5).

## Root causes (evidence-backed, to be fixed)

- **A1 — Pathless-route mismatch.** Nav hrefs `/dashboard/sokere` (×2) and
  `/dashboard/intervjuer` (×1) pointed at pathless route files
  `dashboard_.sokere._index.tsx` / `dashboard_.intervjuer._index.tsx`.
  Implementation decision: restore the idiomatic nested filenames
  `dashboard.sokere._index.tsx` / `dashboard.intervjuer._index.tsx`. This keeps
  the established nav and browser journey URLs, and keeps both routes inside
  the apex `/dashboard/*` family.
- **A2 — Unhandled native capability gaps.** `/dashboard/assistenter`,
  `/dashboard/vikarer`, and `/dashboard/sponsorer` called SDK paths that the
  native backend does not expose, then allowed the typed 404 failure to become
  an SSR 500. Their loaders now preserve the SDK boundary and render an
  explicit unavailable state instead of fabricated rows. The member profile
  route likewise turns a native Profile NotInScope denial into a 200 page
  backed by the strict Better Auth session identity. Static stubs (attester,
  avdelinger, intervjufordeling, intervjusjema) remain out of scope for content
  implementation.
- **B1 — Mock greeting fallback.** `dashboard._index.tsx` fell back to
  `mockDashboard` (name "Admin", department "NTNU", 95/12/5) when
  `client.me.dashboard()` failed. The frozen 0071 implementation replaces this
  with an explicit typed unavailable state; no new `/api/me/dashboard` endpoint
  is introduced.
- **B2 — Identity menu gating.** `dashboardShellVisibility` correctly gates
  `showIdentityMenu` on `user !== null`, but `loadDashboardShell` returned
  `user: null` on ProfileRejection (AuthorityInactive/NotInScope). The shell
  now reads the authenticated Better Auth session identity for that denial
  path, preserves `isAdmin: false`, and keeps organization navigation hidden
  while the identity menu remains available.

## Non-goals

- No deploy, push, or changes to other agents' worktrees or the live bundle.
- No filling in static-stub subpages with real content (attester, avdelinger,
  intervjufordeling, intervjusjema) — only their routes must resolve.
- No redesign of the authorization model; fixes use native endpoints/SDK with
  strict schemas, no mocks (except the existing explicit `isFixtureMode` path,
  which must never leak into real sessions).

## Verification plan

- Disposable PG 17 + native backend + built dashboard locally (pattern from
  `e2e/run-real-native-content-publication.mjs`, ports 45260–45264).
- Personas: admin (`journey-0065-admin`, global admin grant) and a member.
- Route-level vitest asserting every nav href has a matching route file.
- Persona browser journey (Playwright, chromium) with sanitized screenshots
  in /tmp.
- Observed matrix: all 21 admin-visible destinations return 200 except the
  recruitment routes (`sokere`, `intervjuer`), which return the expected 403
  for a global administrator without department scope. Both member identity
  destinations (`profile`, `mine-utlegg`) return 200.

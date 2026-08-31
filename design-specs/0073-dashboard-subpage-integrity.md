# 0073 — Dashboard Subpage Integrity

## Goal

Every navigation link in the dashboard resolves to a real, working route for the
signed-in persona, and the shell always presents the signed-in actor's real
identity — never mock data.

## Falsifiers (each must be falsifiable by a test or browser check)

1. **Every nav href resolves.** For each role-appropriate persona (admin,
   member), every href rendered in `apps/dashboard/app/routes/dashboard.tsx`
   (`mainLinks` / `adminLinks`, ~lines 137–264) returns HTTP 200 when loaded in
   a running dashboard backed by a real native backend + disposable PostgreSQL.
2. **No nav link to a nonexistent route.** A route-level test asserts every
   href in `mainLinks`/`adminLinks` has a matching route file, accounting for
   React Router's trailing-underscore pathless convention
   (`dashboard_.sokere._index.tsx` is served at `/sokere`, not
   `/dashboard/sokere`).
3. **Member identity menu always present.** A signed-in member (non-admin)
   always sees the profile dropdown (Profil / Mine Utlegg / Logg ut) —
   `dashboardShellVisibility` must not gate `showIdentityMenu` on admin-only
   signals, and `loadDashboardShell` must not return `user: null` for a
   signed-in member whose profile read succeeds.
4. **Greeting uses actor name.** The dashboard index greeting renders the
   signed-in actor's real name and department — never the `mockDashboard`
   constants ("Admin", "NTNU", 95/12/5) — for any non-fixture-mode session.

## Root causes (evidence-backed, to be fixed)

- **A1 — Pathless-route mismatch.** Nav hrefs `/dashboard/sokere` (×2) and
  `/dashboard/intervjuer` (×1) point at route files
  `dashboard_.sokere._index.tsx` / `dashboard_.intervjuer._index.tsx`, whose
  trailing-underscore convention makes them PATHLESS: they are served at
  `/sokere` and `/intervjuer`, so the nav links 404. Fix direction: correct the
  hrefs (or rename the route files) so href and served URL agree — decided
  during implementation, whichever is the smaller diff consistent with
  existing conventions.
- **A2 — Loader failures on real backend.** Subpage loaders calling the SDK
  (assistenter, brukere, epostliste, mine-utlegg, opptaksperioder, profile)
  must be reproduced against a locally running native backend + disposable PG
  to find 403/404/500 loader failures. Static stubs (attester, avdelinger,
  intervjufordeling, intervjusjema) are out of scope for loader fixes.
- **B1 — Mock greeting fallback.** `dashboard._index.tsx` falls back to
  `mockDashboard` (name "Admin", department "NTNU", 95/12/5) when
  `client.me.dashboard()` throws — this produced the observed "Velkommen,
  Admin" + NTNU for a member login. Greeting must use the real actor name.
- **B2 — Identity menu gating.** `dashboardShellVisibility` gates
  `showIdentityMenu` on `user !== null`; `loadDashboardShell` returns
  `user: null` on ProfileRejection (AuthorityInactive/NotInScope). Members
  must always get the identity dropdown (Profil / Mine Utlegg / Logg ut) when
  signed in.

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

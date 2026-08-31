# Design spec 0071 — truthful dashboard landing and honest navigation surface

## Metadata

| Field      | Value                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------- |
| Goal       | Authenticated members see only warranted current values or an explicit unavailable/error state; mock business data removed; homepage login and contact entry points stop 404-ing |
| Status     | Frozen                                                                                            |
| Actor      | Authenticated member (dashboard), anonymous visitor (homepage)                                     |
| Dependency | SDK `me.dashboard()`, dashboard auth seam, apex edge worker, homepage organization SDK domain      |
| Evidence   | Route-module unit tests; apex worker/surface tests; local browser journey evidence (disposable PG + Chromium) |
| Scope hold | No deploy, no production, no new backend endpoints                                                 |

## Problem

1. `apps/dashboard/app/routes/dashboard._index.tsx` reads the member's real summary from
   `GET /api/me/dashboard`, then falls back to a seeded `mockDashboard`
   (`Admin / NTNU / 95 / 12 / 5`) on any failure. Plausible fake business data is
   therefore representable in production UI. The mock even masks the fact that the
   legacy Symfony payload shape does not satisfy the SDK `DashboardStats` schema.
2. The homepage "Kontakt" nav link targets `/kontakt`, but the live apex stage serves
   an HTTP 404 for it. Live evidence (2026-08-31, stage `dev-main`): the served
   document manifest contains `routes/_home.kontakt` and
   `routes/_home.kontakt._index` (so the deployed bundle is current and apex
   routing is correct), yet the SSR error stream carries
   `root: ErrorResponse "Kontaktavdelingen finnes ikke." 404`. Root cause:
   `GET /api/departments` on the same stage returns `200 []` (zero active
   departments), and `loadContactPage` throws the 404 when no department exists.
   The route is healthy; the stage's organization data is empty.
3. The homepage "Logg inn" button links to the legacy Symfony path
   `/kontrollpanel`. The apex classifier does not route it, so the homepage
   itself serves `404 "Error: No route matches URL \"/kontrollpanel\""`.

## User journeys

1. An authenticated member opens `/dashboard` (fresh load). The loader reads the
   summary through the authenticated SDK client. The page displays only values
   warranted by the decoded API response, from that actor's own data.
2. If the summary read fails, the page renders an explicit unavailable state
   (role=alert) with no fabricated numbers, names, or departments.
3. Two different members see their own distinct values; neither sees seeded or
   cross-persona figures.
4. An anonymous visitor opens `/kontakt`: the contact page renders honestly from
   backend data — the real department list, an explicit 503 state when the
   organization projection is temporarily unusable, and a truthful 404 only when
   a requested department genuinely does not exist.
5. An anonymous visitor clicks "Logg inn" on the homepage: they land on the
   dashboard login (`/login?redirectTo=%2Fdashboard`) and, after successful
   authentication, arrive at `/dashboard`. Legacy `/kontrollpanel` bookmarks are
   redirected by the apex edge worker to `/login?redirectTo=%2Fdashboard`.

## Constraints

- The SDK `me.dashboard()` boundary and its `DashboardStats` schema stay. If the
  backend cannot warrant the summary, the route renders an explicit typed
  unavailable state — no silent defaults, no fixture substitution.
- The foldkit dashboard shell's `LandingSummary` (Available/Unavailable) is the
  canonical landing-state vocabulary; the React route adopts the same contract
  without touching the foldkit shell.
- The apex legacy redirect is additive and conservative: exact-path only
  (`/kontrollpanel`), query preserved, `.data`-suffixed requests included,
  host/stage guards unchanged and evaluated first.
- Homepage contact rendering changes no SDK schema and adds no endpoints; the
  empty-department case moves from a misleading 404 to an explicit, recoverable
  503 payload the UI presents as "temporarily unavailable".

## Non-goals

- No dashboard redesign, no new summary fields, no new backend endpoints.
- No fix for the upstream emptiness of the stage's department data (an
  organization-import concern owned elsewhere); this spec only makes the UI
  honest about it.
- No production deployment; no provider effects beyond the existing local
  evidence topology.

## Definition of done

1. `dashboard._index.tsx` contains no `mockDashboard`, no fixture fallback, and
   no dead exports; the route module's only exports are route-module contract
   members (loader, default, meta if any).
2. Forced summary failure renders the explicit unavailable state; no number,
   name, or department from any fixture can appear in the landing route module.
3. Two seeded synthetic personas each see their own warranted values on fresh
   load; a forced backend failure shows the unavailable state with no mock
   figures; no console/page errors on the happy path.
4. The homepage login entry point targets `/login?redirectTo=%2Fdashboard`;
   the apex worker redirects exact legacy `/kontrollpanel` requests (document
   and `.data`) to `/login?redirectTo=%2Fdashboard` preserving the query, with
   positive, `.data`, query-preservation, and host-guard tests.
5. `/kontakt` renders the live organization data honestly: 503 ("midlertidig
   utilgjengelig") when the projection is unusable or empty, 404 only for a
   genuinely unknown requested department slug.
6. Focused unit/domain tests defend the loader contract and the apex redirect
   contract; no existing test asserts mock landing figures.
7. Existing local e2e scripts that exercise the dashboard landing remain green
   (run what exists locally with disposable PostgreSQL and Chromium, heavy jobs
   one at a time).

## Falsifiers

- Any rendered landing value (`95`, `12`, `5`, `Admin`, `NTNU`, or any other)
  that no backend response warranted for the signed-in actor.
- A failed summary read producing numbers, an empty success, or a crash page
  instead of the explicit unavailable state.
- Two personas observing identical fabricated values, or persona A's values
  appearing for persona B.
- `/kontakt` rendering invented departments, an empty success state, or a 404
  while the organization projection is empty or unreachable.
- "Logg inn" landing anywhere but the dashboard login flow, or a legacy
  `/kontrollpanel` bookmark 404-ing at the apex.
- Any test asserting the seeded mock figures remains in the suite.

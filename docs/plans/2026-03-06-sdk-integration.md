# SDK Integration Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace hardcoded data in homepage (SSG) and dashboard (SSR) with live API fetching via @monoweb/sdk, using React Router loaders.

**Architecture:** Homepage uses SSG — loaders run at build time, output is static HTML. Dashboard uses SSR — loaders run per-request on the server. Both use `apiClient.GET()` in loaders (server-side), not client-side useQuery. TanStack Query retained for dashboard client-side mutations/revalidation. Private Railway domain used for dashboard SSR to avoid egress.

**Tech Stack:** React Router 7 (loaders), @monoweb/sdk (openapi-fetch), @tanstack/react-query (dashboard mutations), Symfony API Platform (backend)

---

## Phase 0: Architecture Foundation

### Task 0.1: Switch Dashboard to SSR

**Files:**
- Modify: `apps/dashboard/react-router.config.ts`
- Modify: `apps/dashboard/railway.toml`

**Step 1: Enable SSR in React Router config**

In `apps/dashboard/react-router.config.ts`, change `ssr: false` to `ssr: true`.

**Step 2: Update Railway startCommand**

In `apps/dashboard/railway.toml`, change:
```toml
startCommand = "npx serve build/client -s -l $PORT"
```
to:
```toml
startCommand = "npx react-router-serve build/server/index.js"
```

**Step 3: Update Railway watchPatterns**

Add `pnpm-workspace.yaml` and `pnpm-lock.yaml` to watchPatterns since they affect builds.

**Step 4: Verify build**

Run: `turbo -F @monoweb/dashboard build`
Expected: Both client and server bundles generated (no "Removing the server build" message).

**Step 5: Commit**

```
feat(dashboard): switch to SSR mode for server-side data fetching
```

---

### Task 0.2: Add Server-Side API URL Config

**Files:**
- Modify: `packages/sdk/src/config.ts`
- Modify: `apps/dashboard/railway.toml` (env var)

**Step 1: Update SDK config for server-side usage**

The current config uses `import.meta.env.VITE_*` which only works client-side. For SSR loaders, we need server-side env vars too. Update `packages/sdk/src/config.ts`:

```typescript
const DEFAULT_API_URL = "https://vektorprogrammet-production.up.railway.app";

// Server-side: process.env, Client-side: import.meta.env
export const apiUrl: string =
  (typeof process !== "undefined" && process.env?.API_URL) ||
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_URL) ||
  DEFAULT_API_URL;

export const isFixtureMode: boolean =
  (typeof process !== "undefined" && process.env?.API_MODE === "fixture") ||
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_MODE === "fixture") ||
  false;
```

**Step 2: Set Railway env var for dashboard (private domain)**

```bash
railway variable set -s dashboard 'API_URL=http://vektorprogrammet.railway.internal'
```

Note: Homepage keeps `VITE_API_URL` (public domain, build-time). Dashboard uses `API_URL` (private domain, runtime).

**Step 3: Update .env.example files**

Add `API_URL` to both `.env.example` files:
```
# Server-side API URL (for SSR loaders — use private domain on Railway)
# API_URL=http://localhost:8000
```

**Step 4: Commit**

```
feat(sdk): support server-side API_URL for SSR loaders
```

---

## Phase 1: Homepage SSG (Public Endpoints)

Data fetched at build time via loaders. Pages served as static HTML.

### Task 1.1: Sponsors

**Files:**
- Modify: `apps/homepage/src/routes/_home._index.tsx`
- Keep: `apps/homepage/src/api/sponsor.ts` (fixture fallback)

**Step 1: Add loader to home page**

The home page currently has hardcoded sponsor images. Add a React Router `loader` that fetches from `/api/sponsors`:

```typescript
import { apiClient, isFixtureMode } from "@monoweb/sdk";
import { getSponsors } from "~/api/sponsor";

export async function loader() {
  if (isFixtureMode) {
    return { sponsors: getSponsors() };
  }
  const { data } = await apiClient.GET("/api/sponsors");
  return { sponsors: data ?? getSponsors() };
}
```

In the component, use `useLoaderData()` to access sponsors.

**Step 2: Verify build with prerendering**

Run: `turbo -F @monoweb/homepage build`
Expected: Prerendered pages generated, sponsors fetched at build time.

**Step 3: Commit**

```
feat(homepage): fetch sponsors from API at build time
```

---

### Task 1.2: Statistics

**Files:**
- Modify: `apps/homepage/src/routes/_home._index.tsx`

**Step 1: Extend home page loader**

Add statistics fetch to the existing loader:

```typescript
export async function loader() {
  if (isFixtureMode) {
    return { sponsors: getSponsors(), stats: null };
  }
  const [sponsorRes, statsRes] = await Promise.all([
    apiClient.GET("/api/sponsors"),
    apiClient.GET("/api/statistics"),
  ]);
  return {
    sponsors: sponsorRes.data ?? getSponsors(),
    stats: statsRes.data ?? null,
  };
}
```

Replace hardcoded "2218 assistenter" / "608 teammedlemmer" with `stats.assistantCount` / `stats.teamMemberCount`, falling back to the current hardcoded values if null.

**Step 2: Commit**

```
feat(homepage): fetch statistics from API
```

---

### Task 1.3: Departments & Contacts (Kontakt page)

**Files:**
- Modify: `apps/homepage/src/routes/_home.kontakt.tsx` or `_home.kontakt._index.tsx`
- Modify: `apps/homepage/src/components/kontakt-tabs.tsx`
- Keep: `apps/homepage/src/api/kontakt.ts` (fixture fallback)

**Step 1: Add loader fetching departments**

```typescript
import { apiClient, isFixtureMode } from "@monoweb/sdk";

export async function loader() {
  if (isFixtureMode) return { departments: null };
  const { data } = await apiClient.GET("/api/departments");
  return { departments: data };
}
```

**Step 2: Update kontakt-tabs to use API data with fixture fallback**

Use loader data when available, fall back to `info(department)` from the existing hardcoded data.

API department schema: `{ id, name, shortName, email, address, city, latitude, longitude, logoPath, active }`
Existing schema: `{ name, description, email, contacts[] }`

The API provides `name`, `email`, `address`, `city` which covers most needs. `contacts[]` (individual people) may not be in the API — keep fixture data for contact persons.

**Step 3: Commit**

```
feat(homepage): fetch department data for contacts page
```

---

### Task 1.4: Teams

**Files:**
- Modify: `apps/homepage/src/routes/_home.team.tsx`
- Modify: `apps/homepage/src/components/team-tabs.tsx`
- Keep: `apps/homepage/src/api/team.ts` (fixture fallback — has member counts and descriptions not in API)

**Step 1: Add loader fetching teams and departments**

```typescript
export async function loader() {
  if (isFixtureMode) return { teams: null, departments: null };
  const [teamsRes, deptsRes] = await Promise.all([
    apiClient.GET("/api/teams"),
    apiClient.GET("/api/departments"),
  ]);
  return { teams: teamsRes.data, departments: deptsRes.data };
}
```

**Step 2: Map API teams to component format**

API team: `{ id, name, email, shortDescription, active }`
Hardcoded: `{ title, text, mail, numberOfMembers, url }`

Note: API lacks `numberOfMembers`. Either:
- Add it to the API resource (backend change), or
- Omit member counts when using live data, keep them in fixture mode

**Step 3: Commit**

```
feat(homepage): fetch teams from API with fixture fallback
```

---

### Tasks 1.5-1.7: Static Content Pages (om-oss, foreldre, assistenter)

**Keep hardcoded.** These pages contain structured CMS-like content (cards, paragraphs, images) that don't map well to the API's `StaticContent` endpoint (which returns raw HTML blobs). FAQs also have no API endpoint.

No changes needed for these pages — they remain fixture-only data.

---

## Phase 2: Dashboard SSR (Authenticated Endpoints)

Data fetched per-request via loaders. Requires JWT auth flow (future task — for now, use fixture mode for auth-protected routes).

### Task 2.1: Public Data — Field of Studies

**Files:**
- Modify: `apps/dashboard/app/routes/dashboard.profile.rediger._index.tsx`
- Keep: `apps/dashboard/app/mock/api/linjer.ts` (fixture fallback)

**Step 1: Add loader for study lines**

```typescript
import { apiClient, isFixtureMode } from "@monoweb/sdk";
import { linjer } from "~/mock/api/linjer";

export async function loader() {
  if (isFixtureMode) return { studyLines: linjer };
  const { data } = await apiClient.GET("/api/field_of_studies");
  // API returns objects with { id, name, shortName }, mock is string[]
  const studyLines = data?.map((f: any) => f.shortName) ?? linjer;
  return { studyLines };
}
```

**Step 2: Update combobox to use loader data**

Replace direct import of `linjer` with `useLoaderData()`.

**Step 3: Commit**

```
feat(dashboard): fetch study lines from API
```

---

### Task 2.2: Profile Page (requires auth — scaffold only)

**Files:**
- Modify: `apps/dashboard/app/routes/dashboard.profile._index.tsx`
- Keep: `apps/dashboard/app/mock/api/data-profile.ts` (fixture fallback)

**Step 1: Add loader with auth placeholder**

```typescript
import { apiClient, isFixtureMode } from "@monoweb/sdk";
import { getProfileData } from "~/mock/api/data-profile";

export async function loader({ request }: { request: Request }) {
  if (isFixtureMode) return { profile: getProfileData() };
  // TODO: Extract JWT from cookie/session and pass as Authorization header
  // const token = await getSessionToken(request);
  // const { data } = await apiClient.GET("/api/me", {
  //   headers: { Authorization: `Bearer ${token}` },
  // });
  return { profile: getProfileData() }; // fixture until auth is wired
}
```

**Step 2: Update component to use useLoaderData()**

**Step 3: Commit**

```
feat(dashboard): scaffold profile loader with auth placeholder
```

---

### Task 2.3: Users Page (requires admin auth — scaffold only)

Same pattern as 2.2 — add loader with fixture fallback, placeholder for JWT auth.

API: `GET /api/admin/users` returns `{ activeUsers: string[], inactiveUsers: string[], departmentName }` — IDs not full objects. Will need individual fetches or a different admin endpoint.

**Commit:** `feat(dashboard): scaffold users loader with auth placeholder`

---

### Task 2.4: Applicants Page (requires admin auth — scaffold only)

Same pattern. API: `GET /api/admin/applications` returns IDs grouped by status.

**Commit:** `feat(dashboard): scaffold applicants loader with auth placeholder`

---

## Phase 3: Auth Flow (Future)

Not in scope for this plan. Required before dashboard can fetch real data:

1. Login page with `POST /api/login` → JWT token
2. Session/cookie management for SSR
3. Auth middleware in dashboard loaders
4. Protected route wrapper

---

## Notes

### Private Domain Usage
- **Dashboard SSR**: Uses `API_URL=http://vektorprogrammet.railway.internal` (no egress)
- **Homepage SSG**: Uses `VITE_API_URL=https://vektorprogrammet-production.up.railway.app` (build-time only, minimal cost)

### Fixture Mode
- Set `VITE_API_MODE=fixture` (client) or `API_MODE=fixture` (server) to use hardcoded data
- Each loader falls back to existing hardcoded data when fixture mode is on or when API returns no data
- Existing `src/api/` and `app/mock/api/` files preserved as fixtures

### Data Shape Gaps
- **Teams**: API missing `numberOfMembers` field — keep fixture data for member counts
- **Contacts**: API has department info but not individual contact persons — keep fixture for contacts
- **Static content**: Om Oss, Foreldre, Assistenter, FAQs — no matching API structure, stay hardcoded
- **Dashboard users/applications**: API returns ID arrays, not full objects — may need backend updates or multiple fetches

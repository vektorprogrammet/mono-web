# Homepage Migration

The homepage is mostly complete. Public pages are built in React Router with SSR and prerendering. Most content is static (hardcoded Norwegian text). Dynamic data comes from 4 API endpoints.

## Current State

### Live API endpoints

| Endpoint | Route | Data |
|----------|-------|------|
| `GET /api/sponsors` | `/` | Sponsor logos and links |
| `GET /api/statistics` | `/` | Assistant/team member counts |
| `GET /api/teams` | `/team` | Team list per department |
| `GET /api/departments` | `/team`, `/kontakt` | Department info, contact details |

### Static content (fixtures)

These pages use hardcoded data in `src/api/`. The content describes the organization and rarely changes. Keep as code unless editorial needs arise.

| Route | Fixture source | Migrate to API? |
|-------|---------------|-----------------|
| `/om-oss` | `src/api/about.ts` | No |
| `/assistenter` | `src/api/assistenter.ts` | Later — could show real admission status |
| `/foreldre` | `src/api/foreldre.ts` | No |
| `/skoler` | `src/api/skoler.ts` | Later — could show real school list |
| `/team/*` (subpages) | `src/api/team.ts` | No — team member data from `/api/teams` already used |
| `/kontakt/*` (subpages) | `src/api/kontakt.ts` | No — department data from `/api/departments` already used |
| FAQs | `src/api/faq.ts` | No |

### Flag for later

These could benefit from API data once the dashboard migration is further along:

1. **`/assistenter`** — Show whether applications are currently open (needs `GET /api/admission_periods` to check `hasActiveAdmission()`).
2. **`/skoler`** — Show real school list per department (API exists: `GET /api/admin/scheduling/schools`, but needs a public variant).

## Remaining work

### 1. Application form

The monolith serves the application form as a Twig-rendered page. This is the only homepage feature that blocks full replacement.

**What it needs:**
- Route: `/sok` or `/assistenter/sok`
- Check active admission period for the selected department (user picks department, not inferred — they haven't logged in yet)
- Form fields: availability (mon-fri), substitute preference, double position, preferred school, language, special needs
- Submit via `POST /api/applications` (endpoint exists)
- Show confirmation or "applications closed" based on admission period

**Depends on:**
- `GET /api/admission_periods` (public, filtered by department + active semester)
- `POST /api/applications` (authenticated — user must register/login first)
- User registration flow (currently monolith-only)

### 2. User registration

The monolith handles user registration via Twig forms. The homepage needs at minimum a registration page for new applicants, or a redirect to the dashboard login.

**Options:**
- **A)** Build registration in the homepage (separate from dashboard login)
- **B)** Redirect to dashboard for auth, return to homepage after
- **C)** Defer — keep application form in monolith until dashboard auth covers registration

Recommend **C** for now. The application form is the last homepage blocker, and registration is a dashboard concern.

## Definition of done

Homepage replaces the monolith's public pages when:
- [x] All informational pages rendered
- [x] Sponsor and statistics data from API
- [x] Team and department data from API
- [x] SSR + prerendering for SEO
- [ ] Application form functional (or deferred to monolith)
- [ ] Admission status shown on `/assistenter`

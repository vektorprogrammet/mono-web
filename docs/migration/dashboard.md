# Dashboard Migration

The dashboard has 23 routes. Most call real API endpoints but render read-only lists with no create/edit/workflow capabilities. 6 routes are empty shells. Organized below by user journey.

## Current State

| Route | English | API endpoint | Functional? |
|-------|---------|-------------|-------------|
| `/dashboard` | Home | `GET /api/me/dashboard` | Read-only summary |
| `/dashboard/brukere` | Users | `GET /api/admin/users` | Read-only list |
| `/dashboard/sokere` | Applicants | `GET /api/admin/applications` | Read-only list |
| `/dashboard/intervjuer` | Interviews | `GET /api/admin/interviews` | Read-only list |
| `/dashboard/vikarer` | Substitutes | `GET /api/admin/substitutes` | Read-only list |
| `/dashboard/assistenter` | Assistants | `GET /api/admin/scheduling/assistants` | Read-only list |
| `/dashboard/skoler` | Schools | `GET /api/admin/scheduling/schools` | Read-only list |
| `/dashboard/statistikk` | Statistics | `GET /api/admin/admission-statistics` | Read-only |
| `/dashboard/utlegg` | Expenses | `GET /api/admin/receipts` | Read-only list |
| `/dashboard/teaminteresse` | Team interest | `GET /api/admin/team-interest` | Read-only list |
| `/dashboard/epostliste` | Mailing list | `GET /api/admin/mailing-lists` | Read-only list |
| `/dashboard/team` | Teams | `GET /api/teams` | Read-only list |
| `/dashboard/sponsorer` | Sponsors | `GET /api/sponsors` | Read-only list |
| `/dashboard/linjer` | Fields of study | `GET /api/field_of_studies` | Read-only list |
| `/dashboard/profile` | Profile | `GET /api/me` | Read-only (with fixture fallback) |
| `/dashboard/profile/rediger` | Edit profile | `GET /api/field_of_studies` | Partial form |
| `/login` | Login | `POST /api/login` | Functional |
| `/glemt-passord` | Forgot password | `POST /api/password_resets` | Functional |
| `/dashboard/attester` | Certificates | — | Empty shell |
| `/dashboard/avdelinger` | Departments | — | Empty shell |
| `/dashboard/intervjufordeling` | Interview distribution | — | Empty shell |
| `/dashboard/intervjusjema` | Interview schemas | — | Empty shell |
| `/dashboard/opptaksperioder` | Admission periods | — | Empty shell |
| `/dashboard/tidligere-assistenter` | Previous assistants | — | Empty shell |

**API naming convention:** Admin endpoints use **hyphens**: `/api/admin/admission-periods`, `/api/admin/interview-schemas`, `/api/admin/team-memberships`, `/api/admin/assistant-histories`. Exception: `/api/field_of_studies` (public endpoint, uses underscores).

---

## Journey 1: Recruitment Pipeline

**Who:** Team leaders, admins during recruitment season.
**Flow:** Open admission -> Receive applications -> Schedule interviews -> Conduct & score -> Assign to schools.

This is the highest-value journey. It's what the organization does twice a year and involves the most complex state machines. See [contracts/application.md](contracts/application.md) and [contracts/interview.md](contracts/interview.md).

### 1.1 Admission period management

**Route:** `/dashboard/opptaksperioder` (admission periods — empty shell)
**API:** `GET/POST/PUT /api/admin/admission-periods` (confirmed in `AdminAdmissionPeriodWriteResource.php`)

Build:
- List admission periods for current department + semester
- Create/edit form: start date, end date, linked semester, department
- Show active/inactive status (computed from date range vs now)
- Link to info meeting setup (optional)

No state machine — admission periods are immutable time windows. Validation: `endDate > startDate`, one per department per semester.

**Note:** This is a prerequisite for the homepage application form AND all other Journey 1 features. Consider implementing as a standalone quick win.

### 1.2 Application review

**Route:** `/dashboard/sokere` (applicants — read-only list)
**API:** `GET /api/admin/applications` (exists), `POST /api/admin/applications` (exists), `PUT /api/admin/applications/{id}` (exists)

Build:
- Application list -> detail view
- Display computed status (see [contracts/application.md](contracts/application.md) — status is derived, not stored)
- Filter by status, admission period
- Action: assign interview to application (transition: `RECEIVED -> INVITED`)

### 1.3 Interview scheduling

**Route:** `/dashboard/intervjuer` (interviews — read-only list)
**API:** `GET /api/admin/interviews` (exists), mutation endpoints exist

Build:
- Interview list with status badges (`NO_CONTACT`, `PENDING`, `ACCEPTED`, `REQUEST_NEW_TIME`, `CANCELLED`)
- Schedule form: datetime, room, campus, interviewer, co-interviewer
- Send confirmation (triggers status -> `PENDING`, sends email with response code — email is a server-side side effect)
- Handle reschedule requests (see [contracts/interview.md](contracts/interview.md) — reschedule cycle)
- Reminder system is backend-only (max 3, scheduled task). Dashboard shows reminder count but doesn't trigger them.

### 1.4 Interview distribution

**Route:** `/dashboard/intervjufordeling` (interview distribution — empty shell)
**API:** `POST /api/admin/interviews/assign`, `POST /api/admin/interviews/bulk-assign` (confirmed in SDK)

Build:
- Bulk assignment of interviewers to unassigned interviews
- View interviewer availability/load
- Manual assignment (no auto-distribute algorithm found in monolith)

### 1.5 Interview schema management

**Route:** `/dashboard/intervjusjema` (interview schemas — empty shell)
**API:** `GET/POST/PUT /api/admin/interview-schemas` (confirmed, note hyphens)

Build:
- List interview schemas (question templates)
- Create/edit schema: name, questions (ordered list)
- Each question has: text, type, help text (question type enum needs investigation from monolith)
- Schema is selected when conducting an interview

### 1.6 Conduct & score interview

**Not a separate route — part of interview detail view.**

Build:
- Interview conduct form: answer each question from schema, fill score (`explanatoryPower`, `roleModel`, `suitability`, `suitableAssistant`), mark `interviewed = true`
- Draft save: save scores without finalizing (`isDraft()` state — see [contracts/interview.md](contracts/interview.md))
- Score summary with `suitableAssistant` recommendation field
- Transition: sets `interviewed = true` and `conducted = now()`

### 1.7 School assignment

**Route:** `/dashboard/assistenter` (assistants — read-only), `/dashboard/skoler` (schools — read-only)
**API:** `GET /api/admin/scheduling/assistants`, `GET /api/admin/scheduling/schools`, `PUT /api/admin/assistant-histories/{id}` (exists). Creation endpoint (`POST`) needs verification — may need to be built.

Build:
- View schools with capacity and current assignments
- Assign interviewed applicants to schools (creates `AssistantHistory` record)
- Select bolk (time slot) and workdays
- Transition: application status becomes `ASSIGNED` (computed from `user.isActiveAssistant()`)

---

## Journey 2: Team Operations

**Who:** Team leaders managing their team.
**Flow:** View team -> Manage memberships -> Handle substitutes -> Issue certificates.

### 2.1 Team management

**Route:** `/dashboard/team` (teams — read-only list)
**API:** `GET /api/teams`, `GET/POST/PUT /api/admin/team-memberships` (note hyphens)

Build:
- Team detail view with member list
- Add/remove members (create/end TeamMembership — requires `Position` selection)
- Toggle team leader flag
- Suspend/unsuspend members
- See [contracts/membership.md](contracts/membership.md) — note that `isActive()` and `isSuspended` are independent dimensions

### 2.2 Team interest

**Route:** `/dashboard/teaminteresse` (team interest — read-only list)
**API:** `GET /api/admin/team-interest`

Build:
- List users who expressed team interest during application
- Action: invite to team (create TeamMembership)

### 2.3 Substitutes

**Route:** `/dashboard/vikarer` (substitutes — read-only list)
**API:** `GET /api/admin/substitutes`

A **substitute** is an assistant who fills in at a school when the assigned assistant is unavailable. Substitutes mark themselves as available; schools/admins request coverage.

Build:
- List substitute requests and available substitutes
- Match substitutes to schools needing coverage
- Simple assignment — no complex state machine

### 2.4 Certificates

**Route:** `/dashboard/attester` (certificates — empty shell)
**API:** `GET /api/admin/certificates`

Build:
- List certificate requests
- Generate/download certificate (PDF — generation approach TBD: server-side Symfony or client-side)
- Mark as issued

### 2.5 Previous assistants

**Route:** `/dashboard/tidligere-assistenter` (previous assistants — empty shell)
**API:** `GET /api/admin/assistant-histories` (note hyphens)

Build:
- List AssistantHistory records (read-only, filterable by semester/department)
- Historical view of who served where

---

## Journey 3: Finance

**Who:** Team leaders (submit), admins (approve).
**Flow:** Submit receipt -> Admin reviews -> Approve or reject.

### 3.1 Receipt management

**Route:** `/dashboard/utlegg` (expenses — read-only list)
**API:** `POST /api/receipts` (create, non-admin path), `GET /api/admin/receipts` (list), `PUT /api/admin/receipts/{id}/status` (admin status change)

Build:
- List receipts with status filter (pending, refunded, rejected)
- Submit form: description, amount, receipt date, photo upload (upload mechanism TBD — multipart/base64/separate endpoint)
- Admin actions: approve (-> refunded) or reject (-> rejected)
- See [contracts/receipt.md](contracts/receipt.md) — simple 3-state DAG

---

## Journey 4: Analytics

**Who:** Admins, team leaders.

### 4.1 Statistics

**Route:** `/dashboard/statistikk` (statistics — read-only)
**API:** `GET /api/admin/admission-statistics`

Currently functional as read-only. Enhance with:
- Charts/visualizations (application counts, acceptance rates)
- Semester comparison
- Export capability

### 4.2 Mailing lists

**Route:** `/dashboard/epostliste` (mailing list — read-only)
**API:** `GET /api/admin/mailing-lists`

Build:
- Generate email lists by role/team/department
- Copy-to-clipboard or export
- Filter by active members, assistants, etc.

---

## Journey 5: Admin

**Who:** Admins only.

### 5.1 User management

**Route:** `/dashboard/brukere` (users — read-only list)
**API:** `GET /api/admin/users`, `POST/PUT /api/admin/users`

Build:
- User detail view
- Edit form: name, email, roles, active status
- Activate/deactivate users
- Role assignment (`ROLE_USER` -> `TEAM_MEMBER` -> `TEAM_LEADER` -> `ADMIN`)

### 5.2 Department management

**Route:** `/dashboard/avdelinger` (departments — empty shell)
**API:** `GET/POST/PUT /api/admin/departments`

Build:
- List departments
- Create/edit form: name, city, contact info, address

### 5.3 Field of study management

**Route:** `/dashboard/linjer` (fields of study — read-only list)
**API:** `GET /api/field_of_studies`, mutation endpoints

Build:
- List fields of study
- Create/edit (name, abbreviation)

### 5.4 Sponsor management

**Route:** `/dashboard/sponsorer` (sponsors — read-only list)
**API:** `GET /api/sponsors`, mutation endpoints

Build:
- List sponsors
- Create/edit: name, logo, URL, size

### 5.5 Profile editing

**Route:** `/dashboard/profile/rediger` (edit profile — partial form)
**API:** `PUT /api/me`, `POST /api/me/photo`

Build:
- Complete the edit form (some fields exist)
- Profile photo upload (upload mechanism TBD)
- Field of study selection (data already fetched)

---

## Priority order

Based on organizational impact and dependency chains:

1. **Admission periods** (1.1) — quick win, prerequisite for homepage application form and all of Journey 1
2. **Recruitment pipeline** (Journey 1, remaining) — core business process, most complex, org cannot stop using monolith without this
3. **Profile editing** (5.5) — quick win, partially done
4. **Receipt management** (Journey 3) — used regularly, simple state machine
5. **Team operations** (Journey 2) — important but less time-sensitive
6. **Admin** (Journey 5) — lower frequency, can stay in monolith longer
7. **Analytics** (Journey 4) — already read-only functional, enhancements are nice-to-have

## Open questions

Before implementing mutations, establish patterns for:

1. **Mutation flow:** No example of form submission -> React Router action -> SDK client -> API exists in the codebase yet. Build one (e.g., admission period CRUD) as the template.
2. **RBAC in UI:** Which roles can access which routes/actions? The backend enforces this, but the dashboard needs to know what to show/hide per role.
3. **File uploads:** Receipt photos and profile photos need an upload mechanism (multipart? base64? size limits?).
4. **Current semester:** Multiple features depend on "current semester". Is there a `GET /api/admin/semesters` with an `isCurrent` flag, or is it derived from dates?
5. **Registration:** Login exists but user registration is monolith-only. New applicants can't create accounts through the React apps.

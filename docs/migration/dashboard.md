# Dashboard Migration

The dashboard has 23 routes. Most call real API endpoints but render read-only lists with no create/edit/workflow capabilities. 6 routes are empty shells. Organized below by user journey.

## Current State

| Route | API endpoint | Functional? |
|-------|-------------|-------------|
| `/dashboard` | `GET /api/me/dashboard` | Read-only summary |
| `/dashboard/brukere` | `GET /api/admin/users` | Read-only list |
| `/dashboard/sokere` | `GET /api/admin/applications` | Read-only list |
| `/dashboard/intervjuer` | `GET /api/admin/interviews` | Read-only list |
| `/dashboard/vikarer` | `GET /api/admin/substitutes` | Read-only list |
| `/dashboard/assistenter` | `GET /api/admin/scheduling/assistants` | Read-only list |
| `/dashboard/skoler` | `GET /api/admin/scheduling/schools` | Read-only list |
| `/dashboard/statistikk` | `GET /api/admin/admission-statistics` | Read-only |
| `/dashboard/utlegg` | `GET /api/admin/receipts` | Read-only list |
| `/dashboard/teaminteresse` | `GET /api/admin/team-interest` | Read-only list |
| `/dashboard/epostliste` | `GET /api/admin/mailing-lists` | Read-only list |
| `/dashboard/team` | `GET /api/teams` | Read-only list |
| `/dashboard/sponsorer` | `GET /api/sponsors` | Read-only list |
| `/dashboard/linjer` | `GET /api/field_of_studies` | Read-only list |
| `/dashboard/profile` | `GET /api/me` | Read-only (with fixture fallback) |
| `/dashboard/profile/rediger` | `GET /api/field_of_studies` | Partial form |
| `/login` | `POST /api/login` | Functional |
| `/glemt-passord` | `POST /api/password_resets` | Functional |
| `/dashboard/attester` | — | Empty shell |
| `/dashboard/avdelinger` | — | Empty shell |
| `/dashboard/intervjufordeling` | — | Empty shell |
| `/dashboard/intervjusjema` | — | Empty shell |
| `/dashboard/opptaksperioder` | — | Empty shell |
| `/dashboard/tidligere-assistenter` | — | Empty shell |

---

## Journey 1: Recruitment Pipeline

**Who:** Team leaders, admins during recruitment season.
**Flow:** Open admission → Receive applications → Schedule interviews → Conduct & score → Assign to schools.

This is the highest-value journey. It's what the organization does twice a year and involves the most complex state machines. See [contracts/application.md](contracts/application.md) and [contracts/interview.md](contracts/interview.md).

### 1.1 Admission period management

**Route:** `/dashboard/opptaksperioder` (empty shell)
**API:** `GET/POST/PUT /api/admin/admission_periods`

Build:
- List admission periods for current department + semester
- Create/edit form: start date, end date, linked semester, department
- Show active/inactive status (computed from date range vs now)
- Link to info meeting setup (optional)

No state machine — admission periods are immutable time windows. Validation: `endDate > startDate`, one per department per semester.

### 1.2 Application review

**Route:** `/dashboard/sokere` (read-only list)
**API:** `GET /api/admin/applications` (exists), mutation endpoints needed

Build:
- Application list → detail view
- Display computed status (see [contracts/application.md](contracts/application.md) — status is derived, not stored)
- Filter by status, admission period
- Action: assign interview to application (transition: `RECEIVED → INVITED_TO_INTERVIEW`)

### 1.3 Interview scheduling

**Route:** `/dashboard/intervjuer` (read-only list)
**API:** `GET /api/admin/interviews` (exists), mutation endpoints exist

Build:
- Interview list with status badges (NO_CONTACT, PENDING, ACCEPTED, REQUEST_NEW_TIME, CANCELLED)
- Schedule form: datetime, room, campus, interviewer, co-interviewer
- Send confirmation (triggers status → PENDING, sends email with response code)
- Handle reschedule requests (see [contracts/interview.md](contracts/interview.md) — reschedule cycle)
- Reminder system (max 3, only if status PENDING and >24h since last schedule change)

### 1.4 Interview distribution

**Route:** `/dashboard/intervjufordeling` (empty shell)
**API:** Likely `POST /api/admin/interviews/distribute` or similar

Build:
- Bulk assignment of interviewers to unassigned interviews
- View interviewer availability/load
- Auto-distribute algorithm (if monolith has one) or manual assignment

### 1.5 Interview schema management

**Route:** `/dashboard/intervjusjema` (empty shell)
**API:** `GET/POST/PUT /api/admin/interview_schemas`

Build:
- List interview schemas (question templates)
- Create/edit schema: name, questions (ordered list)
- Each question has: text, type, help text
- Schema is selected when conducting an interview

### 1.6 Conduct & score interview

**Not a separate route — part of interview detail view.**

Build:
- Interview conduct form: answer each question from schema, fill score (explanatoryPower, roleModel, suitability), mark `interviewed = true`
- Score summary with `suitableAssistant` recommendation field
- Transition: `ACCEPTED → interviewed=true` (see [contracts/interview.md](contracts/interview.md))

### 1.7 School assignment

**Route:** `/dashboard/assistenter` (read-only), `/dashboard/skoler` (read-only)
**API:** `GET /api/admin/scheduling/assistants`, `GET /api/admin/scheduling/schools`

Build:
- View schools with capacity and current assignments
- Assign interviewed applicants to schools (creates `AssistantHistory` record)
- Select bolk (time slot) and workdays
- Transition: application status → `ASSIGNED_TO_SCHOOL` (computed from `user.isActiveAssistant()`)

---

## Journey 2: Team Operations

**Who:** Team leaders managing their team.
**Flow:** View team → Manage memberships → Handle substitutes → Issue certificates.

### 2.1 Team management

**Route:** `/dashboard/team` (read-only list)
**API:** `GET /api/teams`, `GET/POST/PUT /api/admin/team_memberships`

Build:
- Team detail view with member list
- Add/remove members (create/end TeamMembership)
- Toggle team leader flag
- Suspend/unsuspend members
- See [contracts/membership.md](contracts/membership.md)

### 2.2 Team interest

**Route:** `/dashboard/teaminteresse` (read-only list)
**API:** `GET /api/admin/team-interest`

Build:
- List users who expressed team interest during application
- Action: invite to team (create TeamMembership)

### 2.3 Substitutes

**Route:** `/dashboard/vikarer` (read-only list)
**API:** `GET /api/admin/substitutes`

Build:
- List substitute requests and available substitutes
- Match substitutes to schools needing coverage
- Simple assignment — no complex state machine

### 2.4 Certificates

**Route:** `/dashboard/attester` (empty shell)
**API:** `GET /api/admin/certificates`

Build:
- List certificate requests
- Generate/download certificate (PDF)
- Mark as issued

### 2.5 Previous assistants

**Route:** `/dashboard/tidligere-assistenter` (empty shell)
**API:** `GET /api/admin/assistant_histories` or similar

Build:
- List AssistantHistory records (read-only, filterable by semester/department)
- Historical view of who served where

---

## Journey 3: Finance

**Who:** Team leaders (submit), admins (approve).
**Flow:** Submit receipt → Admin reviews → Approve or reject.

### 3.1 Receipt management

**Route:** `/dashboard/utlegg` (read-only list)
**API:** `GET /api/admin/receipts`, `POST/PUT /api/admin/receipts`

Build:
- List receipts with status filter (pending, refunded, rejected)
- Submit form: description, amount, date, photo upload
- Admin actions: approve (→ refunded) or reject (→ rejected)
- See [contracts/receipt.md](contracts/receipt.md) — simple 3-state DAG

---

## Journey 4: Analytics

**Who:** Admins, team leaders.

### 4.1 Statistics

**Route:** `/dashboard/statistikk` (read-only)
**API:** `GET /api/admin/admission-statistics`

Currently functional as read-only. Enhance with:
- Charts/visualizations (application counts, acceptance rates)
- Semester comparison
- Export capability

### 4.2 Mailing lists

**Route:** `/dashboard/epostliste` (read-only)
**API:** `GET /api/admin/mailing-lists`

Build:
- Generate email lists by role/team/department
- Copy-to-clipboard or export
- Filter by active members, assistants, etc.

---

## Journey 5: Admin

**Who:** Admins only.

### 5.1 User management

**Route:** `/dashboard/brukere` (read-only list)
**API:** `GET /api/admin/users`, `POST/PUT /api/admin/users`

Build:
- User detail view
- Edit form: name, email, roles, active status
- Activate/deactivate users
- Role assignment (USER → TEAM_MEMBER → TEAM_LEADER → ADMIN)

### 5.2 Department management

**Route:** `/dashboard/avdelinger` (empty shell)
**API:** `GET/POST/PUT /api/admin/departments`

Build:
- List departments
- Create/edit form: name, city, contact info, address

### 5.3 Field of study management

**Route:** `/dashboard/linjer` (read-only list)
**API:** `GET /api/field_of_studies`, mutation endpoints

Build:
- List fields of study
- Create/edit (name, abbreviation)

### 5.4 Sponsor management

**Route:** `/dashboard/sponsorer` (read-only list)
**API:** `GET /api/sponsors`, mutation endpoints

Build:
- List sponsors
- Create/edit: name, logo, URL, size

### 5.5 Profile editing

**Route:** `/dashboard/profile/rediger` (partial form)
**API:** `PUT /api/me`, `POST /api/me/profile_photo`

Build:
- Complete the edit form (some fields exist)
- Profile photo upload
- Field of study selection (data already fetched)

---

## Priority order

Based on organizational impact and dependency chains:

1. **Recruitment pipeline** (Journey 1) — core business process, most complex, blocks everything
2. **Profile editing** (5.5) — quick win, partially done
3. **Receipt management** (Journey 3) — used regularly, simple state machine
4. **Team operations** (Journey 2) — important but less time-sensitive
5. **Admin** (Journey 5) — lower frequency, can stay in monolith longer
6. **Analytics** (Journey 4) — already read-only functional, enhancements are nice-to-have

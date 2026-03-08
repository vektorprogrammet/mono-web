# Migration Roadmap

Incremental migration from Symfony/Twig monolith to TypeScript React apps. See [ADR-0000](../adr/0000-migrate-tech-stack-to-typescript-from-php.md) for motivation.

## Architecture

```
Browser ──→ Homepage (React Router, SSR)  ──→ Symfony API ──→ MySQL
       ──→ Dashboard (React Router, SSR) ──→ (via SDK)
```

- **Homepage** (`apps/homepage`): Public pages. Prerendered + SSR.
- **Dashboard** (`apps/dashboard`): Authenticated admin. SSR.
- **SDK** (`packages/sdk`): Auto-generated TypeScript client from Symfony OpenAPI spec.
- **Server** (`apps/server`): Symfony 6.4 + API Platform 3.4. JWT auth. Source of truth during migration.

## Glossary

| Term | Meaning |
|------|---------|
| **Semester** | Academic half-year. "Var" (spring, Jan-Jul) or "Host" (fall, Aug-Dec). Immutable time window. |
| **Department** | Regional branch (Trondheim, Bergen, As). Has its own teams, schools, admission periods. |
| **Admission period** | Time window when a department accepts applications. Scoped to one department + semester. |
| **Application** | A user's request to become an assistant. Linked to one admission period. |
| **Interview** | Evaluation of an applicant. 1:1 with Application. Has scheduling, scoring, and status. |
| **Bolk** | Time slot group within a school assignment (e.g. morning/afternoon). |
| **Assistant history** | Immutable record: user X was assistant at school Y in semester Z. |
| **Team membership** | User's membership in a department team. Has start/end semester + suspended flag. |
| **Receipt** | Expense claim submitted by a team member. Goes through approval workflow. |
| **Survey** | Questionnaire sent to assistants, teams, or schools. Responses are immutable records. |

## Progress

### Homepage

| Page | API | Status |
|------|-----|--------|
| Landing (`/`) | `/api/sponsors`, `/api/statistics` | Done |
| Om oss (`/om-oss`) | — | Done (static) |
| Assistenter (`/assistenter`) | — | Done (static, flag for API later) |
| Team (`/team`, `/team/:dept`) | `/api/teams`, `/api/departments` | Done |
| Foreldre (`/foreldre`) | — | Done (static) |
| Skoler (`/skoler`) | — | Done (static, flag for API later) |
| Kontakt (`/kontakt`, `/kontakt/:dept`) | `/api/departments` | Done |
| Application form | Not started | **Blocked on admission period API** |

See [homepage.md](homepage.md) for details.

### Dashboard

| User journey | Routes | Status |
|--------------|--------|--------|
| Recruitment pipeline | sokere, intervjuer, intervjufordeling, assistenter, skoler | Read-only lists, no workflows |
| Team operations | team, teaminteresse, vikarer, attester | Read-only lists |
| Finance | utlegg | Read-only list |
| Analytics | statistikk, epostliste | Read-only |
| Admin | brukere, avdelinger, linjer, opptaksperioder | Read-only or empty shells |
| Profile | profile, profile/rediger | Partially functional |

See [dashboard.md](dashboard.md) for details.

### State Contracts

| Domain | Graph type | Contract |
|--------|-----------|----------|
| Application | DAG (computed state) | [contracts/application.md](contracts/application.md) |
| Interview | DAG with reschedule cycle | [contracts/interview.md](contracts/interview.md) |
| Receipt | Linear split | [contracts/receipt.md](contracts/receipt.md) |
| Team membership | Toggle + temporal | [contracts/membership.md](contracts/membership.md) |

## Docs

| File | What |
|------|------|
| [homepage.md](homepage.md) | Homepage migration: what's done, what's left |
| [dashboard.md](dashboard.md) | Dashboard migration by user journey |
| [contracts/](contracts/) | Hoare-logic contracts for domain state machines |

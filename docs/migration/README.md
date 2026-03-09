# Migration Roadmap

Incremental migration from Symfony/Twig monolith to TypeScript React apps. See [ADR-0000](../adr/0000-migrate-tech-stack-to-typescript-from-php.md) for motivation.

## Architecture

```
Browser --> Homepage (React Router, SSR)  --> Symfony API --> MySQL
       --> Dashboard (React Router, SSR) --> (via SDK)
```

- **Homepage** (`apps/homepage`): Public pages. Prerendered + SSR.
- **Dashboard** (`apps/dashboard`): Authenticated admin. SSR.
- **SDK** (`packages/sdk`): Auto-generated TypeScript client from Symfony OpenAPI spec.
- **Server** (`apps/server`): Symfony 6.4 + API Platform 3.4. JWT auth. Source of truth during migration.

## Glossary

### Domain terms

| Term | Meaning |
|------|---------|
| **Semester** | Academic half-year. "Var" (spring, Jan-Jul) or "Host" (fall, Aug-Dec). Immutable time window. May appear with Norwegian characters in DB/UI. |
| **Department** | Regional branch (Trondheim, Bergen, As). Has its own teams, schools, admission periods. |
| **Admission period** | Time window when a department accepts applications. Scoped to one department + semester. |
| **Application** | A user's request to become an assistant. Linked to one admission period. |
| **Interview** | Evaluation of an applicant. 1:1 with Application. Has scheduling, scoring, and status. |
| **Bolk** | Time slot group within a school assignment (e.g. morning/afternoon). |
| **Assistant history** | Immutable record: user X was assistant at school Y in semester Z. |
| **Team membership** | User's membership in a department team. Has start/end semester, suspended flag, and position. |
| **Receipt** | Expense claim submitted by a team member. Goes through approval workflow. |
| **Substitute** | An assistant who fills in at a school when the assigned assistant is unavailable. |
| **Survey** | Questionnaire sent to assistants, teams, or schools. Responses are immutable records. |

### Contract terminology

The state contracts use three concepts to describe each operation. Think of them as function input, output, and dependencies:

| We say | What it means | Formal term (Hoare logic) |
|--------|---------------|---------------------------|
| **Guard** | What must be true before the operation can run. Like a function's required input — if the guard isn't met, the operation is invalid and should be rejected or not invokable. | Precondition `{P}` |
| **Effect** | What changes after the operation completes. Like a function's return value — the guaranteed result. | Postcondition `{Q}` |
| **Constraint** | What must remain true across the operation. Like a dependency — if the constraint would be violated, the operation is invalid. Unlike guards (checked before) and effects (asserted after), constraints are properties that must hold both before and after. | Invariant |

See [contracts/implicit-invariants.md](contracts/implicit-invariants.md) for constraints that are enforced by convention rather than by code.

## Progress

### Homepage

| Page | English | API | Status |
|------|---------|-----|--------|
| `/` | Landing | `/api/sponsors`, `/api/statistics` | Done |
| `/om-oss` | About us | — | Done (static) |
| `/assistenter` | Assistants | — | Done (static, flag for API later) |
| `/team`, `/team/:dept` | Teams | `/api/teams`, `/api/departments` | Done |
| `/foreldre` | Parents | — | Done (static) |
| `/skoler` | Schools | — | Done (static, flag for API later) |
| `/kontakt`, `/kontakt/:dept` | Contact | `/api/departments` | Done |
| Application form | Apply | Not started | **Blocked on admission period API** |

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

### Server Comparison

See [server-comparison.md](server-comparison.md) for a diff analysis between the monolith (source of truth) and `apps/server`. Summary: near-identical copy with 2 additive source changes and 3 config changes for deployment.

### State Contracts

| Domain | Graph type | Contract |
|--------|-----------|----------|
| Application | DAG (computed state) | [contracts/application.md](contracts/application.md) |
| Interview | DAG with reschedule cycle | [contracts/interview.md](contracts/interview.md) |
| Receipt | Linear split | [contracts/receipt.md](contracts/receipt.md) |
| Team membership | Toggle + temporal | [contracts/membership.md](contracts/membership.md) |

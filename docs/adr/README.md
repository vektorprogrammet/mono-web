# Architecture Decision Records

We use ADRs to document decisions that are costly to reverse or that future contributors will need context on.

## When to write an ADR

**Write one when:**
- The decision affects how apps are built, deployed, or communicate
- A technology choice would be costly to reverse (framework, database, platform)
- A pattern needs to be followed consistently across the codebase
- Someone will later ask "why do we do it this way?"

**Skip when:**
- The decision is trivially reversible
- It's a code style preference (use linter config)
- It's a library choice within a single app (use `CLAUDE.md` conventions)
- It takes longer to write the ADR than to reverse the decision

## How to write one

1. Copy `template.md` to `NNNN-short-title.md` (e.g., `0001-sdk-distribution.md`)
2. Fill in Context, Decision, Consequences
3. Set status to `Accepted`
4. Commit with the code change it documents (or separately if retroactive)

## Statuses

| Status | Meaning |
|--------|---------|
| Accepted | Active and in effect |
| Deprecated | No longer relevant, kept for history |
| Superseded by [ADR-NNNN] | Replaced by a newer decision |

## Index

| ADR | Decision | Date | Status |
|-----|----------|------|--------|
| — | — | — | — |

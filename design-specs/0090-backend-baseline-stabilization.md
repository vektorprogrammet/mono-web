# 0090 — Backend verification baseline

Status: implementation contract

## Goal and journey

A developer checking the native backend can run its existing test and type-check
commands against the integration baseline and distinguish application regressions
from stale fixtures. Preserve the authenticated profile response, its session
boundary, and its response assertions.

## Scope and constraints

Reproduce the two reported router-test failures at baseline `36348795`. Diagnose
and repair fixture drift against the production profile query without changing
production behavior or weakening assertions. Reuse the existing Vitest suite and
workspace commands. Own only this isolated worktree; avoid external services,
production data, provider effects, and dependency changes.

## Acceptance and falsifiers

- Observe and record the baseline backend test result before changing the fixture.
- Keep the existing successful-profile and session-boundary assertions intact.
- Run the complete backend suite and backend type check after the fix.
- Run relevant existing formatter and linter against changed source.
- Commit the scoped change and leave a clean worktree for independent verification.

These checks validate the in-process HTTP test boundary with its SQL fixture.
They do not establish PostgreSQL execution, browser journeys, or production parity.

## Implementation evidence

The baseline suite reproduced 139 passing and 2 failing tests: the profile route
returned 404 in both cases. The SQL fixture recognized `FROM person_profiles AS
profile`; production queries `FROM public.person_profiles AS profile`. Updating
that exact fixture match restores its profile row; no production code or response
assertion changes are needed. The existing Vitest tests remain the regression gate.

Validation after the change: all 141 backend tests (18 files), backend type check,
scoped Oxfmt, scoped Oxlint, and `git diff --check` passed. Database-backed and
browser checks were not run because this change only corrects the existing SQL
fixture; these results do not establish real database behavior.

Dependencies were copied privately from the same-revision runtime worktree after
a writable-cache install stalled on network resolution. `cp -a --reflink=auto`
was used for root and workspace `node_modules` directories, preserving relative
links; resolved domain and Effect paths were checked to remain in this worktree.
The copied install is verification setup, not a fresh lockfile-install check.
No package or lockfile changed.

Reproduction commands from the repository root:

```sh
bun run --cwd apps/backend test
bun run --cwd apps/backend check-types
bun x --no-install oxfmt --check apps/backend/src/router.test.ts
bun x --no-install oxlint apps/backend/src/router.test.ts
git diff --check
```

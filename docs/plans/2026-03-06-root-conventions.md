# Root Conventions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Unify monorepo conventions — root config files, CI workflow, CLAUDE.md, PR template — and clean up per-app leftovers from pre-monorepo era.

**Architecture:** Hoist shared config to root, create a single CI workflow with TS + PHP jobs, write root CLAUDE.md for monorepo guidance, delete redundant per-app CI/config files.

**Tech Stack:** GitHub Actions, Bun, Turborepo, oxlint/oxfmt, PHP 8.5, Composer

---

### Task 1: Create root .editorconfig

**Files:**
- Create: `.editorconfig`
- Delete: `apps/homepage/.editorconfig`
- Delete: `apps/dashboard/.editorconfig`

**Step 1: Create `.editorconfig` at repo root**

```editorconfig
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = false
insert_final_newline = true
```

This is identical to what homepage and dashboard already have.

**Step 2: Delete per-app editorconfigs**

```bash
rm apps/homepage/.editorconfig apps/dashboard/.editorconfig
```

**Step 3: Commit**

```bash
git add .editorconfig apps/homepage/.editorconfig apps/dashboard/.editorconfig
git commit -m "chore: hoist .editorconfig to root"
```

---

### Task 2: Create CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  ts:
    name: TypeScript (lint, build, test)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Lint
        run: bun turbo lint

      - name: Build
        run: bun turbo build

      - name: Test
        run: bun turbo test

  php:
    name: PHP (lint, analyse, test)
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: apps/server
    steps:
      - uses: actions/checkout@v4

      - name: Setup PHP
        uses: shivammathur/setup-php@v2
        with:
          php-version: "8.5"
          extensions: xml, ctype, iconv, intl, pdo_sqlite, dom, filter, gd, mbstring, sqlite3
          tools: composer:v2
          coverage: none

      - name: Get Composer cache directory
        id: composer-cache
        run: echo "dir=$(composer config cache-files-dir)" >> $GITHUB_OUTPUT

      - name: Cache Composer dependencies
        uses: actions/cache@v4
        with:
          path: ${{ steps.composer-cache.outputs.dir }}
          key: ${{ runner.os }}-composer-${{ hashFiles('apps/server/composer.lock') }}
          restore-keys: ${{ runner.os }}-composer-

      - name: Install dependencies
        run: composer install --no-progress --prefer-dist --optimize-autoloader

      - name: Lint
        run: composer lint

      - name: Static Analysis
        run: composer analyse

      - name: Test
        run: composer test
```

**Step 2: Verify syntax**

```bash
cd /Users/nori/Projects/ntnu/vektor/v1/monoweb
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"
```

Expected: No errors.

**Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add unified CI workflow — TS + PHP jobs"
```

---

### Task 3: Delete per-app CI workflows

**Files:**
- Delete: `apps/homepage/.github/workflows/quality-control.yml`
- Delete: `apps/dashboard/.github/workflows/quality-control.yml`
- Delete: `apps/api/.github/workflows/pull-request-check.yml`
- Delete: `apps/server/.github/workflows/ci.yml`
- Delete: `apps/server/.github/workflows/build.yml`

**Step 1: Delete the files**

```bash
rm apps/homepage/.github/workflows/quality-control.yml
rm apps/dashboard/.github/workflows/quality-control.yml
rm apps/api/.github/workflows/pull-request-check.yml
rm apps/server/.github/workflows/ci.yml
rm apps/server/.github/workflows/build.yml
```

**Step 2: Clean up empty workflow directories if no other files remain**

```bash
rmdir apps/homepage/.github/workflows 2>/dev/null || true
rmdir apps/api/.github/workflows 2>/dev/null
rmdir apps/api/.github 2>/dev/null
```

Keep `apps/homepage/.github/` (has PR templates), `apps/dashboard/.github/` (has PR template), `apps/server/.github/` (staging.yml moves next task).

**Step 3: Commit**

```bash
git add -A apps/homepage/.github/workflows apps/dashboard/.github/workflows apps/api/.github apps/server/.github/workflows/ci.yml apps/server/.github/workflows/build.yml
git commit -m "chore: remove per-app CI workflows — replaced by root ci.yml"
```

---

### Task 4: Move staging workflow to root

**Files:**
- Create: `.github/workflows/staging.yml`
- Delete: `apps/server/.github/workflows/staging.yml`

**Step 1: Move the file**

```bash
mv apps/server/.github/workflows/staging.yml .github/workflows/staging.yml
```

**Step 2: Clean up empty server .github dirs**

```bash
rmdir apps/server/.github/workflows 2>/dev/null || true
```

Keep `apps/server/.github/` if it still has other files.

**Step 3: Commit**

```bash
git add .github/workflows/staging.yml apps/server/.github/workflows/staging.yml
git commit -m "chore: move staging deploy workflow to root .github/"
```

---

### Task 5: Create PR template

**Files:**
- Create: `.github/pull_request_template.md`

**Step 1: Create the template**

```markdown
## What changed

<!-- Brief description of the changes -->

## Related issue

<!-- Link to GitHub issue, e.g. #123. Remove if not applicable. -->

## Checklist

- [ ] Self-reviewed my code
- [ ] Verified it works as intended
- [ ] CI passes
```

**Step 2: Commit**

```bash
git add .github/pull_request_template.md
git commit -m "chore: add root PR template"
```

---

### Task 6: Create root CLAUDE.md

**Files:**
- Create: `CLAUDE.md`

**Step 1: Create `CLAUDE.md`**

```markdown
# Mono-web

Turborepo monorepo for Vektorprogrammet — Norwegian university tutoring program.

## Quick Reference

| Command | Purpose |
|---------|---------|
| `bun install` | Install all dependencies |
| `turbo build` | Build all packages |
| `turbo lint` | Lint all packages (oxlint) |
| `turbo test` | Run all test suites |
| `turbo run generate` | Regenerate SDK types from OpenAPI spec |
| `turbo -F @monoweb/homepage dev` | Dev server for homepage |
| `turbo -F @monoweb/dashboard dev` | Dev server for dashboard |
| `turbo -F @monoweb/api dev` | Dev server for API |

## Apps & Packages

| Package | Stack | Source | Description |
|---------|-------|--------|-------------|
| `@monoweb/homepage` | React Router, Tailwind, daisyUI | `apps/homepage/src/` | Public website |
| `@monoweb/dashboard` | React Router, Tailwind, shadcn | `apps/dashboard/app/` | Admin dashboard |
| `@monoweb/api` | Express 5, Drizzle, Zod | `apps/api/src/` | TS API (future backend) |
| `@monoweb/server` | Symfony 6.4, API Platform 3.4 | `apps/server/src/` | PHP backend (current production) |
| `@monoweb/sdk` | openapi-fetch, openapi-react-query | `packages/sdk/src/` | Type-safe API client |

## Conventions

- **Package manager:** Bun (not pnpm/npm)
- **Linter/formatter:** oxlint + oxfmt (not Biome/ESLint)
- **Path aliases:** `@/*` → source root for new code
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/)
- **Tests:** Each app owns its test runner. `turbo test` as unified interface.
- **CI:** Single GitHub Actions workflow — TS job (turbo) + PHP job (composer)

## SDK

`@monoweb/sdk` auto-generates a type-safe API client from the Symfony OpenAPI spec.

Pipeline: `api:spec` (export from Symfony) → `generate` (openapi-typescript) → `build` (tsc)

Consumer usage:
```typescript
import { createClient, createQueryApi } from "@monoweb/sdk";

// Imperative (loaders, server-side)
const api = createClient("http://localhost:8000");
const { data } = await api.GET("/api/public/departments");

// Declarative (React components with TanStack Query)
const $api = createQueryApi("http://localhost:8000");
const { data, isLoading } = $api.useQuery("get", "/api/public/departments");
```

Regenerate types: `turbo run generate` (or `cd packages/sdk && bun run generate`).

## Server (PHP)

See `apps/server/CLAUDE.md` for Symfony-specific rules, testing, and architecture.

Server commands run via composer, not turbo:
```bash
cd apps/server
composer test          # PHPUnit (1001 tests)
composer lint          # PHP-CS-Fixer
composer analyse       # PHPStan
```
```

**Step 2: Verify it renders**

Skim through the file and ensure all markdown is well-formed.

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add root CLAUDE.md — monorepo conventions and quick reference"
```

---

### Task 7: Verify everything works

**Step 1: Run turbo lint**

```bash
cd /Users/nori/Projects/ntnu/vektor/v1/monoweb
turbo lint
```

Expected: All packages pass.

**Step 2: Run turbo build**

```bash
turbo build
```

Expected: All packages build successfully.

**Step 3: Verify git status is clean**

```bash
git status
```

Expected: Nothing unexpected unstaged.

---

## Acceptance Criteria

1. Root `.editorconfig` exists, per-app copies deleted
2. `.github/workflows/ci.yml` has `ts` and `php` jobs
3. Per-app CI workflows deleted (5 files)
4. `staging.yml` lives at `.github/workflows/staging.yml`
5. Root `.github/pull_request_template.md` exists
6. Root `CLAUDE.md` covers monorepo overview, commands, conventions, SDK docs
7. `turbo lint` and `turbo build` still pass

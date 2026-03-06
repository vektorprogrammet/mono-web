# Monorepo Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rearrange the Better T Stack scaffold into a working monorepo with four apps (homepage, dashboard, api, server) and shared packages.

**Architecture:** Copy source code from four existing repos into the scaffolded `monoweb` Turborepo. Each TS app gets its own workspace with merged dependencies. The Symfony monolith joins via a thin `package.json` shim that wraps composer commands. Root `docker-compose.yml` orchestrates all services.

**Tech Stack:** Bun (package manager + runtime), Turborepo, React Router 7, Express 5, Drizzle, Symfony 6.4, oxlint, oxfmt

---

## Important Paths

- Monoweb root: `/Users/nori/Projects/ntnu/vektor/v1/monoweb/`
- Homepage source: `/Users/nori/Projects/ntnu/vektor/v2/homepage/`
- Dashboard source: `/Users/nori/Projects/ntnu/vektor/v2/dashboard/`
- API source: `/Users/nori/Projects/ntnu/vektor/v2/api/`
- Symfony monolith: `/Users/nori/Projects/ntnu/vektor/v1/monolith/`

## Key Observations from Source Repos

- **Homepage**: `src/` as appDirectory, React 18, Tailwind v3 + postcss, `ssr: false` with prerender paths
- **Dashboard**: `app/` as appDirectory, React 19, Tailwind v4 (no postcss), `ssr: false`. Has nested `dashboard/` dir (looks like accidental clone — ignore it)
- **API**: Uses `tsx` runtime + `tsc-alias`, has `db/` (Drizzle schema/migrations/seeding), `lib/`, `openapi/`, path aliases (`@/src/*`, `@/db/*`, `@/lib/*`)
- **All three** use Biome (replaced by oxlint/oxfmt in monorepo) and pnpm (replaced by Bun)

---

### Task 1: Rename `apps/web` to `apps/homepage`

**Files:**
- Move: `apps/web/` → `apps/homepage/`
- Modify: `apps/homepage/package.json`

**Step 1: Rename directory**

```bash
cd /Users/nori/Projects/ntnu/vektor/v1/monoweb
mv apps/web apps/homepage
```

**Step 2: Update package name**

In `apps/homepage/package.json`, change `"name": "web"` to `"name": "@monoweb/homepage"`.

**Step 3: Verify workspace resolution**

```bash
bun install
```

Expected: No errors. Bun resolves the renamed workspace.

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: rename apps/web to apps/homepage"
```

---

### Task 2: Rename `apps/server` to `apps/api`

**Files:**
- Move: `apps/server/` → `apps/api/`
- Modify: `apps/api/package.json`

**Step 1: Rename directory**

```bash
cd /Users/nori/Projects/ntnu/vektor/v1/monoweb
mv apps/server apps/api
```

**Step 2: Update package name**

In `apps/api/package.json`, change `"name": "server"` to `"name": "@monoweb/api"`.

**Step 3: Verify workspace resolution**

```bash
bun install
```

Expected: No errors.

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: rename apps/server to apps/api"
```

---

### Task 3: Add `test` task to turbo.json and update root scripts

**Files:**
- Modify: `turbo.json`
- Modify: `package.json`

**Step 1: Add test task to turbo.json**

Add to the `tasks` object in `turbo.json`:

```json
"test": {}
```

**Step 2: Update root package.json scripts**

Add these scripts:

```json
"test": "turbo test",
"lint": "turbo lint",
"dev:homepage": "turbo -F @monoweb/homepage dev",
"dev:dashboard": "turbo -F @monoweb/dashboard dev",
"dev:api": "turbo -F @monoweb/api dev",
"dev:server": "turbo -F @monoweb/server dev"
```

Remove the old `"dev:web"` script. Keep `"dev:server"` (now points to Symfony, not TS api).

**Step 3: Verify turbo recognizes the task**

```bash
turbo test --dry-run
```

Expected: Shows `test` task for workspaces that have a `test` script.

**Step 4: Commit**

```bash
git add turbo.json package.json
git commit -m "feat: add test task to turbo, update root scripts"
```

---

### Task 4: Create empty `packages/ui` and `packages/types`

**Files:**
- Create: `packages/ui/package.json`
- Create: `packages/ui/src/index.ts`
- Create: `packages/ui/tsconfig.json`
- Create: `packages/types/package.json`
- Create: `packages/types/src/index.ts`
- Create: `packages/types/tsconfig.json`

**Step 1: Create packages/ui**

```bash
mkdir -p packages/ui/src
```

`packages/ui/package.json`:
```json
{
  "name": "@monoweb/ui",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "check-types": "tsc -b" },
  "devDependencies": {
    "@monoweb/config": "workspace:*",
    "typescript": "^5"
  }
}
```

`packages/ui/tsconfig.json`:
```json
{
  "extends": "@monoweb/config/tsconfig.base.json",
  "compilerOptions": { "outDir": "dist" },
  "include": ["src"]
}
```

`packages/ui/src/index.ts`:
```ts
// Shared UI components — empty for now
```

**Step 2: Create packages/types**

```bash
mkdir -p packages/types/src
```

`packages/types/package.json`:
```json
{
  "name": "@monoweb/types",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "check-types": "tsc -b" },
  "devDependencies": {
    "@monoweb/config": "workspace:*",
    "typescript": "^5"
  }
}
```

`packages/types/tsconfig.json`:
```json
{
  "extends": "@monoweb/config/tsconfig.base.json",
  "compilerOptions": { "outDir": "dist" },
  "include": ["src"]
}
```

`packages/types/src/index.ts`:
```ts
// Shared API types/contracts — empty for now
```

**Step 3: Verify workspaces**

```bash
bun install
turbo check-types --dry-run
```

Expected: Both new packages appear in the workspace list.

**Step 4: Commit**

```bash
git add packages/ui packages/types
git commit -m "feat: add empty packages/ui and packages/types"
```

---

### Task 5: Copy homepage source code

**Files:**
- Replace: `apps/homepage/src/` (scaffold demo → real homepage code)
- Replace: `apps/homepage/public/`
- Replace: `apps/homepage/react-router.config.ts`
- Replace: `apps/homepage/vite.config.ts`
- Replace: `apps/homepage/tsconfig.json`
- Copy: `apps/homepage/components.json`
- Copy: `apps/homepage/tailwind.config.ts`
- Copy: `apps/homepage/postcss.config.cjs`
- Copy: `apps/homepage/e2e/`
- Copy: `apps/homepage/playwright.config.ts`
- Modify: `apps/homepage/package.json` (merge deps)

**Step 1: Remove scaffold placeholder code**

```bash
rm -rf apps/homepage/src apps/homepage/public
```

**Step 2: Copy source files**

```bash
cp -r /Users/nori/Projects/ntnu/vektor/v2/homepage/src apps/homepage/
cp -r /Users/nori/Projects/ntnu/vektor/v2/homepage/public apps/homepage/
cp -r /Users/nori/Projects/ntnu/vektor/v2/homepage/e2e apps/homepage/
cp /Users/nori/Projects/ntnu/vektor/v2/homepage/react-router.config.ts apps/homepage/
cp /Users/nori/Projects/ntnu/vektor/v2/homepage/vite.config.ts apps/homepage/
cp /Users/nori/Projects/ntnu/vektor/v2/homepage/tsconfig.json apps/homepage/
cp /Users/nori/Projects/ntnu/vektor/v2/homepage/components.json apps/homepage/
cp /Users/nori/Projects/ntnu/vektor/v2/homepage/tailwind.config.ts apps/homepage/
cp /Users/nori/Projects/ntnu/vektor/v2/homepage/postcss.config.cjs apps/homepage/
cp /Users/nori/Projects/ntnu/vektor/v2/homepage/playwright.config.ts apps/homepage/
```

**Step 3: Merge package.json**

Rewrite `apps/homepage/package.json`. Keep `@monoweb/*` workspace refs, merge homepage's real dependencies. Key changes:

- Name: `@monoweb/homepage`
- Add all homepage deps (radix, mantine hooks, motion, dayjs, daisyui, react-hook-form, vaul, cmdk)
- React stays at `^18.3.1` (homepage uses React 18, not 19)
- Replace biome devDep with nothing (oxlint at root)
- Add playwright, vitest as devDeps
- Add test scripts: `"test": "vitest run"`, `"e2e": "playwright test"`
- Keep `"build": "react-router build"` and `"dev": "react-router dev"`

```json
{
  "name": "@monoweb/homepage",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "react-router build",
    "dev": "react-router dev",
    "start": "react-router-serve build/server/index.js",
    "test": "vitest run",
    "check-types": "react-router typegen && tsc",
    "e2e": "playwright test",
    "e2e:ui": "playwright test --ui"
  },
  "dependencies": {
    "@icons-pack/react-simple-icons": "^12.3.0",
    "@mantine/hooks": "^7.17.3",
    "@monoweb/env": "workspace:*",
    "@radix-ui/react-accordion": "^1.2.3",
    "@radix-ui/react-avatar": "^1.1.3",
    "@radix-ui/react-checkbox": "^1.1.4",
    "@radix-ui/react-dialog": "^1.1.6",
    "@radix-ui/react-dropdown-menu": "^2.1.6",
    "@radix-ui/react-icons": "^1.3.2",
    "@radix-ui/react-label": "^2.1.2",
    "@radix-ui/react-popover": "^1.1.15",
    "@radix-ui/react-select": "^2.1.6",
    "@radix-ui/react-separator": "^1.1.2",
    "@radix-ui/react-slot": "^1.1.2",
    "@radix-ui/react-tabs": "^1.1.3",
    "@react-router/fs-routes": "^7.4.1",
    "@react-router/node": "^7.4.1",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "cmdk": "^1.1.1",
    "daisyui": "^4.12.24",
    "dayjs": "^1.11.13",
    "isbot": "^5.1.25",
    "lucide-react": "^0.486.0",
    "motion": "^12.6.2",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-hook-form": "^7.55.0",
    "react-router": "^7.4.1",
    "react-router-dom": "^7.9.4",
    "tailwind-merge": "^2.6.0",
    "tailwindcss": "^3.4.17",
    "tailwindcss-animate": "^1.0.7",
    "vaul": "^1.1.2",
    "vite": "^6.2.5"
  },
  "devDependencies": {
    "@monoweb/config": "workspace:*",
    "@playwright/test": "^1.51.1",
    "@react-router/dev": "^7.4.1",
    "@types/node": "^22.13.14",
    "@types/react": "^18.3.20",
    "@types/react-dom": "^18.3.5",
    "autoprefixer": "^10.4.21",
    "postcss": "^8.5.3",
    "postcss-import": "^16.1.0",
    "typescript": "^5.8.2",
    "vitest": "^3.1.1"
  }
}
```

**Step 4: Install and verify build**

```bash
bun install
turbo -F @monoweb/homepage build
```

Expected: React Router build succeeds. If it fails, check for missing dependencies or import paths.

**Step 5: Commit**

```bash
git add apps/homepage
git commit -m "feat: copy homepage source from vektorprogrammet/homepage"
```

---

### Task 6: Create `apps/dashboard` with dashboard source

**Files:**
- Create: `apps/dashboard/` (full app directory)
- Source is at `/Users/nori/Projects/ntnu/vektor/v2/dashboard/` — use root-level files, NOT the nested `dashboard/dashboard/` subdirectory

**Step 1: Create dashboard directory and copy source**

```bash
mkdir -p apps/dashboard

# Copy source (app dir, not src — dashboard uses app/ convention)
cp -r /Users/nori/Projects/ntnu/vektor/v2/dashboard/app apps/dashboard/
cp -r /Users/nori/Projects/ntnu/vektor/v2/dashboard/public apps/dashboard/
cp /Users/nori/Projects/ntnu/vektor/v2/dashboard/react-router.config.ts apps/dashboard/
cp /Users/nori/Projects/ntnu/vektor/v2/dashboard/vite.config.ts apps/dashboard/
cp /Users/nori/Projects/ntnu/vektor/v2/dashboard/tsconfig.json apps/dashboard/
cp /Users/nori/Projects/ntnu/vektor/v2/dashboard/components.json apps/dashboard/
cp /Users/nori/Projects/ntnu/vektor/v2/dashboard/playwright.config.ts apps/dashboard/
cp /Users/nori/Projects/ntnu/vektor/v2/dashboard/.gitignore apps/dashboard/
```

**Step 2: Create package.json**

```json
{
  "name": "@monoweb/dashboard",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "react-router build",
    "dev": "react-router dev",
    "start": "react-router-serve build/server/index.js",
    "check-types": "react-router typegen && tsc",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@hookform/resolvers": "^4.1.3",
    "@mantine/hooks": "^7.17.3",
    "@monoweb/env": "workspace:*",
    "@radix-ui/react-avatar": "^1.1.3",
    "@radix-ui/react-checkbox": "^1.1.4",
    "@radix-ui/react-collapsible": "^1.1.3",
    "@radix-ui/react-dialog": "^1.1.6",
    "@radix-ui/react-dropdown-menu": "^2.1.6",
    "@radix-ui/react-label": "^2.1.2",
    "@radix-ui/react-popover": "^1.1.6",
    "@radix-ui/react-select": "^2.1.6",
    "@radix-ui/react-separator": "^1.1.2",
    "@radix-ui/react-slot": "^1.1.2",
    "@radix-ui/react-tabs": "^1.1.3",
    "@radix-ui/react-tooltip": "^1.1.8",
    "@react-router/fs-routes": "^7.4.1",
    "@react-router/node": "^7.4.1",
    "@react-router/serve": "^7.4.1",
    "@tanstack/react-table": "^8.21.2",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "cmdk": "^1.1.1",
    "isbot": "^5.1.25",
    "lucide-react": "^0.486.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "react-hook-form": "^7.55.0",
    "react-router": "^7.4.1",
    "tailwind-merge": "^3.0.2",
    "tailwindcss": "^4.0.17",
    "tailwindcss-animate": "^1.0.7",
    "vaul": "^1.1.2",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@monoweb/config": "workspace:*",
    "@playwright/test": "^1.51.1",
    "@react-router/dev": "^7.4.1",
    "@tailwindcss/postcss": "^4.0.17",
    "@tailwindcss/vite": "^4.0.17",
    "@types/node": "^22.13.14",
    "@types/react": "^19.0.12",
    "@types/react-dom": "^19.0.4",
    "typescript": "^5.8.2",
    "vite": "^6.2.4"
  }
}
```

**Step 3: Install and verify build**

```bash
bun install
turbo -F @monoweb/dashboard build
```

Expected: React Router build succeeds.

**Step 4: Commit**

```bash
git add apps/dashboard
git commit -m "feat: copy dashboard source from vektorprogrammet/dashboard"
```

---

### Task 7: Replace `apps/api` with real API source

**Files:**
- Replace: `apps/api/src/` (scaffold demo → real api code)
- Copy: `apps/api/db/`, `apps/api/lib/`, `apps/api/openapi/`
- Replace: `apps/api/tsconfig.json`
- Modify: `apps/api/package.json` (merge deps)

**Step 1: Remove scaffold placeholder**

```bash
rm -rf apps/api/src
```

**Step 2: Copy source files**

```bash
cp -r /Users/nori/Projects/ntnu/vektor/v2/api/src apps/api/
cp -r /Users/nori/Projects/ntnu/vektor/v2/api/db apps/api/
cp -r /Users/nori/Projects/ntnu/vektor/v2/api/lib apps/api/
cp -r /Users/nori/Projects/ntnu/vektor/v2/api/openapi apps/api/
cp /Users/nori/Projects/ntnu/vektor/v2/api/tsconfig.json apps/api/
cp /Users/nori/Projects/ntnu/vektor/v2/api/decs.d.ts apps/api/
cp /Users/nori/Projects/ntnu/vektor/v2/api/.env.example apps/api/
```

**Step 3: Update package.json**

Merge the api's dependencies into the scaffold's `apps/api/package.json`. Key changes:

- Name: `@monoweb/api`
- Keep `@monoweb/db` and `@monoweb/env` workspace refs
- Add api-specific deps: `ajv`, `drizzle-seed`, `drizzle-zod`, `express-zod-safe`, `pg`, `swagger-jsdoc`, `validator`, `zod-openapi`, `zod-validation-error`
- Add devDeps: `@types/pg`, `@types/supertest`, `@types/swagger-jsdoc`, `@types/validator`, `drizzle-kit`, `supertest`, `tsc-alias`, `tsx`
- Update scripts to match the api repo's patterns:
  - `"dev": "tsx watch ./src/main.ts"`
  - `"build": "tsc --project ./tsconfig.json && tsc-alias --project ./tsconfig.json --resolve-full-paths"`
  - `"test": "tsc --noEmit && node --import tsx --test --test-force-exit ./src/test/*.ts"`
  - `"start": "node ./build/src/main.js"`
- Keep db scripts: `db:generate`, `db:migrate`, `db:studio`, `db:seed` (pointed at `db/config/drizzle.config.ts`)

```json
{
  "name": "@monoweb/api",
  "type": "module",
  "main": "./src/main.ts",
  "scripts": {
    "dev": "tsx watch ./src/main.ts",
    "build": "tsc --project ./tsconfig.json && tsc-alias --project ./tsconfig.json --resolve-full-paths",
    "start": "node ./build/src/main.js",
    "test": "tsc --noEmit && node --import tsx --test --test-force-exit ./src/test/*.ts",
    "check-types": "tsc --noEmit",
    "db:generate": "drizzle-kit generate --config=db/config/drizzle.config.ts",
    "db:migrate": "drizzle-kit migrate --config=db/config/drizzle.config.ts",
    "db:studio": "drizzle-kit studio --config=db/config/drizzle.config.ts",
    "db:seed": "tsx ./db/seeding/seeding.ts"
  },
  "dependencies": {
    "@monoweb/db": "workspace:*",
    "@monoweb/env": "workspace:*",
    "ajv": "^8.17.1",
    "cors": "^2.8.5",
    "dotenv": "^16.4.7",
    "drizzle-orm": "^0.33.0",
    "drizzle-seed": "^0.3.1",
    "drizzle-zod": "^0.5.1",
    "express": "^5.1.0",
    "express-zod-safe": "^1.3.3",
    "pg": "^8.14.1",
    "swagger-jsdoc": "^6.2.8",
    "validator": "^13.15.0",
    "zod": "^3.24.2",
    "zod-openapi": "^3.3.0",
    "zod-validation-error": "^3.4.0"
  },
  "devDependencies": {
    "@monoweb/config": "workspace:*",
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/node": "^22.14.0",
    "@types/pg": "^8.11.11",
    "@types/supertest": "^6.0.3",
    "@types/swagger-jsdoc": "^6.0.4",
    "@types/validator": "^13.12.3",
    "drizzle-kit": "^0.24.2",
    "supertest": "^7.1.0",
    "tsc-alias": "^1.8.13",
    "tsx": "^4.19.3",
    "typescript": "^5.8.2"
  }
}
```

**Step 4: Install and verify build**

```bash
bun install
turbo -F @monoweb/api build
```

Expected: TypeScript compilation succeeds. Path aliases (`@/src/*`, `@/db/*`) resolved by `tsc-alias`. If build fails on missing DB connection, that's expected — the Drizzle runtime needs Postgres, but `tsc` should still compile.

**Step 5: Commit**

```bash
git add apps/api
git commit -m "feat: copy api source from vektorprogrammet/api"
```

---

### Task 8: Add Symfony monolith as `apps/server`

**Files:**
- Create: `apps/server/` (full Symfony app)
- Create: `apps/server/package.json` (Turbo shim)

**Step 1: Copy Symfony monolith**

```bash
rsync -a \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='vendor' \
  --exclude='var' \
  --exclude='.claude' \
  --exclude='memory' \
  --exclude='.varp' \
  /Users/nori/Projects/ntnu/vektor/v1/monolith/ apps/server/
```

**Step 2: Create Turbo shim package.json**

Create `apps/server/package.json`:

```json
{
  "name": "@monoweb/server",
  "private": true,
  "scripts": {
    "dev": "php -S 0.0.0.0:8000 -t public",
    "build": "composer dump-autoload --optimize",
    "test": "php -d memory_limit=512M bin/phpunit",
    "lint": "composer analyse",
    "check-types": "echo 'PHP: skip'"
  }
}
```

**Step 3: Install PHP deps and verify**

```bash
cd apps/server
composer install
cd ../..
turbo -F @monoweb/server test
```

Expected: PHPUnit runs 1011 tests. May take ~280s.

**Step 4: Verify turbo sees all workspaces**

```bash
turbo build --dry-run
```

Expected: Lists `@monoweb/homepage`, `@monoweb/dashboard`, `@monoweb/api`, `@monoweb/server`, `@monoweb/db`, `@monoweb/env`, `@monoweb/config`, `@monoweb/ui`, `@monoweb/types`.

**Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: add Symfony monolith as apps/server with Turbo shim"
```

---

### Task 9: Add oxlint ignore for PHP files

**Files:**
- Modify: `.oxlintrc.json`

**Step 1: Add ignore pattern**

Add `"apps/server/**"` to `ignorePatterns` in `.oxlintrc.json` so oxlint skips PHP files:

```json
{
  "ignorePatterns": ["apps/server/**"]
}
```

**Step 2: Verify oxlint doesn't scan PHP**

```bash
oxlint 2>&1 | head -20
```

Expected: No PHP-related errors.

**Step 3: Commit**

```bash
git add .oxlintrc.json
git commit -m "chore: ignore apps/server PHP files in oxlint"
```

---

### Task 10: Write root docker-compose.yml

**Files:**
- Create: `docker-compose.yml` (root)

**Step 1: Write docker-compose.yml**

```yaml
services:
  server:
    build:
      context: apps/server
      args:
        APP_ENV: staging
    ports:
      - "8000:8000"
    environment:
      APP_ENV: staging
      APP_SECRET: staging-secret-change-in-production
      DATABASE_DRIVER: pdo_mysql
      DATABASE_HOST: mysql
      DATABASE_PORT: "3306"
      DATABASE_NAME: vektor
      DATABASE_USER: vektor
      DATABASE_PASSWORD: vektor
      JWT_PASSPHRASE: staging-jwt-passphrase
      MAILER_DSN: "null://null"
      SLACK_DISABLED: "true"
      SMS_DISABLE: "true"
      DEFAULT_FROM_EMAIL: noreply@staging.vektorprogrammet.no
      ECONOMY_EMAIL: noreply@staging.vektorprogrammet.no
      DEFAULT_SURVEY_EMAIL: noreply@staging.vektorprogrammet.no
      SLACK_ENDPOINT: https://hooks.slack.com/services/disabled
      LOG_CHANNEL: "#staging"
      GATEWAY_API_TOKEN: disabled
      GOOGLE_API_CLIENT_ID: disabled
      GOOGLE_API_CLIENT_SECRET: disabled
      GOOGLE_API_REFRESH_TOKEN: disabled
      RECAPTCHA_PUBLIC_KEY: ""
      RECAPTCHA_PRIVATE_KEY: ""
      IPINFO_TOKEN: ""
      GEO_IGNORED_ASNS: "[]"
    depends_on:
      mysql:
        condition: service_healthy

  api:
    build: apps/api
    ports:
      - "3001:3001"
    environment:
      DATABASE_URL: postgres://vektor:vektor@postgres:5432/vektor
      PORT: "3001"
    depends_on:
      postgres:
        condition: service_healthy

  mysql:
    image: mysql:8.0
    environment:
      MYSQL_DATABASE: vektor
      MYSQL_USER: vektor
      MYSQL_PASSWORD: vektor
      MYSQL_ROOT_PASSWORD: root
    ports:
      - "3307:3306"
    volumes:
      - mysql_data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 5s
      timeout: 5s
      retries: 10

  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: vektor
      POSTGRES_USER: vektor
      POSTGRES_PASSWORD: vektor
    ports:
      - "5433:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U vektor"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  mysql_data:
  postgres_data:
```

Note: homepage and dashboard are static SPAs in dev — run via `turbo dev`, not Docker. They only need Docker for production builds.

**Step 2: Verify compose config**

```bash
docker compose config --quiet
```

Expected: No errors.

**Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add root docker-compose with server, api, mysql, postgres"
```

---

### Task 11: Clean up scaffold artifacts

**Files:**
- Delete: `bts.jsonc` (Better T Stack metadata)
- Modify: `README.md` (replace scaffold content)

**Step 1: Remove scaffold metadata**

```bash
rm bts.jsonc
```

**Step 2: Replace README.md**

```markdown
# Monoweb

Monorepo for Vektorprogrammet web applications.

## Apps

| App | Port | Stack |
|-----|------|-------|
| `apps/server` | 8000 | Symfony 6.4 / PHP 8.4 (production monolith) |
| `apps/homepage` | 3000 | React Router 7 + shadcn + Tailwind |
| `apps/dashboard` | 3002 | React Router 7 + shadcn + Tailwind |
| `apps/api` | 3001 | Express 5 + Drizzle + Postgres |

## Packages

| Package | Purpose |
|---------|---------|
| `packages/db` | Drizzle schema + migrations |
| `packages/env` | Zod env validation |
| `packages/config` | Shared tsconfig |
| `packages/ui` | Shared React components (future) |
| `packages/types` | Shared API types (future) |

## Commands

```bash
bun install          # Install all dependencies
turbo dev            # Start all dev servers
turbo build          # Build all apps
turbo test           # Run all test suites
turbo check-types    # Type check all TS apps

# Individual apps
turbo -F @monoweb/homepage dev
turbo -F @monoweb/server test
```

## Docker

```bash
docker compose up -d    # Start server + api + mysql + postgres
docker compose down -v  # Reset all data
```

## Tooling

- **Bun** — package manager + runtime
- **Turborepo** — task orchestration + caching
- **oxlint** — linting
- **oxfmt** — formatting
- **Composer** — PHP deps (server only)
```

**Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove scaffold artifacts, update README"
```

---

### Task 12: Final verification

**Step 1: Clean install**

```bash
rm -rf node_modules
bun install
```

Expected: All workspaces resolve.

**Step 2: Turbo build all**

```bash
turbo build
```

Expected: All apps build. Server runs `composer dump-autoload`. Homepage and dashboard run `react-router build`. API runs `tsc`.

**Step 3: Turbo test**

```bash
turbo test
```

Expected: Server runs PHPUnit (1011 tests). API runs its test suite. Homepage runs vitest. Dashboard may not have tests yet (no test script = skipped).

**Step 4: Turbo dev (quick smoke test)**

```bash
turbo dev
```

Expected: All dev servers start on their ports. Ctrl+C to stop.

**Step 5: Docker compose smoke test**

```bash
docker compose up -d
docker compose ps
```

Expected: server, api, mysql, postgres all healthy/running.

```bash
docker compose down
```

**Step 6: Final commit if any fixups needed**

```bash
git add -A
git commit -m "fix: final adjustments from verification"
```

# Environment Strategy Design

**Date**: 2026-03-06
**Status**: Approved
**Goal**: Standardize deployment environments across the monorepo with a clear promotion pipeline.

## Environments

Three environments, one promotion path:

```
feature-branch → PR → main → (auto-deploy) → staging → (manual promote) → production
```

| Environment | Trigger | Purpose | URL |
|---|---|---|---|
| Dev | local | Developer machines | `localhost:*` |
| Staging | auto on merge to main | Team QA, integration testing | `staging.vektorprogrammet.no` |
| Production | manual promote | Live site | `vektorprogrammet.no` |

## Branching Strategy

GitFlow-lite: feature branches → PR to `main` with CI checks. Main is always the latest integrated code. No release branches, no separate staging branch.

## Platform

| App | Platform | Status |
|---|---|---|
| server (Symfony/PHP) | Railway | Needs setup |
| homepage (React SPA) | Vercel/Netlify | Not deployed yet |
| dashboard (React SPA) | Vercel/Netlify | Not deployed yet |
| api (Express/TS) | Railway or similar | Not deployed yet |

Railway was chosen for the server because:
- Docker-native (existing Dockerfile works as-is)
- Built-in environment concept (staging/prod in one project)
- GitHub integration for auto-deploy
- MySQL as a one-click addon
- No server management (vs DigitalOcean droplet)

## Railway Project Structure

```
Railway Project: vektorprogrammet
├── Environment: staging
│   ├── Service: server (Dockerfile from apps/server)
│   └── Service: mysql (Railway MySQL plugin)
└── Environment: production
    ├── Service: server (same Dockerfile)
    └── Service: mysql (Railway MySQL plugin)
```

Same project, same services, different env vars and databases per environment.

## Deploy Flow

**Staging:** Railway watches `main` branch. Every merge auto-deploys. No GitHub Actions workflow needed — Railway's GitHub integration handles it.

**Production:** Manual promote via GitHub Actions `workflow_dispatch` that calls Railway API. Gives audit trail in GitHub.

## Database Strategy

| Mode | Use case | How |
|---|---|---|
| Fixtures (default) | Staging, dev | `doctrine:fixtures:load` on first boot via entrypoint |
| Prod snapshot | Pre-release validation | Manual import via `railway run` |

## CI/CD

```
ci.yml (existing)         — PRs to main: lint, build, test
Railway auto-deploy       — main merges: staging deploy (no workflow needed)
deploy-prod.yml (new)     — manual button: promote staging → production
staging.yml (delete)      — replaced by Railway auto-deploy
```

## Cross-App Configuration

Each app deploys independently. The monorepo CI validates everything together, but deployment is per-app.

The only cross-app config is the SDK's `baseUrl` — each SPA points at the correct server URL per environment via its own env vars.

## Future: SPAs and TS API

When ready to deploy:

| App | Platform | Staging | Production |
|---|---|---|---|
| server | Railway | auto on main | manual promote |
| homepage | Vercel/Netlify | auto on main | auto or manual |
| dashboard | Vercel/Netlify | auto on main | auto or manual |
| api | Railway | auto on main | manual promote |

No shared deploy orchestration. Each platform manages its own environments.

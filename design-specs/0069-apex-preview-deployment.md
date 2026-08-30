# Design spec 0069 — Apex preview deployment

## Metadata

| Field | Value |
|---|---|
| Stable ID | `0069` |
| Status | Accepted operator capsule on 2026-08-31 |
| Source base | `d150c9308ddf9dc0b54de0fb1b74bd505ba91d0f` |
| Stage | `dev-main` |
| Public host | `vektor.phibkro.org` |
| Backend host | `origin-api.vektor.phibkro.org` |
| Production host | `vektorprogrammet.no` is forbidden |

The operator authorized this capsule in the deployment request. This capsule changes only the apex preview contract.

Spec 0005 still owns the local Alchemy state rule. Spec 0011 still owns the persistent development homepage rule.

Spec 0020 keeps its separate `p20` remote-state proposal. This capsule does not deploy or change the `p20` stage.

## Deployment contract

The apex preview has these Cloudflare Workers:

- `vektor-apex-homepage`
- `vektor-apex-dashboard`
- `vektor-apex-worker`

The edge Worker owns `vektor.phibkro.org`. It preserves the existing `api.vektor.phibkro.org` alias without a DNS change.

The edge Worker sends `/api`, `/api/*`, and `/health` requests to `origin-api.vektor.phibkro.org`.

The browser uses only `https://vektor.phibkro.org`. Browser assets, API requests, redirects, and cookies stay on this origin.

The homepage Worker and dashboard Worker use the supporting backend origin from one identity constant. They do not use a localhost URL.

The Alchemy stage uses `Alchemy.localState()`. The local state stays in the ignored `infra/alchemy/.alchemy/` directory.

The existing Cloudflare remote-state resources can remain. This capsule does not delete or change the shared state store.

## Existing-resource recovery

The operator must run the repository wrapper without `--adopt`. Alchemy can recover resources only when provider ownership matches this stack.

If Alchemy reports an unowned resource, stop the deployment. Do not use forced adoption.

The plan can update only the three apex Workers. It can preserve the two existing Worker domains.

## Backend isolation

The backend uses the existing dedicated preview tunnel. Only `origin-api.vektor.phibkro.org` receives a tunnel DNS route.

The tunnel service target is `http://127.0.0.1:8790`. The shared MCP tunnel stays unchanged.

The native backend listens only on `127.0.0.1:8790`. PostgreSQL listens only on `127.0.0.1:5434`.

The database name is `vektor_preview`. The database contains synthetic data only.

`PUBLIC_APPLICATION_EFFECT_MODE=disabled` disables provider delivery. The token maps remain empty.

The preview process supervisor owns PostgreSQL, the backend, and the dedicated tunnel. These services stay live with the requested preview.

## Procedure

1. Make sure that the source worktree is clean at the recorded source commit.
2. Run the bounded source checks.
3. Start the isolated PostgreSQL service.
4. Start the loopback backend service.
5. Make sure that local health and synthetic login succeed.
6. Start the dedicated tunnel with its restricted ingress file.
7. Make sure that `origin-api.vektor.phibkro.org/health` returns `200`.
8. Run the repository Alchemy plan for stage `dev-main`.
9. Stop if the plan contains an unowned resource or an extra domain.
10. Deploy through the repository Alchemy wrapper.
11. Run the HTTPS browser journey on the apex host.

## Acceptance

The following requests must succeed:

- `GET /`
- `GET /nyheter`
- `GET /login`
- `GET /api/health`

An anonymous `GET /dashboard` must redirect to `/login` on the apex host.

A synthetic administrator can sign in. The browser receives a secure session cookie for the apex host.

The authenticated dashboard must load from the apex host. The browser must not request localhost or another public host.

The homepage must not return `503`. Chromium must report no deployment-caused console error or page error.

## Forbidden effects

This capsule forbids these effects:

- production data access
- production credential changes
- provider delivery or notifications
- a shared database change
- a shared tunnel change
- a route or DNS change for another hostname
- remote-state deletion
- forced resource adoption
- a deployment to `p20` or a production stage

## Evidence

The evidence must record the source commit, local-state path, Worker names, hostnames, status codes, and screenshots.

The evidence must not contain credential values, session values, or database rows.

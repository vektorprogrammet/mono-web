# Design spec 0069 — Apex preview deployment

## Metadata

| Field           | Value                                                                     |
| --------------- | ------------------------------------------------------------------------- |
| Stable ID       | `0069`                                                                    |
| Status          | Accepted operator capsule, amended after independent review on 2026-08-31 |
| Source base     | `d150c9308ddf9dc0b54de0fb1b74bd505ba91d0f`                                |
| Deployed source | `dcabd8c54088e26ed9d8d3aaf8463ba9a54482dd`                                |
| Stage           | `dev-main`                                                                |
| Public host     | `vektor.phibkro.org`                                                      |
| Backend host    | `origin-api.vektor.phibkro.org`                                           |
| Production host | `vektorprogrammet.no` is forbidden                                        |

The operator authorized this capsule in the deployment request. This capsule changes only the apex preview contract.

Spec 0005 still owns the local Alchemy state rule. Spec 0011 still owns the persistent development homepage rule.

Spec 0020 keeps its separate `p20` remote-state proposal. This capsule does not deploy or change the `p20` stage.

## Deployment contract

The apex preview has these Cloudflare Workers:

- `vektor-apex-homepage`
- `vektor-apex-dashboard`
- `vektor-apex-worker`

The edge Worker owns the `vektor.phibkro.org` custom domain and preserves the existing `api.vektor.phibkro.org` alias with a Worker route over its existing DNS record. The final net host state matches pre-deployment: apex plus API alias. All three apex Workers disable `workers.dev`.

The edge Worker sends `/api`, `/api/*`, and `/health` requests on both allowed hosts to `origin-api.vektor.phibkro.org`. The API alias rejects homepage traffic with `421`.

The browser uses only `https://vektor.phibkro.org`. Browser assets, API requests, redirects, and cookies stay on this origin.

Server code uses the supporting backend origin from one identity constant. The dashboard browser uses an explicit same-origin `VITE_API_URL`. The homepage reads `API_URL` only at request runtime.

The stack maps `dev-main` only to `Alchemy.localState()`. It maps `p20` to `Cloudflare.state()`. It rejects all other stages before it selects state.

The local state stays in the ignored `infra/alchemy/.alchemy/` directory. The wrapper requires the exact three apex records, apex domain, and API alias route before it can run Alchemy for `dev-main`.

A `0600` operator backup preserves the deployed local state outside the temporary worktree. A future checkout must restore all four files and pass the wrapper identity check before a `dev-main` plan.

The old Cloudflare remote-state records remain. They are stale after a local-state deployment. Operators must not use them to mutate `dev-main`. The provenance record documents this dual-controller risk.

## Existing-resource recovery

The operator must run the repository wrapper without `--adopt`. Alchemy can recover resources only when provider ownership matches this stack.

If Alchemy reports an unowned resource, stop the deployment. Do not use forced adoption.

The plan can update only the three apex Workers. The edge Worker must preserve the apex custom domain and the exact `api.vektor.phibkro.org/*` alias route.

## Backend isolation

The backend uses the existing dedicated preview tunnel. This capsule creates, updates, or deletes no tunnel DNS route.

The tunnel accepts `origin-api.vektor.phibkro.org` for server-only traffic. The existing DNS and tunnel configuration for `api.vektor.phibkro.org` stays unchanged; the edge Worker route restores its pre-deployment alias behavior without a DNS mutation.

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
5. Generate or read the synthetic identities from the operator-only `0600` credential file.
6. Validate the exact two `personId`/email/role mappings and unique values before any seed or rotation mutation.
7. Rotate both credential hashes and invalidate their old sessions.
8. Make sure that local health and both synthetic logins succeed.
9. Start the dedicated tunnel with its restricted ingress file.
10. Make sure that `origin-api.vektor.phibkro.org/health` returns `200`.
11. Run the repository Alchemy plan for stage `dev-main`.
12. Stop if the plan contains an unowned resource or an extra domain.
13. Deploy through the repository Alchemy wrapper.
14. Run the HTTPS browser journey on the apex host.
15. Verify that the API alias returns `200` for `/api/health`, `/health`, and `/api/auth/get-session`, and `421` for homepage traffic.
16. Require the post-deployment Alchemy plan to report three noops.

## Acceptance

The following requests must succeed:

- `GET /`
- `GET /nyheter`
- `GET /login`
- `GET /api/health`

An anonymous `GET /dashboard` must redirect to `/login` on the apex host.

A synthetic administrator can sign in. The browser receives a secure session cookie for the apex host.

The authenticated dashboard must load from the apex host. The browser must not request localhost or another public host.

Authenticated profile, organization, recruitment-period, and interview-assignment pages must load from the dashboard Worker. The bridge families `/profile`, `/recruitment`, `/interview`, and `/interview-response/*` must never fall through to the homepage Worker.

The homepage must not return `503`. Chromium must report no deployment-caused console error or page error.

The edge must fail closed for cross-origin, credentialed-URL, and protocol-relative redirects from the backend. Rejected redirects must not forward cookies to the browser.

`api.vektor.phibkro.org` must route API and health traffic through the apex Worker and must not serve the public homepage. Its responses must report the `dev-main` stage and `noindex` on server routes.

## Forbidden effects

This capsule forbids these effects:

- production data access
- production credential changes
- provider delivery or notifications
- a shared database change
- a shared tunnel change
- a route or DNS change for another hostname, except the operator-authorized recovery of the pre-existing `api.vektor.phibkro.org` Worker association
- remote-state deletion
- forced resource adoption
- a deployment to `p20` or a production stage

## Evidence

The evidence must record the source commit, local-state path, Worker names, hostnames, status codes, post-deployment noop plan, and repository-relative screenshots whose bitmaps match the recorded `1440 × 900` capture viewport.

`infra/alchemy/preview/apex-local-state.provenance.json` records the transfer source, the retained remote-state digests, the deployed local-state digests, and the dual-controller control. Machine-specific backup paths and Cloudflare profile labels are not committed.

The evidence must show that both retired source passwords return `401` without a session cookie. It must not contain credential values, session values, absolute operator paths, or database rows.

The authoritative base history still contains the retired fixed source credentials. This deployment does not rewrite integration history. Both live password hashes are rotated, prior sessions are invalidated, and both retired passwords are rejected.

# Design spec 0070 — Durable apex preview supervision

## Metadata

| Field       | Value                                                       |
| ----------- | ----------------------------------------------------------- |
| Stable ID   | `0070`                                                      |
| Status      | Accepted operator capsule, executed on 2026-08-31           |
| Source base | `0bc4aa3ac5506b6371d25972c9608eee8e35c17d`                  |
| Stage       | `dev-main`                                                  |
| Public host | `vektor.phibkro.org`                                        |
| Backend host | `origin-api.vektor.phibkro.org`                            |
| Production host | `vektorprogrammet.no` is forbidden                      |

Spec 0069 owns the apex preview deployment contract. This capsule owns only how
the host-local preview services (PostgreSQL, native backend, dedicated
cloudflared tunnel) are supervised on the preview host. It changes no DNS
record, no tunnel ingress file, no Cloudflare state, and no `p20` stage.

## Problem

Before this capsule, the three preview services were ad-hoc detached
processes started from agent tooling scopes (`herdr.slice` scopes inside the
omp worker broker). Their parent chain was `omp __omp_worker_daemon_broker`,
not a supervisor. Consequences:

- A restart of the machine or the user session left the preview down; a
  reviewer could not sign in and see previously committed native records.
- Nothing restarted a crashed backend or tunnel.
- The `/tmp` authoritative checkout and its linked worktree were subject to
  10-day `tmpfiles` aging, so the backend's runtime tree was not durable.
- The user manager lacked `Linger=yes`, so user units would not start at boot.

## Goal

After a machine or service restart, a reviewer signs in at
`https://vektor.phibkro.org` and observes previously committed native records.
Persisted data survives the restart.

## Supervision contract

Declarative systemd user units, installed from the repository:

- `vektor-preview-postgres.service` — PostgreSQL 17 on `127.0.0.1:5434`
  with `PGDATA` in the existing `~/.local/state/vektor-preview/pgdata`.
- `vektor-preview-backend.service` — native backend (`apps/backend`) on
  `127.0.0.1:8790`, `After=`/`Requires=` the postgres unit and gated on a
  `pg_isready` readiness probe via `ExecStartPre`.
- `vektor-preview-tunnel.service` — cloudflared running the dedicated apex
  tunnel with its existing restricted ingress file (read-only use of the
  existing `~/.local/state/vektor-preview/cloudflared/apex-tunnel.yml`;
  never modified).
- All units: `Restart=on-failure` with bounded start limits,
  `WantedBy=default.target` via a `[Install]` section, stable unit names,
  no secrets in unit text — an `EnvironmentFile=` pointing at a `0600`
  `~/.config/vektor-preview/backend.env` file carries the backend secret.
- Runtime scope: units live directly under `default.target` in the user
  manager (not under `herdr.slice`), so they survive agent tooling exits.

## Durable checkout

The backend runtime tree must survive reboot and `/tmp` aging:

- A bare mirror `mono-web-durable.git` lives on `/srv/share` under the
  project area. It holds the authoritative history and the
  `feat/durable-apex-preview` branch.
- The runtime worktree `mono-web-durable-preview` is created from that
  mirror at the recorded commit. It hosts the supervised backend runtime
  (with `bun install` dependencies) and the unit templates under
  `infra/host/units/`.
- The `/tmp` authoritative checkout is preserved by the operator; this
  capsule does not modify it.

## Install path

A repo-owned installer `infra/host/preview-services.sh` provides:

- `install` — renders and installs the unit files into
  `~/.config/systemd/user/`, enables them (`WantedBy=default.target`),
  reloads the user daemon, and enables `loginctl enable-linger` for the
  operator user when the manager must start units at boot without an
  active login session.
- `up` — starts (or restarts) the units in dependency order.
- `down` — stops them in reverse order (tunnel, backend, postgres).
- `status` — reports unit activity and the three loopback probes.
- `restart` — restarts the full chain (tunnel, backend, postgres).

The installer never deletes or reinitializes `PGDATA`. Teardown remains
owned by the pre-existing `teardown.sh`, which this capsule does not change.

## Environment file

`~/.config/vektor-preview/backend.env` (`0600`):

```
BETTER_AUTH_SECRET=<operator secret, never committed>
```

The units reference it via `EnvironmentFile=`; systemd rejects units whose
secrets are embedded in unit text on this host. The installer generates the
file from the existing `better-auth-secret` file when absent and refuses to
overwrite an existing file.

## Adoption

Adoption moves the live preview from ad-hoc to supervised without data loss:

1. Record the pre-adoption baseline: migration count (`23`), data counts
   (`auth.user`, `auth.session`, `person_profiles`), apex health.
2. Stop the ad-hoc tunnel and backend processes first, then stop the ad-hoc
   postgres cleanly (the dedicated port `5434` and `PGDATA` match only our
   cluster; shared-host clusters on other ports are untouched).
3. Start the supervised units in dependency order.
4. Verify continuity: same `PGDATA`, migrations `23`/`23`, data counts
   equal to baseline, loopback health `200`, tunnel reconnected, apex live.

## Restart test

The capsule requires these observable restart outcomes:

- `systemctl --user restart` of each unit in turn leaves the apex journey
  working after the chain settles.
- Killing the backend process (`SIGKILL`) triggers `Restart=on-failure`
  auto-recovery; the apex journey works again.
- Data counts and migration count are identical before and after every
  restart; no reinitialization of `PGDATA` occurs.
- A Chromium journey on `https://vektor.phibkro.org`: sign in with the
  protected operator credentials, observe previously committed native
  records, no console or page errors, same-origin traffic only. Credential
  values are never recorded; evidence uses relative paths and sanitized
  JSON under `/tmp`.

## Acceptance

- After adoption and after every restart scenario, the apex host serves the
  reviewer journey: homepage, sign-in, authenticated dashboard, and the
  previously committed native records remain visible.
- Migration count stays `23`/`23` and data counts stay identical to the
  pre-adoption baseline across all restart scenarios.
- `systemctl --user` reports the three units `active` with `WantedBy=`
  `default.target` enablement and `Restart=on-failure`.
- The backend unit starts only after `pg_isready` succeeds on port `5434`.
- No console errors during the Chromium journey; all browser traffic stays
  on `https://vektor.phibkro.org`.

## Forbidden effects

- production data access or production credential changes
- a shared database change
- a shared tunnel change; any modification of tunnel ingress file contents,
  DNS, or Cloudflare state
- a deployment to `p20` or a production stage
- remote-state deletion or forced resource adoption
- deletion or reinitialization of the preview `PGDATA` or preview database
- push or PR from this capsule

# Homepage DEV CONTENT

This package is the non-production homepage checkpoint. It builds one React Router
Worker with one bundled, synthetic `DEV_CONTENT` source. It does not call the API,
load the SDK, read a homepage environment selector, or reference production assets.

## Prerequisites

- Bun `1.3.10` (the repository package manager)
- Node `>=22` for tooling that requires Node compatibility
- Chromium installed for the Playwright journey

Install from the repository root:

```sh
bun install --frozen-lockfile
```

## Local Worker

Build and serve the actual Cloudflare-compatible Worker on loopback:

```sh
bun run --cwd apps/homepage worker:build
bun run --cwd apps/homepage worker:dev
```

The local harness uses `http://127.0.0.1:8787` with the exact Host header
`p000.vektor.phibkro.org`. `p000` is a local-only sentinel. It is never an Alchemy
stage and must never be passed to a provider command.

Useful local probes:

```sh
curl -i -H 'Host: p000.vektor.phibkro.org' http://127.0.0.1:8787/
curl -i -H 'Host: p000.vektor.phibkro.org' http://127.0.0.1:8787/team
curl -i -H 'Host: p000.vektor.phibkro.org' http://127.0.0.1:8787/kontakt/trondheim
curl -i -H 'Host: p000.vektor.phibkro.org' http://127.0.0.1:8787/health
```

Every valid response includes request-time `X-Mono-Web-Stage`,
`X-Mono-Web-Host`, and `X-Robots-Tag: noindex`. `/health` is provenance only;
it is not homepage evidence. Unknown paths return `404`, and non-`GET /health`
returns `405` with `Allow: GET`.

## Checks

Run all four local gates without credentials or provider access:

```sh
bun run --cwd apps/homepage check-types
bun run --cwd apps/homepage test:resolver
bun run --cwd apps/homepage test:dev-content
bun run --cwd apps/homepage worker:build
```

Run the deterministic Playwright journey after installing the browser:

```sh
bun run --cwd apps/homepage e2e:install
bun run --cwd apps/homepage e2e:test
```

The journey fixes the viewport at `1440x900`, sends the local-only Host header,
records screenshots/video/trace, denies non-loopback and unlisted network calls,
and covers `/`, `/team`, `/kontakt/trondheim`, `/health`, `404`, and `405`.

## Alchemy operator boundary

`alchemy.run.ts` is the sole Cloudflare declaration. It creates one
`MonoWebHomepage` stack with one `Cloudflare.Website.Vite("Homepage")` resource,
`workersDev: false`, a singular exact custom domain, and
`assets.runWorkerFirst: true`. The declaration rejects `p000` before the resource
is constructed.

The homepage wrapper is the sole safe command authority. Use this grammar
exactly; do not invoke Alchemy directly:

```sh
bun run --cwd infra/alchemy guard -- --stage p000
bun run --cwd infra/alchemy plan -- --stage <p001..p999|dev-main> --profile <token>
bun run --cwd infra/alchemy deploy -- --stage <p001..p999|dev-main> --profile <token> --yes
bun run --cwd infra/alchemy destroy -- --stage <p001..p999|dev-main> --profile <token> --dry-run
bun run --cwd infra/alchemy destroy -- --stage <p001..p999|dev-main> --profile <token> --yes
```

`p000` is local-only. The wrapper rejects ambient selectors, the
case-insensitive `default` profile, and all unsupported flags before any child
process. Only a named operator with an approved non-production scope record may
run a telemetry-disabled cloud command.

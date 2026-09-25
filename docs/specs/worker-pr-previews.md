# Worker PR previews

Status: frontend preview automation exists in source. Workspace-gate and deployed-provider acceptance remain open.

The workflow builds the frontends but does not itself establish the full workspace-validation gate required below.
[STATE.md](../../STATE.md#next) records the acceptance work. Provider actions still require explicit authority.

## Goal

Every same-repository pull request gets current Cloudflare Worker Preview URLs for the public homepage and staff dashboard. Updating a pull request updates the same named previews. Closing it deletes both previews and removes the review comment.

## Preview Workers

- `infra/previews/homepage.wrangler.json` names the Worker `vektor-preview-homepage`. `infra/previews/dashboard.wrangler.json` names the Worker `vektor-preview-dashboard`.
- The two Workers hold only pull-request previews. Each configuration sets `workers_dev: false` and `preview_urls: true`.
- The production `workers.dev` route of each Worker stays disabled. Cloudflare configures production and Preview `workers.dev` URLs separately ([workers.dev Preview URLs](https://developers.cloudflare.com/workers/previews/custom-domains/#enable-workersdev-preview-urls)).
- A preview URL has the form `https://pr-<number>-vektor-preview-<app>.<subdomain>.workers.dev`.
- If a Worker does not exist, `wrangler preview` creates it as an empty parent Worker with these two settings.
  Wrangler 4.125.0 added this step ([workers-sdk#15174](https://github.com/cloudflare/workers-sdk/pull/15174)). The workspace pins Wrangler 4.136.1.
- `scripts/deploy-preview.ts` never runs `wrangler deploy`. Thus no pull-request build becomes a production version.
- The Cloudflare API token needs the account permission Workers Scripts: Edit. The token creates the Workers on first use and the previews on each run.

## Boundaries

- Use Cloudflare Worker Previews through Wrangler 4.135 or newer.
- Build and deploy the exact pull-request head.
- Never expose Cloudflare credentials to fork pull requests.
- Previews are frontend-only until the native backend has a preview host. They set no API origin. They do not preview backend code or own isolated PostgreSQL state.
- Pages that read the API show their unavailable state. The homepage answers 503 at `/` and on news pages. Dashboard sign-in reports that the service is unavailable.
- The dashboard Worker Preview covers its unauthenticated shell and server-rendered routes. Authenticated staff journeys have no preview until a backend preview host exists and preview-origin and cookie policy are explicitly designed.
- Preview host acceptance is enabled only by explicit Preview configuration and only for `*.workers.dev` hosts.
- No full-system preview exists. Worker Previews cannot bind one Preview Worker to another Preview Worker.
- Do not deploy or mutate production.

## Done when

1. A same-repository pull request build validates the workspace, builds both frontends, deploys `pr-<number>` previews, and publishes both URLs in one updated comment.
2. The deployed homepage answers `/health` and `/om-oss`, and the deployed dashboard answers `/login`. Each document and its static assets come from the exact pull-request build.
3. A closed pull request deletes both previews and removes the comment.
4. Fork pull requests execute no credentialed deployment.
5. Local checks prove configuration, host policy, build, formatting, lint, and type correctness without making a provider change.
6. The first run creates both preview Workers without a production version. Later runs create or update only previews.

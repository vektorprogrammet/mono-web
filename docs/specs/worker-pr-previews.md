# Worker PR previews

Status: frozen for implementation, 2026-09-23.

## Goal

Every same-repository pull request gets current Cloudflare Worker Preview URLs for the public homepage and staff dashboard. Updating a pull request updates the same named previews. Closing it deletes both previews and removes the review comment.

## Boundaries

- Use Cloudflare Worker Previews through Wrangler 4.135 or newer.
- Build and deploy the exact pull-request head.
- Never expose Cloudflare credentials to fork pull requests.
- Frontend previews read the deployed development API; they do not preview backend code or own isolated PostgreSQL state.
- The dashboard Worker Preview covers its unauthenticated shell and server-rendered routes. Authenticated staff journeys remain on the container-backed preview until preview-origin and cookie policy are explicitly designed.
- Preview host acceptance is enabled only by explicit Preview configuration and only for `*.workers.dev` hosts.
- Retain the container-backed preview implementation as the isolated full-system path; Worker Previews cannot bind one Preview Worker to another Preview Worker.
- Do not deploy or mutate production.

## Done when

1. A same-repository pull request build validates the workspace, builds both frontends, deploys `pr-<number>` previews, and publishes both URLs in one updated comment.
2. Both deployed URLs return successful application responses and static assets from the exact pull-request build.
3. A closed pull request deletes both previews and removes the comment.
4. Fork pull requests execute no credentialed deployment.
5. Local checks prove configuration, host policy, build, formatting, lint, and type correctness without making a provider change.

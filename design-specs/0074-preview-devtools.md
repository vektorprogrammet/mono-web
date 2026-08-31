# Design spec 0074 — preview devtools

## Metadata

| Field             | Value                                                                            |
| ----------------- | -------------------------------------------------------------------------------- |
| Status            | Implemented                                                                      |
| Base              | `0bc4aa3ac5506b6371d25972c9608eee8e35c17d` (`0bc4aa3a`)                          |
| Goal              | Add dashboard preview controls that production bundles cannot contain            |
| Actor             | A developer or preview operator                                                  |
| Scope             | `apps/dashboard`                                                                 |
| Operator boundary | No deploy, credential change, server authorization change, or panel network call |

## Goal

The panel previews three dashboard roles without a new login. The panel also controls the Foldkit `Inspect` overlay.

The supported roles are:

- `ROLE_TEAM_MEMBER`
- `ROLE_TEAM_LEADER`
- `ROLE_ADMIN`

The panel changes client rendering only. Server loaders, actions, and API authorization always use the real session.

## Deployment identity

The dashboard has these preview identities:

1. A local Vite server.
2. The `dev-main` stage on `vektor.phibkro.org`.
3. The `p20` stage on `p20.vektor.phibkro.org`.

`validateDashboardPreviewStage` accepts only the two deployed stage and host pairs. An invalid pair fails before the Worker serves a request.

## Two-layer gate

### Build-time gate

`vite.config.ts` defines `import.meta.env.VITE_PREVIEW_DEVTOOLS` as a static string.

- The `serve` command defines the value as `"true"` for local development.
- A build defines the value as `"true"` only when `VITE_PREVIEW_DEVTOOLS=true`.
- A production build defines the value as `"false"`.

`entry.client.tsx` places the preview composition root behind a guarded dynamic import. The production branch registers the ordinary dashboard custom element.

The React shell also places its role-override import behind the same static condition. Rollup removes both import graphs from production.

### Runtime gate

The panel reads `window.location.hostname`. It accepts only:

- `localhost`, `127.0.0.1`, or `::1`
- `vektor.phibkro.org` as `dev-main`
- `p20.vektor.phibkro.org` as `p20`

The deployed host checks call `previewDevtoolsEnabled` with the same stage and host pairs as `validateDashboardPreviewStage`. All other hosts fail closed.

Both gates must pass before the panel mounts.

## Client architecture

### Preview composition root

`preview-devtools-bootstrap.ts` is the only preview entry. It registers the preview dashboard element and mounts the panel.

Production does not emit this module or its dependency graph.

### Role override

`preview-role-override.ts` owns the localStorage key and role schema. It accepts only the three supported role literals.

The preview dashboard element applies the role before the Foldkit input schema decodes the input. The remaining server input does not change.

The React shell loads the override after hydration. It changes only the `isAdmin` rendering value.

A member override can hide admin navigation. A leader or admin override can show admin navigation. Backend authorization does not change.

### Foldkit devtools

The preview dashboard element owns the preview-only `setDevTools` method. The panel uses this method to re-embed the dashboard.

The toggle selects one of these values:

- `false`
- `{ show: "Always", mode: "Inspect" }`

The ordinary production dashboard element has no `setDevTools` method.

### Reset

The reset control removes the localStorage value. It reloads the page to restore the server-provided role.

## Security properties

The panel performs no network request. It imports no server module.

No `.server.ts` or `.server.tsx` module imports the panel or reads the storage key. `devtools-boundary.test.ts` scans this boundary.

The localStorage value is untrusted input. Effect Schema rejects unknown role values.

The server remains the only owner of identity, permissions, actions, and data access.

## Falsifiers

### F1 — Production bundle contains preview code

`assert-preview-devtools-bundles.mjs` builds with `VITE_PREVIEW_DEVTOOLS=false`. It scans client and server output for panel and role-override markers.

The same script builds with `VITE_PREVIEW_DEVTOOLS=true`. This build must contain both storage and panel markers.

The test fails if the production scan finds one marker. The test also fails if the positive control finds no marker.

### F2 — The override changes server authority

The role tests change only the `role` field in the serialized Foldkit input. They keep the real user and all other input fields.

The boundary test fails if a server module references the panel or role-override module.

### F3 — An invalid host shows the panel

The gate tests reject unknown stages, mismatched stage and host pairs, missing values, and hostile host suffixes.

### F4 — Production registers a preview dashboard element

The production client uses `registerDashboardElement`. The preview element is reachable only from the build-gated dynamic import.

The production bundle scan covers this property.

## Non-goals

- The feature does not replace Foldkit devtools.
- The feature does not store data outside localStorage.
- The feature does not add telemetry or a feature-flag service.
- The feature does not change a loader, action, bridge route, SDK client, or backend rule.
- The feature does not support homepage controls.
- The feature does not support roles outside the three dashboard roles.

## Test plan

- Make sure that the build gate is true for local serve and exact preview builds.
- Make sure that production and unknown deployment values fail closed.
- Make sure that role storage rejects malformed JSON and unknown roles.
- Make sure that a role change preserves all non-role Foldkit input.
- Make sure that the Foldkit toggle re-embeds each preview dashboard element.
- Make sure that no server module references preview storage or panel code.
- Build production and make sure that both output trees contain zero markers.
- Build the positive control and make sure that it contains both markers.
- Use a local browser to show role changes and production panel absence.

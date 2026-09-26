# Foldkit dashboard

Status: frozen for implementation on 2026-09-26 (operator decision). Remove this specification when the dashboard runs without React or React Router, and `docs/architecture.md`, `AGENTS.md`, and the effect-house overlay describe it.

## Decision (operator, 2026-09-26)

The whole dashboard becomes one Foldkit application, and it runs Effect end to end:
- **Server:** the Effect `HttpApi` backend, as today.
- **Wire:** the `HttpApi` definitions in `packages/http-api`.
- **Client:** Foldkit, which is built on Effect, calls the API through the typed Effect client derived from those same definitions.

This spec covers `apps/dashboard` only. The docs site (Fumadocs on TanStack Start) and the homepage are out of scope.

## Evidence (measured on `68058e23`)

- 52 React Router route modules. 18 of them already mount a Foldkit element through the custom-element bridge.
- 12 Foldkit modules (16,382 lines), against 7,347 lines of React route code, with 27 `useState`/`useEffect`/`useReducer` uses in routes and 22 shadcn `components/ui` files.
- The installed `foldkit@0.163.0` provides typed routes (`defineRouteUnion`), navigation (`pushUrl`, `replaceUrl`, `load`), `makeApplication`, `hydrate`, and `http`. A second copy, `foldkit@0.148.1`, is also installed; the knip slice removes whatever pulls it in.
- The review found defects at the React–Foldkit seam: stale custom-element input, keys minted per attempt, and state kept outside the one Model.

## Target

- **One Foldkit application.** One Model, typed routes, and navigation. The existing Foldkit modules become its submodels, and each route is a page submodel. There is no React, React Router, Radix, or shadcn in the dashboard. Widgets come from `@foldkit/ui`: stateful widgets (dialog, menu, combobox, and so on) are submodels, and stateless ones are render helpers. Tailwind stays.
- **The typed Effect client.** The dashboard calls the backend through the Effect `HttpApiClient` of `packages/http-api`, not the Promise SDK. Typed problems reach `update` as values. The classification construct (credential, validation, conflict, transient; only credential signs out) and the command-identity construct (the key and the original precondition, kept until confirmed) are Foldkit Commands built on that client.
- **Served by Effect.** A small Effect `HttpServer` (platform-bun) serves the app shell and assets, at the same origin through the router module in [infrastructure ports](infrastructure-ports.md). Authenticated routes render on the client. Every response is `private, no-store` by default.
- **Pre-JS flows keep working.** The flows that must work before JavaScript loads (login, OAuth consent, account activation and claim, password reset) render on the server with Foldkit and hydrate. Their security headers and CSRF checks stay as they are today. The inventory in phase 1 decides which routes need server rendering; any route not in it is client-only.
- **Foldkit's conventions.** The dashboard follows Foldkit's own conventions. The Foldkit repository is vendored as a git subtree at `repos/foldkit`, pinned to the installed release tag, as the Foldkit skill recommends. The `audit-program` skill's quality bar applies to every converted page.

## Phases

1. **Inventory and skeleton.**
   - Vendor the Foldkit subtree.
   - List every route with its server-side work (loaders, actions, cookies, redirects, headers) and classify it as client-only or needing server rendering.
   - Build the application shell (Model, routes, navigation, the authenticated layout, and the typed client), served by the Effect server behind the router, while React Router still serves every route.
   - Convert one route that no review fix touches, as the pilot.
   - Record what felt awkward, and adjust this spec before phase 2.
2. **Convert routes by area,** one area per slice. Start with the areas whose Foldkit modules already exist, which only need their React host removed. The existing browser journeys are the acceptance oracle for each area: they must pass unchanged, or with only their selectors updated.
3. **Pre-JS flows,** with server rendering and hydration.
4. **Remove React:** React, React Router, the custom-element bridge, shadcn, and Radix. The dashboard's dependency list has no React package.

## Done when

1. `apps/dashboard` has no React, React Router, Radix, or shadcn dependency. `rg` finds no `.tsx` route module.
2. Every existing dashboard browser journey passes via `just measure` and in hosted CI, and axe reports no violations on every page state that the journeys audit.
3. Login, OAuth consent, account activation, and password reset work with JavaScript disabled (Playwright with JavaScript off). Their headers match what they send today.
4. Every authenticated response is `private, no-store`, shown by a test that walks every route.
5. A lint or conventions rule rejects React imports in `apps/dashboard`, and another rejects API calls that bypass the typed client. Each has a negative control.
6. `just check` and the hosted workflows pass.

## Order and coordination

Phase 1 starts now. It must not edit the routes that the review fixes own (FrontendHttpFix, RecruitmentFix, AdmissionsCoreFix, PlacementsFix). Phase 2 starts after those land. FrontendHttpFix builds its classification and command-identity constructs on the Effect client now, so they carry over to Foldkit unchanged.

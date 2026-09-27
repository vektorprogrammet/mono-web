# request-ledger

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Classifies the requests that journey recorders observe by whole path segments: native contract operations and legacy routes. The [index](../constructs.md) lists every category.

## `isNativeRequest`

Whether a dashboard-to-backend request stays on the native surface: an operation of the native HTTP contract or an email-password route of the identity engine.

```ts
isNativeRequest(method: string, pathname: string): boolean
```

- Inputs:
  - `method: string`
  - `pathname: string`
- Output: `boolean`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/dashboard/e2e/native-operations.ts:93](../../apps/dashboard/e2e/native-operations.ts#L93)

**How it works**

The operations come from the OpenAPI document of `ExternalNativeApi`, each a method and a path
template. A request is one of them when `method`, in upper case, is the operation's and
`pathname` fills the template segment by segment: a parameter such as `{sessionId}` or
`{receiptId}:approve` holds the rest of one whole segment, and the literal text around it must
match, so a random value in a parameter never changes the answer. Beside the contract, only
`POST /api/auth/sign-in/email`, `POST /api/auth/sign-up/email`, and
`GET /api/auth/get-session` are native. Every other request, such as a legacy API call or a
provider, recovery, or token route, leaves the surface.

**Use**

```ts
proxy.records.filter(({ method, pathname }) => !isNativeRequest(method, pathname));
```

**Avoid**

A recorder that lists the forbidden routes by name, or tests a path for a substring: a
new legacy or provider route passes the list, and an opaque value in a path matches a route
name by chance. Ask `isNativeRequest` whether the request stays on the native surface.

## `addressesAnyRoute`

Whether a request path addresses any of the routes, each matched by whole path segments.

```ts
addressesAnyRoute(pathname: string, routes: ReadonlyArray<string>): boolean
```

- Inputs:
  - `pathname: string`
  - `routes: ReadonlyArray<string>`
- Output: `boolean`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [apps/dashboard/e2e/request-routes.ts:54](../../apps/dashboard/e2e/request-routes.ts#L54)

**How it works**

A path addresses a route when the route's segments appear in it whole and consecutive, at any
depth: `/mock/api` addresses `/mock/api/users` and `/app/mock/api/data.ts` but not
`/mock/apis`. A React Router single-fetch path `<path>.data` addresses `<path>`, and empty
segments do not count. `legacyRoutes` in this module is the one list of legacy routes; a
journey that refuses more routes, such as its providers, spreads it into its own list.

**Use**

```ts
browserRequests.filter((request) => addressesAnyRoute(request.pathname, legacyRoutes));
```

**Avoid**

`pathname.includes(route)` or a prefix test: a session identifier or the content hash in a
built file name contains a route name by chance, and `/mock/apis` starts with `/mock/api`.
Match routes with `addressesAnyRoute`.

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
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/dashboard/e2e/native-operations.ts:73](../../apps/dashboard/e2e/native-operations.ts#L73)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

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
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [apps/dashboard/e2e/request-routes.ts:36](../../apps/dashboard/e2e/request-routes.ts#L36)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

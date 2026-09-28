# rpc-transport

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Addresses the native RPC endpoints over HTTP, as the ingress serves them and every recorder matches them. The [index](../constructs.md) lists every category.

## `isNativeRpcPath`

Whether a request path addresses the native RPC endpoint.

```ts
isNativeRpcPath(pathname: string): boolean
```

- Inputs: `pathname: string`
- Output: `boolean`
- Errors: none
- Requirements: none
- Side effects: none
- Source: [packages/rpc/src/api.ts:58](../../packages/rpc/src/api.ts#L58)

**How it works**

The RPC client joins the endpoint URL with an empty request URL, so it posts to the path with one
trailing slash (`/api/rpc/`); a probe that builds its own request posts to `/api/rpc`. The
ingress serves both, and every recorder and filter asks this predicate, so no check matches one
spelling and silently misses the other.

**Use**

```ts
if (request.method === "POST" && isNativeRpcPath(new URL(request.url).pathname)) record(body);
```

**Avoid**

`pathname === nativeRpcPath` or `pathname === "/api/rpc"`: every call of the RPC client
misses it. `anti-slop/no-rpc-path-comparison` rejects both.

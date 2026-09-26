# runtime-bridge

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Runs the Effect programs behind Promise callbacks that a third-party library calls, inside the scope of the layer that owns the library. The [index](../constructs.md) lists every category.

## `makeBetterAuthCallbackRunner`

Creates the runner for Better Auth's Promise callbacks: it forks each program into a fiber set that the current scope owns, so closing the scope interrupts the callbacks still running.

```ts
const makeBetterAuthCallbackRunner: Effect.Effect<BetterAuthCallbackRunner, never, Scope.Scope>
```

- Inputs: none
- Output: `Effect.Effect<BetterAuthCallbackRunner, never, Scope.Scope>`
- Errors: none
- Requirements: `Scope.Scope`
- Side effects: Missing: the JSDoc has no `@sideEffects` tag.
- Source: [packages/database/src/auth-engine.ts:39](../../packages/database/src/auth-engine.ts#L39)

**How it works**

Missing: the JSDoc has no `@remarks` tag.

**Use**

Missing: the JSDoc has no `@example` tag.

**Avoid**

Missing: the JSDoc has no `@avoid` tag.

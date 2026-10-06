# ui-target

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Derives stable UI element identities and selectors from decoded model identities. The [index](../constructs.md) lists every category.

## `correctionReopenTarget`

Derives the Reopen button's stable id and eligible focus selector from its interview.

```ts
correctionReopenTarget(interviewId: string): CorrectionReopenTarget
```

- Inputs: `interviewId: string`
- Output: `CorrectionReopenTarget`
- Errors: none
- Requirements: none
- Side effects: None. This is a pure projection of a decoded interview identity.
- Source: [apps/dashboard/app/foldkit/recruitment-maintenance/correction-window.ts:37](../../apps/dashboard/app/foldkit/recruitment-maintenance/correction-window.ts#L37)

**How it works**

The view and Command share this identity; disabled controls never match the selector.

**Use**

```ts
const target = correctionReopenTarget("interview-42");
// Render target.id, then use target.selector in the native workflow focus Command.
```

**Avoid**

Do not reuse the Close button's node or infer server eligibility from this identity.

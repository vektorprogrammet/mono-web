# browser-audit

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Audits the pages that browser journeys render once they have settled: accessibility with axe. The [index](../constructs.md) lists every category.

## `auditSettledPage`

Audits a page with axe once every finite animation on it has finished.

```ts
auditSettledPage(
  page: Page,
  options: SettledAxeOptions = {}
): Promise<ReadonlyArray<SettledAxeViolation>>
```

- Inputs:
  - `page: Page`
  - `options: SettledAxeOptions = {}`
- Output: `Promise<ReadonlyArray<SettledAxeViolation>>`
- Errors: none
- Requirements: none
- Side effects: Evaluates a script in the page, and injects and runs axe in each of its frames.
- Source: [apps/dashboard/e2e/settled-axe.ts:82](../../apps/dashboard/e2e/settled-axe.ts#L82)

**How it works**

It waits in the page for every running animation and transition whose end is finite
(`document.getAnimations()`, each one's `finished`), then runs axe with the caller's tags and
regions, and returns each violation with its rule, impact, and the targets that fail with axe's
failure summary. It returns no markup, so no value that a field holds reaches a log or the
evidence. An animation that repeats forever, such as a spinner, never finishes, so the wait skips
it; an animation that is cancelled while it waits counts as settled. The caller keeps its own
assertion: an exact empty list, or no violation of serious or critical impact.

**Use**

```ts
const violations = await auditSettledPage(page, { tags: ["wcag2a", "wcag2aa"] });
expect(violations).toEqual([]);
```

**Avoid**

Calling `new AxeBuilder({ page }).analyze()` right after an interaction: a transition
that still runs reads as its midpoint colours, and the audit fails at random (the onboarding
and golden reimbursement runs of 2026-09-28). `anti-slop/no-unsettled-axe` rejects it.

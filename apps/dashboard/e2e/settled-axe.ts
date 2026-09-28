/**
 * The accessibility audit of the browser journeys: axe on a page whose animations have settled.
 *
 * Axe reads computed colours. A CSS transition that still runs reads as its midpoint: the shared
 * button carries `transition-all` and `disabled:opacity-50`, so right after a submission it is
 * enabled and half transparent for 150 ms, which axe reports as `color-contrast`. The dashboard,
 * the homepage, and the tools that drive them audit through `auditSettledPage`, and the Oxlint rule
 * `anti-slop/no-unsettled-axe` rejects `new AxeBuilder(...)` anywhere else.
 *
 * The module lives beside the dashboard journeys because the dashboard owns `@axe-core/playwright`
 * and Playwright: a Node or Bun runner in another workspace imports it by path, and the axe package
 * resolves from here. It uses only erasable TypeScript, so Node runs it without a build.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

/** What axe audits: its rule tags, and the selectors of the regions it includes or excludes. */
export interface SettledAxeOptions {
  /** Run only the rules with one of these tags, such as `wcag2aa`; all rules when absent. */
  readonly tags?: ReadonlyArray<string>;
  /** Audit only these regions; the whole page when absent. */
  readonly include?: ReadonlyArray<string>;
  /** Leave these regions out of the audit. */
  readonly exclude?: ReadonlyArray<string>;
}

/** One element that violates a rule. */
export interface SettledAxeTarget {
  /** The element's selector; a selector into a frame or shadow root joins its steps with a space. */
  readonly target: string;
  /** Axe's account of what the element fails. */
  readonly failureSummary: string;
}

/** One violated axe rule and the elements that violate it. */
export interface SettledAxeViolation {
  /** The rule, such as `color-contrast`. */
  readonly id: string;
  /** `minor`, `moderate`, `serious`, or `critical`; `null` when axe names none. */
  readonly impact: string | null;
  /** The elements that violate the rule. */
  readonly targets: ReadonlyArray<SettledAxeTarget>;
}

/**
 * Resolves in the page once every animation with a finite end has finished or been cancelled. It is
 * source text, so the tools that import this module type-check it without the DOM library.
 */
const settleAnimations = `Promise.all(
  document
    .getAnimations()
    .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
    .map((animation) => animation.finished.catch(() => animation)),
)`;

/**
 * Audits a page with axe once every finite animation on it has finished.
 *
 * @remarks
 * It waits in the page for every running animation and transition whose end is finite
 * (`document.getAnimations()`, each one's `finished`), then runs axe with the caller's tags and
 * regions, and returns each violation with its rule, impact, and the targets that fail with axe's
 * failure summary. It returns no markup, so no value that a field holds reaches a log or the
 * evidence. An animation that repeats forever, such as a spinner, never finishes, so the wait skips
 * it; an animation that is cancelled while it waits counts as settled. The caller keeps its own
 * assertion: an exact empty list, or no violation of serious or critical impact.
 *
 * @sideEffects Evaluates a script in the page, and injects and runs axe in each of its frames.
 *
 * @example
 * ```ts
 * const violations = await auditSettledPage(page, { tags: ["wcag2a", "wcag2aa"] });
 * expect(violations).toEqual([]);
 * ```
 *
 * @avoid Calling `new AxeBuilder({ page }).analyze()` right after an interaction: a transition
 * that still runs reads as its midpoint colours, and the audit fails at random (the onboarding
 * and golden reimbursement runs of 2026-09-28). `anti-slop/no-unsettled-axe` rejects it.
 *
 * @construct browser-audit
 */
export const auditSettledPage = async (
  /** The page to audit, where the journey's last interaction has already been awaited. */
  page: Page,
  /** The rule tags and regions of the audit; all rules on the whole page when absent. */
  options: SettledAxeOptions = {},
): Promise<ReadonlyArray<SettledAxeViolation>> => {
  await page.evaluate(settleAnimations);

  const builder = new AxeBuilder({ page });

  if (options.tags !== undefined) builder.withTags([...options.tags]);

  for (const selector of options.include ?? []) builder.include(selector);

  for (const selector of options.exclude ?? []) builder.exclude(selector);

  const { violations } = await builder.analyze();

  return violations.map(({ id, impact, nodes }) => ({
    id,
    impact: impact ?? null,
    targets: nodes.map((node) => ({
      target: node.target.map(String).join(" "),
      failureSummary: node.failureSummary ?? "",
    })),
  }));
};

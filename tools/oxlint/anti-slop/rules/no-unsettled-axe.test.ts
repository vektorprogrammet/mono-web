// Run with `node --test`: the Oxlint RuleTester parses through raw transfer, which Bun lacks.
import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noUnsettledAxeRule } from "./no-unsettled-axe.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const unsettled = [{ messageId: "unsettledAxe" }];

new RuleTester().run("no-unsettled-axe", noUnsettledAxeRule, {
  valid: [
    // Negative controls: the construct, other builders, other packages, and the name as text.
    'import { auditSettledPage } from "./settled-axe.ts"',
    "expect(await auditSettledPage(page)).toEqual([])",
    'const violations = await auditSettledPage(page, { tags: ["wcag2a", "wcag2aa"] })',
    'const { chromium } = requireDashboard("@playwright/test")',
    'import { expect, test } from "@playwright/test"',
    "const builder = new StringBuilder()",
    "const audit = new Audit({ page })",
    'const label = "AxeBuilder"',
    'const name = "@axe-core/playwright is audited by auditSettledPage"',
  ],
  invalid: [
    // The onboarding spec of 2026-09-28: axe right after the submit button left its disabled state.
    {
      code: 'import AxeBuilder from "@axe-core/playwright"',
      errors: unsettled,
    },
    {
      code: "const result = await new AxeBuilder({ page }).analyze()",
      errors: unsettled,
    },
    {
      code: 'const audit = await new AxeBuilder({ page }).withTags(["wcag2a"]).include("main").analyze()',
      errors: unsettled,
    },
    // The acceptance tools load the package through a require of the dashboard.
    {
      code: 'const AxeBuilder = requireDashboard("@axe-core/playwright").default',
      errors: unsettled,
    },
    {
      code: 'const Axe = require(`@axe-core/playwright`).default; const r = await new Axe({ page }).analyze()',
      errors: unsettled,
    },
    {
      code: 'const { default: Axe } = await import("@axe-core/playwright")',
      errors: unsettled,
    },
    {
      code: "const result = await new axe.AxeBuilder({ page }).analyze()",
      errors: unsettled,
    },
  ],
});

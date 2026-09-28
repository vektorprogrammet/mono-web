import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

// The axe integration of Playwright, which only the settled-audit construct loads.
const axePackage = "@axe-core/playwright";

function isAxePackage(node: ESTree.Node | null | undefined): boolean {
  if (node === null || node === undefined) return false;
  if (node.type === "Literal") return node.value === axePackage;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked === axePackage;
  }
  return false;
}

/** Whether a constructed callee names the axe builder: `AxeBuilder` or `module.AxeBuilder`. */
function isAxeBuilder(node: ESTree.Node): boolean {
  if (node.type === "Identifier") return node.name === "AxeBuilder";
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
    return node.property.name === "AxeBuilder";
  }
  return false;
}

/**
 * Reject running axe outside `auditSettledPage` of `apps/dashboard/e2e/settled-axe.ts`: constructing
 * `AxeBuilder`, and loading `@axe-core/playwright` by import, dynamic import, or a require call.
 * Axe reads computed colours, so a transition that still runs right after an interaction reads as
 * its midpoint: the shared button is half transparent for 150 ms after it leaves the disabled
 * state, and the onboarding and golden reimbursement journeys failed on `color-contrast` at random
 * (2026-09-28). The construct waits for every finite animation before it runs axe.
 */
export const noUnsettledAxeRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow running axe outside auditSettledPage, which audits a page once its animations have settled.",
    },
    messages: {
      unsettledAxe:
        "An axe audit right after an interaction reads a running transition as its midpoint colours. Audit through `auditSettledPage` of `apps/dashboard/e2e/settled-axe.ts`, which waits for every animation first.",
    },
  },
  createOnce(context) {
    return {
      NewExpression(node) {
        if (isAxeBuilder(node.callee)) context.report({ node, messageId: "unsettledAxe" });
      },
      ImportDeclaration(node) {
        if (isAxePackage(node.source)) context.report({ node, messageId: "unsettledAxe" });
      },
      ImportExpression(node) {
        if (isAxePackage(node.source)) context.report({ node, messageId: "unsettledAxe" });
      },
      CallExpression(node) {
        // require("@axe-core/playwright"), or a createRequire function of another workspace.
        if (node.arguments.some((argument) => isAxePackage(argument))) {
          context.report({ node, messageId: "unsettledAxe" });
        }
      },
    };
  },
});

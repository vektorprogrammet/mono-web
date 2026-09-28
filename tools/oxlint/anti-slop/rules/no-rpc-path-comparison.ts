import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

// The constants of the RPC endpoint paths in `packages/rpc/src/api.ts`.
const endpointConstants = new Set(["nativeRpcPath", "internalNativeRpcPath"]);

// The endpoint paths, with and without the trailing slash of the RPC client.
const endpointPaths = new Set(["/api/rpc", "/api/rpc/", "/internal/rpc", "/internal/rpc/"]);

const equality = new Set(["===", "!==", "==", "!="]);

function staticText(node: ESTree.Node): string | null {
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : null;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/** The endpoint that one operand names: an endpoint constant, its path, or `${constant}/`. */
function endpointOperand(node: ESTree.Node): string | null {
  if (node.type === "Identifier" && endpointConstants.has(node.name)) return node.name;
  const text = staticText(node);
  if (text !== null && endpointPaths.has(text)) return JSON.stringify(text);
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 1 &&
    node.expressions[0]?.type === "Identifier" &&
    endpointConstants.has(node.expressions[0].name)
  ) {
    return `\`\${${node.expressions[0].name}}/\``;
  }
  return null;
}

/**
 * Reject comparing a request path with one spelling of an RPC endpoint path. The RPC client posts
 * to the endpoint with one trailing slash (`/api/rpc/`), and a probe posts without it, so a check
 * that matches one spelling silently misses the other: five journey recorders recorded no RPC of
 * the dashboard server and failed or proved nothing (the RPC migration, 2026-09-28). Ask
 * `isNativeRpcPath` or `isInternalNativeRpcPath` of `@vektorprogrammet/rpc`.
 */
export const noRpcPathComparisonRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow comparing a path with one spelling of an RPC endpoint path; the RPC client adds a trailing slash.",
    },
    messages: {
      rpcPathComparison:
        "Comparing a path with {{endpoint}} misses the other spelling of the RPC endpoint: the RPC client posts with a trailing slash, a probe without. Ask `isNativeRpcPath` or `isInternalNativeRpcPath` of `@vektorprogrammet/rpc`.",
    },
  },
  createOnce(context) {
    return {
      BinaryExpression(node) {
        if (!equality.has(node.operator)) return;
        const endpoint = endpointOperand(node.left) ?? endpointOperand(node.right);
        if (endpoint === null) return;
        context.report({ node, messageId: "rpcPathComparison", data: { endpoint } });
      },
      SwitchCase(node) {
        // case nativeRpcPath: compares the discriminant with one spelling.
        if (node.test === null) return;
        const endpoint = endpointOperand(node.test);
        if (endpoint === null) return;
        context.report({ node, messageId: "rpcPathComparison", data: { endpoint } });
      },
    };
  },
});

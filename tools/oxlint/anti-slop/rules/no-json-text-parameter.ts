import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/** Reports whether an argument is a call that returns JSON text rather than a JSON value. */
function isJsonTextCall(argument: ESTree.Argument | undefined): boolean {
  if (argument?.type !== "CallExpression") return false;
  const callee = argument.callee;
  if (callee.type === "Identifier") return callee.name === "canonicalJson";
  if (
    !("property" in callee) ||
    !("object" in callee) ||
    !("computed" in callee) ||
    callee.computed ||
    callee.property.type !== "Identifier"
  )
    return false;
  return (
    callee.property.name === "canonicalJson" ||
    (callee.property.name === "stringify" &&
      callee.object.type === "Identifier" &&
      callee.object.name === "JSON")
  );
}

/** Ban JSON text as the argument of a `.json(...)` parameter helper, which encodes it again. */
export const noJsonTextParameterRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow JSON text, such as `canonicalJson(...)` or `JSON.stringify(...)`, as the argument of a `.json(...)` SQL parameter; bind the JSON value with `canonicalJsonValue`.",
    },
    messages: {
      jsonText:
        "Use `canonicalJsonValue(...)`. `.json(...)` encodes its argument, so JSON text is stored as a JSON string, not as the value it spells.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          !("property" in callee) ||
          !("computed" in callee) ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "json"
        )
          return;
        const [argument] = node.arguments;
        if (argument !== undefined && isJsonTextCall(argument)) {
          context.report({ node: argument, messageId: "jsonText" });
        }
      },
    };
  },
});

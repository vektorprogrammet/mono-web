import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

// The server methods that make up a probe: bind, read the bound port, release it.
const probeMethods = new Set(["listen", "address", "close"]);

// `Effect.callback(fn)` and `Effect.async(fn)` run `fn` as part of the effect that holds them.
const effectCallbacks = new Set(["callback", "async"]);

const functionTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

/** What one flow scope does with one server identifier. */
interface ServerUse {
  listens: boolean;
  readsAddress: boolean;
  closes: Array<ESTree.Node>;
}

/**
 * A function passed directly to `new Promise(fn)`, to a method of `server` itself, or to
 * `Effect.callback(fn)` or `Effect.async(fn)` runs as part of the flow that passes it.
 */
function isTransparent(fn: ESTree.Node, server: string): boolean {
  const call = fn.parent;

  if (call === null) return false;
  if (call.type !== "CallExpression" && call.type !== "NewExpression") return false;
  if (!call.arguments.some((argument) => argument === fn)) return false;

  const callee = call.callee;

  if (call.type === "NewExpression") return callee.type === "Identifier" && callee.name === "Promise";
  if (callee.type !== "MemberExpression" || callee.computed || callee.object.type !== "Identifier") {
    return false;
  }
  if (callee.object.name === server) return true;
  return (
    callee.object.name === "Effect" &&
    callee.property.type === "Identifier" &&
    effectCallbacks.has(callee.property.name)
  );
}

/**
 * The flow scope of a call on `server`: the nearest enclosing function that is not transparent,
 * or the Program. `inFinally` says whether a `finally` block lies between the call and the scope.
 */
function flowScope(
  node: ESTree.Node,
  server: string,
): { readonly scope: ESTree.Node; readonly inFinally: boolean } {
  let inFinally = false;
  let child = node;
  let current = node.parent;

  while (current !== null) {
    if (current.type === "TryStatement" && current.finalizer === child) inFinally = true;
    if (current.type === "Program") break;
    if (functionTypes.has(current.type) && !isTransparent(current, server)) break;
    child = current;
    current = current.parent;
  }

  return { scope: current ?? child, inFinally };
}

/**
 * Reject a server that listens only to learn a free port and then closes. The port is free only
 * until the close; anything that binds before the caller hands the number to its real owner can
 * take it, as in a batch run where the backend met EADDRINUSE on the port its runner had probed.
 * A probe listens, reads `address()`, and closes outside a `finally` block, all in one flow; a
 * fixed-port availability check reads no address, and teardown in `finally` closes a server that
 * served. Reserve ports with `reserveLoopbackPorts` from `@monoweb/postgres` instead.
 */
export const noPortProbeRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow servers that listen only to learn a free port and then close, which releases the port to any later bind.",
    },
    messages: {
      portProbe:
        "`{{server}}` listens only to learn a port and then closes, so any later bind can take the port before the caller binds it. Reserve ports with `reserveLoopbackPorts` from `@monoweb/postgres`.",
    },
  },
  createOnce(context) {
    let uses = new Map<ESTree.Node, Map<string, ServerUse>>();

    return {
      before() {
        uses = new Map();
      },
      CallExpression(node) {
        const callee = node.callee;

        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.object.type !== "Identifier" ||
          callee.property.type !== "Identifier" ||
          !probeMethods.has(callee.property.name)
        ) {
          return;
        }

        const server = callee.object.name;
        const method = callee.property.name;
        const { scope, inFinally } = flowScope(node, server);

        // Teardown in `finally` closes a server that served, not a probe.
        if (method === "close" && inFinally) return;

        const servers = uses.get(scope) ?? new Map<string, ServerUse>();
        const use = servers.get(server) ?? { listens: false, readsAddress: false, closes: [] };

        if (method === "listen") use.listens = true;
        else if (method === "address") use.readsAddress = true;
        else use.closes.push(node);

        servers.set(server, use);
        uses.set(scope, servers);
      },
      "Program:exit"() {
        for (const servers of uses.values()) {
          for (const [server, use] of servers) {
            const [close] = use.closes;
            // One report per probe, at its first close.
            if (use.listens && use.readsAddress && close !== undefined) {
              context.report({ node: close, messageId: "portProbe", data: { server } });
            }
          }
        }
      },
    };
  },
});

// Run with `node --test`: the Oxlint RuleTester parses through raw transfer, which Bun lacks.
import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noRpcPathComparisonRule } from "./no-rpc-path-comparison.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const comparison = (endpoint: string) => [{ messageId: "rpcPathComparison", data: { endpoint } }];

new RuleTester().run("no-rpc-path-comparison", noRpcPathComparisonRule, {
  valid: [
    // Negative controls: the predicates, building a URL from the constant, and other paths.
    'if (request.method === "POST" && isNativeRpcPath(url.pathname)) record(body)',
    "const endpoint = new URL(nativeRpcPath, origin).href",
    "const url = `${api}${nativeRpcPath}`",
    'if (pathname === "/health") return health()',
    'if (url.pathname === "/api/auth/sign-in/email") signIn()',
    'const rpc = pathname.startsWith("/api/")',
    'if (method === "POST") send()',
  ],
  invalid: [
    // The recorders of the RPC migration: the dashboard server posted to /api/rpc/.
    {
      code: 'const isRpc = method === "POST" && url.pathname === "/api/rpc"',
      errors: comparison('"/api/rpc"'),
    },
    {
      code: "if (url.pathname === nativeRpcPath) record(body)",
      errors: comparison("nativeRpcPath"),
    },
    {
      code: "if (nativeRpcPath !== url.pathname) return",
      errors: comparison("nativeRpcPath"),
    },
    {
      code: "const internal = pathname === internalNativeRpcPath",
      errors: comparison("internalNativeRpcPath"),
    },
    {
      code: 'if (path == "/api/rpc/") record(body)',
      errors: comparison('"/api/rpc/"'),
    },
    {
      code: "const slashed = pathname === `${nativeRpcPath}/`",
      errors: comparison("`${nativeRpcPath}/`"),
    },
    {
      code: "switch (url.pathname) { case nativeRpcPath: record(body); }",
      errors: comparison("nativeRpcPath"),
    },
  ],
});

// Run with `node --test`: the Oxlint RuleTester parses through raw transfer, which Bun lacks.
import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noJsonTextParameterRule } from "./no-json-text-parameter.ts";

RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester().run("no-json-text-parameter", noJsonTextParameterRule, {
  valid: [
    // Negative controls: a JSON value, and JSON text anywhere but a `.json(...)` argument.
    "sql`INSERT INTO t VALUES (${sql.json(canonicalJsonValue(input.teamIds))})`",
    "sql`INSERT INTO t VALUES (${database.json(command)})`",
    "const digest = sha256Hex(new TextEncoder().encode(canonicalJson(input)))",
    "const json = client.json; const bind = (value) => json(JSON.stringify(value))",
    "return HttpServerResponse.json(body)",
  ],
  invalid: [
    {
      code: "sql`INSERT INTO t VALUES (${sql.json(canonicalJson(input.teamIds))})`",
      errors: [{ messageId: "jsonText" }],
    },
    {
      code: "database.json(sharedKernel.canonicalJson(row))",
      errors: [{ messageId: "jsonText" }],
    },
    {
      code: "sql.json(JSON.stringify(value))",
      errors: [{ messageId: "jsonText" }],
    },
  ],
});

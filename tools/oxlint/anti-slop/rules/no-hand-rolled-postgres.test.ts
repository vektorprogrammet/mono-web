// Run with `node --test`: the Oxlint RuleTester parses through raw transfer, which Bun lacks.
import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noHandRolledPostgresRule } from "./no-hand-rolled-postgres.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const handRolled = (program: string) => [{ messageId: "handRolledCluster", data: { program } }];

new RuleTester().run("no-hand-rolled-postgres", noHandRolledPostgresRule, {
  valid: [
    // Negative controls: the construct, client programs, and "postgres" as a role, database,
    // directory, label, or list entry.
    'const postgres = startDisposablePostgres({ user: "receipt", database: "receipt_proof", port })',
    'postgres.createDatabase("identity_auth_live_test")',
    'const maintenance = postgres.urlOf("postgres")',
    'run(postgresProgram("psql"), ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres"])',
    'execFile(postgresProgram("pg_isready"), ["--host", host, "--port", String(port)])',
    'const postgresRoot = join(temporaryRoot, "postgres")',
    'new Pool({ connectionString: "postgres://postgres@127.0.0.1:5432/postgres" })',
    'assert.ok(labels.has("postgres"))',
    'for (const label of ["postgres", "http-child"]) assert.ok(labels.has(label))',
    'format(["postgres", engine])',
    'spawn("bun", ["run", "src/main.ts"])',
    'execSync("git rev-parse HEAD")',
    "$`git status --porcelain`",
    'Promise.resolve("initdb")',
  ],
  invalid: [
    // The CI failure: the server spawned directly, then only its port awaited.
    {
      code: 'postgres = start(postgresProgram("postgres"), ["-D", data, "-p", String(port), "-h", "127.0.0.1"])',
      errors: handRolled("postgres"),
    },
    {
      code: 'run(postgresProgram("initdb"), ["-D", data, "-A", "trust", "-U", "postgres"])',
      errors: handRolled("initdb"),
    },
    {
      code: 'runLocal([postgresProgram("pg_ctl"), "-D", data, "-w", "start"])',
      errors: handRolled("pg_ctl"),
    },
    {
      code: 'run(postgresProgram("createdb"), ["-h", "127.0.0.1", "-p", String(port), name])',
      errors: handRolled("createdb"),
    },
    {
      code: 'run("initdb", ["-D", pgDir, "-A", "trust", "-U", "postgres"])',
      errors: handRolled("initdb"),
    },
    {
      code: 'start("postgres", ["-D", pgDir, "-p", String(pgPort), "-h", "127.0.0.1"])',
      errors: handRolled("postgres"),
    },
    {
      code: 'spawn("/usr/lib/postgresql/18/bin/pg_ctl", args)',
      errors: handRolled("pg_ctl"),
    },
    {
      code: 'execFileSync("createdb", ["-h", "127.0.0.1", name])',
      errors: handRolled("createdb"),
    },
    {
      code: 'runLocal(["pg_ctl", "stop", "-D", dataRoot])',
      errors: handRolled("pg_ctl"),
    },
    {
      code: 'Bun.spawn(["postgres", "-D", dataRoot])',
      errors: handRolled("postgres"),
    },
    {
      code: 'execSync("initdb -D /tmp/cluster --auth=trust")',
      errors: handRolled("initdb"),
    },
    {
      code: "$`pg_ctl -D ${dataRoot} -w start`",
      errors: handRolled("pg_ctl"),
    },
    {
      code: 'const pgCtl = join(binDirectory, "pg_ctl")',
      errors: handRolled("pg_ctl"),
    },
  ],
});

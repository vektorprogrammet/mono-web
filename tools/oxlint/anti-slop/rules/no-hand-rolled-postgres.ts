import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

// The programs that create, start, stop, or populate a cluster.
const clusterPrograms = new Set(["createdb", "initdb", "pg_ctl", "postgres"]);

// Node and Bun APIs that run their first argument as a program with an argument array.
const programApis = new Set(["execFile", "execFileSync", "fork", "spawn", "spawnSync"]);

// Node APIs that run their first argument as a shell command line.
const shellApis = new Set(["exec", "execSync"]);

// Path joins whose last segment names a program file.
const pathApis = new Set(["join", "resolve"]);

// `pg_ctl` actions, which follow the program name in an argument array.
const pgCtlActions = new Set([
  "init",
  "initdb",
  "kill",
  "logrotate",
  "promote",
  "reload",
  "restart",
  "start",
  "status",
  "stop",
]);

function staticText(node: ESTree.Node | null | undefined): string | null {
  if (node === null || node === undefined) return null;
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : null;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/** The cluster program that a program path or bare program name names, if any. */
function clusterProgram(text: string): string | null {
  const program = text.split("/").at(-1) ?? "";
  return clusterPrograms.has(program) ? program : null;
}

/** The cluster program that starts a shell command line, if any. */
function shellClusterProgram(text: string): string | null {
  const program = text.trimStart().split(/\s/u)[0] ?? "";
  return clusterProgram(program);
}

function calleeName(callee: ESTree.Node): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}

/**
 * Whether `elements` reads as an argument array that runs its first element: a second element
 * that is an option, such as `-D`, or a `pg_ctl` action. A list of names, such as
 * `["postgres", "mysql"]`, does not.
 */
function argumentVector(elements: ReadonlyArray<ESTree.Node | null>): boolean {
  const next = staticText(elements[1]);
  return next !== null && (next.startsWith("-") || pgCtlActions.has(next));
}

/**
 * Reject journey code that starts a PostgreSQL cluster by hand. `startDisposablePostgres`
 * reports a cluster ready only once the server accepts connections and owns `initdb`,
 * `createdb`, and teardown; a hand-rolled start that waits for the port races the server's
 * startup ("the database system is starting up").
 */
export const noHandRolledPostgresRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow running the PostgreSQL cluster programs (`initdb`, `postgres`, `pg_ctl`, `createdb`) outside `startDisposablePostgres`.",
    },
    messages: {
      handRolledCluster:
        "Start the cluster with `startDisposablePostgres` (or `withDisposablePostgres`) from `@monoweb/postgres` instead of running `{{program}}`. It waits until the server accepts connections, creates databases with `createDatabase`, and removes the cluster on `stop` or when the process dies; an open port is not readiness.",
    },
  },
  createOnce(context) {
    const report = (node: ESTree.Node, program: string) => {
      context.report({ node, messageId: "handRolledCluster", data: { program } });
    };

    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        const [first, second] = node.arguments;

        if (first === undefined) return;

        const text = staticText(first);

        if (name === "postgresProgram" && text !== null && clusterPrograms.has(text)) {
          report(first, text);
          return;
        }

        if (text !== null && name !== null && shellApis.has(name)) {
          const program = shellClusterProgram(text);
          if (program !== null) report(first, program);
          return;
        }

        if (name !== null && pathApis.has(name)) {
          const last = node.arguments.length > 1 ? node.arguments.at(-1) : undefined;
          const lastText = staticText(last);
          const program = lastText === null ? null : clusterProgram(lastText);
          // `join(root, "postgres")` names a data directory far more often than the server program.
          if (last !== undefined && program !== null && program !== "postgres") report(last, program);
          return;
        }

        if (text !== null) {
          const program = clusterProgram(text);
          const runs =
            (name !== null && programApis.has(name)) || second?.type === "ArrayExpression";
          if (program !== null && runs) report(first, program);
          return;
        }

        if (first.type === "ArrayExpression" && argumentVector(first.elements)) {
          const head = staticText(first.elements[0]);
          const program = head === null ? null : clusterProgram(head);
          if (program !== null) report(first, program);
        }
      },
      TaggedTemplateExpression(node) {
        // Bun Shell: $`initdb -D ${directory}`.
        if (node.tag.type !== "Identifier" || node.tag.name !== "$") return;
        const program = shellClusterProgram(node.quasi.quasis[0]?.value.cooked ?? "");
        if (program !== null) report(node, program);
      },
    };
  },
});

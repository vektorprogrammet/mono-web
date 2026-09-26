/**
 * The shared-construct catalogue.
 *
 * A shared construct is an exported declaration whose JSDoc has a line `@construct <category>`.
 * `just constructs write` renders every construct into `docs/constructs.md` with its summary, its
 * location, and the modules that import it, which the import graph computes. `just constructs`
 * fails when the page differs from that rendering or when a tag is malformed or misplaced, and it
 * warns about functions that three or more modules outside their app or package import untagged.
 */
import { parseSync, type ESTree, type ParseResult } from "rolldown/utils";
import type { Finding } from "./check.js";
import { bindingKey, type ModuleGraph, packageOf } from "./modules.js";
import type { Repository } from "./repository.js";
import { table } from "./sections.js";

/**
 * The construct categories in catalogue order, each with what its constructs do. A tag names one
 * of them; add a category here before the first construct that needs it.
 */
export const constructCategories = {
  "http-transport":
    "Reads native HTTP requests and writes their representations: bounded JSON, preconditions, idempotency keys, entity tags, and cache headers.",
  "http-problem":
    "Answers a native HTTP request with a declared problem: failure mapping, credential classification, authorization, and decoding.",
  "sql-lock": "Transaction-scoped PostgreSQL advisory locks under registered keys.",
  "sql-lifecycle":
    "Claim-fenced row lifecycles in PostgreSQL, such as outbox claims and account access.",
  delivery: "Delivers committed effects to providers after the transaction.",
  worker: "Runs background workers on the Effect clock.",
  pagination: "Keyset cursors and pages over ordered PostgreSQL reads.",
  digest: "Canonical JSON and SHA-256 digests that evidence and idempotency identities hash.",
  "test-harness":
    "Starts and drives disposable infrastructure for tests, proofs, and journeys: PostgreSQL clusters, loopback ports, and the local backend.",
} satisfies Readonly<Record<string, string>>;

export const catalogue = "docs/constructs.md";

const declaration = "tools/conventions/src/constructs.ts";

export interface Construct {
  readonly name: string;
  readonly category: string;
  /** The first sentence of the JSDoc. */
  readonly summary: string;
  readonly path: string;
  readonly line: number;
  /** The modules that import the construct, sorted. */
  readonly consumers: ReadonlyArray<string>;
}

/** An untagged function that three or more modules outside its app or package import. */
export interface Candidate {
  readonly path: string;
  readonly name: string;
  readonly line: number;
  readonly importers: ReadonlyArray<string>;
}

export interface ConstructReport {
  readonly constructs: ReadonlyArray<Construct>;
  /** Malformed or misplaced tags, unused categories, and modules that do not parse. */
  readonly findings: ReadonlyArray<Finding>;
  readonly candidates: ReadonlyArray<Candidate>;
}

/** The fewest importers outside its app or package that make an untagged function a candidate. */
const candidateImporters = 3;

interface Declaration {
  /** The local name, or `default` for an anonymous default export. */
  readonly local: string;
  /** A function declaration, or a variable whose initializer is a function. */
  readonly callable: boolean;
  readonly line: number;
  /** The JSDoc lines without their leading `*`. */
  readonly doc: ReadonlyArray<string>;
}

interface ModuleDeclarations {
  readonly declarations: ReadonlyArray<Declaration>;
  /** The lines of `@construct` tags in comments that are no declaration's JSDoc. */
  readonly strayTags: ReadonlyArray<number>;
}

type Declared = Pick<Declaration, "local" | "callable">;

const bindingNames = (pattern: ESTree.BindingPattern | ESTree.BindingRestElement): string[] => {
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap((property) =>
        bindingNames(property.type === "RestElement" ? property : property.value),
      );
    case "ArrayPattern":
      return pattern.elements.flatMap((element) => (element === null ? [] : bindingNames(element)));
    case "AssignmentPattern":
      return bindingNames(pattern.left);
    case "RestElement":
      return bindingNames(pattern.argument);
  }
};

const isFunction = (expression: ESTree.Expression | null): boolean => {
  switch (expression?.type) {
    case "ArrowFunctionExpression":
    case "FunctionExpression":
      return true;
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "ParenthesizedExpression":
      return isFunction(expression.expression);
    default:
      return false;
  }
};

const declared = (
  node: ESTree.Directive | ESTree.Statement | ESTree.ExportDefaultDeclarationKind,
): ReadonlyArray<Declared> => {
  switch (node.type) {
    case "ExportNamedDeclaration":
      return node.declaration === null ? [] : declared(node.declaration);
    case "ExportDefaultDeclaration": {
      const names = declared(node.declaration);

      return names.length > 0
        ? names
        : [
            {
              local: "default",
              callable:
                node.declaration.type !== "ClassDeclaration" &&
                node.declaration.type !== "TSInterfaceDeclaration" &&
                node.declaration.type !== "FunctionDeclaration" &&
                isFunction(node.declaration),
            },
          ];
    }

    case "VariableDeclaration":
      return node.declarations.flatMap((declarator) =>
        bindingNames(declarator.id).map((local) => ({
          local,
          callable: isFunction(declarator.init),
        })),
      );
    case "FunctionDeclaration":
    case "TSDeclareFunction":
      return [{ local: node.id?.name ?? "default", callable: true }];
    case "ClassDeclaration":
      return [{ local: node.id?.name ?? "default", callable: false }];
    case "TSInterfaceDeclaration":
    case "TSTypeAliasDeclaration":
    case "TSEnumDeclaration":
      return [{ local: node.id.name, callable: false }];
    case "TSModuleDeclaration":
      return node.id.type === "Identifier" ? [{ local: node.id.name, callable: false }] : [];
    default:
      return [];
  }
};

// Rolldown exports the parse result but not its comment type.
type Comment = ParseResult["comments"][number];

// JSDoc lines without the leading `*`.
const docLines = (comment: Comment): ReadonlyArray<string> =>
  comment.value.split("\n").map((line) => line.replace(/^\s*\*? ?/u, "").trimEnd());

const tagLine = /^@construct(?:\s+(.*))?$/u;

/** The top-level declarations of a module, with the line and JSDoc of each statement. */
const readDeclarations = (path: string, text: string): ModuleDeclarations => {
  const parsed = parseSync(path, text);
  const lineStarts = [0, ...[...text.matchAll(/\n/gu)].map((match) => match.index + 1)];
  const lineOf = (offset: number) => lineStarts.findLastIndex((start) => start <= offset) + 1;
  const attached = new Set<Comment>();

  const declarations = parsed.program.body.flatMap((statement) => {
    const names = declared(statement);

    if (names.length === 0) return [];

    // The JSDoc of a statement is the `/** */` comment that only whitespace separates from it.
    const comment = parsed.comments.findLast((candidate) => candidate.end <= statement.start);

    const doc =
      comment !== undefined &&
      comment.type === "Block" &&
      comment.value.startsWith("*") &&
      text.slice(comment.end, statement.start).trim() === ""
        ? comment
        : undefined;

    if (doc !== undefined) attached.add(doc);

    const line = lineOf(statement.start);
    const lines = doc === undefined ? [] : docLines(doc);

    return names.map((name) => ({ ...name, line, doc: lines }));
  });

  return {
    declarations,
    strayTags: parsed.comments.flatMap((comment) =>
      comment.type === "Block" &&
      !attached.has(comment) &&
      docLines(comment).some((line) => tagLine.test(line))
        ? [lineOf(comment.start)]
        : [],
    ),
  };
};

const inlineLink = /\{@link(?:code|plain)?\s+([^\s|}]+)(?:[\s|]+([^}]*))?\}/gu;

// Up to the first period that ends a sentence outside a code span.
const firstSentence = /^(?:[^`.]|`[^`]*`|\.(?!\s|$))*\./u;

const summaryOf = (doc: ReadonlyArray<string>): string => {
  const start = doc.findIndex((line) => line !== "");
  const lines = start === -1 ? [] : doc.slice(start);
  const end = lines.findIndex((line) => line === "" || line.startsWith("@"));

  const paragraph = (end === -1 ? lines : lines.slice(0, end))
    .join(" ")
    .replaceAll(inlineLink, (_link, target: string, text: string | undefined) =>
      text === undefined || text.trim() === "" ? `\`${target}\`` : text.trim(),
    )
    .trim();

  return firstSentence.exec(paragraph)?.[0] ?? paragraph;
};

interface Located {
  readonly path: string;
  readonly line: number;
}

const byLocation = (left: Located, right: Located): number =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : left.line - right.line;

/** Every tagged construct with its consumers, the tag findings, and the untagged candidates. */
export const readConstructs = (repository: Repository, graph: ModuleGraph): ConstructReport => {
  const findings: Array<Finding> = [];
  const constructs: Array<Construct> = [];
  const tagged = new Set<string>();
  const parsed = new Map<string, ModuleDeclarations>();

  const declarationsOf = (path: string): ModuleDeclarations => {
    const known = parsed.get(path) ?? readDeclarations(path, repository.read(path));

    parsed.set(path, known);

    return known;
  };

  for (const module of graph.modules.values()) {
    for (const error of module.errors)
      findings.push({ path: module.path, message: `does not parse: ${error}` });

    if (!repository.read(module.path).includes("@construct")) continue;

    const { declarations, strayTags } = declarationsOf(module.path);

    for (const line of strayTags)
      findings.push({
        path: `${module.path}:${line}`,
        message: "has a @construct tag outside the JSDoc of a top-level declaration",
      });

    for (const { local, line, doc } of declarations) {
      const tags = doc.flatMap((text) => {
        const tag = tagLine.exec(text);

        return tag === null ? [] : [tag[1]?.trim() ?? ""];
      });

      const [category] = tags;

      if (category === undefined) continue;

      const place = `${module.path}:${line}`;

      if (tags.length > 1)
        findings.push({ path: place, message: "has more than one @construct tag; keep one" });

      if (!Object.hasOwn(constructCategories, category)) {
        findings.push({
          path: place,
          message: `has @construct ${category === "" ? "without a category" : category}. Name one of ${Object.keys(constructCategories).join(", ")}, or add the category to constructCategories in ${declaration}`,
        });

        continue;
      }

      const names = [...module.locals].flatMap(([exported, name]) =>
        name === local ? [exported] : [],
      );

      if (names.length === 0)
        findings.push({
          path: place,
          message: `tags ${local}, which the module does not export; tag an exported declaration`,
        });

      for (const name of names) {
        const key = bindingKey({ path: module.path, name });

        if (tagged.has(key)) continue;

        tagged.add(key);

        constructs.push({
          name,
          category,
          summary: summaryOf(doc),
          path: module.path,
          line,
          consumers: [...(graph.importers.get(key) ?? [])].sort(),
        });
      }
    }
  }

  for (const category of Object.keys(constructCategories))
    if (!constructs.some((construct) => construct.category === category))
      findings.push({
        path: declaration,
        message: `declares the category ${category}, which no construct uses; remove it`,
      });

  const candidates: Array<Candidate> = [];

  for (const [key, importers] of graph.importers) {
    if (tagged.has(key)) continue;

    const hash = key.lastIndexOf("#");
    const path = key.slice(0, hash);
    const owner = packageOf(path);
    const outside = [...importers].filter((importer) => packageOf(importer) !== owner);

    if (outside.length < candidateImporters) continue;

    const name = key.slice(hash + 1);
    const local = graph.modules.get(path)?.locals.get(name);

    const found = declarationsOf(path).declarations.find((candidate) => candidate.local === local);

    if (found?.callable === true)
      candidates.push({ path, name, line: found.line, importers: outside.sort() });
  }

  return {
    constructs: constructs.sort(byLocation),
    findings,
    candidates: candidates.sort(byLocation),
  };
};

/** The content of `docs/constructs.md`. */
export const renderCatalogue = (constructs: ReadonlyArray<Construct>): string => {
  const categories = Object.entries(constructCategories).flatMap(([category, holds]) => {
    const members = constructs.filter((construct) => construct.category === category);

    return members.length === 0 ? [] : [{ category, holds, members }];
  });

  const entry = (construct: Construct): ReadonlyArray<string> => {
    const count = construct.consumers.length;

    return [
      `- \`${construct.name}\`: ${construct.summary}`,
      `  [${construct.path}:${construct.line}](../${construct.path}#L${construct.line}), ${
        count === 0 ? "no consumers." : `${count} ${count === 1 ? "consumer" : "consumers"}:`
      }`,
      ...construct.consumers.map((consumer) => `  - [${consumer}](../${consumer})`),
    ];
  };

  return [
    "# Shared constructs",
    "",
    '[//]: # "constructs: generated from the @construct tags and the import graph by just constructs write; do not edit"',
    "",
    "A shared construct is an export that owns logic that several call sites share. Use it instead of writing the logic again.",
    "Its JSDoc carries a `@construct <category>` line, and its module opens with a header comment: purpose, when to use, and details.",
    "Tag a new construct only when at least two call sites share its logic.",
    "Consumers are the modules that import a construct, directly or through re-exports.",
    `\`just constructs\` checks this page against the tags and the imports. It also lists untagged functions that ${candidateImporters} or more modules outside their app or package import.`,
    "",
    table(
      ["Category", "Constructs", "Holds"],
      categories.map(({ category, holds, members }) => [
        `[${category}](#${category})`,
        String(members.length),
        holds,
      ]),
    ),
    "",
    ...categories.flatMap(({ category, holds, members }) => [
      `## ${category}`,
      "",
      holds,
      "",
      ...members.flatMap(entry),
      "",
    ]),
  ].join("\n");
};

/** The findings of `readConstructs`, and a missing or stale `docs/constructs.md`. */
export const checkConstructs = (
  repository: Repository,
  report: ConstructReport,
): ReadonlyArray<Finding> => {
  const page = repository.paths.includes(catalogue) ? repository.read(catalogue) : undefined;

  return page === renderCatalogue(report.constructs)
    ? report.findings
    : [
        ...report.findings,
        {
          path: catalogue,
          message: `${page === undefined ? "is missing" : "differs from the @construct tags and the imports"}; run just constructs write`,
        },
      ];
};

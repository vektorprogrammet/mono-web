/**
 * The shared-construct pages.
 *
 * A shared construct is an exported declaration whose JSDoc has a line `@construct <category>`.
 * Reading about constructs discloses in three steps. `just constructs write` renders the index,
 * one line per category and construct, and one contract page per category, from the tagged
 * declarations and their JSDoc alone (`contracts.ts` reads them). `just constructs consumers
 * <name>` reads the import graph when called and prints the modules that import a construct; no
 * page lists them, so an import never changes a page.
 *
 * `just constructs` fails when a page differs from that rendering or when a tag is malformed or
 * misplaced. It reports a construct that lacks a contract tag or an annotation, or that fewer than
 * two modules outside its own module and the tests of its app or package import, and it warns
 * about functions that three or more modules outside their app or package import untagged.
 */
import { posix } from "node:path";
import type { Finding } from "./check.js";
import {
  contractGaps,
  plainLinks,
  readDeclarations,
  readDocumentation,
  type Signature,
  type Tag,
  tagText,
} from "./contracts.js";
import { bindingKey, type ModuleGraph, moduleFile, packageOf, parseModule } from "./modules.js";
import type { Repository } from "./repository.js";

/**
 * The construct categories in page order, each with what its constructs do. A tag names one of
 * them; add a category here before the first construct that needs it.
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
  "request-ledger":
    "Classifies the requests that journey recorders observe by whole path segments: native contract operations and legacy routes.",
} satisfies Readonly<Record<string, string>>;

/** Where `just constructs write` writes: the index, and one contract page per category. */
export const constructPages = {
  index: "docs/constructs.md",
  contracts: "docs/constructs",
} as const;

const declaration = "tools/conventions/src/constructs.ts";

export interface Construct {
  readonly name: string;
  readonly category: string;
  /** The first sentence of the JSDoc. */
  readonly summary: string;
  /** The block tags of the JSDoc, such as `@remarks`. */
  readonly tags: ReadonlyArray<Tag>;
  readonly signature: Signature;
  readonly path: string;
  readonly line: number;
}

export interface ConstructReport {
  readonly constructs: ReadonlyArray<Construct>;
  /** Malformed or misplaced tags, and unused categories. */
  readonly findings: ReadonlyArray<Finding>;
  /** The contract tags and annotations that constructs lack. */
  readonly gaps: ReadonlyArray<Finding>;
}

/** An untagged function that three or more modules outside its app or package import. */
export interface Candidate {
  readonly path: string;
  readonly name: string;
  readonly line: number;
  readonly importers: ReadonlyArray<string>;
}

/** The modules that import a construct. */
export interface Consumers {
  readonly construct: Construct;
  /** Every module that imports it, directly or through re-exports, sorted. */
  readonly importers: ReadonlyArray<string>;
  /** The importers that share it: all but the tests of its own app or package. */
  readonly counted: ReadonlyArray<string>;
}

/** The fewest importers outside its app or package that make an untagged function a candidate. */
const candidateImporters = 3;

/** The fewest counted consumers that a construct needs. */
const sharedConsumers = 2;

/** A test file. A test in the construct's own app or package tests it rather than shares it. */
const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

interface Located {
  readonly path: string;
  readonly line: number;
}

const byLocation = (left: Located, right: Located): number =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : left.line - right.line;

const constructTags = (tags: ReadonlyArray<Tag>): ReadonlyArray<string> =>
  tags.flatMap((tag) => (tag.name === "construct" ? [tag.text.split("\n")[0]?.trim() ?? ""] : []));

/**
 * Every tagged construct with its contract, the findings of the tags, and the contract gaps. It
 * reads the tagged modules alone, never the import graph.
 */
export const readConstructs = (repository: Repository): ConstructReport => {
  const findings: Array<Finding> = [];
  const gaps: Array<Finding> = [];
  const constructs: Array<Construct> = [];
  const tagged = new Set<string>();

  for (const path of repository.paths) {
    if (!moduleFile.test(path) || repository.links.has(path)) continue;

    const text = repository.read(path);

    if (!text.includes("@construct")) continue;

    const { declarations, unattached } = readDeclarations(path, text);
    const { locals } = parseModule(path, text);

    for (const { line, doc } of unattached)
      if (constructTags(readDocumentation(doc).tags).length > 0)
        findings.push({
          path: `${path}:${line}`,
          message: "has a @construct tag outside the JSDoc of a top-level declaration",
        });

    for (const declared of declarations) {
      const documentation = readDocumentation(declared.doc);
      const categories = constructTags(documentation.tags);
      const [category] = categories;

      if (category === undefined) continue;

      const place = `${path}:${declared.line}`;

      if (categories.length > 1)
        findings.push({ path: place, message: "has more than one @construct tag; keep one" });

      if (!Object.hasOwn(constructCategories, category)) {
        findings.push({
          path: place,
          message: `has @construct ${category === "" ? "without a category" : category}. Name one of ${Object.keys(constructCategories).join(", ")}, or add the category to constructCategories in ${declaration}`,
        });

        continue;
      }

      const names = [...locals].flatMap(([exported, local]) =>
        local === declared.local ? [exported] : [],
      );

      if (names.length === 0) {
        findings.push({
          path: place,
          message: `tags ${declared.local}, which the module does not export; tag an exported declaration`,
        });

        continue;
      }

      for (const message of contractGaps(declared)) gaps.push({ path: place, message });

      for (const name of names) {
        const key = bindingKey({ path, name });

        if (tagged.has(key)) continue;

        tagged.add(key);

        constructs.push({
          name,
          category,
          summary: documentation.summary,
          tags: documentation.tags,
          signature: declared.signature,
          path,
          line: declared.line,
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

  return { constructs: constructs.sort(byLocation), findings, gaps };
};

// ---------------------------------------------------------------------------------------------
// Consumers

/** The modules that do not parse, so that the graph may lack their imports and exports. */
export const parseFindings = (graph: ModuleGraph): ReadonlyArray<Finding> =>
  [...graph.modules.values()].flatMap((module) =>
    module.errors.map((error) => ({ path: module.path, message: `does not parse: ${error}` })),
  );

/** The importers of each construct, which only this reads from the import graph. */
export const readConsumers = (
  constructs: ReadonlyArray<Construct>,
  graph: ModuleGraph,
): ReadonlyArray<Consumers> =>
  constructs.map((construct) => {
    const importers = [
      ...(graph.importers.get(bindingKey({ path: construct.path, name: construct.name })) ?? []),
    ].sort();

    const owner = packageOf(construct.path);

    return {
      construct,
      importers,
      counted: importers.filter(
        (importer) => !testFile.test(importer) || packageOf(importer) !== owner,
      ),
    };
  });

/** A construct that fewer than two modules share is no shared construct. */
export const consumerFindings = (consumers: ReadonlyArray<Consumers>): ReadonlyArray<Finding> =>
  consumers.flatMap(({ construct, counted }) =>
    counted.length >= sharedConsumers
      ? []
      : [
          {
            path: `${construct.path}:${construct.line}`,
            message: `tags ${construct.name}, which ${counted.length === 0 ? "no module" : "one module"} outside its own module and the tests of ${packageOf(construct.path) ?? "its app or package"} imports; remove the tag, or move logic that another call site repeats onto it`,
          },
        ],
  );

/** The untagged functions that three or more modules outside their app or package import. */
export const readCandidates = (
  repository: Repository,
  graph: ModuleGraph,
  constructs: ReadonlyArray<Construct>,
): ReadonlyArray<Candidate> => {
  const tagged = new Set(
    constructs.map((construct) => bindingKey({ path: construct.path, name: construct.name })),
  );

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

    const found = readDeclarations(path, repository.read(path)).declarations.find(
      (candidate) => candidate.local === local,
    );

    if (found?.callable === true)
      candidates.push({ path, name, line: found.line, importers: outside.sort() });
  }

  return candidates.sort(byLocation);
};

// ---------------------------------------------------------------------------------------------
// Pages

const marker =
  '[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"';

const code = (text: string): string => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/gu)].map(([run]) => run.length));
  const fence = "`".repeat(longest + 1);

  return longest === 0 ? `${fence}${text}${fence}` : `${fence} ${text} ${fence}`;
};

// GitHub derives a heading anchor from its text: lowercase, without punctuation, spaces as hyphens.
const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replaceAll(" ", "-");

interface Category {
  readonly category: string;
  readonly holds: string;
  readonly members: ReadonlyArray<Construct>;
}

const categoriesOf = (constructs: ReadonlyArray<Construct>): ReadonlyArray<Category> =>
  Object.entries(constructCategories).flatMap(([category, holds]) => {
    const members = constructs.filter((construct) => construct.category === category);

    return members.length === 0 ? [] : [{ category, holds, members }];
  });

const pageOf = (category: string): string => `${constructPages.contracts}/${category}.md`;

/** The contract of each construct: its category page and the anchor of its section there. */
export const contractLinks = (
  constructs: ReadonlyArray<Construct>,
): ReadonlyMap<Construct, string> => {
  const links = new Map<Construct, string>();

  for (const { category, members } of categoriesOf(constructs)) {
    // A repeated heading takes the next free suffix; the page title is the first heading.
    const taken = new Map<string, number>([[slug(category), 1]]);

    for (const construct of members) {
      const base = slug(construct.name);
      const count = taken.get(base) ?? 0;

      taken.set(base, count + 1);
      links.set(construct, `${pageOf(category)}#${count === 0 ? base : `${base}-${count}`}`);
    }
  }

  return links;
};

const missing = (tag: string) => `Missing: the JSDoc has no \`@${tag}\` tag.`;

// A list item holds its prose on one line.
const oneLine = (text: string): string =>
  plainLinks(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");

const inputsItem = (inputs: ReadonlyArray<string>): ReadonlyArray<string> => {
  const [only] = inputs;

  if (only === undefined) return ["- Inputs: none"];

  return inputs.length === 1
    ? [`- Inputs: ${code(only)}`]
    : ["- Inputs:", ...inputs.map((input) => `  - ${code(input)}`)];
};

const exampleBlock = (example: string): string =>
  /^\s*(?:`{3,}|~{3,})/u.test(example) ? example : ["```ts", example, "```"].join("\n");

const renderContract = (construct: Construct): ReadonlyArray<string> => {
  const { signature } = construct;
  const documentation = { summary: construct.summary, tags: construct.tags };
  const text = (tag: string) => tagText(documentation, tag);
  const throws = text("throws");
  const sideEffects = text("sideEffects");
  const remarks = text("remarks");
  const example = text("example");
  const avoid = text("avoid");

  return [
    `## ${code(construct.name)}`,
    "",
    construct.summary === "" ? "Missing: the JSDoc has no summary sentence." : construct.summary,
    "",
    "```ts",
    signature.text,
    "```",
    "",
    ...inputsItem(signature.inputs),
    `- Output: ${signature.output === undefined ? "not annotated" : code(signature.output)}`,
    `- Errors: ${signature.errors === undefined ? "none" : code(signature.errors)}`,
    ...(throws === undefined ? [] : [`- Throws: ${oneLine(throws)}`]),
    `- Requirements: ${signature.requirements === undefined ? "none" : code(signature.requirements)}`,
    `- Side effects: ${sideEffects === undefined ? missing("sideEffects") : oneLine(sideEffects)}`,
    `- Source: [${construct.path}:${construct.line}](../../${construct.path}#L${construct.line})`,
    "",
    "**How it works**",
    "",
    remarks === undefined ? missing("remarks") : plainLinks(remarks),
    "",
    "**Use**",
    "",
    example === undefined ? missing("example") : exampleBlock(example),
    "",
    "**Avoid**",
    "",
    avoid === undefined ? missing("avoid") : plainLinks(avoid),
    "",
  ];
};

const renderIndex = (
  categories: ReadonlyArray<Category>,
  links: ReadonlyMap<Construct, string>,
): string => {
  const from = posix.dirname(constructPages.index);

  return [
    "# Shared constructs",
    "",
    marker,
    "",
    "A shared construct is an export that owns logic that several call sites share. Use it instead of writing the logic again.",
    "Read about a construct in three steps, each only when you need it:",
    "",
    "1. This index: each category and each construct in one line.",
    "2. Its contract, on the page of its category: signature, errors, requirements, side effects, how it works, one use, and the misuse to avoid.",
    "3. Its consumers: `just constructs consumers <name>` prints the modules that import it. No page lists them, so an import changes no page.",
    "",
    "The JSDoc of a construct carries `@construct <category>`, a summary sentence, `@remarks`, `@sideEffects`, `@example`, and `@avoid`, and its parameters and return type carry annotations.",
    `Tag a construct only when at least ${sharedConsumers} modules outside its own module and the tests of its app or package import it.`,
    `\`just constructs\` checks these pages against the tags, and it lists untagged functions that ${candidateImporters} or more modules outside their app or package import.`,
    "",
    ...categories.flatMap(({ category, holds, members }) => [
      `- [${category}](${posix.relative(from, pageOf(category))}): ${holds}`,
      ...members.map(
        (construct) =>
          `  - [${code(construct.name)}](${posix.relative(from, links.get(construct) ?? "")}): ${construct.summary}`,
      ),
    ]),
    "",
  ].join("\n");
};

const renderCategory = ({ category, holds, members }: Category): string =>
  [
    `# ${category}`,
    "",
    marker,
    "",
    `${holds} The [index](${posix.relative(constructPages.contracts, constructPages.index)}) lists every category.`,
    "",
    ...members.flatMap(renderContract),
  ].join("\n");

/** The index and each category page, by path. They depend on the constructs alone. */
export const renderPages = (constructs: ReadonlyArray<Construct>): ReadonlyMap<string, string> => {
  const categories = categoriesOf(constructs);

  return new Map([
    [constructPages.index, renderIndex(categories, contractLinks(constructs))],
    ...categories.map((category): [string, string] => [
      pageOf(category.category),
      renderCategory(category),
    ]),
  ]);
};

/** The pages that are missing, stale, or no longer rendered. */
export const checkPages = (
  repository: Repository,
  constructs: ReadonlyArray<Construct>,
): ReadonlyArray<Finding> => {
  const pages = renderPages(constructs);
  const present = new Set(repository.paths);

  return [
    ...[...pages].flatMap(([path, text]) =>
      !present.has(path)
        ? [{ path, message: "is missing; run just constructs write" }]
        : repository.read(path) === text
          ? []
          : [
              {
                path,
                message:
                  "differs from the @construct tags and their JSDoc; run just constructs write",
              },
            ],
    ),
    ...repository.paths.flatMap((path) =>
      path.startsWith(`${constructPages.contracts}/`) && !pages.has(path)
        ? [
            {
              path,
              message:
                "is the page of no construct category; run just constructs write to remove it",
            },
          ]
        : [],
    ),
  ];
};

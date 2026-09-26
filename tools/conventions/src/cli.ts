/**
 * The convention checks. `just layout`, `just constructs`, `just guides`, and `just exceptions`
 * run `check`: each reports its findings and exits 1 if there is one. `write` renders the
 * generated files of the topic, then checks; `exceptions` has none. The pre-commit hook passes
 * `--staged`, which lists the files of the Git index instead of the working tree, so untracked
 * files do not count. `just constructs consumers [name]` prints the modules that import a
 * construct, which no generated page lists.
 */
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkLayout, type Finding } from "./check.js";
import { readContextModel } from "./cml.js";
import {
  checkPages,
  consumerFindings,
  constructPages,
  parseFindings,
  readCandidates,
  readConstructs,
  readConsumers,
  renderPages,
} from "./constructs.js";
import { checkExceptions } from "./exceptions.js";
import { checkGuides, guideFile, guideText, linkFile, linkText, renderGuides } from "./guides.js";
import { readWorkflow, testsWorkflow } from "./journeys.js";
import { readJustfile } from "./justfile.js";
import { contextMap } from "./layout.js";
import { packageOf, readModuleGraph } from "./modules.js";
import { type Repository, readRepository, repositoryRoot } from "./repository.js";
import { spliceFiles } from "./sections.js";

const usage = `Usage: bun tools/conventions/src/cli.ts <layout | constructs | guides | exceptions> [check | write] [--staged]
       bun tools/conventions/src/cli.ts constructs consumers [name]

layout      the layout declaration against the tree, the generated README.md and AGENTS.md sections, and the hosted journeys
constructs  the construct index docs/constructs.md and the contract pages docs/constructs/ against the @construct tags and their JSDoc, and each construct's consumers
guides      the AGENTS.md guide, and the CLAUDE.md that imports it, of every app, package, and context folder
exceptions  every suppression of an Effect rule against the registry docs/effect-exceptions.json

check       report findings and exit 1 if there is one (the default)
write       render the generated files of the topic, then check; exceptions has none
consumers   print the modules that import each construct called name, or every construct with its consumer count
--staged    check the files of the Git index, as the pre-commit hook does
`;

interface Outcome {
  readonly findings: ReadonlyArray<Finding>;
  /** Reported without failing the check. */
  readonly warnings: ReadonlyArray<string>;
  readonly summary: string;
}

const [topic = "", ...options] = process.argv.slice(2);

const staged = options.includes("--staged");

const [command = "check", ...rest] = options.filter((option) => option !== "--staged");

const root = repositoryRoot(process.cwd());

const rewrite = (path: string, text: string) => {
  const file = join(root, path);
  let current: string | undefined;

  try {
    current = readFileSync(file, "utf8");
  } catch {
    current = undefined;
  }

  if (current === text) return;

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  process.stdout.write(`${topic}: rewrote ${path}\n`);
};

const layout = (): Outcome => {
  const justfile = readJustfile(join(root, "justfile"));

  if (command === "write") {
    const read = (path: string) => readFileSync(join(root, path), "utf8");

    for (const { path, text } of spliceFiles(read, justfile, readWorkflow(read(testsWorkflow))))
      rewrite(path, text);
  }

  const repository = readRepository(root, staged);

  return {
    findings: checkLayout(repository, justfile),
    warnings: [],
    summary: `${repository.paths.length} ${staged ? "staged" : "working tree"} files`,
  };
};

const constructs = (): Outcome => {
  if (command === "write") {
    const tree = readRepository(root, false);
    const pages = renderPages(readConstructs(tree).constructs);

    for (const [path, text] of pages) rewrite(path, text);

    for (const path of tree.paths)
      if (path.startsWith(`${constructPages.contracts}/`) && !pages.has(path)) {
        rmSync(join(root, path));
        process.stdout.write(`${topic}: removed ${path}\n`);
      }
  }

  const repository = readRepository(root, staged);
  const report = readConstructs(repository);
  const graph = readModuleGraph(repository);
  const consumers = readConsumers(report.constructs, graph);
  const candidates = readCandidates(repository, graph, report.constructs);

  return {
    findings: [
      ...parseFindings(graph),
      ...report.findings,
      ...checkPages(repository, report.constructs),
    ],
    // Reported, not yet failing, until every construct carries its contract.
    warnings: [
      ...[...report.gaps, ...consumerFindings(consumers)].map(
        (finding) => `${finding.path}: ${finding.message}`,
      ),
      ...candidates.map(
        (candidate) =>
          `${candidate.path}:${candidate.line}: ${candidate.name} has no @construct tag, and ${candidate.importers.length} modules outside ${packageOf(candidate.path) ?? "its package"} import it, in ${[...new Set(candidate.importers.map((importer) => packageOf(importer) ?? importer))].join(", ")}`,
      ),
    ],
    summary: `${graph.modules.size} modules, ${report.constructs.length} constructs, ${consumers.reduce((sum, { importers }) => sum + importers.length, 0)} consumers, ${candidates.length} untagged candidates`,
  };
};

/** Prints the consumers of each construct called `name`, or the count of every construct. */
const printConsumers = (name: string | undefined): number => {
  const repository = readRepository(root, false);
  const all = readConstructs(repository).constructs;
  const selected = name === undefined ? all : all.filter((construct) => construct.name === name);

  if (selected.length === 0) {
    process.stderr.write(`constructs: no construct is called ${name ?? ""}\n`);

    return 1;
  }

  for (const { construct, importers, counted } of readConsumers(
    selected,
    readModuleGraph(repository),
  )) {
    process.stdout.write(
      `${construct.path}:${construct.line} ${construct.name}: ${importers.length} ${importers.length === 1 ? "consumer" : "consumers"}, ${counted.length} outside the tests of ${packageOf(construct.path) ?? "its app or package"}\n`,
    );

    if (name !== undefined)
      for (const importer of importers) process.stdout.write(`  ${importer}\n`);
  }

  return 0;
};

const guideSet = (repository: Repository) => {
  const model = readContextModel(repository.read(contextMap));
  const { constructs } = readConstructs(repository);

  return { model, set: renderGuides(repository, model, constructs) };
};

const guides = (): Outcome => {
  if (command === "write") {
    const repository = readRepository(root, false);
    const { set } = guideSet(repository);

    for (const guide of set.guides) {
      const agents = `${guide.directory}/${guideFile}`;
      const section = set.sections.get(guide.directory);

      if (section !== undefined)
        rewrite(
          agents,
          guideText(
            repository.paths.includes(agents) ? repository.read(agents) : undefined,
            section,
          ),
        );

      const link = join(root, guide.directory, linkFile);
      let current: string | undefined;

      try {
        current = lstatSync(link).isSymbolicLink() ? undefined : readFileSync(link, "utf8");
      } catch {
        current = undefined;
      }

      if (current !== linkText) {
        rmSync(link, { force: true });
        writeFileSync(link, linkText);
        process.stdout.write(
          `guides: wrote ${guide.directory}/${linkFile}, which imports ${guideFile}\n`,
        );
      }
    }
  }

  const repository = readRepository(root, staged);
  const { model, set } = guideSet(repository);

  return {
    findings: [
      ...model.errors.map((message) => ({ path: contextMap, message })),
      ...checkGuides(repository, set),
    ],
    warnings: [],
    summary: `${set.guides.length} guides`,
  };
};

const exceptions = (): Outcome => {
  const report = checkExceptions(readRepository(root, staged));

  return {
    findings: report.findings,
    warnings: [],
    summary: `${report.exceptions.length} exceptions, ${report.suppressions.length} suppressions, ${report.references.length} references`,
  };
};

const run = Object.entries({ layout, constructs, guides, exceptions }).find(
  ([name]) => name === topic,
)?.[1];

const consumersOf =
  topic === "constructs" && command === "consumers" && !staged && rest.length <= 1;

if (
  run === undefined ||
  !(command === "check" || command === "write" || consumersOf) ||
  (rest.length > 0 && !consumersOf) ||
  (staged && command === "write") ||
  (topic === "exceptions" && command === "write")
) {
  process.stderr.write(usage);
  process.exit(2);
}

if (consumersOf) process.exit(printConsumers(rest[0]));

const outcome = run();

for (const { path, message } of outcome.findings) process.stderr.write(`${path}: ${message}\n`);

for (const warning of outcome.warnings) process.stderr.write(`warning: ${warning}\n`);

process.stdout.write(`${topic}: ${outcome.summary}, ${outcome.findings.length} findings\n`);

process.exitCode = outcome.findings.length === 0 ? 0 : 1;

/**
 * The convention checks. `just layout`, `just constructs`, `just guides`, and `just exceptions`
 * run `check`: each reports its findings and exits 1 if there is one. `write` renders the
 * generated files of the topic, then checks; `exceptions` has none. The pre-commit hook passes
 * `--staged`, which lists the files of the Git index instead of the working tree, so untracked
 * files do not count. `just constructs consumers [name]` prints the modules that import a
 * construct, which no generated page lists.
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import process from "node:process";
import { Console, Effect, Exit, FileSystem, Option, Path, Predicate } from "effect";
import * as Runtime from "effect/Runtime";
import { checkLayout, type Finding } from "./check.js";
import { readContextModel } from "./cml.js";
import {
  checkConstructs,
  constructPages,
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

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* repositoryRoot(process.cwd());

  const readText = (file: string) => Effect.option(fileSystem.readFileString(file));

  const rewrite = Effect.fnUntraced(function* (relative: string, text: string) {
    const file = path.join(root, relative);
    const current = yield* readText(file);

    if (Option.isSome(current) && current.value === text) return;

    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(file, text);
    yield* Console.log(`${topic}: rewrote ${relative}`);
  });

  const layout = Effect.gen(function* () {
    const justfile = yield* readJustfile(path.join(root, "justfile"));

    if (command === "write") {
      const tree = yield* readRepository(root, false);

      for (const { path: relative, text } of spliceFiles(
        tree.read,
        justfile,
        readWorkflow(tree.read(testsWorkflow)),
      ))
        yield* rewrite(relative, text);
    }

    const repository = yield* readRepository(root, staged);

    return {
      findings: checkLayout(repository, justfile),
      warnings: [],
      summary: `${repository.paths.length} ${staged ? "staged" : "working tree"} files`,
    } satisfies Outcome;
  });

  const constructs = Effect.gen(function* () {
    if (command === "write") {
      const tree = yield* readRepository(root, false);
      const pages = renderPages(readConstructs(tree).constructs);

      for (const [relative, text] of pages) yield* rewrite(relative, text);

      for (const relative of tree.paths)
        if (relative.startsWith(`${constructPages.contracts}/`) && !pages.has(relative)) {
          yield* fileSystem.remove(path.join(root, relative));
          yield* Console.log(`${topic}: removed ${relative}`);
        }
    }

    const check = checkConstructs(yield* readRepository(root, staged));

    return {
      findings: check.findings,
      warnings: check.candidates.map(
        (candidate) =>
          `${candidate.path}:${candidate.line}: ${candidate.name} has no @construct tag, and ${candidate.importers.length} modules outside ${packageOf(candidate.path) ?? "its package"} import it, in ${[...new Set(candidate.importers.map((importer) => packageOf(importer) ?? importer))].join(", ")}`,
      ),
      summary: `${check.modules} modules, ${check.constructs.length} constructs, ${check.consumers.reduce((sum, { importers }) => sum + importers.length, 0)} consumers, ${check.candidates.length} untagged candidates`,
    } satisfies Outcome;
  });

  /** Prints the consumers of each construct called `name`, or the count of every construct. */
  const printConsumers = Effect.fnUntraced(function* (name: string | undefined) {
    const repository = yield* readRepository(root, false);
    const all = readConstructs(repository).constructs;
    const selected = name === undefined ? all : all.filter((construct) => construct.name === name);

    if (selected.length === 0) {
      yield* Console.error(`constructs: no construct is called ${name ?? ""}`);

      return 1;
    }

    for (const { construct, importers, counted } of readConsumers(
      selected,
      readModuleGraph(repository),
    )) {
      yield* Console.log(
        `${construct.path}:${construct.line} ${construct.name}: ${importers.length} ${importers.length === 1 ? "consumer" : "consumers"}, ${counted.length} outside the tests of ${packageOf(construct.path) ?? "its app or package"}`,
      );

      if (name !== undefined) for (const importer of importers) yield* Console.log(`  ${importer}`);
    }

    return 0;
  });

  const guideSet = (repository: Repository) => {
    const model = readContextModel(repository.read(contextMap));
    const { constructs: found } = readConstructs(repository);

    return { model, set: renderGuides(repository, model, found) };
  };

  const guides = Effect.gen(function* () {
    if (command === "write") {
      const repository = yield* readRepository(root, false);
      const { set } = guideSet(repository);

      for (const guide of set.guides) {
        const agents = `${guide.directory}/${guideFile}`;
        const section = set.sections.get(guide.directory);

        if (section !== undefined)
          yield* rewrite(
            agents,
            guideText(
              repository.paths.includes(agents) ? repository.read(agents) : undefined,
              section,
            ),
          );

        const link = path.join(root, guide.directory, linkFile);

        // A symbolic link does not count as the link file, whatever its target holds.
        const current = Option.isSome(yield* Effect.option(fileSystem.readLink(link)))
          ? Option.none<string>()
          : yield* readText(link);

        if (Option.isNone(current) || current.value !== linkText) {
          yield* fileSystem.remove(link, { force: true });
          yield* fileSystem.writeFileString(link, linkText);
          yield* Console.log(
            `guides: wrote ${guide.directory}/${linkFile}, which imports ${guideFile}`,
          );
        }
      }
    }

    const repository = yield* readRepository(root, staged);
    const { model, set } = guideSet(repository);

    return {
      findings: [
        ...model.errors.map((message) => ({ path: contextMap, message })),
        ...checkGuides(repository, set),
      ],
      warnings: [],
      summary: `${set.guides.length} guides`,
    } satisfies Outcome;
  });

  const exceptions = Effect.gen(function* () {
    const report = checkExceptions(yield* readRepository(root, staged));

    return {
      findings: report.findings,
      warnings: [],
      summary: `${report.exceptions.length} exceptions, ${report.suppressions.length} suppressions, ${report.references.length} references`,
    } satisfies Outcome;
  });

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
    yield* Console.error(usage.trimEnd());

    return 2;
  }

  if (consumersOf) return yield* printConsumers(rest[0]);

  const outcome: Outcome = yield* run;

  for (const { path: file, message } of outcome.findings)
    yield* Console.error(`${file}: ${message}`);

  for (const warning of outcome.warnings) yield* Console.error(`warning: ${warning}`);

  yield* Console.log(`${topic}: ${outcome.summary}, ${outcome.findings.length} findings`);

  return outcome.findings.length === 0 ? 0 : 1;
});

/** The platform of the checks, which their tests take too. */
export const ConventionsPlatform = BunServices.layer;

/** The services of `ConventionsPlatform`. */
export type ConventionsPlatform = BunServices.BunServices;

// A program that succeeds with a number exits with that code.
const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isSuccess(exit) && Predicate.isNumber(exit.value)) onExit(exit.value);
  else Runtime.defaultTeardown(exit, onExit);
};

if (import.meta.main)
  BunRuntime.runMain(program.pipe(Effect.provide(ConventionsPlatform)), { teardown });

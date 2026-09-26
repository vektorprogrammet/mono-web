/**
 * The convention checks. `just layout`, `just constructs`, and `just guides` run `check`: each
 * reports its findings and exits 1 if there is one. `write` renders the generated files of the
 * topic, then checks. The pre-commit hook passes `--staged`, which lists the files of the Git
 * index instead of the working tree, so untracked files do not count.
 */
import { lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkLayout, type Finding } from "./check.js";
import { readContextModel } from "./cml.js";
import { catalogue, checkConstructs, readConstructs, renderCatalogue } from "./constructs.js";
import { checkGuides, guideFile, guideText, linkFile, renderGuides } from "./guides.js";
import { readJustfile } from "./justfile.js";
import { contextMap } from "./layout.js";
import { packageOf, readModuleGraph } from "./modules.js";
import { type Repository, readRepository, repositoryRoot } from "./repository.js";
import { generatedFiles, renderSections, spliceSections } from "./sections.js";

const usage = `Usage: bun tools/conventions/src/cli.ts <layout | constructs | guides> [check | write] [--staged]

layout      the layout declaration against the tree, and the generated README.md and AGENTS.md sections
constructs  the construct catalogue docs/constructs.md against the @construct tags and the imports
guides      the AGENTS.md guide and CLAUDE.md link of every app, package, and context folder

check       report findings and exit 1 if there is one (the default)
write       render the generated files of the topic, then check
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

  writeFileSync(file, text);
  process.stdout.write(`${topic}: rewrote ${path}\n`);
};

const layout = (): Outcome => {
  const justfile = readJustfile(join(root, "justfile"));

  if (command === "write") {
    const sections = renderSections(justfile);

    for (const [path, ids] of Object.entries(generatedFiles))
      rewrite(
        path,
        spliceSections(
          readFileSync(join(root, path), "utf8"),
          ids.map((id) => sections[id]),
        ).text,
      );
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
    const repository = readRepository(root, false);

    rewrite(
      catalogue,
      renderCatalogue(readConstructs(repository, readModuleGraph(repository)).constructs),
    );
  }

  const repository = readRepository(root, staged);
  const graph = readModuleGraph(repository);
  const report = readConstructs(repository, graph);

  return {
    findings: checkConstructs(repository, report),
    warnings: report.candidates.map(
      (candidate) =>
        `${candidate.path}:${candidate.line}: ${candidate.name} has no @construct tag, and ${candidate.importers.length} modules outside ${packageOf(candidate.path) ?? "its package"} import it, in ${[...new Set(candidate.importers.map((importer) => packageOf(importer) ?? importer))].join(", ")}`,
    ),
    summary: `${graph.modules.size} modules, ${report.constructs.length} constructs, ${report.constructs.reduce((sum, construct) => sum + construct.consumers.length, 0)} consumers, ${report.candidates.length} untagged candidates`,
  };
};

const guideSet = (repository: Repository) => {
  const model = readContextModel(repository.read(contextMap));
  const { constructs } = readConstructs(repository, readModuleGraph(repository));

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
      let present = true;

      try {
        lstatSync(link);
      } catch {
        present = false;
      }

      if (!present) {
        symlinkSync(guideFile, link);
        process.stdout.write(`guides: linked ${guide.directory}/${linkFile} to ${guideFile}\n`);
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

const run = Object.entries({ layout, constructs, guides }).find(([name]) => name === topic)?.[1];

if (
  run === undefined ||
  !(command === "check" || command === "write") ||
  rest.length > 0 ||
  (staged && command === "write")
) {
  process.stderr.write(usage);
  process.exit(2);
}

const outcome = run();

for (const { path, message } of outcome.findings) process.stderr.write(`${path}: ${message}\n`);

for (const warning of outcome.warnings) process.stderr.write(`warning: ${warning}\n`);

process.stdout.write(`${topic}: ${outcome.summary}, ${outcome.findings.length} findings\n`);

process.exitCode = outcome.findings.length === 0 ? 0 : 1;

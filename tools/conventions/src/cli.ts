/**
 * `just layout` runs `layout check`: it reports every layout finding and exits 1 if there is one.
 * `just layout write` rewrites the generated sections of README.md and AGENTS.md, then checks.
 * The pre-commit hook passes `--staged`, which lists the files of the Git index instead of the
 * working tree, so untracked files do not count.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkLayout } from "./check.js";
import { readJustfile } from "./justfile.js";
import { readRepository, repositoryRoot } from "./repository.js";
import { generatedFiles, renderSections, spliceSections } from "./sections.js";

const usage = `Usage: bun tools/conventions/src/cli.ts layout [check | write] [--staged]

check     report layout findings and exit 1 if there is one (the default)
write     rewrite the generated sections of README.md and AGENTS.md, then check
--staged  check the files of the Git index, as the pre-commit hook does
`;

const [topic, ...options] = process.argv.slice(2);

const staged = options.includes("--staged");

const [command = "check", ...rest] = options.filter((option) => option !== "--staged");

if (
  topic !== "layout" ||
  !(command === "check" || command === "write") ||
  rest.length > 0 ||
  (staged && command === "write")
) {
  process.stderr.write(usage);
  process.exit(2);
}

const root = repositoryRoot(process.cwd());

const justfile = readJustfile(join(root, "justfile"));

if (command === "write") {
  const bodies = renderSections(justfile);

  for (const [path, ids] of Object.entries(generatedFiles)) {
    const file = join(root, path);
    const text = readFileSync(file, "utf8");
    const spliced = spliceSections(text, ids, bodies);

    if (spliced.text !== text) {
      writeFileSync(file, spliced.text);
      process.stdout.write(`layout: rewrote the generated sections of ${path}\n`);
    }
  }
}

const repository = readRepository(root, staged);

const findings = checkLayout(repository, justfile);

for (const { path, message } of findings) process.stderr.write(`${path}: ${message}\n`);

process.stdout.write(
  `layout: ${repository.paths.length} ${staged ? "staged" : "working tree"} files, ${findings.length} findings\n`,
);

process.exitCode = findings.length === 0 ? 0 : 1;

// Negative controls run against the real repository with one change each, so they exercise the
// real context map, layout declaration, construct tags, and package exports.
import { describe, expect, test } from "bun:test";
import type { Finding } from "../src/check.js";
import { readContextModel } from "../src/cml.js";
import { readConstructs } from "../src/constructs.js";
import { checkGuides, guideText, renderGuides } from "../src/guides.js";
import { contextMap } from "../src/layout.js";
import { readModuleGraph } from "../src/modules.js";
import { readRepository, repositoryRoot, type Repository } from "../src/repository.js";

const root = repositoryRoot(import.meta.dir);

const base = readRepository(root, false);

const withChanges = (
  files: Readonly<Record<string, string>>,
  removed: ReadonlyArray<string> = [],
): Repository => ({
  root,
  paths: [...new Set([...base.paths, ...Object.keys(files)])]
    .filter((path) => !removed.includes(path))
    .sort(),
  links: base.links,
  read: (path) => files[path] ?? base.read(path),
  readLink: base.readLink,
});

const guidesOf = (repository: Repository) =>
  renderGuides(
    repository,
    readContextModel(repository.read(contextMap)),
    readConstructs(repository, readModuleGraph(repository)).constructs,
  );

const findingsFor = (repository: Repository, path: string): ReadonlyArray<Finding> =>
  checkGuides(repository, guidesOf(repository)).filter((finding) => finding.path === path);

const placements = "packages/domain/src/placements";

describe("module guides", () => {
  test("rejects a missing guide and a missing CLAUDE.md link", () => {
    const repository = withChanges({}, [`${placements}/AGENTS.md`, `${placements}/CLAUDE.md`]);

    expect(findingsFor(repository, `${placements}/AGENTS.md`)).toHaveLength(1);
    expect(findingsFor(repository, `${placements}/CLAUDE.md`)).toHaveLength(1);
  });

  test("requires a guide for a new context folder", () => {
    const repository = withChanges({ "packages/domain/src/economy/index.ts": "export {};\n" });

    expect(findingsFor(repository, "packages/domain/src/economy/AGENTS.md")).toHaveLength(1);
  });

  test("rejects a hand edit of the generated part, and accepts hand-written notes below it", () => {
    const guide = base.read(`${placements}/AGENTS.md`);
    const edited = guide.replace("### Owns", "### Owned");

    expect(edited).not.toBe(guide);

    expect(
      findingsFor(withChanges({ [`${placements}/AGENTS.md`]: edited }), `${placements}/AGENTS.md`),
    ).toHaveLength(1);

    expect(
      findingsFor(
        withChanges({ [`${placements}/AGENTS.md`]: `${guide}\nA note written by hand.\n` }),
        `${placements}/AGENTS.md`,
      ),
    ).toHaveLength(0);
  });

  test("rejects a context map change that the guides of the context do not reflect", () => {
    const cml = base.read(contextMap);
    const edited = cml.replace("Assistant supply (affiliation)", "Assistant supply");

    expect(edited).not.toBe(cml);

    const repository = withChanges({ [contextMap]: edited });

    expect(findingsFor(repository, `${placements}/AGENTS.md`)).toHaveLength(1);
    expect(findingsFor(repository, "packages/database/src/placements/AGENTS.md")).toHaveLength(1);
    expect(findingsFor(repository, "packages/domain/src/schools/AGENTS.md")).toHaveLength(0);
  });

  test("writes keep the hand-written part and adopt a guide that has no markers", () => {
    const section = guidesOf(base).sections.get(placements);

    expect(section).toBeDefined();

    if (section === undefined) return;

    const notes = "## Pitfalls\n\nWritten by hand.\n";
    const current = `${base.read(`${placements}/AGENTS.md`)}\n${notes}`;

    expect(guideText(current, section)).toBe(current);
    expect(guideText(notes, section).endsWith(`\n${notes}`)).toBe(true);
    expect(guideText(notes, section).startsWith('[//]: # "guide: generated ')).toBe(true);
  });
});

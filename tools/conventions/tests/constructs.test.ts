// Negative controls run against the real repository with a few in-memory files, so they exercise
// the real resolver, package exports, and catalogue.
import { describe, expect, test } from "bun:test";
import { catalogue, checkConstructs, readConstructs, renderCatalogue } from "../src/constructs.js";
import { readModuleGraph } from "../src/modules.js";
import { readRepository, repositoryRoot, type Repository } from "../src/repository.js";

const root = repositoryRoot(import.meta.dir);

const base = readRepository(root, false);

const withFiles = (files: Readonly<Record<string, string>>): Repository => ({
  root,
  paths: [...new Set([...base.paths, ...Object.keys(files)])].sort(),
  links: base.links,
  read: (path) => files[path] ?? base.read(path),
  readLink: base.readLink,
});

const reportFor = (repository: Repository) =>
  readConstructs(repository, readModuleGraph(repository));

const kernel = "packages/domain/src/shared-kernel";

// The shared kernel's package entry re-exports the probe, so importers reach it through a barrel.
const probe = (doc: string) => ({
  [`${kernel}/probe.ts`]: `${doc}export const probeDouble = (value: number): number => value * 2;\n`,
  [`${kernel}/index.ts`]: `${base.read(`${kernel}/index.ts`)}export * from "./probe.js";\n`,
});

const importer = (statement: string) =>
  `${statement}\n\nexport const probeResult = probeDouble(2);\n`;

describe("construct catalogue", () => {
  test("counts consumers through package exports, a barrel, and a namespace import", () => {
    const files = {
      ...probe("/**\n * Doubles a number. Nothing else.\n *\n * @construct digest\n */\n"),
      "apps/backend/src/probe-named.ts": importer(
        'import { probeDouble } from "@vektorprogrammet/domain/shared-kernel";',
      ),
      "apps/backend/src/probe-namespace.ts":
        'import * as Kernel from "@vektorprogrammet/domain/shared-kernel";\n\nexport const probeResult = Kernel.probeDouble(2);\n',
      "apps/backend/src/probe-unrelated.ts":
        'import { canonicalJson } from "@vektorprogrammet/domain/shared-kernel";\n\nexport const probeResult = canonicalJson(2);\n',
    };

    const construct = reportFor(withFiles(files)).constructs.find(
      (candidate) => candidate.name === "probeDouble",
    );

    expect(construct?.category).toBe("digest");
    expect(construct?.summary).toBe("Doubles a number.");
    expect(construct?.consumers).toEqual([
      "apps/backend/src/probe-named.ts",
      "apps/backend/src/probe-namespace.ts",
    ]);
  });

  test("warns about an untagged function that three modules outside its package import", () => {
    const outside = {
      "apps/backend/src/probe-a.ts": importer(
        'import { probeDouble } from "@vektorprogrammet/domain/shared-kernel";',
      ),
      "tools/e2e/probe-b.ts": importer(
        'import { probeDouble } from "@vektorprogrammet/domain/shared-kernel";',
      ),
    };

    const inside = {
      [`${kernel}/probe-inside.ts`]: importer('import { probeDouble } from "./probe.js";'),
    };

    const third = {
      "packages/database/src/probe-c.ts": importer(
        'import { probeDouble } from "@vektorprogrammet/domain/shared-kernel";',
      ),
    };

    const candidates = (files: Readonly<Record<string, string>>) =>
      reportFor(withFiles({ ...probe(""), ...files })).candidates.filter(
        (candidate) => candidate.name === "probeDouble",
      );

    expect(candidates({ ...outside, ...inside })).toHaveLength(0);
    expect(candidates({ ...outside, ...inside, ...third })).toHaveLength(1);

    expect(
      reportFor(
        withFiles({
          ...probe("/**\n * Doubles a number.\n *\n * @construct digest\n */\n"),
          ...outside,
          ...third,
        }),
      ).candidates.filter((candidate) => candidate.name === "probeDouble"),
    ).toHaveLength(0);
  });

  test("rejects a catalogue that misses a new construct, and accepts it rendered", () => {
    const files = probe("/**\n * Doubles a number.\n *\n * @construct digest\n */\n");

    const stale = (repository: Repository) =>
      checkConstructs(repository, reportFor(repository)).filter(
        (finding) => finding.path === catalogue,
      );

    const repository = withFiles(files);

    expect(stale(repository)).toHaveLength(1);

    expect(
      stale(
        withFiles({
          ...files,
          [catalogue]: renderCatalogue(reportFor(repository).constructs),
        }),
      ),
    ).toHaveLength(0);
  });

  test("rejects an unknown category and a tag on a declaration that is not exported", () => {
    const files = {
      [`${kernel}/probe.ts`]: [
        "/** @construct nonsense */",
        "export const probeUnknown = 1;",
        "",
        "/**",
        " * Hidden.",
        " *",
        " * @construct digest",
        " */",
        "const probeHidden = 1;",
        "",
        "export const probeVisible = probeHidden;",
        "",
      ].join("\n"),
    };

    const findings = reportFor(withFiles(files)).findings.filter((finding) =>
      finding.path.startsWith(`${kernel}/probe.ts:`),
    );

    expect(findings.map((finding) => finding.path)).toEqual([
      `${kernel}/probe.ts:2`,
      `${kernel}/probe.ts:9`,
    ]);
  });
});

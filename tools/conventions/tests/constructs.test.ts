// Negative controls run against the real repository with a few in-memory files, so they exercise
// the real resolver, package exports, and pages.
import { describe, expect, test } from "bun:test";
import {
  checkPages,
  consumerFindings,
  constructPages,
  readCandidates,
  readConstructs,
  readConsumers,
  renderPages,
} from "../src/constructs.js";
import { channelsOf } from "../src/contracts.js";
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

const kernel = "packages/domain/src/shared-kernel";

const contract = [
  " * @remarks",
  " * Multiplies by two.",
  " *",
  " * @sideEffects none",
  " *",
  " * @example",
  " * ```ts",
  " * probeDouble(2);",
  " * ```",
  " *",
  " * @avoid Writing `value * 2` again.",
].join("\n");

const tagged = (tags: string) =>
  `/**\n * Doubles a number. Nothing else.\n *\n${tags}\n *\n * @construct digest\n */\n`;

// The shared kernel's package entry re-exports the probe, so importers reach it through a barrel.
const probe = (doc: string, declaration = "(value: number): number => value * 2") => ({
  [`${kernel}/probe.ts`]: `${doc}export const probeDouble = ${declaration};\n`,
  [`${kernel}/index.ts`]: `${base.read(`${kernel}/index.ts`)}export * from "./probe.js";\n`,
});

const importer = (statement: string) =>
  `${statement}\n\nexport const probeResult = probeDouble(2);\n`;

const fromKernel = importer(
  'import { probeDouble } from "@vektorprogrammet/domain/shared-kernel";',
);

const probeConsumers = (repository: Repository) =>
  readConsumers(
    readConstructs(repository).constructs.filter((construct) => construct.name === "probeDouble"),
    readModuleGraph(repository),
  );

describe("construct pages", () => {
  test("counts consumers through package exports, a barrel, and a namespace import", () => {
    const [consumers] = probeConsumers(
      withFiles({
        ...probe(tagged(contract)),
        "apps/backend/src/probe-named.ts": fromKernel,
        "apps/backend/src/probe-namespace.ts":
          'import * as Kernel from "@vektorprogrammet/domain/shared-kernel";\n\nexport const probeResult = Kernel.probeDouble(2);\n',
        "apps/backend/src/probe-unrelated.ts":
          'import { canonicalJson } from "@vektorprogrammet/domain/shared-kernel";\n\nexport const probeResult = canonicalJson(2);\n',
      }),
    );

    expect(consumers?.construct.category).toBe("digest");
    expect(consumers?.construct.summary).toBe("Doubles a number.");
    expect(consumers?.importers).toEqual([
      "apps/backend/src/probe-named.ts",
      "apps/backend/src/probe-namespace.ts",
    ]);
  });

  test("leaves every page byte-identical when a new module imports a construct", () => {
    const files = probe(tagged(contract));
    const before = withFiles(files);
    const after = withFiles({ ...files, "apps/backend/src/probe-named.ts": fromKernel });

    expect(probeConsumers(after)[0]?.importers).toEqual(["apps/backend/src/probe-named.ts"]);
    expect(probeConsumers(before)[0]?.importers).toEqual([]);
    expect([...renderPages(readConstructs(after).constructs)]).toEqual([
      ...renderPages(readConstructs(before).constructs),
    ]);
  });

  test("counts a test of another package as a consumer, but not a test of its own", () => {
    const unshared = (files: Readonly<Record<string, string>>) =>
      consumerFindings(probeConsumers(withFiles({ ...probe(tagged(contract)), ...files }))).length;

    const lone = {
      "apps/backend/src/probe-a.ts": fromKernel,
      [`${kernel}/probe.test.ts`]: importer('import { probeDouble } from "./probe.js";'),
    };

    expect(unshared(lone)).toBe(1);
    expect(unshared({ ...lone, "apps/backend/src/probe-b.test.ts": fromKernel })).toBe(0);
    expect(unshared({ ...lone, "apps/backend/src/probe-b.ts": fromKernel })).toBe(0);
  });

  test("warns about an untagged function that three modules outside its package import", () => {
    const outside = {
      "apps/backend/src/probe-a.ts": fromKernel,
      "tools/e2e/probe-b.ts": fromKernel,
    };

    const inside = {
      [`${kernel}/probe-inside.ts`]: importer('import { probeDouble } from "./probe.js";'),
    };

    const third = { "packages/database/src/probe-c.ts": fromKernel };

    const candidates = (doc: string, files: Readonly<Record<string, string>>) => {
      const repository = withFiles({ ...probe(doc), ...files });

      return readCandidates(
        repository,
        readModuleGraph(repository),
        readConstructs(repository).constructs,
      ).filter((candidate) => candidate.name === "probeDouble");
    };

    expect(candidates("", { ...outside, ...inside })).toHaveLength(0);
    expect(candidates("", { ...outside, ...inside, ...third })).toHaveLength(1);
    expect(candidates(tagged(contract), { ...outside, ...third })).toHaveLength(0);
  });

  test("rejects pages that miss a new construct, and accepts them rendered", () => {
    const files = probe(tagged(contract));
    const page = `${constructPages.contracts}/digest.md`;

    const stale = (repository: Repository) =>
      checkPages(repository, readConstructs(repository).constructs)
        .map((finding) => finding.path)
        .filter((path) => path === constructPages.index || path === page);

    expect(stale(withFiles(files))).toEqual([constructPages.index, page]);

    const pages = renderPages(readConstructs(withFiles(files)).constructs);

    expect(stale(withFiles({ ...files, ...Object.fromEntries(pages) }))).toEqual([]);
    expect(pages.get(page)).toContain("probeDouble(value: number): number");
    expect(pages.get(constructPages.index)).toContain(
      "[`probeDouble`](constructs/digest.md#probedouble): Doubles a number.",
    );
  });

  test("reports a missing contract tag and a missing annotation", () => {
    const gaps = (doc: string, declaration?: string) =>
      readConstructs(withFiles(probe(doc, declaration)))
        .gaps.filter((finding) => finding.path.startsWith(`${kernel}/probe.ts:`))
        .map((finding) => finding.message);

    expect(gaps(tagged(contract))).toEqual([]);
    expect(gaps(tagged(contract.replace("@avoid", "Avoid:")))).toEqual([
      "has no @avoid tag (the misuse that it prevents, and what to do instead)",
    ]);
    expect(gaps(tagged(contract), "(value: number) => value * 2")).toEqual([
      "has no return type annotation",
    ]);
    expect(gaps(tagged(contract), "(value): number => value * 2")).toEqual([
      "has no type annotation on the parameter `value`",
    ]);
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

    const findings = readConstructs(withFiles(files)).findings.filter((finding) =>
      finding.path.startsWith(`${kernel}/probe.ts:`),
    );

    expect(findings.map((finding) => finding.path)).toEqual([
      `${kernel}/probe.ts:2`,
      `${kernel}/probe.ts:9`,
    ]);
  });
});

describe("contract channels", () => {
  test("splits the errors and requirements out of the type as written", () => {
    expect(channelsOf("Effect.Effect<A, Problem | Conflict, Scope.Scope>")).toEqual({
      errors: "Problem | Conflict",
      requirements: "Scope.Scope",
    });
    expect(channelsOf("Effect<void, never, SqlClient>")).toEqual({
      errors: undefined,
      requirements: "SqlClient",
    });
    expect(channelsOf("Effect.Effect<string>")).toEqual({
      errors: undefined,
      requirements: undefined,
    });
    expect(channelsOf("Layer.Layer<Boundary, ConfigError, Database>")).toEqual({
      errors: "ConfigError",
      requirements: "Database",
    });
    expect(channelsOf("Result.Result<Page, Malformed>")).toEqual({
      errors: "Malformed",
      requirements: undefined,
    });
    expect(channelsOf("Option.Option<Row>")).toEqual({
      errors: "Option.None<Row>",
      requirements: undefined,
    });
    expect(channelsOf("Promise<Effect.Effect<A, E>>")).toEqual({
      errors: undefined,
      requirements: undefined,
    });
  });
});

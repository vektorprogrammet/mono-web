// Negative controls run against the real repository with one change each, so they exercise the
// real declaration, context map, and justfile.
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { ConventionsPlatform } from "../src/cli.js";
import { checkLayout, type Finding } from "../src/check.js";
import { boundedContextNames, contextFolderName, readContextModel } from "../src/cml.js";
import { readJustfile } from "../src/justfile.js";
import { readRepository, repositoryRoot, type Repository } from "../src/repository.js";

const run = <A, E>(effect: Effect.Effect<A, E, ConventionsPlatform>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(ConventionsPlatform)));

const root = await run(repositoryRoot(import.meta.dir));

const base = await run(readRepository(root, false));

const justfile = await run(readJustfile(`${root}/justfile`));

const withFiles = (
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

const findingsFor = (
  files: Readonly<Record<string, string>>,
  path: string,
  removed: ReadonlyArray<string> = [],
): ReadonlyArray<Finding> =>
  checkLayout(withFiles(files, removed), justfile).filter((finding) => finding.path === path);

describe("layout check", () => {
  test("rejects a new top-level directory", () => {
    expect(findingsFor({ "scratch/notes.md": "notes\n" }, "scratch/")).toHaveLength(1);
  });

  test("rejects a package outside the package roots", () => {
    expect(
      findingsFor({ "infra/tool/package.json": "{}\n" }, "infra/tool/package.json"),
    ).toHaveLength(1);
  });

  test("rejects a context folder that the CML does not declare, and accepts a CML name", () => {
    const files = {
      "packages/domain/src/billing/index.ts": "export {};\n",
      "packages/domain/src/economy/index.ts": "export {};\n",
    };

    expect(findingsFor(files, "packages/domain/src/billing/")).toHaveLength(1);
    expect(findingsFor(files, "packages/domain/src/economy/")).toHaveLength(0);
  });

  test("rejects a hand edit of a generated section", () => {
    const readme = base.read("README.md");
    const edited = readme.replace("| `apps/backend` ", "| `apps/server`  ");

    expect(edited).not.toBe(readme);
    expect(findingsFor({ "README.md": edited }, "README.md")).toHaveLength(1);
  });

  test("rejects a tool import from product source, and accepts a declared harness", () => {
    const probe = 'import { postgresProgram } from "@monoweb/postgres";\n';

    const files = {
      "apps/backend/src/probe.ts": probe,
      "apps/backend/test/probe.ts": probe,
      "packages/domain/src/probe.ts": 'import "../../../tools/e2e/golden-harness.ts";\n',
    };

    expect(findingsFor(files, "apps/backend/src/probe.ts")).toHaveLength(1);
    expect(findingsFor(files, "packages/domain/src/probe.ts")).toHaveLength(1);
    expect(findingsFor(files, "apps/backend/test/probe.ts")).toHaveLength(0);
  });

  test("rejects a root script beside the justfile", () => {
    const manifest = base
      .read("package.json")
      .replace('"scripts": {', '"scripts": {\n    "build": "turbo build",');

    expect(findingsFor({ "package.json": manifest }, "package.json")).toHaveLength(1);
  });

  test("rejects documentation that names a missing recipe", () => {
    expect(
      findingsFor({ "docs/probe.md": "Run `just deploy-everything`.\n" }, "docs/probe.md"),
    ).toHaveLength(1);
    expect(findingsFor({ "docs/probe.md": "Run `just check`.\n" }, "docs/probe.md")).toHaveLength(
      0,
    );
  });

  test("rejects a workspace that runs Vitest without a configuration that merges the shared one", () => {
    const config = "apps/backend/vitest.config.ts";

    expect(findingsFor({}, "apps/backend/package.json", [config])).toHaveLength(1);
    expect(
      findingsFor(
        {
          [config]:
            '// import { sharedVitestConfig } from "../../vitest.shared";\nimport { defineConfig } from "vitest/config";\n\nexport default defineConfig({});\n',
        },
        config,
      ),
    ).toHaveLength(1);
    expect(
      findingsFor(
        {
          [config]: `import { sharedVitestConfig } from "../../vitest.shared";
import { defineConfig } from "vitest/config";
export default defineConfig({});
`,
        },
        config,
      ),
    ).toHaveLength(1);
    expect(
      findingsFor(
        {
          [config]: `import { mergeConfig } from "vitest/config";
import { sharedVitestConfig } from "../../vitest.shared.js";
export default mergeConfig(sharedVitestConfig, { test: { maxWorkers: 32 } });
`,
        },
        config,
      ),
    ).toHaveLength(1);
    expect(
      findingsFor(
        {
          [config]:
            'import { defineConfig, mergeConfig } from "vitest/config";\nimport { sharedVitestConfig } from "../../vitest.shared.js";\n\nexport default mergeConfig(sharedVitestConfig, defineConfig({}));\n',
        },
        config,
      ),
    ).toHaveLength(0);
    expect(findingsFor({}, "apps/backend/package.json")).toHaveLength(0);
    expect(findingsFor({}, config)).toHaveLength(0);
  });
});

describe("CML bounded context names", () => {
  test("counts only top-level declarations outside comments and strings", () => {
    const cml = [
      "/* BoundedContext InComment { } */",
      "// BoundedContext InLineComment",
      'BoundedContext TeamApplications { domainVisionStatement = "BoundedContext InString" }',
      "ContextMap Map { BoundedContext Nested { } }",
      "BoundedContext HkDirCatalogue",
    ].join("\n");

    expect(boundedContextNames(cml)).toEqual(["TeamApplications", "HkDirCatalogue"]);
    expect(boundedContextNames(cml).map(contextFolderName)).toEqual([
      "team-applications",
      "hk-dir-catalogue",
    ]);
  });
});

describe("CML context map", () => {
  test("reads the upstream side of each arrow, and a partnership as symmetric", () => {
    const model = readContextModel(
      [
        'BoundedContext Upstream implements Area { Aggregate Owned { responsibilities = "Owns it" } }',
        "BoundedContext Downstream",
        "ContextMap Map {",
        "  contains Upstream, Downstream",
        "  Upstream [U,OHS,PL] -> [D,CF] Downstream { exposedAggregates = Owned, Other }",
        '  Downstream [D,ACL] <- [U] Upstream { implementationTechnology = "Import" }',
        "  Upstream [P]<->[P] Downstream : Pact",
        "}",
      ].join("\n"),
    );

    expect(model.errors).toEqual([]);
    expect(model.contexts[0]?.aggregates).toEqual([
      { name: "Owned", responsibilities: ["Owns it"] },
    ]);

    expect(
      model.relationships.map(({ upstream, downstream, downstreamRoles, symmetric }) => [
        upstream,
        downstream,
        downstreamRoles.join(","),
        symmetric,
      ]),
    ).toEqual([
      ["Upstream", "Downstream", "D,CF", false],
      ["Upstream", "Downstream", "D,ACL", false],
      ["Upstream", "Downstream", "P", true],
    ]);

    expect(model.relationships[0]?.exposedAggregates).toEqual(["Owned", "Other"]);
    expect(model.relationships[1]?.implementationTechnology).toBe("Import");
  });

  test("reports a relationship notation that it does not read", () => {
    expect(
      readContextModel("ContextMap Map { Upstream Partnership Downstream }").errors,
    ).toHaveLength(1);
  });
});

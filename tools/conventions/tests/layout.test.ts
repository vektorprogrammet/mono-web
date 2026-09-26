// Negative controls run against the real repository with one change each, so they exercise the
// real declaration, context map, and justfile.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkLayout, type Finding } from "../src/check.js";
import { boundedContextNames, contextFolderName } from "../src/cml.js";
import { readJustfile } from "../src/justfile.js";
import { readRepository, repositoryRoot, type Repository } from "../src/repository.js";

const root = repositoryRoot(import.meta.dir);

const base = readRepository(root, false);

const justfile = readJustfile(join(root, "justfile"));

const withFiles = (files: Readonly<Record<string, string>>): Repository => ({
  root,
  paths: [...new Set([...base.paths, ...Object.keys(files)])].sort(),
  links: base.links,
  read: (path) => files[path] ?? base.read(path),
});

const findingsFor = (
  files: Readonly<Record<string, string>>,
  path: string,
): ReadonlyArray<Finding> =>
  checkLayout(withFiles(files), justfile).filter((finding) => finding.path === path);

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

import { Schema } from "effect";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Application } from "typedoc";

const root = fileURLToPath(new URL("../../", import.meta.url));

const packageRoot = resolve(root, "packages/placements");

const [mode, destination, ...extra] = process.argv.slice(2);

assert(
  (mode === "generate" || mode === "check") && destination && extra.length === 0,
  "Usage: placements.ts <generate|check> <output-directory-outside-repository>",
);

const output = resolve(destination);

const fromRoot = relative(root, output);

assert(
  fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot),
  "Generated documentation must stay outside the repository",
);

const manifest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ exports: Schema.Record(Schema.String, Schema.String) })),
)(await readFile(resolve(packageRoot, "package.json"), "utf8"));

const entryPoints = Object.entries(manifest.exports).map(([name, source]) => {
  assert(name.startsWith("./"), "Expected explicit package exports");

  return resolve(packageRoot, source);
});

const render = async (directory: string) => {
  const app = await Application.bootstrap({
    name: "Placements developer guide",
    entryPoints,
    tsconfig: resolve(packageRoot, "tsconfig.json"),
    readme: resolve(packageRoot, "README.md"),
    basePath: root,
    disableGit: true,
    sourceLinkTemplate: `${pathToFileURL(root).href}{path}#L{line}`,
    includeVersion: false,
    cleanOutputDir: false,
    validation: { invalidLink: true, notExported: false, notDocumented: false },
    treatWarningsAsErrors: true,
  });

  const project = await app.convert();
  assert(project && !app.logger.hasErrors(), "Reference extraction failed");
  app.validate(project);
  assert(!app.logger.hasErrors() && !app.logger.hasWarnings(), "Reference validation failed");
  await app.generateDocs(project, directory);
  assert(!app.logger.hasErrors() && !app.logger.hasWarnings(), "Documentation rendering failed");
  console.log(
    `TypeDoc ${Application.VERSION}; documentation compiler ${app.getTypeScriptVersion()}`,
  );
};

const files = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      for (const child of await files(resolve(directory, entry.name))) {
        paths.push(`${entry.name}/${child}`);
      }
    } else {
      assert(entry.isFile(), "Generated documentation must contain only regular files");
      paths.push(entry.name);
    }
  }

  return paths.sort();
};

if (mode === "generate") {
  // Never replace an existing directory or remove caller-owned content.
  await mkdir(output);
  await render(output);
  console.log(`Open ${pathToFileURL(resolve(output, "index.html")).href}`);
} else {
  const fresh = await mkdtemp(resolve(tmpdir(), "placements-docs-check-"));

  try {
    await render(fresh);
    const expected = await files(fresh);
    assert.deepEqual(await files(output), expected, "Generated file inventory is stale");

    for (const path of expected) {
      assert(
        (await readFile(resolve(output, path))).equals(await readFile(resolve(fresh, path))),
        `Generated documentation is stale: ${path}`,
      );
    }

    console.log("Placements documentation is fresh");
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
}

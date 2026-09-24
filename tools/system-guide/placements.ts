import { Schema } from "effect";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Application } from "typedoc";
import {
  acceptArtifact, cleanRevision, git, inventory, outsideOutput, publicFile, receiptName,
} from "./placements-artifact.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const packageRoot = resolve(root, "packages/placements");
const [mode, destination, ...extra] = process.argv.slice(2);
assert(
  ["generate", "check", "ci", "accept"].includes(mode ?? "") && destination && extra.length === 0,
  "Usage: placements.ts <generate|check|ci|accept> <output-directory-outside-repository>",
);
const output = await outsideOutput(root, destination);
const expectedRevision = process.env.PLACEMENTS_DOCS_EXPECTED_REVISION;
const revision = mode === "ci" || mode === "accept" ? cleanRevision(root, expectedRevision) : undefined;
const tracked = new Set(git(root, "ls-files", "-z").split("\0"));
const sourceUrl = revision
  ? `https://github.com/vektorprogrammet/mono-web/blob/${revision}/{path}#L{line}`
  : `${pathToFileURL(root).href}{path}#L{line}`;
const manifest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ exports: Schema.Record(Schema.String, Schema.String) })),
)(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const entryPoints = Object.entries(manifest.exports).map(([name, source]) => {
  assert(name.startsWith("./"), "Expected explicit package exports");
  const entry = resolve(packageRoot, source);
  publicFile(root, tracked, entry);
  return entry;
});

let interrupted = false;
let child: ChildProcess | undefined;
const run = async (script: string) => {
  assert(!interrupted, "Documentation command interrupted");
  const running = spawn(process.execPath, ["--no-env-file", "run", "--cwd", packageRoot, script], {
    cwd: root, stdio: "inherit", detached: true,
  });
  child = running;
  try {
    const { promise, resolve: complete, reject } = Promise.withResolvers<number | string | null>();
    running.once("error", reject);
    running.once("exit", (code, signal) => complete(signal ?? code));
    const code = await promise;
    assert.equal(code, 0, script + " failed");
    assert(!interrupted, "Documentation command interrupted");
  } finally {
    child = undefined;
  }
};

const render = async (directory: string) => {
  const app = await Application.bootstrap({
    name: "Placements developer guide",
    entryPoints,
    tsconfig: resolve(packageRoot, "tsconfig.json"),
    readme: resolve(packageRoot, "README.md"),
    basePath: root,
    displayBasePath: root,
    disableGit: true,
    sourceLinkTemplate: sourceUrl,
    includeVersion: false,
    excludeExternals: true,
    cleanOutputDir: false,
    validation: { invalidLink: true, notExported: false, notDocumented: false },
    treatWarningsAsErrors: true,
  });
  // TypeDoc registers README and nested include inputs before reading them.
  // Guard its existing lifecycle instead of parsing Markdown or TypeScript.
  const watchFile = app.watchFile.bind(app);
  app.watchFile = (path, restart) => {
    publicFile(root, tracked, path);
    watchFile(path, restart);
  };
  const project = await app.convert();
  assert(!interrupted, "Documentation command interrupted");
  assert(project && !app.logger.hasErrors(), "Reference extraction failed");
  app.validate(project);
  assert(!app.logger.hasErrors() && !app.logger.hasWarnings(), "Reference validation failed");
  const sourceLines = new Map<string, number>();
  let sourceCount = 0;
  for (const reflection of Object.values(project.reflections)) {
    if (!("sources" in reflection) || !Array.isArray(reflection.sources)) continue;
    // Inherited vendor signatures remain visible, but are not repository source.
    reflection.sources = reflection.sources.filter((source) => !source.fileName.split("/").includes("node_modules"));
    for (const source of reflection.sources) {
      const path = publicFile(root, tracked, resolve(root, source.fileName));
      let lines = sourceLines.get(path);
      if (lines === undefined) {
        lines = (await readFile(resolve(root, path), "utf8")).split("\n").length;
        sourceLines.set(path, lines);
      }
      assert(Number.isInteger(source.line) && source.line > 0 && source.line <= lines, "Invalid source line");
      assert.equal(source.url, sourceUrl.replace("{path}", path).replace("{line}", String(source.line)), "Invalid source link");
      sourceCount++;
    }
  }
  assert(sourceCount > 0, "Reference source links are missing");
  for (const path of project.files.getMediaPaths()) publicFile(root, tracked, path);
  await app.generateDocs(project, directory);
  assert(!interrupted, "Documentation command interrupted");
  assert(!app.logger.hasErrors() && !app.logger.hasWarnings(), "Documentation rendering failed");
  assert((await inventory(directory))["index.html"], "Documentation index is missing");
  console.log(`TypeDoc ${Application.VERSION}; documentation compiler ${app.getTypeScriptVersion()}`);
};

// TypeDoc has no cancellation API. Finish its current operation before cleanup.
const interrupt = () => {
  interrupted = true;
  if (child?.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
try {
  if (mode === "accept") {
    await acceptArtifact(root, output, expectedRevision);
    assert(!interrupted, "Documentation command interrupted");
    console.log("Accepted retained Placements documentation for " + revision);
  } else if (mode === "generate" || mode === "ci") {
    // Only this successful mkdir gives the command ownership of a new directory.
    await mkdir(output);
    try {
      if (mode === "ci") {
        await run("check-types");
        await run("docs:examples");
      }
      await render(output);
      if (mode === "ci") {
        cleanRevision(root, expectedRevision);
        await writeFile(resolve(output, receiptName), JSON.stringify({
          format: 1, status: "complete", revision, sourceUrl, files: await inventory(output),
        }, null, 2) + "\n", { flag: "wx" });
        await acceptArtifact(root, output, expectedRevision);
      }
      assert(!interrupted, "Documentation command interrupted");
    } catch (error) {
      await rm(output, { recursive: true, force: true });
      throw error;
    }
    console.log("Open " + pathToFileURL(resolve(output, "index.html")).href);
  } else {
    const fresh = await mkdtemp(resolve(tmpdir(), "placements-docs-check-"));
    try {
      await render(fresh);
      assert.deepEqual(await inventory(output), await inventory(fresh), "Generated documentation is stale");
      assert(!interrupted, "Documentation command interrupted");
      console.log("Placements documentation is fresh");
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  }
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}

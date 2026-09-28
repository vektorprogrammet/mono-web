import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Config, Console, Effect, Exit, FileSystem, Option, Path, Predicate, Schema } from "effect";
import * as Runtime from "effect/Runtime";
import { Application, DeclarationReflection, SignatureReflection } from "typedoc";
import {
  acceptArtifact,
  cleanRevision,
  ensure,
  git,
  inventory,
  outsideOutput,
  PlacementsDocsFailure,
  publicFile,
  readPublicSource,
  ReceiptJson,
  receiptName,
} from "./placements-artifact.js";
import { runDocumentationCommand } from "./placements-process.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

const toolRoot = fileURLToPath(new URL("./", import.meta.url));

const Manifest = Schema.fromJsonString(
  Schema.Struct({ exports: Schema.Record(Schema.String, Schema.String) }),
);

const usage = "Usage: placements.ts <generate|check|ci|accept> <output-directory-outside-repository>";

/** A TypeDoc call. It has no cancellation API, so an interruption waits for the call to finish. */
const typedoc = <A>(what: string, call: () => Promise<A>) =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: call,
      catch: (error) => new PlacementsDocsFailure({ message: `${what}: ${String(error)}` }),
    }),
  );

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // The Placements context spans the portable domain entry and its database-backed entry.
  const packageRoots = ["packages/domain", "packages/database"].map((packageRoot) =>
    path.resolve(root, packageRoot),
  );

  const [mode, destination, ...extra] = process.argv.slice(2);

  if (
    mode === undefined ||
    !["generate", "check", "ci", "accept"].includes(mode) ||
    destination === undefined ||
    destination === "" ||
    extra.length > 0
  )
    return yield* new PlacementsDocsFailure({ message: usage });

  const output = yield* outsideOutput({ root, destination });

  const expectedRevision = Option.getOrUndefined(
    yield* Config.option(Config.String("PLACEMENTS_DOCS_EXPECTED_REVISION")),
  );

  const revision =
    mode === "ci" || mode === "accept"
      ? yield* cleanRevision({ root, expected: expectedRevision })
      : undefined;

  const tracked = (yield* git(root, "ls-files", "-z")).split("\0").filter((file) => file !== "");
  const source = yield* readPublicSource({ root, tracked });

  const sourceUrl =
    revision === undefined
      ? `${pathToFileURL(root).href}{path}#L{line}`
      : `https://github.com/vektorprogrammet/mono-web/blob/${revision}/{path}#L{line}`;

  const entryPoints = yield* Effect.forEach(packageRoots, (packageRoot) =>
    Effect.gen(function* () {
      const manifest = yield* fileSystem
        .readFileString(path.resolve(packageRoot, "package.json"))
        .pipe(Effect.flatMap(Schema.decodeEffect(Manifest)), Effect.orDie);

      const entry = manifest.exports["./placements"];

      if (entry === undefined)
        return yield* new PlacementsDocsFailure({
          message: "Expected an explicit ./placements package export",
        });

      const file = path.resolve(packageRoot, entry);

      publicFile(source, file);

      return file;
    }),
  );

  const run = (args: ReadonlyArray<string>) =>
    runDocumentationCommand({ command: process.execPath, args: ["--no-env-file", ...args], cwd: root });

  const render = Effect.fnUntraced(function* (directory: string) {
    const app = yield* typedoc("TypeDoc did not start", () =>
      Application.bootstrap({
        name: "Placements developer guide",
        entryPoints,
        tsconfig: path.resolve(toolRoot, "tsconfig.json"),
        readme: path.resolve(root, "packages/domain/src/placements/README.md"),
        basePath: root,
        displayBasePath: root,
        disableGit: true,
        sourceLinkTemplate: sourceUrl,
        includeVersion: false,
        excludeExternals: true,
        cleanOutputDir: false,
        validation: { invalidLink: true, notExported: false, notDocumented: false },
        treatWarningsAsErrors: true,
      }),
    );

    // TypeDoc registers README and nested include inputs before reading them.
    // Guard its existing lifecycle instead of parsing Markdown or TypeScript.
    const watchFile = app.watchFile.bind(app);

    app.watchFile = (file, restart) => {
      publicFile(source, file);
      watchFile(file, restart);
    };

    const project = yield* typedoc("Reference extraction failed", () => app.convert());

    yield* ensure(project !== undefined && !app.logger.hasErrors(), "Reference extraction failed");

    if (project === undefined) return;

    app.validate(project);

    yield* ensure(
      !app.logger.hasErrors() && !app.logger.hasWarnings(),
      "Reference validation failed",
    );

    const sourceLines = new Map<string, number>();
    let sourceCount = 0;

    for (const reflection of Object.values(project.reflections)) {
      if (
        !(reflection instanceof DeclarationReflection || reflection instanceof SignatureReflection) ||
        reflection.sources === undefined
      )
        continue;

      // Inherited vendor signatures remain visible, but are not repository source.
      reflection.sources = reflection.sources.filter(
        (reflected) => !reflected.fileName.split("/").includes("node_modules"),
      );

      for (const reflected of reflection.sources) {
        const file = publicFile(source, path.resolve(root, reflected.fileName));
        let lines = sourceLines.get(file);

        if (lines === undefined) {
          lines = (yield* Effect.orDie(fileSystem.readFileString(path.resolve(root, file)))).split(
            "\n",
          ).length;
          sourceLines.set(file, lines);
        }

        yield* ensure(
          Number.isInteger(reflected.line) && reflected.line > 0 && reflected.line <= lines,
          "Invalid source line",
        );

        yield* ensure(
          reflected.url ===
            sourceUrl.replace("{path}", file).replace("{line}", String(reflected.line)),
          "Invalid source link",
        );

        sourceCount++;
      }
    }

    yield* ensure(sourceCount > 0, "Reference source links are missing");

    for (const media of project.files.getMediaPaths()) publicFile(source, media);

    yield* typedoc("Documentation rendering failed", () => app.generateDocs(project, directory));

    yield* ensure(
      !app.logger.hasErrors() && !app.logger.hasWarnings(),
      "Documentation rendering failed",
    );

    yield* ensure(
      (yield* inventory(directory))["index.html"] !== undefined,
      "Documentation index is missing",
    );

    yield* Console.log(
      `TypeDoc ${Application.VERSION}; documentation compiler ${app.getTypeScriptVersion()}`,
    );
  });

  if (mode === "accept") {
    yield* acceptArtifact({ root, output, expected: expectedRevision });
    yield* Console.log("Accepted retained Placements documentation for " + revision);
  } else if (mode === "generate" || mode === "ci") {
    // Only this successful mkdir gives the command ownership of a new directory.
    yield* Effect.orDie(fileSystem.makeDirectory(output));

    yield* Effect.gen(function* () {
      if (mode === "ci") {
        for (const packageRoot of packageRoots)
          yield* run(["run", "--cwd", packageRoot, "check-types"]);

        yield* run(["run", "--cwd", toolRoot, "docs:examples"]);
      }

      yield* render(output);

      if (mode === "ci" && revision !== undefined) {
        yield* cleanRevision({ root, expected: expectedRevision });

        const receipt = yield* Schema.encodeEffect(ReceiptJson)({
          format: 1,
          status: "complete",
          revision,
          sourceUrl,
          files: yield* inventory(output),
        }).pipe(Effect.orDie);

        yield* Effect.orDie(
          fileSystem.writeFileString(path.resolve(output, receiptName), receipt + "\n", {
            flag: "wx",
          }),
        );

        yield* acceptArtifact({ root, output, expected: expectedRevision });
      }
    }).pipe(Effect.onError(() => Effect.ignore(fileSystem.remove(output, { recursive: true, force: true }))));

    yield* Console.log("Open " + pathToFileURL(path.resolve(output, "index.html")).href);
  } else {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const fresh = yield* Effect.orDie(
          fileSystem.makeTempDirectoryScoped({ prefix: "placements-docs-check-" }),
        );

        yield* render(fresh);

        const retained = Object.entries(yield* inventory(output)).toSorted(([a], [b]) =>
          a.localeCompare(b),
        );

        const rendered = Object.entries(yield* inventory(fresh)).toSorted(([a], [b]) =>
          a.localeCompare(b),
        );

        yield* ensure(
          retained.length === rendered.length &&
            retained.every(
              ([name, digest], index) =>
                rendered[index]?.[0] === name && rendered[index]?.[1] === digest,
            ),
          "Generated documentation is stale",
        );

        yield* Console.log("Placements documentation is fresh");
      }),
    );
  }

  return 0;
}).pipe(
  Effect.catchTags({
    PlacementsDocsFailure: ({ message }) => Console.error(message).pipe(Effect.as(1)),
    DocumentationCommandFailed: ({ message, exitCode }) =>
      Console.error(`${message} (${exitCode})`).pipe(Effect.as(1)),
  }),
);

// A program that succeeds with a number exits with that code.
const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isSuccess(exit) && Predicate.isNumber(exit.value)) onExit(exit.value);
  else Runtime.defaultTeardown(exit, onExit);
};

/** The platform of the documentation commands, which their tests take too. */
export const PlacementsDocsPlatform = BunServices.layer;

/** The services of `PlacementsDocsPlatform`. */
export type PlacementsDocsPlatform = BunServices.BunServices;

if (import.meta.main)
  BunRuntime.runMain(program.pipe(Effect.provide(PlacementsDocsPlatform)), { teardown });

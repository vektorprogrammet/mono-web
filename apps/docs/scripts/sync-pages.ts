// Mirror the published repository Markdown into the ignored Vocs pages directory.
// Pages keep their repository paths, so relative links between them still resolve.
// Two build-time expansions keep sources readable on GitHub and valid for Vocs:
// - a TypeDoc `{@includeCode path}` line becomes a code block with that file;
// - an `.mdx` source gets imports for the components it uses from `mdxComponents`.
// `--watch` re-mirrors a source whenever it changes, for `vocs dev`.
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Array, Console, Data, Effect, FileSystem, Path, Schema, Stream } from "effect";
import process from "node:process";
import {
  completeDirectories,
  mdxComponents,
  pageFile,
  pagesDirectory,
  repositoryRoot,
  sources,
} from "../site.ts";

/** Markdown files in a complete directory that no section of `site.ts` publishes. */
class UnpublishedSources extends Data.TaggedError("UnpublishedSources")<{
  readonly message: string;
}> {}

const encodeSpecifier = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const checkCompleteDirectories = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  for (const directory of completeDirectories) {
    const unpublished = (yield* fs.readDirectory(path.resolve(repositoryRoot, directory)))
      .filter((name) => /\.mdx?$/.test(name))
      .map((name) => `${directory}/${name}`)
      .filter((source) => !sources.includes(source));

    if (unpublished.length > 0)
      return yield* new UnpublishedSources({
        message: `Add ${unpublished.join(", ")} to a section in apps/docs/site.ts.`,
      });
  }
});

const mirror = Effect.fnUntraced(function* (source: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.resolve(pagesDirectory, pageFile(source));
  let content = yield* fs.readFileString(path.resolve(repositoryRoot, source), "utf8");

  for (const [line, include = ""] of content.matchAll(/^\{@includeCode\s+(\S+)\}$/gm)) {
    const code = (yield* fs.readFileString(
      path.resolve(repositoryRoot, path.dirname(source), include),
      "utf8",
    )).trimEnd();

    // Fence the file with more backticks than any fence inside it.
    const fence = "`".repeat(
      Math.max(3, ...[...code.matchAll(/`{3,}/g)].map(([run]) => run.length + 1)),
    );

    content = content.replace(line, `${fence}${path.extname(include).slice(1)}\n${code}\n${fence}`);
  }

  if (source.endsWith(".mdx")) {
    const imports = Object.entries(mdxComponents)
      .filter(([name]) => content.includes(`<${name}`))
      .map(
        ([name, file]) =>
          `import { ${name} } from ${encodeSpecifier(path.relative(path.dirname(target), file))};\n`,
      );

    if (imports.length > 0) content = `${imports.join("")}\n${content}`;
  }

  yield* fs.makeDirectory(path.dirname(target), { recursive: true });

  yield* fs.writeFileString(target, content);
});

// Watch directories, not files: editors often replace a file on save.
const watchSources = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directories = Array.dedupe(sources.map((source) => path.dirname(source)));

  yield* Stream.mergeAll(
    directories.map((directory) =>
      fs.watch(path.resolve(repositoryRoot, directory)).pipe(
        Stream.map((event) => path.join(directory, path.basename(event.path))),
        Stream.filter((source) => sources.includes(source)),
      ),
    ),
    { concurrency: "unbounded" },
  ).pipe(
    Stream.runForEach((source) =>
      mirror(source).pipe(Effect.catchCause((cause) => Console.error(cause))),
    ),
  );
});

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* checkCompleteDirectories;

  // Committed Vocs files in the pages directory start with an underscore.
  for (const entry of yield* fs.readDirectory(pagesDirectory))
    if (!entry.startsWith("_"))
      yield* fs.remove(path.resolve(pagesDirectory, entry), { recursive: true });

  yield* Effect.forEach(sources, mirror, { concurrency: "unbounded", discard: true });

  yield* Console.log(
    `Mirrored ${sources.length} repository documents into ${path.relative(repositoryRoot, pagesDirectory)}.`,
  );

  if (process.argv.includes("--watch")) yield* watchSources;
});

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));

/**
 * The checks of the Placements documentation: its inputs are tracked public source, its output
 * stays outside the repository, and a retained artifact matches its receipt and source revision.
 */
import { createHash } from "node:crypto";
import { Data, Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { dual } from "effect/Function";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export const receiptName = "source-receipt.json";

/** A documentation input, output, or artifact that the checks reject. */
export class PlacementsDocsFailure extends Data.TaggedError("PlacementsDocsFailure")<{
  readonly message: string;
}> {}

/** Fails with `message` unless `condition` holds. */
export const ensure: {
  (message: string): (condition: boolean) => Effect.Effect<void, PlacementsDocsFailure>;
  (condition: boolean, message: string): Effect.Effect<void, PlacementsDocsFailure>;
} = dual(
  2,
  (condition: boolean, message: string): Effect.Effect<void, PlacementsDocsFailure> =>
    condition ? Effect.void : Effect.fail(new PlacementsDocsFailure({ message })),
);

/** The trimmed standard output of `git -C root ...args`. */
export const git = (
  root: string,
  ...args: ReadonlyArray<string>
): Effect.Effect<string, PlacementsDocsFailure, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const [stdout, stderr, status] = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make("git", ["-C", root, ...args], { stdin: "ignore" }),
        );

        return yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
      }),
    ).pipe(
      Effect.mapError(
        (error) => new PlacementsDocsFailure({ message: `git ${args.join(" ")}: ${error.message}` }),
      ),
    );

    if (status !== 0)
      return yield* new PlacementsDocsFailure({
        message: `git ${args.join(" ")} failed: ${stderr.trim()}`,
      });

    return stdout.trim();
  });

/** The expected revision, when the checkout is clean at exactly that revision. */
export const cleanRevision = ({
  root,
  expected,
}: {
  readonly root: string;
  readonly expected: string | undefined;
}): Effect.Effect<string, PlacementsDocsFailure, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    if (expected === undefined || !/^[a-f0-9]{40}$/.test(expected))
      return yield* new PlacementsDocsFailure({
        message: "An exact expected Git revision is required",
      });

    yield* ensure((yield* git(root, "rev-parse", "HEAD")) === expected, "Source revision does not match");

    yield* ensure(
      (yield* git(root, "status", "--porcelain", "--untracked-files=all")) === "",
      "Source checkout must be clean",
    );

    return expected;
  });

/**
 * The tracked files of a checkout, with whether each is a regular file that no symbolic link
 * leads to, read once so that TypeDoc's synchronous input hook can check an input.
 */
export interface PublicSource {
  readonly root: string;
  readonly path: Path.Path;
  /** Tracked paths relative to the root, each with whether it is a regular file on its own path. */
  readonly files: ReadonlyMap<string, boolean>;
}

/** Reads whether each tracked path of `root` is a regular file on its own path. */
export const readPublicSource = ({
  root,
  tracked,
}: {
  readonly root: string;
  /** Paths relative to the root, as `git ls-files` lists them. */
  readonly tracked: ReadonlyArray<string>;
}): Effect.Effect<
  PublicSource,
  PlacementsDocsFailure,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const entries = yield* Effect.forEach(
      tracked,
      (file) =>
        Effect.gen(function* () {
          const absolute = path.resolve(root, file);
          const link = yield* Effect.option(fileSystem.readLink(absolute));
          const info = yield* Effect.option(fileSystem.stat(absolute));
          const real = yield* Effect.option(fileSystem.realPath(absolute));

          const regular =
            Option.isNone(link) &&
            Option.isSome(info) &&
            info.value.type === "File" &&
            Option.isSome(real) &&
            real.value === absolute;

          return [file, regular] as const;
        }),
      { concurrency: 16 },
    );

    return { root, path, files: new Map(entries) };
  });

/**
 * The path of `file` relative to the root, when it is tracked public source: no part starts with
 * a dot, and it is a regular file on its own path. Throws otherwise, inside TypeDoc's hook.
 */
export const publicFile: {
  (file: string): (source: PublicSource) => string;
  (source: PublicSource, file: string): string;
} = dual(2, (source: PublicSource, file: string): string => {
  const absolute = source.path.resolve(file);
  const relative = source.path.relative(source.root, absolute);

  if (
    !source.files.has(relative) ||
    relative.split(source.path.sep).some((part) => part.startsWith("."))
  )
    throw new PlacementsDocsFailure({
      message: "Documentation input must be tracked public source: " + relative,
    });

  if (source.files.get(relative) !== true)
    throw new PlacementsDocsFailure({
      message: "Documentation input must not traverse a symlink: " + relative,
    });

  return relative;
});

/** The output directory, when it stays outside the repository and its parent, without links. */
export const outsideOutput = ({
  root,
  destination,
}: {
  readonly root: string;
  readonly destination: string;
}): Effect.Effect<string, PlacementsDocsFailure, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const output = path.resolve(destination);

    const realPath = (file: string) =>
      Effect.mapError(
        fileSystem.realPath(file),
        (error) => new PlacementsDocsFailure({ message: error.message }),
      );

    // Resolve the parent even when the output does not exist yet.
    const canonical = path.resolve(
      yield* realPath(path.resolve(output, "..")),
      output.split(path.sep).at(-1) ?? "",
    );

    const fromRoot = path.relative(yield* realPath(root), canonical);

    yield* ensure(
      fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot),
      "Documentation output must stay outside the repository and its parent",
    );

    yield* ensure(canonical === output, "Documentation output must not traverse a symlink");

    return output;
  });

/** The SHA-256 of every file below `directory`, which must hold only directories and files. */
export const inventory = (
  directory: string,
): Effect.Effect<Record<string, string>, PlacementsDocsFailure, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const kind = (file: string) =>
      Effect.gen(function* () {
        if (Option.isSome(yield* Effect.option(fileSystem.readLink(file)))) return "SymbolicLink";

        const info = yield* Effect.option(fileSystem.stat(file));

        return Option.isSome(info) ? info.value.type : "Unknown";
      });

    yield* ensure(
      (yield* kind(directory)) === "Directory",
      "Documentation output must be a regular directory",
    );

    const names = yield* Effect.mapError(
      fileSystem.readDirectory(directory),
      (error) => new PlacementsDocsFailure({ message: error.message }),
    );

    // A Map keeps a file called `__proto__` as an entry.
    const result = new Map<string, string>();

    for (const name of names.toSorted((a, b) => a.localeCompare(b))) {
      const file = path.resolve(directory, name);
      const type = yield* kind(file);

      if (type === "Directory") {
        for (const [child, digest] of Object.entries(yield* inventory(file)))
          result.set(`${name}/${child}`, digest);
      } else {
        yield* ensure(type === "File", "Documentation output must contain only regular files");

        const bytes = yield* Effect.mapError(
          fileSystem.readFile(file),
          (error) => new PlacementsDocsFailure({ message: error.message }),
        );

        result.set(name, createHash("sha256").update(bytes).digest("hex"));
      }
    }

    return Object.fromEntries(result);
  });

/** The receipt that a complete documentation run writes beside its output. */
export const Receipt = Schema.Struct({
  format: Schema.Finite,
  status: Schema.String,
  revision: Schema.String,
  sourceUrl: Schema.String,
  files: Schema.Record(Schema.String, Schema.String),
});

/** The receipt as JSON text, indented by two spaces. */
export const ReceiptJson = Schema.fromJsonString(Receipt, { space: 2 });

/** Accepts a retained artifact against its receipt and the clean source revision `expected`. */
export const acceptArtifact = ({
  root,
  output,
  expected,
}: {
  readonly root: string;
  readonly output: string;
  readonly expected: string | undefined;
}): Effect.Effect<
  typeof Receipt.Type,
  PlacementsDocsFailure,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const revision = yield* cleanRevision({ root, expected });
    const actual = yield* inventory(output);

    yield* ensure(
      actual[receiptName] !== undefined && actual["index.html"] !== undefined,
      "Complete documentation output is missing",
    );

    const receipt = yield* fileSystem.readFileString(path.resolve(output, receiptName)).pipe(
      Effect.flatMap(Schema.decodeEffect(ReceiptJson)),
      Effect.mapError(
        (error) => new PlacementsDocsFailure({ message: `Unreadable receipt: ${error.message}` }),
      ),
    );

    yield* ensure(receipt.format === 1, "Unknown documentation receipt format");
    yield* ensure(receipt.status === "complete", "Documentation did not complete");
    yield* ensure(receipt.revision === revision, "Retained documentation has a stale source revision");

    yield* ensure(
      receipt.sourceUrl ===
        `https://github.com/vektorprogrammet/mono-web/blob/${revision}/{path}#L{line}`,
      "Documentation source URL is not revision-bound",
    );

    delete actual[receiptName];

    const listed = Object.entries(receipt.files).toSorted(([a], [b]) => a.localeCompare(b));
    const found = Object.entries(actual).toSorted(([a], [b]) => a.localeCompare(b));

    yield* ensure(
      listed.length === found.length &&
        listed.every(
          ([name, digest], index) => found[index]?.[0] === name && found[index]?.[1] === digest,
        ),
      "Retained documentation inventory or content changed",
    );

    yield* cleanRevision({ root, expected });

    return receipt;
  });

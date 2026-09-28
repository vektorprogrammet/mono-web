/**
 * The files that the layout check reads. The working tree view lists tracked and untracked files
 * that Git does not ignore. The staged view lists the Git index, which is the tree that a commit
 * records; the hook runner sets unstaged changes aside, so the files on disk hold the staged content.
 *
 * Reading a repository loads every listed file through `FileSystem` once, so the checks read the
 * files synchronously. A file that could not be loaded fails when a check reads it.
 */
import { Data, Effect, FileSystem, Option, Path, Result, Stream } from "effect";
import { dual } from "effect/Function";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export interface Repository {
  readonly root: string;
  /** File paths relative to the root, with forward slashes, sorted. */
  readonly paths: ReadonlyArray<string>;
  /** The paths that are symbolic links, which conventions checks reject where a file is required. */
  readonly links: ReadonlySet<string>;
  readonly read: (path: string) => string;
  /** The target of a symbolic link, as the link stores it. */
  readonly readLink: (path: string) => string;
}

/** Git could not list the repository. */
export class RepositoryGitFailure extends Data.TaggedError("RepositoryGitFailure")<{
  readonly message: string;
}> {}

/** A file that a check read but that the repository could not load. */
export class RepositoryFileUnreadable extends Data.TaggedError("RepositoryFileUnreadable")<{
  readonly message: string;
}> {}

type RepositoryServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

const git = Effect.fnUntraced(function* (root: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const failure = (detail: string) =>
    new RepositoryGitFailure({ message: `git ${args.join(" ")} failed: ${detail}` });

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
  ).pipe(Effect.mapError((error) => failure(error.message)));

  if (status !== 0) return yield* failure(stderr.trim());

  return stdout;
});

/** The root of the Git working tree that contains `directory`. */
export const repositoryRoot = (
  directory: string,
): Effect.Effect<string, RepositoryGitFailure, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.map(git(directory, ["rev-parse", "--show-toplevel"]), (text) => text.trim());

// Decoding keeps a byte order mark, as `readFileSync(path, "utf8")` did.
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

interface Entry {
  readonly path: string;
  readonly link: Option.Option<string>;
  readonly present: boolean;
  readonly bytes: Result.Result<Uint8Array, PlatformError> | undefined;
}

const loadRepository = Effect.fnUntraced(function* (root: string, staged: boolean) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const listed = yield* git(root, [
    "ls-files",
    "-z",
    "--cached",
    ...(staged ? [] : ["--others", "--exclude-standard"]),
  ]);

  // `readLink` succeeds only on a symbolic link, which is present even when its target is not.
  const entries: ReadonlyArray<Entry> = yield* Effect.forEach(
    [...new Set(listed.split("\0"))].filter((listedPath) => listedPath !== ""),
    (listedPath) =>
      Effect.gen(function* () {
        const file = path.join(root, listedPath);
        const link = yield* Effect.option(fileSystem.readLink(file));

        const present =
          Option.isSome(link) ||
          (yield* Effect.orElseSucceed(fileSystem.exists(file), () => false));

        const bytes = present ? yield* Effect.result(fileSystem.readFile(file)) : undefined;

        return { path: listedPath, link, present, bytes };
      }),
    { concurrency: 16 },
  );

  const paths: Array<string> = [];
  const links = new Map<string, string>();
  const contents = new Map<string, Result.Result<Uint8Array, PlatformError>>();

  for (const entry of entries) {
    // A tracked file that the working tree deleted is not part of the working tree view.
    if (!entry.present && !staged) continue;

    paths.push(entry.path);

    if (Option.isSome(entry.link)) links.set(entry.path, entry.link.value);

    if (entry.bytes !== undefined) contents.set(entry.path, entry.bytes);
  }

  const repository: Repository = {
    root,
    paths: paths.sort(),
    links: new Set(links.keys()),
    read: (file) => {
      const loaded = contents.get(file);

      if (loaded === undefined)
        throw new RepositoryFileUnreadable({ message: `${file}: no such file` });

      if (Result.isFailure(loaded))
        throw new RepositoryFileUnreadable({ message: `${file}: ${loaded.failure.message}` });

      return utf8.decode(loaded.success);
    },
    readLink: (file) => {
      const target = links.get(file);

      if (target === undefined)
        throw new RepositoryFileUnreadable({ message: `${file}: not a symbolic link` });

      return target;
    },
  };

  return repository;
});

/** The staged view with `staged`, the working tree view otherwise. */
export const readRepository: {
  (
    staged: boolean,
  ): (root: string) => Effect.Effect<Repository, RepositoryGitFailure, RepositoryServices>;
  (
    root: string,
    staged: boolean,
  ): Effect.Effect<Repository, RepositoryGitFailure, RepositoryServices>;
} = dual(2, (root: string, staged: boolean) => loadRepository(root, staged));

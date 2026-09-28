/**
 * Checks files in the Git index against the source-safety rules. In a commit hook the index is
 * the tree the commit records; in CI it is the checkout. Every rule reads one path and its bytes,
 * so the pre-commit hook checks only the index entries that differ from HEAD (`--changed`); the
 * merge hook and `just check` check every entry, so no task cache can skip it.
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import process from "node:process";
import { Console, Data, Effect, Exit, Predicate, Stream } from "effect";
import * as Runtime from "effect/Runtime";
import { dual } from "effect/Function";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  isTextualSourcePath,
  sourcePathSafetyReason,
  sourceTextSafetyReason,
  type SourceSafetyReason,
} from "./source-safety.js";

export interface SourceSafetyFinding {
  readonly path: string;
  readonly reason: SourceSafetyReason;
}

export interface SourceSafetyScan {
  readonly files: number;
  readonly findings: readonly SourceSafetyFinding[];
}

/** A Git command that failed, or whose output the scan could not read. */
export class SourceSafetyGitError extends Data.TaggedError("SourceSafetyGitError")<{
  readonly message: string;
}> {}

const concatenate = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return bytes;
};

const utf8 = new TextDecoder();

// The exit code and the output bytes of one Git command; `input` is written to its standard input.
const runGit = (root: string, args: readonly string[], input?: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const handle = yield* spawner.spawn(
        ChildProcess.make("git", ["-C", root, ...args], {
          stdin: input === undefined ? "ignore" : Stream.make(new TextEncoder().encode(input)),
        }),
      );

      const [stdout, stderr, status] = yield* Effect.all(
        [Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      );

      return { status, stdout: concatenate(stdout), stderr: utf8.decode(concatenate(stderr)) };
    }),
  ).pipe(
    Effect.mapError(
      (error) =>
        new SourceSafetyGitError({ message: `git ${args.join(" ")} failed: ${error.message}` }),
    ),
  );

const git = (root: string, args: readonly string[], input?: string) =>
  Effect.flatMap(runGit(root, args, input), (result) =>
    result.status === 0
      ? Effect.succeed(result.stdout)
      : Effect.fail(
          new SourceSafetyGitError({
            message: `git ${args.join(" ")} failed: ${result.stderr.trim()}`,
          }),
        ),
  );

/** `index` checks every entry of the index; `changed` only the entries that differ from HEAD. */
export type SourceSafetyScope = "index" | "changed";

const isScope = (value: unknown): value is SourceSafetyScope =>
  value === "index" || value === "changed";

// Git's empty tree, which a repository without commits compares against.
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** The mode, object id, and path of each index entry in the scope, submodules excluded. */
const indexEntries = (root: string, scope: SourceSafetyScope) =>
  Effect.gen(function* () {
    if (scope === "index")
      // Each entry is `<mode> <object id> <stage>\t<path>`.
      return utf8
        .decode(yield* git(root, ["ls-files", "--stage", "-z"]))
        .split("\0")
        .flatMap((entry) => {
          const match = entry.match(/^(\d{6}) ([0-9a-f]+) \d\t(.+)$/su);

          return match === null ? [] : [{ mode: match[1], objectId: match[2], path: match[3] }];
        });

    const head = yield* runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);

    // Each entry is `:<old mode> <new mode> <old id> <new id> <status>\0<path>\0`; deletions are gone.
    const fields = utf8
      .decode(
        yield* git(root, [
          "diff-index",
          "--cached",
          "--no-renames",
          "--diff-filter=d",
          "-z",
          head.status === 0 ? "HEAD" : emptyTree,
        ]),
      )
      .split("\0");

    return yield* Effect.forEach(
      Array.from({ length: Math.floor(fields.length / 2) }, (_, index) => index),
      (index) => {
        const header = fields[index * 2] ?? "";
        const match = /^:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]+) [A-Z]\d*$/u.exec(header);

        return match === null
          ? Effect.fail(
              new SourceSafetyGitError({
                message: "git diff-index returned an invalid entry: " + header,
              }),
            )
          : Effect.succeed({ mode: match[1], objectId: match[2], path: fields[index * 2 + 1] });
      },
    );
  });

const scan = (root: string, scope: SourceSafetyScope = "index") =>
  Effect.gen(function* () {
    const findings: SourceSafetyFinding[] = [];
    const textual: { readonly path: string; readonly objectId: string }[] = [];
    let files = 0;

    // Submodules (mode 160000) have no blob.
    for (const { mode, objectId = "", path = "" } of yield* indexEntries(root, scope)) {
      if (mode === "160000" || path === "") continue;
      files += 1;

      if (sourcePathSafetyReason(path) !== null) findings.push({ path, reason: "UNSAFE_SOURCE" });
      else if (isTextualSourcePath(path)) textual.push({ path, objectId });
    }

    const blobs = yield* git(
      root,
      ["cat-file", "--batch"],
      textual.map(({ objectId }) => objectId).join("\n"),
    );

    // `--batch` answers each object ID with `<id> <type> <size>\n<content>\n`, in input order.
    let offset = 0;

    for (const { path } of textual) {
      const headerEnd = blobs.indexOf(0x0a, offset);
      const size = Number(utf8.decode(blobs.subarray(offset, headerEnd)).split(" ")[2]);

      if (!Number.isSafeInteger(size))
        return yield* new SourceSafetyGitError({
          message: `git cat-file returned no blob for ${path}`,
        });

      const reason = sourceTextSafetyReason(
        path,
        blobs.subarray(headerEnd + 1, headerEnd + 1 + size),
      );

      if (reason !== null) findings.push({ path, reason });
      offset = headerEnd + 1 + size + 1;
    }

    return { files, findings } satisfies SourceSafetyScan;
  });

/** Returns the findings for every path and textual blob in the scope of the index at `root`. */
export const scanIndex: {
  (
    scope?: SourceSafetyScope,
  ): (
    root: string,
  ) => Effect.Effect<
    SourceSafetyScan,
    SourceSafetyGitError,
    ChildProcessSpawner.ChildProcessSpawner
  >;
  (
    root: string,
    scope?: SourceSafetyScope,
  ): Effect.Effect<SourceSafetyScan, SourceSafetyGitError, ChildProcessSpawner.ChildProcessSpawner>;
} = dual((args) => args.length === 2 || (args.length === 1 && !isScope(args[0])), scan);

/** The platform of the scan: the Bun services that this composition root provides. */
export const SourceSafetyPlatform = BunServices.layer;

/** The services of `SourceSafetyPlatform`. */
export type SourceSafetyPlatform = BunServices.BunServices;

const REASON_TEXT: Record<SourceSafetyReason, string> = {
  INVALID_UTF8: "textual file is not valid UTF-8",
  UNSAFE_SOURCE:
    "path or content looks like a credential, personal data, or database material; remove it, or record a reviewed exception in tools/source-safety/src/source-safety.ts",
};

const main = Effect.gen(function* () {
  const options = process.argv.slice(2);

  if (options.some((option) => option !== "--changed")) {
    yield* Console.error(
      "Usage: just source-safety [--changed]\n--changed checks only the index entries that differ from HEAD.",
    );

    return 2;
  }

  const scope: SourceSafetyScope = options.includes("--changed") ? "changed" : "index";
  const root = utf8.decode(yield* git(process.cwd(), ["rev-parse", "--show-toplevel"])).trim();
  const { files, findings } = yield* scanIndex(root, scope);

  for (const { path, reason } of findings) yield* Console.error(`${path}: ${REASON_TEXT[reason]}`);

  yield* Console.log(
    `source-safety: ${files} ${scope === "index" ? "indexed" : "changed"} files, ${findings.length} unsafe${findings.length === 0 ? "" : " (see above)"}`,
  );

  return findings.length === 0 ? 0 : 1;
});

if (import.meta.main)
  BunRuntime.runMain(main.pipe(Effect.provide(SourceSafetyPlatform)), {
    teardown: (exit, onExit) => {
      if (Exit.isSuccess(exit) && Predicate.isNumber(exit.value)) onExit(exit.value);
      else Runtime.defaultTeardown(exit, onExit);
    },
  });

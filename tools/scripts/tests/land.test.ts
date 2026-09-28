import { describe, expect, test } from "bun:test";
import process from "node:process";
import { Data, Effect, FileSystem, Path, Scope } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess } from "effect/unstable/process";
import { type CommandResult, runCommand } from "../command.js";
import { ScriptsPlatform } from "../measure-job.js";

// Each test lands a branch in its own repository: a main checkout and a linked worktree of the
// branch `feature`. Git must not see the variables of a hook that runs the tests, nor the user's
// configuration.

const land = `${import.meta.dir}/../land.ts`;

const identity = { name: "Land Test", email: "land@example.invalid" };

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: identity.name,
  GIT_AUTHOR_EMAIL: identity.email,
  GIT_COMMITTER_NAME: identity.name,
  GIT_COMMITTER_EMAIL: identity.email,
};

class GitFailure extends Data.TaggedError("GitFailure")<{ readonly message: string }> {}

const git = Effect.fnUntraced(function* (cwd: string, ...gitArguments: Array<string>) {
  const result = yield* runCommand(
    ChildProcess.make("git", gitArguments, { cwd, env, extendEnv: false, stdin: "ignore" }),
  );

  if (result.status !== 0)
    return yield* new GitFailure({ message: `git ${gitArguments.join(" ")}: ${result.stderr}` });

  return result.stdout.trim();
});

const write = Effect.fnUntraced(function* (file: string, text: string) {
  const fileSystem = yield* FileSystem.FileSystem;

  yield* fileSystem.writeFileString(file, text);
});

const exists = Effect.fnUntraced(function* (file: string) {
  const fileSystem = yield* FileSystem.FileSystem;

  return yield* fileSystem.exists(file);
});

const commit = Effect.fnUntraced(function* (cwd: string, file: string, text: string) {
  yield* write(`${cwd}/${file}`, text);
  yield* git(cwd, "add", file);
  yield* git(cwd, "commit", "--quiet", "--message", `change ${file}`);
});

// The repository is removed when the test's scope closes.
const repository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ directory: "/tmp", prefix: "land-test-" });
  const main = path.join(root, "main");
  const feature = path.join(root, "feature");

  yield* git(root, "init", "--quiet", "--initial-branch=main", main);
  yield* commit(main, "base.txt", "base\n");
  yield* git(main, "worktree", "add", "--quiet", "-b", "feature", feature);
  yield* commit(feature, "feature.txt", "feature\n");

  return { root, main, feature };
});

const runLand = (
  cwd: string,
  branch: string,
): Effect.Effect<CommandResult, PlatformError, ScriptsPlatform> =>
  runCommand(
    ChildProcess.make(process.execPath, ["--no-env-file", land, branch], {
      cwd,
      env,
      extendEnv: false,
      stdin: "ignore",
    }),
  );

const run = <A, E>(effect: Effect.Effect<A, E, ScriptsPlatform | Scope.Scope>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(ScriptsPlatform)));

describe("just land", () => {
  test("records a merge commit even when main can fast-forward", () =>
    run(
      Effect.gen(function* () {
        const { main, feature } = yield* repository;
        const parents = [yield* git(main, "rev-parse", "HEAD"), yield* git(feature, "rev-parse", "HEAD")];
        const result = yield* runLand(main, "feature");

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("merge commit");
        expect(
          (yield* git(main, "rev-list", "--parents", "--max-count=1", "main")).split(" ").slice(1),
        ).toEqual(parents);
        expect(yield* exists(feature)).toBe(false);
        expect(yield* git(main, "branch", "--list", "feature")).toBe("");
      }),
    ));

  test("a failing pre-merge-commit hook blocks a fast-forwardable branch", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { main, feature } = yield* repository;
        const before = yield* git(main, "rev-parse", "HEAD");
        const hook = `${main}/.git/hooks/pre-merge-commit`;

        yield* write(hook, "#!/bin/sh\nexit 1\n");
        yield* fileSystem.chmod(hook, 0o755);

        const result = yield* runLand(main, "feature");

        expect(result.status).toBe(1);
        expect(yield* git(main, "rev-parse", "HEAD")).toBe(before);
        expect(yield* exists(feature)).toBe(true);
      }),
    ));

  test("records a merge commit when main has moved on", () =>
    run(
      Effect.gen(function* () {
        const { main, feature } = yield* repository;

        yield* commit(main, "main.txt", "main\n");

        const parents = [yield* git(main, "rev-parse", "HEAD"), yield* git(feature, "rev-parse", "HEAD")];
        const result = yield* runLand(main, "feature");

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("merge commit");
        expect(
          (yield* git(main, "rev-list", "--parents", "--max-count=1", "main")).split(" ").slice(1),
        ).toEqual(parents);
        expect(yield* exists(feature)).toBe(false);
      }),
    ));

  test("refuses a branch whose worktree has an untracked file and changes nothing", () =>
    run(
      Effect.gen(function* () {
        const { main, feature } = yield* repository;
        const before = yield* git(main, "rev-parse", "main");

        yield* write(`${feature}/notes.txt`, "unfinished\n");

        const result = yield* runLand(main, "feature");

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("notes.txt");
        expect(yield* git(main, "rev-parse", "main")).toBe(before);
        expect(yield* exists(`${feature}/notes.txt`)).toBe(true);
        expect(yield* git(main, "branch", "--list", "feature")).not.toBe("");
      }),
    ));

  test("refuses a branch that contains the commits of another unlanded branch", () =>
    run(
      Effect.gen(function* () {
        const { root, main } = yield* repository;
        const stacked = `${root}/stacked`;
        const before = yield* git(main, "rev-parse", "main");

        yield* git(main, "worktree", "add", "--quiet", "-b", "stacked", stacked, "feature");
        yield* commit(stacked, "stacked.txt", "stacked\n");

        const result = yield* runLand(main, "stacked");

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("stacked is based on feature");
        expect(yield* git(main, "rev-parse", "main")).toBe(before);
        expect(yield* exists(stacked)).toBe(true);
      }),
    ));

  test("aborts a merge that stops on a conflict and leaves main unchanged", () =>
    run(
      Effect.gen(function* () {
        const { main, feature } = yield* repository;

        yield* commit(main, "feature.txt", "main's version\n");

        const before = yield* git(main, "rev-parse", "main");
        const result = yield* runLand(main, "feature");

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("was aborted");
        expect(yield* git(main, "rev-parse", "main")).toBe(before);
        expect(yield* git(main, "status", "--porcelain")).toBe("");
        expect(yield* exists(feature)).toBe(true);
      }),
    ));
});

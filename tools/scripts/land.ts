import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import process from "node:process";
import { Console, Data, Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { runCommand } from "./command.js";
import { exitWithReturnedCode } from "./exit-code.js";

const usage = `Usage:
  just land <branch>

Lands a local branch on main. Run it in the main checkout, the checkout that has
main checked out. It refuses when:
- main or the branch's worktree has changes or untracked files,
- the branch shares no history with main,
- the branch contains commits of another local branch that main does not contain.
Every landing records a merge commit (--no-ff), even when main is an ancestor.
The pre-merge-commit hook checks the full merged tree. A merge that stops, for
example on a conflict or a failed hook, is aborted, and main is unchanged.
Then it removes the branch's worktree, deletes the branch, and prints the landed
commit. It does not push.
`;


/** A refusal or a failed step; the program prints it and exits 1. */
class LandFailure extends Data.TaggedError("LandFailure")<{ readonly message: string }> {}

const fail = (message: string) => Effect.fail(new LandFailure({ message }));

const git = (...gitArguments: Array<string>) =>
  runCommand(ChildProcess.make("git", gitArguments, { stdin: "ignore" }));

const read = (...gitArguments: Array<string>) =>
  Effect.flatMap(git(...gitArguments), (result) =>
    result.status === 0
      ? Effect.succeed(result.stdout.trim())
      : fail(`git ${gitArguments.join(" ")} failed: ${result.stderr.trim()}`),
  );

const isAncestor = (ancestor: string, descendant: string) =>
  Effect.flatMap(git("merge-base", "--is-ancestor", ancestor, descendant), ({ status }) =>
    status === 0 || status === 1
      ? Effect.succeed(status === 0)
      : fail(`git merge-base --is-ancestor exited with ${status}.`),
  );

const land = Effect.gen(function* () {
  const options = process.argv.slice(2);

  if (options.includes("--help") || options.includes("-h")) {
    yield* Console.log(usage.trimEnd());

    return 0;
  }

  const [branch] = options;

  if (branch === undefined || options.length !== 1) return yield* fail("Pass one branch. Use --help.");

  if (branch === "main") return yield* fail("main cannot land on itself.");

  const current = (yield* git("symbolic-ref", "--quiet", "--short", "HEAD")).stdout.trim();

  if (current !== "main")
    return yield* fail(
      `Run just land in the main checkout. This checkout has ${current === "" ? "a detached HEAD" : current}.`,
    );

  if ((yield* git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).status !== 0)
    return yield* fail(`${branch} is not a local branch.`);

  const mainChanges = yield* read("status", "--porcelain");

  if (mainChanges !== "")
    return yield* fail(`main has changes. Commit or remove them first:\n${mainChanges}`);

  // `git worktree list --porcelain` separates worktrees by a blank line.
  const worktree = (yield* read("worktree", "list", "--porcelain"))
    .split("\n\n")
    .map((entry) => entry.split("\n"))
    .find((lines) => lines.includes(`branch refs/heads/${branch}`))
    ?.find((line) => line.startsWith("worktree "))
    ?.slice("worktree ".length);

  if (worktree !== undefined) {
    const changes = yield* read("-C", worktree, "status", "--porcelain");

    if (changes !== "")
      return yield* fail(
        `The worktree ${worktree} of ${branch} has changes. Commit or remove them first:\n${changes}`,
      );
  }

  if ((yield* git("merge-base", "main", branch)).status !== 0)
    return yield* fail(`${branch} shares no history with main.`);

  const tip = yield* read("rev-parse", branch);

  // A branch that contains the unlanded commits of another branch would land them as well.
  const others = (yield* read("for-each-ref", "--format=%(refname:short)", "refs/heads"))
    .split("\n")
    .filter((other) => other !== "" && other !== branch && other !== "main");

  const bases = yield* Effect.filter(others, (other) =>
    Effect.gen(function* () {
      const otherTip = yield* read("rev-parse", other);

      return (
        otherTip !== tip &&
        (yield* isAncestor(otherTip, tip)) &&
        !(yield* isAncestor(otherTip, "main"))
      );
    }),
  );

  if (bases.length > 0)
    return yield* fail(
      `${branch} is based on ${bases.join(", ")}, which main does not contain. ` +
        `Land ${bases.length === 1 ? "it" : "them"} first, or rebase ${branch} onto main.`,
    );

  const before = yield* read("rev-parse", "--short", "main");

  let how: string;

  if (yield* isAncestor(tip, "main")) how = "main already contained it";
  else {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const merged = yield* spawner.exitCode(
      ChildProcess.make("git", ["merge", "--no-ff", "--no-edit", branch], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }),
    );

    if (merged !== 0) {
      if ((yield* git("rev-parse", "--verify", "--quiet", "MERGE_HEAD")).status === 0)
        yield* read("merge", "--abort");

      return yield* fail(
        `The merge of ${branch} stopped and was aborted. main is unchanged at ${before}.`,
      );
    }

    how = "merge commit";
  }

  const landed = yield* read("log", "-1", "--format=%h %s", "main");

  yield* Console.log(`land: main is at ${landed} (${how}; it was at ${before}).`);

  if (worktree !== undefined) {
    const removal = yield* git("worktree", "remove", worktree);

    if (removal.status !== 0)
      return yield* fail(
        `${branch} landed, but its worktree ${worktree} was not removed: ${removal.stderr.trim()}`,
      );

    yield* Console.log(`land: removed the worktree ${worktree}.`);
  }

  yield* read("branch", "--delete", branch);

  yield* Console.log(`land: deleted ${branch}. Nothing was pushed.`);

  return 0;
});

const program = land.pipe(
  Effect.catchTag("LandFailure", ({ message }) =>
    Console.error(`land: ${message}`).pipe(Effect.as(1)),
  ),
);

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)), exitWithReturnedCode);

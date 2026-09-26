import { spawnSync } from "node:child_process";

const usage = `Usage:
  just land <branch>

Lands a local branch on main. Run it in the main checkout, the checkout that has
main checked out. It refuses when:
- main or the branch's worktree has changes or untracked files,
- the branch shares no history with main,
- the branch contains commits of another local branch that main does not contain.
If main is an ancestor of the branch, main fast-forwards to it. Otherwise Git
records a merge commit (--no-ff), and the merge hooks run. A merge that stops,
for example on a conflict or a failed hook, is aborted, and main is unchanged.
Then it removes the branch's worktree, deletes the branch, and prints the landed
commit. It does not push.
`;

// A function declaration lets calls narrow control flow as `never`.
function fail(message: string): never {
  process.stderr.write(`land: ${message}\n`);
  process.exit(1);
}

const git = (...gitArguments: Array<string>) => spawnSync("git", gitArguments, { encoding: "utf8" });

const read = (...gitArguments: Array<string>) => {
  const result = git(...gitArguments);

  return result.status === 0
    ? result.stdout.trim()
    : fail(`git ${gitArguments.join(" ")} failed: ${result.stderr.trim()}`);
};

const isAncestor = (ancestor: string, descendant: string) => {
  const { status } = git("merge-base", "--is-ancestor", ancestor, descendant);

  if (status !== 0 && status !== 1) fail(`git merge-base --is-ancestor exited with ${status}.`);

  return status === 0;
};

const options = process.argv.slice(2);

if (options.includes("--help") || options.includes("-h")) {
  process.stdout.write(usage);
  process.exit(0);
}

const [branch] = options;

if (branch === undefined || options.length !== 1) fail("Pass one branch. Use --help.");

if (branch === "main") fail("main cannot land on itself.");

const current = git("symbolic-ref", "--quiet", "--short", "HEAD").stdout.trim();

if (current !== "main")
  fail(`Run just land in the main checkout. This checkout has ${current || "a detached HEAD"}.`);

if (git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).status !== 0)
  fail(`${branch} is not a local branch.`);

const mainChanges = read("status", "--porcelain");

if (mainChanges !== "") fail(`main has changes. Commit or remove them first:\n${mainChanges}`);

// `git worktree list --porcelain` separates worktrees by a blank line.
const worktree = read("worktree", "list", "--porcelain")
  .split("\n\n")
  .map((entry) => entry.split("\n"))
  .find((lines) => lines.includes(`branch refs/heads/${branch}`))
  ?.find((line) => line.startsWith("worktree "))
  ?.slice("worktree ".length);

if (worktree !== undefined) {
  const changes = read("-C", worktree, "status", "--porcelain");

  if (changes !== "")
    fail(`The worktree ${worktree} of ${branch} has changes. Commit or remove them first:\n${changes}`);
}

if (git("merge-base", "main", branch).status !== 0) fail(`${branch} shares no history with main.`);

const tip = read("rev-parse", branch);

// A branch that contains the unlanded commits of another branch would land them as well.
const bases = read("for-each-ref", "--format=%(refname:short)", "refs/heads")
  .split("\n")
  .filter((other) => other !== "" && other !== branch && other !== "main")
  .filter((other) => {
    const otherTip = read("rev-parse", other);

    return otherTip !== tip && isAncestor(otherTip, tip) && !isAncestor(otherTip, "main");
  });

if (bases.length > 0)
  fail(
    `${branch} is based on ${bases.join(", ")}, which main does not contain. ` +
      `Land ${bases.length === 1 ? "it" : "them"} first, or rebase ${branch} onto main.`,
  );

const before = read("rev-parse", "--short", "main");

let how: string;

if (isAncestor(tip, "main")) how = "main already contained it";
else if (isAncestor("main", tip)) {
  if (spawnSync("git", ["merge", "--ff-only", branch], { stdio: "inherit" }).status !== 0)
    fail(`The fast-forward to ${branch} failed. main is unchanged.`);

  how = "fast-forward";
} else {
  if (spawnSync("git", ["merge", "--no-ff", "--no-edit", branch], { stdio: "inherit" }).status !== 0) {
    if (git("rev-parse", "--verify", "--quiet", "MERGE_HEAD").status === 0) read("merge", "--abort");

    fail(`The merge of ${branch} stopped and was aborted. main is unchanged at ${before}.`);
  }

  how = "merge commit";
}

const landed = read("log", "-1", "--format=%h %s", "main");

process.stdout.write(`land: main is at ${landed} (${how}; it was at ${before}).\n`);

if (worktree !== undefined) {
  const removal = git("worktree", "remove", worktree);

  if (removal.status !== 0)
    fail(`${branch} landed, but its worktree ${worktree} was not removed: ${removal.stderr.trim()}`);

  process.stdout.write(`land: removed the worktree ${worktree}.\n`);
}

read("branch", "--delete", branch);

process.stdout.write(`land: deleted ${branch}. Nothing was pushed.\n`);

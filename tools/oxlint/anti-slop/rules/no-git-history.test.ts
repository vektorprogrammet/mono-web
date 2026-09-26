// Run with `node --test`: the Oxlint RuleTester parses through raw transfer, which Bun lacks.
import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noGitHistoryRule } from "./no-git-history.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const gitHistory = (read: string) => [{ messageId: "gitHistory", data: { read } }];

new RuleTester().run("no-git-history", noGitHistoryRule, {
  valid: [
    // Negative controls: HEAD, its tree and commit peels, the index, and the working tree, which
    // a depth-1 checkout holds.
    'run("git", ["rev-parse", "HEAD"])',
    'spawnSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" })',
    'execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"])',
    'command("git", ["status", "--porcelain"])',
    'runLocal(["git", "archive", "--format=tar.gz", `--output=${archive}`, "HEAD"])',
    'runLocal(["git", "cat-file", "-e", `HEAD:${path}`])',
    'runLocal(["git", "diff", "--quiet", "HEAD", "--"])',
    'git(root, "ls-files", "-z", "--", "apps/backend")',
    'readGitValue(["rev-parse", "HEAD"], environment, observations, effects)',
    'ChildProcess.make("git", ["-c", "user.name=Probe", "-C", root, "commit", "-m", "probe"])',
    'execSync("git rev-parse HEAD")',
    "$`git status --porcelain`",
    // "log" and a range outside a Git argument list.
    'const levels = ["log", "warn"]',
    'digits("merge-base", "main..HEAD")',
    'join(root, "../fixtures")',
    // A pathspec after `--` that reads like a range.
    'runLocal(["git", "ls-files", "--", "docs..md"])',
  ],
  invalid: [
    // The CI failure: the organization import rehearsal asked for the merge base of a fixed commit.
    {
      code: 'readGitValue(["merge-base", "HEAD", SPEC_0067.frozenCodeBaseHead], environment, observations, effects)',
      errors: gitHistory("merge-base"),
    },
    {
      code: 'git("merge-base", "--is-ancestor", ancestor, descendant)',
      errors: gitHistory("merge-base"),
    },
    {
      code: 'spawnSync("git", ["log", "-1", "--format=%H"])',
      errors: gitHistory("log"),
    },
    {
      code: 'runLocal(["git", "rev-list", "--count", "HEAD"])',
      errors: gitHistory("rev-list"),
    },
    {
      code: 'execFileSync("git", ["-C", root, "describe", "--tags"])',
      errors: gitHistory("describe"),
    },
    {
      code: 'run("git", ["rev-parse", "HEAD~1"])',
      errors: gitHistory("rev-parse HEAD~1"),
    },
    {
      code: 'run("git", ["show", "HEAD^:package.json"])',
      errors: gitHistory("show HEAD^:package.json"),
    },
    {
      code: 'run("git", ["diff", "--name-only", "main...HEAD"])',
      errors: gitHistory("diff main...HEAD"),
    },
    {
      code: 'run("git", ["cat-file", "-e", "5f9f4c7a6a7c3cb54104d21756311d53d6cc1d48"])',
      errors: gitHistory("cat-file 5f9f4c7a6a7c3cb54104d21756311d53d6cc1d48"),
    },
    {
      code: 'execSync("git log --oneline -5")',
      errors: gitHistory("log"),
    },
    {
      code: "execSync(`git -C ${root} merge-base HEAD ${base}`)",
      errors: gitHistory("merge-base"),
    },
    {
      code: "$`git rev-parse @{1}`",
      errors: gitHistory("rev-parse @{1}"),
    },
    {
      code: 'Bun.spawn(["git", "reflog"])',
      errors: gitHistory("reflog"),
    },
  ],
});

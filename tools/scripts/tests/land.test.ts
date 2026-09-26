import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

// Each test lands a branch in its own repository: a main checkout and a linked worktree of the
// branch `feature`. Git must not see the variables of a hook that runs the tests, nor the user's
// configuration.

const land = join(import.meta.dir, "..", "land.ts");

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

const roots: Array<string> = [];

const git = (cwd: string, ...gitArguments: Array<string>) => {
  const result = spawnSync("git", gitArguments, { cwd, env, encoding: "utf8" });

  if (result.status !== 0) throw new Error(`git ${gitArguments.join(" ")}: ${result.stderr}`);

  return result.stdout.trim();
};

const commit = (cwd: string, file: string, text: string) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "--quiet", "--message", `change ${file}`);
};

const repository = () => {
  const root = mkdtempSync("/tmp/land-test-");
  const main = join(root, "main");
  const feature = join(root, "feature");

  roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=main", main);
  commit(main, "base.txt", "base\n");
  git(main, "worktree", "add", "--quiet", "-b", "feature", feature);
  commit(feature, "feature.txt", "feature\n");

  return { root, main, feature };
};

const runLand = (cwd: string, branch: string) =>
  spawnSync(process.execPath, ["--no-env-file", land, branch], { cwd, env, encoding: "utf8" });

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("just land", () => {
  test("fast-forwards main, removes the worktree, and deletes the branch", () => {
    const { main, feature } = repository();
    const tip = git(feature, "rev-parse", "HEAD");
    const result = runLand(main, "feature");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("fast-forward");
    expect(git(main, "rev-parse", "main")).toBe(tip);
    expect(existsSync(feature)).toBe(false);
    expect(git(main, "branch", "--list", "feature")).toBe("");
  });

  test("records a merge commit when main has moved on", () => {
    const { main, feature } = repository();

    commit(main, "main.txt", "main\n");

    const parents = [git(main, "rev-parse", "HEAD"), git(feature, "rev-parse", "HEAD")];
    const result = runLand(main, "feature");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("merge commit");
    expect(git(main, "rev-list", "--parents", "--max-count=1", "main").split(" ").slice(1)).toEqual(
      parents,
    );
    expect(existsSync(feature)).toBe(false);
  });

  test("refuses a branch whose worktree has an untracked file and changes nothing", () => {
    const { main, feature } = repository();
    const before = git(main, "rev-parse", "main");

    writeFileSync(join(feature, "notes.txt"), "unfinished\n");

    const result = runLand(main, "feature");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("notes.txt");
    expect(git(main, "rev-parse", "main")).toBe(before);
    expect(existsSync(join(feature, "notes.txt"))).toBe(true);
    expect(git(main, "branch", "--list", "feature")).not.toBe("");
  });

  test("refuses a branch that contains the commits of another unlanded branch", () => {
    const { root, main } = repository();
    const stacked = join(root, "stacked");
    const before = git(main, "rev-parse", "main");

    git(main, "worktree", "add", "--quiet", "-b", "stacked", stacked, "feature");
    commit(stacked, "stacked.txt", "stacked\n");

    const result = runLand(main, "stacked");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stacked is based on feature");
    expect(git(main, "rev-parse", "main")).toBe(before);
    expect(existsSync(stacked)).toBe(true);
  });

  test("aborts a merge that stops on a conflict and leaves main unchanged", () => {
    const { main, feature } = repository();

    commit(main, "feature.txt", "main's version\n");

    const before = git(main, "rev-parse", "main");
    const result = runLand(main, "feature");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("was aborted");
    expect(git(main, "rev-parse", "main")).toBe(before);
    expect(git(main, "status", "--porcelain")).toBe("");
    expect(existsSync(feature)).toBe(true);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { heavyLockVariable } from "../heavy-lock.js";

// Each test checks the staged tree of its own workspace repository, with the packages `app` and
// `lib` and the Turbo version of this repository's install. Git must not see the variables of a
// hook that runs the tests, nor the user's configuration. The heavy lock, the hook slots, and the
// caches of check-staged live in the test's own directory.

const checkStaged = join(import.meta.dir, "..", "check-staged.ts");

const turboManifest = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "node_modules",
  "turbo",
  "package.json",
);

const turboVersion: string = (await Bun.file(turboManifest).json()).version;

const roots: Array<string> = [];

const environment = (root: string) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("GIT_") && name !== heavyLockVariable,
    ),
  ),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Check Staged Test",
  GIT_AUTHOR_EMAIL: "check-staged@example.invalid",
  GIT_COMMITTER_NAME: "Check Staged Test",
  GIT_COMMITTER_EMAIL: "check-staged@example.invalid",
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_RUNTIME_DIR: join(root, "runtime"),
  XDG_STATE_HOME: join(root, "state"),
  TURBO_TELEMETRY_DISABLED: "1",
});

const run = (repo: string, command: string, commandArguments: Array<string>) => {
  const result = spawnSync(command, commandArguments, {
    cwd: repo,
    env: environment(dirname(repo)),
    encoding: "utf8",
  });

  if (result.status !== 0)
    throw new Error(`${command} ${commandArguments.join(" ")}: ${result.stderr}${result.stdout}`);
};

// A committed and installed workspace whose `app` does not depend on `lib`.
const repository = () => {
  const root = mkdtempSync("/tmp/check-staged-test-");
  const repo = join(root, "repo");

  roots.push(root);
  mkdirSync(join(repo, "packages", "app"), { recursive: true });
  mkdirSync(join(repo, "packages", "lib"));
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      name: "fixture",
      private: true,
      workspaces: ["packages/*"],
      packageManager: `bun@${Bun.version}`,
      devDependencies: { turbo: turboVersion },
    }),
  );
  writeFileSync(join(repo, "turbo.json"), JSON.stringify({ tasks: { "check-types": {}, test: {} } }));
  writeFileSync(join(repo, ".gitignore"), "node_modules\n.turbo\n");
  writeFileSync(
    join(repo, "packages", "lib", "package.json"),
    JSON.stringify({
      name: "@fixture/lib",
      private: true,
      type: "module",
      exports: "./index.ts",
    }),
  );
  writeFileSync(join(repo, "packages", "lib", "index.ts"), "export const value = 42;\n");
  writeFileSync(
    join(repo, "packages", "app", "package.json"),
    JSON.stringify({
      name: "@fixture/app",
      private: true,
      type: "module",
      scripts: { test: "bun app.ts" },
    }),
  );
  writeFileSync(join(repo, "packages", "app", "app.ts"), "console.log('app');\n");
  run(repo, "git", ["init", "--quiet", "--initial-branch=main"]);
  run(repo, process.execPath, ["install"]);
  run(repo, "git", ["add", "--all"]);
  run(repo, "git", ["commit", "--quiet", "--message", "fixture"]);

  return repo;
};

// Stages a dependency of `app` on `lib` in the manifest and the lockfile, not in node_modules.
const stageDependency = (repo: string) => {
  writeFileSync(
    join(repo, "packages", "app", "package.json"),
    JSON.stringify({
      name: "@fixture/app",
      private: true,
      type: "module",
      dependencies: { "@fixture/lib": "workspace:*" },
      scripts: { test: "bun app.ts" },
    }),
  );
  writeFileSync(
    join(repo, "packages", "app", "app.ts"),
    "import { value } from '@fixture/lib';\n\nif (value !== 42) process.exit(1);\n",
  );
  run(repo, process.execPath, ["install", "--lockfile-only"]);
  run(repo, "git", ["add", "--all"]);
};

const runCheckStaged = (repo: string) =>
  spawnSync(process.execPath, ["--no-env-file", checkStaged, "--class", "check-staged-test"], {
    cwd: repo,
    env: environment(dirname(repo)),
    encoding: "utf8",
  });

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("just check-staged", () => {
  test(
    "installs a dependency that the staged lockfile adds and the checkout has not installed",
    () => {
      const repo = repository();

      stageDependency(repo);

      expect(existsSync(join(repo, "packages", "app", "node_modules", "@fixture", "lib"))).toBe(
        false,
      );

      const installing = runCheckStaged(repo);

      expect(`${installing.stderr}${installing.stdout}`).not.toContain("Cannot find");
      expect(installing.stderr).toContain("installing the staged lockfile");
      expect(installing.stderr).toContain("1 tasks for staged tree");
      expect(installing.status).toBe(0);

      // A second run of the same install inputs reuses the install.
      const reusing = runCheckStaged(repo);

      expect(reusing.stderr).not.toContain("installing the staged lockfile");
      expect(reusing.status).toBe(0);
    },
    120_000,
  );

  // A merge whose lockfile equals HEAD's, in a checkout that did not install HEAD's lockfile.
  test(
    "installs a committed dependency that the checkout has not installed",
    () => {
      const repo = repository();

      stageDependency(repo);
      run(repo, "git", ["commit", "--quiet", "--message", "depend on lib"]);
      writeFileSync(
        join(repo, "packages", "app", "app.ts"),
        "import { value } from '@fixture/lib';\n\nif (value !== 42) process.exit(2);\n",
      );
      run(repo, "git", ["add", "--all"]);

      const result = runCheckStaged(repo);

      expect(`${result.stderr}${result.stdout}`).not.toContain("Cannot find");
      expect(result.stderr).toContain("1 tasks for staged tree");
      expect(result.status).toBe(0);
    },
    120_000,
  );

  test(
    "refuses a Bun that differs from the staged packageManager and names devenv shell",
    async () => {
      const repo = repository();
      const manifest = join(repo, "package.json");

      writeFileSync(
        manifest,
        JSON.stringify({ ...(await Bun.file(manifest).json()), packageManager: "bun@0.0.1" }),
      );
      run(repo, "git", ["add", "--all"]);

      const result = runCheckStaged(repo);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("bun@0.0.1");
      expect(result.stderr).toContain("devenv shell");
    },
    120_000,
  );
});

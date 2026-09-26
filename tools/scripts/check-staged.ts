import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";

const usage = `Usage:
  just check-staged --class <job-class> [--dependents]

Runs \`turbo run check-types test\` for the packages that the staged tree
changes compared with HEAD. With --dependents, it also runs them for the
packages that depend on those. For a merge, the staged tree is the merge
result. The tree is checked out in a temporary Git worktree, so unstaged and
untracked files do not change the result. The worktree uses the installed
node_modules and the Turbo cache of this worktree. The tasks run through
hook-slot with the job class. A change that selects no task does not wait for a
hook slot. The pre-commit hook runs this command; the pre-merge-commit hook
runs it with --dependents.
`;

// A function declaration lets calls narrow control flow as `never`.
function fail(message: string): never {
  process.stderr.write(`check-staged: ${message}\n`);
  process.exit(2);
}

const options = process.argv.slice(2);

let jobClass: string | undefined;

let dependents = false;

for (let index = 0; index < options.length; index += 1) {
  const option = options[index];

  if (option === "--help" || option === "-h") {
    process.stdout.write(usage);
    process.exit(0);
  } else if (option === "--class") jobClass = options[++index] ?? fail("--class needs a value.");
  else if (option === "--dependents") dependents = true;
  else fail(`Unknown argument ${option}. Use --help.`);
}

if (jobClass === undefined) fail("Pass --class <job-class>. Use --help.");

const git = (gitArguments: Array<string>, env: NodeJS.ProcessEnv = process.env) => {
  const result = spawnSync("git", gitArguments, { encoding: "utf8", env });

  return result.status === 0
    ? result.stdout.trim()
    : fail(`git ${gitArguments.join(" ")} failed: ${result.stderr.trim()}`);
};

const root = git(["rev-parse", "--show-toplevel"]);

const store = join(root, "node_modules", ".bun");

if (!existsSync(store)) fail("Run bun install first.");

const head = git(["rev-parse", "--verify", "HEAD^{commit}"]);

// Git sets GIT_INDEX_FILE to the index that the commit records, also for
// `git commit -a` and `git commit <paths>`.
const tree = git(["write-tree"]);

if (tree === git(["rev-parse", "HEAD^{tree}"])) {
  process.stderr.write("check-staged: the staged tree equals HEAD. Nothing to check.\n");
  process.exit(0);
}

const snapshot = git(["commit-tree", "--no-gpg-sign", "-p", head, "-m", "check-staged", tree]);

// Commands for the snapshot must not use the index or directory of the hook.
const snapshotEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);

const snapshotParent = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "vektorprogrammet",
);

const directory = join(snapshotParent, `check-staged-${process.pid}`);

mkdirSync(snapshotParent, { recursive: true });

// A killed run leaves its worktree. Remove the worktrees of exited runs.
for (const name of readdirSync(snapshotParent)) {
  const pid = Number(/^check-staged-(\d+)$/.exec(name)?.[1]);

  if (!Number.isInteger(pid)) continue;

  try {
    if (pid !== process.pid) process.kill(pid, 0);
  } catch {
    rmSync(join(snapshotParent, name), { recursive: true, force: true });
  }
}

rmSync(directory, { recursive: true, force: true });

git(["-C", root, "worktree", "prune"], snapshotEnv);

git(
  [
    "-C",
    root,
    "-c",
    "core.hooksPath=/dev/null",
    "worktree",
    "add",
    "--detach",
    directory,
    snapshot,
  ],
  snapshotEnv,
);

// Workspace links in node_modules are relative. A copy of each link tree
// resolves them to the snapshot packages. The package store is shared.
const copyLinks = (source: string, target: string) => {
  mkdirSync(target, { recursive: true });

  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);

    if (entry.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else if (entry.isDirectory() && from !== store) copyLinks(from, to);
  }
};

copyLinks(join(root, "node_modules"), join(directory, "node_modules"));

symlinkSync(store, join(directory, "node_modules", ".bun"));

const { workspaces } = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ workspaces: Schema.Array(Schema.String) })),
)(readFileSync(join(directory, "package.json"), "utf8"));

for (const pattern of workspaces) {
  const packages = pattern.endsWith("/*")
    ? readdirSync(join(directory, pattern.slice(0, -2))).map((name) =>
        join(pattern.slice(0, -2), name),
      )
    : [pattern];

  for (const path of packages) {
    if (existsSync(join(root, path, "node_modules")))
      copyLinks(join(root, path, "node_modules"), join(directory, path, "node_modules"));
  }
}

// A failed removal leaves the worktree for the next run to remove.
const removeSnapshot = () => {
  spawnSync("git", ["-C", root, "worktree", "remove", "--force", directory], { env: snapshotEnv });
  rmSync(directory, { recursive: true, force: true });
};

const turboEnv = {
  ...snapshotEnv,
  TURBO_CACHE_DIR: process.env.TURBO_CACHE_DIR || join(root, ".turbo", "cache"),
};

// `[A...B]` selects the packages that change between the commits; a leading
// `...` adds their dependents.
const turboRun = [
  "x",
  "turbo",
  "run",
  "check-types",
  "test",
  `--filter=${dependents ? "..." : ""}[${head}...${snapshot}]`,
  "--concurrency=1",
  `--cwd=${directory}`,
];

// The dry run needs no hook slot, so a change that affects no task does not wait.
const dryRun = spawnSync(process.execPath, [...turboRun, "--dry=json"], {
  encoding: "utf8",
  env: turboEnv,
  maxBuffer: 2 ** 28,
});

if (dryRun.status !== 0) {
  removeSnapshot();
  fail(`turbo --dry=json failed: ${dryRun.stderr.trim()}`);
}

const affected = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({ tasks: Schema.Array(Schema.Struct({ command: Schema.String })) }),
  ),
)(dryRun.stdout).tasks.filter((task) => task.command !== "<NONEXISTENT>").length;

if (affected === 0) {
  removeSnapshot();
  process.stderr.write("check-staged: the staged change affects no type check or test.\n");
  process.exit(0);
}

process.stderr.write(`check-staged: ${affected} tasks for staged tree ${tree.slice(0, 12)}\n`);

const job = spawn(
  process.execPath,
  [
    "--no-env-file",
    join(import.meta.dir, "hook-slot.ts"),
    "--class",
    jobClass,
    "--",
    process.execPath,
    ...turboRun,
    "--ui=stream",
    "--output-logs=errors-only",
  ],
  { stdio: "inherit", env: turboEnv },
);

const signalHandlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(
  (signal) => [signal, () => job.kill(signal)] as const,
);

for (const [signal, handler] of signalHandlers) process.on(signal, handler);

job.once("error", (error) => fail(`hook-slot could not start: ${error.message}`));

job.once("exit", (exitCode, signal) => {
  removeSnapshot();

  for (const [name, handler] of signalHandlers) process.off(name, handler);

  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(exitCode ?? 1);
});

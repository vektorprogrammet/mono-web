import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Schema } from "effect";

const usage = `Usage:
  just check-staged --class <job-class> [--dependents]

Runs \`turbo run check-types test\` for the packages that the staged tree
changes compared with HEAD. With --dependents, it also runs them for the
packages that depend on those. For a merge, the staged tree is the merge
result. The tree is checked out in a temporary Git worktree, so unstaged and
untracked files do not change the result. Its node_modules link to a frozen
install of the staged lockfile and manifests, which a later run with the same
files reuses; what this worktree has installed does not matter. The Bun that
runs this command installs and runs the tasks, and it must be the one that
package.json pins: run it inside \`devenv shell\`. The tasks use the Turbo
cache of this worktree and run through hook-slot with the job class. A change
that selects no task does not wait for a hook slot. The pre-commit hook runs
this command; the pre-merge-commit hook runs it with --dependents.
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

const head = git(["rev-parse", "--verify", "HEAD^{commit}"]);

// Git sets GIT_INDEX_FILE to the index that the commit records, also for
// `git commit -a` and `git commit <paths>`.
const tree = git(["write-tree"]);

if (tree === git(["rev-parse", "HEAD^{tree}"])) {
  process.stderr.write("check-staged: the staged tree equals HEAD. Nothing to check.\n");
  process.exit(0);
}

const manifest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({ packageManager: Schema.String, workspaces: Schema.Array(Schema.String) }),
  ),
)(git(["cat-file", "blob", `${tree}:package.json`]));

// The install and the tasks run with this Bun. Another Bun links a lockfile differently.
if (manifest.packageManager !== `bun@${Bun.version}`)
  fail(
    `This is Bun ${Bun.version}, but the staged package.json pins ${manifest.packageManager}. ` +
      "Run the Git hooks and just recipes inside `devenv shell`, which provides the pinned Bun.",
  );

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

const installs = join(snapshotParent, "check-staged-installs");

mkdirSync(installs, { recursive: true });

// A killed run leaves its worktree or its unfinished install. Remove those of exited runs.
for (const [parent, pattern] of [
  [snapshotParent, /^check-staged-(\d+)$/],
  [installs, /^[\da-f]+-(\d+)$/],
] as const) {
  for (const name of readdirSync(parent)) {
    const pid = Number(pattern.exec(name)?.[1]);

    if (!Number.isInteger(pid)) continue;

    try {
      if (pid !== process.pid) process.kill(pid, 0);
    } catch {
      rmSync(join(parent, name), { recursive: true, force: true });
    }
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

// A failed removal leaves the worktree for the next run to remove.
const removeSnapshot = () => {
  spawnSync("git", ["-C", root, "worktree", "remove", "--force", directory], { env: snapshotEnv });
  rmSync(directory, { recursive: true, force: true });
};

// Bun installs node_modules from these files of the staged tree alone. An install of the same
// files is reused, whatever this worktree has installed.
const workspaceManifests = manifest.workspaces.map((pattern) => new Bun.Glob(`${pattern}/package.json`));

// `git ls-tree` prints `<mode> <type> <object>\t<path>`.
const inputs = git(["ls-tree", "-r", "-z", tree])
  .split("\0")
  .map((entry) => ({ entry, path: entry.slice(entry.indexOf("\t") + 1) }))
  .filter(
    ({ path }) =>
      ["package.json", "bun.lock", "bunfig.toml"].includes(path) ||
      path.startsWith("patches/") ||
      workspaceManifests.some((glob) => glob.match(path)),
  );

const install = join(
  installs,
  new Bun.CryptoHasher("sha256").update(inputs.map(({ entry }) => entry).join("\0")).digest("hex").slice(0, 32),
);

const installed = join(install, "installed");

if (existsSync(installed)) {
  const now = new Date();

  utimesSync(installed, now, now);
} else {
  process.stderr.write("check-staged: installing the staged lockfile.\n");

  const unfinished = `${install}-${process.pid}`;

  for (const { path } of inputs) {
    mkdirSync(dirname(join(unfinished, path)), { recursive: true });
    copyFileSync(join(directory, path), join(unfinished, path));
  }

  const result = spawnSync(process.execPath, ["install", "--frozen-lockfile"], {
    cwd: unfinished,
    encoding: "utf8",
    env: snapshotEnv,
    maxBuffer: 2 ** 28,
  });

  if (result.status !== 0) {
    rmSync(unfinished, { recursive: true, force: true });
    removeSnapshot();
    fail(`bun install --frozen-lockfile failed for the staged tree:\n${result.stderr}${result.stdout}`);
  }

  writeFileSync(join(unfinished, "installed"), "");

  // A concurrent run may have finished the same install first.
  try {
    renameSync(unfinished, install);
  } catch {
    rmSync(unfinished, { recursive: true, force: true });
  }

  // Keep the installs that a run used in the last day, which covers every running check.
  for (const name of readdirSync(installs)) {
    const marker = join(installs, name, "installed");

    if (existsSync(marker) && Date.now() - statSync(marker).mtimeMs > 24 * 60 * 60 * 1000)
      rmSync(join(installs, name), { recursive: true, force: true });
  }
}

const store = join(install, "node_modules", ".bun");

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

for (const { path } of inputs) {
  const modules = join(dirname(path), "node_modules");

  if (basename(path) === "package.json" && existsSync(join(install, modules)))
    copyLinks(join(install, modules), join(directory, modules));
}

symlinkSync(store, join(directory, "node_modules", ".bun"));

// Turbo and the tasks resolve `bun` on PATH, so this Bun comes first.
const turboEnv = {
  ...snapshotEnv,
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  TURBO_CACHE_DIR: process.env.TURBO_CACHE_DIR || join(root, ".turbo", "cache"),
};

// `bun x` runs the Turbo of the snapshot's install. `[A...B]` selects the packages
// that change between the commits; a leading `...` adds their dependents.
const turboRun = [
  "x",
  "turbo",
  "run",
  "check-types",
  "test",
  `--filter=${dependents ? "..." : ""}[${head}...${snapshot}]`,
  "--concurrency=1",
];

// The dry run needs no hook slot, so a change that affects no task does not wait.
const dryRun = spawnSync(process.execPath, [...turboRun, "--dry=json"], {
  cwd: directory,
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
  { cwd: directory, stdio: "inherit", env: turboEnv },
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

/**
 * The files that the layout check reads. The working tree view lists tracked and untracked files
 * that Git does not ignore. The staged view lists the Git index, which is the tree that a commit
 * records; the hook runner sets unstaged changes aside, so the files on disk hold the staged content.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, type Stats } from "node:fs";
import { join } from "node:path";

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

const git = (root: string, args: ReadonlyArray<string>): string => {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 2 ** 28,
  });

  if (result.error !== undefined) throw result.error;

  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);

  return result.stdout;
};

/** The root of the Git working tree that contains `directory`. */
export const repositoryRoot = (directory: string): string =>
  git(directory, ["rev-parse", "--show-toplevel"]).trim();

/** The staged view with `staged`, the working tree view otherwise. */
export const readRepository = (root: string, staged: boolean): Repository => {
  const listed = git(root, [
    "ls-files",
    "-z",
    "--cached",
    ...(staged ? [] : ["--others", "--exclude-standard"]),
  ]);

  const paths: Array<string> = [];
  const links = new Set<string>();

  for (const path of new Set(listed.split("\0"))) {
    if (path === "") continue;

    let stats: Stats | undefined;

    try {
      stats = lstatSync(join(root, path));
    } catch {
      stats = undefined;
    }

    // A tracked file that the working tree deleted is not part of the working tree view.
    if (stats === undefined && !staged) continue;

    paths.push(path);

    if (stats?.isSymbolicLink() === true) links.add(path);
  }

  return {
    root,
    paths: paths.sort(),
    links,
    read: (path) => readFileSync(join(root, path), "utf8"),
    readLink: (path) => readlinkSync(join(root, path)),
  };
};

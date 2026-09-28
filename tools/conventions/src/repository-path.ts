/**
 * POSIX path arithmetic on the repository-relative paths that the checks compare: forward
 * slashes, no drive, and inside the repository root. It touches no file system and reads no
 * working directory, so the checks stay plain functions of the repository view; the file system
 * itself is read only through the `FileSystem` and `Path` services of the command line entry.
 */

const segmentsOf = (path: string): ReadonlyArray<string> => {
  const segments: Array<string> = [];

  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;

    if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") segments.pop();
    else if (segment !== ".." || !path.startsWith("/")) segments.push(segment);
  }

  return segments;
};

/** The path with `.` and `..` segments resolved and repeated slashes collapsed, as `path.posix`. */
const normalize = (path: string): string => {
  if (path === "") return ".";

  const absolute = path.startsWith("/");
  const body = segmentsOf(path).join("/");
  const trailing = path.endsWith("/") && body !== "" ? "/" : "";

  if (absolute) return `/${body}${trailing}`;

  return body === "" ? "." : `${body}${trailing}`;
};

/** The segments joined by slashes and normalized; empty segments are skipped. */
const join = (...paths: ReadonlyArray<string>): string =>
  normalize(paths.filter((path) => path !== "").join("/"));

const withoutTrailingSlashes = (path: string): string => {
  let end = path.length;

  while (end > 1 && path[end - 1] === "/") end -= 1;

  return path.slice(0, end);
};

/** The directory part of a path, `.` for a bare name. */
const dirname = (path: string): string => {
  const trimmed = withoutTrailingSlashes(path);
  const slash = trimmed.lastIndexOf("/");

  if (slash === -1) return ".";

  return slash === 0 ? "/" : trimmed.slice(0, slash);
};

/** The last segment of a path. */
const basename = (path: string): string => {
  const trimmed = withoutTrailingSlashes(path);

  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
};

/** The relative path from one repository-relative path to another; empty when they are equal. */
const relative = (from: string, to: string): string => {
  const source = segmentsOf(from);
  const target = segmentsOf(to);
  let shared = 0;

  while (shared < source.length && shared < target.length && source[shared] === target[shared])
    shared += 1;

  return [...source.slice(shared).map(() => ".."), ...target.slice(shared)].join("/");
};

/** The POSIX path functions of the checks, over repository-relative paths. */
export const repositoryPath = { basename, dirname, join, normalize, relative } as const;

/**
 * Checks files in the Git index against the source-safety rules. In a commit hook the index is
 * the tree the commit records; in CI it is the checkout. Every rule reads one path and its bytes,
 * so the pre-commit hook checks only the index entries that differ from HEAD (`--changed`); the
 * merge hook and `just check` check every entry, so no task cache can skip it.
 */
import { spawnSync } from "node:child_process";
import {
  isTextualSourcePath,
  sourcePathSafetyReason,
  sourceTextSafetyReason,
  type SourceSafetyReason,
} from "./source-safety.js";

export interface SourceSafetyFinding {
  readonly path: string;
  readonly reason: SourceSafetyReason;
}

export interface SourceSafetyScan {
  readonly files: number;
  readonly findings: readonly SourceSafetyFinding[];
}

const git = (root: string, args: readonly string[], input?: string): Buffer => {
  const result = spawnSync("git", ["-C", root, ...args], {
    input,
    maxBuffer: 2 ** 31 - 1,
  });

  if (result.error !== undefined) throw result.error;

  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);

  return result.stdout;
};

/** `index` checks every entry of the index; `changed` only the entries that differ from HEAD. */
export type SourceSafetyScope = "index" | "changed";

// Git's empty tree, which a repository without commits compares against.
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** The mode, object id, and path of each index entry in the scope, submodules excluded. */
const indexEntries = (root: string, scope: SourceSafetyScope) => {
  if (scope === "index")
    // Each entry is `<mode> <object id> <stage>\t<path>`.
    return git(root, ["ls-files", "--stage", "-z"])
      .toString("utf8")
      .split("\0")
      .flatMap((entry) => {
        const match = entry.match(/^(\d{6}) ([0-9a-f]+) \d\t(.+)$/su);

        return match === null ? [] : [{ mode: match[1], objectId: match[2], path: match[3] }];
      });

  const head = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD"]);

  // Each entry is `:<old mode> <new mode> <old id> <new id> <status>\0<path>\0`; deletions are gone.
  const fields = git(root, [
    "diff-index",
    "--cached",
    "--no-renames",
    "--diff-filter=d",
    "-z",
    head.status === 0 ? "HEAD" : emptyTree,
  ])
    .toString("utf8")
    .split("\0");

  return Array.from({ length: Math.floor(fields.length / 2) }, (_, index) => {
    const header = fields[index * 2] ?? "";
    const match = /^:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]+) [A-Z]\d*$/u.exec(header);

    if (match === null) throw new Error("git diff-index returned an invalid entry: " + header);

    return { mode: match[1], objectId: match[2], path: fields[index * 2 + 1] };
  });
};

/** Returns the findings for every path and textual blob in the scope of the index at `root`. */
export const scanIndex = (root: string, scope: SourceSafetyScope = "index"): SourceSafetyScan => {
  const findings: SourceSafetyFinding[] = [];
  const textual: { readonly path: string; readonly objectId: string }[] = [];
  let files = 0;

  // Submodules (mode 160000) have no blob.
  for (const { mode, objectId = "", path = "" } of indexEntries(root, scope)) {
    if (mode === "160000" || path === "") continue;
    files += 1;

    if (sourcePathSafetyReason(path) !== null) findings.push({ path, reason: "UNSAFE_SOURCE" });
    else if (isTextualSourcePath(path)) textual.push({ path, objectId });
  }

  const blobs = git(
    root,
    ["cat-file", "--batch"],
    textual.map(({ objectId }) => objectId).join("\n"),
  );

  // `--batch` answers each object ID with `<id> <type> <size>\n<content>\n`, in input order.
  let offset = 0;

  for (const { path } of textual) {
    const headerEnd = blobs.indexOf(0x0a, offset);
    const size = Number(blobs.subarray(offset, headerEnd).toString("utf8").split(" ")[2]);

    if (!Number.isSafeInteger(size)) throw new Error(`git cat-file returned no blob for ${path}`);

    const reason = sourceTextSafetyReason(
      path,
      blobs.subarray(headerEnd + 1, headerEnd + 1 + size),
    );

    if (reason !== null) findings.push({ path, reason });
    offset = headerEnd + 1 + size + 1;
  }

  return { files, findings };
};

const REASON_TEXT: Record<SourceSafetyReason, string> = {
  INVALID_UTF8: "textual file is not valid UTF-8",
  UNSAFE_SOURCE:
    "path or content looks like a credential, personal data, or database material; remove it, or record a reviewed exception in tools/source-safety/src/source-safety.ts",
};

if (import.meta.main) {
  const options = process.argv.slice(2);

  if (options.some((option) => option !== "--changed")) {
    process.stderr.write(
      "Usage: just source-safety [--changed]\n--changed checks only the index entries that differ from HEAD.\n",
    );
    process.exit(2);
  }

  const scope: SourceSafetyScope = options.includes("--changed") ? "changed" : "index";
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  const { files, findings } = scanIndex(root, scope);

  for (const { path, reason } of findings)
    process.stderr.write(`${path}: ${REASON_TEXT[reason]}\n`);

  process.stdout.write(
    `source-safety: ${files} ${scope === "index" ? "indexed" : "changed"} files, ${findings.length} unsafe${findings.length === 0 ? "" : " (see above)"}\n`,
  );
  process.exitCode = findings.length === 0 ? 0 : 1;
}

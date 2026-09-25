/**
 * Checks every file in the Git index against the source-safety rules. In a commit hook the
 * index is the tree the commit records; in CI it is the checkout. It runs in the pre-commit
 * hook and in `bun run check`, so no task cache can skip it.
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

/** Returns the findings for every path and textual blob in the index of the repository at `root`. */
export const scanIndex = (root: string): SourceSafetyScan => {
  const findings: SourceSafetyFinding[] = [];
  const textual: { readonly path: string; readonly objectId: string }[] = [];
  let files = 0;

  // Each entry is `<mode> <object id> <stage>\t<path>`; submodules (mode 160000) have no blob.
  for (const entry of git(root, ["ls-files", "--stage", "-z"]).toString("utf8").split("\0")) {
    const match = entry.match(/^(\d{6}) ([0-9a-f]+) \d\t(.+)$/su);

    if (match === null || match[1] === "160000") continue;
    const [, , objectId = "", path = ""] = match;
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
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  const { files, findings } = scanIndex(root);

  for (const { path, reason } of findings)
    process.stderr.write(`${path}: ${REASON_TEXT[reason]}\n`);

  process.stdout.write(
    `source-safety: ${files} indexed files, ${findings.length} unsafe${findings.length === 0 ? "" : " (see above)"}\n`,
  );
  process.exitCode = findings.length === 0 ? 0 : 1;
}

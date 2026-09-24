import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const receiptName = "source-receipt.json";

export function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

export function cleanRevision(root, expected) {
  assert(/^[a-f0-9]{40}$/.test(expected ?? ""), "An exact expected Git revision is required");
  assert.equal(git(root, "rev-parse", "HEAD"), expected, "Source revision does not match");
  assert.equal(
    git(root, "status", "--porcelain", "--untracked-files=all"),
    "",
    "Source checkout must be clean",
  );

  return expected;
}

export function publicFile(root, tracked, file) {
  const absolute = resolve(file);
  const path = relative(root, absolute);
  assert(
    tracked.has(path) && !path.split(sep).some((part) => part.startsWith(".")),
    "Documentation input must be tracked public source: " + path,
  );
  assert(
    lstatSync(absolute).isFile() && realpathSync(absolute) === absolute,
    "Documentation input must not traverse a symlink: " + path,
  );

  return path;
}

export async function outsideOutput(root, destination) {
  const output = resolve(destination);
  // Resolve the parent even when the output does not exist yet.
  const canonical = resolve(realpathSync(resolve(output, "..")), output.split(sep).at(-1));
  const fromRoot = relative(realpathSync(root), canonical);
  assert(
    fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot),
    "Documentation output must stay outside the repository and its parent",
  );
  assert.equal(canonical, output, "Documentation output must not traverse a symlink");

  return output;
}

export async function inventory(directory) {
  assert(
    (await lstat(directory)).isDirectory(),
    "Documentation output must be a regular directory",
  );
  const result = Object.create(null);

  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      for (const [child, digest] of Object.entries(await inventory(path)))
        result[`${entry.name}/${child}`] = digest;
    } else {
      assert(entry.isFile(), "Documentation output must contain only regular files");
      result[entry.name] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    }
  }

  return { ...result };
}

export async function acceptArtifact(root, output, expected) {
  cleanRevision(root, expected);
  const actual = await inventory(output);
  assert(actual[receiptName] && actual["index.html"], "Complete documentation output is missing");
  const receipt = JSON.parse(await readFile(resolve(output, receiptName), "utf8"));
  assert.equal(receipt.format, 1, "Unknown documentation receipt format");
  assert.equal(receipt.status, "complete", "Documentation did not complete");
  assert.equal(receipt.revision, expected, "Retained documentation has a stale source revision");
  assert.equal(
    receipt.sourceUrl,
    `https://github.com/vektorprogrammet/mono-web/blob/${expected}/{path}#L{line}`,
    "Documentation source URL is not revision-bound",
  );
  delete actual[receiptName];
  assert.deepEqual(receipt.files, actual, "Retained documentation inventory or content changed");
  cleanRevision(root, expected);

  return receipt;
}

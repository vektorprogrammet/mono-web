import { unlink, rename } from "node:fs/promises";

const check = Bun.argv.includes("--check");
const outputPath = "CHANGELOG.md";
const temporaryPath = `${outputPath}.tmp-${process.pid}`;

const processResult = Bun.spawn(
  [
    "node_modules/.bin/conventional-changelog",
    "--config",
    ".changelogrc.mjs",
    "--release-count",
    "0",
    "--outfile",
    temporaryPath,
  ],
  { stderr: "inherit", stdout: "inherit" },
);

const exitCode = await processResult.exited;
if (exitCode !== 0) {
  await unlink(temporaryPath).catch(() => undefined);
  process.exit(exitCode);
}

if (check) {
  const expected = await Bun.file(outputPath)
    .arrayBuffer()
    .catch(() => null);
  const actual = await Bun.file(temporaryPath).arrayBuffer();
  await unlink(temporaryPath);

  if (expected === null || !Buffer.from(expected).equals(Buffer.from(actual))) {
    console.error("CHANGELOG.md is out of date. Run `bun run changelog` and commit the result.");
    process.exit(1);
  }

  console.log("CHANGELOG.md matches git history.");
} else {
  await rename(temporaryPath, outputPath);
  console.log("Generated CHANGELOG.md from conventional commits.");
}

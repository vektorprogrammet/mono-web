import { expect, test } from "bun:test";

const source = new URL("../../../", import.meta.url);

// Bun's metafile retains resolved inputs even when unused exports are tree-shaken.
const dependencyInputs = (entrypoints: ReadonlyArray<string>): string => {
  const child = Bun.spawnSync(
    [
      "bun",
      "-e",
      'const result = await Bun.build({entrypoints: process.argv.slice(1), target: "bun", metafile: true, write: false}); if (!result.success) { console.error(result.logs); process.exit(1); } console.log(Object.keys(result.metafile.inputs).join("\\n"));',
      ...entrypoints,
    ],
    { cwd: source.pathname },
  );

  if (child.exitCode !== 0) throw new Error(child.stderr.toString());

  return child.stdout.toString();
};

test("production database and backend entries cannot reach PGlite test adapters", () => {
  const productionInputs = dependencyInputs([
    new URL("packages/database/src/layers.ts", source).pathname,
    new URL("packages/database/src/index.ts", source).pathname,
    new URL("apps/backend/src/main.ts", source).pathname,
  ]);

  const adapterInputs = productionInputs
    .split("\n")
    .filter(
      (path) =>
        path.includes("@effect/sql-pglite/") ||
        path.includes("@effect+sql-pglite@") ||
        path.includes("@electric-sql/pglite/") ||
        path.includes("@electric-sql+pglite@") ||
        path.includes("/src/test-support/pglite-layer.ts"),
    );

  expect(adapterInputs).toEqual([]);

  const testInputs = dependencyInputs([
    new URL("packages/database/src/test-support/platform.ts", source).pathname,
  ]);

  expect(testInputs).toContain("sql-pglite");
  expect(testInputs).toContain("btree_gist");
});

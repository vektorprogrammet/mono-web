import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { placementsStaticPath } from "../markdown/placements";

const app = process.cwd();

const root = resolve(app, "../..");

const run = async (args: ReadonlyArray<string>, cwd: string): Promise<void> => {
  const child = Bun.spawn([process.execPath, "--no-env-file", ...args], {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const exit = await child.exited;

  if (exit !== 0) throw new Error(`${args.join(" ")} exited ${exit}`);
};

await run(["run", "--cwd", "packages/http-api", "generate"], root);

await run(["run", "--cwd", "packages/sdk", "generate"], root);

await run(["markdown/cli.ts", "check"], app);

await run(["markdown/prerender.ts"], app);

await run(["run", "vite", "build"], app);

// Static hosts have no server functions. Publish every generated Markdown URL as an asset.
const markdown = join(app, ".output/public/docs");

await cp(join(root, "docs"), markdown, { recursive: true });

await cp(join(root, "README.md"), join(markdown, "index.md"));

await cp(join(root, "STATE.md"), join(markdown, "state.md"));

const temporary = await mkdtemp(join(tmpdir(), "vektor-docs-placements-"));

const reference = join(temporary, "reference");

try {
  const mode = process.env.PLACEMENTS_DOCS_EXPECTED_REVISION ? "ci" : "generate";
  await run(["run", "--cwd", "tools/placements-docs", `docs:${mode}`, reference], root);
  const target = join(app, ".output/public", placementsStaticPath);
  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(reference, target, { recursive: true });
} finally {
  await rm(temporary, { recursive: true, force: true });
}

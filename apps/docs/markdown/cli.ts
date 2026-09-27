/** Render the documentation read paths from the site's content folders. */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { constructDocuments, constructPages } from "@monoweb/conventions/documentation";
import { apiDocuments } from "./openapi";
import { generatedPages } from "./generated";
import { bodyOf, Frontmatter, linkResolver, type Tree } from "./links";
import { collisions, pagesIn } from "./pages";
import { placementsReadPath, placementsReference } from "./placements";
import { markedSource, markerOf, recipe, renderPage } from "./render";

interface Finding {
  readonly path: string;
  readonly message: string;
}

const git = (args: ReadonlyArray<string>): string => {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 2 ** 28 });

  if (result.error !== undefined) throw result.error;

  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);

  return result.stdout;
};

// A hook sets GIT_DIR, which makes `rev-parse --show-toplevel` answer the current directory.
const root = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/u, "");

const readDisk = (path: string): string => readFileSync(join(root, path), "utf8");

/** The index for a hook, or the tracked and unignored working files for local use. */
const listTree = (staged: boolean) => {
  const listed = git([
    "-C",
    root,
    "ls-files",
    "-z",
    "--cached",
    ...(staged ? [] : ["--others", "--exclude-standard", "--deleted"]),
  ]).split("\0");

  const deleted = new Set(
    staged ? [] : git(["-C", root, "ls-files", "-z", "--deleted"]).split("\0"),
  );

  const paths = new Set(listed.filter((path) => path !== "" && !deleted.has(path)));
  const directories = new Set<string>();

  for (const path of paths)
    for (
      let directory = posix.dirname(path);
      directory !== ".";
      directory = posix.dirname(directory)
    )
      directories.add(directory);

  return {
    paths,
    tree: {
      kind: (path) => (paths.has(path) ? "file" : directories.has(path) ? "directory" : undefined),
      read: readDisk,
    } satisfies Tree,
  };
};

interface Expected {
  readonly path: string;
  readonly text: string;
}

const render = async (
  paths: Set<string>,
  tree: Tree,
  staged: boolean,
): Promise<{
  readonly expected: ReadonlyArray<Expected>;
  readonly findings: Array<Finding>;
}> => {
  const constructs = constructDocuments(root, staged);
  const api = await apiDocuments();
  const sources = new Set([...paths, ...constructs.keys(), placementsReadPath]);

  const sourceText = (path: string): string =>
    path === placementsReadPath ? placementsReference() : (constructs.get(path) ?? tree.read(path));

  const generated = generatedPages(sources, sourceText);
  const texts = new Map(generated.map(({ source, text }) => [source, text]));
  const read = (path: string): string => texts.get(path) ?? sourceText(path);
  const pages = pagesIn([...sources, ...texts.keys()], read);

  const links = linkResolver(pages, {
    ...tree,
    read,
    kind: (path) => (texts.has(path) || constructs.has(path) ? "file" : tree.kind(path)),
  });

  const findings = collisions(pages).map((message) => ({
    path: "apps/docs/markdown/pages.ts",
    message,
  }));

  const expected: Array<Expected> = [
    ...[...constructs].map(([path, text]) => ({ path, text })),
    ...api,
  ];

  expected.push({ path: placementsReadPath, text: placementsReference() });

  for (const page of pages) {
    const frontmatter = Frontmatter.safeParse(bodyOf(read(page.source)).data);

    if (!frontmatter.success)
      findings.push({
        path: page.source,
        message: "declares no title and description in its frontmatter",
      });

    if (!page.generated) continue;

    const rendered = await renderPage(page, read(page.source), links, read);

    for (const message of rendered.problems) findings.push({ path: page.source, message });
    expected.push({ path: page.readPath, text: rendered.text });
  }

  // The index is committed; the full-text aggregation is served by the site, not duplicated here.
  const index = [
    markerOf("content/"),
    "",
    "# Documentation",
    "",
    ...pages.map((page) => {
      const { data } = bodyOf(read(page.source));
      const parsed = Frontmatter.safeParse(data);
      const target = posix.relative("docs", page.readPath);

      return `- [${parsed.success ? parsed.data.title : page.source}](${target})`;
    }),
    ...api.map(({ path, text }) => {
      const title = /^# (.+)$/mu.exec(text)?.[1] ?? path;

      return `- [${title}](${posix.relative("docs", path)})`;
    }),
    "",
  ].join("\n");

  expected.push({ path: "docs/llms.txt", text: index });
  const seen = new Set<string>();

  for (const { path } of expected) {
    if (seen.has(path))
      findings.push({ path, message: "two documentation sources share this read path" });
    seen.add(path);
  }

  return { expected, findings };
};

const orphansOf = (
  paths: Set<string>,
  expected: ReadonlyArray<Expected>,
): ReadonlyArray<string> => {
  const rendered = new Set(expected.map(({ path }) => path));

  return [...paths].filter(
    (path) =>
      path.startsWith("docs/") &&
      !rendered.has(path) &&
      (markedSource(readDisk(path)) !== undefined ||
        path === constructPages.index ||
        path.startsWith(`${constructPages.contracts}/`)),
  );
};

const check = async (staged: boolean): Promise<ReadonlyArray<Finding>> => {
  const { paths, tree } = listTree(staged);
  const { expected, findings } = await render(paths, tree, staged);

  for (const { path, text } of expected) {
    if (!paths.has(path)) findings.push({ path, message: `is missing; run ${recipe}` });
    else if (readDisk(path) !== text)
      findings.push({
        path,
        message: `differs from the render of ${markedSource(text) ?? "its source"}; edit the source and run ${recipe}`,
      });
  }

  for (const path of orphansOf(paths, expected))
    findings.push({ path, message: `has no page; run ${recipe} to remove it` });

  return findings.sort((a, b) => a.path.localeCompare(b.path));
};

const write = async (): Promise<void> => {
  const { paths, tree } = listTree(false);
  const { expected, findings } = await render(paths, tree, false);

  if (findings.length > 0) {
    for (const { path, message } of findings) process.stderr.write(`${path}: ${message}\n`);
    throw new Error(`Cannot write documentation with ${findings.length} source findings`);
  }

  for (const { path, text } of expected) {
    if (paths.has(path) && readDisk(path) === text) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
    process.stdout.write(`docs: wrote ${path}\n`);
  }

  for (const path of orphansOf(paths, expected)) {
    rmSync(join(root, path));
    process.stdout.write(`docs: removed ${path}\n`);
  }
};

const [command = "check", ...options] = process.argv.slice(2);

const staged = options.includes("--staged");

if (
  !(command === "check" || command === "write") ||
  options.some((option) => option !== "--staged") ||
  (staged && command === "write")
) {
  process.stderr.write("Usage: bun markdown/cli.ts <write | check> [--staged]\n");
  process.exit(2);
}

if (command === "write") await write();
else {
  const findings = await check(staged);

  for (const { path, message } of findings) process.stderr.write(`${path}: ${message}\n`);
  process.stdout.write(`docs: ${findings.length} findings\n`);
  process.exitCode = findings.length === 0 ? 0 : 1;
}

/**
 * The pages that the site generates from the repository rather than from a content folder. Each is
 * a page read in place: it includes one repository document, so the site renders the document,
 * resolves its links relative to it, and takes the title and description from the page.
 *
 * - Each app, package, and tool has a section. Its first page is the workspace's summary, its
 *   `AGENTS.md` guide, whose generated part `just guides write` renders from the layout
 *   declaration, the package exports, and the constructs. The pages of its content folder follow.
 * - The construct contracts and the Placements TypeDoc landing page are derived directly from
 *   their source data. No generated file is written into an authored content folder.
 *
 * The site build writes these pages into the ignored generated folder before Vite reads the
 * content; `just docs generate` and `just docs check` compute them in memory.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { constructDocuments, constructPages } from "@monoweb/conventions/documentation";
import { generatedDirectory, packageDirectories } from "@monoweb/conventions/layout";
import type { Paragraph } from "mdast";
import { markdownProcessor, textOf } from "./links";
import { generatedFolder } from "./pages";
import { placementsReadPath, placementsReference } from "./placements";

/** A page that the site generates: its file in the generated folder and its text. */
export interface GeneratedPage {
  readonly source: string;
  readonly text: string;
}

/** Construct pages appear in the Architecture section, but retain their stable read paths. */
const constructSection = "(architecture)";

const stub = (
  path: string,
  title: string,
  description: string,
  document: string,
): GeneratedPage => {
  const source = `${generatedFolder}/${path}`;

  return {
    source,
    text: [
      "---",
      `title: ${JSON.stringify(title)}`,
      `description: ${JSON.stringify(description)}`,
      "---",
      "",
      `<include>${posix.relative(posix.dirname(source), document)}</include>`,
      "",
    ].join("\n"),
  };
};

/** The first-level heading and the first paragraph of a Markdown document, as plain text. */
const summaryOf = (text: string) => {
  const tree = markdownProcessor.parse(text);
  const heading = tree.children.find((node) => node.type === "heading" && node.depth === 1);
  const paragraph = tree.children.find((node): node is Paragraph => node.type === "paragraph");

  return {
    title: heading === undefined ? "" : textOf(heading),
    description: paragraph === undefined ? "" : textOf(paragraph).replaceAll(/\s+/gu, " ").trim(),
  };
};

/** The pages that the site generates from the repository files at `paths`. */
export const generatedPages = (
  paths: ReadonlySet<string>,
  read: (path: string) => string,
): ReadonlyArray<GeneratedPage> => [
  ...Object.entries(packageDirectories).flatMap(([workspace, holds]) =>
    paths.has(`${workspace}/AGENTS.md`)
      ? [stub(`${workspace}/index.mdx`, workspace, `${holds}.`, `${workspace}/AGENTS.md`)]
      : [],
  ),
  ...(paths.has(placementsReadPath)
    ? [
        stub(
          "packages/domain/placements-api.mdx",
          "Placements API reference",
          "Public Placements exports and TypeDoc reference.",
          placementsReadPath,
        ),
      ]
    : []),
  ...(() => {
    const documents = [...paths]
      .filter(
        (path) =>
          path === constructPages.index ||
          (path.startsWith(`${constructPages.contracts}/`) && path.endsWith(".md")),
      )
      .sort();

    const folders = new Set(documents.map((document) => posix.dirname(document)));

    return documents.map((document) => {
      const relative = posix.relative(generatedDirectory, document).replace(/\.md$/u, "");

      const path = folders.has(posix.join(generatedDirectory, relative))
        ? `${relative}/index.mdx`
        : `${relative}.mdx`;

      const { title, description } = summaryOf(read(document));

      return stub(`${constructSection}/${path}`, title, description, document);
    });
  })(),
];

/** Writes the generated pages into the generated folder of the repository at `root`, and nothing else. */
export const writeGeneratedPages = (root: string, pages: ReadonlyArray<GeneratedPage>): void => {
  rmSync(join(root, generatedFolder), { recursive: true, force: true });

  for (const { source, text } of pages) {
    mkdirSync(dirname(join(root, source)), { recursive: true });
    writeFileSync(join(root, source), text);
  }
};

/** Materialize the site's derived pages before Fumadocs scans the content folders. */
export const prepareGeneratedPages = (root: string): void => {
  const documents = constructDocuments(root);

  const paths = new Set([
    ...Object.keys(packageDirectories)
      .map((workspace) => `${workspace}/AGENTS.md`)
      .filter((path) => existsSync(join(root, path))),
    ...documents.keys(),
    placementsReadPath,
  ]);

  const read = (path: string): string =>
    path === placementsReadPath
      ? placementsReference()
      : (documents.get(path) ?? readFileSync(join(root, path), "utf8"));

  writeGeneratedPages(root, generatedPages(paths, read));
};

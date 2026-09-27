/**
 * The pages of the documentation site and their read paths.
 *
 * Hand-written pages live in content folders: the repository's own `content/`, and one beside the
 * `package.json` of each app, package, and tool. The site shows a page of the root folder at its
 * path in that folder, and a page of a workspace under the workspace's path: the page of
 * `content/specs/x.mdx` is `specs/x`, and the page of `packages/domain/content/receipt.mdx` is
 * `packages/domain/receipt`. A folder in parentheses, such as `content/(system)`, is a section of
 * the navigation that adds nothing to the path (a Fumadocs folder group). The site generates the
 * other pages from the repository into `apps/docs/generated`, as `generated.ts` describes.
 *
 * `just docs generate` writes the Markdown of each page to its read path, the file that agents and
 * GitHub readers open: `docs/` and the page's path, so `specs/x` reads at `docs/specs/x.md`. A page
 * whose whole body includes one repository Markdown document, such as the start page with
 * `README.md`, is read in place: the document is its read path, and nothing is generated for it.
 */
import { posix } from "node:path";
import { contentFolder, generatedDirectory, packageRoots } from "@monoweb/conventions/layout";
import { getSlugs } from "fumadocs-core/source";
import { urlOf } from "../src/lib/shared";

/** Where the site build writes the pages that it generates; Git ignores the folder. */
export const generatedFolder = "apps/docs/generated";

export interface Page {
  /** The MDX or Markdown file, relative to the repository root. */
  readonly source: string;
  /** The page's path in the site's content tree, such as `(system)/system.mdx`. */
  readonly path: string;
  /** The route of the page, below the site's base path. */
  readonly url: string;
  /** The Markdown file that readers open in the repository. */
  readonly readPath: string;
  /** Whether `just docs generate` writes the read path; false for a page read in place. */
  readonly generated: boolean;
}

const workspaceContent = new RegExp(
  `^((?:${packageRoots.join("|")})/[^/]+)/${contentFolder}/(.+)$`,
  "u",
);

/**
 * The path of a file of a content folder or of the generated folder in the site's content tree, or
 * undefined for any other file.
 */
export const contentPathOf = (file: string): string | undefined => {
  if (file.startsWith(`${contentFolder}/`)) return file.slice(contentFolder.length + 1);

  if (file.startsWith(`${generatedFolder}/`)) return file.slice(generatedFolder.length + 1);

  const match = workspaceContent.exec(file);

  return match === null ? undefined : `${match[1]}/${match[2]}`;
};

/** The read path of a page's path: `docs/`, the path without its folder groups, and `.md`. */
export const readPathOf = (path: string): string =>
  posix.join(
    generatedDirectory,
    path
      .split("/")
      .filter((segment) => !/^\(.+\)$/u.test(segment))
      .join("/")
      .replace(/\.mdx?$/u, ".md"),
  );

const include = /^<include>([^<>]+\.md)<\/include>$/u;

/** The frontmatter block at the start of a page. */
const frontmatterBlock = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u;

/**
 * The repository document that a page includes as its whole body, relative to the repository
 * root; undefined when the page has a body of its own.
 */
export const inPlaceDocumentOf = (source: string, text: string): string | undefined => {
  const specifier = include.exec(text.replace(frontmatterBlock, "").trim())?.[1]?.trim();

  return specifier === undefined
    ? undefined
    : posix.normalize(posix.join(posix.dirname(source), specifier));
};

/** The pages among repository paths, sorted by source. */
export const pagesIn = (
  paths: Iterable<string>,
  read: (path: string) => string,
): ReadonlyArray<Page> =>
  [...paths].sort().flatMap((source) => {
    const path = contentPathOf(source);

    if (path === undefined || !/\.mdx?$/u.test(path)) return [];

    const document = inPlaceDocumentOf(source, read(source));

    return [
      {
        source,
        path,
        url: urlOf(getSlugs(path)),
        readPath: document ?? readPathOf(path),
        generated: document === undefined,
      },
    ];
  });

/** Two pages with one read path or one route, which the site and the Markdown cannot tell apart. */
export const collisions = (pages: ReadonlyArray<Page>): ReadonlyArray<string> =>
  (["readPath", "url"] as const).flatMap((key) => {
    const owners = new Map<string, Array<string>>();

    for (const page of pages)
      owners.set(page[key], [...(owners.get(page[key]) ?? []), page.source]);

    return [...owners].flatMap(([value, sources]) =>
      sources.length > 1
        ? [`${sources.join(" and ")} share the ${key === "url" ? "route" : "read path"} ${value}`]
        : [],
    );
  });

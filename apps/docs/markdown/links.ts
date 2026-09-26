/**
 * Links of the documentation pages. A page links another page by the path of its source, and any
 * other repository file or directory by its path, both relative to the page. The site and the
 * generated Markdown resolve the same link: the site to the route of the page or to a GitHub view
 * of the path, the Markdown to a path relative to the read path. A page read in place resolves the
 * links of its document relative to that document, where GitHub reads it. A link out of the
 * repository, to a missing path, or from a page to a generated read path instead of its source is
 * broken, and so is a fragment that names no heading of its Markdown target.
 */
import { posix } from "node:path";
import { frontmatter } from "fumadocs-core/content/md/frontmatter";
import GithubSlugger from "github-slugger";
import type { Heading, Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { z } from "zod";
import type { Page } from "./pages";

/** The repository files that links may name: those of the working tree or of the Git index. */
export interface Tree {
  /** Whether the path is a file or a directory; undefined when it does not exist. */
  readonly kind: (path: string) => "file" | "directory" | undefined;
  readonly read: (path: string) => string;
}

export type Target =
  | { readonly type: "external" }
  | {
      readonly type: "page";
      readonly page: Page;
      /** The heading id without `#`; empty when the link names the page itself. */
      readonly fragment: string;
    }
  | {
      readonly type: "path";
      readonly path: string;
      readonly directory: boolean;
      readonly fragment: string;
    };

export type Resolution = Target | { readonly type: "broken"; readonly reason: string };

export interface LinkResolver {
  /** Where a link of `page` points, or why it is broken. */
  readonly resolve: (url: string, page: Page) => Resolution;
}

/** A URL with a scheme, such as `https:` or `mailto:`, or a protocol-relative one. */
const external = /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu;

export const markdownProcessor = unified().use(remarkParse).use(remarkGfm);

export const mdxProcessor = unified().use(remarkParse).use(remarkMdx).use(remarkGfm);

/** A file split into its frontmatter data and its body. */
export const bodyOf = (text: string) => {
  const { content, data } = frontmatter(text);

  return { body: content, data };
};

/** The title and description that the frontmatter of every page declares. */
export const Frontmatter = z.object({ title: z.string().min(1), description: z.string().min(1) });

/** The syntax tree of the body of a Markdown or MDX file. */
export const parse = (path: string, text: string): Root =>
  (path.endsWith(".mdx") ? mdxProcessor : markdownProcessor).parse(bodyOf(text).body);

/** The plain text of a node, as Fumadocs flattens a heading for its id. */
export const textOf = (node: Nodes): string =>
  "children" in node
    ? node.children.map((child) => textOf(child)).join("")
    : "value" in node
      ? node.value
      : "";

/** The GitHub ids of headings in document order. */
const idsOf = (headings: ReadonlyArray<string>): ReadonlySet<string> => {
  const slugger = new GithubSlugger();

  return new Set(headings.map((heading) => slugger.slug(heading)));
};

/** The document through which a link names the fragments of a target, or undefined for none. */
const documentOf = (target: Target): string | undefined => {
  if (target.type === "page")
    return target.page.generated ? target.page.source : target.page.readPath;

  return target.type === "path" && /\.mdx?$/u.test(target.path) ? target.path : undefined;
};

/**
 * Resolves the links of pages against a tree. A fragment of a generated page must name a heading
 * both on the site, where the page title is not a heading of the body, and in the Markdown, which
 * starts with the title as its first heading.
 */
export const linkResolver = (pages: ReadonlyArray<Page>, tree: Tree): LinkResolver => {
  const bySource = new Map(pages.map((page) => [page.source, page]));
  const byReadPath = new Map(pages.map((page) => [page.readPath, page]));
  const cache = new Map<string, ReadonlyArray<ReadonlySet<string>>>();

  /** The id sets of the headings of a Markdown file, each of which a fragment must be in. */
  const headingIds = (path: string): ReadonlyArray<ReadonlySet<string>> => {
    const cached = cache.get(path);

    if (cached !== undefined) return cached;

    const text = tree.read(path);
    const headings: Array<string> = [];

    visit(parse(path, text), "heading", (node: Heading) => {
      headings.push(textOf(node));
    });

    const title = Frontmatter.safeParse(bodyOf(text).data);

    const ids =
      bySource.has(path) && title.success
        ? [idsOf(headings), idsOf([title.data.title, ...headings])]
        : [idsOf(headings)];

    cache.set(path, ids);

    return ids;
  };

  const checked = (target: Target): Resolution => {
    if (target.type === "external" || target.fragment === "") return target;

    const document = documentOf(target);

    if (document === undefined || headingIds(document).every((ids) => ids.has(target.fragment)))
      return target;

    return { type: "broken", reason: `names no heading #${target.fragment} of ${document}` };
  };

  const resolve = (url: string, page: Page): Resolution => {
    if (external.test(url)) return { type: "external" };

    const hash = url.indexOf("#");
    const path = hash === -1 ? url : url.slice(0, hash);
    const fragment = hash === -1 ? "" : decodeURIComponent(url.slice(hash + 1));

    if (path === "") return checked({ type: "page", page, fragment });

    if (path.startsWith("/"))
      return {
        type: "broken",
        reason: `links the absolute path ${path}; link the file by its path relative to the page`,
      };

    const base = posix.dirname(page.generated ? page.source : page.readPath);
    const target = posix.normalize(posix.join(base, decodeURI(path))).replace(/\/$/u, "");

    if (target === ".." || target.startsWith("../"))
      return { type: "broken", reason: `links ${path}, which is outside the repository` };

    const linked = bySource.get(target) ?? byReadPath.get(target);

    if (linked !== undefined) {
      if (linked.generated && linked.readPath === target && page.generated)
        return {
          type: "broken",
          reason: `links the generated ${target}; link its source ${posix.relative(base, linked.source)}`,
        };

      return checked({ type: "page", page: linked, fragment });
    }

    const kind = tree.kind(target);

    if (kind === undefined)
      return { type: "broken", reason: `links ${path}, which does not exist` };

    return checked({ type: "path", path: target, directory: kind === "directory", fragment });
  };

  return { resolve };
};

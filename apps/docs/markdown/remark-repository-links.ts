/**
 * The links of the site's pages, as `links.ts` resolves them: a page to its route and any other
 * repository path to its view on GitHub. A broken link fails the build. A page read in place shows
 * its document without the document's first-level heading, which the page title replaces.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Root } from "mdast";
import { SKIP, visit } from "unist-util-visit";
import type { VFile } from "vfile";
import { packageRoots } from "@monoweb/conventions/layout";
import { gitConfig } from "../src/lib/shared";
import { linkResolver, type Target, type Tree } from "./links";
import { contentFolder, pagesIn } from "./pages";

const root = fileURLToPath(new URL("../../..", import.meta.url));

const repository: Tree = {
  kind: (path) => {
    try {
      return statSync(join(root, path)).isDirectory() ? "directory" : "file";
    } catch {
      return undefined;
    }
  },
  read: (path) => readFileSync(join(root, path), "utf8"),
};

const toPosix = (path: string): string => path.split(sep).join("/");

/** The files of every `content/` folder, relative to the repository root. */
const contentFiles = (): ReadonlyArray<string> =>
  [
    contentFolder,
    ...packageRoots.flatMap((packageRoot) =>
      readdirSync(join(root, packageRoot)).map((name) => `${packageRoot}/${name}/${contentFolder}`),
    ),
  ].flatMap((folder) =>
    existsSync(join(root, folder))
      ? readdirSync(join(root, folder), { encoding: "utf8", recursive: true }).map(
          (entry) => `${folder}/${toPosix(entry)}`,
        )
      : [],
  );

/** The route of a page, or the GitHub view of another repository path. */
const hrefOf = (target: Target, url: string): string => {
  switch (target.type) {
    case "external":
      return url;
    case "page":
      return `${target.page.url}${target.fragment === "" ? "" : `#${target.fragment}`}`;
    case "path":
      return `https://github.com/${gitConfig.user}/${gitConfig.repo}/${target.directory ? "tree" : "blob"}/${gitConfig.branch}/${encodeURI(target.path)}${target.fragment === "" ? "" : `#${target.fragment}`}`;
  }
};

export function remarkRepositoryLinks() {
  return (tree: Root, file: VFile): void => {
    const source = toPosix(relative(root, resolve(file.cwd, file.path)));
    const pages = pagesIn(contentFiles(), repository.read);
    const page = pages.find((candidate) => candidate.source === source);

    if (page === undefined) return;

    const links = linkResolver(pages, repository);

    if (!page.generated)
      visit(tree, "heading", (heading, index, parent) => {
        if (heading.depth !== 1 || parent === undefined || index === undefined) return undefined;

        parent.children.splice(index, 1);

        return [SKIP, index];
      });

    visit(tree, (node) => {
      if (node.type !== "link" && node.type !== "image" && node.type !== "definition") return;

      const resolution = links.resolve(node.url, page);

      if (resolution.type === "broken")
        file.fail(
          `${page.generated ? page.source : page.readPath}: ${resolution.reason} (${node.url})`,
          node,
        );

      node.url = hrefOf(resolution, node.url);
    });
  };
}

// Resolve repository-relative Markdown links for the rendered site.
// A link to a published document becomes its site route; a link to any other
// repository file or directory becomes its GitHub view. A link to a missing path
// stays unchanged, so the Vocs dead-link check fails the build.
import { existsSync, statSync } from "node:fs";
import { posix, relative, resolve, sep } from "node:path";
import type { Root } from "mdast";
import { visit } from "unist-util-visit";
import type { VFile } from "vfile";
import { pagesDirectory, repositoryRoot, repositoryUrl, route, sources } from "./site.ts";

const external = /^(?:[a-z][a-z\d+.-]*:|#|\/)/i;

export function remarkRepositoryLinks() {
  return (tree: Root, file: VFile) => {
    // The search index compiles sources without a path; its links need no rewriting.
    if (!file.path) return;

    const page = relative(pagesDirectory, file.path).split(sep).join("/");

    if (page.startsWith("..")) return;

    const directory = posix.dirname(page === "index.md" ? "README.md" : page);

    visit(tree, ["link", "definition"], (node) => {
      if ((node.type !== "link" && node.type !== "definition") || external.test(node.url)) return;

      const [path = "", fragment] = node.url.split("#", 2);
      const target = posix.normalize(posix.join(directory, decodeURI(path)));
      const hash = fragment === undefined ? "" : `#${fragment}`;

      if (sources.includes(target)) {
        node.url = `${route(target)}${hash}`;

        return;
      }

      const absolute = resolve(repositoryRoot, target);

      if (target.startsWith("..") || !existsSync(absolute)) return;

      const view = statSync(absolute).isDirectory() ? "tree" : "blob";

      node.url = `${repositoryUrl}/${view}/main/${encodeURI(target)}${hash}`;
    });
  };
}

import { defineConfig } from "fumadocs-mdx/config";
import { remarkRepositoryLinks } from "./markdown/remark-repository-links";

export default defineConfig({
  mdxOptions: {
    // First, so that it resolves every link before the preset turns images into imports, and
    // removes the heading of a document read in place before the table of contents lists it.
    remarkPlugins: (plugins) => [remarkRepositoryLinks, ...plugins],
  },
});

import { defineConfig } from "fumadocs-mdx/config";
import { remarkRepositoryLinks } from "./markdown/remark-repository-links";

export default defineConfig({
  mdxOptions: {
    // Resolve repository links before the preset turns images into imports.
    // The in-place document heading is removed before the table of contents is assembled.
    remarkPlugins: (plugins) => [remarkRepositoryLinks, ...plugins],
  },
});

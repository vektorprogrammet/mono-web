import { defineDocs } from "fumadocs-mdx/macro";

/** The authored content folders and the derived site pages, scanned by Fumadocs. */
export const docs = defineDocs({
  dir: "../..",
  docs: {
    files: [
      "content/**/*.{md,mdx}",
      "{apps,packages,tools}/*/content/**/*.{md,mdx}",
      "apps/docs/generated/**/*.mdx",
    ],
    async: true,
    postprocess: { includeProcessedMarkdown: true },
  },
  meta: {
    files: ["content/**/meta.json", "{apps,packages,tools}/*/content/**/meta.json"],
  },
});

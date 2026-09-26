import { llms, loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons";
import { defineDocs } from "fumadocs-mdx/macro";
import { contentPathOf } from "../../markdown/pages";
import { docsRoute, urlOf } from "./shared";

/**
 * Every `content/` folder of the repository: the root one and one per app, package, and tool.
 * `markdown/pages.ts` places each file in the site's content tree, as it places each page's
 * Markdown in `docs/`. The collection's paths are relative to the repository root.
 */
export const docs = defineDocs({
  dir: "../..",
  docs: {
    files: ["content/**/*.{md,mdx}", "{apps,packages,tools}/*/content/**/*.{md,mdx}"],
    async: true,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    files: ["content/**/meta.json", "{apps,packages,tools}/*/content/**/meta.json"],
  },
});

const content = docs.toFumadocsSource();

export const source = loader({
  source: {
    ...content,
    files: content.files.flatMap((file): typeof content.files => {
      const path = contentPathOf(file.path);

      return path === undefined ? [] : [{ ...file, path }];
    }),
  },
  baseUrl: docsRoute,
  url: urlOf,
  plugins: [lucideIconsPlugin()],
});

export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${await page.data.getText("processed")}`,
});

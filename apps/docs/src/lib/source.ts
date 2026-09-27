import { llms, loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons";
import { docs } from "./docs";
import { openapi } from "./openapi";
import { contentPathOf } from "../../markdown/pages";
import { docsRoute, urlOf } from "./shared";

const content = docs.toFumadocsSource();

export const source = loader(
  {
    docs: {
      ...content,
      files: content.files.flatMap((file): typeof content.files => {
        const path = contentPathOf(file.path);

        return path === undefined ? [] : [{ ...file, path }];
      }),
    },
    openapi: await openapi.staticSource({ baseDir: "packages/http-api/api" }),
  },
  { baseUrl: docsRoute, url: urlOf, plugins: [lucideIconsPlugin(), openapi.loaderPlugin()] },
);

export const docsLlms = llms(source, {
  renderPage: async (page) =>
    page.type === "openapi"
      ? `# ${page.data.title} (${page.url})\n\n${JSON.stringify(page.data.getOpenAPIPageProps().operations)}`
      : `# ${page.data.title} (${page.url})\n\n${await page.data.getText("processed")}`,
});

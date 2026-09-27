import { posix } from "node:path";
import { openapi } from "../src/lib/openapi";
import { markerOf } from "./render";

export interface ApiDocument {
  readonly path: string;
  readonly text: string;
}

const source = "packages/http-api/openapi.json";

const directory = "docs/packages/http-api";

/** The virtual Fumadocs pages and Markdown read paths share one public OpenAPI contract. */
export const apiDocuments = async (): Promise<ReadonlyArray<ApiDocument>> => {
  const pages = await openapi.staticSource({ baseDir: "packages/http-api/api" });
  const first = pages.files.find((file) => file.type === "page");
  const document = first?.data.getSchema().bundled;

  if (document === undefined || !("paths" in document) || document.paths === undefined)
    throw new Error("The public OpenAPI contract has no paths");

  const entries: Array<{
    readonly path: string;
    readonly title: string;
    readonly method: string;
    readonly route: string;
    readonly text: string;
  }> = [];

  for (const file of pages.files) {
    if (file.type !== "page") continue;
    const operation = file.data.getOpenAPIPageProps().operations?.[0];

    if (operation === undefined) throw new Error(`The OpenAPI page ${file.path} has no operation`);
    const detail = document.paths[operation.path]?.[operation.method];

    if (detail === undefined)
      throw new Error(`The OpenAPI contract has no ${operation.method} ${operation.path}`);
    const path = `docs/${file.path.replace(/\.mdx$/u, ".md")}`;
    const title = file.data.title;

    if (title === undefined) throw new Error(`The OpenAPI page ${file.path} has no title`);
    const description = file.data.description ?? "";
    const responses = Object.keys(detail.responses ?? {});
    const siteUrl = `https://vektorprogrammet.github.io/mono-web/docs/${file.path.replace(/\.mdx$/u, "")}`;

    const text = [
      markerOf(source),
      "",
      `# ${title}`,
      "",
      description,
      "",
      `**${operation.method.toUpperCase()} ${operation.path}**`,
      "",
      `Responses: ${responses.join(", ") || "none declared"}.`,
      "",
      `[Request and response schemas](${siteUrl}) are rendered from the public OpenAPI contract.`,
      "",
      `[Contract source](${posix.relative(posix.dirname(path), "packages/http-api/src/api.ts")})`,
      "",
    ].join("\n");

    entries.push({
      path,
      title,
      method: operation.method.toUpperCase(),
      route: operation.path,
      text,
    });
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));

  const index = [
    markerOf(source),
    "",
    "# HTTP API reference",
    "",
    "The public HTTP operations come from the native API contract. Internal operations are excluded.",
    "",
    "Each operation links to its interactive request and response schemas on the site.",
    "",
    ...entries.map(
      ({ path, title, method, route }) =>
        `- [${method} ${route} — ${title}](${posix.relative(directory, path)})`,
    ),
    "",
  ].join("\n");

  return [
    ...entries.map(({ path, text }) => ({ path, text })),
    { path: `${directory}/api.md`, text: index },
  ];
};

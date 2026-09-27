import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { apiDocuments } from "./openapi";
import { prepareGeneratedPages } from "./generated";
import { pagesIn } from "./pages";
import { contentFiles } from "./remark-repository-links";

const app = process.cwd();

const root = resolve(app, "../..");

prepareGeneratedPages(root);

const pages = pagesIn(contentFiles(root), (path) => readFileSync(join(root, path), "utf8"));

if (!pages.some(({ url }) => url === "/")) throw new Error("The site has no start page");

const api = (await apiDocuments())
  .filter(({ path }) => path.startsWith("docs/packages/http-api/api/"))
  .map(({ path }) => `/docs/${path.slice("docs/".length).replace(/\.md$/u, "")}`);

const routes = new Set([
  ...pages.map(({ url }) => url),
  ...api,
  "/api/search",
  "/llms-full.txt",
  "/llms.txt",
]);

writeFileSync(join(app, "generated/routes.txt"), [...routes].sort().join("\n") + "\n");

process.stdout.write(`docs: ${routes.size} routes to prerender\n`);

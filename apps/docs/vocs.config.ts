import { resolve } from "node:path";
import { defineConfig, OpenApi } from "vocs/config";
import { remarkRepositoryLinks } from "./remark-repository-links.ts";
import { repositoryRoot, repositoryUrl, route, sections, title } from "./site.ts";

export default defineConfig({
  title: "Vektorprogrammet",
  description: "Documentation for the Vektorprogrammet native replacement.",
  basePath: "/mono-web",
  renderStrategy: "full-static",
  checkDeadlinks: true,
  mcp: { enabled: false },
  // Repository Markdown is CommonMark; only `.mdx` sources are MDX.
  markdown: { format: "detect", remarkPlugins: [remarkRepositoryLinks] },
  editLink: {
    // Vocs serializes this function to the client; it cannot reference module bindings.
    link: (filePath) =>
      `https://github.com/vektorprogrammet/mono-web/edit/main/${filePath === "index.md" ? "README.md" : filePath}`,
    text: "Edit this page on GitHub",
  },
  socials: [{ icon: "github", link: repositoryUrl }],
  topNav: [
    { text: "Documentation", link: "/" },
    { text: "HTTP API", link: "/api" },
  ],
  // The build derives this ignored spec from the HTTP contract first.
  openapi: [
    OpenApi.from({ spec: resolve(repositoryRoot, "packages/http-api/openapi.json"), path: "/api" }),
  ],
  sidebar: sections.map((section) => ({
    text: section.text,
    items: [
      ...section.sources.map((source) => ({ text: title(source), link: route(source) })),
      ...(section.links ?? []),
    ],
  })),
});

// The documentation site renders repository Markdown in place. This manifest names the
// published sources; `scripts/sync-pages.ts` mirrors them into the ignored `src/pages`.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export const repositoryUrl = "https://github.com/vektorprogrammet/mono-web";

export const pagesDirectory = fileURLToPath(new URL("src/pages", import.meta.url));

// Every Markdown file directly in these directories must be published.
export const completeDirectories = ["docs", "docs/specs"];

// MDX components available to published `.mdx` sources without an import.
export const mdxComponents = {
  GraphFlow: fileURLToPath(new URL("components/mdxcn/graph-flow.tsx", import.meta.url)),
};

const specs = readdirSync(resolve(repositoryRoot, "docs/specs"))
  .filter((name) => name.endsWith(".md"))
  .sort()
  .map((name) => `docs/specs/${name}`);

export const sections = [
  { text: "Start", sources: ["README.md", "STATE.md"] },
  {
    text: "System",
    sources: [
      "docs/system.md",
      "docs/system-walkthrough.mdx",
      "docs/architecture.md",
      "docs/enterprise-models.md",
      "docs/operational-responsibility-map.md",
    ],
  },
  { text: "Operations", sources: ["docs/delivery-recovery.md"] },
  {
    text: "Developer guides",
    sources: [
      "docs/module-developer-documentation.md",
      "docs/constructs.md",
      "packages/domain/src/placements/README.md",
      "packages/domain/src/substitutes/README.md",
      "packages/domain/src/receipt/README.md",
    ],
    // The Pages workflow publishes the Placements TypeDoc output at this path.
    links: [
      {
        text: "Placements API reference",
        link: "https://vektorprogrammet.github.io/mono-web/packages/domain/src/placements/api/",
      },
    ],
  },
  { text: "Specs", sources: specs },
  { text: "Testing", sources: ["docs/web-system-functional-testing.md"] },
];

export const sources = sections.flatMap((section) => section.sources);

/** Page file under `src/pages` for a repository-relative source; README.md is the site root. */
export function pageFile(source: string) {
  return source === "README.md" ? "index.md" : source;
}

/** Site route for a repository-relative source. */
export function route(source: string) {
  return `/${pageFile(source)
    .replace(/(^|\/)index\.md$/, "")
    .replace(/\.mdx?$/, "")}`;
}

/** The source's first-level heading. */
export function title(source: string) {
  const heading = /^# (.+)$/m.exec(readFileSync(resolve(repositoryRoot, source), "utf8"));

  if (!heading?.[1]) throw new Error(`${source} has no first-level heading.`);

  return heading[1].trim();
}

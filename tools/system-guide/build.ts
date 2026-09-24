import { evaluate } from "@mdx-js/mdx";
import { compile } from "@tailwindcss/node";
import GithubSlugger from "github-slugger";
import type { Nodes, Root } from "mdast";
import { toString } from "mdast-util-to-string";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import * as runtime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import remarkGfm from "remark-gfm";
import { GraphFlow, type GraphFlowProps } from "./vendor/mdxcn/graph-flow";

type Heading = { id: string; title: string; depth: number };

const directory = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(directory, "../..");
const [input = resolve(root, "docs/system-walkthrough.mdx"), output = resolve(root, "docs/system-walkthrough.html")] = process.argv.slice(2);
const headings: Heading[] = [];
const slugger = new GithubSlugger();
// Reserve the wrapper's anchor before assigning document headings.
slugger.slug("main");

function documentHeadings() {
  return (tree: Root) => {
    function walk(node: Nodes) {
      if (node.type === "heading") {
        const title = toString(node);
        const id = slugger.slug(title);
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id } };
        headings.push({ id, title, depth: node.depth });
      }
      if ("children" in node) {
        for (const child of node.children) walk(child);
      }
    }
    walk(tree);
  };
}

let graphCount = 0;
function StaticGraphFlow(props: GraphFlowProps) {
  if (++graphCount > 2) throw new Error("The system guide supports at most two graphs.");
  return createElement(GraphFlow, props);
}

// MDX is executable build-time source. Only compile the repository's trusted document.
const { default: Content } = await evaluate(await readFile(input, "utf8"), {
  ...runtime,
  remarkPlugins: [remarkGfm, documentHeadings],
});
const article = renderToStaticMarkup(createElement(Content, {
  components: { GraphFlow: StaticGraphFlow },
}));
const title = headings.find((heading) => heading.depth === 1)?.title ?? "Vektorprogrammet system guide";
const toc = renderToStaticMarkup(createElement("nav", { "aria-label": "On this page", className: "toc" },
  createElement("p", { className: "toc-label" }, "On this page"),
  createElement("ol", null, headings.filter(({ depth }) => depth === 2 || depth === 3).map((heading) =>
    createElement("li", { key: heading.id, className: heading.depth === 3 ? "toc-subheading" : undefined },
      createElement("a", { href: `#${heading.id}` }, heading.title))))));

const shell = `<a class="skip-link" href="#main">Skip to content</a>
<header class="page-header"><p>VEKTORPROGRAMMET <span aria-hidden="true">/</span> SYSTEM GUIDE</p></header>
<div class="layout">${toc}<main id="main" tabindex="-1"><article>${article}</article>
<footer><p>This page is generated from one MDX source. It works offline without JavaScript.</p>
<p>Diagrams use <a href="https://www.mdxcn.dev/">MDXCN</a> components under the MIT license.</p></footer></main></div>`;
// Compile only the utilities that occur in this page, including the rendered MDXCN components.
const candidates = new Set<string>();
for (const match of shell.matchAll(/class="([^"]*)"/g)) {
  for (const candidate of match[1]!.split(/\s+/)) candidates.add(candidate.replaceAll("&amp;", "&").replaceAll("&#x27;", "'").replaceAll("&quot;", '"'));
}
const compiler = await compile(await readFile(resolve(directory, "style.css"), "utf8"), {
  base: directory,
  onDependency() { /* One-shot build: imported CSS needs no file watcher. */ },
});
const css = compiler.build([...candidates]);
const license = await readFile(resolve(directory, "vendor/mdxcn/LICENSE"), "utf8");
const escapedTitle = renderToStaticMarkup(createElement("title", null, title));
const html = `<!doctype html>
<!-- Generated from MDX by tools/system-guide/build.ts. Do not edit this HTML directly. -->
<!-- MDXCN license\n${license}-->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
${escapedTitle}<style>${css}</style></head><body>${shell}</body></html>\n`;
await writeFile(output, html);
console.log(`Rendered ${input} → ${output} (${Buffer.byteLength(html)} bytes, ${graphCount} graphs).`);

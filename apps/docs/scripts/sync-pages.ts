// Mirror the published repository Markdown into the ignored Vocs pages directory.
// Pages keep their repository paths, so relative links between them still resolve.
// Two build-time expansions keep sources readable on GitHub and valid for Vocs:
// - a TypeDoc `{@includeCode path}` line becomes a code block with that file;
// - an `.mdx` source gets imports for the components it uses from `mdxComponents`.
// `--watch` re-mirrors a source whenever it changes, for `vocs dev`.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { dirname, extname, posix, relative, resolve } from "node:path";
import {
  completeDirectories,
  mdxComponents,
  pageFile,
  pagesDirectory,
  repositoryRoot,
  sources,
} from "../site.ts";

for (const directory of completeDirectories) {
  const unpublished = (await readdir(resolve(repositoryRoot, directory)))
    .filter((name) => /\.mdx?$/.test(name))
    .map((name) => `${directory}/${name}`)
    .filter((source) => !sources.includes(source));

  if (unpublished.length > 0)
    throw new Error(`Add ${unpublished.join(", ")} to a section in apps/docs/site.ts.`);
}

async function mirror(source: string) {
  const target = resolve(pagesDirectory, pageFile(source));
  let content = await readFile(resolve(repositoryRoot, source), "utf8");

  for (const [line, include = ""] of content.matchAll(/^\{@includeCode\s+(\S+)\}$/gm)) {
    const code = (
      await readFile(resolve(repositoryRoot, dirname(source), include), "utf8")
    ).trimEnd();

    // Fence the file with more backticks than any fence inside it.
    const fence = "`".repeat(
      Math.max(3, ...[...code.matchAll(/`{3,}/g)].map(([run]) => run.length + 1)),
    );

    content = content.replace(line, `${fence}${extname(include).slice(1)}\n${code}\n${fence}`);
  }

  if (source.endsWith(".mdx")) {
    const imports = Object.entries(mdxComponents)
      .filter(([name]) => content.includes(`<${name}`))
      .map(
        ([name, file]) =>
          `import { ${name} } from ${JSON.stringify(relative(dirname(target), file))};\n`,
      );

    if (imports.length > 0) content = `${imports.join("")}\n${content}`;
  }

  await mkdir(dirname(target), { recursive: true });

  await writeFile(target, content);
}

// Committed Vocs files in the pages directory start with an underscore.
for (const entry of await readdir(pagesDirectory))
  if (!entry.startsWith("_")) await rm(resolve(pagesDirectory, entry), { recursive: true });

await Promise.all(sources.map(mirror));

console.log(
  `Mirrored ${sources.length} repository documents into ${relative(repositoryRoot, pagesDirectory)}.`,
);

if (process.argv.includes("--watch")) {
  // Watch directories, not files: editors often replace a file on save.
  for (const directory of new Set(sources.map((source) => posix.dirname(source))))
    watch(resolve(repositoryRoot, directory), (_event, name) => {
      const source = posix.join(directory, name ?? "");

      if (sources.includes(source)) mirror(source).catch(console.error);
    });
}

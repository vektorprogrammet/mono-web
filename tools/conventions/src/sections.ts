/**
 * Generated sections of Markdown files. Each section sits between a begin and an end marker
 * comment and is rendered from its source: the layout declaration and the justfile render the
 * sections of README.md and AGENTS.md, and `guides.ts` renders the module guides. The tables use
 * the column alignment that Oxfmt writes, so formatting never changes them.
 */
import type { Justfile } from "./justfile.js";
import {
  contextLayers,
  contextMap,
  packageDirectories,
  packageRoots,
  sharedKernel,
  topLevelDirectories,
} from "./layout.js";

export type SectionId = "layout" | "commands";

/** A generated section: what renders it, from which source, and its body. */
export interface Section {
  readonly id: string;
  readonly source: string;
  readonly recipe: string;
  readonly body: string;
}

const declaration = "tools/conventions/src/layout.ts";

/** The files that carry generated sections, and which ones. */
export const generatedFiles = {
  "README.md": ["layout", "commands"],
  "AGENTS.md": ["layout", "commands"],
} satisfies Readonly<Record<string, ReadonlyArray<SectionId>>>;

/** A Markdown table with the column alignment that Oxfmt writes. */
export const table = (
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string => {
  const cells = [header, ...rows].map((row) => row.map((cell) => cell.replaceAll("|", "\\|")));

  const widths = header.map((_, column) =>
    Math.max(3, ...cells.map((row) => row[column]?.length ?? 0)),
  );

  const line = (row: ReadonlyArray<string>) =>
    `| ${widths.map((width, column) => (row[column] ?? "").padEnd(width)).join(" | ")} |`;

  const [head = [], ...body] = cells;

  return [line(head), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join("\n");
};

const code = (text: string) => `\`${text}\``;

const renderLayout = (): string => {
  const rows = Object.entries(topLevelDirectories).flatMap(([directory, purpose]) =>
    packageRoots.some((root) => root === directory)
      ? Object.entries(packageDirectories).flatMap(([path, holds]) =>
          path.startsWith(`${directory}/`) ? [[code(path), holds]] : [],
        )
      : [[code(directory), purpose]],
  );

  const layers = Object.keys(contextLayers).map(code);

  return [
    table(["Path", "Holds"], rows),
    "",
    `Apps and packages never import ${code("tools/")}.`,
    `Context folders in ${layers.slice(0, -1).join(", ")}, and ${layers.at(-1) ?? ""} carry the kebab-case name of a bounded context in [${contextMap}](${contextMap}).`,
    `Code that several contexts share lives in ${code(sharedKernel)}.`,
    `${code("just layout")} checks the tree against [${declaration}](${declaration}), which lists the exceptions and their reasons.`,
    `Every app, package, and context folder has an ${code("AGENTS.md")} guide and a ${code("CLAUDE.md")} link to it; ${code("just guides write")} renders their generated part.`,
    `[docs/constructs.md](docs/constructs.md) lists the shared constructs and their consumers; ${code("just constructs write")} renders it.`,
  ].join("\n");
};

const renderCommands = (justfile: Justfile): string =>
  table(
    ["Group", "Recipe", "Does"],
    justfile.recipes.map((recipe) => [recipe.group, code(recipe.usage), recipe.doc]),
  );

// Link reference definitions render as nothing on GitHub and, unlike HTML comments, are valid MDX
// for the documentation site.
const begin = (section: Section) =>
  `[//]: # "${section.id}: generated from ${section.source} by ${section.recipe}; do not edit"`;

const end = (id: string) => `[//]: # "${id}: end"`;

/** The sections of README.md and AGENTS.md, rendered. */
export const renderSections = (justfile: Justfile): Readonly<Record<SectionId, Section>> => ({
  layout: { id: "layout", source: declaration, recipe: "just layout write", body: renderLayout() },
  commands: {
    id: "commands",
    source: "the justfile",
    recipe: "just layout write",
    body: renderCommands(justfile),
  },
});

export interface Spliced {
  readonly text: string;
  /** Sections whose markers are missing, out of order, or repeated; they stay as they are. */
  readonly missing: ReadonlyArray<string>;
}

/** Replaces each section of `text` with its rendered body, between its begin and end markers. */
export const spliceSections = (text: string, sections: ReadonlyArray<Section>): Spliced => {
  const lines = text.split("\n");
  const missing: Array<string> = [];

  for (const section of sections) {
    const starts = lines.flatMap((line, index) =>
      line.startsWith(`[//]: # "${section.id}: generated `) ? [index] : [],
    );

    const ends = lines.flatMap((line, index) => (line === end(section.id) ? [index] : []));
    const [start] = starts;
    const [stop] = ends;

    if (
      start === undefined ||
      stop === undefined ||
      starts.length > 1 ||
      ends.length > 1 ||
      stop < start
    ) {
      missing.push(section.id);

      continue;
    }

    lines.splice(start, stop - start + 1, begin(section), "", section.body, "", end(section.id));
  }

  return { text: lines.join("\n"), missing };
};

/** The markers of `section` with nothing between them, for a file that has none yet. */
export const emptySection = (section: Section): string => `${begin(section)}\n${end(section.id)}\n`;

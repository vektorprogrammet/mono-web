/**
 * Generated sections of README.md and AGENTS.md. Each section sits between a begin and an end
 * marker comment and is rendered from its source: the layout declaration or the justfile.
 * The tables use the column alignment that Oxfmt writes, so formatting never changes them.
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

const sources: Readonly<Record<SectionId, string>> = {
  layout: "tools/conventions/src/layout.ts",
  commands: "the justfile",
};

/** The files that carry generated sections, and which ones. */
export const generatedFiles = {
  "README.md": ["layout", "commands"],
  "AGENTS.md": ["layout", "commands"],
} satisfies Readonly<Record<string, ReadonlyArray<SectionId>>>;

const table = (
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
    `${code("just layout")} checks the tree against [${sources.layout}](${sources.layout}), which lists the exceptions and their reasons.`,
  ].join("\n");
};

const renderCommands = (justfile: Justfile): string =>
  table(
    ["Group", "Recipe", "Does"],
    justfile.recipes.map((recipe) => [recipe.group, code(recipe.usage), recipe.doc]),
  );

const begin = (id: SectionId) =>
  `<!-- ${id}: generated from ${sources[id]} by \`just layout write\`; do not edit -->`;

const end = (id: SectionId) => `<!-- ${id}: end -->`;

/** The rendered body of every section. */
export const renderSections = (justfile: Justfile): Readonly<Record<SectionId, string>> => ({
  layout: renderLayout(),
  commands: renderCommands(justfile),
});

export interface Spliced {
  readonly text: string;
  /** Sections whose markers are missing, out of order, or repeated; they stay as they are. */
  readonly missing: ReadonlyArray<SectionId>;
}

/** Replaces each section of `text` with its rendered body, between its begin and end markers. */
export const spliceSections = (
  text: string,
  ids: ReadonlyArray<SectionId>,
  bodies: Readonly<Record<SectionId, string>>,
): Spliced => {
  const lines = text.split("\n");
  const missing: Array<SectionId> = [];

  for (const id of ids) {
    const starts = lines.flatMap((line, index) =>
      line.startsWith(`<!-- ${id}: generated `) ? [index] : [],
    );

    const ends = lines.flatMap((line, index) => (line === end(id) ? [index] : []));
    const [start] = starts;
    const [stop] = ends;

    if (
      start === undefined ||
      stop === undefined ||
      starts.length > 1 ||
      ends.length > 1 ||
      stop < start
    ) {
      missing.push(id);

      continue;
    }

    lines.splice(start, stop - start + 1, begin(id), "", bodies[id], "", end(id));
  }

  return { text: lines.join("\n"), missing };
};

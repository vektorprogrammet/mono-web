/**
 * Generated sections of Markdown and YAML files. Each section sits between a begin and an end
 * marker comment and is rendered from its source: the layout declaration and the justfile render
 * the sections of README.md and AGENTS.md, the justfile and the journeys declaration render the
 * hosted journeys of the Tests workflow and of its document, and `guides.ts` renders the module
 * guides. The tables use the column alignment that Oxfmt writes, so formatting never changes them.
 */
import {
  exclusionOf,
  exclusions,
  journeyRecipes,
  journeys,
  journeysDeclaration,
  legs,
  matrixJob,
  ownJobOf,
  runFiles,
  testsWorkflow,
  type Workflow,
} from "./journeys.js";
import type { Justfile } from "./justfile.js";
import {
  contextLayers,
  contextMap,
  packageDirectories,
  packageRoots,
  sharedKernel,
  topLevelDirectories,
} from "./layout.js";

type SectionId = "layout" | "commands" | "hosted-journeys" | "browser-journeys";

/** A generated section: what renders it, from which source, and its body. */
export interface Section {
  readonly id: string;
  readonly source: string;
  readonly recipe: string;
  readonly body: string;
}

const declaration = "tools/conventions/src/layout.ts";

/** The files that carry generated sections, and which ones. */
const generatedFiles = {
  "README.md": ["layout", "commands"],
  "AGENTS.md": ["layout", "commands"],
  "docs/web-system-functional-testing.md": ["hosted-journeys"],
  [testsWorkflow]: ["browser-journeys"],
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

const renderHostedJourneys = (justfile: Justfile, workflow: Workflow): string => {
  // GitHub names each leg after the matrix values, such as `Browser journeys (e2e contact)`.
  const legName = workflow.jobs.get(matrixJob) ?? matrixJob;
  const recipes = journeyRecipes.map((recipe) => code(`just ${recipe}`));

  const hosted = journeys(justfile).flatMap((journey) => {
    const command = code(`just ${journey.recipe} ${journey.name}`);
    const own = ownJobOf(journey);

    if (own !== undefined) return [[command, workflow.jobs.get(own.job) ?? code(own.job)]];

    return exclusionOf(journey) === undefined
      ? [
          [
            command,
            legName.replaceAll(/\$\{\{\s*matrix\.(recipe|suite)\s*\}\}/gu, (_, key) =>
              key === "recipe" ? journey.recipe : journey.name,
            ),
          ],
        ]
      : [];
  });

  const excluded = exclusions.map((entry) => [
    code(
      "script" in entry
        ? `bun run --cwd ${entry.directory} ${entry.script}`
        : "file" in entry
          ? entry.file
          : `just ${entry.recipe} ${entry.name}`,
    ),
    entry.reason,
  ]);

  const files = runFiles.map(({ kind, glob }) => `${kind} (${code(glob)})`);

  return [
    `${code("just layout write")} generates this section and the matrix legs in ${code(testsWorkflow)} from the names that ${recipes.slice(0, -1).join(", ")}, and ${recipes.at(-1) ?? ""} accept.`,
    `Each name is one leg, unless ${code(journeysDeclaration)} gives it a job of its own or excludes it with its reason.`,
    `A name runs the files that its command names, and in turn the files that those name. Each ${files.join(" and each ")} runs under a name, unless the declaration excludes it.`,
    "",
    table(["Command", "Hosted job"], hosted),
    ...(excluded.length === 0
      ? []
      : [
          "",
          "These commands and files are not hosted:",
          "",
          table(["Command or file", "Reason"], excluded),
        ]),
  ].join("\n");
};

const renderMatrix = (justfile: Justfile): string =>
  [
    "include:",
    ...legs(justfile).map(({ recipe, name }) => `  - { recipe: ${recipe}, suite: ${name} }`),
  ].join("\n");

const renderSections = (
  justfile: Justfile,
  workflow: Workflow,
): Readonly<Record<SectionId, Section>> => ({
  layout: { id: "layout", source: declaration, recipe: "just layout write", body: renderLayout() },
  commands: {
    id: "commands",
    source: "the justfile",
    recipe: "just layout write",
    body: renderCommands(justfile),
  },
  "hosted-journeys": {
    id: "hosted-journeys",
    source: `the justfile, ${journeysDeclaration}, and ${testsWorkflow}`,
    recipe: "just layout write",
    body: renderHostedJourneys(justfile, workflow),
  },
  "browser-journeys": {
    id: "browser-journeys",
    source: `the justfile and ${journeysDeclaration}`,
    recipe: "just layout write",
    body: renderMatrix(justfile),
  },
});

/** How a file type writes the marker comments around a generated section. */
interface Comment {
  readonly open: string;
  readonly close: string;
  /** The lines between each marker and the body. */
  readonly padding: ReadonlyArray<string>;
}

// Link reference definitions render as nothing on GitHub and, unlike HTML comments, are valid MDX
// for the documentation site. A blank line keeps a table apart from them.
const markdown: Comment = { open: '[//]: # "', close: '"', padding: [""] };

const yaml: Comment = { open: "# ", close: "", padding: [] };

const begin = (comment: Comment, section: Section) =>
  `${comment.open}${section.id}: generated from ${section.source} by ${section.recipe}; do not edit${comment.close}`;

const end = (comment: Comment, id: string) => `${comment.open}${id}: end${comment.close}`;

export interface Spliced {
  readonly text: string;
  /** Sections whose markers are missing, out of order, or repeated; they stay as they are. */
  readonly missing: ReadonlyArray<string>;
}

/**
 * Replaces each section of `text` with its rendered body, between its begin and end markers. The
 * markers and the body take the indentation of the begin marker, which a YAML block needs.
 */
export const spliceSections = (
  text: string,
  sections: ReadonlyArray<Section>,
  comment: Comment = markdown,
): Spliced => {
  const lines = text.split("\n");
  const missing: Array<string> = [];

  for (const section of sections) {
    const starts = lines.flatMap((line, index) =>
      line.trimStart().startsWith(`${comment.open}${section.id}: generated `) ? [index] : [],
    );

    const ends = lines.flatMap((line, index) =>
      line.trim() === end(comment, section.id) ? [index] : [],
    );

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

    const indent = /^\s*/u.exec(lines[start] ?? "")?.[0] ?? "";

    lines.splice(
      start,
      stop - start + 1,
      indent + begin(comment, section),
      ...comment.padding,
      ...section.body.split("\n").map((line) => (line === "" ? line : indent + line)),
      ...comment.padding,
      indent + end(comment, section.id),
    );
  }

  return { text: lines.join("\n"), missing };
};

/** The markers of `section` with nothing between them, for a Markdown file that has none yet. */
export const emptySection = (section: Section): string =>
  `${begin(markdown, section)}\n${end(markdown, section.id)}\n`;

export interface SplicedFile extends Spliced {
  readonly path: string;
  /** The text before the splice. */
  readonly current: string;
}

/** Each file with generated sections, spliced with the sections that its sources render. */
export const spliceFiles = (
  read: (path: string) => string,
  justfile: Justfile,
  workflow: Workflow,
): ReadonlyArray<SplicedFile> => {
  const sections = renderSections(justfile, workflow);

  return Object.entries(generatedFiles).map(([path, ids]) => {
    const current = read(path);

    return {
      path,
      current,
      ...spliceSections(
        current,
        ids.map((id) => sections[id]),
        /\.ya?ml$/u.test(path) ? yaml : markdown,
      ),
    };
  });
};

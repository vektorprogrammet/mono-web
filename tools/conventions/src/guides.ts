/**
 * The module guides: an `AGENTS.md` in every app, package, and context folder, and a `CLAUDE.md`
 * beside it that imports it (`@AGENTS.md`). A file, not a symbolic link, so a clone without
 * symbolic links and an editor that refuses to write through one both see the same instructions.
 *
 * A guide opens with its generated part, between markers. For a context folder, that part states
 * the bounded context from `docs/model/contexts.cml`: its responsibility, the aggregates that it
 * owns, what it uses but does not own, its upstream and downstream relationships, and the role of
 * the layer. Every guide lists the entry points that `exports` in `package.json` gives the folder
 * and the constructs that the folder defines. Local invariants, pitfalls, and recipes are written
 * by hand below the end marker, and `just guides write` keeps them. A folder's README stays the
 * human guide; the generated part links to it.
 */
import { posix } from "node:path";
import type { Finding } from "./check.js";
import {
  type BoundedContext,
  contextFolderName,
  type ContextModel,
  type Relationship,
} from "./cml.js";
import { catalogue, type Construct } from "./constructs.js";
import {
  contextLayerRoles,
  contextLayers,
  contextMap,
  type FolderException,
  packageDirectories,
  sharedKernel,
} from "./layout.js";
import { entryPoints, packageOf, readManifest } from "./modules.js";
import type { Repository } from "./repository.js";
import { emptySection, type Section, spliceSections, table } from "./sections.js";

/** A folder of a context layer, such as `packages/domain/src/placements`. */
export interface ContextFolder {
  readonly layer: string;
  readonly name: string;
  /** What the layer holds, from the layout declaration. */
  readonly role: string;
  /** The bounded context that owns the folder, if any. */
  readonly context: string | undefined;
  /** Why the folder does not carry the name of a bounded context. */
  readonly reason: string | undefined;
}

export interface Guide {
  /** The app, package, tool, or context folder. */
  readonly directory: string;
  readonly folder: ContextFolder | undefined;
}

export const guideFile = "AGENTS.md";

export const linkFile = "CLAUDE.md";

/** The whole content of each `CLAUDE.md`: Claude Code expands the import into the guide. */
export const linkText = `@${guideFile}\n`;

const guideFiles = new Set([guideFile, linkFile]);

/** Every folder that needs a guide: each app, package, and tool, and each context folder. */
const readGuides = (repository: Repository, model: ContextModel): ReadonlyArray<Guide> => {
  // A folder that holds nothing but its guide needs none.
  const contents = repository.paths.filter((path) => !guideFiles.has(posix.basename(path)));

  const contexts = new Map(
    model.contexts.map((context) => [contextFolderName(context.name), context.name]),
  );

  const packages = Object.keys(packageDirectories).flatMap((directory) =>
    contents.some((path) => path.startsWith(`${directory}/`))
      ? [{ directory, folder: undefined }]
      : [],
  );

  const folders = Object.entries(contextLayers).flatMap(([layer, exceptions]) => {
    const names = new Set(
      contents.flatMap((path) => {
        const rest = path.startsWith(`${layer}/`) ? path.slice(layer.length + 1) : "";
        const slash = rest.indexOf("/");

        return slash === -1 ? [] : [rest.slice(0, slash)];
      }),
    );

    const role = Object.entries(contextLayerRoles).find(([key]) => key === layer)?.[1] ?? "";

    return [...names].map((name) => {
      const exception: FolderException | undefined = Object.entries(exceptions).find(
        ([folder]) => folder === name,
      )?.[1];

      return {
        directory: `${layer}/${name}`,
        folder: {
          layer,
          name,
          role,
          context: exception === undefined ? contexts.get(name) : exception.context,
          reason: exception?.reason,
        },
      };
    });
  });

  return [...packages, ...folders].sort((left, right) =>
    left.directory < right.directory ? -1 : left.directory > right.directory ? 1 : 0,
  );
};

const code = (text: string) => `\`${text}\``;

// The Context Mapper relationship roles; `U` and `D` only say which side is which.
const roleNames = {
  OHS: "open host service",
  PL: "published language",
  S: "supplier",
  C: "customer",
  CF: "conformist",
  ACL: "anticorruption layer",
  P: "partnership",
  SK: "shared kernel",
} satisfies Readonly<Record<string, string>>;

const patternOf = (relationship: Relationship): string =>
  [...new Set([...relationship.upstreamRoles, ...relationship.downstreamRoles])]
    .flatMap((role) =>
      role === "U" || role === "D"
        ? []
        : [Object.entries(roleNames).find(([key]) => key === role)?.[1] ?? role],
    )
    .join(", ");

const names = (items: ReadonlyArray<string>): string => {
  const quoted = items.map(code);

  return quoted.length < 2
    ? quoted.join("")
    : `${quoted.slice(0, -1).join(", ")}${quoted.length > 2 ? "," : ""} and ${quoted.at(-1) ?? ""}`;
};

interface Rendering {
  readonly guide: Guide;
  readonly guides: ReadonlyArray<Guide>;
  readonly model: ContextModel;
  readonly constructs: ReadonlyArray<Construct>;
  readonly repository: Repository;
}

// A context name links to its guide in the same layer, when the layer has a folder for it.
const contextLink = (rendering: Rendering, context: string): string => {
  const layer = rendering.guide.folder?.layer;

  const [target] = rendering.guides
    .filter((guide) => guide.folder?.layer === layer && guide.folder?.context === context)
    .sort(
      (left, right) =>
        Number(right.folder?.name === contextFolderName(context)) -
        Number(left.folder?.name === contextFolderName(context)),
    );

  return target === undefined
    ? context
    : `[${context}](${posix.relative(rendering.guide.directory, `${target.directory}/${guideFile}`)})`;
};

const contextSection = (rendering: Rendering, context: BoundedContext): ReadonlyArray<string> => {
  const { relationships } = rendering.model;

  const upstream = relationships.filter(
    (item) => !item.symmetric && item.downstream === context.name,
  );

  const downstream = relationships.filter(
    (item) => !item.symmetric && item.upstream === context.name,
  );

  const partners = relationships.flatMap((item) =>
    !item.symmetric
      ? []
      : item.upstream === context.name
        ? [{ partner: item.downstream, relationship: item }]
        : item.downstream === context.name
          ? [{ partner: item.upstream, relationship: item }]
          : [],
  );

  const used = [
    ...upstream.map((item) => ({ owner: item.upstream, aggregates: item.exposedAggregates })),
    ...partners.map(({ partner, relationship }) => ({
      owner: partner,
      aggregates: relationship.exposedAggregates,
    })),
  ].filter((item) => item.aggregates.length > 0);

  const cml = posix.relative(rendering.guide.directory, contextMap);

  return [
    `## Bounded context: ${context.name}`,
    "",
    `From [${contextMap}](${cml}).`,
    ...(context.domainVisionStatement === undefined ? [] : ["", context.domainVisionStatement]),
    ...(context.responsibilities.length === 0
      ? []
      : ["", "Responsibilities:", "", ...context.responsibilities.map((item) => `- ${item}`)]),
    ...(context.implementationTechnology === undefined
      ? []
      : ["", `Implementation: ${context.implementationTechnology}`]),
    "",
    "### Owns",
    "",
    ...(context.aggregates.length === 0
      ? ["No aggregate."]
      : context.aggregates.map(
          (aggregate) =>
            `- ${code(aggregate.name)}${aggregate.responsibilities.length === 0 ? "" : `: ${aggregate.responsibilities.join("; ")}`}`,
        )),
    "",
    "### Uses but does not own",
    "",
    ...(used.length === 0
      ? ["No aggregate of another context."]
      : used.map((item) => `- ${names(item.aggregates)} of ${contextLink(rendering, item.owner)}`)),
    "",
    "### Upstream",
    "",
    upstream.length === 0
      ? "No upstream context."
      : table(
          ["Context", "Relationship", "Integration"],
          upstream.map((item) => [
            contextLink(rendering, item.upstream),
            patternOf(item),
            item.implementationTechnology ?? "",
          ]),
        ),
    "",
    "### Downstream",
    "",
    downstream.length === 0
      ? "No downstream context."
      : table(
          ["Context", "Relationship", "Exposes", "Integration"],
          downstream.map((item) => [
            contextLink(rendering, item.downstream),
            patternOf(item),
            item.exposedAggregates.map(code).join(", "),
            item.implementationTechnology ?? "",
          ]),
        ),
    ...(partners.length === 0
      ? []
      : [
          "",
          "### Partners",
          "",
          table(
            ["Context", "Relationship", "Integration"],
            partners.map(({ partner, relationship }) => [
              contextLink(rendering, partner),
              patternOf(relationship),
              relationship.implementationTechnology ?? "",
            ]),
          ),
        ]),
  ];
};

const entryPointSection = (rendering: Rendering): ReadonlyArray<string> => {
  const { directory, folder } = rendering.guide;
  const owner = packageOf(directory) ?? directory;
  const manifest = readManifest(rendering.repository, owner);
  const name = manifest?.name;

  const rows =
    name === undefined || manifest?.exports === undefined
      ? []
      : entryPoints(manifest.exports).flatMap(({ subpath, target }) => {
          const path = posix.join(owner, target);
          const module = posix.relative(directory, path);

          return path.startsWith(`${directory}/`)
            ? [
                [
                  code(subpath === "." ? name : `${name}/${subpath.slice(2)}`),
                  `[${module}](${module})`,
                ],
              ]
            : [];
        });

  const manifestLink = posix.relative(directory, `${owner}/package.json`);

  return [
    "## Entry points",
    "",
    rows.length > 0
      ? table(["Import", "Module"], rows)
      : folder === undefined
        ? `The package has no ${code("exports")}, so other packages do not import it.`
        : `No ${code("exports")} entry of [${owner}/package.json](${manifestLink}) points into this folder, so other packages do not import it.`,
  ];
};

const constructSection = (rendering: Rendering): ReadonlyArray<string> => {
  const { directory } = rendering.guide;

  // Each construct belongs to the innermost guide folder that holds it.
  const nested = rendering.guides.filter(
    (guide) => guide.directory !== directory && guide.directory.startsWith(`${directory}/`),
  );

  const owned = rendering.constructs.filter(
    (construct) =>
      construct.path.startsWith(`${directory}/`) &&
      !nested.some((guide) => construct.path.startsWith(`${guide.directory}/`)),
  );

  if (owned.length === 0) return [];

  return [
    "## Constructs",
    "",
    `The shared constructs defined here. [${catalogue}](${posix.relative(directory, catalogue)}) lists their consumers.`,
    "",
    ...owned.map(
      (construct) =>
        `- [${code(construct.name)}](${posix.relative(directory, construct.path)}) (${construct.category}): ${construct.summary}`,
    ),
    "",
  ];
};

const humanGuide = (rendering: Rendering): ReadonlyArray<string> =>
  rendering.repository.paths.includes(`${rendering.guide.directory}/README.md`)
    ? ["The human guide is [README.md](README.md)."]
    : [];

const folderIntro = (rendering: Rendering, folder: ContextFolder): ReadonlyArray<string> => {
  const holds =
    folder.name === sharedKernel
      ? "This folder holds code that several bounded contexts share."
      : folder.context === undefined
        ? `This folder is not a bounded context. ${folder.reason ?? ""}`
        : folder.reason === undefined
          ? `This folder holds the ${folder.context} bounded context in ${code(folder.layer)}.`
          : `This folder holds ${folder.context} code under another name. ${folder.reason}`;

  const others = rendering.guides.filter(
    (guide) =>
      guide.directory !== rendering.guide.directory &&
      folder.context !== undefined &&
      guide.folder?.context === folder.context,
  );

  return [
    holds.trim(),
    folder.role,
    ...humanGuide(rendering),
    ...(others.length === 0
      ? []
      : [
          "",
          `The ${folder.context} context in other folders:`,
          "",
          ...others.map(
            (guide) =>
              `- [${guide.directory}](${posix.relative(rendering.guide.directory, `${guide.directory}/${guideFile}`)})`,
          ),
        ]),
  ];
};

const packageIntro = (rendering: Rendering): ReadonlyArray<string> => {
  const { directory } = rendering.guide;
  const manifest = readManifest(rendering.repository, directory);
  const holds = Object.entries(packageDirectories).find(([key]) => key === directory)?.[1] ?? "";

  return [
    `${holds}.`,
    ...(manifest?.name === undefined ? [] : [`Package ${code(manifest.name)}.`]),
    ...humanGuide(rendering),
  ];
};

const contextFolderSection = (rendering: Rendering): ReadonlyArray<string> => {
  const { directory } = rendering.guide;

  return Object.keys(contextLayers).flatMap((layer) =>
    layer.startsWith(`${directory}/`)
      ? [
          "## Context folders",
          "",
          `Each folder of ${code(posix.relative(directory, layer))} holds a bounded context of [${contextMap}](${posix.relative(directory, contextMap)}), the shared kernel, or code that the layout declaration excepts. Each has its own guide.`,
          "",
          table(
            ["Folder", "Bounded context", "Guide"],
            rendering.guides.flatMap(({ directory: folderDirectory, folder }) =>
              folder?.layer === layer
                ? [
                    [
                      code(folder.name),
                      folder.name === sharedKernel ? "shared kernel" : (folder.context ?? "none"),
                      `[${guideFile}](${posix.relative(directory, `${folderDirectory}/${guideFile}`)})`,
                    ],
                  ]
                : [],
            ),
          ),
          "",
        ]
      : [],
  );
};

/** The generated part of one guide. */
const renderGuide = (rendering: Rendering): Section => {
  const { directory, folder } = rendering.guide;

  const context =
    folder?.context === undefined
      ? undefined
      : rendering.model.contexts.find((item) => item.name === folder.context);

  const body = [
    `# ${directory}`,
    "",
    ...(folder === undefined ? packageIntro(rendering) : folderIntro(rendering, folder)),
    "",
    ...(folder === undefined ? contextFolderSection(rendering) : []),
    ...(context === undefined ? [] : [...contextSection(rendering, context), ""]),
    ...entryPointSection(rendering),
    "",
    ...constructSection(rendering),
    `Local invariants, pitfalls, and recipes go below this generated part; ${code("just guides write")} keeps them.`,
  ];

  return {
    id: "guide",
    source: `${contextMap}, the @construct tags, and package.json exports`,
    recipe: "just guides write",
    body: body.join("\n"),
  };
};

/** The complete text of a guide: the generated part, then what is written by hand. */
export const guideText = (current: string | undefined, section: Section): string => {
  const fresh = spliceSections(emptySection(section), [section]).text;

  if (current === undefined) return fresh;

  const spliced = spliceSections(current, [section]);

  return spliced.missing.length === 0 ? spliced.text : `${fresh}\n${current}`;
};

export interface GuideSet {
  readonly guides: ReadonlyArray<Guide>;
  readonly sections: ReadonlyMap<string, Section>;
}

/** Every guide and its generated part. */
export const renderGuides = (
  repository: Repository,
  model: ContextModel,
  constructs: ReadonlyArray<Construct>,
): GuideSet => {
  const guides = readGuides(repository, model);

  return {
    guides,
    sections: new Map(
      guides.map((guide) => [
        guide.directory,
        renderGuide({ guide, guides, model, constructs, repository }),
      ]),
    ),
  };
};

/** Missing guides and links, stale generated parts, and guides of folders that need none. */
export const checkGuides = (repository: Repository, set: GuideSet): ReadonlyArray<Finding> => {
  const paths = new Set(repository.paths);
  const findings: Array<Finding> = [];

  for (const guide of set.guides) {
    const agents = `${guide.directory}/${guideFile}`;
    const link = `${guide.directory}/${linkFile}`;
    const section = set.sections.get(guide.directory);

    if (!paths.has(agents))
      findings.push({ path: agents, message: "is missing; run just guides write" });
    else if (section !== undefined) {
      const text = repository.read(agents);
      const spliced = spliceSections(text, [section]);

      if (spliced.missing.length > 0)
        findings.push({
          path: agents,
          message:
            "lacks one begin and one end marker of its generated part; run just guides write",
        });
      else if (spliced.text !== text)
        findings.push({
          path: agents,
          message: `has a generated part that differs from ${contextMap}, the @construct tags, or package.json exports; run just guides write`,
        });
    }

    if (!paths.has(link))
      findings.push({ path: link, message: `is missing; run just guides write` });
    else if (repository.links.has(link) || repository.read(link) !== linkText)
      findings.push({
        path: link,
        message: `must be a file that holds only ${JSON.stringify(linkText.trim())}; run just guides write`,
      });
  }

  const directories = new Set(set.guides.map((guide) => guide.directory));

  for (const path of repository.paths)
    if (
      posix.basename(path) === guideFile &&
      !directories.has(posix.dirname(path)) &&
      !repository.links.has(path) &&
      repository.read(path).startsWith('[//]: # "guide: generated ')
    )
      findings.push({
        path,
        message: `is the module guide of a folder that needs none; remove it and its ${linkFile}`,
      });

  return findings;
};

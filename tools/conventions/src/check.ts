/**
 * The layout rules. Each finding names a path and what to change; the declaration in
 * `layout.ts` is the only place to allow an exception.
 */
import { posix } from "node:path";
import { Schema } from "effect";
import { boundedContextNames, contextFolderName } from "./cml.js";
import type { Justfile } from "./justfile.js";
import {
  contextLayers,
  contextMap,
  packageDirectories,
  packageRoots,
  rootFiles,
  rootScripts,
  sharedKernel,
  toolImportExceptions,
  topLevelDirectories,
} from "./layout.js";
import type { Repository } from "./repository.js";
import { generatedFiles, renderSections, spliceSections } from "./sections.js";

export interface Finding {
  readonly path: string;
  readonly message: string;
}

const declaration = "tools/conventions/src/layout.ts";

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optional(Schema.String),
    scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);

const decodeManifest = Schema.decodeSync(Manifest);

const absent = (entry: string): Finding => ({
  path: declaration,
  message: `declares ${entry}, which does not exist; remove the entry`,
});

const topLevelFindings = (repository: Repository): ReadonlyArray<Finding> => {
  const findings: Array<Finding> = [];
  const present = new Set<string>();

  for (const path of repository.paths) {
    const slash = path.indexOf("/");
    const entry = slash === -1 ? path : path.slice(0, slash);

    if (present.has(entry)) continue;
    present.add(entry);

    if (
      slash === -1 ? !Object.hasOwn(rootFiles, entry) : !Object.hasOwn(topLevelDirectories, entry)
    )
      findings.push({
        path: slash === -1 ? entry : `${entry}/`,
        message: `is not a declared top-level entry. Top-level entries are ${Object.keys(topLevelDirectories).join(", ")}, and the root files that ${declaration} lists`,
      });
  }

  for (const entry of [...Object.keys(topLevelDirectories), ...Object.keys(rootFiles)])
    if (!present.has(entry)) findings.push(absent(`the top-level entry ${entry}`));

  return findings;
};

const packageFindings = (repository: Repository): ReadonlyArray<Finding> => {
  const findings: Array<Finding> = [];
  const present = new Set<string>();

  for (const path of repository.paths) {
    const segments = path.split("/");
    const [root = "", name = ""] = segments;
    const inRoot = packageRoots.some((packageRoot) => packageRoot === root);

    if (
      segments.at(-1) === "package.json" &&
      path !== "package.json" &&
      !(inRoot && segments.length === 3)
    )
      findings.push({
        path,
        message: `is a package outside ${packageRoots.map((packageRoot) => `${packageRoot}/`).join(", ")}; a package.json sits directly in a directory of a package root`,
      });

    if (!inRoot) continue;

    if (segments.length === 2) {
      findings.push({
        path,
        message: `is a loose file in ${root}/, which holds only app, package, and tool directories`,
      });

      continue;
    }

    const directory = `${root}/${name}`;

    if (present.has(directory)) continue;
    present.add(directory);

    if (!Object.hasOwn(packageDirectories, directory))
      findings.push({
        path: `${directory}/`,
        message: `is not declared; add it with what it holds to packageDirectories in ${declaration}`,
      });
  }

  for (const directory of Object.keys(packageDirectories))
    if (!present.has(directory)) findings.push(absent(`the directory ${directory}`));

  return findings;
};

const contextFindings = (repository: Repository): ReadonlyArray<Finding> => {
  const findings: Array<Finding> = [];
  const contexts = new Set(boundedContextNames(repository.read(contextMap)));
  const contextFolders = new Set([...contexts].map(contextFolderName));

  for (const [layer, exceptions] of Object.entries(contextLayers)) {
    const folders = new Set(
      repository.paths.flatMap((path) => {
        if (!path.startsWith(`${layer}/`)) return [];

        const rest = path.slice(layer.length + 1);
        const slash = rest.indexOf("/");

        return slash === -1 ? [] : [rest.slice(0, slash)];
      }),
    );

    for (const folder of folders) {
      const named = contextFolders.has(folder) || folder === sharedKernel;
      const excepted = Object.hasOwn(exceptions, folder);

      if (named && excepted)
        findings.push({
          path: declaration,
          message: `lists ${layer}/${folder}, which already has a bounded context name; remove the entry`,
        });
      else if (!named && !excepted)
        findings.push({
          path: `${layer}/${folder}/`,
          message: `is not a bounded context of ${contextMap}. Name the folder after a context in kebab case, move shared code to ${sharedKernel}, or add the folder with its reason to contextLayers in ${declaration}`,
        });
    }

    for (const [folder, exception] of Object.entries(exceptions)) {
      if (!folders.has(folder)) findings.push(absent(`the context folder ${layer}/${folder}`));

      if ("context" in exception && !contexts.has(exception.context))
        findings.push({
          path: declaration,
          message: `assigns ${layer}/${folder} to ${exception.context}, which is not a bounded context of ${contextMap}`,
        });
    }
  }

  return findings;
};

// Static and dynamic imports, re-exports, and require calls. Comments are not parsed; an
// import-shaped comment would count, which errs on the side of the rule.
const specifier =
  /\b(?:from|import)\s*\(?\s*["']([^"'\n]+)["']|\brequire\s*\(\s*["']([^"'\n]+)["']/gu;

const sourceFile = /\.(?:[cm]?[jt]sx?)$/u;

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const toolImportFindings = (repository: Repository): ReadonlyArray<Finding> => {
  const findings: Array<Finding> = [];
  const used = new Set<string>();
  const toolByPackage = new Map<string, string>();

  for (const path of repository.paths) {
    const segments = path.split("/");

    if (segments.length === 3 && segments[0] === "tools" && segments[2] === "package.json") {
      const { name } = decodeManifest(repository.read(path));

      if (name !== undefined) toolByPackage.set(name, `tools/${segments[1]}`);
    }
  }

  const exceptionFor = (importer: string, tool: string): string | undefined => {
    for (const exception of toolImportExceptions)
      if (exception.tool === tool)
        for (const prefix of exception.importers)
          if (importer.startsWith(prefix)) return `${tool} ${prefix}`;

    return undefined;
  };

  for (const path of repository.paths) {
    if (!path.startsWith("apps/") && !path.startsWith("packages/")) continue;

    const segments = path.split("/");

    if (segments.length === 3 && segments[2] === "package.json") {
      const manifest = decodeManifest(repository.read(path));
      const packageDirectory = `${segments[0]}/${segments[1]}/`;

      for (const field of dependencyFields)
        for (const dependency of Object.keys(manifest[field] ?? {})) {
          const tool = toolByPackage.get(dependency);

          if (
            tool !== undefined &&
            !toolImportExceptions.some(
              (exception) =>
                exception.tool === tool &&
                exception.importers.some((prefix) => prefix.startsWith(packageDirectory)),
            )
          )
            findings.push({
              path,
              message: `depends on ${dependency} from ${tool}/; apps and packages never import tools`,
            });
        }

      continue;
    }

    if (!sourceFile.test(path)) continue;

    for (const match of repository.read(path).matchAll(specifier)) {
      const imported = match[1] ?? match[2] ?? "";

      const tool = imported.startsWith(".")
        ? /^(tools\/[^/]+)(?:\/|$)/u.exec(posix.join(posix.dirname(path), imported))?.[1]
        : toolByPackage.get(
            imported
              .split("/")
              .slice(0, imported.startsWith("@") ? 2 : 1)
              .join("/"),
          );

      if (tool === undefined) continue;

      const exception = exceptionFor(path, tool);

      if (exception === undefined)
        findings.push({
          path,
          message: `imports ${imported} from ${tool}/; apps and packages never import tools. Move the shared code into a package, or add an exception with its reason to toolImportExceptions in ${declaration}`,
        });
      else used.add(exception);
    }
  }

  for (const exception of toolImportExceptions)
    for (const prefix of exception.importers)
      if (!used.has(`${exception.tool} ${prefix}`))
        findings.push({
          path: declaration,
          message: `allows ${prefix} to import ${exception.tool}, but no file there does; remove the importer`,
        });

  return findings;
};

const rootScriptFindings = (repository: Repository): ReadonlyArray<Finding> => {
  const scripts = decodeManifest(repository.read("package.json")).scripts ?? {};

  return [
    ...Object.keys(scripts).flatMap((script) =>
      Object.hasOwn(rootScripts, script)
        ? []
        : [
            {
              path: "package.json",
              message: `has the root script ${script}. Commands are justfile recipes; root scripts are only what Bun, Turbo, and tools run (rootScripts in ${declaration})`,
            },
          ],
    ),
    ...Object.keys(rootScripts).flatMap((script) =>
      Object.hasOwn(scripts, script) ? [] : [absent(`the root script ${script}`)],
    ),
  ];
};

// Fenced code blocks first, then inline code spans of the remaining text.
const fencedCode = /^(`{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gmu;

const inlineCode = /`[^`\n]+`/gu;

const recipeMention = /(?:^|[\s;&|(`])just[ \t]+([A-Za-z_][\w-]*)/gmu;

// The changelog quotes old commits, and active specifications describe commands to come.
const commandMentionFindings = (
  repository: Repository,
  justfile: Justfile,
): ReadonlyArray<Finding> =>
  repository.paths.flatMap((path) => {
    if (
      !/\.mdx?$/u.test(path) ||
      repository.links.has(path) ||
      path === "CHANGELOG.md" ||
      path.startsWith("docs/specs/")
    )
      return [];

    const text = repository.read(path);

    const code = [
      ...[...text.matchAll(fencedCode)].map(([block]) => block),
      ...[...text.replaceAll(fencedCode, "").matchAll(inlineCode)].map(([span]) => span),
    ];

    return [
      ...new Set(
        code.flatMap((segment) =>
          [...segment.matchAll(recipeMention)].map(([, name = ""]) => name),
        ),
      ),
    ].flatMap((name) =>
      justfile.names.has(name)
        ? []
        : [{ path, message: `mentions just ${name}, which is not a recipe of the justfile` }],
    );
  });

const sectionFindings = (repository: Repository, justfile: Justfile): ReadonlyArray<Finding> => {
  const sections = renderSections(justfile);

  return Object.entries(generatedFiles).flatMap(([path, ids]) => {
    const text = repository.read(path);

    const spliced = spliceSections(
      text,
      ids.map((id) => sections[id]),
    );

    return [
      ...spliced.missing.map((id) => ({
        path,
        message: `lacks one begin and one end marker of the generated ${id} section`,
      })),
      ...(spliced.text === text
        ? []
        : [
            {
              path,
              message:
                "has generated sections that differ from their sources; run just layout write",
            },
          ]),
    ];
  });
};

/** Every layout finding of the repository, sorted by path. */
export const checkLayout = (repository: Repository, justfile: Justfile): ReadonlyArray<Finding> =>
  [
    ...topLevelFindings(repository),
    ...packageFindings(repository),
    ...contextFindings(repository),
    ...toolImportFindings(repository),
    ...rootScriptFindings(repository),
    ...commandMentionFindings(repository, justfile),
    ...sectionFindings(repository, justfile),
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

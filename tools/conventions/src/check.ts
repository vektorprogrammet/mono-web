/**
 * The layout rules. Each finding names a path and what to change; the declarations in `layout.ts`
 * and `journeys.ts` are the only places to allow an exception.
 */
import { matchesGlob, posix } from "node:path";
import { Schema } from "effect";
import { boundedContextNames, contextFolderName } from "./cml.js";
import { checkJourneys, readWorkflow, testsWorkflow } from "./journeys.js";
import type { Justfile } from "./justfile.js";
import {
  contentFiles,
  contentFolder,
  contextLayers,
  contextMap,
  generatedDirectory,
  generators,
  packageDirectories,
  packageRoots,
  rootFiles,
  rootScripts,
  sharedKernel,
  sharedVitestConfig,
  toolImportExceptions,
  topLevelDirectories,
} from "./layout.js";
import type { Repository } from "./repository.js";
import { spliceFiles } from "./sections.js";

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

// A script that runs the Vitest binary, alone or after another command.
const vitestScript = /(?:^|[\s;&|(])vitest(?:\s|$)/u;

// The names that Vitest's findConfigFile tries first, before any vite.config.*.
const vitestConfigName = /^vitest\.config\.[cm]?[jt]s$/u;

// An import in a comment must not satisfy the rule.
const comments = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu;

const sourceExtension = /\.[cm]?[jt]s$/u;

/**
 * Vitest looks up its configuration in the working directory only, so a root configuration does
 * not reach `bun run --cwd <workspace> vitest`. Each workspace that runs Vitest merges the shared one.
 */
const vitestConfigFindings = (repository: Repository): ReadonlyArray<Finding> =>
  repository.paths.flatMap((path) => {
    const [root = "", , file, ...rest] = path.split("/");

    if (
      file !== "package.json" ||
      rest.length > 0 ||
      !packageRoots.some((packageRoot) => packageRoot === root)
    )
      return [];

    const scripts = decodeManifest(repository.read(path)).scripts ?? {};

    if (!Object.values(scripts).some((script) => vitestScript.test(script))) return [];

    const directory = posix.dirname(path);

    const configs = repository.paths.filter(
      (candidate) =>
        posix.dirname(candidate) === directory && vitestConfigName.test(posix.basename(candidate)),
    );

    if (configs.length === 0)
      return [
        {
          path,
          message: `runs Vitest, but ${directory} has no vitest.config.ts. Vitest reads its configuration from the working directory only; add one that merges ${sharedVitestConfig}`,
        },
      ];

    const base = sharedVitestConfig.replace(sourceExtension, "");

    return configs.flatMap((config) => {
      const text = repository.read(config).replaceAll(comments, "");

      const importsBase = [...text.matchAll(specifier)].some(([, imported = "", required = ""]) => {
        const target = imported || required;

        return (
          target.startsWith(".") &&
          posix.join(directory, target).replace(sourceExtension, "") === base
        );
      });

      // Importing the base without composing it leaves Vitest's worker default unbounded.
      const appliesBase = /\bmergeConfig\s*\(\s*sharedVitestConfig\s*,/u.test(text);
      const overridesBound = /\b(?:maxWorkers|globalSetup)\s*:/u.test(text);

      return importsBase && appliesBase && !overridesBound
        ? []
        : [
            {
              path: config,
              message: `must merge ${sharedVitestConfig} first without overriding its worker or admission settings`,
            },
          ];
    });
  });

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
      path.startsWith(`${contentFolder}/specs/`) ||
      path.startsWith(`${generatedDirectory}/specs/`)
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

/** A marker line of a generated file or section, which names the recipe that writes it. */
const markerLine =
  /^\[\/\/\]: # "(?:[\w-]+: )?generated from .+ by (just [a-z][\w-]*(?: [a-z][\w-]*)*); do not edit"$/u;

/** The lines near the top of a generated file where its marker stands. */
const markerLines = 5;

const contentPath = new RegExp(
  `^(?:${contentFolder}|(?:${packageRoots.join("|")})/[^/]+/${contentFolder})/`,
  "u",
);

const generatorFindings = (): ReadonlyArray<Finding> =>
  Object.entries(generators).flatMap(([recipe, generator]) =>
    generator.outputs.flatMap((output) =>
      output.startsWith(`${generatedDirectory}/`)
        ? []
        : [
            {
              path: declaration,
              message: `lets ${recipe} write ${output}; a generator writes only into ${generatedDirectory}/, never into a ${contentFolder}/ folder`,
            },
          ],
    ),
  );

/**
 * Every file in the generated directory names a registered generator whose outputs hold it, and
 * every file in a content folder is written by hand and of a kind that the folder holds.
 */
const documentationFindings = (repository: Repository): ReadonlyArray<Finding> =>
  repository.paths.flatMap((path): ReadonlyArray<Finding> => {
    if (path.startsWith(`${generatedDirectory}/`)) {
      const recipe = repository
        .read(path)
        .split("\n", markerLines)
        .map((line) => markerLine.exec(line)?.[1])
        .find((match) => match !== undefined);

      const generator = Object.entries(generators).find(([name]) => name === recipe)?.[1];

      if (generator?.outputs.some((output) => matchesGlob(path, output)) === true) return [];

      return [
        {
          path,
          message:
            recipe === undefined
              ? `is written by hand, but ${generatedDirectory}/ holds only generated files. Write the page in a ${contentFolder}/ folder, whose Markdown just docs generate writes here`
              : `names ${recipe}, which the generators in ${declaration} do not register for this path`,
        },
      ];
    }

    if (!contentPath.test(path)) return [];

    const name = posix.basename(path);
    const kind = Object.hasOwn(contentFiles, name) ? name : posix.extname(path);

    if (!Object.hasOwn(contentFiles, kind))
      return [
        {
          path,
          message: `is not a kind of file that a ${contentFolder}/ folder holds: ${Object.keys(contentFiles).join(", ")}`,
        },
      ];

    const recipe = repository
      .read(path)
      .split("\n")
      .map((line) => markerLine.exec(line)?.[1])
      .find((match) => match !== undefined);

    return recipe === undefined
      ? []
      : [
          {
            path,
            message: `holds what ${recipe} writes, but no generator writes into a ${contentFolder}/ folder. Render generated content from its source in apps/docs`,
          },
        ];
  });

const sectionFindings = (repository: Repository, justfile: Justfile): ReadonlyArray<Finding> =>
  spliceFiles(repository.read, justfile).flatMap(({ path, current, text, missing }) => [
    ...missing.map((id) => ({
      path,
      message: `lacks one begin and one end marker of the generated ${id} section`,
    })),
    ...(text === current
      ? []
      : [
          {
            path,
            message: "has generated sections that differ from their sources; run just layout write",
          },
        ]),
  ]);

/** Every layout finding of the repository, sorted by path. */
export const checkLayout = (repository: Repository, justfile: Justfile): ReadonlyArray<Finding> => {
  const workflow = readWorkflow(repository.read(testsWorkflow));

  return [
    ...topLevelFindings(repository),
    ...packageFindings(repository),
    ...contextFindings(repository),
    ...toolImportFindings(repository),
    ...rootScriptFindings(repository),
    ...vitestConfigFindings(repository),
    ...commandMentionFindings(repository, justfile),
    ...generatorFindings(),
    ...documentationFindings(repository),
    ...checkJourneys(repository, justfile, workflow),
    ...sectionFindings(repository, justfile),
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
};

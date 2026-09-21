import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import * as z from "zod";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const docsRoot = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(docsRoot, "../..");
const generatedRoot = process.env.DOCS_GENERATED_ROOT
  ? resolve(process.env.DOCS_GENERATED_ROOT)
  : docsRoot;
const outputRoot = join(generatedRoot, "src/pages/reference/code");
const repositoryUrl = "https://github.com/vektorprogrammet/mono-web";
const docgenVersion = "4.0.0-rc.109";
const docgenTypeScriptVersion = "6.0.2";
const require = createRequire(import.meta.url);
const typescriptDocgenExecutable = join(
  dirname(require.resolve("typescript-docgen/package.json")),
  "bin/tsc",
);

const PackageSchema = z.object({
  name: z.string(),
  version: z.string(),
});

type PackageMetadata = z.infer<typeof PackageSchema>;

type LibraryConfig = {
  readonly label: string;
  readonly packageDirectory: string;
  readonly select: (sourcePath: string) => boolean;
  readonly slug: string;
};

type GeneratedModule = {
  readonly label: string;
  readonly outputPath: string;
  readonly sourcePath: string;
};

type GeneratedLibrary = {
  readonly library: LibraryConfig;
  readonly metadata: PackageMetadata;
  readonly modules: ReadonlyArray<GeneratedModule>;
};

const libraries: ReadonlyArray<LibraryConfig> = [
  {
    label: "Domain",
    packageDirectory: "packages/domain",
    slug: "domain",
    select: (path) =>
      /^(capabilities|data|runtime-services|schema)\.ts$/.test(path) ||
      /^authz\/(decision|rules|schema)\.ts$/.test(path) ||
      /^receipt\/(approval-list|authority|auxiliary-service|effects|errors|file-errors|file-service|schema|service|update)\.ts$/.test(
        path,
      ) ||
      /^application\/(digest|effects|errors|schema|validation)\.ts$/.test(path) ||
      /^admission-period\/(context|digest|effects|errors|schema|update)\.ts$/.test(path) ||
      /^admissions\/service\.ts$/.test(path) ||
      /^organization\/(administration|administration-schema|authority|directory|errors|import|mailing-lists|schema|service|transitions)\.ts$/.test(
        path,
      ) ||
      /^content\/(actor|content-service|errors|journeys|news|projection|sanitize|schema|service)\.ts$/.test(
        path,
      ) ||
      /^profile\/(errors|schema|service)\.ts$/.test(path) ||
      /^schools\/(authority|directory|errors|schema|service)\.ts$/.test(path) ||
      /^identity\/(errors|schema|service)\.ts$/.test(path) ||
      /^recruitment\/(conduct|effects|errors|schema|service)\.ts$/.test(path) ||
      /^notification\/service\.ts$/.test(path),
  },
  {
    label: "SDK",
    packageDirectory: "packages/sdk",
    slug: "sdk",
    select: (path) =>
      /^(config|effect-client|errors|promise)\.ts$/.test(path) || /^schemas\/[^/]+\.ts$/.test(path),
  },
  {
    label: "HTTP API",
    packageDirectory: "packages/http-api",
    slug: "http-api",
    select: (path) => /^[^/]+\.ts$/.test(path) && path !== "index.ts",
  },
];

const readFiles = async (directory: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
};

const run = async (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> => {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`),
      );
    });
  });
};

const shiftDocgenHeadings = (markdown: string, moduleName: string): string => {
  let fenced = false;
  let foundOverview = false;

  return markdown
    .split("\n")
    .map((line) => {
      if (/^(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      if (!foundOverview && line === `## ${moduleName} overview`) {
        foundOverview = true;
        return "## Overview";
      }
      const heading = /^(#{1,5}) (.+)$/.exec(line);
      if (!heading) return line;
      return `${"#".repeat(heading[1].length + 1)} ${heading[2]}`;
    })
    .join("\n");
};

const moduleLabel = (sourcePath: string): string =>
  sourcePath.replace(/\.ts$/, "").replaceAll("/", " / ");

const makeModulePage = (
  library: LibraryConfig,
  packageJson: PackageMetadata,
  sourcePath: string,
  markdown: string,
): string => {
  const sourceRepositoryPath = `${library.packageDirectory}/src/${sourcePath}`;
  const sourceUrl = `${repositoryUrl}/blob/main/${sourceRepositoryPath}`;
  const moduleName = basename(sourcePath);
  const docgenSourceUrl = `${repositoryUrl}/blob/main/${library.packageDirectory}/src/${moduleName}`;
  const correctedSource = markdown
    .replace(/^---\n[\s\S]*?\n---\n+/, "")
    .replaceAll(docgenSourceUrl, sourceUrl);
  const body = shiftDocgenHeadings(correctedSource, moduleName).trim();
  const label = moduleLabel(sourcePath);

  return `---
title: ${library.label} / ${label}
description: Generated code reference for ${sourceRepositoryPath}.
showAskAi: false
---

# ${library.label} / \`${label}\`

> Generated by \`@effect/docgen@${docgenVersion}\` from [\`${sourceRepositoryPath}\`](${sourceUrl}).
> Package: \`${packageJson.name}@${packageJson.version}\`.
> The docs tool uses \`typescript-docgen@${docgenTypeScriptVersion}\`.
> The repository TypeScript 7 checker remains separate.
> Edit the source comments, then run \`bun run docs:generate\`.

${body}
`;
};

const packagePage = (
  library: LibraryConfig,
  packageJson: PackageMetadata,
  modules: ReadonlyArray<GeneratedModule>,
): string => `---
title: ${library.label} code reference
description: Generated module index for ${packageJson.name}.
showAskAi: false
---

# ${library.label} code reference

This reference comes from public source comments in [\`${library.packageDirectory}/src\`](${repositoryUrl}/tree/main/${library.packageDirectory}/src).
It documents \`${packageJson.name}@${packageJson.version}\` with \`@effect/docgen@${docgenVersion}\`.
The docs tool uses \`typescript-docgen@${docgenTypeScriptVersion}\`.

The generator excludes tests, runtime entrypoints, persistence adapters, workers, proof programs, and private implementation modules.

## Modules

${modules.map((module) => `- [\`${module.label}\`](${module.outputPath})`).join("\n")}
`;

const landingPage = (
  packages: ReadonlyArray<{
    readonly library: LibraryConfig;
    readonly metadata: PackageMetadata;
    readonly moduleCount: number;
  }>,
): string => `---
title: Code reference
description: Generated reference for selected public Vektorprogrammet TypeScript libraries.
showAskAi: false
---

# Code reference

This reference comes from TypeScript source comments through \`@effect/docgen@${docgenVersion}\`.
Generated Markdown is a deterministic derivative and is not a source of code documentation.
The docs tool uses \`typescript-docgen@${docgenTypeScriptVersion}\`.
The repository TypeScript 7 checker remains separate.

## Public libraries

${packages
  .map(
    ({ library, metadata, moduleCount }) =>
      `- [${library.label}](/reference/code/${library.slug}) documents ${moduleCount} selected modules from \`${metadata.name}@${metadata.version}\`.`,
  )
  .join("\n")}

Edit a public source comment to improve this reference.
Then run \`bun run docs:generate\` and commit the generated change.
`;

const generateLibrary = async (
  library: LibraryConfig,
  temporaryRoot: string,
): Promise<GeneratedLibrary> => {
  const packageRoot = join(repositoryRoot, library.packageDirectory);
  const sourceRoot = join(packageRoot, "src");
  const packageJson = PackageSchema.parse(
    JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
  );
  const sourceFiles = (await readFiles(sourceRoot)).filter((path) => path.endsWith(".ts"));
  const selectedFiles = sourceFiles.filter(library.select);
  const excludedFiles = sourceFiles.filter((path) => !library.select(path));

  if (selectedFiles.length === 0) {
    throw new Error(`No source modules selected for ${packageJson.name}.`);
  }

  const docgenOutput = join(temporaryRoot, library.slug);
  const sourceLink = `${repositoryUrl}/blob/main/${library.packageDirectory}/src/`;
  const excludeArgs = excludedFiles.flatMap((path) => ["--exclude", `src/${path}`]);

  await run(
    "docgen",
    [
      "--src",
      "src",
      "--out",
      docgenOutput,
      "--homepage",
      repositoryUrl,
      "--srcLink",
      sourceLink,
      "--disable-search",
      "--no-enforce-version",
      "--parse-tsconfig-file",
      "tsconfig.json",
      ...excludeArgs,
    ],
    packageRoot,
    {
      ...process.env,
      DOCGEN_TSC_EXECUTABLE: typescriptDocgenExecutable,
    },
  );

  const docgenModulesRoot = join(docgenOutput, "modules");
  const generatedFiles = (await readFiles(docgenModulesRoot)).filter((path) =>
    path.endsWith(".ts.md"),
  );

  if (generatedFiles.length !== selectedFiles.length) {
    throw new Error(
      `${packageJson.name} selected ${selectedFiles.length} modules but docgen wrote ${generatedFiles.length}.`,
    );
  }

  const packageOutputRoot = join(outputRoot, library.slug);
  const modules: Array<GeneratedModule> = [];

  const sourceMarker = `${library.packageDirectory}/src/`;
  for (const generatedFile of generatedFiles) {
    const sourceStart = generatedFile.indexOf(sourceMarker);
    if (sourceStart < 0) {
      throw new Error(`Docgen output is outside ${sourceMarker}: ${generatedFile}`);
    }
    const sourcePath = generatedFile.slice(sourceStart + sourceMarker.length).replace(/\.md$/, "");
    const routePath = sourcePath.replace(/\.ts$/, "");
    const targetPath = join(packageOutputRoot, "modules", `${routePath}.mdx`);
    const route = `/reference/code/${library.slug}/modules/${routePath}`;
    const markdown = await readFile(join(docgenModulesRoot, generatedFile), "utf8");
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, makeModulePage(library, packageJson, sourcePath, markdown));
    modules.push({ label: moduleLabel(sourcePath), outputPath: route, sourcePath });
  }

  modules.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  await writeFile(join(packageOutputRoot, "index.mdx"), packagePage(library, packageJson, modules));

  return { library, metadata: packageJson, modules };
};

const main = async (): Promise<void> => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "vektor-docgen-"));
  await rm(outputRoot, { force: true, recursive: true });
  await mkdir(outputRoot, { recursive: true });

  try {
    const generated: Array<GeneratedLibrary> = [];
    for (const library of libraries) {
      generated.push(await generateLibrary(library, temporaryRoot));
    }
    await writeFile(
      join(outputRoot, "index.mdx"),
      landingPage(
        generated.map(({ library, metadata, modules }) => ({
          library,
          metadata,
          moduleCount: modules.length,
        })),
      ),
    );
    const count = generated.reduce((total, item) => total + item.modules.length, 0);
    process.stdout.write(`generated ${count} code-reference module pages\n`);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

await main();

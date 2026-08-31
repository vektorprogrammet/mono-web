import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const docsRoot = resolve(scriptDirectory, "..");
const formatterConfig = resolve(docsRoot, "../..", ".oxfmtrc.json");
const checkMode = process.argv.includes("--check");
const generatedFiles = [
  "public/migration-state.json",
  "public/migration-state.schema.json",
  "src/pages/reference/design-spec-evidence-index.mdx",
  "src/pages/reference/migration-state.mdx",
  "src/pages/reference/native-api/index.mdx",
] as const;
const generatedDirectories = ["src/pages/reference/code"] as const;
const generatorScripts = [
  "scripts/generate-reference.ts",
  "scripts/generate-openapi-reference.ts",
  "scripts/generate-code-reference.ts",
] as const;

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const readDirectoryFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  if (!(await pathExists(root))) return [];
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
};

const ownedFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  const files = [];
  for (const path of generatedFiles) {
    if (await pathExists(join(root, path))) files.push(path);
  }
  for (const directory of generatedDirectories) {
    const entries = await readDirectoryFiles(join(root, directory));
    files.push(...entries.map((path) => `${directory}/${path}`));
  }
  return files.sort();
};

const generatedDigest = async (root: string): Promise<string> => {
  const hash = createHash("sha256");
  for (const path of await ownedFiles(root)) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(join(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
};

const run = async (
  command: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
): Promise<void> => {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: docsRoot,
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

const generate = async (root: string): Promise<void> => {
  const environment = {
    ...process.env,
    DOCS_GENERATED_ROOT: root,
  };
  for (const script of generatorScripts) {
    await run("bun", [script], environment);
  }
  const formatPaths = [
    ...generatedFiles.map((path) => join(root, path)),
    ...generatedDirectories.map((path) => join(root, path)),
  ];
  let digest = await generatedDigest(root);
  for (let pass = 1; pass <= 8; pass += 1) {
    await run("oxfmt", ["--write", `--config=${formatterConfig}`, ...formatPaths], environment);
    const formattedDigest = await generatedDigest(root);
    if (formattedDigest === digest) return;
    digest = formattedDigest;
  }
  throw new Error("Generated Markdown formatting did not reach a fixed point after 8 passes.");
};

type GeneratedComparison = {
  readonly differences: ReadonlyArray<string>;
  readonly expected: ReadonlyArray<string>;
};

const compareGeneratedFiles = async (candidateRoot: string): Promise<GeneratedComparison> => {
  const expected = await ownedFiles(candidateRoot);
  const actual = await ownedFiles(docsRoot);
  const expectedNames = new Set(expected);
  const actualNames = new Set(actual);
  const differences: Array<string> = [];

  for (const path of expected) {
    if (!actualNames.has(path)) {
      differences.push(`missing ${path}`);
      continue;
    }
    const [candidate, current] = await Promise.all([
      readFile(join(candidateRoot, path)),
      readFile(join(docsRoot, path)),
    ]);
    if (!candidate.equals(current)) differences.push(`changed ${path}`);
  }

  for (const path of actual) {
    if (!expectedNames.has(path)) differences.push(`extra ${path}`);
  }

  return { differences, expected };
};

const makeSureGeneratedFilesMatch = async (candidateRoot: string): Promise<void> => {
  const { differences, expected } = await compareGeneratedFiles(candidateRoot);
  if (differences.length > 0) {
    throw new Error(
      `Generated docs are stale:\n${differences.map((difference) => `- ${difference}`).join("\n")}\nRun bun run docs:generate.`,
    );
  }
  process.stdout.write(`generated docs are current (${expected.length} files)\n`);
};

const replaceGeneratedFiles = async (candidateRoot: string): Promise<void> => {
  const { differences, expected } = await compareGeneratedFiles(candidateRoot);
  if (differences.length === 0) {
    process.stdout.write(`generated docs are current (${expected.length} files)\n`);
    return;
  }

  for (const directory of generatedDirectories) {
    await rm(join(docsRoot, directory), { force: true, recursive: true });
  }
  for (const path of expected) {
    const destination = join(docsRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(candidateRoot, path), destination);
  }
  process.stdout.write(`updated generated docs (${expected.length} files)\n`);
};

const main = async (): Promise<void> => {
  const candidateRoot = await mkdtemp(join(tmpdir(), "vektor-docs-generate-"));
  try {
    await generate(candidateRoot);
    if (checkMode) {
      await makeSureGeneratedFilesMatch(candidateRoot);
    } else {
      await replaceGeneratedFiles(candidateRoot);
    }
  } finally {
    await rm(candidateRoot, { force: true, recursive: true });
  }
};

await main();

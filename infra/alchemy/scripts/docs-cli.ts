import { spawnSync as nodeSpawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertDocsDeploymentIdentity, DOCS_IDENTITY } from "../docs/identity.ts";

export type DocsCommand = "state" | "plan" | "deploy";

export type ParsedDocsCommand = {
  readonly command: DocsCommand;
  readonly stage: string;
  readonly profile: string;
  readonly confirmed: boolean;
};

export type SpawnSync = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: "inherit";
  },
) => {
  readonly status: number | null;
  readonly error?: Error;
};

export type DocsCliOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly spawn?: SpawnSync;
  readonly standaloneDirectory?: string;
  readonly report?: (message: string) => void;
};

export class DocsCliUsageError extends Error {}

const ambientSelectorNames: Record<string, true> = {
  ALCHEMY_ENV: true,
  ALCHEMY_ENV_FILE: true,
  ALCHEMY_PROFILE: true,
  ALCHEMY_STAGE: true,
  CLOUDFLARE_PROFILE: true,
  CLOUDFLARE_STAGE: true,
};

const usage = (): string =>
  [
    "usage:",
    `  state --stage ${DOCS_IDENTITY.stage} --profile ${DOCS_IDENTITY.profile}`,
    `  plan --stage ${DOCS_IDENTITY.stage} --profile ${DOCS_IDENTITY.profile}`,
    `  deploy --stage ${DOCS_IDENTITY.stage} --profile ${DOCS_IDENTITY.profile} --yes`,
  ].join("\n");

const usageError = (message: string): never => {
  throw new DocsCliUsageError(message);
};

export const parseDocsCommand = (argv: readonly string[]): ParsedDocsCommand => {
  const tokens = argv.filter((token) => token !== "--");
  const [commandToken, ...options] = tokens;
  const command: DocsCommand =
    commandToken === "state" || commandToken === "plan" || commandToken === "deploy"
      ? commandToken
      : usageError(`unknown command${commandToken === undefined ? "" : ` '${commandToken}'`}`);

  let stage: string | undefined;
  let profile: string | undefined;
  let confirmed = false;
  for (let index = 0; index < options.length; index += 1) {
    const token = options[index];
    if (token === "--stage" || token === "--profile") {
      const name = token.slice(2) as "stage" | "profile";
      if (name === "stage" ? stage !== undefined : profile !== undefined) {
        usageError(`duplicate --${name}`);
      }
      const value = options[index + 1];
      if (value === undefined || value.startsWith("--")) {
        usageError(`--${name} requires one value`);
      }
      index += 1;
      if (name === "stage") stage = value;
      else profile = value;
      continue;
    }
    if (token === "--yes") {
      if (confirmed) usageError("duplicate --yes");
      confirmed = true;
      continue;
    }
    usageError(`unknown argument '${token}'`);
  }

  const selectedStage = stage ?? usageError("docs commands require an explicit --stage value");
  const selectedProfile =
    profile ?? usageError("docs commands require an explicit --profile value");
  try {
    assertDocsDeploymentIdentity({ stage: selectedStage, profile: selectedProfile });
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
  }
  if (command === "deploy" && !confirmed) {
    usageError("deploy requires --yes");
  }
  if (command !== "deploy" && confirmed) {
    usageError(`${command} does not accept --yes`);
  }
  return { command, stage: selectedStage, profile: selectedProfile, confirmed };
};

export const rejectAmbientDocsSelectors = (env: NodeJS.ProcessEnv): void => {
  const found = Object.keys(env).find((name) => ambientSelectorNames[name] === true);
  if (found !== undefined) usageError(`ambient selector '${found}' is not allowed`);
};

const run = (
  file: string,
  args: string[],
  directory: string,
  environment: NodeJS.ProcessEnv,
  spawn: SpawnSync,
): number => {
  const result = spawn(file, args, {
    cwd: directory,
    env: environment,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw new Error(`failed to start ${file}: ${result.error.message}`);
  }
  return result.status ?? 1;
};

const runAlchemy = (parsed: ParsedDocsCommand, options: DocsCliOptions): number => {
  const standaloneDirectory =
    options.standaloneDirectory ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const environment = {
    ...(options.env ?? process.env),
    ALCHEMY_TELEMETRY_DISABLED: "1",
  };
  const spawn = options.spawn ?? nodeSpawnSync;
  const alchemyBinary = resolve(standaloneDirectory, "node_modules/.bin/alchemy");

  if (parsed.command === "state") {
    const stacks = run(
      alchemyBinary,
      ["state", "stacks", "docs.run.ts", "--profile", parsed.profile, "--local"],
      standaloneDirectory,
      environment,
      spawn,
    );
    if (stacks !== 0) return stacks;
    return run(
      alchemyBinary,
      [
        "state",
        "stages",
        "docs.run.ts",
        "--stack",
        DOCS_IDENTITY.stack,
        "--profile",
        parsed.profile,
        "--local",
      ],
      standaloneDirectory,
      environment,
      spawn,
    );
  }

  const args = [
    parsed.command,
    "docs.run.ts",
    "--stage",
    parsed.stage,
    "--profile",
    parsed.profile,
  ];
  if (parsed.command === "deploy") args.push("--yes");
  return run(alchemyBinary, args, standaloneDirectory, environment, spawn);
};

export const executeDocsCli = (argv: readonly string[], options: DocsCliOptions = {}): number => {
  const parsed = parseDocsCommand(argv);
  rejectAmbientDocsSelectors(options.env ?? process.env);
  return runAlchemy(parsed, options);
};

export const main = (
  argv: readonly string[] = process.argv.slice(2),
  options: DocsCliOptions = {},
): number => {
  try {
    return executeDocsCli(argv, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const report =
      options.report ??
      ((line: string): void => {
        process.stderr.write(`${line}\n`);
      });
    report(`docs-cli: ${message}`);
    report(usage());
    return 1;
  }
};

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main());

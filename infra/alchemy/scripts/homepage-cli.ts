import { spawnSync as nodeSpawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type CloudCommand = "plan" | "deploy" | "destroy";

export type ParsedGuardCommand = {
  readonly command: "guard";
  readonly stage: "p000";
};

export type ParsedCloudCommand = {
  readonly command: CloudCommand;
  readonly stage: string;
  readonly profile: string;
  readonly confirmation?: "dry-run" | "yes";
};

export type ParsedCommand = ParsedGuardCommand | ParsedCloudCommand;

export type SpawnSync = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: "inherit";
  },
) => {
  status: number | null;
  error?: Error;
};

export type HomepageCliOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly spawn?: SpawnSync;
  readonly standaloneDirectory?: string;
  readonly report?: (message: string) => void;
};

export class HomepageCliUsageError extends Error {}

const STAGE_PATTERN = /^(?:p(?:00[1-9]|0[1-9][0-9]|[1-9][0-9]{2})|dev-main)$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// These names are selector/credential inputs. The wrapper requires all
// deployment selectors to be present as explicit argv tokens instead.
const AMBIENT_SELECTOR_NAMES = new Set([
  "ALCHEMY_ENV",
  "ALCHEMY_ENV_FILE",
  "ALCHEMY_PROFILE",
  "ALCHEMY_STAGE",
  "AWS_ACCESS_KEY_ID",
  "AWS_DEFAULT_PROFILE",
  "AWS_PROFILE",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_EMAIL",
  "CLOUDFLARE_PROFILE",
  "CLOUDFLARE_STAGE",
]);

const usage = (): string =>
  [
    "usage:",
    "  guard --stage p000",
    "  plan --stage <p001..p999|dev-main> --profile <token>",
    "  deploy --stage <p001..p999|dev-main> --profile <token> --yes",
    "  destroy --stage <p001..p999|dev-main> --profile <token> (--dry-run|--yes)",
  ].join("\n");

const usageError = (message: string): never => {
  throw new HomepageCliUsageError(message);
};

export const parseHomepageCommand = (argv: readonly string[]): ParsedCommand => {
  const [commandToken, ...tokens] = argv;
  if (
    commandToken !== "guard" &&
    commandToken !== "plan" &&
    commandToken !== "deploy" &&
    commandToken !== "destroy"
  ) {
    usageError(`unknown command${commandToken === undefined ? "" : ` '${commandToken}'`}`);
  }

  let stage: string | undefined;
  let profile: string | undefined;
  let confirmation: "dry-run" | "yes" | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--stage" || token === "--profile") {
      const option = token.slice(2) as "stage" | "profile";
      if (option === "stage" ? stage !== undefined : profile !== undefined) {
        usageError(`duplicate --${option}`);
      }
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith("--")) {
        usageError(`--${option} requires one value`);
      }
      index += 1;
      if (option === "stage") stage = value;
      else profile = value;
      continue;
    }

    if (token === "--yes" || token === "--dry-run") {
      if (confirmation !== undefined) usageError("duplicate confirmation flag");
      confirmation = token === "--yes" ? "yes" : "dry-run";
      continue;
    }

    usageError(`unknown argument '${token}'`);
  }

  if (commandToken === "guard") {
    if (stage !== "p000") {
      usageError("guard accepts only --stage p000");
    }
    if (profile !== undefined) usageError("guard does not accept --profile");
    if (confirmation !== undefined) {
      usageError("guard does not accept a confirmation flag");
    }
    return { command: "guard", stage: "p000" };
  }

  if (stage === undefined || !STAGE_PATTERN.test(stage)) {
    usageError("cloud commands require an explicit stage: p001..p999 or dev-main");
  }
  if (profile === undefined || !PROFILE_PATTERN.test(profile)) {
    usageError("cloud commands require an explicit profile token");
  }
  const validatedStage = stage as string;
  const validatedProfile = profile as string;
  if (validatedProfile.toLowerCase() === "default") {
    usageError("cloud commands reject the reserved default profile token");
  }

  if (commandToken === "plan") {
    if (confirmation !== undefined) {
      usageError("plan accepts neither --yes nor --dry-run");
    }
  } else if (commandToken === "deploy") {
    if (confirmation !== "yes") {
      usageError("deploy requires exactly --yes");
    }
  } else if (confirmation === undefined) {
    usageError("destroy requires exactly one of --dry-run or --yes");
  }

  const cloudCommand = commandToken as CloudCommand;
  return {
    command: cloudCommand,
    stage: validatedStage,
    profile: validatedProfile,
    confirmation,
  };
};

export function rejectAmbientSelectors(env: NodeJS.ProcessEnv): void {
  const found = Object.keys(env).filter((name) => AMBIENT_SELECTOR_NAMES.has(name));
  if (found.length > 0) {
    usageError(`ambient selector '${found[0]}' is not allowed`);
  }
}

function runAlchemy(parsed: ParsedCloudCommand, options: HomepageCliOptions): number {
  // Keep this import-free and shell-free: the only executable is the local
  // standalone install, and the declaration is always the checked-in entrypoint.
  const standaloneDirectory =
    options.standaloneDirectory ??
    resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const alchemyBinary = resolve(standaloneDirectory, "node_modules/.bin/alchemy");
  const childEnvironment = {
    ...(options.env ?? process.env),
    ALCHEMY_TELEMETRY_DISABLED: "1",
  };
  const args = [
    parsed.command,
    "alchemy.run.ts",
    "--stage",
    parsed.stage,
    "--profile",
    parsed.profile,
  ];
  if (parsed.confirmation === "yes") args.push("--yes");
  if (parsed.confirmation === "dry-run") args.push("--dry-run");

  const result = (options.spawn ?? nodeSpawnSync)(alchemyBinary, args, {
    cwd: standaloneDirectory,
    env: childEnvironment,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw new Error(`failed to start local Alchemy: ${result.error.message}`);
  }
  return result.status ?? 1;
}

export function executeHomepageCli(
  argv: readonly string[],
  options: HomepageCliOptions = {},
): number {
  const parsed = parseHomepageCommand(argv);

  // This branch is intentionally before any ambient-selector check or child
  // process. It is the complete p000 guard proof.
  if (parsed.command === "guard") {
    return usageError("p000 is reserved for local-only proof");
  }

  rejectAmbientSelectors(options.env ?? process.env);
  return runAlchemy(parsed, options);
}

export function main(
  argv: readonly string[] = process.argv.slice(2),
  options: HomepageCliOptions = {},
): number {
  try {
    return executeHomepageCli(argv, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const report = options.report ?? console.error;
    report(`homepage-cli: ${message}`);
    report(usage());
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main());

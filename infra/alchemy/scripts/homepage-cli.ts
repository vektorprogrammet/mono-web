import { readFileSync, readdirSync } from "node:fs";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APEX_LOCAL_STATE_LOGICAL_IDS } from "../preview/state-contract.ts";
import { APEX_IDENTITY } from "../preview/identity.ts";

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

const STAGE_PATTERN = /^(?:p(?:[1-9][0-9]|00[1-9]|0[1-9][0-9]|[1-9][0-9]{2})|dev-main)$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// These names can select a deployment target. The wrapper requires every
// deployment selector to be present as an explicit argv token instead.
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
  "CLOUDFLARE_EMAIL",
  "CLOUDFLARE_PROFILE",
  "CLOUDFLARE_STAGE",
]);

const usage = (): string =>
  [
    "usage:",
    "  guard --stage p000",
    "  plan --stage <p01..p99|p001..p999|dev-main> --profile <token>",
    "  deploy --stage <p01..p99|p001..p999|dev-main> --profile <token> --yes",
    "  destroy --stage <p01..p99|p001..p999|dev-main> --profile <token> (--dry-run|--yes)",
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

interface ApexLocalStateRecord {
  readonly fqn?: unknown;
  readonly logicalId?: unknown;
  readonly instanceId?: unknown;
  readonly resourceType?: unknown;
  readonly props?: {
    readonly env?: Record<string, unknown>;
    readonly isExternal?: unknown;
  };
  readonly attr?: {
    readonly accountId?: unknown;
    readonly domain?: { readonly aliases?: unknown; readonly name?: unknown };
    readonly routes?: unknown;
    readonly tags?: unknown;
    readonly url?: unknown;
    readonly workerId?: unknown;
    readonly workerName?: unknown;
  };
  readonly providerMode?: unknown;
  readonly removalPolicy?: unknown;
}

export function assertApexLocalState(standaloneDirectory: string): void {
  const stateDirectory = resolve(standaloneDirectory, ".alchemy/state/vektor/dev-main");
  const expectedFiles = [
    "__stack_output__.json",
    ...APEX_LOCAL_STATE_LOGICAL_IDS.map((logicalId) => `${logicalId}.json`),
  ].sort();
  let actualFiles: string[];
  try {
    actualFiles = readdirSync(stateDirectory)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    throw new Error("missing apex local state directory");
  }
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("apex local state file set mismatch");
  }

  const expectedOutput: Record<string, string> = {
    app: APEX_IDENTITY.app,
    apiHostname: APEX_IDENTITY.apiHostname,
    backendHostname: APEX_IDENTITY.backendHostname,
    backendOrigin: APEX_IDENTITY.backendOrigin,
    forbiddenHost: APEX_IDENTITY.forbiddenHost,
    hostname: APEX_IDENTITY.hostname,
    previewStage: APEX_IDENTITY.stage,
    stage: APEX_IDENTITY.stage,
    stateDirectory: APEX_IDENTITY.localStateDirectory,
    target: APEX_IDENTITY.target,
    url: `https://${APEX_IDENTITY.hostname}`,
  };
  let stackOutput: Record<string, unknown>;
  try {
    stackOutput = JSON.parse(
      readFileSync(resolve(stateDirectory, "__stack_output__.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    throw new Error("invalid apex local stack output");
  }
  if (
    JSON.stringify(Object.keys(stackOutput).sort()) !==
      JSON.stringify(Object.keys(expectedOutput).sort()) ||
    Object.entries(expectedOutput).some(([name, value]) => stackOutput[name] !== value)
  ) {
    throw new Error("apex local stack output identity mismatch");
  }

  const records = new Map<string, ApexLocalStateRecord>();
  let accountId: string | undefined;
  for (const logicalId of APEX_LOCAL_STATE_LOGICAL_IDS) {
    let record: ApexLocalStateRecord;
    try {
      record = JSON.parse(
        readFileSync(resolve(stateDirectory, `${logicalId}.json`), "utf8"),
      ) as typeof record;
    } catch {
      throw new Error(`invalid apex local state record: ${logicalId}`);
    }
    const workerName = record.attr?.workerName;
    const expectedTags = [
      "alchemy:stack:vektor",
      `alchemy:stage:${APEX_IDENTITY.stage}`,
      `alchemy:id:${logicalId}`,
    ];
    if (
      record.fqn !== logicalId ||
      record.logicalId !== logicalId ||
      typeof record.instanceId !== "string" ||
      !/^[a-f0-9]{32}$/u.test(record.instanceId) ||
      record.resourceType !== "Cloudflare.Worker" ||
      record.props?.isExternal !== true ||
      record.providerMode !== "live" ||
      record.removalPolicy !== "destroy" ||
      typeof workerName !== "string" ||
      record.attr?.workerId !== workerName ||
      !new RegExp(`^vektor-${logicalId}-${APEX_IDENTITY.stage}-[a-z0-9]{16}$`, "u").test(
        workerName,
      ) ||
      JSON.stringify(record.attr?.tags) !== JSON.stringify(expectedTags) ||
      typeof record.attr?.accountId !== "string" ||
      !/^[a-f0-9]{32}$/u.test(record.attr.accountId)
    ) {
      throw new Error(`apex local state identity mismatch: ${logicalId}`);
    }
    if (accountId !== undefined && record.attr.accountId !== accountId) {
      throw new Error("apex local state account ownership mismatch");
    }
    accountId = record.attr.accountId;
    records.set(logicalId, record);
  }

  const edge = records.get("vektor-apex-worker");
  const homepageName = records.get("vektor-apex-homepage")?.attr?.workerName;
  const dashboardName = records.get("vektor-apex-dashboard")?.attr?.workerName;
  const homepageBinding = edge?.props?.env?.Homepage as
    | { readonly workerId?: unknown; readonly workerName?: unknown }
    | undefined;
  const dashboardBinding = edge?.props?.env?.Dashboard as
    | { readonly workerId?: unknown; readonly workerName?: unknown }
    | undefined;
  const aliases = edge?.attr?.domain?.aliases;
  const routes = edge?.attr?.routes;
  const apiRoute = Array.isArray(routes) && routes.length === 1 ? routes[0] : undefined;
  const hasRestoredApiRoute =
    apiRoute !== null &&
    typeof apiRoute === "object" &&
    "id" in apiRoute &&
    typeof apiRoute.id === "string" &&
    /^[a-f0-9]{32}$/u.test(apiRoute.id) &&
    "pattern" in apiRoute &&
    apiRoute.pattern === `${APEX_IDENTITY.apiHostname}/*` &&
    "zoneId" in apiRoute &&
    typeof apiRoute.zoneId === "string" &&
    /^[a-f0-9]{32}$/u.test(apiRoute.zoneId);
  if (
    homepageBinding?.workerId !== homepageName ||
    homepageBinding?.workerName !== homepageName ||
    dashboardBinding?.workerId !== dashboardName ||
    dashboardBinding?.workerName !== dashboardName ||
    edge?.attr?.url !== `https://${APEX_IDENTITY.hostname}` ||
    edge?.attr?.domain?.name !== APEX_IDENTITY.hostname ||
    JSON.stringify(aliases) !== "[]" ||
    !hasRestoredApiRoute
  ) {
    throw new Error("apex local state binding identity mismatch");
  }
}

function runAlchemy(parsed: ParsedCloudCommand, options: HomepageCliOptions): number {
  // Keep this import-free and shell-free: the only executable is the local
  // standalone install, and the declaration is always the checked-in entrypoint.
  const standaloneDirectory =
    options.standaloneDirectory ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (parsed.stage === "dev-main") {
    assertApexLocalState(standaloneDirectory);
  }
  const alchemyBinary = resolve(standaloneDirectory, "node_modules/.bin/alchemy");
  const childEnvironment = {
    ...(options.env ?? process.env),
    ALCHEMY_TELEMETRY_DISABLED: "1",
    ...(parsed.stage === APEX_IDENTITY.stage
      ? { DASHBOARD_MOUNT: APEX_IDENTITY.dashboardMount }
      : {}),
  };
  const spawn = options.spawn ?? nodeSpawnSync;
  if (parsed.command === "deploy") {
    const sdkDirectory = resolve(standaloneDirectory, "../..", "packages/sdk");
    const sdkBuild = spawn(process.execPath, ["run", "--cwd", sdkDirectory, "build"], {
      cwd: standaloneDirectory,
      env: childEnvironment,
      stdio: "inherit",
    });
    if (sdkBuild.error !== undefined) {
      throw new Error(`failed to build the local SDK: ${sdkBuild.error.message}`);
    }
    if (sdkBuild.status !== 0) return sdkBuild.status ?? 1;
  }

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

  const result = spawn(alchemyBinary, args, {
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
    const report =
      options.report ??
      ((line: string): void => {
        process.stderr.write(`${line}\n`);
      });
    report(`homepage-cli: ${message}`);
    report(usage());
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main());

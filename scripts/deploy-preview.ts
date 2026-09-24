import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";


const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const homepageRoot = resolve(root, "apps/homepage");

const dashboardRoot = resolve(root, "apps/dashboard");

const homepageConfig = resolve(root, "infra/previews/homepage.wrangler.json");

const dashboardConfig = resolve(root, "infra/previews/dashboard.wrangler.json");

const wrangler = resolve(root, "node_modules/.bin/wrangler");

const pullRequestNumber = process.argv[2];

const writeLine = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

if (pullRequestNumber === undefined || !/^[1-9]\d*$/.test(pullRequestNumber)) {
  fail("Usage: bun run deploy:preview -- <pull-request-number>");
}

const previewName = `pr-${pullRequestNumber}`;

const isCi = process.env.CI === "true";

const run = (
  command: string,
  args: ReadonlyArray<string>,
  cwd = root,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env });

  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }

  return result.stdout.trim();
};

const runVisible = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv,
): void => {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });

  if (result.status !== 0) process.exit(result.status ?? 1);
};

const localHead = (): string => {
  const branch = run("git", ["branch", "--show-current"]);

  if (branch.length === 0 || branch === "main") {
    fail("Preview deployment requires a named non-main branch.");
  }

  if (run("git", ["status", "--porcelain", "--untracked-files=no"]).length > 0) {
    fail("Refusing preview deployment from a dirty tracked worktree.");
  }

  const head = run("git", ["rev-parse", "HEAD"]);

  if (head !== run("git", ["rev-parse", `origin/${branch}`])) {
    fail("Refusing preview deployment: HEAD must exactly match the pushed branch revision.");
  }

  return head;
};

const head = isCi ? process.env.PREVIEW_HEAD_SHA : localHead();

if (head === undefined || !/^[0-9a-f]{40}$/.test(head)) {
  fail("PREVIEW_HEAD_SHA must be the exact 40-character pull-request revision.");
}

const PreviewResult = Schema.Struct({ deployment: Schema.optionalKey(Schema.Struct({ urls: Schema.optionalKey(Schema.Array(Schema.String)) })), deployment_urls: Schema.optionalKey(Schema.Array(Schema.String)), preview: Schema.optionalKey(Schema.Struct({ urls: Schema.optionalKey(Schema.Array(Schema.String)) })), preview_urls: Schema.optionalKey(Schema.Array(Schema.String)) });

type PreviewUrls = {
  readonly deployment: string;
  readonly preview: string;
};

const parsePreviewResult = (output: string): PreviewUrls => {
  const jsonStart = output.lastIndexOf("\n{");

  const parsed = Schema.decodeUnknownSync(Schema.fromJsonString(PreviewResult))(jsonStart === -1 ? output : output.slice(jsonStart + 1));

  const preview = parsed.preview?.urls?.[0] ?? parsed.preview_urls?.[0];
  const deployment = parsed.deployment?.urls?.[0] ?? parsed.deployment_urls?.[0];

  if (preview === undefined || deployment === undefined) {
    throw new Error("Wrangler did not return Preview and deployment URLs.");
  }

  return { deployment, preview };
};

const buildEnvironment = {
  ...process.env,
  API_URL: "https://origin-api.vektor.phibkro.org",
  DASHBOARD_MOUNT: "/",
  PREVIEW_HOST_SUFFIX: ".workers.dev",
  PREVIEW_STAGE: "worker-preview",
  VITE_API_URL: "https://vektor.phibkro.org",
};

if (!isCi) {
  writeLine("Building homepage Worker Preview");
  runVisible("bun", ["run", "build"], homepageRoot, buildEnvironment);
  writeLine("Building dashboard Worker Preview");
  runVisible("bun", ["run", "build"], dashboardRoot, buildEnvironment);
}

for (const requiredPath of [
  resolve(homepageRoot, "build/server/index.js"),
  resolve(homepageRoot, "build/client"),
  resolve(dashboardRoot, "build/server/index.js"),
  resolve(dashboardRoot, "build/client"),
]) {
  if (!existsSync(requiredPath)) {
    fail(`Missing Preview build artifact: ${requiredPath}`);
  }
}

const previewArgs = [
  "preview",
  "--name",
  previewName,
  "--tag",
  head.slice(0, 12),
  "--message",
  `PR #${pullRequestNumber} ${head}`,
  "--ignore-base-config",
  "--json",
] as const;

writeLine(`Deploying homepage Worker Preview ${previewName}`);

const homepage = parsePreviewResult(run(wrangler, [...previewArgs, "--config", homepageConfig]));

writeLine(`Deploying dashboard Worker Preview ${previewName}`);

const dashboard = parsePreviewResult(run(wrangler, [...previewArgs, "--config", dashboardConfig]));

const repository = process.env.GITHUB_REPOSITORY ?? "vektorprogrammet/mono-web";

const outputs = {
  commit: head,
  dashboard_deployment_url: dashboard.deployment,
  dashboard_url: dashboard.preview,
  homepage_deployment_url: homepage.deployment,
  homepage_url: homepage.preview,
  source_url: `https://github.com/${repository}/tree/${head}`,
};

for (const [name, value] of Object.entries(outputs)) {
  writeLine(`${name}: ${value}`);

  if (process.env.GITHUB_OUTPUT !== undefined) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import process from "node:process";
import { Config, Console, Data, Effect, FileSystem, Option, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { runCommand } from "./command.js";
import { exitWithReturnedCode } from "./exit-code.js";

/** A refusal or a failed command; the program prints its message and exits with its code. */
class PreviewFailure extends Data.TaggedError("PreviewFailure")<{
  readonly message: string;
  readonly exitCode: number;
}> {}

const fail = (message: string) => Effect.fail(new PreviewFailure({ message, exitCode: 1 }));

const PreviewResult = Schema.Struct({
  deployment: Schema.optionalKey(
    Schema.Struct({ urls: Schema.optionalKey(Schema.Array(Schema.String)) }),
  ),
  deployment_urls: Schema.optionalKey(Schema.Array(Schema.String)),
  preview: Schema.optionalKey(
    Schema.Struct({ urls: Schema.optionalKey(Schema.Array(Schema.String)) }),
  ),
  preview_urls: Schema.optionalKey(Schema.Array(Schema.String)),
});

const decodePreviewResult = Schema.decodeEffect(Schema.fromJsonString(PreviewResult));

const parsePreviewResult = Effect.fnUntraced(function* (output: string) {
  const jsonStart = output.lastIndexOf("\n{");

  const parsed = yield* Effect.orDie(
    decodePreviewResult(jsonStart === -1 ? output : output.slice(jsonStart + 1)),
  );

  const preview = parsed.preview?.urls?.[0] ?? parsed.preview_urls?.[0];
  const deployment = parsed.deployment?.urls?.[0] ?? parsed.deployment_urls?.[0];

  if (preview === undefined || deployment === undefined)
    return yield* Effect.die("Wrangler did not return Preview and deployment URLs.");

  return { deployment, preview };
});

/** An environment variable, or undefined when it is not set. */
const variable = (name: string) =>
  Effect.map(Config.option(Config.String(name)), Option.getOrUndefined);

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = path.resolve(import.meta.dir, "../..");
  const homepageRoot = path.resolve(root, "apps/homepage");
  const dashboardRoot = path.resolve(root, "apps/dashboard");
  const homepageConfig = path.resolve(root, "infra/previews/homepage.wrangler.json");
  const dashboardConfig = path.resolve(root, "infra/previews/dashboard.wrangler.json");
  const wrangler = path.resolve(root, "node_modules/.bin/wrangler");
  const pullRequestNumber = process.argv[2];

  if (pullRequestNumber === undefined || !/^[1-9]\d*$/.test(pullRequestNumber))
    return yield* fail("Usage: bun tools/scripts/deploy-preview.ts <pull-request-number>");

  const previewName = `pr-${pullRequestNumber}`;
  const isCi = (yield* variable("CI")) === "true";

  // Prints the output of a failed command and exits with its code.
  const run = Effect.fnUntraced(function* (
    command: string,
    args: ReadonlyArray<string>,
    cwd = root,
  ) {
    const result = yield* runCommand(ChildProcess.make(command, args, { cwd, stdin: "ignore" }));

    if (result.status !== 0)
      return yield* new PreviewFailure({
        message: `${result.stdout}${result.stderr}`,
        exitCode: result.status,
      });

    return result.stdout.trim();
  });

  const runVisible = Effect.fnUntraced(function* (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    env: Readonly<Record<string, string>>,
  ) {
    const status = yield* spawner.exitCode(
      ChildProcess.make(command, args, {
        cwd,
        env,
        extendEnv: true,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        detached: false,
      }),
    );

    if (status !== 0) return yield* new PreviewFailure({ message: "", exitCode: status });
  });

  const localHead = Effect.gen(function* () {
    const branch = yield* run("git", ["branch", "--show-current"]);

    if (branch.length === 0 || branch === "main")
      return yield* fail("Preview deployment requires a named non-main branch.");

    if ((yield* run("git", ["status", "--porcelain", "--untracked-files=no"])).length > 0)
      return yield* fail("Refusing preview deployment from a dirty tracked worktree.");

    const head = yield* run("git", ["rev-parse", "HEAD"]);

    if (head !== (yield* run("git", ["rev-parse", `origin/${branch}`])))
      return yield* fail(
        "Refusing preview deployment: HEAD must exactly match the pushed branch revision.",
      );

    return head;
  });

  const head = isCi ? yield* variable("PREVIEW_HEAD_SHA") : yield* localHead;

  if (head === undefined || !/^[0-9a-f]{40}$/.test(head))
    return yield* fail("PREVIEW_HEAD_SHA must be the exact 40-character pull-request revision.");

  const buildEnvironment = {
    DASHBOARD_MOUNT: "/",
    PREVIEW_HOST_SUFFIX: ".workers.dev",
    PREVIEW_STAGE: "worker-preview",
  };

  if (!isCi) {
    yield* Console.log("Building homepage Worker Preview");
    yield* runVisible("bun", ["run", "build"], homepageRoot, buildEnvironment);
    yield* Console.log("Building dashboard Worker Preview");
    yield* runVisible("bun", ["run", "build"], dashboardRoot, buildEnvironment);
  }

  for (const requiredPath of [
    path.resolve(homepageRoot, "build/server/index.js"),
    path.resolve(homepageRoot, "build/client"),
    path.resolve(dashboardRoot, "build/server/index.js"),
    path.resolve(dashboardRoot, "build/client"),
  ]) {
    if (!(yield* fileSystem.exists(requiredPath)))
      return yield* fail(`Missing Preview build artifact: ${requiredPath}`);
  }

  // `wrangler preview` creates a missing Worker as an empty parent with the config's `workers_dev`
  // and `preview_urls` settings and no production version (Wrangler 4.125.0+, workers-sdk#15174).
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

  yield* Console.log(`Deploying homepage Worker Preview ${previewName}`);

  const homepage = yield* parsePreviewResult(
    yield* run(wrangler, [...previewArgs, "--config", homepageConfig]),
  );

  yield* Console.log(`Deploying dashboard Worker Preview ${previewName}`);

  const dashboard = yield* parsePreviewResult(
    yield* run(wrangler, [...previewArgs, "--config", dashboardConfig]),
  );

  const repository = (yield* variable("GITHUB_REPOSITORY")) ?? "vektorprogrammet/mono-web";
  const githubOutput = yield* variable("GITHUB_OUTPUT");

  const outputs = {
    commit: head,
    dashboard_deployment_url: dashboard.deployment,
    dashboard_url: dashboard.preview,
    homepage_deployment_url: homepage.deployment,
    homepage_url: homepage.preview,
    source_url: `https://github.com/${repository}/tree/${head}`,
  };

  for (const [name, value] of Object.entries(outputs)) {
    yield* Console.log(`${name}: ${value}`);

    if (githubOutput !== undefined)
      yield* fileSystem.writeFileString(githubOutput, `${name}=${value}\n`, { flag: "a" });
  }

  return 0;
}).pipe(
  Effect.catchTag("PreviewFailure", ({ message, exitCode }) =>
    (message === "" ? Effect.void : Console.error(message.replace(/\n$/u, ""))).pipe(
      Effect.as(exitCode),
    ),
  ),
);

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)), exitWithReturnedCode);

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import process from "node:process";
import { Config, Console, Data, Effect, FileSystem, Layer, Option, Path } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { runCommand } from "./command.js";
import { exitWithReturnedCode } from "./exit-code.js";

// The Context Mapper CLI release and the SHA-256 that Maven Central publishes for its archive.
const contextMapperVersion = "6.12.0";

const contextMapperSha256 = "96579d57a5afa110d7b1363463cc576a2494cbbf480c37620aa09960c7779ce0";

const usage = `Usage:
  just model check
  just model validate

check     Runs every command of docs/model/authority.als with Alloy 6 from nixpkgs
          (nix shell nixpkgs#alloy6, the glucose solver) and compares each result
          with the command's \`expect\`. A check expects no counterexample (0). A
          mutant check, whose name contains "mutant", and a scenario run expect an
          instance (1). Prints the counts and every unexpected result, and keeps
          Alloy's output when there is one.
validate  Validates docs/model/contexts.cml with Context Mapper CLI ${contextMapperVersion} from
          Maven Central on OpenJDK 17 from nixpkgs (nix shell
          nixpkgs#jdk17_headless). The CLI archive must match its SHA-256. It is
          kept in \${XDG_CACHE_HOME:-~/.cache}/vektorprogrammet.

Both are heavy jobs. \`just model\` runs them through \`just measure\`, so they
wait for the heavy lock.
`;

/** A refusal or a failed step; the program prints it and exits 1. */
class ModelFailure extends Data.TaggedError("ModelFailure")<{ readonly message: string }> {}

const fail = (message: string) => Effect.fail(new ModelFailure({ message }));

const nixVersion = (attribute: string) =>
  Effect.map(
    Effect.option(runCommand(ChildProcess.make("nix", ["eval", "--raw", `nixpkgs#${attribute}.version`]))),
    (result) =>
      Option.isSome(result) && result.value.status === 0 ? result.value.stdout.trim() : "unknown",
  );

/** The exit code of a command whose output goes to this terminal, or how it ended otherwise. */
const exitStatus = Effect.fnUntraced(function* (command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return yield* Effect.match(spawner.exitCode(command), {
    onFailure: (error) => ({ ok: false, text: error.message }),
    onSuccess: (code) => ({ ok: code === 0, text: String(code) }),
  });
});

const check = Effect.fnUntraced(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const modelPath = path.join(root, "docs/model/authority.als");

  const lines = (yield* fileSystem.readFileString(modelPath))
    .split("\n")
    .filter((line) => /^\s*(check|run)\b/.test(line));

  const commands = yield* Effect.forEach(lines, (line) => {
    const match = /^\s*(check|run)\s+(\w+)\b.*\bexpect\s+([01])\s*$/.exec(line);

    return match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined
      ? Effect.succeed({ kind: match[1], name: match[2], expectsInstance: match[3] === "1" })
      : fail(
          `Every command states its expected result as \`expect 0\` or \`expect 1\`: ${line.trim()}`,
        );
  });

  const names = new Set(commands.map((command) => command.name));

  if (names.size !== commands.length) return yield* fail("Two commands have the same name.");

  const output = yield* fileSystem.makeTempDirectory({ prefix: "vektorprogrammet-alloy-" });
  const version = yield* nixVersion("alloy6");

  yield* Console.error(
    `model: running ${commands.length} commands of docs/model/authority.als with Alloy ${version}`,
  );

  // The command of the model header. Alloy prints one line per command, writes
  // <name>-solution-<n>.txt for each instance it finds, and reports a result that breaks `expect`.
  const alloy = yield* exitStatus(
    ChildProcess.make(
      "nice",
      [
        "-n",
        "10",
        "nix",
        "shell",
        "nixpkgs#alloy6",
        "--command",
        "alloy6",
        "exec",
        "-s",
        "glucose",
        "-c",
        "*",
        "-t",
        "text",
        "-o",
        output,
        "-f",
        modelPath,
      ],
      { stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: false },
    ),
  );

  const found = new Set<string>();

  for (const file of yield* fileSystem.readDirectory(output)) {
    const name = /^(\w+)-solution-\d+\.txt$/.exec(file)?.[1];

    if (name === undefined) continue;

    if (!names.has(name))
      return yield* fail(`Alloy wrote ${file}, which names no command. The output is ${output}.`);

    found.add(name);
  }

  const unexpected = commands.filter(
    (command) => found.has(command.name) !== command.expectsInstance,
  );

  const checks = commands.filter(
    (command) => command.kind === "check" && !command.name.includes("mutant"),
  );

  const mutants = commands.filter(
    (command) => command.kind === "check" && command.name.includes("mutant"),
  );

  const scenarios = commands.filter((command) => command.kind === "run");

  yield* Console.log(
    `model: authority.als, Alloy ${version}: ${commands.length} commands; ` +
      `${checks.filter((command) => !found.has(command.name)).length} of ${checks.length} checks hold, ` +
      `${mutants.filter((command) => found.has(command.name)).length} of ${mutants.length} mutants caught, ` +
      `${scenarios.filter((command) => found.has(command.name)).length} of ${scenarios.length} scenarios found, ` +
      `${unexpected.length} unexpected`,
  );

  if (unexpected.length > 0 || !alloy.ok)
    return yield* fail(
      `Alloy exited with ${alloy.text}; the output is kept in ${output}.` +
        unexpected
          .map(
            (command) =>
              `\n  ${command.kind} ${command.name}: expected ${command.expectsInstance ? "an instance" : "none"}, ` +
              `found ${found.has(command.name) ? "one" : "none"}`,
          )
          .join(""),
    );

  yield* fileSystem.remove(output, { recursive: true, force: true });
});

const validate = Effect.fnUntraced(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const version = contextMapperVersion;

  // An empty XDG_CACHE_HOME counts as unset.
  const cacheHome = yield* Config.withDefault(Config.String("XDG_CACHE_HOME"), "");

  const cache = path.join(
    cacheHome === "" ? path.join(homedir(), ".cache") : cacheHome,
    "vektorprogrammet",
  );

  const cli = path.join(cache, `context-mapper-cli-${version}`);
  const cm = path.join(cli, "bin", "cm");

  if (!(yield* fileSystem.exists(cm))) {
    const url = `https://repo1.maven.org/maven2/org/contextmapper/context-mapper-cli/${version}/context-mapper-cli-${version}.zip`;
    const response = yield* HttpClient.get(url);

    if (response.status < 200 || response.status > 299)
      return yield* fail(`${url} answered ${response.status}.`);

    const archive = new Uint8Array(yield* response.arrayBuffer);
    const digest = createHash("sha256").update(archive).digest("hex");

    if (digest !== contextMapperSha256)
      return yield* fail(`${url} has SHA-256 ${digest}, not the pinned ${contextMapperSha256}.`);

    // Extract beside the cache and move into place, so an interrupted run leaves no partial CLI.
    // The staging directory shares the cache's file system: a rename cannot cross devices.
    yield* fileSystem.makeDirectory(cache, { recursive: true });

    const staging = yield* fileSystem.makeTempDirectory({
      directory: cache,
      prefix: ".context-mapper-staging-",
    });

    const zip = path.join(staging, "cli.zip");

    yield* fileSystem.writeFile(zip, archive);

    const unzip = yield* exitStatus(
      ChildProcess.make(
        "nix",
        ["shell", "nixpkgs#unzip", "--command", "unzip", "-q", zip, "-d", staging],
        { stdin: "inherit", stdout: "inherit", stderr: "inherit", detached: false },
      ),
    );

    if (!unzip.ok) return yield* fail(`unzip exited with ${unzip.text}.`);

    yield* fileSystem.rename(path.join(staging, `context-mapper-cli-${version}`), cli);
    yield* fileSystem.remove(staging, { recursive: true, force: true });
  }

  const java = yield* nixVersion("jdk17_headless");

  const result = yield* runCommand(
    ChildProcess.make(
      "nice",
      [
        "-n",
        "10",
        "nix",
        "shell",
        "nixpkgs#jdk17_headless",
        "--command",
        cm,
        "validate",
        "-i",
        path.join(root, "docs/model/contexts.cml"),
      ],
      { stdin: "ignore" },
    ),
  );

  const text = `${result.stdout}${result.stderr}`;

  yield* Console.log(text.replace(/\n$/u, ""));

  // The CLI exits with 0 also when it reports errors.
  if (result.status !== 0 || /\bERROR\b/.test(text) || !text.includes("validated without errors"))
    return yield* fail(
      `contexts.cml did not validate (Context Mapper CLI ${version}, OpenJDK ${java}).`,
    );

  yield* Console.log(
    `model: contexts.cml validated without errors (Context Mapper CLI ${version}, OpenJDK ${java})`,
  );
});

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = path.join(import.meta.dir, "..", "..");
  const [action, ...rest] = process.argv.slice(2);

  if (action === "--help" || action === "-h") {
    yield* Console.log(usage.trimEnd());

    return 0;
  }

  if (rest.length > 0) return yield* fail("Pass one action: check or validate.");

  if (action === "check") yield* check(root);
  else if (action === "validate") yield* validate(root);
  else return yield* fail("Pass one action: check or validate. Use --help.");

  return 0;
}).pipe(
  Effect.catchTag("ModelFailure", ({ message }) =>
    Console.error(`model: ${message}`).pipe(Effect.as(1)),
  ),
);

BunRuntime.runMain(
  program.pipe(Effect.provide(Layer.merge(BunServices.layer, FetchHttpClient.layer))),
  exitWithReturnedCode,
);

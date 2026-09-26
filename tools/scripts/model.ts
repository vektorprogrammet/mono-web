import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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

// A function declaration lets calls narrow control flow as `never`.
function fail(message: string): never {
  process.stderr.write(`model: ${message}\n`);
  process.exit(1);
}

const root = join(import.meta.dir, "..", "..");

const nixVersion = (attribute: string) => {
  const result = spawnSync("nix", ["eval", "--raw", `nixpkgs#${attribute}.version`], {
    encoding: "utf8",
  });

  return result.status === 0 ? result.stdout.trim() : "unknown";
};

const check = () => {
  const modelPath = join(root, "docs/model/authority.als");

  const lines = readFileSync(modelPath, "utf8")
    .split("\n")
    .filter((line) => /^\s*(check|run)\b/.test(line));

  const commands = lines.map((line) => {
    const match = /^\s*(check|run)\s+(\w+)\b.*\bexpect\s+([01])\s*$/.exec(line);

    return match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined
      ? { kind: match[1], name: match[2], expectsInstance: match[3] === "1" }
      : fail(`Every command states its expected result as \`expect 0\` or \`expect 1\`: ${line.trim()}`);
  });

  const names = new Set(commands.map((command) => command.name));

  if (names.size !== commands.length) fail("Two commands have the same name.");

  const output = mkdtempSync(join(tmpdir(), "vektorprogrammet-alloy-"));
  const version = nixVersion("alloy6");

  process.stderr.write(
    `model: running ${commands.length} commands of docs/model/authority.als with Alloy ${version}\n`,
  );

  // The command of the model header. Alloy prints one line per command, writes
  // <name>-solution-<n>.txt for each instance it finds, and reports a result that breaks `expect`.
  const alloy = spawnSync(
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
    { stdio: ["ignore", "inherit", "inherit"] },
  );

  const found = new Set<string>();

  for (const file of readdirSync(output)) {
    const name = /^(\w+)-solution-\d+\.txt$/.exec(file)?.[1];

    if (name === undefined) continue;

    if (!names.has(name)) fail(`Alloy wrote ${file}, which names no command. The output is ${output}.`);

    found.add(name);
  }

  const unexpected = commands.filter((command) => found.has(command.name) !== command.expectsInstance);
  const checks = commands.filter((command) => command.kind === "check" && !command.name.includes("mutant"));
  const mutants = commands.filter((command) => command.kind === "check" && command.name.includes("mutant"));
  const scenarios = commands.filter((command) => command.kind === "run");

  process.stdout.write(
    `model: authority.als, Alloy ${version}: ${commands.length} commands; ` +
      `${checks.filter((command) => !found.has(command.name)).length} of ${checks.length} checks hold, ` +
      `${mutants.filter((command) => found.has(command.name)).length} of ${mutants.length} mutants caught, ` +
      `${scenarios.filter((command) => found.has(command.name)).length} of ${scenarios.length} scenarios found, ` +
      `${unexpected.length} unexpected\n`,
  );

  if (unexpected.length > 0 || alloy.status !== 0)
    fail(
      `Alloy exited with ${alloy.status ?? alloy.signal}; the output is kept in ${output}.` +
        unexpected
          .map(
            (command) =>
              `\n  ${command.kind} ${command.name}: expected ${command.expectsInstance ? "an instance" : "none"}, ` +
              `found ${found.has(command.name) ? "one" : "none"}`,
          )
          .join(""),
    );

  rmSync(output, { recursive: true, force: true });
};

const validate = async () => {
  const version = contextMapperVersion;
  const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "vektorprogrammet");
  const cli = join(cache, `context-mapper-cli-${version}`);
  const cm = join(cli, "bin", "cm");

  if (!existsSync(cm)) {
    const url = `https://repo1.maven.org/maven2/org/contextmapper/context-mapper-cli/${version}/context-mapper-cli-${version}.zip`;
    const response = await fetch(url);

    if (!response.ok) fail(`${url} answered ${response.status}.`);

    const archive = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(archive).digest("hex");

    if (digest !== contextMapperSha256)
      fail(`${url} has SHA-256 ${digest}, not the pinned ${contextMapperSha256}.`);

    // Extract beside the cache and move into place, so an interrupted run leaves no partial CLI.
    const staging = mkdtempSync(join(tmpdir(), "vektorprogrammet-context-mapper-"));
    const zip = join(staging, "cli.zip");

    writeFileSync(zip, archive);

    const unzip = spawnSync(
      "nix",
      ["shell", "nixpkgs#unzip", "--command", "unzip", "-q", zip, "-d", staging],
      { stdio: "inherit" },
    );

    if (unzip.status !== 0) fail(`unzip exited with ${unzip.status ?? unzip.signal}.`);

    mkdirSync(cache, { recursive: true });
    renameSync(join(staging, `context-mapper-cli-${version}`), cli);
    rmSync(staging, { recursive: true, force: true });
  }

  const java = nixVersion("jdk17_headless");

  const result = spawnSync(
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
      join(root, "docs/model/contexts.cml"),
    ],
    { encoding: "utf8" },
  );

  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  process.stdout.write(text);

  // The CLI exits with 0 also when it reports errors.
  if (result.status !== 0 || /\bERROR\b/.test(text) || !text.includes("validated without errors"))
    fail(`contexts.cml did not validate (Context Mapper CLI ${version}, OpenJDK ${java}).`);

  process.stdout.write(
    `model: contexts.cml validated without errors (Context Mapper CLI ${version}, OpenJDK ${java})\n`,
  );
};

const [action, ...rest] = process.argv.slice(2);

if (action === "--help" || action === "-h") {
  process.stdout.write(usage);
  process.exit(0);
}

if (rest.length > 0) fail("Pass one action: check or validate.");

if (action === "check") check();
else if (action === "validate") await validate();
else fail("Pass one action: check or validate. Use --help.");

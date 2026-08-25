import { Cause, Effect, Result } from "effect";
import { createMachineReport, renderMarkdown } from "./report.js";
import { DatasetInputError, loadDataset, loadPersonAuthority } from "./data.js";
import { allFixturesPass, runSyntheticFixtures } from "./fixtures.js";
import { runSDep2Team } from "./laws.js";
import {
  writeStandardError,
  writeStandardOutput,
  writeTextFile,
} from "./runtime-services.js";

declare global {
  interface ImportMeta {
    main: boolean;
  }
}

interface CliOptions {
  readonly dataDir?: string;
  readonly personAuthorityFile?: string;
  readonly snapshotId?: string;
  readonly snapshotHash?: string;
  readonly format: "json" | "markdown";
  readonly output?: string;
  readonly fixtures: boolean;
  readonly help: boolean;
}

type CliErrorCode =
  | "MISSING_OPTION_VALUE"
  | "INVALID_FORMAT"
  | "UNKNOWN_OPTION"
  | "MISSING_DATA_DIR";

class CliError extends Error {
  readonly code: CliErrorCode;
  readonly file = "cli";

  constructor(code: CliErrorCode, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

const USAGE = [
  "Usage: bun run runtime/main.ts --data-dir DATA_DIR [options]",
  "",
  "Options:",
  "  --data-dir PATH          Explicit sanitized five-file input directory",
  "  --person-authority PATH  Optional explicit person-to-department projection",
  "  --snapshot ID            Snapshot identifier for provenance",
  "  --snapshot-hash HASH    Snapshot hash for provenance",
  "  --format json|markdown   Output format (default: json)",
  "  --output PATH            Also write the rendered report to PATH",
  "  --fixtures               Run the strict synthetic falsifier matrix",
  "  --help                   Show this usage",
].join("\n");

const valueAfter = (args: ReadonlyArray<string>, index: number, option: string): string => {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CliError("MISSING_OPTION_VALUE", `missing option value for ${option}`);
  }
  return value;
};

const parseArgs = (args: ReadonlyArray<string>): CliOptions => {
  let dataDir: string | undefined;
  let personAuthorityFile: string | undefined;
  let snapshotId: string | undefined;
  let snapshotHash: string | undefined;
  let format: CliOptions["format"] = "json";
  let output: string | undefined;
  let fixtures = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--fixtures") {
      fixtures = true;
    } else if (arg === "--data-dir") {
      dataDir = valueAfter(args, index, arg);
      index += 1;
    } else if (arg === "--person-authority") {
      personAuthorityFile = valueAfter(args, index, arg);
      index += 1;
    } else if (arg === "--snapshot") {
      snapshotId = valueAfter(args, index, arg);
      index += 1;
    } else if (arg === "--snapshot-hash") {
      snapshotHash = valueAfter(args, index, arg);
      index += 1;
    } else if (arg === "--format") {
      const selected = valueAfter(args, index, arg);
      if (selected !== "json" && selected !== "markdown") {
        throw new CliError("INVALID_FORMAT", "format must be json or markdown");
      }
      format = selected;
      index += 1;
    } else if (arg === "--output") {
      output = valueAfter(args, index, arg);
      index += 1;
    } else {
      throw new CliError("UNKNOWN_OPTION", `unknown option ${arg}`);
    }
  }
  if (!help && !fixtures && dataDir === undefined) {
    throw new CliError("MISSING_DATA_DIR", "--data-dir is required unless --fixtures is used");
  }
  return { dataDir, personAuthorityFile, snapshotId, snapshotHash, format, output, fixtures, help };
};

const emit = (text: string, output: string | undefined) =>
  Effect.gen(function* () {
    if (output !== undefined) yield* writeTextFile(output, text);
    yield* writeStandardOutput(text.endsWith("\n") ? text : `${text}\n`);
  });

export const main = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const options = yield* Effect.try({
      try: () => parseArgs(args),
      catch: (cause) => cause,
    });
    if (options.help) {
      yield* emit(USAGE, options.output);
      return 0;
    }
    if (options.fixtures) {
      const fixtures = yield* runSyntheticFixtures();
      const all = allFixturesPass(fixtures);
      yield* emit(JSON.stringify({ fixtures, all, pii: "none" }, null, 2), options.output);
      return all ? 0 : 1;
    }
    const dataset = yield* loadDataset(options.dataDir ?? "");
    const personAuthority =
      options.personAuthorityFile === undefined
        ? undefined
        : yield* loadPersonAuthority(options.personAuthorityFile);
    const result = runSDep2Team(dataset, {
      snapshotId: options.snapshotId,
      snapshotHash: options.snapshotHash,
      personAuthority,
    });
    const report = createMachineReport(result);
    const rendered =
      options.format === "markdown" ? renderMarkdown(report) : JSON.stringify(report, null, 2);
    yield* emit(rendered, options.output);
    return report.status === "PASS" && !report.drift ? 0 : 1;
  }).pipe(
    Effect.catchCause((cause) => {
      const failure = Cause.findError(cause);
      const error = Result.isSuccess(failure) ? failure.success : undefined;
      const safeError =
        error instanceof DatasetInputError
          ? { code: error.code, file: error.file, message: error.message }
          : error instanceof CliError
            ? { code: error.code, file: error.file, message: error.message }
            : { code: "COMMAND_ERROR", file: "cli", message: "command failed" };
      return writeStandardError(`${JSON.stringify({ error: safeError })}\n`).pipe(Effect.as(1));
    }),
  );


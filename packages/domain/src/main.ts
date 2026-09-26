import { Cause, Data, Effect, Result, Schema } from "effect";
import { createMachineReport, renderMarkdown } from "./report.js";
import { DatasetInputError, loadDataset, loadPersonAuthority } from "./data.js";
import { allFixturesPass, runSyntheticFixtures } from "./fixtures.js";
import { runSDep2Team } from "./laws.js";
import { writeStandardError, writeStandardOutput, writeTextFile } from "./runtime-services.js";

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

class CliError extends Data.TaggedError("CliError")<{
  readonly code: CliErrorCode;
  readonly message: string;
}> {
  readonly file = "cli";
}

const ReportJson = Schema.fromJsonString(Schema.Unknown, { space: 2 });

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

const valueAfter = (
  args: ReadonlyArray<string>,
  index: number,
  option: string,
): Result.Result<string, CliError> => {
  const value = args[index + 1];

  return value === undefined || value.startsWith("--")
    ? Result.fail(
        new CliError({
          code: "MISSING_OPTION_VALUE",
          message: `missing option value for ${option}`,
        }),
      )
    : Result.succeed(value);
};

const parseArgs = (args: ReadonlyArray<string>): Result.Result<CliOptions, CliError> =>
  Result.gen(function* () {
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
        dataDir = yield* valueAfter(args, index, arg);
        index += 1;
      } else if (arg === "--person-authority") {
        personAuthorityFile = yield* valueAfter(args, index, arg);
        index += 1;
      } else if (arg === "--snapshot") {
        snapshotId = yield* valueAfter(args, index, arg);
        index += 1;
      } else if (arg === "--snapshot-hash") {
        snapshotHash = yield* valueAfter(args, index, arg);
        index += 1;
      } else if (arg === "--format") {
        const selected = yield* valueAfter(args, index, arg);

        if (selected !== "json" && selected !== "markdown") {
          return yield* Result.fail(
            new CliError({ code: "INVALID_FORMAT", message: "format must be json or markdown" }),
          );
        }

        format = selected;
        index += 1;
      } else if (arg === "--output") {
        output = yield* valueAfter(args, index, arg);
        index += 1;
      } else {
        return yield* Result.fail(
          new CliError({ code: "UNKNOWN_OPTION", message: `unknown option ${arg}` }),
        );
      }
    }

    if (!help && !fixtures && dataDir === undefined) {
      return yield* Result.fail(
        new CliError({
          code: "MISSING_DATA_DIR",
          message: "--data-dir is required unless --fixtures is used",
        }),
      );
    }

    return {
      dataDir,
      personAuthorityFile,
      snapshotId,
      snapshotHash,
      format,
      output,
      fixtures,
      help,
    };
  });

const emit = (text: string, output: string | undefined) =>
  Effect.gen(function* () {
    if (output !== undefined) yield* writeTextFile(output, text);
    yield* writeStandardOutput(text.endsWith("\n") ? text : `${text}\n`);
  });

export const main = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const options = yield* Effect.fromResult(parseArgs(args));

    if (options.help) {
      yield* emit(USAGE, options.output);

      return 0;
    }

    if (options.fixtures) {
      const fixtures = yield* runSyntheticFixtures;
      const all = allFixturesPass(fixtures);
      yield* emit(
        yield* Schema.encodeEffect(ReportJson)({ fixtures, all, pii: "none" }),
        options.output,
      );

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
      options.format === "markdown"
        ? renderMarkdown(report)
        : yield* Schema.encodeEffect(ReportJson)(report);

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

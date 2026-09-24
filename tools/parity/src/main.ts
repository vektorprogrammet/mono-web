import { Console, Effect } from "effect";
import { CliConfig, CliError, Command, Flag } from "effect/unstable/cli";
import { version } from "../package.json";
import { canonicalJson, failureId } from "./canonical.js";
import { FALSIFIERS, run } from "./runner.js";
import { ParityRuntimeError } from "./runtime.js";
import {
  ParityCommandExecutor,
  ParityExecutionEnvironment,
  ParityFileSystem,
  ParityTerminal,
} from "./services.js";
import type { ZeroGapReport } from "./types.js";

// Validate every occurrence before selecting the last value, as the original CLI did.
const lastValue = <A>(flag: Flag.Flag<A>): Flag.Flag<A | undefined> =>
  flag.pipe(
    Flag.atLeast(0),
    Flag.map((values) => values.at(-1)),
  );

const options = {
  root: lastValue(Flag.String("root").pipe(Flag.withDescription("Mono repository root."))),
  legacyRoot: lastValue(
    Flag.String("legacy-root").pipe(Flag.withDescription("Legacy repository root.")),
  ),
  intentRegisterPath: lastValue(
    Flag.String("intent-register").pipe(
      Flag.withDescription("External intent authority. Required for diff and write."),
    ),
  ),
  evidenceRegisterPath: lastValue(
    Flag.String("evidence-register").pipe(
      Flag.withDescription(
        "External evidence authority. Required for diff and write; forbidden for fixture_injection.",
      ),
    ),
  ),
  mode: lastValue(
    Flag.Literals("mode", ["diff", "write", "fixture_injection"]).pipe(
      Flag.withDescription(
        "diff compares projections; write promotes them; fixture_injection runs one isolated falsifier.",
      ),
    ),
  ),
  falsifierId: lastValue(
    Flag.Literals("falsifier", FALSIFIERS).pipe(
      Flag.withDescription("Required only for fixture_injection."),
    ),
  ),
  phpExecutable: lastValue(
    Flag.String("php-executable").pipe(
      Flag.withDescription("Canonical PHP executable. Default: /usr/bin/php."),
    ),
  ),
  bwrapExecutable: lastValue(
    Flag.String("bwrap-executable").pipe(
      Flag.withDescription("Canonical bubblewrap executable. Default: /usr/bin/bwrap."),
    ),
  ),
  help: Flag.Boolean("help").pipe(
    Flag.withAlias("h"),
    Flag.withDefault(false),
    Flag.withDescription("Show command help."),
  ),
};

const commandName = "bun tools/parity/cli.ts";

const invalidOptions = (message: string) =>
  new CliError.ShowHelp({
    commandPath: [commandName],
    errors: [new CliError.UserError({ cause: message })],
  });

const commandErrorReport = (): ZeroGapReport => {
  const sourceRefIds: string[] = [];

  const failure = {
    failure_id: failureId("command_error", "COMMAND_ARGUMENT_ERROR", [], sourceRefIds),
    status: "command_error" as const,
    reason_code: "COMMAND_ARGUMENT_ERROR",
    row_ids: [],
    source_ref_ids: sourceRefIds,
    accepted_intent_ref_ids: [],
  };

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    schema_version: "functional-parity-zero-gap-report/v1",
    status: "command_error",
    exit_code: 12,
    mode: "diff",
    falsifier_id: null,
    projection_write: { status: "blocked", target_ref: null },
    source_manifest_sha256: null,
    inventory_artifact_sha256: {},
    row_counts: {},
    status_counts: {},
    failures: [failure],
    mismatches: [],
    openapi_reconciliation_ref: "openapi-reconciliation.json",
    verification: {
      canonical_json: "recursive-key-sort/byte-order-array-sort/compact-utf8/no-newline",
      schema_validation: true,
      cross_reference_validation: false,
      deterministic_diff: "different",
      forbidden_states_empty: false,
    },
  };
};

const runtimeErrorReport = (error: ParityRuntimeError): ZeroGapReport => {
  const evidenceInvalid =
    error.operation === "runtime_evidence_authority" && error.message.startsWith("EVIDENCE_");

  const unsafe =
    (error.operation === "scan_root" || error.operation === "unsafe_source") &&
    /(unsafe source metadata|sensitive paths|projection construction)/i.test(error.message);

  const drift =
    !unsafe &&
    !evidenceInvalid &&
    ((error.operation === "scan_root" &&
      /(dirty|changed during scan|revision)/i.test(error.message)) ||
      ((error.operation === "intent_authority" ||
        error.operation === "runtime_evidence_authority" ||
        error.operation === "write_projection") &&
        /(dirty|changed|drift|revision)/i.test(error.message)));

  const status = evidenceInvalid
    ? ("accepted_intent_invalid" as const)
    : drift
      ? ("source_hash_drift" as const)
      : ("source_unavailable" as const);

  const reasonCode = evidenceInvalid
    ? error.message
    : unsafe
      ? "UNSAFE_SOURCE"
      : drift
        ? "SOURCE_HASH_DRIFT"
        : "SOURCE_UNAVAILABLE";

  const exitCode = evidenceInvalid ? 11 : drift ? 7 : 6;

  const failure = {
    failure_id: failureId(status, reasonCode, [], []),
    status,
    reason_code: reasonCode,
    row_ids: [],
    source_ref_ids: [],
    accepted_intent_ref_ids: [],
  };

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    schema_version: "functional-parity-zero-gap-report/v1",
    status,
    exit_code: exitCode,
    mode: "diff",
    falsifier_id: null,
    projection_write: { status: "blocked", target_ref: null },
    source_manifest_sha256: null,
    inventory_artifact_sha256: {},
    row_counts: {},
    status_counts: {},
    failures: [failure],
    mismatches: [],
    openapi_reconciliation_ref: "openapi-reconciliation.json",
    verification: {
      canonical_json: "recursive-key-sort/byte-order-array-sort/compact-utf8/no-newline",
      schema_validation: false,
      cross_reference_validation: false,
      deterministic_diff: "different",
      forbidden_states_empty: false,
    },
  };
};

export const main = (
  args?: readonly string[],
): Effect.Effect<
  number,
  never,
  | Command.Environment
  | ParityCommandExecutor
  | ParityExecutionEnvironment
  | ParityFileSystem
  | ParityTerminal
> =>
  Effect.gen(function* () {
    const environment = yield* ParityExecutionEnvironment;
    const terminal = yield* ParityTerminal;
    const console = yield* Console.Console;
    const programArgs = args ?? environment.arguments.slice(2);
    let help = "";
    let exitCode = 0;

    const command = Command.make(
      commandName,
      options,
      Effect.fnUntraced(function* (parsed) {
        if (parsed.help) {
          return yield* new CliError.ShowHelp({ commandPath: [commandName], errors: [] });
        }

        if (
          parsed.root === undefined ||
          parsed.legacyRoot === undefined ||
          parsed.mode === undefined
        )
          return yield* invalidOptions("--root, --legacy-root, and --mode are required");

        if (parsed.mode !== "fixture_injection" && parsed.intentRegisterPath === undefined)
          return yield* invalidOptions("--intent-register is required for diff and write modes");

        if (parsed.mode !== "fixture_injection" && parsed.evidenceRegisterPath === undefined)
          return yield* invalidOptions("--evidence-register is required for diff and write modes");

        if (parsed.mode === "fixture_injection" && parsed.falsifierId === undefined)
          return yield* invalidOptions("fixture_injection requires exactly one --falsifier");

        if (parsed.mode === "fixture_injection" && parsed.evidenceRegisterPath !== undefined)
          return yield* invalidOptions(
            "--evidence-register is forbidden in fixture_injection mode",
          );

        if (parsed.mode !== "fixture_injection" && parsed.falsifierId !== undefined)
          return yield* invalidOptions("--falsifier is only valid in fixture_injection mode");

        const result = yield* run({
          root: parsed.root,
          legacyRoot: parsed.legacyRoot,
          intentRegisterPath: parsed.intentRegisterPath,
          evidenceRegisterPath: parsed.evidenceRegisterPath,
          mode: parsed.mode,
          falsifierId: parsed.falsifierId,
          collectorExecutables:
            parsed.phpExecutable === undefined && parsed.bwrapExecutable === undefined
              ? undefined
              : {
                  phpExecutable: parsed.phpExecutable ?? "/usr/bin/php",
                  bwrapExecutable: parsed.bwrapExecutable ?? "/usr/bin/bwrap",
                },
        });

        yield* Effect.sync(() => terminal.writeStandardOutput(canonicalJson(result.report) + "\n"));
        exitCode = result.exitCode;
      }),
    ).pipe(
      Command.withDescription(
        "Verify functional parity. Root, legacy-root, and mode are required except for help. Collector defaults require canonical files.",
      ),
    );

    return yield* Command.runWith(command, { version, renderErrors: false })(
      programArgs.filter((argument) => argument !== "--"),
    ).pipe(
      Effect.provideService(CliConfig.CliConfig, CliConfig.make({ builtIns: [] })),
      Effect.provideService(Console.Console, {
        ...console,
        log: (text: string) => {
          help += String(text) + "\n";
        },
        error: (text: string) => terminal.writeStandardError(String(text) + "\n"),
      }),
      Effect.map(() => exitCode),
      Effect.catch((error) =>
        Effect.sync(() => {
          if (error instanceof CliError.ShowHelp && error.errors.length === 0) {
            terminal.writeStandardOutput(help);

            return 0;
          }

          const report =
            error instanceof ParityRuntimeError ? runtimeErrorReport(error) : commandErrorReport();

          if (
            error instanceof ParityRuntimeError &&
            error.operation === "unsafe_source" &&
            error.diagnostics !== undefined
          )
            terminal.writeStandardError(
              canonicalJson({ reason_code: "UNSAFE_SOURCE", diagnostics: error.diagnostics }) +
                "\n",
            );

          if (!(error instanceof ParityRuntimeError)) terminal.writeStandardError(help);
          terminal.writeStandardOutput(canonicalJson(report) + "\n");

          return report.exit_code;
        }),
      ),
    );
  });

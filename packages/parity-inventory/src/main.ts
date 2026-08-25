import { Effect } from "effect";
import { canonicalJson, failureId } from "./canonical.js";
import { FALSIFIERS, run, type FalsifierId, type RunMode } from "./runner.js";
import { ParityRuntimeError } from "./runtime.js";
import {
  ParityCommandExecutor,
  ParityExecutionEnvironment,
  ParityFileSystem,
  ParityTerminal,
} from "./services.js";
import type { CollectorExecutables, ZeroGapReport } from "./types.js";

const USAGE = [
  "Usage: bun run parity:verify -- --root <mono-root> --legacy-root <legacy-root> --intent-register <external-intent-authority-checkout-file> --evidence-register <external-runtime-evidence-authority-checkout-file> --mode <diff|write|fixture_injection> [--php-executable <absolute-canonical-php>] [--bwrap-executable <absolute-canonical-bwrap>] [--falsifier F0..F19]",
  "",
  "Modes:",
  "  diff              regenerate C0 projections and compare committed bytes (read-only)",
  "  write             atomically promote source-manifest and route projections",
  "  fixture_injection run one named isolated falsifier; never writes projections",
  "",
  "Collector executables default to /usr/bin/php and /usr/bin/bwrap when both canonical files are present.",
].join("\n");

interface ParsedArgs {
  readonly root: string;
  readonly legacyRoot: string;
  readonly intentRegisterPath?: string;
  readonly evidenceRegisterPath?: string;
  readonly mode: RunMode;
  readonly falsifierId?: FalsifierId;
  readonly collectorExecutables?: CollectorExecutables;
  readonly help: boolean;
}

const valueAfter = (args: readonly string[], index: number, option: string): string => {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
};

const parseArgs = (args: readonly string[]): ParsedArgs => {
  let root: string | undefined;
  let legacyRoot: string | undefined;
  let intentRegisterPath: string | undefined;
  let evidenceRegisterPath: string | undefined;
  let mode: RunMode | undefined;
  let falsifierId: FalsifierId | undefined;
  let phpExecutable: string | undefined;
  let bwrapExecutable: string | undefined;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--root") {
      root = valueAfter(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--legacy-root") {
      legacyRoot = valueAfter(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--intent-register") {
      intentRegisterPath = valueAfter(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--evidence-register") {
      evidenceRegisterPath = valueAfter(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--php-executable") {
      phpExecutable = valueAfter(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--bwrap-executable") {
      bwrapExecutable = valueAfter(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--mode") {
      const value = valueAfter(args, index, argument);
      if (value !== "diff" && value !== "write" && value !== "fixture_injection")
        throw new Error(`invalid mode: ${value}`);
      mode = value;
      index += 1;
      continue;
    }
    if (argument === "--falsifier") {
      const value = valueAfter(args, index, argument);
      if (!(FALSIFIERS as readonly string[]).includes(value))
        throw new Error(`invalid falsifier: ${value}`);
      falsifierId = value as FalsifierId;
      index += 1;
      continue;
    }
    if (argument === "--") continue;
    throw new Error(`unknown option: ${argument}`);
  }
  const collectorExecutables: CollectorExecutables | undefined =
    phpExecutable === undefined && bwrapExecutable === undefined
      ? undefined
      : {
          phpExecutable: phpExecutable ?? "/usr/bin/php",
          bwrapExecutable: bwrapExecutable ?? "/usr/bin/bwrap",
        };
  if (help)
    return {
      root: root ?? ".",
      legacyRoot: legacyRoot ?? ".",
      intentRegisterPath,
      evidenceRegisterPath,
      mode: mode ?? "diff",
      falsifierId,
      collectorExecutables,
      help,
    };
  if (root === undefined || legacyRoot === undefined || mode === undefined)
    throw new Error("--root, --legacy-root, and --mode are required");
  if (mode !== "fixture_injection" && intentRegisterPath === undefined)
    throw new Error("--intent-register is required for diff and write modes");
  if (mode !== "fixture_injection" && evidenceRegisterPath === undefined)
    throw new Error("--evidence-register is required for diff and write modes");
  if (mode === "fixture_injection" && falsifierId === undefined)
    throw new Error("fixture_injection requires exactly one --falsifier");
  if (mode === "fixture_injection" && evidenceRegisterPath !== undefined)
    throw new Error("--evidence-register is forbidden in fixture_injection mode");
  if (mode !== "fixture_injection" && falsifierId !== undefined)
    throw new Error("--falsifier is only valid in fixture_injection mode");
  return {
    root,
    legacyRoot,
    intentRegisterPath,
    evidenceRegisterPath,
    mode,
    falsifierId,
    collectorExecutables,
    help,
  };
};

const commandErrorReport = (message: string): ZeroGapReport => {
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
    failures: [
      {
        ...failure,
        reason_code: message.length > 0 ? "COMMAND_ARGUMENT_ERROR" : failure.reason_code,
      },
    ],
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
  ParityCommandExecutor | ParityExecutionEnvironment | ParityFileSystem | ParityTerminal
> =>
  Effect.gen(function* () {
    const environment = yield* ParityExecutionEnvironment;
    const terminal = yield* ParityTerminal;
    const programArgs = args ?? environment.arguments.slice(2);
    const program = Effect.gen(function* () {
      const parsed = yield* Effect.try({
        try: () => parseArgs(programArgs),
        catch: (error) => (error instanceof Error ? error : new Error("command error")),
      });
      if (parsed.help) {
        yield* Effect.sync(() => terminal.writeStandardOutput(`${USAGE}\n`));
        return 0;
      }
      const result = yield* run({
        root: parsed.root,
        legacyRoot: parsed.legacyRoot,
        intentRegisterPath: parsed.intentRegisterPath,
        evidenceRegisterPath: parsed.evidenceRegisterPath,
        mode: parsed.mode,
        falsifierId: parsed.falsifierId,
        collectorExecutables: parsed.collectorExecutables,
      });
      yield* Effect.sync(() => terminal.writeStandardOutput(`${canonicalJson(result.report)}\n`));
      return result.exitCode;
    });
    return yield* program.pipe(
      Effect.catchIf(
        (_error): _error is Error => true,
        (error) =>
          Effect.sync(() => {
            const report =
              error instanceof ParityRuntimeError
                ? runtimeErrorReport(error)
                : commandErrorReport(error instanceof Error ? error.message : "command error");
            if (!(error instanceof ParityRuntimeError)) terminal.writeStandardError(`${USAGE}\n`);
            terminal.writeStandardOutput(`${canonicalJson(report)}\n`);
            return report.exit_code;
          }),
      ),
    );
  });

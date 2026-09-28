/** The processes, environment, and readiness of the acceptance probes, as Effects on platform services. */
import { ConfigProvider, Data, type Duration, Effect, Predicate, Schema, Stream } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess } from "effect/unstable/process";

/** The grace between SIGTERM and SIGKILL when an owned process group is stopped. */
const ownedProcessGrace: Duration.Input = "5 seconds";

/** A command of an acceptance probe that exited with a code other than 0, or outlived its deadline. */
export class AcceptanceCommandFailed extends Data.TaggedError("AcceptanceCommandFailed")<{
  readonly command: string;
  readonly reason: string;
  readonly stderr: string;
}> {
  override get message(): string {
    return `${this.command} ${this.reason}: ${this.stderr}`;
  }
}

/** One command of an acceptance probe. */
export interface AcceptanceCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  /** Values over the inherited environment; an `undefined` value removes the variable. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/** A command that runs to completion within `deadline`. */
export interface CompletedCommand extends AcceptanceCommand {
  readonly deadline: Duration.Input;
  /** `inherit` shows the standard error of the command; `pipe` keeps it for the failure. */
  readonly stderr?: "inherit" | "pipe" | undefined;
}

/**
 * The standard output of a command that must exit with code 0 before its deadline. At the
 * deadline its process group is stopped, SIGTERM first and SIGKILL after five seconds.
 */
export const commandOutput = (spec: CompletedCommand) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make(spec.command, spec.args, {
        cwd: spec.cwd,
        env: { ...spec.env },
        extendEnv: true,
        stdin: "ignore",
        stderr: spec.stderr ?? "inherit",
        forceKillAfter: ownedProcessGrace,
      });

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          spec.stderr === "pipe"
            ? Stream.mkString(Stream.decodeText(handle.stderr))
            : Effect.succeed(""),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0)
        return yield* new AcceptanceCommandFailed({
          command: spec.command,
          reason: `exited with code ${exitCode}`,
          stderr,
        });

      return stdout;
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: spec.deadline,
      orElse: () =>
        Effect.fail(
          new AcceptanceCommandFailed({
            command: spec.command,
            reason: "outlived its deadline",
            stderr: "",
          }),
        ),
    }),
  );

/** A long-running process that the caller scope owns. */
export interface OwnedChild {
  /** The exit code; an exit on a signal fails. */
  readonly exitCode: Effect.Effect<number, AcceptanceCommandFailed>;
  /** Stops the process group, SIGTERM first and SIGKILL after five seconds, and awaits its exit. */
  readonly stop: Effect.Effect<void>;
}

/** A long-running command whose standard output and error go to `output`. */
export interface OwnedCommand extends AcceptanceCommand {
  readonly output: (text: string) => void;
}

/**
 * Starts a long-running process group in the caller scope. The scope stops the group like
 * `stop` when it closes, so no owned process outlives the probe.
 */
export const startOwnedProcess = Effect.fnUntraced(function* (spec: OwnedCommand) {
  const handle = yield* ChildProcess.make(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...spec.env },
    extendEnv: true,
    stdin: "ignore",
    forceKillAfter: ownedProcessGrace,
  });

  yield* handle.all.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) => Effect.sync(() => spec.output(text))),
    Effect.ignore,
    Effect.forkScoped,
  );

  const child: OwnedChild = {
    exitCode: handle.exitCode.pipe(
      Effect.map(Number),
      Effect.mapError(
        (error) =>
          new AcceptanceCommandFailed({
            command: spec.command,
            reason: "exited on a signal",
            stderr: error.message,
          }),
      ),
    ),
    stop: handle.kill({ forceKillAfter: ownedProcessGrace }).pipe(Effect.ignore),
  };

  return child;
});

/**
 * The names of the inherited environment variables under `prefix`, the segments of a name that
 * `_` separates, such as `["CONTACT"]` for every `CONTACT_*` variable.
 */
export const ambientVariables = (
  prefix: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, ConfigProvider.SourceError> =>
  Effect.gen(function* () {
    const provider = yield* ConfigProvider.ConfigProvider;
    const node = yield* provider.load(prefix);

    if (node === undefined) return [];

    const own =
      Predicate.isTagged(node, "Value") || node.value !== undefined ? [prefix.join("_")] : [];

    if (!Predicate.isTagged(node, "Record")) return own;

    const nested = yield* Effect.forEach([...node.keys], (key) =>
      ambientVariables([...prefix, key]),
    );

    return [...own, ...nested.flat()];
  });

/**
 * The inherited variables that a backend of a probe must not see: every `CONTACT_*` and every
 * `PUBLIC_APPLICATION_EFFECT_*` but the mode, each mapped to `undefined` to remove it.
 */
export const withheldVariables = Effect.gen(function* () {
  const contact = yield* ambientVariables(["CONTACT"]);
  const effects = yield* ambientVariables(["PUBLIC", "APPLICATION", "EFFECT"]);

  return Object.fromEntries(
    [...contact, ...effects].flatMap((key) =>
      key === "PUBLIC_APPLICATION_EFFECT_MODE" ? [] : [[key, undefined]],
    ),
  ) satisfies Record<string, undefined>;
});

/** Whether `url` answers a 2xx status; a transport failure counts as not ready. */
export const answersOk = (url: string): Effect.Effect<boolean, never, HttpClient.HttpClient> =>
  HttpClient.get(url).pipe(
    Effect.map((response) => response.status >= 200 && response.status <= 299),
    Effect.orElseSucceed(() => false),
  );

const JsonText = Schema.fromJsonString(Schema.Unknown);

const IndentedJsonText = Schema.fromJsonString(Schema.Unknown, { space: 2 });

/** The JSON text of a value, byte for byte what `JSON.stringify` writes. */
export const jsonText = <A>(value: A): Effect.Effect<string> =>
  Schema.encodeEffect(JsonText)(value).pipe(Effect.orDie);

/** The JSON text of a value indented by two spaces, as `JSON.stringify(value, null, 2)` writes it. */
export const indentedJsonText = <A>(value: A): Effect.Effect<string> =>
  Schema.encodeEffect(IndentedJsonText)(value).pipe(Effect.orDie);

/** A failed step of an acceptance probe, such as a readiness deadline. */
export class ProbeFailure extends Data.TaggedError("ProbeFailure")<{ readonly message: string }> {}

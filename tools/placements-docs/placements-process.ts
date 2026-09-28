/**
 * Runs a documentation subprocess in its own process group and owns that group: when the
 * subprocess ends, fails, or the program is interrupted, the whole group stops, also descendants
 * that ignore SIGTERM.
 */
import process from "node:process";
import { Clock, Data, Duration, Effect, Result } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/** The subprocess ended with another code than 0, or its process group did not stop. */
export class DocumentationCommandFailed extends Data.TaggedError("DocumentationCommandFailed")<{
  readonly message: string;
  /** The exit code, or how the subprocess ended otherwise. */
  readonly exitCode: number | string;
}> {}

// Whether the group still has a member; ESRCH means that none is left.
const signalGroup = (pid: number, signal: NodeJS.Signals | 0) =>
  Effect.sync(() => {
    try {
      process.kill(-pid, signal);

      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;

      throw error;
    }
  });

const terminateGroup = Effect.fnUntraced(function* (pid: number) {
  // The leader can exit before its descendants. Keep ownership of the group.
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!(yield* signalGroup(pid, signal))) return;

    const deadline = (yield* Clock.currentTimeMillis) + 1000;

    do {
      yield* Effect.sleep(Duration.millis(20));

      if (!(yield* signalGroup(pid, 0))) return;
    } while ((yield* Clock.currentTimeMillis) < deadline);
  }

  return yield* new DocumentationCommandFailed({
    message: "Documentation process group did not stop",
    exitCode: "running",
  });
});

/** A documentation subprocess: its program, arguments, and working directory. */
export interface DocumentationCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

/**
 * Runs the subprocess with inherited standard streams to its end and stops its process group.
 * A failure of the subprocess comes first: a failed cleanup replaces only a success.
 */
export const runDocumentationCommand = ({
  command,
  args,
  cwd,
}: DocumentationCommand): Effect.Effect<
  void,
  DocumentationCommandFailed,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const handle = yield* spawner
        .spawn(
          ChildProcess.make(command, args, {
            cwd,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
            detached: true,
          }),
        )
        .pipe(
          Effect.mapError(
            (error) =>
              new DocumentationCommandFailed({
                message: `Documentation subprocess did not start: ${error.message}`,
                exitCode: "not started",
              }),
          ),
        );

      const pid = Number(handle.pid);

      const completed = Effect.gen(function* () {
        const ended = yield* Effect.result(handle.exitCode);
        const cleanup = yield* Effect.result(terminateGroup(pid));

        const exitCode = Result.isSuccess(ended) ? Number(ended.success) : ended.failure.message;

        if (exitCode !== 0)
          return yield* new DocumentationCommandFailed({
            message: "Documentation subprocess failed",
            exitCode,
          });

        if (Result.isFailure(cleanup)) return yield* cleanup.failure;
      });

      yield* Effect.onInterrupt(completed, () => Effect.ignore(terminateGroup(pid)));
    }),
  );

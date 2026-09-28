/**
 * Runs one command to its end and collects its exit code and output, as `spawnSync` did for the
 * scripts, through the `ChildProcessSpawner` service that the composition root provides.
 */
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The exit code and the text of both output streams of a command that runs to its end. */
export const runCommand = (command: ChildProcess.Command) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(command);

      const [stdout, stderr, status] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );

      return { status, stdout, stderr } satisfies CommandResult;
    }),
  );

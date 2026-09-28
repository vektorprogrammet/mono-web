/**
 * Runs the job of `just measure` or a hook slot as a child that shares the terminal and the
 * process group of this process, forwards the signals that this process receives to it, and
 * reports how it ended: its exit code, or the signal that ended it. The program then ends the
 * same way, so its caller sees the job's own status.
 */
// oxlint-disable-next-line effecttsgo/node-builtin-import -- EX-0015: the job's terminating signal is needed, and a ChildProcess handle reports it only inside an error message
import { spawn } from "node:child_process";
import process from "node:process";
import { Data, Effect, Exit, Predicate } from "effect";
import * as Runtime from "effect/Runtime";

/** How a job ended: `signal` is set when a signal ended it, and `exitCode` is null then. */
export interface JobExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** How a job ended, and the first signal that this process forwarded to it, if any. */
export interface ForwardedJobExit extends JobExit {
  readonly forwarded: NodeJS.Signals | null;
}

/** The job's program could not start. */
export class JobStartFailure extends Data.TaggedError("JobStartFailure")<{
  readonly message: string;
}> {}

/** A job, its environment, and the signals forwarded to it. */
export interface Job {
  readonly command: string;
  readonly arguments: ReadonlyArray<string>;
  /** Added to the environment of this process, or the whole environment with `isolated`. */
  readonly variables: Readonly<Record<string, string>>;
  readonly isolated?: boolean | undefined;
  readonly cwd?: string | undefined;
  readonly forwardedSignals: ReadonlyArray<NodeJS.Signals>;
}

/**
 * Runs the job with inherited standard streams to its end. The wait cannot be interrupted: a
 * signal that this process receives goes to the job, and the program learns of it from the
 * job's exit.
 */
export const runJob = ({
  command,
  arguments: jobArguments,
  variables,
  isolated = false,
  cwd,
  forwardedSignals,
}: Job): Effect.Effect<ForwardedJobExit, JobStartFailure> =>
  Effect.uninterruptible(
    Effect.callback<ForwardedJobExit, JobStartFailure>((resume) => {
      const child = spawn(command, jobArguments, {
        stdio: "inherit",
        env: isolated ? { ...variables } : { ...process.env, ...variables },
        cwd,
      });

      let forwarded: NodeJS.Signals | null = null;

      const handlers = forwardedSignals.map(
        (signal) =>
          [
            signal,
            () => {
              forwarded ??= signal;
              child.kill(signal);
            },
          ] as const,
      );

      for (const [signal, handler] of handlers) process.on(signal, handler);

      const stop = () => {
        for (const [signal, handler] of handlers) process.off(signal, handler);
      };

      child.once("error", (error) => {
        stop();
        resume(Effect.fail(new JobStartFailure({ message: error.message })));
      });

      child.once("exit", (exitCode, signal) => {
        stop();
        resume(Effect.succeed({ exitCode, signal, forwarded }));
      });
    }),
  );

/**
 * The end of a program that ran a job. `record` keeps the job's exit, and `teardown`, the
 * `BunRuntime.runMain` teardown, ends the process with it: by the job's signal, or with its exit
 * code. It applies also when a signal interrupted the program, which forwarded it to the job.
 * A program that recorded no job exit ends with the number that it returns.
 */
export const jobDisposition = () => {
  let recorded: JobExit | undefined;

  const teardown: Runtime.Teardown = (exit, onExit) => {
    if (recorded?.signal !== null && recorded?.signal !== undefined)
      process.kill(process.pid, recorded.signal);
    else if (recorded !== undefined) onExit(recorded.exitCode ?? 1);
    else if (Exit.isSuccess(exit) && Predicate.isNumber(exit.value)) onExit(exit.value);
    else Runtime.defaultTeardown(exit, onExit);
  };

  return {
    record: (jobExit: JobExit): Effect.Effect<void> =>
      Effect.sync(() => {
        recorded = jobExit;
      }),
    teardown,
  };
};

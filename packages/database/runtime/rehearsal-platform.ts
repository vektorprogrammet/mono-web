/** The Bun platform steps of the synthetic cohort rehearsals: files, commands, and configuration. */
import assert from "node:assert/strict";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Config, Data, Effect, FileSystem, Option, Path, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

export class RehearsalCommandFailed extends Data.TaggedError("RehearsalCommandFailed")<{
  readonly command: string;
  readonly exitCode: number;
  readonly stderr: string;
}> {
  override get message(): string {
    return `${this.command} exited with code ${this.exitCode}: ${this.stderr}`;
  }
}

/** Runs one rehearsal step on the Bun platform services. */
export const runOnBun = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

/** Fails when one of `keys` is set: a rehearsal reads no ambient configuration. */
export const assertNoAmbientConfiguration = (keys: ReadonlyArray<string>): void => {
  for (const key of keys)
    assert.ok(
      Option.isNone(Effect.runSync(Config.option(Config.String(key)))),
      `${key} ambient configuration prohibited`,
    );
};

/** The repository root and a new private artifact directory whose name starts with `prefix`. */
export const rehearsalWorkspace = (prefix: string) =>
  runOnBun(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const artifacts = yield* fs.makeTempDirectory({ prefix });

      return {
        root: path.resolve(import.meta.dirname, "../../.."),
        artifacts,
        file: (name: string) => path.join(artifacts, name),
      };
    }),
  );

/** Writes `text` to `file`, readable and writable by the owner only. */
export const writePrivateFile = (file: string, text: string) =>
  runOnBun(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(file, text, { mode: 0o600 });
      yield* fs.chmod(file, 0o600);
    }),
  );

/** Removes the artifact directory and everything in it. */
export const removeWorkspace = (artifacts: string) =>
  runOnBun(
    FileSystem.FileSystem.use((fs) => fs.remove(artifacts, { recursive: true, force: true })),
  );

/**
 * The standard output of `command`, which must exit with code 0 within a minute. The command
 * inherits the environment, with `env` taking precedence.
 */
export const commandOutput = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string>> = {},
) =>
  runOnBun(
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make(command, args, {
          cwd,
          env,
          extendEnv: true,
          stdin: "ignore",
        });

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );

        if (exitCode !== 0) return yield* new RehearsalCommandFailed({ command, exitCode, stderr });

        return stdout;
      }),
    ).pipe(Effect.timeout("60 seconds")),
  );

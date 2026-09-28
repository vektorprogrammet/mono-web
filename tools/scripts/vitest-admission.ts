/**
 * The Vitest global setup of vitest.shared.ts: every `vitest run` holds the heavy lock shared and
 * one hook slot, as a hook job does, unless it runs inside a job that holds the heavy lock (a hook
 * slot, `just measure`, or another admitted run). A heavy job then waits for running test runs,
 * and a test run that starts later waits for the heavy job.
 *
 * The locks belong to the Vitest main process and are released when it exits, also on a signal:
 * the setup takes them in a scope that it never closes. Its processes inherit
 * `VEKTORPROGRAMMET_HEAVY_LOCK`, so a nested run does not wait for itself.
 * Watch mode is not admitted: it would hold the slot until it is stopped and keep heavy jobs out.
 */
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import process from "node:process";
import { Console, Effect, Layer, Scope } from "effect";
import {
  heavyLockVariable,
  insideHeavyLock,
  localNow,
  takeHeavyLock,
  takeHookSlot,
} from "./heavy-lock.js";

/** The part of Vitest's TestProject that the setup reads. */
interface Project {
  readonly config: { readonly watch: boolean };
}

// Vitest may run the setup under Node, whose runtime these layers share with Bun.
const AdmissionPlatform = Layer.merge(BunFileSystem.layer, BunPath.layer);

const log = (message: string) =>
  Effect.flatMap(localNow, ({ time }) => Console.error(`vitest-admission: ${time} ${message}`));

const admission = Effect.gen(function* () {
  if (yield* insideHeavyLock) return;

  const command = ["vitest", ...process.argv.slice(2)];

  const variables = yield* takeHeavyLock({ mode: "shared", jobClass: "vitest", command, log });

  yield* takeHookSlot({ jobClass: "vitest", log });

  return variables[heavyLockVariable] ?? String(process.pid);
});

export const setup = (project: Project): Promise<void> | undefined =>
  project.config.watch
    ? undefined
    : // The scope stays open for the life of the Vitest main process, which holds the locks.
      Effect.runPromise(
        admission.pipe(Scope.provide(Scope.makeUnsafe()), Effect.provide(AdmissionPlatform)),
      ).then((holder) => {
        // Vitest starts its workers with the environment of its main process.
        // oxlint-disable-next-line effecttsgo/process-env -- EX-0014: Vitest workers learn the holder of the lock only from the environment of the main process
        if (holder !== undefined) process.env[heavyLockVariable] = holder;
      });

/**
 * The Vitest global setup of vitest.shared.ts: every `vitest run` holds the heavy lock shared and
 * one hook slot, as a hook job does, unless it runs inside a job that holds the heavy lock (a hook
 * slot, `just measure`, or another admitted run). A heavy job then waits for running test runs,
 * and a test run that starts later waits for the heavy job.
 *
 * The locks belong to the Vitest main process and are released when it exits, also on a signal.
 * Its processes inherit `VEKTORPROGRAMMET_HEAVY_LOCK`, so a nested run does not wait for itself.
 * Watch mode is not admitted: it would hold the slot until it is stopped and keep heavy jobs out.
 */
import process from "node:process";
import { heavyLockVariable, insideHeavyLock, takeHeavyLock, takeHookSlot } from "./heavy-lock.js";

/** The part of Vitest's TestProject that the setup reads. */
interface Project {
  readonly config: { readonly watch: boolean };
}

const log = (message: string) =>
  process.stderr.write(`vitest-admission: ${new Date().toTimeString().slice(0, 8)} ${message}\n`);

export const setup = (project: Project) => {
  if (project.config.watch || insideHeavyLock()) return;

  const command = ["vitest", ...process.argv.slice(2)];

  takeHeavyLock("shared", "vitest", command, log);
  takeHookSlot("vitest", log);

  process.env[heavyLockVariable] = String(process.pid);
};

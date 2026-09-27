/**
 * The Vitest settings that every workspace shares: a worker cap and admission under the machine's
 * heavy lock. Vitest looks up its configuration in the working directory only, so each workspace
 * whose scripts run Vitest has a `vitest.config.*` that merges this one; `just layout` rejects one
 * that does not. `--maxWorkers` on the command line still overrides the cap.
 */
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

// A direct run may use all 32 CPUs, but must not start one worker per CPU. A hook slot
// offers six CPUs on this workstation, so four workers leave headroom for the main process.
const workerCap = 4;

export const sharedVitestConfig = {
  test: {
    // One CPU stays free for the main process. availableParallelism() honours the CPU affinity
    // of a hook slot, so the default holds under hook-slot pinning and outside it.
    maxWorkers: Math.max(1, Math.min(availableParallelism() - 1, workerCap)),
    // A run outside a hook slot or `just measure` takes the heavy lock shared and a hook slot.
    globalSetup: [fileURLToPath(new URL("tools/scripts/vitest-admission.ts", import.meta.url))],
  },
};

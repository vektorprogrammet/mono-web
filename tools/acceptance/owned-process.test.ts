import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { stopOwnedProcess } from "./owned-process";

describe("owned process lifecycle", () => {
  it("confirms owned process exit even when graceful termination is ignored", async () => {
    const child = spawn("bun", [
      "-e",
      'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);',
    ]);

    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", () => resolve());
      });
      // Real clock on purpose: Bun's fake timers also freeze this test's timeout,
      // so a missing SIGKILL escalation would hang instead of failing.
      await stopOwnedProcess(child);
      expect(child.signalCode).toBe("SIGKILL");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10_000);
});

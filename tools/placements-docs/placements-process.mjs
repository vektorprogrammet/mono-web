import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);

    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function terminateGroup(pid) {
  // The leader can exit before its descendants. Keep ownership of the group.
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (!signalGroup(pid, signal)) return;
    const deadline = Date.now() + 1000;

    do {
      await setTimeout(20);

      if (!signalGroup(pid, 0)) return;
    } while (Date.now() < deadline);
  }

  throw new Error("Documentation process group did not stop");
}

export async function runDocumentationCommand(command, args, cwd, signal) {
  signal.throwIfAborted();
  const child = spawn(command, args, { cwd, stdio: "inherit", detached: true });
  const exited = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  child.once("error", exited.reject);
  child.once("exit", (code, signal) => exited.resolve(signal ?? code));
  let cleanup;

  const stop = () =>
    (cleanup ??= (child.pid ? terminateGroup(child.pid) : Promise.resolve()).then(
      () => undefined,
      (error) => error,
    ));

  const interrupt = () => {
    void stop().then(() => aborted.reject(signal.reason));
  };

  const completed = Promise.race([exited.promise, aborted.promise]);
  signal.addEventListener("abort", interrupt, { once: true });

  if (signal.aborted) interrupt();
  let failure;

  try {
    const code = await completed;
    signal.throwIfAborted();
    assert.equal(code, 0, "Documentation subprocess failed");
  } catch (error) {
    failure = error;
  }

  const cleanupError = await stop();
  signal.removeEventListener("abort", interrupt);

  // Cleanup must not replace the original compiler, example, or signal failure.
  if (failure) throw failure;
  signal.throwIfAborted();

  if (cleanupError) throw cleanupError;
}

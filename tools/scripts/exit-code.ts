/**
 * The run options of the scripts' composition roots: a program that succeeds with a number exits
 * with that code, and a failure or an interruption exits as `Runtime.defaultTeardown` decides.
 */
import { Exit, Predicate } from "effect";
import * as Runtime from "effect/Runtime";

const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isSuccess(exit) && Predicate.isNumber(exit.value)) onExit(exit.value);
  else Runtime.defaultTeardown(exit, onExit);
};

/** `BunRuntime.runMain` options that exit with the code that the program returns. */
export const exitWithReturnedCode = { teardown } as const;

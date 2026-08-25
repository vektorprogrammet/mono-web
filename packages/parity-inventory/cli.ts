import { Effect } from "effect";
import { nodeRuntime } from "./node-runtime.js";
import { main } from "./src/main.js";

const exitCode = await Effect.runPromise(main());
nodeRuntime.process.setExitCode(exitCode);

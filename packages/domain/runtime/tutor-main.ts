import { Effect } from "effect";
import { main } from "../src/tutor/main.js";
import { DomainProcessLive, nodeArguments, setNodeExitCode } from "./node.js";

const exitCode = Effect.runSync(main(nodeArguments()).pipe(Effect.provide(DomainProcessLive)));
setNodeExitCode(exitCode);

import { Effect } from "effect";
import { main } from "../src/main.js";
import { DomainNodeLive, nodeArguments, setNodeExitCode } from "./node.js";

const exitCode = await Effect.runPromise(
  main(nodeArguments()).pipe(Effect.provide(DomainNodeLive)),
);
setNodeExitCode(exitCode);

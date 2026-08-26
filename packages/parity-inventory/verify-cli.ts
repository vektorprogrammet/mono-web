import process from "node:process";
import { existsSync, lstatSync } from "node:fs";
import { Effect } from "effect";
import { NodeRuntimeLayer } from "./node-runtime.js";
import { main } from "./src/main.js";
import { parityExternalInputs, parityVerifyArguments } from "./verify-config.js";

const repositoryRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

if (import.meta.main) {
  const missing = parityExternalInputs(repositoryRoot)
    .filter(({ path, directory }) => {
      if (!existsSync(path)) return true;
      try {
        return directory ? !lstatSync(path).isDirectory() : !lstatSync(path).isFile();
      } catch {
        return true;
      }
    })
    .map(({ label, path }) => `${label}: ${path}`);
  if (missing.length > 0) {
    process.stderr.write(
      [
        "parity:verify cannot run because required external parity authorities are unavailable:",
        ...missing.map((input) => `- ${input}`),
        "Provide the sibling legacy checkout and authority registers, then rerun `bun run parity:verify`.",
        "For an explicitly selected setup, invoke `bun run packages/parity-inventory/cli.ts -- --help` and provide all required arguments.",
      ].join("\n") + "\n",
    );
    process.exitCode = 12;
  } else if (process.argv.length > 2) {
    process.stderr.write(
      "parity:verify uses its pinned repository inputs and accepts no overrides; invoke packages/parity-inventory/cli.ts directly for an explicitly selected run.\n",
    );
    process.exitCode = 12;
  } else {
    const exitCode = await Effect.runPromise(
      main(parityVerifyArguments()).pipe(Effect.provide(NodeRuntimeLayer)),
    );
    process.exitCode = exitCode;
  }
}

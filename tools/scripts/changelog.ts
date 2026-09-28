import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import process from "node:process";
import { Console, Effect, FileSystem, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { exitWithReturnedCode } from "./exit-code.js";

const outputPath = "CHANGELOG.md";

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const check = process.argv.includes("--check");
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;

  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(
      "node_modules/.bin/conventional-changelog",
      ["--config", ".changelogrc.mjs", "--release-count", "0", "--outfile", temporaryPath],
      { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
    ),
  );

  if (exitCode !== 0) {
    yield* fileSystem.remove(temporaryPath).pipe(Effect.ignore);

    return exitCode;
  }

  if (!check) {
    yield* fileSystem.rename(temporaryPath, outputPath);
    yield* Console.log("Generated CHANGELOG.md from conventional commits.");

    return 0;
  }

  const expected = yield* fileSystem.readFile(outputPath).pipe(Effect.option);
  const actual = yield* fileSystem.readFile(temporaryPath);

  yield* fileSystem.remove(temporaryPath);

  if (Option.isNone(expected) || !sameBytes(expected.value, actual)) {
    yield* Console.error("CHANGELOG.md is out of date. Run `just changelog` and commit the result.");

    return 1;
  }

  yield* Console.log("CHANGELOG.md matches git history.");

  return 0;
});

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)), exitWithReturnedCode);

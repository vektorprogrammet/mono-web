import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { DomainFileSystem, DomainProcess } from "../src/runtime-services.js";

export const DomainFileSystemLive = Layer.succeed(DomainFileSystem, {
  readTextFile: (path) => Effect.tryPromise(() => readFile(path, "utf8")),
  joinPath: (directory, file) => join(directory, file),
  writeTextFile: (path, contents) =>
    Effect.tryPromise(() => writeFile(path, contents)).pipe(Effect.asVoid),
  makeTempDirectory: (prefix) => Effect.tryPromise(() => mkdtemp(join(tmpdir(), prefix))),
  removeTree: (path) => Effect.tryPromise(() => rm(path, { recursive: true, force: true })),
});

export const DomainProcessLive = Layer.succeed(DomainProcess, {
  writeStandardOutput: (text) =>
    Effect.sync(() => {
      process.stdout.write(text);
    }),
  writeStandardError: (text) =>
    Effect.sync(() => {
      process.stderr.write(text);
    }),
});

export const DomainNodeLive = Layer.merge(DomainFileSystemLive, DomainProcessLive);

export const nodeArguments = (): ReadonlyArray<string> => process.argv.slice(2);

export const setNodeExitCode = (exitCode: number): void => {
  process.exitCode = exitCode;
};

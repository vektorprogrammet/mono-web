import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { DomainFileSystem, DomainProcess } from "../src/runtime-services.js";

export const DomainFileSystemLive = Layer.succeed(DomainFileSystem, {
  readTextFile: (path) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => cause,
    }),
  joinPath: (directory, file) => join(directory, file),
  writeTextFile: (path, contents) =>
    Effect.tryPromise({
      try: () => writeFile(path, contents),
      catch: (cause) => cause,
    }).pipe(Effect.asVoid),
  makeTempDirectory: (prefix) =>
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), prefix)),
      catch: (cause) => cause,
    }),
  removeTree: (path) =>
    Effect.tryPromise({
      try: () => rm(path, { recursive: true, force: true }),
      catch: (cause) => cause,
    }),
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

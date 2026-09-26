import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, FileSystem, Layer, Path } from "effect";
import { DomainFileSystem, DomainProcess } from "../src/runtime-services.js";

export const DomainFileSystemLive = Layer.effect(
  DomainFileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    return {
      readTextFile: (file) => fileSystem.readFileString(file),
      joinPath: (directory, file) => path.join(directory, file),
      writeTextFile: (file, contents) => fileSystem.writeFileString(file, contents),
      makeTempDirectory: (prefix) => fileSystem.makeTempDirectory({ prefix }),
      removeTree: (directory) => fileSystem.remove(directory, { recursive: true, force: true }),
    };
  }),
).pipe(Layer.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)));

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

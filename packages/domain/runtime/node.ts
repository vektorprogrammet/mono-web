import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import {
  DomainFileSystem,
  DomainProcess,
  DomainSha256,
  makeTempDirectory,
  readTextFile,
  removeTree,
  writeTextFile,
  writeStandardError,
  writeStandardOutput,
} from "../src/runtime-services.js";

const DomainFileSystemLive = Layer.succeed(DomainFileSystem, {
  readTextFile: (path) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => cause,
    }),
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

const DomainProcessLive = Layer.succeed(DomainProcess, {
  writeStandardOutput: (text) =>
    Effect.sync(() => {
      process.stdout.write(text);
    }),
  writeStandardError: (text) =>
    Effect.sync(() => {
      process.stderr.write(text);
    }),
});

const DomainSha256Live = Layer.succeed(DomainSha256, {
  digestHex: (bytes) => createHash("sha256").update(bytes).digest("hex"),
});

const runtime = ManagedRuntime.make(
  Layer.mergeAll(DomainFileSystemLive, DomainProcessLive, DomainSha256Live),
);

type DomainRuntimeServices = DomainFileSystem | DomainProcess | DomainSha256;

export const runDomainPromise = <A, E, R extends DomainRuntimeServices>(
  program: Effect.Effect<A, E, R>,
): Promise<A> => runtime.runPromise(program as Effect.Effect<A, E, DomainRuntimeServices>);

export const runDomainSync = <A, E, R extends DomainRuntimeServices>(
  program: Effect.Effect<A, E, R>,
): A => runtime.runSync(program as Effect.Effect<A, E, DomainRuntimeServices>);

export const runDomainSyncExit = <A, E, R extends DomainRuntimeServices>(
  program: Effect.Effect<A, E, R>,
): Exit.Exit<A, E> =>
  runtime.runSyncExit(program as Effect.Effect<A, E, DomainRuntimeServices>) as Exit.Exit<A, E>;

export const readTextFileAtNodeBoundary = (path: string | URL): Promise<string> =>
  runDomainPromise(readTextFile(path));

export const writeTextFileAtNodeBoundary = (
  path: string | URL,
  contents: string | Uint8Array,
): Promise<void> => runDomainPromise(writeTextFile(path, contents));

export const makeTempDirectoryAtNodeBoundary = (prefix: string): Promise<string> =>
  runDomainPromise(makeTempDirectory(prefix));

export const removeTreeAtNodeBoundary = (path: string): Promise<void> =>
  runDomainPromise(removeTree(path));
export const writeStandardOutputAtNodeBoundary = (text: string): void => {
  runDomainSync(writeStandardOutput(text));
};

export const writeStandardErrorAtNodeBoundary = (text: string): void => {
  runDomainSync(writeStandardError(text));
};

export const nodeArguments = (): ReadonlyArray<string> => process.argv.slice(2);

export const setNodeExitCode = (exitCode: number): void => {
  process.exitCode = exitCode;
};

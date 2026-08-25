import { Context, Effect } from "effect";

export interface DomainFileSystemShape {
  readonly readTextFile: (path: string | URL) => Effect.Effect<string, unknown>;
  readonly joinPath: (directory: string, file: string) => string;
  readonly writeTextFile: (
    path: string | URL,
    contents: string | Uint8Array,
  ) => Effect.Effect<void, unknown>;
  readonly makeTempDirectory: (prefix: string) => Effect.Effect<string, unknown>;
  readonly removeTree: (path: string) => Effect.Effect<void, unknown>;
}

export class DomainFileSystem extends Context.Service<DomainFileSystem, DomainFileSystemShape>()(
  "@vektorprogrammet/domain/DomainFileSystem",
) {}

export interface DomainProcessShape {
  readonly writeStandardOutput: (text: string) => Effect.Effect<void>;
  readonly writeStandardError: (text: string) => Effect.Effect<void>;
}

export class DomainProcess extends Context.Service<DomainProcess, DomainProcessShape>()(
  "@vektorprogrammet/domain/DomainProcess",
) {}

export const readTextFile = (
  path: string | URL,
): Effect.Effect<string, unknown, DomainFileSystem> =>
  DomainFileSystem.use((fileSystem) => fileSystem.readTextFile(path));

export const joinPath = (
  directory: string,
  file: string,
): Effect.Effect<string, never, DomainFileSystem> =>
  DomainFileSystem.use((fileSystem) => Effect.succeed(fileSystem.joinPath(directory, file)));

export const writeTextFile = (
  path: string | URL,
  contents: string | Uint8Array,
): Effect.Effect<void, unknown, DomainFileSystem> =>
  DomainFileSystem.use((fileSystem) => fileSystem.writeTextFile(path, contents));

export const makeTempDirectory = (
  prefix: string,
): Effect.Effect<string, unknown, DomainFileSystem> =>
  DomainFileSystem.use((fileSystem) => fileSystem.makeTempDirectory(prefix));

export const removeTree = (path: string): Effect.Effect<void, unknown, DomainFileSystem> =>
  DomainFileSystem.use((fileSystem) => fileSystem.removeTree(path));

export const writeStandardOutput = (text: string): Effect.Effect<void, never, DomainProcess> =>
  DomainProcess.use((process) => process.writeStandardOutput(text));

export const writeStandardError = (text: string): Effect.Effect<void, never, DomainProcess> =>
  DomainProcess.use((process) => process.writeStandardError(text));

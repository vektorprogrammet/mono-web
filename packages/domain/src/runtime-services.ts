/**
 * Abstract file-system and process requirements for portable domain programs.
 *
 * @since 0.1.0
 */
import { Cause, Context, Effect } from "effect";

export interface DomainFileSystemOperations {
  readonly readTextFile: (path: string | URL) => Effect.Effect<string, Cause.UnknownError>;
  readonly joinPath: (directory: string, file: string) => string;
  readonly writeTextFile: (
    path: string | URL,
    contents: string | Uint8Array,
  ) => Effect.Effect<void, Cause.UnknownError>;
  readonly makeTempDirectory: (prefix: string) => Effect.Effect<string, Cause.UnknownError>;
  readonly removeTree: (path: string) => Effect.Effect<void, Cause.UnknownError>;
}

export class DomainFileSystem extends Context.Service<
  DomainFileSystem,
  DomainFileSystemOperations
>()("@vektorprogrammet/domain/DomainFileSystem") {}

export interface DomainProcessOperations {
  readonly writeStandardOutput: (text: string) => Effect.Effect<void>;
  readonly writeStandardError: (text: string) => Effect.Effect<void>;
}

export class DomainProcess extends Context.Service<DomainProcess, DomainProcessOperations>()(
  "@vektorprogrammet/domain/DomainProcess",
) {}

export const readTextFile = (
  path: string | URL,
): Effect.Effect<string, Cause.UnknownError, DomainFileSystem> =>
  DomainFileSystem.use((fileSystem) => fileSystem.readTextFile(path));

export const joinPath = (
  directory: string,
  file: string,
): Effect.Effect<string, never, DomainFileSystem> =>
  DomainFileSystem.use((fileSystem) => Effect.succeed(fileSystem.joinPath(directory, file)));

export const writeTextFile = (
  path: string | URL,
  contents: string | Uint8Array,
): Effect.Effect<void, Cause.UnknownError, DomainFileSystem> =>
  DomainFileSystem.use((fileSystem) => fileSystem.writeTextFile(path, contents));

export const makeTempDirectory = (
  prefix: string,
): Effect.Effect<string, Cause.UnknownError, DomainFileSystem> =>
  DomainFileSystem.use((fileSystem) => fileSystem.makeTempDirectory(prefix));

export const removeTree = (
  path: string,
): Effect.Effect<void, Cause.UnknownError, DomainFileSystem> =>
  DomainFileSystem.use((fileSystem) => fileSystem.removeTree(path));

export const writeStandardOutput = (text: string): Effect.Effect<void, never, DomainProcess> =>
  DomainProcess.use((process) => process.writeStandardOutput(text));

export const writeStandardError = (text: string): Effect.Effect<void, never, DomainProcess> =>
  DomainProcess.use((process) => process.writeStandardError(text));

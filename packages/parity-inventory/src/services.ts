import { Context } from "effect";

export interface ParityFileMetadata {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
}

export interface ParityDirectoryEntry {
  readonly name: string;
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
}

export interface ParityWriteFileOptions {
  readonly encoding?: "utf8";
  readonly flag?: "wx";
  readonly mode?: number;
}

export interface ParityRemoveOptions {
  readonly force?: boolean;
  readonly recursive?: boolean;
}

export interface ParityFileSystemShape {
  readonly exists: (path: string) => boolean;
  readonly exchangeDirectoriesAtomically: (source: string, target: string) => void;
  readonly lstat: (path: string) => ParityFileMetadata;
  readonly makeDirectory: (
    path: string,
    options?: { readonly recursive?: boolean; readonly mode?: number },
  ) => void;
  readonly makeTempDirectory: (prefix: string) => string;
  readonly readBytes: (path: string) => Uint8Array;
  readonly readBytesPromise: (path: string) => Promise<Uint8Array>;
  readonly readText: (path: string) => string;
  readonly readDirectory: (path: string) => readonly ParityDirectoryEntry[];
  readonly realpath: (path: string) => string;
  readonly remove: (path: string, options?: ParityRemoveOptions) => void;
  readonly rename: (source: string, target: string) => void;
  readonly stat: (path: string) => ParityFileMetadata;
  readonly temporaryDirectory: () => string;
  readonly writeFile: (
    path: string,
    contents: string | Uint8Array,
    options?: "utf8" | ParityWriteFileOptions,
  ) => void;
  readonly writeBytesPromise: (path: string, contents: Uint8Array) => Promise<void>;
}

export class ParityFileSystem extends Context.Service<ParityFileSystem, ParityFileSystemShape>()(
  "@monoweb/parity-inventory/ParityFileSystem",
) {}

export type ParityStdio = "ignore" | "pipe";

export interface ParityCommandOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly killSignal?: "SIGKILL";
  readonly maxBuffer?: number;
  readonly stdio?: "ignore" | [ParityStdio, ParityStdio, ParityStdio];
  readonly timeout?: number;
}

export interface ParitySpawnResult {
  readonly error?: Error;
  readonly signal: string | null;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

export interface ParityCommandExecutorShape {
  readonly executeBytes: (
    executable: string,
    arguments_: readonly string[],
    options?: ParityCommandOptions,
  ) => Uint8Array;
  readonly executeText: (
    executable: string,
    arguments_: readonly string[],
    options?: ParityCommandOptions,
  ) => string;
  readonly spawnText: (
    executable: string,
    arguments_: readonly string[],
    options?: ParityCommandOptions,
  ) => ParitySpawnResult;
}

export class ParityCommandExecutor extends Context.Service<
  ParityCommandExecutor,
  ParityCommandExecutorShape
>()("@monoweb/parity-inventory/ParityCommandExecutor") {}

export interface ParityExecutionEnvironmentShape {
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly executablePath: string;
  readonly platform: string;
  readonly runnerDirectory: string;
  readonly cliPath: string;
}

export class ParityExecutionEnvironment extends Context.Service<
  ParityExecutionEnvironment,
  ParityExecutionEnvironmentShape
>()("@monoweb/parity-inventory/ParityExecutionEnvironment") {}

export interface ParityTerminalShape {
  readonly writeStandardError: (text: string) => void;
  readonly writeStandardOutput: (text: string) => void;
}

export class ParityTerminal extends Context.Service<ParityTerminal, ParityTerminalShape>()(
  "@monoweb/parity-inventory/ParityTerminal",
) {}

export type ParityRuntimeServices =
  | ParityCommandExecutor
  | ParityExecutionEnvironment
  | ParityFileSystem
  | ParityTerminal;

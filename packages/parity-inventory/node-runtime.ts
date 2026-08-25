import {
  execFileSync,
  spawnSync,
  type ExecFileSyncOptions,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Layer } from "effect";
import {
  ParityCommandExecutor,
  type ParityCommandOptions,
  ParityExecutionEnvironment,
  ParityFileSystem,
  ParityTerminal,
} from "./src/services.js";

const commandOptions = (options: ParityCommandOptions | undefined): ExecFileSyncOptions => ({
  cwd: options?.cwd,
  env: options?.env === undefined ? undefined : { ...options.env },
  killSignal: options?.killSignal,
  maxBuffer: options?.maxBuffer,
  stdio: options?.stdio,
  timeout: options?.timeout,
});
const RENAME_EXCHANGE_SCRIPT = `import { dlopen, FFIType } from "bun:ffi"
const source = process.argv[1]
const target = process.argv[2]
if (source === undefined || target === undefined) process.exit(2)
const libc = dlopen("libc.so.6", { renameat2: { args: [FFIType.c_int, FFIType.cstring, FFIType.c_int, FFIType.cstring, FFIType.c_uint], returns: FFIType.c_int } })
const result = libc.symbols.renameat2(-100, Buffer.from(source + String.fromCharCode(0)), -100, Buffer.from(target + String.fromCharCode(0)), 2)
if (result !== 0) process.exit(1)`;

export const NodeFileSystemLayer = Layer.succeed(ParityFileSystem, {
  exists: existsSync,
  exchangeDirectoriesAtomically: (source, target) => {
    if (process.platform !== "linux")
      throw new Error("atomic projection exchange is unavailable on this platform");
    execFileSync(process.execPath, ["-e", RENAME_EXCHANGE_SCRIPT, source, target], {
      stdio: "ignore",
    });
  },
  lstat: lstatSync,
  makeDirectory: (path, options) => {
    mkdirSync(path, options);
  },
  makeTempDirectory: mkdtempSync,
  readBytes: readFileSync,
  readBytesPromise: readFile,
  readText: (path) => readFileSync(path, "utf8"),
  readDirectory: (path) => readdirSync(path, { withFileTypes: true }),
  realpath: realpathSync,
  remove: (path, options) => {
    rmSync(path, options);
  },
  rename: renameSync,
  stat: statSync,
  temporaryDirectory: tmpdir,
  writeFile: writeFileSync,
  writeBytesPromise: writeFile,
});

export const NodeCommandExecutorLayer = Layer.succeed(ParityCommandExecutor, {
  executeBytes: (executable, arguments_, options) =>
    execFileSync(executable, [...arguments_], commandOptions(options)),
  executeText: (executable, arguments_, options) =>
    execFileSync(executable, [...arguments_], {
      ...commandOptions(options),
      encoding: "utf8",
    }),
  spawnText: (executable, arguments_, options) => {
    const result = spawnSync(executable, [...arguments_], {
      ...commandOptions(options),
      encoding: "utf8",
    } satisfies SpawnSyncOptionsWithStringEncoding);
    return {
      ...(result.error === undefined ? {} : { error: result.error }),
      signal: result.signal,
      status: result.status,
      stderr: result.stderr ?? "",
      stdout: result.stdout ?? "",
    };
  },
});

const runnerDirectory = dirname(fileURLToPath(new URL("./src/runner.ts", import.meta.url)));
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

export const NodeExecutionEnvironmentLayer = Layer.succeed(ParityExecutionEnvironment, {
  get arguments() {
    return process.argv;
  },
  get environment() {
    return process.env;
  },
  get executablePath() {
    return process.execPath;
  },
  get platform() {
    return process.platform;
  },
  runnerDirectory,
  cliPath,
});

export const NodeTerminalLayer = Layer.succeed(ParityTerminal, {
  writeStandardError: (text) => {
    process.stderr.write(text);
  },
  writeStandardOutput: (text) => {
    process.stdout.write(text);
  },
});

export const NodeRuntimeLayer = Layer.mergeAll(
  NodeCommandExecutorLayer,
  NodeExecutionEnvironmentLayer,
  NodeFileSystemLayer,
  NodeTerminalLayer,
);

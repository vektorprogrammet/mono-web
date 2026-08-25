import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { Effect } from "effect";

/** Concrete Node capabilities owned by the parity application's runtime adapter. */
export const nodeRuntime = {
  execFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFile,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  spawnSync,
  statSync,
  tmpdir,
  writeFile,
  writeFileSync,
  runSync: Effect.runSync,
  runPromise: Effect.runPromise,
  sha256Hex: (value: Uint8Array | string): string =>
    createHash("sha256").update(value).digest("hex"),
  process: {
    get argv(): readonly string[] {
      return process.argv;
    },
    get env(): NodeJS.ProcessEnv {
      return process.env;
    },
    get execPath(): string {
      return process.execPath;
    },
    get platform(): NodeJS.Platform {
      return process.platform;
    },
    get stderr(): NodeJS.WriteStream {
      return process.stderr;
    },
    get stdout(): NodeJS.WriteStream {
      return process.stdout;
    },
    setExitCode(value: number): void {
      process.exitCode = value;
    },
  },
} as const;

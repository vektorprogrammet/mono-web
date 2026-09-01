#!/usr/bin/env bun
import { resolve } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { canonicalJson } from "./src/canonical.js";
import {
  JourneyHttpClient,
  type JourneyHttpRequest,
  runClaimSpecificLegacyJourneyEvidence,
} from "./src/legacy-journey-evidence.js";
import { JourneyProcessExecutor, type JourneyProcessHandle } from "./src/journey-evidence.js";
import { NodeRuntimeLayer } from "./node-runtime.js";
import { ParityExecutionEnvironment, ParityFileSystem, ParityTerminal } from "./src/services.js";

const JsonUnknownFromText = Schema.fromJsonString(Schema.Unknown);
const decodeJsonText = Schema.decodeUnknownSync(JsonUnknownFromText, {
  onExcessProperty: "error",
});

const responseBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text.length === 0) return null;
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("json") ? decodeJsonText(text) : { text_sha256_input: text };
};

const requestBody = (request: JourneyHttpRequest): BodyInit | undefined => {
  if (request.body === undefined) return undefined;
  if (request.body.kind === "json") return canonicalJson(request.body.value);
  const form = new FormData();
  for (const [name, value] of Object.entries(request.body.fields)) form.set(name, value);
  form.set(
    request.body.file.fieldName,
    new File([request.body.file.bytes], request.body.file.name, {
      type: request.body.file.contentType,
    }),
  );
  return form;
};

const NodeJourneyHttpLayer = Layer.succeed(JourneyHttpClient, {
  request: async (request) => {
    const response = await fetch(request.url, {
      body: requestBody(request),
      headers: { ...request.headers },
      method: request.method,
      redirect: "manual",
    });
    const setCookie = response.headers.getSetCookie();
    return {
      body: await responseBody(response),
      headers: setCookie.length === 0 ? {} : { "set-cookie": setCookie.join("\n") },
      status: response.status,
    };
  },
});

interface RunningSubprocess {
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  readonly pid: number;
  readonly kill: (signal: "SIGKILL" | "SIGTERM") => void;
}

const subprocesses = new Map<string, RunningSubprocess>();
const delay = (milliseconds: number): Promise<void> => {
  const { promise, resolve: complete } = Promise.withResolvers<void>();
  setTimeout(complete, milliseconds);
  return promise;
};

const NodeJourneyProcessLayer = Layer.succeed(JourneyProcessExecutor, {
  sleep: delay,
  start: async (executable, arguments_, options): Promise<JourneyProcessHandle> => {
    const child = Bun.spawn([executable, ...arguments_], {
      cwd: options.cwd,
      env: { ...options.env },
      stderr: "inherit",
      stdin: "ignore",
      stdout: "inherit",
    });
    const handle = { id: String(child.pid) };
    subprocesses.set(handle.id, child);
    await delay(10);
    if (child.exitCode !== null) {
      subprocesses.delete(handle.id);
      throw new Error(`process ${executable} exited during startup with ${child.exitCode}`);
    }
    return handle;
  },
  stop: async (handle) => {
    const child = subprocesses.get(handle.id);
    if (child === undefined) return;
    subprocesses.delete(handle.id);
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const graceful = Promise.race([child.exited.then(() => true), delay(5_000).then(() => false)]);
    if (!(await graceful) && child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  },
});

const parseArguments = (
  arguments_: readonly string[],
): {
  readonly output: string;
  readonly phpExecutable: string;
} => {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--")) {
      throw new Error("LEGACY_JOURNEY_EVIDENCE_ARGUMENTS_INVALID");
    }
    values.set(name, value);
  }
  const output = values.get("--output");
  const phpExecutable = values.get("--php");
  if (values.size !== 2 || output === undefined || phpExecutable === undefined) {
    throw new Error(
      "LEGACY_JOURNEY_EVIDENCE_ARGUMENTS_INVALID:requires --output <dir> --php <path>",
    );
  }
  return { output: resolve(output), phpExecutable: resolve(phpExecutable) };
};

const program = Effect.gen(function* () {
  const execution = yield* ParityExecutionEnvironment;
  const fileSystem = yield* ParityFileSystem;
  const terminal = yield* ParityTerminal;
  const options = parseArguments(execution.arguments.slice(2));
  const manifest = yield* runClaimSpecificLegacyJourneyEvidence({
    artifactDirectory: resolve(options.output, "artifacts"),
    legacyRepositoryRoot: "/srv/share/projects/vektorprogrammet/mono-web",
    phpExecutable: options.phpExecutable,
    runnerSourcePath: resolve(execution.runnerDirectory, "legacy-journey-evidence.ts"),
  });
  const manifestBytes = canonicalJson(manifest);
  fileSystem.writeFile(resolve(options.output, "legacy-run-manifest.json"), manifestBytes, "utf8");
  terminal.writeStandardOutput(`${manifestBytes}\n`);
});

await Effect.runPromise(
  program.pipe(
    Effect.provide(Layer.mergeAll(NodeRuntimeLayer, NodeJourneyHttpLayer, NodeJourneyProcessLayer)),
  ),
);

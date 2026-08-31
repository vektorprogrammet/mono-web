#!/usr/bin/env bun
import { resolve } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { canonicalJson } from "./src/canonical.js";
import {
  JourneyHttpClient,
  JourneyProcessExecutor,
  runClaimSpecificJourneyEvidence,
  type JourneyHttpRequest,
  type JourneyProcessHandle,
} from "./src/journey-evidence.js";
import { ParityExecutionEnvironment, ParityFileSystem, ParityTerminal } from "./src/services.js";
import { NodeRuntimeLayer } from "./node-runtime.js";

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

const parseOutput = (arguments_: readonly string[]): string => {
  const index = arguments_.indexOf("--output");
  if (index === -1 || arguments_[index + 1] === undefined) {
    throw new Error("journey-evidence-cli requires --output <evidence/capability-parity>");
  }
  if (arguments_.length !== 4 || arguments_[2] !== "--output") {
    throw new Error("JOURNEY_EVIDENCE_ARGUMENTS_INVALID");
  }
  return resolve(arguments_[index + 1]);
};

const program = Effect.gen(function* () {
  const execution = yield* ParityExecutionEnvironment;
  const fileSystem = yield* ParityFileSystem;
  const terminal = yield* ParityTerminal;
  const output = parseOutput(execution.arguments);
  const repositoryRoot = resolve(execution.runnerDirectory, "../../..");
  const manifest = yield* runClaimSpecificJourneyEvidence({
    artifactDirectory: resolve(output, "artifacts"),
    repositoryRoot,
    runnerSourcePath: resolve(execution.runnerDirectory, "journey-evidence.ts"),
  });
  const manifestBytes = canonicalJson(manifest);
  fileSystem.writeFile(resolve(output, "native-run-manifest.json"), manifestBytes, "utf8");
  terminal.writeStandardOutput(`${manifestBytes}\n`);
});

await Effect.runPromise(
  program.pipe(
    Effect.provide(Layer.mergeAll(NodeRuntimeLayer, NodeJourneyHttpLayer, NodeJourneyProcessLayer)),
  ),
);

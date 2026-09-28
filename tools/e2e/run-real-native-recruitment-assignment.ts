/**
 * Real native recruitment assignment journey: a disposable PostgreSQL cluster with the canonical
 * migrations, the unified native backend behind a recording proxy, the built dashboard, and one
 * Chromium journey, followed by the persistence evidence of the assignment.
 *
 * Usage: bun run --cwd apps/dashboard e2e:real-recruitment
 * Ports: RECRUITMENT_E2E_POSTGRES_PORT, RECRUITMENT_E2E_BACKEND_PORT, RECRUITMENT_E2E_DASHBOARD_PORT
 */
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  type DisposablePostgres,
  loopbackPortFree,
  postgresProgram,
  reserveLoopbackPorts,
  startDisposablePostgres,
} from "@monoweb/postgres";
import {
  databaseMigrationDefinitions,
  databaseSchemaRevision,
} from "@vektorprogrammet/database/migrations";
import {
  Cause,
  Config,
  Data,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import {
  Cookies,
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpMethod,
} from "effect/unstable/http";
import { flow } from "effect/Function";
import { ChildProcess } from "effect/unstable/process";
import { isNativeRpcPath } from "../../apps/dashboard/e2e/native-operations";
import { replacedAnswer, replacedRequest } from "../../apps/dashboard/e2e/native-rpc-ledger";
import { HarnessFailure } from "./golden-harness";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

const dashboardRoot = fileURLToPath(new URL("../../apps/dashboard/", import.meta.url));

const recruitmentAssignmentMigration = {
  id: 10,
  name: "native-recruitment-applicant-assignment",
};

/** The JSON text of a value, byte for byte what `JSON.stringify` writes. */
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const jsonText = <A>(value: A): string => encodeJson(value);

const journeyFailure = (message: string) => HarnessFailure.make({ stage: "recruitment", message });

class NotReady extends Data.TaggedError("NotReady")<{}> {}

interface MigrationEntry {
  readonly id: number;
  readonly name: string;
  readonly revision: string;
}

const parseMigrationDefinition = (
  definition: { readonly id: string; readonly name: string },
  index: number,
): MigrationEntry => {
  const match = /^([1-9]\d*)_(.+)$/u.exec(definition.id);

  if (match === null) {
    throw new Error(
      `canonical migration registry entry ${index} has malformed id ${jsonText(definition.id)}`,
    );
  }

  const numericId = Number(match[1]);

  if (!Number.isSafeInteger(numericId)) {
    throw new Error(
      `canonical migration registry entry ${index} has unsafe numeric id ${jsonText(definition.id)}`,
    );
  }

  if (match[2] !== definition.name) {
    throw new Error(
      `canonical migration registry entry ${index} id/name disagree: ${jsonText({
        id: definition.id,
        name: definition.name,
      })}`,
    );
  }

  return { id: numericId, name: definition.name, revision: definition.id };
};

const deriveCanonicalMigrationExpectation = (
  definitions: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  schemaRevision: string,
) => {
  let minimumId = Number.POSITIVE_INFINITY;
  let maximumId = Number.NEGATIVE_INFINITY;
  let previousId: number | undefined;
  let contiguous = true;
  let head: MigrationEntry | undefined;
  const seenIds = new Set<number>();

  for (const [index, definition] of definitions.entries()) {
    const parsed = parseMigrationDefinition(definition, index);

    if (seenIds.has(parsed.id)) {
      throw new Error(`canonical migration registry duplicates numeric id ${parsed.id}`);
    }

    seenIds.add(parsed.id);
    minimumId = Math.min(minimumId, parsed.id);
    maximumId = Math.max(maximumId, parsed.id);
    contiguous &&= previousId === undefined || parsed.id === previousId + 1;
    previousId = parsed.id;
    head = parsed;
  }

  if (head === undefined) {
    throw new Error("canonical migration registry must not be empty");
  }

  if (head.id !== maximumId) {
    throw new Error(
      `canonical migration registry head ${head.revision} does not have maximum numeric id ${maximumId}`,
    );
  }

  if (schemaRevision !== head.revision.replaceAll("-", "_")) {
    throw new Error(
      `canonical migration registry/revision disagreement: ${jsonText({
        registryHead: head.revision,
        databaseSchemaRevision: schemaRevision,
      })}`,
    );
  }

  return {
    count: definitions.length,
    minimumId,
    maximumId,
    contiguous,
    head: { id: head.id, name: head.name },
  };
};

const canonicalMigrationExpectation = deriveCanonicalMigrationExpectation(
  databaseMigrationDefinitions,
  databaseSchemaRevision,
);

const expectedMigrationEvidence = {
  ...canonicalMigrationExpectation,
  recruitmentAssignment: recruitmentAssignmentMigration,
};

const fixedClock = "2026-09-15T12:00:00.000Z";

const applicationId = "application-native-journey-0049";

const leaderPersonId = "journey-rec-leader-0049";

const interviewerPersonId = "journey-rec-interviewer-a-0049";

const interviewSchemaId = "interview-schema-native-journey-0049";

const betterAuthSecret = randomBytes(32).toString("base64url");

const commandTimeout = "300 seconds";

const shutdownTimeout = "5 seconds";

// The runner removes these from the environment it passes to every child.
const removedEnvironment = {
  API_MODE: undefined,
  VITE_API_MODE: undefined,
  ADMISSION_AUTH_TOKENS: undefined,
  ORGANIZATION_AUTH_TOKENS: undefined,
  RECEIPT_AUTH_TOKENS: undefined,
  JWT_SECRET: undefined,
  SYMFONY_API_URL: undefined,
};

type ChildEnvironment = Readonly<Record<string, string | undefined>>;

const configuredLoopbackPort = (name: string, fallback: number) =>
  Effect.gen(function* () {
    const value = yield* Config.withDefault(Config.String(name), String(fallback));

    if (!/^\d+$/u.test(value)) return yield* journeyFailure(`${name} must be an integer`);

    const port = Number(value);

    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
      return yield* journeyFailure(`${name} must be between 1 and 65535`);

    return port;
  });

const errorDetail = (cause: unknown): string =>
  Schema.is(HarnessFailure)(cause)
    ? cause.message
    : cause instanceof Error
      ? cause.message
      : String(cause);

const assertEqual = <A>(actual: A, expected: A, label: string) =>
  jsonText(actual) === jsonText(expected)
    ? Effect.void
    : Effect.fail(
        journeyFailure(
          `${label} mismatch\nexpected: ${jsonText(expected)}\nactual: ${jsonText(actual)}`,
        ),
      );

const assertPortAvailable = (port: number) =>
  Effect.tryPromise({
    try: () => loopbackPortFree(port),
    catch: (cause) =>
      journeyFailure(`could not inspect loopback port ${port}: ${errorDetail(cause)}`),
  }).pipe(
    Effect.flatMap((free) =>
      free ? Effect.void : Effect.fail(journeyFailure(`loopback port ${port} is already in use`)),
    ),
  );

const waitForPortRelease = (port: number) =>
  assertPortAvailable(port).pipe(
    Effect.retry(Schedule.spaced("100 millis").pipe(Schedule.upTo({ duration: shutdownTimeout }))),
    Effect.mapError(() => journeyFailure(`loopback port ${port} was not released`)),
  );

interface RunOptions {
  readonly cwd: string;
  readonly env: ChildEnvironment;
  readonly label: string;
  readonly capture?: boolean | undefined;
}

type ProcessExit = { readonly code: number | null; readonly signal: string | null };

const exitOf = (exit: Exit.Exit<number, unknown>): ProcessExit => {
  if (Exit.isSuccess(exit)) return { code: exit.value, signal: null };

  const error = Cause.squash(exit.cause);
  const message = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";

  return { code: null, signal: /signal: '(\w+)'/u.exec(message)?.[1] ?? null };
};

/** Runs one command in its own process group and returns its output when it captures it. */
const run = (command: string, args: ReadonlyArray<string>, options: RunOptions) =>
  Effect.scoped(
    Effect.gen(function* () {
      const capture = options.capture === true;

      const handle = yield* ChildProcess.make(command, args, {
        cwd: options.cwd,
        env: options.env,
        extendEnv: true,
        detached: true,
        stdin: "ignore",
        stdout: capture ? "pipe" : "inherit",
        stderr: capture ? "pipe" : "inherit",
        killSignal: "SIGTERM",
      }).pipe(
        Effect.mapError((cause) =>
          journeyFailure(`${options.label} could not start: ${errorDetail(cause)}`),
        ),
      );

      const [stdout, stderr, exit] = yield* Effect.all(
        [
          capture ? Stream.mkString(Stream.decodeText(handle.stdout)) : Effect.succeed(""),
          capture ? Stream.mkString(Stream.decodeText(handle.stderr)) : Effect.succeed(""),
          Effect.map(Effect.exit(handle.exitCode), exitOf),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError((cause) => journeyFailure(`${options.label}: ${errorDetail(cause)}`)),
        Effect.timeoutOrElse({
          duration: commandTimeout,
          orElse: () => Effect.fail(journeyFailure(`${options.label} timed out`)),
        }),
      );

      if (exit.code === 0) return { stdout, stderr };

      const detail = [stdout.trim(), stderr.trim()].filter((part) => part.length > 0).join("\n");

      return yield* journeyFailure(
        `${options.label} exited with ${exit.signal ?? `code ${exit.code}`}${detail.length > 0 ? `:\n${detail}` : ""}`,
      );
    }),
  );

interface OwnedChild {
  readonly scope: Scope.Closeable;
  readonly exited: Deferred.Deferred<ProcessExit>;
}

const start = (
  command: string,
  args: ReadonlyArray<string>,
  environment: ChildEnvironment,
  cwd: string,
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();

    const handle = yield* ChildProcess.make(command, args, {
      cwd,
      env: environment,
      extendEnv: true,
      detached: true,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      killSignal: "SIGTERM",
      forceKillAfter: shutdownTimeout,
    }).pipe(
      Scope.provide(scope),
      Effect.mapError((cause) =>
        journeyFailure(`${command} could not start: ${errorDetail(cause)}`),
      ),
    );

    const exited = yield* Deferred.make<ProcessExit>();

    yield* handle.exitCode.pipe(
      Effect.exit,
      Effect.flatMap((exit) => Deferred.succeed(exited, exitOf(exit))),
      Effect.forkDetach,
    );

    return { scope, exited } satisfies OwnedChild;
  });

/** Signals the group with SIGTERM, then SIGKILL after the shutdown timeout. */
const stop = (child: OwnedChild | undefined) =>
  child === undefined ? Effect.void : Scope.close(child.scope, Exit.void);

const waitForHttp = (url: string, child: OwnedChild, label: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    const attempt = client.execute(HttpClientRequest.get(url)).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.map((response) => response.status < 500),
      Effect.orElseSucceed(() => false),
    );

    yield* Effect.gen(function* () {
      if (yield* Deferred.isDone(child.exited))
        return yield* journeyFailure(`${label} exited before readiness`);

      if (!(yield* attempt)) return yield* new NotReady();
    }).pipe(
      Effect.retry({
        while: (error) => Predicate.isTagged(error, "NotReady"),
        schedule: Schedule.spaced("250 millis").pipe(Schedule.upTo({ duration: commandTimeout })),
      }),
      Effect.catchTag("NotReady", () =>
        Effect.fail(journeyFailure(`${label} did not become ready`)),
      ),
    );
  });

const JsonText = Schema.fromJsonString(Schema.Json);

const JsonObject = Schema.Record(Schema.String, Schema.Json);

type JsonObject = typeof JsonObject.Type;

const parseJsonBody = (bytes: Buffer): Schema.Json | undefined =>
  bytes.byteLength === 0
    ? undefined
    : Option.getOrUndefined(Schema.decodeOption(JsonText)(bytes.toString("utf8")));

/** One member of a JSON object, or `undefined` for anything else. */
const member = (value: Schema.Json | null | undefined, key: string): Schema.Json | undefined =>
  Option.getOrUndefined(
    Option.flatMap(Schema.decodeUnknownOption(JsonObject)(value), (object) =>
      Option.fromNullishOr(object[key]),
    ),
  );

const sessionCookieNames = new Set([
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
]);

const hasNamedCookie = (cookieHeader: string | null | undefined, names: ReadonlySet<string>) =>
  Predicate.isString(cookieHeader) &&
  cookieHeader.split(";").some((pair) => {
    const separator = pair.indexOf("=");

    return separator > 0 && names.has(pair.slice(0, separator).trim());
  });

interface ProxyRecord {
  method: string;
  path: string;
  pathAndQuery: string;
  status: number;
  sessionCookieAuth: boolean;
  jwtCookieAuth: boolean;
  authorizationHeaderPresent: boolean;
  requestJson: Schema.Json | undefined;
  idempotencyKey: string | null;
  ifMatch: string | null;
  responseJson: Schema.Json | null;
  responseEtag: string | null;
  rpcTag?: string;
  responseFailure?: Schema.Json | undefined;
}

interface RecordingProxy {
  readonly origin: string;
  readonly records: ReadonlyArray<ProxyRecord>;
  readonly close: Effect.Effect<void, HarnessFailure>;
}

const skippedRequestHeaders = ["connection", "content-length", "host", "transfer-encoding"];

const skippedResponseHeaders = [
  "content-encoding",
  "content-length",
  "set-cookie",
  "transfer-encoding",
];

const startRecordingProxy = (targetOrigin: string) =>
  Effect.gen(function* () {
    const records: Array<ProxyRecord> = [];
    const scope = yield* Scope.make();
    const client = yield* HttpClient.HttpClient;
    const runHandler = yield* FiberSet.makeRuntimePromise().pipe(Scope.provide(scope));

    const forward = (request: Request) =>
      Effect.gen(function* () {
        const incoming = new URL(request.url);
        const method = request.method;
        const requestUrl = new URL(`${incoming.pathname}${incoming.search}`, targetOrigin);
        const path = requestUrl.pathname;
        const requestBytes = Buffer.from(yield* Effect.promise(() => request.arrayBuffer()));
        const requestJson = parseJsonBody(requestBytes);
        const idempotencyKey = request.headers.get("idempotency-key");
        const ifMatch = request.headers.get("if-match");

        const record: ProxyRecord = {
          method,
          path,
          pathAndQuery: `${path}${requestUrl.search}`,
          status: 0,
          sessionCookieAuth: hasNamedCookie(request.headers.get("cookie"), sessionCookieNames),
          jwtCookieAuth: hasNamedCookie(request.headers.get("cookie"), new Set(["jwt_token"])),
          authorizationHeaderPresent: request.headers.has("authorization"),
          requestJson,
          idempotencyKey,
          ifMatch,
          responseJson: null,
          responseEtag: null,
        };

        const rpc = isNativeRpcPath(path) ? replacedRequest(requestJson) : undefined;

        // A native RPC is recorded as the HTTP route it replaced, with the facts of its message.
        if (rpc !== undefined) {
          const status = rpc.payload.status;

          record.rpcTag = rpc.tag;
          record.method = rpc.method;
          record.path = rpc.path;
          record.pathAndQuery =
            rpc.tag === "recruitment.readAssignmentBoard" && Predicate.isString(status)
              ? `${rpc.path}?status=${status}`
              : rpc.path;
          record.idempotencyKey = rpc.idempotencyKey;
          record.ifMatch = rpc.ifMatch;
          record.requestJson = rpc.requestJson;
          record.sessionCookieAuth ||= hasNamedCookie(
            rpc.messageHeaders.cookie,
            sessionCookieNames,
          );
          record.jwtCookieAuth ||= hasNamedCookie(
            rpc.messageHeaders.cookie,
            new Set(["jwt_token"]),
          );
          record.authorizationHeaderPresent ||= rpc.messageHeaders.authorization !== undefined;
        }

        records.push(record);

        return yield* Effect.gen(function* () {
          const headers = [...request.headers.entries()].filter(
            ([name]) => !skippedRequestHeaders.includes(name),
          );

          const outgoing = HttpClientRequest.make(HttpMethod.isHttpMethod(method) ? method : "GET")(
            requestUrl,
            { headers: Object.fromEntries(headers) },
          );

          const upstream = yield* client.execute(
            method === "GET" || method === "HEAD"
              ? outgoing
              : HttpClientRequest.bodyUint8Array(
                  outgoing,
                  requestBytes,
                  request.headers.get("content-type") ?? undefined,
                ),
          );

          const responseBytes = Buffer.from(yield* upstream.arrayBuffer);

          record.status = upstream.status;

          if (upstream.status >= 400) record.responseFailure = parseJsonBody(responseBytes);
          record.responseJson = parseJsonBody(responseBytes) ?? null;
          record.responseEtag = upstream.headers.etag ?? null;

          const answer = rpc === undefined ? undefined : replacedAnswer(record.responseJson);

          if (answer !== undefined) {
            record.status = answer.status;
            record.responseJson = answer.responseJson;
            record.responseEtag = answer.responseEtag;

            if (answer.status >= 400) record.responseFailure = answer.responseJson;
          }

          const responseHeaders = new Headers();

          for (const [name, value] of Object.entries(upstream.headers))
            if (!skippedResponseHeaders.includes(name)) responseHeaders.set(name, value);

          for (const cookie of Cookies.toSetCookieHeaders(upstream.cookies))
            responseHeaders.append("set-cookie", cookie);

          return new Response(responseBytes.byteLength === 0 ? null : responseBytes, {
            status: upstream.status,
            headers: responseHeaders,
          });
        }).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              record.status = 502;
              process.stderr.write(
                `Native recruitment proxy failure: ${errorDetail(Cause.squash(cause))}\n`,
              );

              return new Response(jsonText({ error: "native recruitment evidence proxy failed" }), {
                status: 502,
                headers: { "content-type": "application/json" },
              });
            }),
          ),
        );
      });

    const [port] = yield* Effect.tryPromise({
      try: () => reserveLoopbackPorts(1),
      catch: (cause) => journeyFailure(`proxy port: ${errorDetail(cause)}`),
    });

    const server = yield* Effect.try({
      try: () =>
        Bun.serve({
          hostname: "127.0.0.1",
          port,
          // Node's server, which this proxy replaced, closed no idle request.
          idleTimeout: 0,
          fetch: (request) => runHandler(forward(request)),
        }),
      catch: (cause) => journeyFailure(`proxy listen: ${errorDetail(cause)}`),
    });

    let closed = false;

    return {
      origin: `http://127.0.0.1:${port}`,
      records,
      close: Effect.suspend(() => {
        if (closed) return Effect.void;
        closed = true;

        return Effect.tryPromise({
          try: () => server.stop(true),
          catch: (cause) => journeyFailure(`proxy close: ${errorDetail(cause)}`),
        }).pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
      }),
    } satisfies RecordingProxy;
  });

const MigrationEvidence = Schema.Struct({
  count: Schema.Finite,
  minimumId: Schema.NullOr(Schema.Finite),
  maximumId: Schema.NullOr(Schema.Finite),
  contiguous: Schema.Boolean,
  recruitmentAssignment: Schema.NullOr(Schema.Struct({ id: Schema.Finite, name: Schema.String })),
  head: Schema.NullOr(Schema.Struct({ id: Schema.Finite, name: Schema.String })),
});

const PersistenceEvidence = Schema.Struct({
  interviewCount: Schema.Finite,
  scheduleCount: Schema.Finite,
  receiptCount: Schema.Finite,
  auditCount: Schema.Finite,
  interview: Schema.NullOr(
    Schema.Struct({
      interviewId: Schema.String,
      applicationId: Schema.String,
      departmentId: Schema.String,
      interviewerPersonId: Schema.NullOr(Schema.String),
      interviewSchemaId: Schema.NullOr(Schema.String),
      assignedByPersonId: Schema.NullOr(Schema.String),
      assignedAt: Schema.NullOr(Schema.String),
      revision: Schema.Finite,
    }),
  ),
  receipt: Schema.NullOr(
    Schema.Struct({
      commandId: Schema.String,
      applicationId: Schema.String,
      interviewId: Schema.NullOr(Schema.String),
      commandApplicationId: Schema.NullOr(Schema.String),
      commandInterviewerPersonId: Schema.NullOr(Schema.String),
      commandInterviewSchemaId: Schema.NullOr(Schema.String),
      committedAt: Schema.NullOr(Schema.String),
    }),
  ),
  audit: Schema.NullOr(
    Schema.Struct({
      commandId: Schema.String,
      interviewId: Schema.NullOr(Schema.String),
      applicationId: Schema.String,
      departmentId: Schema.NullOr(Schema.String),
      actorPersonId: Schema.NullOr(Schema.String),
      action: Schema.String,
      interviewRevision: Schema.NullOr(Schema.Finite),
      occurredAt: Schema.NullOr(Schema.String),
    }),
  ),
});

type MigrationEvidence = typeof MigrationEvidence.Type;

type PersistenceEvidence = typeof PersistenceEvidence.Type;

const assertMigrationEvidence = (evidence: MigrationEvidence) =>
  evidence.count !== expectedMigrationEvidence.count ||
  evidence.minimumId !== expectedMigrationEvidence.minimumId ||
  evidence.maximumId !== expectedMigrationEvidence.maximumId ||
  evidence.contiguous !== expectedMigrationEvidence.contiguous ||
  evidence.recruitmentAssignment?.id !== expectedMigrationEvidence.recruitmentAssignment.id ||
  evidence.recruitmentAssignment.name !== expectedMigrationEvidence.recruitmentAssignment.name ||
  evidence.head?.id !== expectedMigrationEvidence.head.id ||
  evidence.head.name !== expectedMigrationEvidence.head.name
    ? Effect.fail(
        journeyFailure(
          `canonical migration evidence failed: ${jsonText({
            expected: expectedMigrationEvidence,
            actual: evidence,
          })}`,
        ),
      )
    : Effect.void;

const assertPersistenceEvidence = (evidence: PersistenceEvidence) => {
  const { interview, receipt, audit } = evidence;

  return evidence.interviewCount !== 1 ||
    evidence.scheduleCount !== 0 ||
    evidence.receiptCount !== 1 ||
    evidence.auditCount !== 1 ||
    interview?.applicationId !== applicationId ||
    interview.interviewerPersonId !== interviewerPersonId ||
    interview.interviewSchemaId !== interviewSchemaId ||
    interview.assignedByPersonId !== leaderPersonId ||
    interview.assignedAt !== fixedClock ||
    interview.revision !== 0 ||
    receipt?.applicationId !== applicationId ||
    receipt.interviewId !== interview.interviewId ||
    receipt.commandApplicationId !== applicationId ||
    receipt.commandInterviewerPersonId !== interviewerPersonId ||
    receipt.commandInterviewSchemaId !== interviewSchemaId ||
    receipt.committedAt !== fixedClock ||
    audit?.commandId !== receipt.commandId ||
    audit.interviewId !== interview.interviewId ||
    audit.applicationId !== applicationId ||
    audit.departmentId !== interview.departmentId ||
    audit.actorPersonId !== leaderPersonId ||
    audit.actorPersonId !== interview.assignedByPersonId ||
    audit.action !== "ApplicantAssigned" ||
    audit.interviewRevision !== 0 ||
    audit.occurredAt !== fixedClock
    ? Effect.fail(
        journeyFailure(`native recruitment persistence evidence failed: ${jsonText(evidence)}`),
      )
    : Effect.void;
};

const signalExitCodes = { SIGINT: 130, SIGTERM: 143 } as const;

type Signal = keyof typeof signalExitCodes;

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const postgresPort = yield* configuredLoopbackPort("RECRUITMENT_E2E_POSTGRES_PORT", 55446);
  const backendPort = yield* configuredLoopbackPort("RECRUITMENT_E2E_BACKEND_PORT", 8800);
  const dashboardPort = yield* configuredLoopbackPort("RECRUITMENT_E2E_DASHBOARD_PORT", 5174);

  const playwrightNode = yield* Config.withDefault(
    Config.String("PLAYWRIGHT_NODE_EXECUTABLE"),
    "node",
  );

  const postgresUrl = `postgres://postgres@127.0.0.1:${postgresPort}/postgres`;
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;
  const seedPath = path.join(dashboardRoot, "e2e/native-recruitment-journey-seed.mjs");

  yield* Effect.all(
    [
      assertPortAvailable(postgresPort),
      assertPortAvailable(backendPort),
      assertPortAvailable(dashboardPort),
    ],
    { concurrency: "unbounded" },
  );

  const temporaryRoot = yield* fs.makeTempDirectory({
    prefix: "mono-web-native-recruitment-0049-1-",
  });

  const postgresRoot = path.join(temporaryRoot, "postgres");
  const browserEvidencePath = path.join(temporaryRoot, "browser-evidence.json");
  const receiptStagingRoot = path.join(temporaryRoot, "receipt-staging");
  const receiptCommittedRoot = path.join(temporaryRoot, "receipt-committed");

  const processEnvironment = {
    ...removedEnvironment,
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: String(backendPort),
    BACKEND_PG_URL: postgresUrl,
    BETTER_AUTH_SECRET: betterAuthSecret,
    NATIVE_IDENTITY_DEPLOYMENT: "local",
    NATIVE_IDENTITY_TRUSTED_ORIGINS: jsonText([dashboardOrigin]),
    OAUTH_CANONICAL_ORIGIN: backendOrigin,
    OAUTH_DASHBOARD_ORIGIN: dashboardOrigin,
    OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
    ADMISSION_FIXED_NOW: fixedClock,
    PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
    PASSWORD_RESET_DELIVERY_MODE: "disabled",
    RECEIPT_DELIVERY_MODE: "disabled",
    RECEIPT_STAGING_ROOT: receiptStagingRoot,
    RECEIPT_COMMITTED_ROOT: receiptCommittedRoot,
    RECEIPT_MAX_FILE_BYTES: "10485760",
    RECEIPT_E2E_TEST_MODE: "1",
  };

  let postgres: DisposablePostgres | undefined;
  let backend: OwnedChild | undefined;
  let dashboard: OwnedChild | undefined;
  let proxy: RecordingProxy | undefined;
  let cleaned = false;

  const runPsql = (sql: string, label: string) =>
    run(
      postgresProgram("psql"),
      [
        "-h",
        "127.0.0.1",
        "-p",
        String(postgresPort),
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
      ],
      { cwd: repositoryRoot, env: removedEnvironment, capture: true, label },
    ).pipe(Effect.map(({ stdout }) => stdout.trim()));

  const readMigrationEvidence = runPsql(
    `SELECT json_build_object(
        'count', (SELECT count(*)::int FROM vektorprogrammet_schema_migrations),
        'minimumId', (SELECT min(migration_id)::int FROM vektorprogrammet_schema_migrations),
        'maximumId', (SELECT max(migration_id)::int FROM vektorprogrammet_schema_migrations),
        'contiguous', NOT EXISTS (
          SELECT 1 FROM generate_series(
            (SELECT min(migration_id) FROM vektorprogrammet_schema_migrations),
            (SELECT max(migration_id) FROM vektorprogrammet_schema_migrations)
          ) AS expected(id)
          LEFT JOIN vektorprogrammet_schema_migrations actual ON actual.migration_id = expected.id
          WHERE actual.migration_id IS NULL
        ),
        'recruitmentAssignment', (SELECT json_build_object('id', migration_id, 'name', name) FROM vektorprogrammet_schema_migrations WHERE migration_id = ${recruitmentAssignmentMigration.id}),
        'head', (SELECT json_build_object('id', migration_id, 'name', name) FROM vektorprogrammet_schema_migrations ORDER BY migration_id DESC LIMIT 1)
      )`,
    "canonical migration evidence",
  ).pipe(
    Effect.flatMap((text) =>
      Schema.decodeEffect(Schema.fromJsonString(MigrationEvidence))(text).pipe(
        Effect.mapError((cause) =>
          journeyFailure(`canonical migration evidence failed: ${errorDetail(cause)}`),
        ),
      ),
    ),
  );

  const readPersistenceEvidence = runPsql(
    `SELECT json_build_object(
        'interviewCount', (SELECT count(*)::int FROM recruitment_interviews WHERE application_id = '${applicationId}'),
        'scheduleCount', (SELECT count(*)::int FROM recruitment_interview_schedules schedule INNER JOIN recruitment_interviews interview ON interview.interview_id = schedule.interview_id WHERE interview.application_id = '${applicationId}'),
        'receiptCount', (SELECT count(*)::int FROM recruitment_assignment_command_receipts WHERE application_id = '${applicationId}'),
        'auditCount', (SELECT count(*)::int FROM recruitment_assignment_audit WHERE application_id = '${applicationId}'),
        'interview', (SELECT row_to_json(value) FROM (
          SELECT interview_id AS "interviewId", application_id AS "applicationId", department_id AS "departmentId",
            interviewer_person_id AS "interviewerPersonId", interview_schema_id AS "interviewSchemaId",
            assigned_by_person_id AS "assignedByPersonId", to_char(assigned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "assignedAt",
            revision
          FROM recruitment_interviews WHERE application_id = '${applicationId}'
        ) value),
        'receipt', (SELECT row_to_json(value) FROM (
          SELECT command_id AS "commandId", application_id AS "applicationId", interview_id AS "interviewId",
            command_json->>'applicationId' AS "commandApplicationId",
            command_json->>'interviewerPersonId' AS "commandInterviewerPersonId",
            command_json->>'interviewSchemaId' AS "commandInterviewSchemaId",
            to_char(committed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "committedAt"
          FROM recruitment_assignment_command_receipts WHERE application_id = '${applicationId}'
        ) value),
        'audit', (SELECT row_to_json(value) FROM (
          SELECT command_id AS "commandId", interview_id AS "interviewId", application_id AS "applicationId",
            department_id AS "departmentId", actor_person_id AS "actorPersonId", action,
            interview_revision AS "interviewRevision",
            to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt"
          FROM recruitment_assignment_audit WHERE application_id = '${applicationId}'
        ) value)
      )`,
    "native recruitment persistence evidence",
  ).pipe(
    Effect.flatMap((text) =>
      Schema.decodeEffect(Schema.fromJsonString(PersistenceEvidence))(text).pipe(
        Effect.mapError((cause) =>
          journeyFailure(`native recruitment persistence evidence failed: ${errorDetail(cause)}`),
        ),
      ),
    ),
  );

  const cleanup = Effect.gen(function* () {
    if (cleaned) return;
    cleaned = true;

    const errors: Array<string> = [];

    const attempt = <E>(effect: Effect.Effect<unknown, E>) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => void errors.push(errorDetail(Cause.squash(cause)))),
        ),
      );

    yield* attempt(stop(dashboard));

    if (proxy !== undefined) yield* attempt(proxy.close);
    yield* attempt(stop(backend));

    const cluster = postgres;

    if (cluster !== undefined) yield* attempt(Effect.tryPromise(() => cluster.stop()));
    yield* attempt(fs.remove(temporaryRoot, { recursive: true, force: true }));

    if (errors.length > 0)
      return yield* journeyFailure(`native recruitment cleanup failed: ${errors.join("; ")}`);
  });

  const journey = Effect.gen(function* () {
    postgres = yield* Effect.tryPromise({
      try: () => startDisposablePostgres({ port: postgresPort, directory: postgresRoot }),
      catch: (cause) => journeyFailure(errorDetail(cause)),
    });
    yield* run("bun", [seedPath], {
      cwd: repositoryRoot,
      env: { ...processEnvironment, JOURNEY_SEED_PG_URL: postgresUrl },
      label: "existing native recruitment fixture and Identity seed",
    });

    const migrations = yield* readMigrationEvidence;

    yield* assertMigrationEvidence(migrations);

    const startedBackend = yield* start(
      "bun",
      ["run", "--cwd", "apps/backend", "start"],
      processEnvironment,
      repositoryRoot,
    );

    backend = startedBackend;
    yield* waitForHttp(`${backendOrigin}/health`, startedBackend, "unified native backend");

    const recording = yield* startRecordingProxy(backendOrigin);

    proxy = recording;

    const journeyEnvironment = {
      ...processEnvironment,
      API_URL: recording.origin,
      VITE_API_URL: recording.origin,
      DASHBOARD_ORIGIN: dashboardOrigin,
      REAL_NATIVE_IDENTITY_E2E: "1",
      REAL_NATIVE_CONDUCT_E2E: "1",
      RECRUITMENT_E2E_BROWSER_EVIDENCE_PATH: browserEvidencePath,
      RECRUITMENT_E2E_LEADER_PERSON_ID: leaderPersonId,
    };

    // The dev server optimizes newly discovered dependencies and reloads the page, which
    // aborts in-flight module imports under the browser. The journey serves the build.
    const dashboardEnvironment = {
      ...journeyEnvironment,
      HOST: "127.0.0.1",
      PORT: String(dashboardPort),
      NODE_ENV: "production",
    };

    yield* run("bun", ["run", "build"], {
      cwd: dashboardRoot,
      env: dashboardEnvironment,
      label: "native recruitment dashboard production build",
    });

    const startedDashboard = yield* start(
      "bun",
      ["server.mjs"],
      dashboardEnvironment,
      dashboardRoot,
    );

    dashboard = startedDashboard;
    yield* waitForHttp(`${dashboardOrigin}/login`, startedDashboard, "native dashboard");
    yield* run(
      playwrightNode,
      [
        "./node_modules/@playwright/test/cli.js",
        "test",
        "e2e/native-recruitment-session-journey.spec.ts",
        "--project=chromium",
        "--workers=1",
        "--retries=0",
      ],
      {
        cwd: dashboardRoot,
        env: journeyEnvironment,
        capture: true,
        label: "real native recruitment Chromium journey",
      },
    );

    const browser = yield* fs.readFileString(browserEvidencePath).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(JsonObject))),
      Effect.mapError((cause) =>
        journeyFailure(
          `native recruitment browser evidence was not valid JSON: ${errorDetail(cause)}`,
        ),
      ),
    );

    yield* assertEqual<Schema.Json | undefined>(
      browser.bridgeResponses,
      [
        { operation: "readAssignmentBoard", status: 200, authorizationHeaderPresent: false },
        { operation: "createApplicationInterview", status: 200, authorizationHeaderPresent: false },
        { operation: "readAssignmentBoard", status: 200, authorizationHeaderPresent: false },
        { operation: "readAssignmentBoard", status: 200, authorizationHeaderPresent: false },
      ],
      "browser bridge sequence",
    );

    const emptyList = (value: Schema.Json | undefined) =>
      Array.isArray(value) && value.length === 0;

    if (
      browser.renderedNativeLogin !== true ||
      browser.sessionCookieName !== "better-auth.session_token" ||
      browser.sessionPersonId !== leaderPersonId ||
      browser.rawAuthenticationLeak !== false ||
      browser.accessibilityViolations !== 0 ||
      !emptyList(browser.pageErrors) ||
      !emptyList(browser.legacyBrowserRequests) ||
      !emptyList(browser.externalBrowserRequests)
    )
      return yield* journeyFailure(`browser evidence failed: ${jsonText(browser)}`);

    const boardPath = "/api/recruitment/application-assignments";
    const createPath = `/api/recruitment/applications/${encodeURIComponent(applicationId)}/interviews`;

    const recruitmentRequests = recording.records.filter(
      ({ path: requestPath }) => requestPath === boardPath || requestPath === createPath,
    );

    const requiredTransportTail: ReadonlyArray<readonly [string, string, number]> = [
      ["GET", `${boardPath}?status=new`, 200],
      // An RPC command answers 200; the 201 and Location were HTTP transport facts.
      ["POST", createPath, 200],
      ["GET", `${boardPath}?status=new`, 200],
      ["GET", `${boardPath}?status=all`, 200],
    ];

    const leadingInitialAllFilterReadCount =
      recruitmentRequests.length - requiredTransportTail.length;

    if (leadingInitialAllFilterReadCount !== 1 && leadingInitialAllFilterReadCount !== 2)
      return yield* journeyFailure("native recruitment transport had an unexpected request count");

    const duplicateInitialAllFilterReadObserved = leadingInitialAllFilterReadCount === 2;

    const expectedTransport = [
      ...Array.from(
        { length: leadingInitialAllFilterReadCount },
        () => ["GET", `${boardPath}?status=all`, 200] as const,
      ),
      ...requiredTransportTail,
    ].map(([method, pathAndQuery, status]) => ({
      method,
      pathAndQuery,
      status,
      sessionCookieAuth: true,
      authorizationHeaderPresent: false,
      jwtCookieAuth: false,
      idempotencyKeyPresent: method === "POST",
      ifMatchPresent: false,
      requestBodyKeys: method === "POST" ? ["interviewSchemaId", "interviewerPersonId"] : [],
    }));

    yield* assertEqual(
      recruitmentRequests.map(
        ({
          method,
          pathAndQuery,
          status,
          sessionCookieAuth,
          authorizationHeaderPresent,
          jwtCookieAuth,
          idempotencyKey,
          ifMatch,
          requestJson,
        }) => ({
          method,
          pathAndQuery,
          status,
          sessionCookieAuth,
          authorizationHeaderPresent,
          jwtCookieAuth,
          idempotencyKeyPresent: Predicate.isString(idempotencyKey),
          ifMatchPresent: Predicate.isString(ifMatch),
          requestBodyKeys: Predicate.isObject(requestJson) ? Object.keys(requestJson).sort() : [],
        }),
      ),
      expectedTransport,
      "exact native recruitment transport",
    );

    const createRequest = recruitmentRequests.find(({ method }) => method === "POST");
    const responseJson = createRequest?.responseJson;
    const requestJson = createRequest?.requestJson;

    if (
      jsonText(Predicate.isObject(responseJson) ? Object.keys(responseJson).sort() : []) !==
        jsonText([
          "applicationId",
          "assignedAt",
          "assignedByPersonId",
          "coInterviewerPersonId",
          "departmentId",
          "interviewId",
          "interviewSchemaId",
          "interviewerPersonId",
          "revision",
        ]) ||
      member(requestJson, "interviewerPersonId") !== interviewerPersonId ||
      member(requestJson, "interviewSchemaId") !== interviewSchemaId ||
      !/^"vkr2\.[A-Za-z0-9_-]{43}"$/u.test(createRequest?.responseEtag ?? "") ||
      member(responseJson, "applicationId") !== applicationId ||
      Option.getOrUndefined(
        Option.map(
          Schema.decodeUnknownOption(JsonObject)(responseJson),
          (object) => object.coInterviewerPersonId,
        ),
      ) !== null ||
      member(responseJson, "interviewerPersonId") !== interviewerPersonId ||
      member(responseJson, "interviewSchemaId") !== interviewSchemaId ||
      member(responseJson, "assignedByPersonId") !== leaderPersonId ||
      member(responseJson, "revision") !== 0
    )
      return yield* journeyFailure(
        "Application interview creation did not use the generated v0.2 contract",
      );

    const browserEvidence = { ...browser, duplicateInitialAllFilterReadObserved };

    yield* fs
      .writeFileString(browserEvidencePath, `${jsonText(browserEvidence)}\n`)
      .pipe(Effect.mapError(flow(errorDetail, journeyFailure)));

    const legacyPaths = recording.records.filter(({ path: requestPath }) =>
      [
        "/api/admin/applications",
        "/api/admin/users",
        "/api/admin/interviews/schemas",
        "/api/admin/interviews/assign",
        "/api/admin/recruitment/assignment-board",
        "/api/admin/recruitment/interviews/assign",
      ].some(
        (legacyPath) => requestPath === legacyPath || requestPath.startsWith(`${legacyPath}/`),
      ),
    );

    if (
      recording.records.some(
        ({ authorizationHeaderPresent, jwtCookieAuth }) =>
          authorizationHeaderPresent || jwtCookieAuth,
      ) ||
      legacyPaths.length > 0
    )
      return yield* journeyFailure(
        `legacy or bearer authentication transport observed: ${jsonText({ legacyPaths })}`,
      );

    const persisted = yield* readPersistenceEvidence;

    yield* assertPersistenceEvidence(persisted);

    return {
      topology: {
        database: "disposable-loopback-postgresql",
        migrations: `canonical-${canonicalMigrationExpectation.minimumId}-through-${canonicalMigrationExpectation.maximumId}`,
        backend: "unified-native-effect-backend",
        dashboard: "loopback-react-router-dashboard",
        browser: "real-chromium",
        fixedClock,
        externalEffects: "disabled",
      },
      authentication: {
        renderedNativeLogin: true,
        cookieName: browser.sessionCookieName,
        personId: browser.sessionPersonId,
        processScopedBetterAuthConfiguration: true,
        bearerInjected: false,
        jwtCookieUsed: false,
        tokenMapConfigured: false,
        rawAuthenticationLeak: false,
      },
      browser: browserEvidence,
      nativeTransport: {
        initialAllFilterReadCount: leadingInitialAllFilterReadCount,
        duplicateInitialAllFilterReadObserved,
        requests: recruitmentRequests.map(
          ({ method, pathAndQuery, status, sessionCookieAuth, authorizationHeaderPresent }) => ({
            method,
            pathAndQuery,
            status,
            sessionCookieAuth,
            authorizationHeaderPresent,
          }),
        ),
      },
      postgres: { migrations, persisted },
    };
  });

  const signals = yield* Deferred.make<Signal>();

  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          (["SIGINT", "SIGTERM"] as const).map((signal) => {
            const listener = () => Deferred.doneUnsafe(signals, Effect.succeed(signal));

            process.once(signal, listener);

            return [signal, listener] as const;
          }),
        ),
        (listeners) =>
          Effect.sync(() => {
            for (const [signal, listener] of listeners) process.removeListener(signal, listener);
          }),
      );

      const outcome = yield* journey.pipe(
        Effect.map((evidence) => ({ kind: "passed" as const, evidence })),
        Effect.raceFirst(
          Effect.map(Deferred.await(signals), (signal) => ({ kind: "signal" as const, signal })),
        ),
        Effect.exit,
      );

      if (Exit.isSuccess(outcome) && outcome.value.kind === "signal") {
        yield* Effect.ignore(cleanup);

        return signalExitCodes[outcome.value.signal];
      }

      let primaryError: string | undefined;

      if (Exit.isFailure(outcome)) {
        const cluster = postgres;

        const postgresLog =
          cluster === undefined
            ? "<postgres log unavailable>"
            : yield* fs
                .readFileString(cluster.logFile)
                .pipe(Effect.orElseSucceed(() => "<postgres log unavailable>"));

        primaryError = `${errorDetail(Cause.squash(outcome.cause))}\nrecorded native transport: ${jsonText(proxy?.records ?? [])}\nPostgreSQL log:\n${postgresLog}`;
      }

      const cleanupError = yield* Effect.gen(function* () {
        yield* cleanup;

        if (yield* fs.exists(temporaryRoot))
          return yield* journeyFailure("native recruitment cleanup left the temporary root behind");

        yield* Effect.all(
          [
            waitForPortRelease(postgresPort),
            waitForPortRelease(backendPort),
            waitForPortRelease(dashboardPort),
          ],
          { concurrency: "unbounded" },
        );
      }).pipe(
        Effect.as<string | undefined>(undefined),
        Effect.catchCause((cause) => Effect.succeed(errorDetail(Cause.squash(cause)))),
      );

      if (primaryError !== undefined && cleanupError !== undefined)
        return yield* journeyFailure(
          `native recruitment journey and cleanup failed: ${primaryError}; ${cleanupError}`,
        );

      if (primaryError !== undefined) return yield* journeyFailure(primaryError);

      if (cleanupError !== undefined) return yield* journeyFailure(cleanupError);

      const passed = Exit.isSuccess(outcome) ? outcome.value : undefined;

      if (passed?.kind === "passed")
        yield* Effect.sync(() =>
          process.stdout.write(
            `${jsonText({
              ...passed.evidence,
              cleanup: {
                postgresRemoved: true,
                temporaryRootRemoved: true,
                portsReleased: [postgresPort, backendPort, dashboardPort],
              },
            })}\n`,
          ),
        );

      return 0;
    }),
  );
});

Effect.runPromise(
  program.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
).then(
  (code) => {
    if (code === 0) process.exitCode = 0;
    else process.exit(code);
  },
  (cause: unknown) => {
    process.stderr.write(
      `Real native recruitment assignment runner failed: ${errorDetail(cause)}\n`,
    );
    process.exitCode = 1;
  },
);

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
} from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { AdmissionsLive } from "@vektorprogrammet/domain/admissions";
import { ContentLive, ContentManagementLive } from "@vektorprogrammet/domain/content";
import { Database, type DatabaseShape, databaseHealth } from "@vektorprogrammet/domain/database";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import {
  Identity,
  IdentityActor,
  IdentityEngineError,
  IdentitySessionNotFound,
  type IdentityShape,
} from "@vektorprogrammet/domain/identity";
import {
  Organization,
  OrganizationLive,
  PersonId,
  importLegacyOrganizationEffect,
  type LegacyOrganizationSnapshot,
  type OrganizationImportResult,
} from "@vektorprogrammet/domain/organization";
import { EconomyLive } from "@vektorprogrammet/domain/receipt/postgres";
import { ProfileLive } from "@vektorprogrammet/domain/profile";
import { RecruitmentLive } from "@vektorprogrammet/domain/recruitment";
import { SchoolsLive } from "@vektorprogrammet/domain/schools";
import { Config, DateTime, Effect, Layer, Redacted, Result } from "effect";
import { makeBackendConfig } from "../../../apps/backend/src/config.js";
import { makeBackendHttp, type BackendRun } from "../../../apps/backend/src/router.js";
import { makeBackendRuntime } from "../../../apps/backend/runtime.js";
import { DatabaseLive } from "../src/layers.js";
import { databaseMigrationDefinitions, databaseSchemaRevision } from "../src/migrations.js";
import {
  NATIVE_BROWSER_JOURNEY_REQUIREMENTS,
  SPEC_0067,
  SPEC_0067_PREREQUISITES,
  decodeFrozenOrganizationSnapshot,
  decodeOrganizationImportBrowserFailedEvidence,
  decodeOrganizationImportBrowserObservedEvidence,
  verifyOrganizationImportRehearsalArtifact,
  expectedOrganizationImportOutcomeMatrix,
  frozenOrganizationSnapshotCore,
  frozenOrganizationSnapshotInput,
  makeOrganizationImportSqlObserverState,
  observeOrganizationImportSql,
  organizationImportOutcomeMatrix,
  organizationImportProvenanceEvidence,
  type OrganizationImportBrowserFailedEvidence,
} from "../src/test-support/organization-import-rehearsal.js";
import {
  compareStableByteSets,
  installOrganizationImportFailureTrigger,
  readOrganizationImportStableState,
  removeOrganizationImportFailureTrigger,
  stableByteSetEvidence,
  type OrganizationImportStableState,
} from "../src/test-support/organization-import-rehearsal-postgres.js";

interface BunServer {
  readonly hostname: string;
  readonly port: number;
  readonly stop: (closeActiveConnections?: boolean) => Promise<void> | void;
}

declare const Bun: {
  serve: (options: {
    readonly hostname: string;
    readonly port: number;
    readonly fetch: (request: Request) => Response | Promise<Response>;
  }) => BunServer;
};

interface ProcessObservation {
  readonly label: string;
  readonly outcome: "Exited" | "SpawnFailed" | "Stopped" | "AlreadyExited" | "NotStarted";
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface ProcessEffectObserver {
  deploymentAttempts: number;
}

interface ProxyRequestObservation {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly sessionCookieAuth: boolean;
  readonly requestSource: "BrowserCrossOrigin" | "DashboardSsr" | "UnexpectedOrigin";
}

interface RehearsalProxy {
  readonly origin: string;
  readonly port: number;
  readonly records: ReadonlyArray<ProxyRequestObservation>;
  readonly close: () => Promise<void>;
}

interface BackendRequestObservation {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly sessionCookieAuth: boolean;
}

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const dashboardRoot = join(repositoryRoot, "apps/dashboard");
const sdkRoot = join(repositoryRoot, "packages/sdk");
const dashboardPort = 5_187;
const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;

export const ORGANIZATION_IMPORT_PLAYWRIGHT_ARGUMENTS = [
  "./node_modules/@playwright/test/cli.js",
  "test",
  "e2e/organization-import-rehearsal.spec.ts",
  "--config=playwright.organization-import-rehearsal.config.ts",
  "--project=chromium",
  "--workers=1",
  "--retries=0",
  "--reporter=line",
] as const;

export const ORGANIZATION_IMPORT_DASHBOARD_BUILD_ARGUMENTS = ["run", "build"] as const;

export const ORGANIZATION_IMPORT_DASHBOARD_SERVE_ARGUMENTS = [
  "node_modules/@react-router/serve/bin.cjs",
  "build/server/index.js",
] as const;

export const ORGANIZATION_IMPORT_GENERATED_OUTPUT_PATHS = [
  "packages/sdk/dist",
  "packages/sdk/tsconfig.tsbuildinfo",
  "apps/dashboard/.react-router",
  "apps/dashboard/build",
] as const;

export const ORGANIZATION_IMPORT_DASHBOARD_RUNTIME = {
  build: "ReactRouterProductionBuild",
  server: "ReactRouterServe",
  viteDependencyOptimizer: "NotUsed",
} as const;

export const EXPECTED_MIGRATION_23_AUTH_TABLES = [
  "auth.account",
  "auth.session",
  "auth.user",
  "auth.verification",
] as const;

export const EXPECTED_MIGRATION_23_PUBLIC_TABLES = [
  "public.admission_applicants",
  "public.admission_application_audit",
  "public.admission_application_command_receipts",
  "public.admission_application_outbox",
  "public.admission_applications",
  "public.admission_period_audit",
  "public.admission_period_command_receipts",
  "public.admission_period_departments",
  "public.admission_period_fields_of_study",
  "public.admission_period_outbox",
  "public.admission_period_semesters",
  "public.admission_periods",
  "public.authz_rules",
  "public.authz_tag_assignments",
  "public.authz_tags",
  "public.content_article_departments",
  "public.content_article_versions",
  "public.content_articles",
  "public.content_publication_audit",
  "public.content_publication_command_receipts",
  "public.economy_payment_authorities",
  "public.economy_receipt_approval_grants",
  "public.economy_receipt_audit",
  "public.economy_receipt_command_receipts",
  "public.economy_receipt_import_ledger",
  "public.economy_receipt_outbox",
  "public.economy_receipts",
  "public.organization_command_receipts",
  "public.organization_creation_audit",
  "public.organization_departments",
  "public.organization_field_of_studies",
  "public.organization_global_administrator_grants",
  "public.organization_import_ledger",
  "public.organization_membership_quarantine",
  "public.organization_memberships",
  "public.organization_team_interest_registrations",
  "public.organization_teams",
  "public.person_contact_profiles",
  "public.person_profiles",
  "public.profile_self_edit_commands",
  "public.recruitment_assignment_audit",
  "public.recruitment_assignment_command_receipts",
  "public.recruitment_interview_cancellations",
  "public.recruitment_interview_conducts",
  "public.recruitment_interview_lifecycle_audit",
  "public.recruitment_interview_lifecycle_command_receipts",
  "public.recruitment_interview_question_snapshots",
  "public.recruitment_interview_schedules",
  "public.recruitment_interview_schema_questions",
  "public.recruitment_interview_schemas",
  "public.recruitment_interviews",
  "public.recruitment_invitation_outbox",
  "public.recruitment_invitation_response_audit",
  "public.recruitment_invitation_response_outbox",
  "public.recruitment_invitations",
  "public.recruitment_schedule_audit",
  "public.recruitment_schedule_command_receipts",
  "public.schools_directory_departments",
  "public.schools_directory_schools",
  "public.vektorprogrammet_schema_migrations",
] as const;

const NATIVE_BROWSER_JOURNEY_PATHS = NATIVE_BROWSER_JOURNEY_REQUIREMENTS.map(({ path }) => path);

export const isNativeBrowserJourneyRequestAllowed = (method: string, path: string): boolean =>
  (method === "GET" || method === "OPTIONS") &&
  NATIVE_BROWSER_JOURNEY_REQUIREMENTS.some((requirement) => requirement.path === path);

export const isExpectedNativeBrowserJourneyObservation = (input: {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly sessionCookieAuth: boolean;
  readonly requestSource: "BrowserCrossOrigin" | "DashboardSsr" | "UnexpectedOrigin";
}): boolean => {
  const requirement = NATIVE_BROWSER_JOURNEY_REQUIREMENTS.find(({ path }) => path === input.path);
  return (
    input.method === "GET" &&
    input.status === 200 &&
    requirement !== undefined &&
    input.sessionCookieAuth === (requirement.access === "BoundedSession") &&
    input.requestSource === requirement.requestSource
  );
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const sha256Text = (value: string): string => sha256Hex(new TextEncoder().encode(value));

export interface GeneratedOutputSnapshot {
  readonly path: string;
  readonly relativePath: string;
  readonly preexisting: boolean;
  readonly beforeSha256: string | null;
  readonly backupPath: string | null;
}

const logicalPathSha256 = async (root: string): Promise<string> => {
  const entries: Array<Record<string, unknown>> = [];
  const visit = async (path: string): Promise<void> => {
    const metadata = await lstat(path);
    const relativePath = relative(root, path) || ".";
    if (metadata.isSymbolicLink()) {
      entries.push({ path: relativePath, type: "symlink", target: await readlink(path) });
      return;
    }
    if (metadata.isFile()) {
      const bytes = await readFile(path);
      entries.push({
        path: relativePath,
        type: "file",
        byteLength: bytes.byteLength,
        sha256: sha256Hex(bytes),
      });
      return;
    }
    if (!metadata.isDirectory()) {
      throw new Error(`unsupported generated output entry: ${relativePath}`);
    }
    entries.push({ path: relativePath, type: "directory" });
    const children = (await readdir(path)).sort();
    for (const child of children) await visit(join(path, child));
  };
  await visit(root);
  return sha256Hex(canonicalJsonBytes(entries));
};

export const captureGeneratedOutputs = async (
  paths: ReadonlyArray<string>,
  backupRoot: string,
): Promise<GeneratedOutputSnapshot[]> => {
  await mkdir(backupRoot, { recursive: true });
  const snapshots: GeneratedOutputSnapshot[] = [];
  for (const [index, path] of paths.entries()) {
    const preexisting = await pathExists(path);
    const backupPath = preexisting ? join(backupRoot, String(index)) : null;
    const beforeSha256 = preexisting ? await logicalPathSha256(path) : null;
    if (backupPath !== null) {
      await cp(path, backupPath, { recursive: true, preserveTimestamps: true });
    }
    snapshots.push({
      path,
      relativePath: relative(repositoryRoot, path),
      preexisting,
      beforeSha256,
      backupPath,
    });
  }
  return snapshots;
};
export const clearCapturedGeneratedOutputs = async (
  snapshots: ReadonlyArray<GeneratedOutputSnapshot>,
): Promise<void> => {
  for (const snapshot of snapshots) {
    await rm(snapshot.path, { recursive: true, force: true });
  }
};

export const restoreGeneratedOutput = async (snapshot: GeneratedOutputSnapshot) => {
  await rm(snapshot.path, { recursive: true, force: true });
  if (snapshot.preexisting) {
    assert.ok(snapshot.backupPath !== null);
    await cp(snapshot.backupPath, snapshot.path, {
      recursive: true,
      preserveTimestamps: true,
    });
  }
  const afterExists = await pathExists(snapshot.path);
  const afterSha256 = afterExists ? await logicalPathSha256(snapshot.path) : null;
  const restored = afterExists === snapshot.preexisting && afterSha256 === snapshot.beforeSha256;
  if (!restored) throw new Error(`generated output restoration mismatch: ${snapshot.relativePath}`);
  return {
    path: snapshot.relativePath,
    preexisting: snapshot.preexisting,
    beforeSha256: snapshot.beforeSha256,
    afterSha256,
    restored,
  };
};

const makeChildToolEnvironment = (runnerTempRoot: string): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {
    HOME: join(runnerTempRoot, "home"),
    TMPDIR: join(runnerTempRoot, "tmp"),
    XDG_CACHE_HOME: join(runnerTempRoot, "cache"),
    PLAYWRIGHT_BROWSERS_PATH:
      process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache/ms-playwright"),
  };
  for (const name of [
    "PATH",
    "LANG",
    "LC_ALL",
    "NIX_SSL_CERT_FILE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
};

const normalizedLoopbackHost = (host: string): string =>
  host === "localhost" || host === "::1" ? "127.0.0.1" : host;

const isLocalPostgresEndpoint = (url: URL): boolean => {
  if (normalizedLoopbackHost(url.hostname) === "127.0.0.1") return true;
  const socketDirectory = url.searchParams.get("host");
  return url.hostname === "" && socketDirectory !== null && socketDirectory.startsWith("/");
};

class LocalNetworkGuard {
  readonly allowedDestinations = new Set<string>();
  readonly rejectedDestinations: string[] = [];
  productionResourceAttempts = 0;
  providerRequests = 0;
  remoteEffectAttempts = 0;
  readonly #allowedOrigins = new Set<string>();

  addHttp(origin: string, label: string): void {
    const url = new URL(origin);
    assert.equal(url.protocol, "http:");
    assert.equal(normalizedLoopbackHost(url.hostname), "127.0.0.1");
    this.#allowedOrigins.add(url.origin);
    this.allowedDestinations.add(label);
  }

  addPostgres(urlValue: string): void {
    const url = new URL(urlValue);
    assert.ok(url.protocol === "postgres:" || url.protocol === "postgresql:");
    if (!isLocalPostgresEndpoint(url)) {
      this.productionResourceAttempts += 1;
      this.remoteEffectAttempts += 1;
      throw new Error("the rehearsal PostgreSQL authority must be loopback or a local Unix socket");
    }
    this.allowedDestinations.add("local-postgresql/disposable-database");
  }

  readonly fetchLoopback = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.protocol !== "http:" || !this.#allowedOrigins.has(url.origin)) {
      this.productionResourceAttempts += 1;
      this.remoteEffectAttempts += 1;
      if (url.protocol === "http:" || url.protocol === "https:") this.providerRequests += 1;
      this.rejectedDestinations.push(`${url.protocol}//${url.hostname}`);
      throw new Error("network guard rejected a non-rehearsal destination");
    }
    return fetch(request);
  };
}

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const createDisposableDatabase = async (
  administratorUrl: string,
  databaseName: string,
): Promise<{ readonly url: string; readonly administrator: Pool }> => {
  const admin = new URL(administratorUrl);
  if (
    (admin.protocol !== "postgres:" && admin.protocol !== "postgresql:") ||
    !isLocalPostgresEndpoint(admin)
  ) {
    throw new Error(
      "ORGANIZATION_IMPORT_REHEARSAL_ADMIN_PG_URL must use loopback PostgreSQL or a local Unix socket",
    );
  }
  const administrator = new Pool({ connectionString: admin.toString(), max: 1 });
  try {
    await administrator.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } catch (cause) {
    await administrator.end();
    throw cause;
  }
  const target = new URL(admin);
  target.pathname = `/${databaseName}`;
  return { url: target.toString(), administrator };
};

const dropDisposableDatabase = async (
  administrator: Pool,
  databaseName: string,
): Promise<{ readonly databaseAbsent: boolean; readonly residualConnections: number }> => {
  await administrator.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [databaseName],
  );
  await administrator.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`);
  const result = await administrator.query<{ readonly count: string }>(
    "SELECT count(*)::text AS count FROM pg_database WHERE datname = $1",
    [databaseName],
  );
  const connections = await administrator.query<{ readonly count: string }>(
    "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = $1",
    [databaseName],
  );
  return {
    databaseAbsent: Number(result.rows[0]?.count ?? "-1") === 0,
    residualConnections: Number(connections.rows[0]?.count ?? "-1"),
  };
};

const rejectDeploymentIntent = (
  command: string,
  args: ReadonlyArray<string>,
  observer: ProcessEffectObserver,
  label: string,
): void => {
  const processIntent = [basename(command), ...args].join(" ");
  if (!/\b(?:deploy|publish|wrangler|alchemy)\b/iu.test(processIntent)) return;
  observer.deploymentAttempts += 1;
  throw new Error(`deployment-capable child command rejected before spawn: ${label}`);
};

const runCommand = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly label: string;
    readonly observations: ProcessObservation[];
    readonly processEffects: ProcessEffectObserver;
    readonly captureOutput?: (output: string) => void;
    readonly timeoutMilliseconds?: number;
  },
): Promise<ProcessObservation> => {
  rejectDeploymentIntent(command, args, options.processEffects, options.label);
  const { promise, resolve, reject } = Promise.withResolvers<ProcessObservation>();
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let settled = false;
  const capture = (chunk: Buffer): void => {
    output = `${output}${chunk.toString("utf8")}`.slice(-16_384);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMilliseconds ?? 300_000);
  child.once("error", (cause) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.observations.push({
      label: options.label,
      outcome: "SpawnFailed",
      exitCode: null,
      signal: null,
    });
    reject(new Error(`${options.label} failed to spawn: ${String(cause)}`));
  });
  child.once("exit", (exitCode, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const observation: ProcessObservation = {
      label: options.label,
      outcome: "Exited",
      exitCode,
      signal,
    };
    options.observations.push(observation);
    options.captureOutput?.(output);
    if (exitCode === 0) {
      resolve(observation);
    } else {
      reject(
        new Error(
          `${options.label} failed with exit ${String(exitCode)} signal ${String(signal)}: ${output}`,
        ),
      );
    }
  });
  return promise;
};

const readGitValue = async (
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  observations: ProcessObservation[],
  processEffects: ProcessEffectObserver,
): Promise<string> => {
  let output = "";
  await runCommand("git", args, {
    cwd: repositoryRoot,
    env: environment,
    label: `git ${args.join(" ")}`,
    observations,
    processEffects,
    captureOutput: (value) => {
      output = value;
    },
  });
  const value = output.trim();
  if (value.length === 0) throw new Error(`git ${args.join(" ")} returned no value`);
  return value;
};

const startDashboard = (
  env: NodeJS.ProcessEnv,
  observations: ProcessObservation[],
  processEffects: ProcessEffectObserver,
): Promise<ChildProcess> => {
  const command = process.env.PLAYWRIGHT_NODE_EXECUTABLE ?? "node";
  const args = ORGANIZATION_IMPORT_DASHBOARD_SERVE_ARGUMENTS;
  const label = "dashboard production server";
  rejectDeploymentIntent(command, args, processEffects, label);
  const child = spawn(command, args, {
    cwd: dashboardRoot,
    env: {
      ...env,
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      PORT: String(dashboardPort),
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const started = Promise.withResolvers<ChildProcess>();
  child.once("spawn", () => started.resolve(child));
  child.once("error", (cause) => {
    observations.push({
      label,
      outcome: "SpawnFailed",
      exitCode: null,
      signal: null,
    });
    started.reject(cause);
  });
  return started.promise;
};

const stopProcessTree = async (
  processHandle: ChildProcess | undefined,
  label: string,
): Promise<ProcessObservation> => {
  if (processHandle === undefined) {
    return { label, outcome: "NotStarted", exitCode: null, signal: null };
  }
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    return {
      label,
      outcome: "AlreadyExited",
      exitCode: processHandle.exitCode,
      signal: processHandle.signalCode,
    };
  }
  const pid = processHandle.pid;
  const { promise, resolve } = Promise.withResolvers<ProcessObservation>();
  let timer: NodeJS.Timeout | undefined;
  processHandle.once("exit", (exitCode, signal) => {
    clearTimeout(timer);
    resolve({ label, outcome: "Stopped", exitCode, signal });
  });
  if (pid !== undefined) process.kill(-pid, "SIGTERM");
  timer = setTimeout(() => {
    if (pid !== undefined && processHandle.exitCode === null && processHandle.signalCode === null) {
      process.kill(-pid, "SIGKILL");
    }
  }, 5_000);
  return promise;
};

const assertPortAvailable = (port: number): Promise<void> => {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const server = createNetServer();
  server.once("error", reject);
  server.listen(port, "127.0.0.1", () => {
    server.close((cause) => (cause === undefined ? resolve() : reject(cause)));
  });
  return promise;
};

const isPortReleased = (port: number): Promise<boolean> => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = createConnection({ host: "127.0.0.1", port });
  const settle = (released: boolean): void => {
    socket.removeAllListeners();
    socket.destroy();
    resolve(released);
  };
  socket.setTimeout(250, () => settle(true));
  socket.once("error", () => settle(true));
  socket.once("connect", () => settle(false));
  return promise;
};

const delay = (milliseconds: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
};

export const boundedCookieCapabilityFailure = (input: {
  readonly cookieName: string;
  readonly cookieValue: string;
  readonly dashboardOrigin: string;
  readonly apiOrigin: string;
  readonly authorizationInstant: string;
  readonly expiresAt: string;
}): string | undefined => {
  const dashboardUrl = new URL(input.dashboardOrigin);
  const apiUrl = new URL(input.apiOrigin);
  if (
    normalizedLoopbackHost(dashboardUrl.hostname) !== "127.0.0.1" ||
    normalizedLoopbackHost(apiUrl.hostname) !== "127.0.0.1" ||
    dashboardUrl.hostname !== apiUrl.hostname
  ) {
    return "bounded cookie requires one shared loopback host for dashboard and API";
  }
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(input.cookieName)) {
    return "bounded cookie name is not representable by Chromium";
  }
  if (input.cookieValue.length === 0) return "bounded cookie value is empty";
  const authorizationTime = Date.parse(input.authorizationInstant);
  const expiryTime = Date.parse(input.expiresAt);
  if (!Number.isFinite(authorizationTime) || !Number.isFinite(expiryTime)) {
    return "bounded cookie interval is not a valid instant";
  }
  if (authorizationTime >= expiryTime) {
    return "bounded cookie expires before the fixed authorization instant";
  }
  return undefined;
};

export interface ExistingPageSessionCapabilityObservation {
  readonly path: string;
  readonly status: number;
  readonly location: string | null;
}

export type ExistingPageSessionCapability =
  | { readonly _tag: "Practical" }
  | {
      readonly _tag: "BrowserNotPractical";
      readonly capability: "ExistingPageBoundedSession";
      readonly reason: string;
    }
  | { readonly _tag: "EnvironmentFailure"; readonly reason: string };

const loginRedirectPath = (location: string | null): string | undefined => {
  if (location === null) return undefined;
  try {
    const redirect = new URL(location, "http://127.0.0.1");
    return redirect.pathname === "/login" ? `${redirect.pathname}${redirect.search}` : undefined;
  } catch {
    return undefined;
  }
};

export const classifyExistingPageSessionCapability = (
  observations: ReadonlyArray<ExistingPageSessionCapabilityObservation>,
): ExistingPageSessionCapability => {
  if (observations.length === 0) {
    return {
      _tag: "EnvironmentFailure",
      reason: "existing page/session capability preflight produced no observations",
    };
  }
  for (const observation of observations) {
    const loginRedirect = loginRedirectPath(observation.location);
    if (observation.status >= 300 && observation.status < 400 && loginRedirect !== undefined) {
      return {
        _tag: "BrowserNotPractical",
        capability: "ExistingPageBoundedSession",
        reason:
          `existing page/session gate cannot consume the bounded cookie: ${observation.path} ` +
          `redirected to ${loginRedirect}; proceeding would require credentials, an auth write, ` +
          "a product change, or a legacy service",
      };
    }
    if (observation.status === 401 || observation.status === 403) {
      return {
        _tag: "BrowserNotPractical",
        capability: "ExistingPageBoundedSession",
        reason:
          `existing page/session gate rejected the bounded cookie: ${observation.path} returned ` +
          `${observation.status}; proceeding would require credentials, an auth write, ` +
          "a product change, or a legacy service",
      };
    }
    if (observation.status !== 200) {
      return {
        _tag: "EnvironmentFailure",
        reason:
          `existing page/session capability preflight received unexpected ${observation.status} ` +
          `${observation.path}${observation.location === null ? "" : ` -> ${observation.location}`}`,
      };
    }
  }
  return { _tag: "Practical" };
};

const observeExistingPageSessionCapability = async (
  dashboardOrigin: string,
  cookieName: string,
  cookieValue: string,
  guard: LocalNetworkGuard,
): Promise<ReadonlyArray<ExistingPageSessionCapabilityObservation>> => {
  const observations: ExistingPageSessionCapabilityObservation[] = [];
  for (const path of ["/dashboard/team", "/dashboard/brukere"] as const) {
    const response = await guard.fetchLoopback(`${dashboardOrigin}${path}`, {
      headers: {
        accept: "text/html",
        cookie: `${cookieName}=${cookieValue}`,
      },
      redirect: "manual",
    });
    observations.push({
      path,
      status: response.status,
      location: response.headers.get("location"),
    });
    await response.body?.cancel();
  }
  return observations;
};

const waitForHttp = async (
  url: string,
  guard: LocalNetworkGuard,
  processHandle?: ChildProcess,
): Promise<void> => {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (
      processHandle !== undefined &&
      (processHandle.exitCode !== null || processHandle.signalCode !== null)
    ) {
      throw new Error("dashboard exited before its loopback HTTP endpoint was ready");
    }
    try {
      const response = await guard.fetchLoopback(url, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Bounded readiness retries are local observations, not product retries.
    }
    await delay(100);
  }
  throw new Error("dashboard loopback HTTP readiness timed out");
};

const requestBodyBytes = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const startRecordingProxy = async (
  targetOrigin: string,
  dashboardAllowedOrigin: string,
  guard: LocalNetworkGuard,
  cookieName: string,
): Promise<RehearsalProxy> => {
  const records: ProxyRequestObservation[] = [];
  const server: HttpServer = createHttpServer(async (request, response) => {
    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", targetOrigin).pathname;
    const cookie = request.headers.cookie ?? "";
    const sessionCookieAuth = cookie
      .split(";")
      .some((pair) => pair.trim().startsWith(`${cookieName}=`));
    const requestSource =
      request.headers.origin === undefined
        ? ("DashboardSsr" as const)
        : request.headers.origin === dashboardAllowedOrigin
          ? ("BrowserCrossOrigin" as const)
          : ("UnexpectedOrigin" as const);
    const allowedPath = NATIVE_BROWSER_JOURNEY_PATHS.some(
      (allowedJourneyPath) => allowedJourneyPath === path,
    );
    if (!isNativeBrowserJourneyRequestAllowed(method, path)) {
      const status = allowedPath ? 405 : 404;
      records.push({ method, path, status, sessionCookieAuth, requestSource });
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end('{"error":"unexpected rehearsal API request"}');
      return;
    }
    if (method === "OPTIONS") {
      records.push({ method, path, status: 204, sessionCookieAuth, requestSource });
      response.statusCode = 204;
      response.setHeader("access-control-allow-origin", dashboardAllowedOrigin);
      response.setHeader("access-control-allow-credentials", "true");
      response.setHeader("access-control-allow-methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
      response.setHeader("access-control-allow-headers", "content-type");
      response.end();
      return;
    }
    const requestBytes = await requestBodyBytes(request);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (
        value === undefined ||
        ["connection", "content-length", "host", "transfer-encoding"].includes(name)
      ) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item);
      } else {
        headers.set(name, value);
      }
    }
    try {
      const upstream = await guard.fetchLoopback(new URL(request.url ?? "/", targetOrigin), {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : requestBytes,
        redirect: "manual",
      });
      const responseBytes = Buffer.from(await upstream.arrayBuffer());
      records.push({ method, path, status: upstream.status, sessionCookieAuth, requestSource });
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers.entries()) {
        if (["content-encoding", "content-length", "transfer-encoding"].includes(name)) continue;
        response.setHeader(name, value);
      }
      const setCookie = upstream.headers.getSetCookie();
      if (setCookie.length > 0) response.setHeader("set-cookie", setCookie);
      response.setHeader("access-control-allow-origin", dashboardAllowedOrigin);
      response.setHeader("access-control-allow-credentials", "true");
      response.setHeader("content-length", String(responseBytes.byteLength));
      response.end(responseBytes);
    } catch {
      records.push({ method, path, status: 502, sessionCookieAuth, requestSource });
      response.statusCode = 502;
      response.end('{"error":"local rehearsal proxy failure"}');
    }
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => {
    server.removeListener("error", listening.reject);
    listening.resolve();
  });
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("local rehearsal proxy did not bind a loopback port");
  }
  let closed = false;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    records,
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections?.();
      const closing = Promise.withResolvers<void>();
      server.close((cause) => (cause === undefined ? closing.resolve() : closing.reject(cause)));
      await closing.promise;
    },
  };
};

const sanitizeProjection = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeProjection);
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (normalized === "email" || normalized === "phone") {
      result[`${key}Sha256`] = typeof child === "string" ? sha256Text(child) : null;
      continue;
    }
    if (
      normalized.includes("password") ||
      normalized.includes("secret") ||
      normalized.includes("cookie") ||
      normalized.includes("token") ||
      normalized.includes("ciphertext")
    ) {
      throw new Error(`forbidden sensitive projection field: ${key}`);
    }
    result[key] = sanitizeProjection(child);
  }
  return result;
};

const stableComparisonIsEqual = (
  comparison: ReturnType<typeof compareStableByteSets>,
  names: ReadonlyArray<keyof typeof comparison>,
): boolean =>
  names.every((name) => {
    const value = comparison[name];
    return value.byteLengthEqual && value.sha256Equal && value.directBytesEqual;
  });

const importResultEvidence = (result: OrganizationImportResult) => {
  const bytes = canonicalJsonBytes(result);
  return {
    byteLength: bytes.byteLength,
    sha256: sha256Hex(bytes),
    counts: {
      departments: result.departments.length,
      teams: result.teams.length,
      memberships: result.memberships.length,
      quarantine: result.quarantined.length,
      ledger: result.ledger.length,
    },
    outcomeMatrix: organizationImportOutcomeMatrix(result),
    provenance: organizationImportProvenanceEvidence(result),
  };
};

const decodeJsonResponse = async (
  response: Response,
): Promise<{ readonly status: number; readonly body: unknown }> => ({
  status: response.status,
  body: await response.json(),
});

const sanitizeFailure = (cause: unknown, sensitiveValues: ReadonlyArray<string>): string => {
  let message = cause instanceof Error ? cause.message : String(cause);
  for (const sensitive of sensitiveValues) {
    if (sensitive.length > 0) message = message.replaceAll(sensitive, "<redacted>");
  }
  message = message.replace(/postgres(?:ql)?:\/\/[^@\s/]+@/giu, "postgresql://<redacted>@");
  return message.slice(0, 2_000);
};
const readSanitizedFailedBrowserEvidence = async (
  path: string,
  sensitiveValues: ReadonlyArray<string>,
): Promise<OrganizationImportBrowserFailedEvidence | undefined> => {
  try {
    if (!(await pathExists(path))) return undefined;
    const serialized = await readFile(path, "utf8");
    const input: unknown = JSON.parse(serialized);
    const evidence = await Effect.runPromise(decodeOrganizationImportBrowserFailedEvidence(input));
    return {
      status: "Failed",
      failure: sanitizeFailure(evidence.failure, sensitiveValues),
      pageErrors: evidence.pageErrors.map((message) => sanitizeFailure(message, sensitiveValues)),
      consoleMessages: evidence.consoleMessages.map((message) => ({
        type: sanitizeFailure(message.type, sensitiveValues),
        text: sanitizeFailure(message.text, sensitiveValues),
      })),
      rejectedDestinations: evidence.rejectedDestinations.map((destination) =>
        sanitizeFailure(destination, sensitiveValues),
      ),
      unexpectedApiRequests: evidence.unexpectedApiRequests.map((request) => ({
        method: sanitizeFailure(request.method, sensitiveValues),
        path: sanitizeFailure(request.path, sensitiveValues),
      })),
      requests: evidence.requests.map((request) => ({
        method: sanitizeFailure(request.method, sensitiveValues),
        origin: request.origin,
        path: sanitizeFailure(request.path, sensitiveValues),
        resourceType: sanitizeFailure(request.resourceType, sensitiveValues),
      })),
      failedResponses: evidence.failedResponses.map((response) => ({
        origin: response.origin,
        path: sanitizeFailure(response.path, sensitiveValues),
        status: response.status,
      })),
      finalPageState: {
        path: sanitizeFailure(evidence.finalPageState.path, sensitiveValues),
        customElementDefined: evidence.finalPageState.customElementDefined,
        host: evidence.finalPageState.host,
        container: evidence.finalPageState.container,
        headings: evidence.finalPageState.headings.map((heading) =>
          sanitizeFailure(heading, sensitiveValues),
        ),
        alerts: evidence.finalPageState.alerts.map((alert) =>
          sanitizeFailure(alert, sensitiveValues),
        ),
      },
    };
  } catch {
    return undefined;
  }
};

const makeIdentityTestLayer = (
  sessionCookie: string,
  counters: { credentialAttempts: number; authMutationAttempts: number },
): Layer.Layer<Identity> => {
  const actor = new IdentityActor({
    personId: PersonId.make(SPEC_0067.administratorPersonId),
    sessionId: `session-${sha256Text(sessionCookie).slice(0, 16)}`,
    expiresAt: DateTime.makeUnsafe(new Date(SPEC_0067.sessionExpiresAt)),
  });
  const identity: IdentityShape = {
    signIn: () => {
      counters.credentialAttempts += 1;
      return Promise.reject(
        new IdentityEngineError({
          operation: "signIn",
          message: "credentials are outside the spec 0067 rehearsal",
        }),
      );
    },
    resolveSession: (cookieHeader) => {
      const accepted = (cookieHeader ?? "")
        .split(";")
        .some((pair) => pair.trim() === `${SPEC_0067.sessionCookieName}=${sessionCookie}`);
      return accepted
        ? Promise.resolve(actor)
        : Promise.reject(new IdentitySessionNotFound({ sessionToken: "not-recorded" }));
    },
    signOut: () => {
      counters.authMutationAttempts += 1;
      return Promise.reject(
        new IdentityEngineError({
          operation: "signOut",
          message: "auth mutation is outside the spec 0067 rehearsal",
        }),
      );
    },
  };
  return Layer.succeed(Identity, identity);
};

const makeRehearsalRuntime = (
  databaseUrl: string,
  observerState: ReturnType<typeof makeOrganizationImportSqlObserverState>,
  identityLayer: Layer.Layer<Identity>,
) => {
  const databaseLayer = DatabaseLive({
    url: Redacted.make(databaseUrl),
    applicationName: "spec-0067-organization-import-rehearsal",
    maxConnections: 6,
  });
  const observedDatabaseLayer = Layer.effect(
    Database,
    Effect.map(Database, (sql) => observeOrganizationImportSql(sql, observerState)),
  ).pipe(Layer.provide(databaseLayer));
  const admissionsLayer = AdmissionsLive.pipe(Layer.provide(observedDatabaseLayer));
  const economyLayer = EconomyLive.pipe(Layer.provide(observedDatabaseLayer));
  const organizationLayer = OrganizationLive.pipe(Layer.provide(observedDatabaseLayer));
  const profileLayer = ProfileLive.pipe(
    Layer.provide(Layer.merge(observedDatabaseLayer, organizationLayer)),
  );
  const schoolsLayer = SchoolsLive.pipe(Layer.provide(observedDatabaseLayer));
  const contentManagementLayer = ContentManagementLive.pipe(Layer.provide(observedDatabaseLayer));
  const contentLayer = ContentLive.pipe(
    Layer.provide(Layer.mergeAll(observedDatabaseLayer, organizationLayer, profileLayer)),
  );
  const recruitmentLayer = RecruitmentLive.pipe(
    Layer.provide(
      Layer.mergeAll(observedDatabaseLayer, admissionsLayer, organizationLayer, profileLayer),
    ),
  );
  return makeBackendRuntime(
    Layer.mergeAll(
      observedDatabaseLayer,
      admissionsLayer,
      economyLayer,
      organizationLayer,
      profileLayer,
      schoolsLayer,
      contentManagementLayer,
      contentLayer,
      recruitmentLayer,
      identityLayer,
    ),
  );
};

const seedPrerequisites = (sql: DatabaseShape): Effect.Effect<void, unknown> =>
  sql.withTransaction(
    Effect.gen(function* () {
      for (const person of SPEC_0067_PREREQUISITES.persons) {
        yield* sql`
          INSERT INTO public.person_profiles (
            person_id, first_name, last_name, revision
          ) VALUES (
            ${person.personId}, ${person.firstName}, ${person.lastName}, ${person.revision}
          )
        `;
        yield* sql`
          INSERT INTO public.person_contact_profiles (
            person_id, email, phone, revision
          ) VALUES (
            ${person.personId}, ${person.email}, ${person.phone}, ${person.revision}
          )
        `;
      }
      const grant = SPEC_0067_PREREQUISITES.administratorGrant;
      yield* sql`
        INSERT INTO public.organization_global_administrator_grants (
          grant_id, person_id, start_at, end_at, revision
        ) VALUES (
          ${grant.grantId}, ${grant.personId}, ${grant.startAt}::timestamptz,
          ${grant.endAt}::timestamptz, ${grant.revision}
        )
      `;
    }),
  );

const stableState = async (sql: DatabaseShape): Promise<OrganizationImportStableState> =>
  Effect.runPromise(readOrganizationImportStableState(sql));

const serviceImport = async (
  runtime: ReturnType<typeof makeRehearsalRuntime>,
  snapshot: LegacyOrganizationSnapshot,
): Promise<OrganizationImportResult> =>
  runtime.runPromise(
    Organization.use(({ importLegacyOrganization }) => importLegacyOrganization(snapshot)),
  );

export const writeSanitizedOrganizationImportRehearsalArtifact = async (input: {
  readonly artifactCore: Record<string, unknown>;
  readonly evidencePath: string;
  readonly sensitiveValues: ReadonlyArray<string>;
}): Promise<{ readonly evidenceSha256: string }> => {
  const evidenceSha256 = sha256Hex(canonicalJsonBytes(input.artifactCore));
  const artifact = { ...input.artifactCore, evidenceSha256 };
  let artifactValidated = false;
  await Effect.runPromise(verifyOrganizationImportRehearsalArtifact(artifact));
  artifactValidated = true;
  const serialized = `${canonicalJson(artifact)}\n`;
  for (const sensitive of input.sensitiveValues) {
    assert.equal(
      serialized.includes(sensitive),
      false,
      "sanitized evidence contained a secret value",
    );
  }
  assert.equal(/postgres(?:ql)?:\/\/[^@\s/]+@/iu.test(serialized), false);
  assert.equal(
    artifactValidated,
    true,
    "evidence persistence requires strict artifact and digest validation",
  );
  await mkdir(dirname(input.evidencePath), { recursive: true });
  await writeFile(input.evidencePath, serialized, { encoding: "utf8", flag: "wx" });
  return { evidenceSha256 };
};

const runRehearsal = async (
  administratorUrl: string,
  evidencePath: string,
): Promise<{ readonly evidencePath: string; readonly evidenceSha256: string }> => {
  const databaseName = `vektorprogrammet_spec_0067_${randomBytes(8).toString("hex")}`;
  const databaseNameSha256 = sha256Text(databaseName);
  let sessionCookie: string | undefined = randomBytes(48).toString("base64url");
  let backendSecret: string | undefined = randomBytes(48).toString("base64url");
  const sensitiveValues: string[] = [
    administratorUrl,
    sessionCookie,
    backendSecret,
    ...SPEC_0067_PREREQUISITES.persons.map(({ email }) => email),
    ...SPEC_0067_PREREQUISITES.persons.map(({ phone }) => phone),
  ];
  const guard = new LocalNetworkGuard();
  const observerState = makeOrganizationImportSqlObserverState();
  const identityCounters = { credentialAttempts: 0, authMutationAttempts: 0 };
  const processObservations: ProcessObservation[] = [];
  const processEffects: ProcessEffectObserver = { deploymentAttempts: 0 };
  const backendRequests: BackendRequestObservation[] = [];
  const cleanupErrors: string[] = [];
  const runnerTempRoot = join(
    tmpdir(),
    `vektorprogrammet-spec-0067-${randomBytes(8).toString("hex")}`,
  );
  const browserEvidencePath = join(runnerTempRoot, "browser-evidence.json");
  const generatedBackupRoot = join(runnerTempRoot, "generated-output-backups");
  const childToolEnvironment = makeChildToolEnvironment(runnerTempRoot);
  const generatedPaths = ORGANIZATION_IMPORT_GENERATED_OUTPUT_PATHS.map((relativePath) =>
    join(repositoryRoot, relativePath),
  );
  let generatedOutputSnapshots: GeneratedOutputSnapshot[] = [];
  const generatedOutputRestoration: Array<{
    readonly path: string;
    readonly preexisting: boolean;
    readonly beforeSha256: string | null;
    readonly afterSha256: string | null;
    readonly restored: boolean;
  }> = [];

  const artifactCore: Record<string, unknown> = {
    contract: {
      revision: SPEC_0067.contractRevision,
      frozenCodeBaseHead: SPEC_0067.frozenCodeBaseHead,
      implementationBaseHead: SPEC_0067.implementationBaseHead,
      runtimeHead: "NotObservedDueToFailure",
      frozenBaseMergeBase: "NotObservedDueToFailure",
      implementationBaseMergeBase: "NotObservedDueToFailure",
      actualBaseVerified: false,
    },
    source: {
      sourceRepository: SPEC_0067.sourceRepository,
      sourceRevision: SPEC_0067.sourceRevision,
      snapshotId: SPEC_0067.snapshotId,
      snapshotHash: SPEC_0067.snapshotHash,
      transformationRevision: SPEC_0067.transformationRevision,
      authorizationInstant: SPEC_0067.authorizationInstant,
      sessionCookieSha256: sha256Text(sessionCookie),
    },
    database: { status: "NotObservedDueToFailure" },
    inventory: { status: "NotObservedDueToFailure" },
    prerequisites: { status: "NotObservedDueToFailure" },
    classifier: { status: "NotObservedDueToFailure" },
    rollback: { status: "NotObservedDueToFailure" },
    commitAndReplay: { status: "NotObservedDueToFailure" },
    http: { status: "NotObservedDueToFailure" },
    personAuthority: { status: "NotObservedDueToFailure" },
    browser: { status: "NotObservedDueToFailure" },
    forbiddenEffects: { status: "NotObservedDueToFailure" },
    cleanup: { status: "NotObservedDueToFailure" },
    observations: { status: "Running" },
    evidenceClassification: {
      class: "local runtime observation over synthetic data",
      productionReadinessClaim: false,
      proofClaim: false,
      status: "Running",
      failedChecks: [],
    },
  };

  let administrator: Pool | undefined;
  let databaseCreated = false;
  let databaseUrl: string | undefined;
  let runtime: ReturnType<typeof makeRehearsalRuntime> | undefined;
  let backendServer: ReturnType<typeof Bun.serve> | undefined;
  let backendPort: number | undefined;
  let proxy: RehearsalProxy | undefined;
  let dashboardProcess: ChildProcess | undefined;
  let databaseDisposalCompleted = false;
  let cleanupFinalizationCompleted = false;
  let runFailure: unknown;
  let failureStage: string | undefined;
  let stage = "repository and local-output preflight";

  try {
    await mkdir(childToolEnvironment.HOME!, { recursive: true });
    await mkdir(childToolEnvironment.TMPDIR!, { recursive: true });
    await mkdir(childToolEnvironment.XDG_CACHE_HOME!, { recursive: true });
    for (const root of [sdkRoot, dashboardRoot]) {
      for (const name of [".env", ".env.local", ".env.development", ".env.development.local"]) {
        assert.equal(
          await pathExists(join(root, name)),
          false,
          `ambient child environment file is prohibited: ${relative(repositoryRoot, join(root, name))}`,
        );
      }
    }
    generatedOutputSnapshots = await captureGeneratedOutputs(generatedPaths, generatedBackupRoot);
    await clearCapturedGeneratedOutputs(generatedOutputSnapshots);
    const runtimeHead = await readGitValue(
      ["rev-parse", "HEAD"],
      childToolEnvironment,
      processObservations,
      processEffects,
    );
    const frozenBaseMergeBase = await readGitValue(
      ["merge-base", "HEAD", SPEC_0067.frozenCodeBaseHead],
      childToolEnvironment,
      processObservations,
      processEffects,
    );
    const implementationBaseMergeBase = await readGitValue(
      ["merge-base", "HEAD", SPEC_0067.implementationBaseHead],
      childToolEnvironment,
      processObservations,
      processEffects,
    );
    assert.match(runtimeHead, /^[a-f0-9]{40}$/u);
    assert.equal(frozenBaseMergeBase, SPEC_0067.frozenCodeBaseHead);
    assert.equal(implementationBaseMergeBase, SPEC_0067.implementationBaseHead);
    artifactCore.contract = {
      revision: SPEC_0067.contractRevision,
      frozenCodeBaseHead: SPEC_0067.frozenCodeBaseHead,
      implementationBaseHead: SPEC_0067.implementationBaseHead,
      runtimeHead,
      frozenBaseMergeBase,
      implementationBaseMergeBase,
      actualBaseVerified: true,
    };
    stage = "database creation";
    assert.equal(
      sha256Hex(canonicalJsonBytes(frozenOrganizationSnapshotCore)),
      SPEC_0067.snapshotHash,
    );
    const created = await createDisposableDatabase(administratorUrl, databaseName);
    administrator = created.administrator;
    databaseUrl = created.url;
    sensitiveValues.push(databaseUrl);
    guard.addPostgres(databaseUrl);
    databaseCreated = true;

    stage = "migration and runtime composition";
    runtime = makeRehearsalRuntime(
      databaseUrl,
      observerState,
      makeIdentityTestLayer(sessionCookie, identityCounters),
    );
    await runtime.runPromise(databaseHealth);
    const sql = await runtime.runPromise(Database);
    const migrationRows = await runtime.runPromise(
      sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM public.vektorprogrammet_schema_migrations
        ORDER BY migration_id ASC
      `,
    );
    const [postgresVersion] = await runtime.runPromise(
      sql<{ readonly version: string }>`SELECT version() AS version`,
    );
    assert.deepEqual(
      migrationRows.map((row) => `${row.migrationId}_${row.name}`),
      databaseMigrationDefinitions.map((migration) => migration.id),
    );
    assert.equal(migrationRows.length, 23);
    assert.equal(sql.schemaRevision, databaseSchemaRevision);

    const inventory = await runtime.runPromise(
      sql<{ readonly schemaName: string; readonly tableName: string }>`
        SELECT table_schema AS "schemaName", table_name AS "tableName"
        FROM information_schema.tables
        WHERE table_type = 'BASE TABLE' AND table_schema IN ('public', 'auth')
        ORDER BY table_schema ASC, table_name ASC
      `,
    );
    const qualifiedInventory = inventory.map(
      ({ schemaName, tableName }) => `${schemaName}.${tableName}`,
    );
    const authInventory = qualifiedInventory.filter((name) => name.startsWith("auth."));
    const publicInventory = qualifiedInventory.filter((name) => name.startsWith("public."));
    assert.deepEqual(authInventory, [...EXPECTED_MIGRATION_23_AUTH_TABLES]);
    assert.deepEqual(publicInventory, [...EXPECTED_MIGRATION_23_PUBLIC_TABLES]);
    assert.deepEqual(qualifiedInventory, [
      ...EXPECTED_MIGRATION_23_AUTH_TABLES,
      ...EXPECTED_MIGRATION_23_PUBLIC_TABLES,
    ]);
    const misplacedAuthTables = publicInventory.filter((name) =>
      /^public\.(?:account|session|user|verification)$/u.test(name),
    );
    assert.deepEqual(misplacedAuthTables, []);
    const misplacedNativeTables = authInventory.filter((name) =>
      /organization|authz_|person_profiles|person_contact_profiles/u.test(name),
    );
    assert.deepEqual(misplacedNativeTables, []);
    artifactCore.database = {
      status: "Observed",
      postgresqlVersion: postgresVersion?.version ?? "unobserved",
      databaseNameSha256,
      migrationCount: migrationRows.length,
      databaseSchemaRevision: sql.schemaRevision,
      migration23: migrationRows.at(-1),
    };
    artifactCore.inventory = {
      status: "Observed",
      qualifiedTables: qualifiedInventory,
      authCatalogTables: authInventory,
      misplacedNativeTables,
      expectedPublicTables: [...EXPECTED_MIGRATION_23_PUBLIC_TABLES],
      observedPublicTables: publicInventory,
      misplacedAuthTables,
    };

    stage = "prerequisite insertion and empty-state preflight";
    await runtime.runPromise(seedPrerequisites(sql));
    const baseline = await stableState(sql);
    assert.deepEqual(baseline.importedTableCounts, {
      departments: 0,
      teams: 0,
      memberships: 0,
      quarantine: 0,
      ledger: 0,
    });
    assert.ok(baseline.byteSets.rule.tables.every((item) => item.rowCount === 0));
    assert.ok(baseline.byteSets.receipt.tables.every((item) => item.rowCount === 0));
    assert.ok(baseline.byteSets.outbox.tables.every((item) => item.rowCount === 0));
    const authDataCounts = await runtime.runPromise(
      sql<{ readonly rowCount: number }>`
        SELECT count(*)::integer AS "rowCount" FROM (
          SELECT id FROM auth."user"
          UNION ALL SELECT id FROM auth."session"
          UNION ALL SELECT id FROM auth."account"
          UNION ALL SELECT id FROM auth."verification"
        ) AS auth_rows
      `,
    );
    assert.equal(authDataCounts[0]?.rowCount, 0);
    assert.deepEqual(
      baseline.byteSets.prerequisite.tables.map(({ rowCount }) => rowCount),
      [2, 2, 1],
    );
    artifactCore.prerequisites = {
      status: "Observed",
      persons: SPEC_0067_PREREQUISITES.persons.map((person) => ({
        personId: person.personId,
        firstName: person.firstName,
        lastName: person.lastName,
        emailSha256: sha256Text(person.email),
        phoneSha256: sha256Text(person.phone),
        revision: person.revision,
      })),
      administratorGrant: SPEC_0067_PREREQUISITES.administratorGrant,
      baseline: {
        counts: baseline.importedTableCounts,
        byteSets: stableByteSetEvidence(baseline),
      },
      authDataRowCount: authDataCounts[0]?.rowCount ?? -1,
    };

    stage = "strict frozen decode and existing classifier";
    const snapshot = await Effect.runPromise(
      decodeFrozenOrganizationSnapshot(frozenOrganizationSnapshotInput),
    );
    const serviceSnapshotReferences: LegacyOrganizationSnapshot[] = [];
    const classified = await Effect.runPromise(importLegacyOrganizationEffect(snapshot));
    assert.deepEqual(
      organizationImportOutcomeMatrix(classified),
      expectedOrganizationImportOutcomeMatrix,
    );
    assert.deepEqual(importResultEvidence(classified).counts, {
      departments: 1,
      teams: 1,
      memberships: 1,
      quarantine: 5,
      ledger: 8,
    });
    artifactCore.classifier = {
      status: "Observed",
      strictRuntimeDecoded: true,
      snapshotObjectFrozen: Object.isFrozen(snapshot),
      ...importResultEvidence(classified),
    };

    stage = "forced transaction rollback";
    await runtime.runPromise(installOrganizationImportFailureTrigger(sql));
    const triggerCatalog = await runtime.runPromise(
      sql<{ readonly triggerCount: number; readonly functionCount: number }>`
        SELECT
          (SELECT count(*)::integer FROM pg_catalog.pg_trigger AS trigger_record
            INNER JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_record.tgrelid
            INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public'
              AND relation.relname = 'organization_import_ledger'
              AND trigger_record.tgname = 'spec_0067_fail_organization_ledger'
              AND NOT trigger_record.tgisinternal) AS "triggerCount",
          (SELECT count(*)::integer FROM pg_catalog.pg_proc AS procedure
            INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
            WHERE namespace.nspname = 'public'
              AND procedure.proname = 'spec_0067_fail_organization_ledger') AS "functionCount"
      `,
    );
    assert.deepEqual(triggerCatalog, [{ triggerCount: 1, functionCount: 1 }]);
    observerState.captureImportTrace = true;
    observerState.importTrace.length = 0;
    serviceSnapshotReferences.push(snapshot);
    const failedImport = await runtime.runPromise(
      Effect.result(
        Organization.use(({ importLegacyOrganization }) => importLegacyOrganization(snapshot)),
      ),
    );
    observerState.captureImportTrace = false;
    assert.ok(Result.isFailure(failedImport));
    assert.equal(failedImport.failure._tag, "OrganizationPersistenceError");
    assert.equal(failedImport.failure.operation, "persist organization import");
    const traceSummary = observerState.importTrace.reduce<Record<string, number>>(
      (counts, item) => ({ ...counts, [item.phase]: (counts[item.phase] ?? 0) + 1 }),
      {},
    );
    assert.deepEqual(traceSummary, {
      DepartmentInsert: 1,
      TeamInsert: 1,
      MembershipInsert: 1,
      QuarantineInsert: 5,
      LedgerInsert: 1,
      LedgerSqlError: 1,
    });
    const finalTrace = observerState.importTrace.at(-1);
    assert.deepEqual(finalTrace, {
      phase: "LedgerSqlError",
      sqlState: SPEC_0067.failureSqlState,
      message: SPEC_0067.failureMessage,
    });
    const afterFailure = await stableState(sql);
    const rollbackEquality = compareStableByteSets(baseline, afterFailure);
    assert.deepEqual(afterFailure.importedTableCounts, baseline.importedTableCounts);
    assert.ok(stableComparisonIsEqual(rollbackEquality, ["canonical", "provenance"]));
    assert.ok(
      stableComparisonIsEqual(rollbackEquality, [
        "prerequisite",
        "rule",
        "auth",
        "receipt",
        "outbox",
      ]),
    );
    assert.deepEqual(
      observerState.delegatedSqlErrors.map(({ sqlState, message }) => ({ sqlState, message })),
      [{ sqlState: SPEC_0067.failureSqlState, message: SPEC_0067.failureMessage }],
    );
    artifactCore.rollback = {
      status: "Observed",
      serviceFailure: {
        tag: failedImport.failure._tag,
        operation: failedImport.failure.operation,
      },
      sqlState: SPEC_0067.failureSqlState,
      triggerMessage: SPEC_0067.failureMessage,
      writeAttemptTrace: observerState.importTrace,
      delegatedSqlErrors: observerState.delegatedSqlErrors,
      triggerCatalog: triggerCatalog[0],
      before: {
        counts: baseline.importedTableCounts,
        byteSets: stableByteSetEvidence(baseline),
      },
      after: {
        counts: afterFailure.importedTableCounts,
        byteSets: stableByteSetEvidence(afterFailure),
      },
      equality: rollbackEquality,
    };
    observerState.delegatedSqlErrors.length = 0;

    stage = "failure object removal and successful commit";
    await runtime.runPromise(removeOrganizationImportFailureTrigger(sql));
    const residualFailureObjects = await runtime.runPromise(
      sql<{ readonly triggerCount: number; readonly functionCount: number }>`
        SELECT
          (SELECT count(*)::integer FROM pg_catalog.pg_trigger AS trigger_record
            WHERE trigger_record.tgname = 'spec_0067_fail_organization_ledger'
              AND NOT trigger_record.tgisinternal) AS "triggerCount",
          (SELECT count(*)::integer FROM pg_catalog.pg_proc AS procedure
            INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
            WHERE namespace.nspname = 'public'
              AND procedure.proname = 'spec_0067_fail_organization_ledger') AS "functionCount"
      `,
    );
    assert.deepEqual(residualFailureObjects, [{ triggerCount: 0, functionCount: 0 }]);
    serviceSnapshotReferences.push(snapshot);
    const committedResult = await serviceImport(runtime, snapshot);
    assert.deepEqual(
      organizationImportOutcomeMatrix(committedResult),
      expectedOrganizationImportOutcomeMatrix,
    );
    const committedState = await stableState(sql);
    assert.deepEqual(committedState.importedTableCounts, {
      departments: 1,
      teams: 1,
      memberships: 1,
      quarantine: 5,
      ledger: 8,
    });
    const persistedMemberships = await runtime.runPromise(
      sql<Record<string, unknown>>`
        SELECT
          membership_id AS "membershipId",
          person_id AS "personId",
          team_id AS "teamId",
          deleted_team_name AS "deletedTeamName",
          to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
          CASE WHEN end_at IS NULL THEN NULL
            ELSE to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          END AS "endAt",
          position_id AS "positionId",
          is_team_leader AS "isTeamLeader",
          is_suspended AS "isSuspended",
          revision
        FROM public.organization_memberships
        ORDER BY membership_id ASC
      `,
    );
    assert.deepEqual(persistedMemberships, [
      {
        membershipId: "6721",
        personId: "6731",
        teamId: "6711",
        deletedTeamName: null,
        startAt: "2037-01-01T00:00:00.000Z",
        endAt: null,
        positionId: "6741",
        isTeamLeader: true,
        isSuspended: false,
        revision: 0,
      },
    ]);
    const commitAgainstBaseline = compareStableByteSets(baseline, committedState);
    assert.ok(
      stableComparisonIsEqual(commitAgainstBaseline, [
        "prerequisite",
        "rule",
        "auth",
        "receipt",
        "outbox",
      ]),
    );

    stage = "backend and strict native projections";
    const configEnvironment: NodeJS.ProcessEnv = {
      BACKEND_HOST: "127.0.0.1",
      BACKEND_PORT: "3000",
      BACKEND_PG_URL: databaseUrl,
      BETTER_AUTH_SECRET: backendSecret,
      BETTER_AUTH_URL: dashboardOrigin,
      PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
      ADMISSION_AUTH_TOKENS: "{}",
      ORGANIZATION_AUTH_TOKENS: "{}",
      RECEIPT_AUTH_TOKENS: "{}",
    };
    const config = makeBackendConfig(configEnvironment);
    const run = runtime.runPromise.bind(runtime) as BackendRun;
    const api = makeBackendHttp(
      config,
      run,
      {
        handle: () => {
          identityCounters.authMutationAttempts += 1;
          return Promise.resolve(new Response(null, { status: 404 }));
        },
      },
      { now: () => SPEC_0067.authorizationInstant },
    );
    backendServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch });
    backendPort = backendServer.port;
    const backendOrigin = `http://127.0.0.1:${backendPort}`;
    guard.addHttp(backendOrigin, "backend-loopback");
    proxy = await startRecordingProxy(
      backendOrigin,
      dashboardOrigin,
      guard,
      SPEC_0067.sessionCookieName,
    );
    guard.addHttp(proxy.origin, "api-proxy-loopback");
    guard.addHttp(dashboardOrigin, "dashboard-loopback");
    const cookieHeader = `${SPEC_0067.sessionCookieName}=${sessionCookie}`;
    const fetchObservation = async (
      path: string,
      authenticated: boolean,
    ): Promise<{ readonly status: number; readonly body: unknown }> => {
      const response = await guard.fetchLoopback(`${backendOrigin}${path}`, {
        headers: authenticated ? { cookie: cookieHeader } : undefined,
      });
      const decoded = await decodeJsonResponse(response);
      backendRequests.push({
        method: "GET",
        path,
        status: decoded.status,
        sessionCookieAuth: authenticated,
      });
      return decoded;
    };
    const departmentsHttp = await fetchObservation("/api/departments", false);
    const teamsHttp = await fetchObservation("/api/teams", false);
    const sessionHttp = await fetchObservation("/api/me/session", true);
    const missingSessionHttp = await fetchObservation("/api/me/session", false);
    const adminUsersHttp = await fetchObservation("/api/admin/users", true);
    assert.equal(departmentsHttp.status, 200, "GET /api/departments did not return 200");
    assert.equal(teamsHttp.status, 200, "GET /api/teams did not return 200");
    assert.equal(sessionHttp.status, 200, "authenticated GET /api/me/session did not return 200");
    assert.equal(
      missingSessionHttp.status,
      401,
      "unauthenticated GET /api/me/session did not return 401",
    );
    assert.equal(adminUsersHttp.status, 200, "GET /api/admin/users did not return 200");
    assert.deepEqual(sessionHttp.body, {
      personId: SPEC_0067.administratorPersonId,
      expiresAt: SPEC_0067.sessionExpiresAt,
    });
    assert.deepEqual(missingSessionHttp.body, { error: { tag: "UnauthenticatedActor" } });

    const processEnvironment: NodeJS.ProcessEnv = {
      ...childToolEnvironment,
      API_URL: proxy.origin,
      VITE_API_URL: proxy.origin,
      DASHBOARD_ORIGIN: dashboardOrigin,
      BETTER_AUTH_SECRET: backendSecret,
      BETTER_AUTH_URL: dashboardOrigin,
    };
    delete processEnvironment.API_MODE;
    delete processEnvironment.VITE_API_MODE;
    delete processEnvironment.ALCHEMY_CLOUDFLARE_VITE_INJECTED;
    await runCommand("bun", ["run", "build"], {
      cwd: sdkRoot,
      env: processEnvironment,
      label: "spec 0067 SDK build",
      observations: processObservations,
      processEffects,
    });
    const sdk = (await import(
      new URL("../../sdk/dist/effect-client.js", import.meta.url).href
    )) as {
      readonly createEffectClient: (
        baseUrl: string,
        options: { readonly cookie: string; readonly fetch: typeof guard.fetchLoopback },
      ) => {
        readonly public: {
          readonly organization: {
            readonly listDepartments: () => Effect.Effect<
              ReadonlyArray<Record<string, unknown>>,
              unknown
            >;
            readonly listTeams: () => Effect.Effect<
              ReadonlyArray<Record<string, unknown>>,
              unknown
            >;
          };
        };
        readonly admin: {
          readonly users: {
            readonly list: () => Effect.Effect<Record<string, unknown>, unknown>;
          };
        };
      };
    };
    const client = sdk.createEffectClient(proxy.origin, {
      cookie: cookieHeader,
      fetch: guard.fetchLoopback,
    });
    const departmentsSdk = await Effect.runPromise(client.public.organization.listDepartments());
    const teamsSdk = await Effect.runPromise(client.public.organization.listTeams());
    const adminUsersSdk = await Effect.runPromise(client.admin.users.list());
    assert.deepEqual(departmentsSdk, departmentsHttp.body);
    assert.deepEqual(teamsSdk, teamsHttp.body);
    const adminHttpBody = adminUsersHttp.body as {
      readonly activeUsers: ReadonlyArray<Record<string, unknown>>;
      readonly inactiveUsers: ReadonlyArray<Record<string, unknown>>;
      readonly nextCursor: string | null;
    };
    assert.equal(adminHttpBody.nextCursor, null);
    assert.deepEqual(adminUsersSdk, {
      activeUsers: adminHttpBody.activeUsers,
      inactiveUsers: adminHttpBody.inactiveUsers,
    });
    assert.deepEqual(
      departmentsSdk.map(({ departmentId, name }) => ({ departmentId, name })),
      [{ departmentId: "6701", name: "Spec 0067 Department" }],
    );
    assert.deepEqual(
      teamsSdk.map(({ teamId, departmentId, name }) => ({ teamId, departmentId, name })),
      [{ teamId: "6711", departmentId: "6701", name: "Spec 0067 Team" }],
    );
    const adminBody = adminUsersSdk as {
      readonly activeUsers: ReadonlyArray<Record<string, unknown>>;
      readonly inactiveUsers: ReadonlyArray<Record<string, unknown>>;
    };
    assert.deepEqual(
      adminBody.activeUsers.map(({ personId, departments, isActive }) => ({
        personId,
        departments,
        isActive,
      })),
      [{ personId: "6731", departments: ["Spec 0067 Department"], isActive: true }],
    );
    assert.deepEqual(
      adminBody.inactiveUsers.map(({ personId, departments, isActive }) => ({
        personId,
        departments,
        isActive,
      })),
      [
        {
          personId: SPEC_0067.administratorPersonId,
          departments: [],
          isActive: false,
        },
      ],
    );
    artifactCore.http = {
      status: "Observed",
      backendRequests,
      strictNative: {
        departments: sanitizeProjection(departmentsSdk),
        teams: sanitizeProjection(teamsSdk),
        session: sanitizeProjection(sessionHttp.body),
        missingSession: sanitizeProjection(missingSessionHttp.body),
        administratorDirectory: sanitizeProjection(adminUsersSdk),
      },
      sdkDecoded: true,
      fixtureMode: false,
    };

    const memberAuthority = await runtime.runPromise(
      Organization.use(({ resolvePersonAuthorityForRead }) =>
        resolvePersonAuthorityForRead(
          PersonId.make(SPEC_0067.importedMemberPersonId),
          SPEC_0067.authorizationInstant,
        ),
      ),
    );
    assert.equal(memberAuthority.evaluatedAt, SPEC_0067.authorizationInstant);
    assert.deepEqual(
      memberAuthority.memberships.map(
        ({ membershipId, teamId, departmentId, active, teamLeader }) => ({
          membershipId,
          teamId,
          departmentId,
          active,
          teamLeader,
        }),
      ),
      [
        {
          membershipId: "6721",
          teamId: "6711",
          departmentId: "6701",
          active: true,
          teamLeader: true,
        },
      ],
    );
    artifactCore.personAuthority = {
      status: "Observed",
      projection: memberAuthority,
      fixedEvaluatedAt: memberAuthority.evaluatedAt,
      authzRuleRows: baseline.byteSets.rule.tables,
      personSpecificRuleLockAttempts: observerState.personAuthorizationLockAttempts,
    };

    stage = "same-snapshot replay";
    serviceSnapshotReferences.push(snapshot);
    const replayResult = await serviceImport(runtime, snapshot);
    const replayState = await stableState(sql);
    const replayEquality = compareStableByteSets(committedState, replayState);
    const replayResultBytes = canonicalJsonBytes(replayResult);
    const committedResultBytes = canonicalJsonBytes(committedResult);
    assert.ok(Buffer.from(replayResultBytes).equals(Buffer.from(committedResultBytes)));
    assert.deepEqual(
      organizationImportOutcomeMatrix(replayResult),
      expectedOrganizationImportOutcomeMatrix,
    );
    assert.deepEqual(replayState.importedTableCounts, committedState.importedTableCounts);
    assert.ok(
      stableComparisonIsEqual(replayEquality, [
        "canonical",
        "provenance",
        "prerequisite",
        "rule",
        "auth",
        "receipt",
        "outbox",
      ]),
    );
    const distinctServiceSnapshotObjects = new Set(serviceSnapshotReferences);
    assert.equal(serviceSnapshotReferences.length, 3);
    assert.equal(distinctServiceSnapshotObjects.size, 1);
    assert.ok(serviceSnapshotReferences.every((reference) => reference === snapshot));
    artifactCore.commitAndReplay = {
      status: "Observed",
      serviceImportInvocationCount: serviceSnapshotReferences.length,
      distinctServiceSnapshotObjectCount: distinctServiceSnapshotObjects.size,
      allServiceInvocationsUsedDecodedSnapshot: serviceSnapshotReferences.every(
        (reference) => reference === snapshot,
      ),
      committedResult: importResultEvidence(committedResult),
      replayResult: importResultEvidence(replayResult),
      resultDirectBytesEqual: Buffer.from(replayResultBytes).equals(
        Buffer.from(committedResultBytes),
      ),
      committed: {
        counts: committedState.importedTableCounts,
        byteSets: stableByteSetEvidence(committedState),
      },
      replayed: {
        counts: replayState.importedTableCounts,
        byteSets: stableByteSetEvidence(replayState),
      },
      equality: replayEquality,
      residualFailureObjects: residualFailureObjects[0],
      persistedMemberships,
    };

    stage = "dashboard environment preflight";
    const boundedCookieConfigurationFailure = boundedCookieCapabilityFailure({
      cookieName: SPEC_0067.sessionCookieName,
      cookieValue: sessionCookie ?? "",
      dashboardOrigin,
      apiOrigin: proxy.origin,
      authorizationInstant: SPEC_0067.authorizationInstant,
      expiresAt: SPEC_0067.sessionExpiresAt,
    });
    if (boundedCookieConfigurationFailure !== undefined) {
      throw new Error(
        `bounded-cookie configuration preflight failed: ${boundedCookieConfigurationFailure}`,
      );
    }
    await assertPortAvailable(dashboardPort);
    const browserEnvironment: NodeJS.ProcessEnv = {
      ...processEnvironment,
      ORGANIZATION_IMPORT_REHEARSAL: "1",
      ORGANIZATION_IMPORT_REHEARSAL_DASHBOARD_ORIGIN: dashboardOrigin,
      ORGANIZATION_IMPORT_REHEARSAL_API_ORIGIN: proxy.origin,
      ORGANIZATION_IMPORT_REHEARSAL_SESSION_TOKEN: sessionCookie,
      ORGANIZATION_IMPORT_REHEARSAL_BROWSER_EVIDENCE_PATH: browserEvidencePath,
      ORGANIZATION_IMPORT_REHEARSAL_PLAYWRIGHT_OUTPUT_DIR: join(
        runnerTempRoot,
        "playwright-results",
      ),
      ORGANIZATION_IMPORT_REHEARSAL_AUTHORIZATION_INSTANT: SPEC_0067.authorizationInstant,
      ORGANIZATION_IMPORT_REHEARSAL_SDK_EFFECT_PATH: join(sdkRoot, "dist/effect-client.js"),
      ORGANIZATION_IMPORT_REHEARSAL_NATIVE_API_PATHS: JSON.stringify(NATIVE_BROWSER_JOURNEY_PATHS),
    };
    stage = "dashboard production build";
    await runCommand("bun", ORGANIZATION_IMPORT_DASHBOARD_BUILD_ARGUMENTS, {
      cwd: dashboardRoot,
      env: browserEnvironment,
      label: "spec 0067 dashboard production build",
      observations: processObservations,
      processEffects,
    });
    stage = "dashboard production server readiness";
    dashboardProcess = await startDashboard(
      browserEnvironment,
      processObservations,
      processEffects,
    );
    await waitForHttp(`${dashboardOrigin}/login`, guard, dashboardProcess);

    stage = "bounded existing page/session capability preflight";
    const pageSessionProxyStart = proxy.records.length;
    const pageSessionPreflight = await observeExistingPageSessionCapability(
      dashboardOrigin,
      SPEC_0067.sessionCookieName,
      sessionCookie ?? "",
      guard,
    );
    const pageSessionProxyRequests = proxy.records.slice(pageSessionProxyStart);
    const pageSessionCapability = classifyExistingPageSessionCapability(pageSessionPreflight);
    if (pageSessionCapability._tag === "EnvironmentFailure") {
      throw new Error(pageSessionCapability.reason);
    }

    let browserEvidence: {
      readonly status: string;
      readonly pageErrors: ReadonlyArray<string>;
      readonly legacyOrganizationRequests: number;
      readonly rejectedDestinations: ReadonlyArray<string>;
      readonly unexpectedApiRequests: ReadonlyArray<{
        readonly method: string;
        readonly path: string;
      }>;
      readonly failedResponses: ReadonlyArray<unknown>;
      readonly viteDependencyRequests: number;
      readonly dependencyOptimizerFailures: number;
    } = {
      status: "NotRun",
      pageErrors: [],
      legacyOrganizationRequests: 0,
      rejectedDestinations: [],
      unexpectedApiRequests: [],
      failedResponses: [],
      viteDependencyRequests: 0,
      dependencyOptimizerFailures: 0,
    };
    if (pageSessionCapability._tag === "BrowserNotPractical") {
      artifactCore.browser = {
        status: "BrowserNotPractical",
        capability: pageSessionCapability.capability,
        reason: pageSessionCapability.reason,
        pageSessionPreflight,
        backendProxyRequests: pageSessionProxyRequests,
        dashboardRuntime: ORGANIZATION_IMPORT_DASHBOARD_RUNTIME,
      };
    } else {
      stage = "practical Chromium path";
      const browserProxyStart = proxy.records.length;
      await runCommand(
        process.env.PLAYWRIGHT_NODE_EXECUTABLE ?? "node",
        ORGANIZATION_IMPORT_PLAYWRIGHT_ARGUMENTS,
        {
          cwd: dashboardRoot,
          env: browserEnvironment,
          label: "spec 0067 Chromium journey",
          observations: processObservations,
          processEffects,
        },
      );
      const browserEvidenceInput: unknown = JSON.parse(await readFile(browserEvidencePath, "utf8"));
      browserEvidence = await Effect.runPromise(
        decodeOrganizationImportBrowserObservedEvidence(browserEvidenceInput),
      );
      assert.equal(browserEvidence.status, "Observed");
      assert.deepEqual(browserEvidence.pageErrors, []);
      assert.equal(browserEvidence.legacyOrganizationRequests, 0);
      assert.deepEqual(browserEvidence.unexpectedApiRequests, []);
      assert.deepEqual(browserEvidence.failedResponses, []);
      assert.equal(browserEvidence.viteDependencyRequests, 0);
      assert.equal(browserEvidence.dependencyOptimizerFailures, 0);
      const browserProxyRequests = proxy.records.slice(browserProxyStart);
      const nativePathObservations = NATIVE_BROWSER_JOURNEY_REQUIREMENTS.map((requirement) => {
        const observation = browserProxyRequests.find(
          (candidate) =>
            candidate.path === requirement.path &&
            isExpectedNativeBrowserJourneyObservation(candidate),
        );
        assert.ok(
          observation,
          `Chromium journey did not observe the required ${requirement.access} 200 GET ${requirement.path}`,
        );
        return {
          path: observation.path,
          status: observation.status,
          sessionCookieAuth: observation.sessionCookieAuth,
          access: requirement.access,
          requestSource: observation.requestSource,
        };
      });
      artifactCore.browser = {
        status: "Observed",
        practicality: "Existing pages accepted the bounded session without credential changes",
        pageSessionPreflight,
        dashboardRuntime: ORGANIZATION_IMPORT_DASHBOARD_RUNTIME,
        preflightBackendProxyRequests: pageSessionProxyRequests,
        evidence: sanitizeProjection(browserEvidence),
        nativePathObservations,
        backendProxyRequests: browserProxyRequests,
      };
    }

    const rejectedDestinations = [
      ...guard.rejectedDestinations,
      ...browserEvidence.rejectedDestinations,
    ];
    const unexpectedProxyRequests = proxy.records.filter(
      ({ method, path }) => !isNativeBrowserJourneyRequestAllowed(method, path),
    );
    const forbiddenEffects = {
      ruleWriteAttempts: observerState.ruleDmlAttempts,
      authWriteAttempts: observerState.authDmlAttempts,
      receiptWriteAttempts: observerState.receiptDmlAttempts,
      outboxWriteAttempts: observerState.outboxDmlAttempts,
      outboxClaimAttempts: observerState.outboxClaimAttempts,
      credentialAttempts: identityCounters.credentialAttempts,
      identityMutationAttempts: identityCounters.authMutationAttempts,
      providerRequests: guard.providerRequests + browserEvidence.rejectedDestinations.length,
      legacyOrganizationRequests:
        browserEvidence.legacyOrganizationRequests +
        proxy.records.filter(({ path }) => /legacy|php|graphql/iu.test(path)).length,
      unexpectedApiRequestAttempts:
        unexpectedProxyRequests.length + browserEvidence.unexpectedApiRequests.length,
      productionResourceAttempts:
        guard.productionResourceAttempts + browserEvidence.rejectedDestinations.length,
      deploymentAttempts: processEffects.deploymentAttempts,
      remoteEffectAttempts:
        guard.remoteEffectAttempts + browserEvidence.rejectedDestinations.length,
      allowedDestinations: [...guard.allowedDestinations].sort(),
      rejectedDestinations,
    };
    artifactCore.forbiddenEffects = { status: "Observed", ...forbiddenEffects };
    assert.ok(
      Object.entries(forbiddenEffects)
        .filter(([, value]) => typeof value === "number")
        .every(([, value]) => value === 0),
    );
    assert.deepEqual(rejectedDestinations, []);
    artifactCore.observations = {
      status: "Observed",
      transitionSequence: [
        "S0 Empty",
        "S1 Ready",
        "S2 Classified",
        "S3 RolledBack",
        "S4 RetryReady",
        "S5 Committed",
        "S6 Observed",
        "S7 Replayed",
      ],
      provenanceAuthorities: {
        snapshot: "synthetic immutable input",
        organizationTables: "canonical native state",
        importLedger: "canonical provenance",
        identityLayer: "bounded in-memory session mapping only",
        browser: "projection observation",
      },
    };
  } catch (cause) {
    runFailure = cause;
    failureStage = stage;
    const failedBrowserEvidence = await readSanitizedFailedBrowserEvidence(
      browserEvidencePath,
      sensitiveValues,
    );
    if (failedBrowserEvidence !== undefined) {
      artifactCore.browser = {
        status: "Failed",
        evidence: failedBrowserEvidence,
        dashboardRuntime: ORGANIZATION_IMPORT_DASHBOARD_RUNTIME,
      };
    }
    artifactCore.observations = {
      status: "Failed",
      failedStage: stage,
      message: sanitizeFailure(cause, sensitiveValues),
    };
  } finally {
    stage = "resource cleanup";
    try {
      processObservations.push(
        await stopProcessTree(dashboardProcess, "dashboard production server"),
      );
    } catch (cause) {
      cleanupErrors.push(`dashboard production server: ${sanitizeFailure(cause, sensitiveValues)}`);
    }
    if (backendServer !== undefined) {
      try {
        await backendServer.stop(true);
      } catch (cause) {
        const message = sanitizeFailure(cause, sensitiveValues);
        if (message !== "Server is not running.") cleanupErrors.push(`backend: ${message}`);
      }
    }
    const proxyPort = proxy?.port;
    if (proxy !== undefined) {
      try {
        await proxy.close();
      } catch (cause) {
        const message = sanitizeFailure(cause, sensitiveValues);
        if (message !== "Server is not running.") cleanupErrors.push(`proxy: ${message}`);
      }
    }
    if (runtime !== undefined) {
      try {
        await runtime.dispose();
      } catch (cause) {
        cleanupErrors.push(`runtime: ${sanitizeFailure(cause, sensitiveValues)}`);
      }
    }
    let disposal = { databaseAbsent: !databaseCreated, residualConnections: 0 };
    if (administrator !== undefined) {
      if (databaseCreated) {
        try {
          disposal = await dropDisposableDatabase(administrator, databaseName);
        } catch (cause) {
          cleanupErrors.push(sanitizeFailure(cause, sensitiveValues));
          disposal = { databaseAbsent: false, residualConnections: -1 };
        }
      }
      try {
        await administrator.end();
      } catch (cause) {
        cleanupErrors.push(sanitizeFailure(cause, sensitiveValues));
      }
    }
    databaseDisposalCompleted = disposal.databaseAbsent && disposal.residualConnections === 0;
    for (const snapshot of generatedOutputSnapshots) {
      try {
        const restoration = await restoreGeneratedOutput(snapshot);
        generatedOutputRestoration.push(restoration);
        if (!restoration.restored) cleanupErrors.push("a pre-existing generated output changed");
      } catch (cause) {
        cleanupErrors.push(
          `generated output ${snapshot.relativePath}: ${sanitizeFailure(cause, sensitiveValues)}`,
        );
      }
    }
    try {
      await rm(runnerTempRoot, { recursive: true, force: true });
    } catch (cause) {
      cleanupErrors.push(sanitizeFailure(cause, sensitiveValues));
    }
    const portRelease = {
      backend: backendPort === undefined ? true : await isPortReleased(backendPort),
      proxy: proxyPort === undefined ? true : await isPortReleased(proxyPort),
      dashboard: await isPortReleased(dashboardPort),
    };
    if (!Object.values(portRelease).every(Boolean))
      cleanupErrors.push("a runner-owned port remained open");
    if (!disposal.databaseAbsent || disposal.residualConnections !== 0) {
      cleanupErrors.push("the runner-owned database or a database connection remained present");
    }
    const residualGeneratedPaths = generatedOutputRestoration
      .filter(({ restored }) => !restored)
      .map(({ path }) => path.replace(repositoryRoot, "<repository>"));
    if (residualGeneratedPaths.length > 0) cleanupErrors.push("runner-generated files remained");
    sessionCookie = undefined;
    backendSecret = undefined;
    databaseUrl = undefined;
    artifactCore.cleanup = {
      status: cleanupErrors.length === 0 ? "Observed" : "Failed",
      processExitStatuses: processObservations,
      portRelease,
      databaseDisposal: disposal,
      failureObjectsRemovedBeforeCommit:
        (artifactCore.commitAndReplay as { readonly residualFailureObjects?: unknown })
          .residualFailureObjects ?? "NotObservedDueToFailure",
      cookieCleared: sessionCookie === undefined,
      processSecretCleared: backendSecret === undefined,
      databaseUrlCleared: databaseUrl === undefined,
      unsanitizedBrowserArtifactRemoved: !(await pathExists(browserEvidencePath)),
      residualGeneratedPaths,
      generatedOutputRestoration: generatedOutputRestoration.map(({ path, ...observation }) => ({
        path: path.replace(repositoryRoot, "<repository>"),
        ...observation,
      })),
      runnerTempRootRemoved: !(await pathExists(runnerTempRoot)),
      lifecycle: {
        databaseDisposalCompleted,
        cleanupFinalizationCompleted: true,
        artifactValidationRequiresCleanupFinalization: true,
        evidenceWriteRequiresArtifactValidation: true,
      },
      errors: cleanupErrors,
    };
    cleanupFinalizationCompleted = true;
  }
  assert.equal(
    cleanupFinalizationCompleted,
    true,
    "artifact finalization requires a completed cleanup finalizer, including failed cleanup evidence",
  );

  const finalFailure =
    runFailure ??
    (cleanupErrors.length > 0
      ? new Error(`cleanup failed: ${cleanupErrors.join("; ")}`)
      : undefined);
  artifactCore.evidenceClassification = {
    class: "local runtime observation over synthetic data",
    productionReadinessClaim: false,
    proofClaim: false,
    status: finalFailure === undefined ? "Accepted" : "Failed",
    failedChecks:
      finalFailure === undefined
        ? []
        : [
            {
              stage: failureStage ?? "resource cleanup",
              message: sanitizeFailure(finalFailure, sensitiveValues),
            },
          ],
  };
  const { evidenceSha256 } = await writeSanitizedOrganizationImportRehearsalArtifact({
    artifactCore,
    evidencePath,
    sensitiveValues,
  });
  if (finalFailure !== undefined) throw finalFailure;
  return { evidencePath, evidenceSha256 };
};

const program = Effect.gen(function* () {
  const administratorUrl = yield* Config.redacted(
    "ORGANIZATION_IMPORT_REHEARSAL_ADMIN_PG_URL",
  ).pipe(Config.withDefault(Redacted.make("postgresql:///postgres?host=/run/postgresql")));
  const evidencePath = yield* Config.string("ORGANIZATION_IMPORT_REHEARSAL_EVIDENCE_PATH").pipe(
    Config.withDefault(SPEC_0067.evidencePath),
  );
  return yield* Effect.tryPromise(() =>
    runRehearsal(Redacted.value(administratorUrl), evidencePath),
  );
});

if (import.meta.main) {
  Effect.runPromise(program)
    .then(({ evidencePath, evidenceSha256 }) => {
      process.stdout.write(`${canonicalJson({ evidencePath, evidenceSha256 })}\n`);
    })
    .catch((cause: unknown) => {
      process.stderr.write(`spec 0067 Organization import rehearsal failed: ${String(cause)}\n`);
      process.exitCode = 1;
    });
}

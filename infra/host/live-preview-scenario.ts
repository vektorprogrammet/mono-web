import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  assertDisposablePostgresUrl,
  assertScenarioPrerequisites,
  prepareDisposableScenarioTarget,
  previewScenarioManifest,
  runPreviewScenarioApplication,
  type PreviewScenarioApplicationResult,
} from "./preview-scenario.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;
const databaseRequire = createRequire(
  new URL("../../packages/database/package.json", import.meta.url),
);
const { Pool } = databaseRequire("pg");

export const LIVE_ACKNOWLEDGMENT = "APPLY-0076-SYNTHETIC-PREVIEW" as const;
export const REHEARSAL_ACKNOWLEDGMENT = "REHEARSE-0076-DISPOSABLE-PREVIEW" as const;

export type LivePreviewScenarioMode = "live" | "rehearsal";

export interface ValidatedScenarioTarget {
  readonly mode: LivePreviewScenarioMode;
  readonly databaseUrl: string;
  readonly hostname: "127.0.0.1";
  readonly port: 5434 | 5435;
  readonly database: "vektor_preview" | "preview_scenario";
}

export interface LivePreviewScenarioCommand {
  readonly mode: LivePreviewScenarioMode;
  readonly target: "synthetic-preview" | "disposable-preview";
  readonly acknowledgment: string;
  readonly validatedTarget: ValidatedScenarioTarget;
}

const exactOptions = {
  mode: true,
  target: true,
  ack: true,
  "database-url": true,
} as const satisfies Record<string, true>;
type ScenarioOptionName = keyof typeof exactOptions;

const parseOptions = (args: ReadonlyArray<string>): ReadonlyMap<ScenarioOptionName, string> => {
  const parsed = new Map<ScenarioOptionName, string>();
  for (const argument of args) {
    assert.ok(argument.startsWith("--"), `unexpected positional argument: ${argument}`);
    const separator = argument.indexOf("=");
    assert.ok(separator > 2, `option must use --name=value: ${argument}`);
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    assert.ok(name in exactOptions, `unknown option: --${name}`);
    const optionName = name as ScenarioOptionName;
    assert.ok(value.length > 0, `empty option: --${name}`);
    assert.ok(!parsed.has(optionName), `duplicate option: --${name}`);
    parsed.set(optionName, value);
  }
  for (const name of Object.keys(exactOptions) as Array<ScenarioOptionName>) {
    assert.ok(parsed.has(name), `missing option: --${name}`);
  }
  return parsed;
};

export const validateScenarioTarget = (
  mode: LivePreviewScenarioMode,
  value: string,
): ValidatedScenarioTarget => {
  const parsed = new URL(value);
  assert.ok(
    parsed.protocol === "postgres:" || parsed.protocol === "postgresql:",
    "scenario target must use PostgreSQL",
  );
  assert.equal(parsed.hostname, "127.0.0.1", "scenario target must use 127.0.0.1");
  assert.equal(parsed.username, "postgres", "scenario target must use the postgres role");
  assert.equal(parsed.password, "", "scenario target URL must not contain a password");
  assert.equal(parsed.search, "", "scenario target URL must not contain query options");
  assert.equal(parsed.hash, "", "scenario target URL must not contain a fragment");

  if (mode === "live") {
    assert.equal(parsed.port, "5434", "live scenario target must use port 5434");
    assert.equal(
      parsed.pathname,
      "/vektor_preview",
      "live scenario database must be vektor_preview",
    );
    return {
      mode,
      databaseUrl: value,
      hostname: "127.0.0.1",
      port: 5434,
      database: "vektor_preview",
    };
  }

  assertDisposablePostgresUrl(value);
  assert.equal(parsed.port, "5435", "rehearsal target must use port 5435");
  assert.equal(parsed.pathname, "/preview_scenario", "rehearsal database must be preview_scenario");
  return {
    mode,
    databaseUrl: value,
    hostname: "127.0.0.1",
    port: 5435,
    database: "preview_scenario",
  };
};

export const parseLivePreviewScenarioCommand = (
  args: ReadonlyArray<string>,
): LivePreviewScenarioCommand => {
  const options = parseOptions(args);
  const mode = options.get("mode");
  assert.ok(mode === "live" || mode === "rehearsal", "mode must be live or rehearsal");
  const target = options.get("target");
  const acknowledgment = options.get("ack");
  const databaseUrl = options.get("database-url");
  assert.ok(databaseUrl !== undefined, "database URL is required");

  if (mode === "live") {
    assert.equal(target, "synthetic-preview", "live target acknowledgment mismatch");
    assert.equal(acknowledgment, LIVE_ACKNOWLEDGMENT, "live acknowledgment mismatch");
    return {
      mode,
      target: "synthetic-preview",
      acknowledgment,
      validatedTarget: validateScenarioTarget(mode, databaseUrl),
    };
  }

  assert.equal(target, "disposable-preview", "rehearsal target acknowledgment mismatch");
  assert.equal(acknowledgment, REHEARSAL_ACKNOWLEDGMENT, "rehearsal acknowledgment mismatch");
  return {
    mode,
    target: "disposable-preview",
    acknowledgment,
    validatedTarget: validateScenarioTarget(mode, databaseUrl),
  };
};

const providerEnvironmentNames = [
  "PUBLIC_APPLICATION_EFFECT_ENDPOINT",
  "PUBLIC_APPLICATION_EFFECT_TOKEN",
  "RECEIPT_EFFECT_ENDPOINT",
  "RECEIPT_EFFECT_TOKEN",
  "RECEIPT_PROVIDER_ENDPOINT",
  "RECEIPT_PROVIDER_TOKEN",
] as const;

export const assertProviderDeliveryDisabled = (environment: NodeJS.ProcessEnv): void => {
  const mode = environment.PUBLIC_APPLICATION_EFFECT_MODE;
  assert.ok(mode === undefined || mode === "disabled", "public application delivery is enabled");
  for (const name of providerEnvironmentNames) {
    assert.ok(environment[name] === undefined, `${name} must be absent`);
  }
  for (const [name, value] of Object.entries(environment)) {
    if (name.endsWith("_URL") || name.endsWith("_HOST")) {
      assert.ok(
        value === undefined || !value.toLowerCase().includes("vektorprogrammet.no"),
        `${name} contains a production host`,
      );
    }
  }
};

export interface SourceIdentity {
  readonly head: string;
  readonly clean: boolean;
}

export const readSourceIdentity = (): SourceIdentity => {
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(head.status, 0, `cannot resolve source HEAD: ${head.stderr}`);
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(status.status, 0, `cannot resolve source status: ${status.stderr}`);
  return { head: head.stdout.trim(), clean: status.stdout.trim().length === 0 };
};

export interface PreflightEvidence {
  readonly schemaRevision: string;
  readonly stateMarkerPresent: boolean;
  readonly syntheticIdentityCohortPresent: boolean;
  readonly canonicalScenarioCohortPresent: boolean;
  readonly canonicalPrerequisitesPresent: boolean;
  readonly providerDeliveryDisabled: true;
}

const liveMarkerPath = join(homedir(), ".local", "state", "vektor-preview", ".seeded");

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

export const preflightScenarioTarget = async (
  target: ValidatedScenarioTarget,
  environment: NodeJS.ProcessEnv,
): Promise<PreflightEvidence> => {
  assertProviderDeliveryDisabled(environment);
  const pool = new Pool({ connectionString: target.databaseUrl, max: 2 });
  try {
    const revision = await pool.query(
      `SELECT migration_id::text || '_' || name AS revision
       FROM public.vektorprogrammet_schema_migrations
       ORDER BY migration_id DESC
       LIMIT 1`,
    );
    assert.equal(
      revision.rows[0]?.revision,
      previewScenarioManifest.schemaRevision,
      "preview schema revision mismatch",
    );

    const canonicalIds = Object.values(previewScenarioManifest.persons).map(
      ({ personId }) => personId,
    );
    const canonical = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM person_profiles
       WHERE person_id = ANY($1::text[])`,
      [canonicalIds],
    );
    const canonicalScenarioCohortPresent = canonical.rows[0]?.count === canonicalIds.length;
    assert.ok(canonicalScenarioCohortPresent, "canonical 0072 identity cohort is missing");

    let syntheticIdentityCohortPresent = true;
    let stateMarkerPresent = true;
    if (target.mode === "live") {
      stateMarkerPresent = await fileExists(liveMarkerPath);
      assert.ok(stateMarkerPresent, `synthetic preview marker is missing: ${liveMarkerPath}`);
      const bootstrap = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM person_profiles AS person
         INNER JOIN person_contact_profiles AS contact USING (person_id)
         WHERE person.person_id = ANY($1::text[])
           AND contact.email LIKE '%@example.invalid'`,
        [["apex-preview-administrator", "apex-preview-member"]],
      );
      const grant = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM organization_global_administrator_grants
         WHERE grant_id = 'apex-preview-administrator-grant'
           AND person_id = 'apex-preview-administrator'`,
      );
      syntheticIdentityCohortPresent = bootstrap.rows[0]?.count === 2 && grant.rows[0]?.count === 1;
      assert.ok(syntheticIdentityCohortPresent, "synthetic preview identity cohort is missing");
    }

    await assertScenarioPrerequisites(pool);
    return {
      schemaRevision: revision.rows[0].revision,
      stateMarkerPresent,
      syntheticIdentityCohortPresent,
      canonicalScenarioCohortPresent,
      canonicalPrerequisitesPresent: true,
      providerDeliveryDisabled: true,
    };
  } finally {
    await pool.end().catch(() => undefined);
  }
};

export interface BackupMetadata {
  readonly filePath: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mode: "0600";
}

export const createPgDumpBackup = async (
  target: ValidatedScenarioTarget,
  directory: string,
  sourceHead: string,
): Promise<BackupMetadata> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const fileName = `0076-${timestamp}-${sourceHead.slice(0, 12)}-${randomBytes(6).toString("hex")}.dump`;
  const filePath = join(directory, fileName);
  const handle = await open(filePath, "wx", 0o600);
  await handle.close();
  const dump = spawnSync(
    "pg_dump",
    ["--format=custom", "--no-owner", "--no-acl", `--file=${filePath}`, target.databaseUrl],
    { encoding: "utf8" },
  );
  if (dump.status !== 0) {
    await rm(filePath, { force: true });
    throw new Error(`pg_dump failed: ${dump.stderr.trim()}`);
  }
  await chmod(filePath, 0o600);
  const details = await stat(filePath);
  assert.ok(details.size > 0, "pg_dump produced an empty snapshot");
  assert.equal(details.mode & 0o777, 0o600, "pg_dump snapshot mode is not 0600");
  const snapshotDigest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) snapshotDigest.update(chunk);
  return {
    filePath,
    fileName,
    sha256: snapshotDigest.digest("hex"),
    byteLength: details.size,
    mode: "0600",
  };
};

export const runBackupGatedApplication = async <A>(
  backup: () => Promise<BackupMetadata>,
  apply: (backup: BackupMetadata) => Promise<A>,
): Promise<{ readonly backup: BackupMetadata; readonly application: A }> => {
  const snapshot = await backup();
  const application = await apply(snapshot);
  return { backup: snapshot, application };
};

const scenarioTables = {
  admission_periods: "admission_period_id",
  admission_applications: "application_id",
  recruitment_interviews: "interview_id",
  economy_receipts: "receipt_id",
  content_articles: "article_id",
  organization_departments: "department_id",
  organization_teams: "team_id",
  organization_memberships: "membership_id",
} as const;

export interface ScenarioTableFact {
  readonly count: number;
  readonly sha256: string;
}

export type ScenarioDatabaseFacts = Record<keyof typeof scenarioTables, ScenarioTableFact>;

export const readScenarioDatabaseFacts = async (
  target: ValidatedScenarioTarget,
): Promise<ScenarioDatabaseFacts> => {
  const pool = new Pool({ connectionString: target.databaseUrl, max: 2 });
  const facts = {} as ScenarioDatabaseFacts;
  try {
    for (const [table, order] of Object.entries(scenarioTables) as Array<
      [keyof typeof scenarioTables, string]
    >) {
      const result = await pool.query(
        `SELECT to_jsonb(row_value) AS value
         FROM ${table} AS row_value
         ORDER BY ${order}`,
      );
      facts[table] = {
        count: result.rowCount ?? 0,
        sha256: createHash("sha256").update(JSON.stringify(result.rows)).digest("hex"),
      };
    }
    return facts;
  } finally {
    await pool.end().catch(() => undefined);
  }
};

export interface CommandReceiptFact {
  readonly kind: string;
  readonly commandId: string;
  readonly present: boolean;
}

export const readCommandReceiptFacts = async (
  target: ValidatedScenarioTarget,
): Promise<ReadonlyArray<CommandReceiptFact>> => {
  const pool = new Pool({ connectionString: target.databaseUrl, max: 2 });
  const commands = previewScenarioManifest.commandIds;
  const definitions = [
    ["organization-department", "organization_command_receipts", ...commands.departments],
    ["organization-team", "organization_command_receipts", commands.recruitmentTeam],
    ["admission-period", "admission_period_command_receipts", commands.admissionPeriod],
    ["application", "admission_application_command_receipts", commands.application],
    ["assignment", "recruitment_assignment_command_receipts", commands.assignment],
    ["receipt", "economy_receipt_command_receipts", commands.receipt],
    ["content-draft", "content_publication_command_receipts", commands.draft],
    ["content-publish", "content_publication_command_receipts", commands.publish],
  ] as const;
  const facts: CommandReceiptFact[] = [];
  try {
    for (const [kind, table, ...commandIds] of definitions) {
      const result = await pool.query(
        `SELECT command_id AS "commandId" FROM ${table} WHERE command_id = ANY($1::text[])`,
        [commandIds],
      );
      const present = new Set(result.rows.map(({ commandId }: { commandId: string }) => commandId));
      for (const commandId of commandIds) {
        facts.push({ kind, commandId, present: present.has(commandId) });
      }
    }
    return facts;
  } finally {
    await pool.end().catch(() => undefined);
  }
};

const sensitiveKey = /password|secret|token|cookie|databaseurl|postgresurl|userinfo|email|phone/i;
const secretValue = /postgres(?:ql)?:\/\/|https?:\/\/|@example\.invalid/i;

export const sanitizeEvidence = (input: unknown): unknown => {
  if (input === null || typeof input === "boolean" || typeof input === "number") return input;
  if (typeof input === "string") {
    assert.ok(!secretValue.test(input), "evidence contains a secret or URL-like value");
    return input;
  }
  if (Array.isArray(input)) return input.map((value) => sanitizeEvidence(value));
  assert.ok(typeof input === "object", "evidence contains an unsupported value");
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    assert.ok(!sensitiveKey.test(key), `evidence contains a sensitive key: ${key}`);
    output[key] = sanitizeEvidence(value);
  }
  return output;
};

export interface ScenarioApplicationRuns {
  readonly first: PreviewScenarioApplicationResult;
  readonly replay?: PreviewScenarioApplicationResult;
}

export interface LivePreviewScenarioEvidence {
  readonly specId: "0076";
  readonly formatRevision: 1;
  readonly mode: LivePreviewScenarioMode;
  readonly target: {
    readonly hostname: string;
    readonly port: number;
    readonly database: string;
  };
  readonly source: SourceIdentity;
  readonly preflight: PreflightEvidence;
  readonly before: ScenarioDatabaseFacts;
  readonly after: ScenarioDatabaseFacts;
  readonly commandReceipts: ReadonlyArray<CommandReceiptFact>;
  readonly applicationSteps: ReadonlyArray<Record<string, unknown>>;
  readonly replay: {
    readonly executed: boolean;
    readonly countsAndDigestsUnchanged: boolean;
    readonly allCommandStepsReplayed: boolean;
  };
  readonly backup: Omit<BackupMetadata, "filePath">;
  readonly rollbackCommand: string;
}

const commandStepNames = {
  "native-departments": true,
  "native-team": true,
  "admission-period": true,
  "public-application": true,
  "interview-assignment": true,
  "receipt-submit": true,
  "content-publication": true,
} as const satisfies Record<string, true>;

export interface ScenarioReplayEvaluation {
  readonly countsAndDigestsUnchanged: boolean;
  readonly allCommandStepsReplayed: boolean;
}

export const evaluateScenarioReplay = (
  steps: ReadonlyArray<Record<string, unknown>>,
  afterFirstRun: ScenarioDatabaseFacts,
  afterReplay: ScenarioDatabaseFacts,
  runnerCountsUnchanged: boolean,
): ScenarioReplayEvaluation => {
  const commandReplaySteps = steps.filter(
    ({ step }) => commandStepNames[String(step) as keyof typeof commandStepNames] === true,
  );
  return {
    allCommandStepsReplayed:
      commandReplaySteps.length === Object.keys(commandStepNames).length &&
      commandReplaySteps.every(({ status }) => status === "replayed"),
    countsAndDigestsUnchanged:
      runnerCountsUnchanged &&
      Object.keys(scenarioTables).every((table) => {
        const key = table as keyof ScenarioDatabaseFacts;
        return (
          afterFirstRun[key].count === afterReplay[key].count &&
          afterFirstRun[key].sha256 === afterReplay[key].sha256
        );
      }),
  };
};

export const runLivePreviewScenario = async (
  command: LivePreviewScenarioCommand,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ readonly evidence: LivePreviewScenarioEvidence; readonly evidencePath: string }> => {
  const source = readSourceIdentity();
  if (command.mode === "live")
    assert.ok(source.clean, "live scenario requires a clean source tree");

  if (command.mode === "rehearsal") {
    await prepareDisposableScenarioTarget(command.validatedTarget.databaseUrl);
  }
  const preflight = await preflightScenarioTarget(command.validatedTarget, environment);
  const before = await readScenarioDatabaseFacts(command.validatedTarget);
  const backupDirectory =
    command.mode === "live"
      ? join(homedir(), ".local", "state", "vektor-preview", "backups")
      : await mkdtemp(join(tmpdir(), "vektor-preview-0076-rehearsal-backups-"));

  const gated = await runBackupGatedApplication(
    () => createPgDumpBackup(command.validatedTarget, backupDirectory, source.head),
    async () => {
      const first = await runPreviewScenarioApplication({
        postgresUrl: command.validatedTarget.databaseUrl,
        emitEvidence: false,
      });
      const replay =
        command.mode === "rehearsal"
          ? await runPreviewScenarioApplication({
              postgresUrl: command.validatedTarget.databaseUrl,
              emitEvidence: false,
            })
          : undefined;
      return { first, ...(replay === undefined ? {} : { replay }) } as ScenarioApplicationRuns;
    },
  );

  const after = await readScenarioDatabaseFacts(command.validatedTarget);
  const commandReceipts = await readCommandReceiptFacts(command.validatedTarget);
  assert.ok(
    commandReceipts.every(({ present }) => present),
    "scenario command receipt is missing",
  );
  const replaySteps = gated.application.replay?.evidence.steps ?? [];
  const verificationFacts = await readScenarioDatabaseFacts(command.validatedTarget);
  const replayEvaluation = evaluateScenarioReplay(
    replaySteps,
    after,
    verificationFacts,
    gated.application.replay?.evidence.replayCheck?.countsUnchanged === true,
  );
  const allCommandStepsReplayed =
    command.mode === "rehearsal" && replayEvaluation.allCommandStepsReplayed;
  const countsAndDigestsUnchanged =
    command.mode === "rehearsal" && replayEvaluation.countsAndDigestsUnchanged;

  const applicationSteps = (
    gated.application.replay?.evidence.steps ?? gated.application.first.evidence.steps
  ).map(({ step, status }) => ({ step, status }));
  const rollbackCommand =
    command.mode === "live"
      ? `pg_restore --clean --if-exists --exit-on-error --dbname="$VEKTOR_PREVIEW_SCENARIO_DATABASE_URL" "$HOME/.local/state/vektor-preview/backups/${gated.backup.fileName}"`
      : `pg_restore --clean --if-exists --exit-on-error --dbname="$VEKTOR_PREVIEW_SCENARIO_DATABASE_URL" "<rehearsal-backup-dir>/${gated.backup.fileName}"`;
  const evidenceCandidate: LivePreviewScenarioEvidence = {
    specId: "0076",
    formatRevision: 1,
    mode: command.mode,
    target: {
      hostname: command.validatedTarget.hostname,
      port: command.validatedTarget.port,
      database: command.validatedTarget.database,
    },
    source,
    preflight,
    before,
    after,
    commandReceipts,
    applicationSteps,
    replay: {
      executed: gated.application.replay !== undefined,
      countsAndDigestsUnchanged,
      allCommandStepsReplayed,
    },
    backup: {
      fileName: gated.backup.fileName,
      sha256: gated.backup.sha256,
      byteLength: gated.backup.byteLength,
      mode: gated.backup.mode,
    },
    rollbackCommand,
  };
  const evidence = sanitizeEvidence(evidenceCandidate) as LivePreviewScenarioEvidence;
  const evidenceDirectory =
    command.mode === "live"
      ? join(homedir(), ".local", "state", "vektor-preview", "evidence")
      : await mkdtemp(join(tmpdir(), "vektor-preview-0076-rehearsal-evidence-"));
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  await chmod(evidenceDirectory, 0o700);
  const evidencePath = join(
    evidenceDirectory,
    `0076-${command.mode}-${source.head.slice(0, 12)}-${randomBytes(6).toString("hex")}.json`,
  );
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await chmod(evidencePath, 0o600);
  return { evidence, evidencePath };
};

const main = async (): Promise<void> => {
  const command = parseLivePreviewScenarioCommand(process.argv.slice(2));
  const result = await runLivePreviewScenario(command);
  process.stdout.write(`evidence written to ${result.evidencePath}\n`);
};

if (import.meta.main) {
  main().catch((cause: unknown) => {
    process.stderr.write(`${String(cause)}\n`);
    process.exitCode = 1;
  });
}

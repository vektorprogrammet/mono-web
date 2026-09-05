/**
 * Spec 0072 — representative preview scenario runner.
 *
 * Composes the existing seed surfaces into one small synthetic scenario shaped
 * like the deployed legacy organization (steering: NTNU/UiB/NMBU departments,
 * legacy team titles, @example.invalid contacts, legacy-register article and
 * receipt wording). Everything enters through native boundaries:
 *
 *   - identity:seed (better-auth engine, caller-supplied PersonIds)
 *   - generated native SDK operations for Organization, Admissions, Recruitment,
 *     Receipts and Content (the canonical HTTP contract owns paths and payloads)
 *   - Organization.importLegacyOrganization for the authority cohort
 *
 * Named prerequisites (recorded, never silent): admission authority rows,
 * global administrator and payment-authority grants, and the interview schema.
 * Schools remain an explicit skip because no native write command exists.
 *
 * Usage:
 *   PREVIEW_SCENARIO_PG_URL='postgres://postgres@127.0.0.1:5435/preview_scenario' \
 *   PREVIEW_SCENARIO_STORAGE_ROOT=/tmp/owned-preview-receipt-storage \
 *     bun infra/host/preview-scenario.ts
 *
 * Idempotent: compatible re-runs preserve witnessed HTTP command receipts and
 * business-table counts stay stable. Loopback-only, disposable databases only.
 */

import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseLive } from "../../packages/database/src/layers.js";
import { databaseMigrationDefinitions } from "../../packages/database/src/migrations.js";
import { createPromiseClient } from "../../packages/sdk/src/promise.js";
import { IdempotencyKey, StrongETag } from "../../packages/http-api/src/http-semantics.js";
import { DepartmentId, SemesterId } from "../../packages/domain/src/organization/schema.js";
import { AdmissionFieldOfStudyId } from "../../packages/domain/src/admission-period/schema.js";
import { InterviewSchemaId } from "../../packages/domain/src/recruitment/schema.js";
import { OrganizationLive } from "../../packages/domain/src/organization/postgres-layer.js";
import { Organization } from "../../packages/domain/src/organization/service.js";
import { contactDepartmentSlug } from "../../apps/homepage/src/lib/contact-message.js";
import {
  CreateDepartmentCommandSchema,
  CreateTeamCommandSchema,
  type CreateDepartmentCommand,
  type CreateTeamCommand,
} from "../../packages/domain/src/organization/administration-schema.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;
export const devMainNativeIdentityEnvironment = {
  NATIVE_IDENTITY_DEPLOYMENT: "preview",
  NATIVE_IDENTITY_TRUSTED_ORIGINS: '["https://vektor.phibkro.org"]',
  OAUTH_CANONICAL_ORIGIN: "https://vektor.phibkro.org",
  OAUTH_DASHBOARD_ORIGIN: "https://vektor.phibkro.org",
  OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
} as const;

export const makePreviewScenarioEnvironment = (
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const sanitized = { ...environment };
  delete sanitized.BETTER_AUTH_URL;
  delete sanitized.BETTER_AUTH_TRUSTED_ORIGINS;
  return { ...sanitized, ...devMainNativeIdentityEnvironment };
};

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Same TERM/KILL-and-observe pattern as the homepage contact acceptance runner. */
export const stopPreviewScenarioBackend = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
};

const waitForHttp = async (url: string, child: ChildProcess) => {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // backend not ready yet
    }
    if (child.exitCode !== null) {
      throw new Error(`backend exited with code ${child.exitCode}`);
    }
    await sleep(500);
  }
  throw new Error(`backend did not become ready at ${url}`);
};

const signIn = async (backendOrigin: string, email: string, password: string) => {
  const response = await fetch(`${backendOrigin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: devMainNativeIdentityEnvironment.OAUTH_CANONICAL_ORIGIN,
    },
    body: JSON.stringify({ email, password }),
  });
  assert.ok(response.ok, `scenario sign-in failed: HTTP ${response.status}`);
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) return null;
  return setCookie.split(";")[0] ?? null;
};

export const departmentEntityIdFor = (commandId: string): string => {
  const canonical = JSON.stringify({ commandId, entityKind: "Department" });
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `department-${digest}`;
};

const databaseRequire = createRequire(
  new URL("../../packages/database/package.json", import.meta.url),
);
const { Effect, Layer, Redacted, Schema } = databaseRequire("effect");
const { Pool } = databaseRequire("pg");

export const assertDisposablePostgresUrl = (value: string): void => {
  const parsed = new URL(value);
  assert.ok(
    parsed.protocol === "postgres:" || parsed.protocol === "postgresql:",
    "preview scenario seed requires PostgreSQL",
  );
  assert.ok(
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname),
    "preview scenario seed is restricted to loopback PostgreSQL",
  );
  assert.notEqual(parsed.port, "5434", "shared preview PostgreSQL port 5434 is forbidden");
  assert.match(
    decodeURIComponent(parsed.pathname.slice(1)),
    /preview|scenario/i,
    "preview scenario seed requires a disposable preview database name",
  );
  assert.ok(!parsed.hostname.endsWith("vektorprogrammet.no"), "production hosts are forbidden");
};

// --- Legacy-aligned scenario values (steering: legacy shapes, synthetic data) ---
const persons = {
  admin: {
    personId: "7200",
    firstName: "An",
    lastName: "Administrator",
    email: "admin.preview.0072@example.invalid",
    password: "preview-0072-admin-password",
  },
  leader: {
    personId: "7201",
    firstName: "Lina",
    lastName: "Leder",
    email: "lina.leader.preview.0072@example.invalid",
    password: "preview-0072-leader-password",
  },
  member: {
    personId: "7202",
    firstName: "Ming",
    lastName: "Medlem",
    email: "ming.medlem.preview.0072@example.invalid",
    password: "preview-0072-member-password",
  },
  interviewer: {
    personId: "7203",
    firstName: "Irene",
    lastName: "Intervjuer",
    email: "irene.intervjuer.preview.0072@example.invalid",
    password: "preview-0072-interviewer-password",
  },
  receiptOwner: {
    personId: "7204",
    firstName: "Ulla",
    lastName: "Utleggsier",
    email: "ulla.utlegg.preview.0072@example.invalid",
    password: "preview-0072-owner-password",
  },
  author: {
    personId: "7205",
    firstName: "Erik",
    lastName: "Forfatter",
    email: "erik.forfatter.preview.0072@example.invalid",
    password: "preview-0072-author-password",
  },
} as const;

const departmentId = DepartmentId.make("1");
const semesterId = SemesterId.make("preview-0072-semester");
const admissionPeriodCommandId = "preview-0072-period-command";
const fieldOfStudyId = AdmissionFieldOfStudyId.make("preview-0072-fos-datateknologi");
const recruitmentTeamCommandId = "preview-0092-team-rekruttering-command";
export const nativePreviewDepartments = [
  {
    id: "preview-0092-dept-synthetic-cmd",
    name: "Syntetisk demoavdeling",
    shortName: "Syntetisk demo",
    email: "synthetic-demo@example.invalid",
    city: "Trondheim",
  },
  {
    id: "preview-0072-dept-uib-cmd",
    name: "Bergen",
    shortName: "Bergen",
    email: "bergen@example.invalid",
    city: "Bergen",
  },
  {
    id: "preview-0072-dept-nmbu-cmd",
    name: "Ås",
    shortName: "Ås",
    email: "ås@example.invalid",
    city: "Ås",
  },
] as const;

export const nativePreviewDepartmentCommands: ReadonlyArray<CreateDepartmentCommand> =
  nativePreviewDepartments.map(({ id, ...department }) =>
    Schema.decodeUnknownSync(CreateDepartmentCommandSchema)({
      _tag: "CreateDepartment",
      commandId: id,
      ...department,
      address: null,
      latitude: null,
      longitude: null,
    }),
  );

export const nativePreviewTeamCommand: CreateTeamCommand = Schema.decodeUnknownSync(
  CreateTeamCommandSchema,
)({
  _tag: "CreateTeam",
  commandId: recruitmentTeamCommandId,
  departmentId: departmentEntityIdFor(nativePreviewDepartments[0].id),
  name: "Rekruttering",
  email: "rekruttering@example.invalid",
  description: "Rekruttering og intervju",
  shortDescription: "Rekruttering",
  acceptApplication: true,
  deadline: null,
  active: true,
});

/** Read-only: runs before even identity:seed (which applies migrations). */
export const assertPreviewScenarioCompatibility = async (
  pool: InstanceType<typeof Pool>,
): Promise<void> => {
  const tables = await pool.query(`SELECT
    to_regclass('public.organization_departments') IS NOT NULL AS departments,
    to_regclass('public.organization_command_receipts') IS NOT NULL AS receipts`);
  const previousDepartmentCommand = "preview-0072-dept-ntnu-cmd";
  if (tables.rows[0].departments) {
    const previous = await pool.query(
      `SELECT department_id FROM public.organization_departments WHERE department_id = $1`,
      [departmentEntityIdFor(previousDepartmentCommand)],
    );
    assert.equal(
      previous.rowCount,
      0,
      "incompatible pre-0092 preview scenario: department row; no mutation performed",
    );
  }
  if (tables.rows[0].receipts) {
    const previous = await pool.query(
      `SELECT command_id FROM public.organization_command_receipts WHERE command_id = ANY($1::text[])`,
      [[previousDepartmentCommand, "preview-0072-team-rekruttering-command"]],
    );
    assert.equal(
      previous.rowCount,
      0,
      "incompatible pre-0092 preview scenario: command receipt; no mutation performed",
    );
  }
};

export const assertUniqueContactDepartmentSlugs = (
  departments: ReadonlyArray<{ readonly active: boolean; readonly shortName: string }>,
): void => {
  const slugs = departments.filter((department) => department.active).map(contactDepartmentSlug);
  assert.ok(
    slugs.every((slug) => slug.length > 0),
    "empty active contact department slug",
  );
  assert.equal(new Set(slugs).size, slugs.length, "duplicate active contact department slug");
};
const applicantEmail = "sofie.soker.preview.0072@example.invalid";
const applicationCommandId = "preview-0072-application-command";
const assignmentCommandId = "preview-0072-assignment-command";
const interviewSchemaId = InterviewSchemaId.make("preview-0072-interview-schema");
const receiptCommandId = "preview-0072-receipt-command";
const draftCommandId = "preview-0072-draft-command";
const publishCommandId = "preview-0072-publish-command";
const snapshotId = "sha256:preview-0072-membership-snapshot";

// Wide window brackets "now" so the period stays OPEN and memberships stay
// ACTIVE across re-runs for years (real clock, no fixed-now requirement).
const semesterStartAt = "2026-01-01T00:00:00.000Z";
const semesterEndAt = "2037-01-01T00:00:00.000Z";
const periodStartAt = "2026-08-01T00:00:00.000Z";
const periodEndAt = "2036-12-31T23:59:59.999Z";
const membershipStartAt = "2026-01-01T00:00:00.000Z";
const receiptDate = "2026-08-20";

export const previewScenarioManifest = {
  schemaRevision: databaseMigrationDefinitions.at(-1)!.id,
  persons,
  departmentId,
  semesterId,
  fieldOfStudyId,
  interviewSchemaId,
  snapshotId,
  commandIds: {
    admissionPeriod: admissionPeriodCommandId,
    application: applicationCommandId,
    assignment: assignmentCommandId,
    receipt: receiptCommandId,
    draft: draftCommandId,
    publish: publishCommandId,
    recruitmentTeam: recruitmentTeamCommandId,
    departments: nativePreviewDepartments.map((department) => department.id),
  },
} as const;
const receiptBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

// --- Prerequisite SQL (named inserts, 0049 journey-seed precedent) ---
// All inserts are idempotent (ON CONFLICT DO NOTHING); each write is read back.
const prerequisitesSql = `
BEGIN;

-- (1) Global administrator grant: no native grant command exists.
INSERT INTO organization_global_administrator_grants (
  grant_id, person_id, start_at, end_at, revision
)
VALUES (
  'preview-0072-global-administrator',
  '${persons.admin.personId}',
  '${membershipStartAt}', NULL, 0
)
ON CONFLICT (grant_id) DO NOTHING;

-- (2) Shared department row across Admissions / Organization scopes.
INSERT INTO admission_period_departments (department_id)
VALUES ('${departmentId}')
ON CONFLICT (department_id) DO NOTHING;

-- (3) Admission semester row: no native create command exists (0049 precedent).
INSERT INTO admission_period_semesters (semester_id, start_at, end_at)
VALUES ('${semesterId}', '${semesterStartAt}', '${semesterEndAt}')
ON CONFLICT (semester_id) DO NOTHING;

-- (4) Field of study row: no native create command for the admissions scope.
INSERT INTO admission_period_fields_of_study (
  field_of_study_id, department_id, name, active
)
VALUES ('${fieldOfStudyId}', '${departmentId}', 'Datateknologi', TRUE)
ON CONFLICT (field_of_study_id) DO NOTHING;


-- (5) Payment authority for the receipt owner: no native create command
--     (recorded skip, spec 0061/0037 precedent). Ciphertext is a synthetic
--     placeholder, never a real account number.
INSERT INTO economy_payment_authorities (
  payment_authority_id, person_id, department_id,
  payment_account_ciphertext, start_at, end_at, revision
)
VALUES (
  'preview-0072-payment-authority',
  '${persons.receiptOwner.personId}',
  '${departmentId}',
  'ciphertext:preview-0072-placeholder',
  '${membershipStartAt}', NULL, 0
)
ON CONFLICT (payment_authority_id) DO NOTHING;

-- (6) Interview schema: no native create command (0049 precedent).
INSERT INTO recruitment_interview_schemas (
  interview_schema_id, name, question_count, active, revision
)
VALUES ('${interviewSchemaId}', 'Førstegangsintervju', 8, TRUE, 0)
ON CONFLICT (interview_schema_id) DO NOTHING;

INSERT INTO recruitment_interview_schema_questions (
  interview_schema_id, question_id, ordinal, prompt, help_text, kind, alternatives
) VALUES
  ('${interviewSchemaId}', '${interviewSchemaId}-q0', 0, 'Question 0', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q1', 1, 'Question 1', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q2', 2, 'Question 2', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q3', 3, 'Question 3', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q4', 4, 'Question 4', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q5', 5, 'Question 5', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q6', 6, 'Question 6', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q7', 7, 'Question 7', NULL, 'text', '[]'::jsonb)
ON CONFLICT (interview_schema_id, question_id) DO NOTHING;

COMMIT;
`;

export interface PreviewScenarioEvidence {
  schemaRevision: string | null;
  readonly steps: Array<Record<string, unknown>>;
  readonly skips: Array<Record<string, unknown>>;
  tableCountsBefore: Record<string, number>;
  tableCountsAfter: Record<string, number>;
  replayCheck: Record<string, unknown> | null;
  readonly legacyAlignment: Record<string, string>;
  readonly commandReceipts: Array<{ readonly kind: string; readonly identitySha256: string }>;
}

const makeEvidence = (): PreviewScenarioEvidence => ({
  schemaRevision: null,
  steps: [],
  skips: [],
  tableCountsBefore: {},
  tableCountsAfter: {},
  replayCheck: null,
  commandReceipts: [],
  legacyAlignment: {
    admissionPeriod: "/kontrollpanel/opptaksperiode",
    interviewAssignment: "/kontrollpanel/intervju/fordel/{id}",
    receiptSubmit: "/kontrollpanel/utlegg",
    articles: "/kontrollpanel/artikkeladmin",
    schoolsDirectory: "/kontrollpanel/skoleadmin",
    teams: "/kontrollpanel/teamadmin/team/{id}",
    publicSchools: "/skoler",
    publicNews: "/nyheter",
  },
});

const countTables = async (pool: InstanceType<typeof Pool>) => {
  const tables = [
    "admission_periods",
    "admission_applications",
    "recruitment_interviews",
    "economy_receipts",
    "content_articles",
    "organization_departments",
    "organization_teams",
    "organization_memberships",
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const result = await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
    counts[table] = result.rows[0].count;
  }
  return counts;
};

export interface PreviewScenarioPrerequisiteStatus {
  readonly globalAdministrator: boolean;
  readonly admissionDepartment: boolean;
  readonly admissionSemester: boolean;
  readonly fieldOfStudy: boolean;
  readonly paymentAuthority: boolean;
  readonly interviewSchema: boolean;
}

export const readPreviewScenarioPrerequisites = async (
  pool: InstanceType<typeof Pool>,
): Promise<PreviewScenarioPrerequisiteStatus> => {
  const result = await pool.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM organization_global_administrator_grants
         WHERE grant_id = 'preview-0072-global-administrator'
           AND person_id = $1
       ) AS "globalAdministrator",
       EXISTS (
         SELECT 1 FROM admission_period_departments WHERE department_id = $2
       ) AS "admissionDepartment",
       EXISTS (
         SELECT 1 FROM admission_period_semesters WHERE semester_id = $3
       ) AS "admissionSemester",
       EXISTS (
         SELECT 1 FROM admission_period_fields_of_study
         WHERE field_of_study_id = $4 AND department_id = $2
       ) AS "fieldOfStudy",
       EXISTS (
         SELECT 1 FROM economy_payment_authorities
         WHERE payment_authority_id = 'preview-0072-payment-authority'
           AND person_id = $5
           AND department_id = $2
       ) AS "paymentAuthority",
       (
         SELECT COUNT(*) = 8
         FROM recruitment_interview_schema_questions
         WHERE interview_schema_id = $6
       ) AS "interviewSchema"`,
    [
      persons.admin.personId,
      departmentId,
      semesterId,
      fieldOfStudyId,
      persons.receiptOwner.personId,
      interviewSchemaId,
    ],
  );
  return result.rows[0] as PreviewScenarioPrerequisiteStatus;
};

export const assertScenarioPrerequisites = async (
  pool: InstanceType<typeof Pool>,
): Promise<PreviewScenarioPrerequisiteStatus> => {
  const status = await readPreviewScenarioPrerequisites(pool);
  assert.ok(
    Object.values(status).every((present) => present),
    `preview scenario prerequisites are incomplete: ${JSON.stringify(status)}`,
  );
  return status;
};

const recordStep = (
  evidence: PreviewScenarioEvidence,
  step: string,
  status: "ok" | "replayed" | "skip",
  detail: Record<string, unknown>,
) => {
  evidence.steps.push({ step, status, ...detail });
};

interface PreviewScenarioCohortResult {
  readonly schemaRevision: string;
  readonly membershipCount: number;
}

const ensurePreviewScenarioCohort = async (
  pool: InstanceType<typeof Pool>,
  postgresUrl: string,
  evidence?: PreviewScenarioEvidence,
): Promise<PreviewScenarioCohortResult> => {
  await assertPreviewScenarioCompatibility(pool);
  const seed = spawnSync("bun", ["run", "identity:seed"], {
    cwd: join(repositoryRoot, "packages", "database"),
    env: {
      ...makePreviewScenarioEnvironment(),
      IDENTITY_SEED_PG_URL: postgresUrl,
      IDENTITY_SEED_PERSONS: JSON.stringify(Object.values(persons)),
    },
    encoding: "utf8",
  });
  assert.equal(seed.status, 0, `identity:seed failed:\n${seed.stderr}`);
  const revisionRow = await pool.query(
    `SELECT migration_id::text || '_' || name AS revision
     FROM public.vektorprogrammet_schema_migrations
     ORDER BY migration_id DESC
     LIMIT 1`,
  );
  const schemaRevision = revisionRow.rows[0]?.revision as string | undefined;
  assert.equal(
    schemaRevision,
    previewScenarioManifest.schemaRevision,
    "unexpected database schema revision",
  );
  const seedRows = await pool.query(
    `SELECT person_id FROM person_profiles WHERE person_id = ANY($1::text[])`,
    [Object.values(persons).map(({ personId }) => personId)],
  );
  assert.equal(seedRows.rowCount, Object.keys(persons).length, "identity seed read-back failed");
  if (evidence !== undefined) {
    evidence.schemaRevision = schemaRevision;
    recordStep(evidence, "identity-seed", "ok", { persons: Object.keys(persons).length });
  }

  const membershipSnapshot = {
    sourceRepository: "preview-scenario-0072",
    sourceRevision: "1",
    snapshotId,
    transformationRevision: "1",
    departments: [
      {
        id: 1,
        name: "Trondheim",
        shortName: "Trondheim",
        email: "trondheim@example.invalid",
        city: "Trondheim",
        active: true,
      },
    ],
    teams: [
      {
        id: 11,
        departmentId: 1,
        name: "Rekruttering",
        email: "rekruttering@example.invalid",
        active: true,
      },
    ],
    memberships: Object.values(persons)
      .filter((person) => person.personId !== persons.admin.personId)
      .map((person, index) => ({
        id: 7301 + index,
        userId: Number(person.personId),
        teamId: 11,
        deletedTeamName: null,
        startAt: membershipStartAt,
        endAt: null,
        positionId: index + 1,
        isTeamLeader: person.personId === persons.leader.personId,
        isLeader: person.personId === persons.leader.personId,
        isSuspended: false,
        isActive: true,
      })),
  };
  const databaseLayer = DatabaseLive({
    url: Redacted.make(postgresUrl),
    applicationName: "preview-scenario-0072-import",
    maxConnections: 1,
  });
  const organizationLayer = OrganizationLive.pipe(Layer.provide(databaseLayer));
  const importResult = await Effect.runPromise(
    Organization.use(({ importLegacyOrganization }) =>
      importLegacyOrganization(membershipSnapshot),
    ).pipe(Effect.provide(organizationLayer)),
  );
  assert.equal(importResult.quarantined.length, 0, "membership import quarantined rows");
  assert.equal(importResult.memberships.length, 5, "membership import did not accept all members");
  const membershipRows = await pool.query(
    `SELECT person_id FROM organization_memberships
     WHERE membership_id LIKE '73%'
     ORDER BY person_id`,
  );
  assert.equal(membershipRows.rowCount, 5, "membership import read-back failed");
  if (evidence !== undefined) {
    recordStep(evidence, "memberships-import", "ok", {
      memberships: importResult.memberships.length,
      boundary: "Organization.importLegacyOrganization",
    });
  }
  return { schemaRevision, membershipCount: importResult.memberships.length };
};

export const prepareDisposableScenarioTarget = async (postgresUrl: string): Promise<void> => {
  assertDisposablePostgresUrl(postgresUrl);
  const pool = new Pool({ connectionString: postgresUrl, max: 2 });
  try {
    await ensurePreviewScenarioCohort(pool, postgresUrl);
    await pool.query(prerequisitesSql);
    await assertScenarioPrerequisites(pool);
  } finally {
    await pool.end().catch(() => undefined);
  }
};

export interface PreviewScenarioApplicationOptions {
  readonly postgresUrl: string;
  readonly receiptStorageRoot: string;
  readonly backendPort?: number;
  readonly evidencePath?: string;
  readonly emitEvidence?: boolean;
}

export interface PreviewScenarioApplicationResult {
  readonly evidence: PreviewScenarioEvidence;
  readonly evidencePath: string | null;
}

export const runPreviewScenarioApplication = async (
  options: PreviewScenarioApplicationOptions,
): Promise<PreviewScenarioApplicationResult> => {
  assert.ok(
    options.receiptStorageRoot.trim().length > 0,
    "receiptStorageRoot is required and must persist for replay",
  );
  const { postgresUrl } = options;
  const evidence = makeEvidence();
  const pool = new Pool({ connectionString: postgresUrl, max: 4 });
  const backendPort = options.backendPort ?? 8872;
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const tempRoot = await mkdtemp(join(tmpdir(), "preview-scenario-0072-"));
  let backend: ChildProcess | undefined;

  try {
    await ensurePreviewScenarioCohort(pool, postgresUrl, evidence);

    await assertScenarioPrerequisites(pool);
    recordStep(evidence, "prerequisites", "replayed", {
      items: [
        "organization_global_administrator_grants (no native grant command)",
        "admission_period_semesters (no native command; 0049 precedent)",
        "admission_period_fields_of_study (no native command)",
        "economy_payment_authorities (no native command; recorded skip)",
        "recruitment_interview_schemas (+8 questions; no native command)",
      ],
    });
    evidence.skips.push(
      {
        surface: "global-administrator-grant",
        reason: "no native grant command exists",
      },
      {
        surface: "admission-semester",
        reason: "no native create command exists; uses the established 0049 prerequisite",
      },
      {
        surface: "admission-field-of-study",
        reason: "no native admissions-scope write command exists",
      },
      {
        surface: "payment-authority",
        reason: "no native payment-authority command exists",
      },
      {
        surface: "interview-schema",
        reason: "no native interview-schema command exists; uses the established 0049 prerequisite",
      },
      {
        surface: "membership-native-entity-reconciliation",
        reason:
          "the legacy importer maps numeric source IDs to string IDs and cannot target " +
          "native command-derived hashes; the authority journey uses imported Trondheim/Rekruttering",
      },
      {
        surface: "schools_directory",
        reason: "no native write command exists; rows are read-only via GET /api/schools",
      },
    );

    // 3) Compose the real backend (real Layers + real better-auth AuthLive)
    evidence.tableCountsBefore = await countTables(pool);
    const backendEnv: NodeJS.ProcessEnv = {
      ...makePreviewScenarioEnvironment(),
      BACKEND_HOST: "127.0.0.1",
      BACKEND_PORT: String(backendPort),
      BACKEND_PG_URL: postgresUrl,
      BETTER_AUTH_SECRET: "preview-0072-better-auth-secret-0123456789abcdef",
      ADMISSION_AUTH_TOKENS: "{}",
      RECEIPT_AUTH_TOKENS: "{}",
      ORGANIZATION_AUTH_TOKENS: "{}",
      PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
      RECEIPT_E2E_TEST_MODE: "1",
      RECEIPT_STAGING_ROOT: join(options.receiptStorageRoot, "receipt-staging"),
      RECEIPT_COMMITTED_ROOT: join(options.receiptStorageRoot, "receipt-committed"),
    };
    backend = spawn("bun", ["apps/backend/src/main.ts"], {
      cwd: repositoryRoot,
      env: backendEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const backendLogs: string[] = [];
    backend.stdout?.on("data", (chunk: Buffer) => backendLogs.push(chunk.toString()));
    backend.stderr?.on("data", (chunk: Buffer) => backendLogs.push(chunk.toString()));
    await waitForHttp(`${backendOrigin}/health`, backend);

    // Every SDK mutation is witnessed against the actual native HTTP receipt table.
    // The runner owns this isolated scenario; no other writer may share the target.
    const observeMutation = async <A extends { readonly body: unknown }>(
      kind: string,
      execute: () => Promise<A>,
    ): Promise<{ readonly response: A; readonly replayed: boolean }> => {
      const before = await pool.query(
        `SELECT identity_sha256 FROM public.native_http_idempotency_receipts`,
      );
      const response = await execute();
      const after = await pool.query(
        `SELECT identity_sha256, body_bytes FROM public.native_http_idempotency_receipts WHERE state = 'Complete'`,
      );
      const body = JSON.parse(JSON.stringify(response.body));
      const matching = after.rows.filter((row: { body_bytes: Buffer }) =>
        isDeepStrictEqual(JSON.parse(row.body_bytes.toString()), body),
      );
      assert.equal(matching.length, 1, `${kind} response must identify one actual HTTP receipt`);
      const identitySha256 = matching[0].identity_sha256 as string;
      const replayed = before.rows.some(
        (row: { identity_sha256: string }) => row.identity_sha256 === identitySha256,
      );
      evidence.commandReceipts.push({ kind, identitySha256 });
      return { response, replayed };
    };
    const idempotency = (key: string) => ({ "idempotency-key": IdempotencyKey.make(key) });
    const clientFor = (cookie?: string) =>
      createPromiseClient(backendOrigin, {
        ...(cookie === undefined ? {} : { cookie }),
        origin: devMainNativeIdentityEnvironment.OAUTH_CANONICAL_ORIGIN,
        fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
      });
    const adminCookie = await signIn(backendOrigin, persons.admin.email, persons.admin.password);
    assert.ok(adminCookie, "admin sign-in returned no session cookie");
    const admin = clientFor(adminCookie);
    recordStep(evidence, "sign-in-admin", "ok", {});

    let replayedDepartments = 0;
    let syntheticDepartmentId: DepartmentId | undefined;
    for (const { commandId, _tag, ...payload } of nativePreviewDepartmentCommands) {
      const created = await observeMutation("organization-department", () =>
        admin.organization.createDepartment({ headers: idempotency(commandId), payload }),
      );
      if (created.replayed) replayedDepartments += 1;
      if (commandId === nativePreviewDepartmentCommands[0]?.commandId)
        syntheticDepartmentId = created.response.body.departmentId;
    }
    assert.ok(syntheticDepartmentId, "native demo department response omitted identity");
    const contactDepartments = await admin.organization.listDepartments({ headers: {} });
    assert.ok(contactDepartments.body);
    assertUniqueContactDepartmentSlugs(contactDepartments.body);
    recordStep(
      evidence,
      "native-departments",
      replayedDepartments === nativePreviewDepartmentCommands.length ? "replayed" : "ok",
      { count: nativePreviewDepartmentCommands.length, activeContactSlugsUnique: true },
    );

    const {
      commandId: teamKey,
      _tag: _teamTag,
      departmentId: _priorDepartmentId,
      ...teamFields
    } = nativePreviewTeamCommand;
    const team = await observeMutation("organization-team", () =>
      admin.organization.createTeam({
        headers: idempotency(teamKey),
        payload: { ...teamFields, departmentId: syntheticDepartmentId },
      }),
    );
    recordStep(evidence, "native-team", team.replayed ? "replayed" : "ok", {
      teamId: team.response.body.teamId,
    });

    const period = await observeMutation("admission-period", () =>
      admin.admissions.createAdmissionPeriod({
        headers: idempotency(admissionPeriodCommandId),
        payload: { semesterId, startAt: periodStartAt, endAt: periodEndAt, departmentId },
      }),
    );
    recordStep(evidence, "admission-period", period.replayed ? "replayed" : "ok", { open: true });
    const application = await observeMutation("application", () =>
      clientFor().admissions.submitApplication({
        headers: idempotency(applicationCommandId),
        payload: {
          departmentId,
          firstName: "Sofie",
          lastName: "Søker",
          phone: "+47 900 00 072",
          email: applicantEmail,
          gender: 1,
          fieldOfStudyId,
          yearOfStudy: 3,
        },
      }),
    );
    const applicationId = application.response.body.applicationId;
    recordStep(evidence, "public-application", application.replayed ? "replayed" : "ok", {
      applicationId,
    });

    const leaderCookie = await signIn(backendOrigin, persons.leader.email, persons.leader.password);
    assert.ok(leaderCookie, "leader sign-in returned no session cookie");
    const leader = clientFor(leaderCookie);
    const board = await leader.recruitment.readAssignmentBoard({ query: { status: "all" } });
    const candidate = board.body.candidates.find((item) => item.applicationId === applicationId);
    const interviewer = board.body.interviewers.find(
      (item) => item.personId === persons.interviewer.personId,
    );
    const schema = board.body.interviewSchemas.find(
      (item) => item.interviewSchemaId === interviewSchemaId,
    );
    assert.ok(candidate, "assignment board omitted the scenario application");
    assert.ok(interviewer, "assignment board omitted the scenario interviewer");
    assert.ok(schema, "assignment board omitted the scenario interview schema");
    // Current assignment command replays directly even once the applicant leaves the new board.
    const assignment = await observeMutation("assignment", () =>
      leader.recruitment.createApplicationInterview({
        params: { applicationId },
        headers: idempotency(assignmentCommandId),
        payload: {
          interviewerPersonId: interviewer.personId,
          interviewSchemaId: schema.interviewSchemaId,
        },
      }),
    );
    recordStep(evidence, "interview-assignment", assignment.replayed ? "replayed" : "ok", {
      interviewId: assignment.response.body.interviewId,
    });

    const ownerCookie = await signIn(
      backendOrigin,
      persons.receiptOwner.email,
      persons.receiptOwner.password,
    );
    assert.ok(ownerCookie, "receipt owner sign-in returned no session cookie");
    const form = new FormData();
    form.set("description", "Kaffetraktere og grenuttak til stand");
    form.set("amountOre", "1108");
    form.set("receiptDate", receiptDate);
    form.set("file", new File([receiptBytes], "receipt.png", { type: "image/png" }));
    const receipt = await observeMutation("receipt", () =>
      clientFor(ownerCookie).receipts.submitReceipt({
        query: {},
        headers: idempotency(receiptCommandId),
        payload: form,
      }),
    );
    const receiptId = receipt.response.body.receiptId;
    const storedReceipt = await pool.query(
      `SELECT status, file_object_key AS "objectKey", file_sha256 AS sha256 FROM public.economy_receipts WHERE receipt_id = $1`,
      [receiptId],
    );
    assert.equal(storedReceipt.rows[0]?.status, "Pending");
    const committedFile = await readFile(
      join(options.receiptStorageRoot, "receipt-committed", storedReceipt.rows[0].objectKey),
    );
    assert.equal(
      createHash("sha256").update(committedFile).digest("hex"),
      storedReceipt.rows[0].sha256,
    );
    recordStep(evidence, "receipt-submit", receipt.replayed ? "replayed" : "ok", {
      receiptId,
      receiptStatus: "Pending",
      committedFileVerified: true,
    });

    const authorCookie = await signIn(backendOrigin, persons.author.email, persons.author.password);
    assert.ok(authorCookie, "article author sign-in returned no session cookie");
    const draft = await observeMutation("content-draft", () =>
      clientFor(authorCookie).content.createArticle({
        headers: idempotency(draftCommandId),
        payload: {
          title: "Vektorprogrammet starter opptaket",
          bodyHtml:
            "<p>Opptaket for det nye studieåret er i gang. Alle interesserte kan sende inn søknad gjennom nettsiden. Vi gleder oss til å møte dere!</p>",
          departmentIds: [departmentId],
          sticky: false,
        },
      }),
    );
    const articleId = draft.response.body.articleId;
    // ETags include the reading caller's authority. Persist the leader's original
    // observed precondition so replay submits the same request after publication.
    const publicationPreconditionPath = join(
      options.receiptStorageRoot,
      `${publishCommandId}-${articleId}.etag`,
    );
    const savedPrecondition = await readFile(publicationPreconditionPath, "utf8").catch(
      (cause: unknown) => {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw cause;
      },
    );
    let publicationPrecondition: StrongETag;
    if (savedPrecondition === undefined) {
      const selected = await leader.content.readArticle({ params: { articleId }, headers: {} });
      assert.equal(
        selected.body?.status,
        "Draft",
        "published scenario lost its original precondition",
      );
      publicationPrecondition = selected.headers.etag;
      await mkdir(options.receiptStorageRoot, { recursive: true, mode: 0o700 });
      await writeFile(publicationPreconditionPath, publicationPrecondition, {
        flag: "wx",
        mode: 0o600,
      });
    } else {
      publicationPrecondition = Schema.decodeUnknownSync(StrongETag)(savedPrecondition);
    }
    const publication = await observeMutation("content-publish", () =>
      leader.content.publishArticle({
        params: { articleId },
        headers: { ...idempotency(publishCommandId), "if-match": publicationPrecondition },
        payload: {},
      }),
    );
    assert.equal(publication.response.body.versionNumber, 1);
    recordStep(
      evidence,
      "content-publication",
      draft.replayed && publication.replayed ? "replayed" : "ok",
      { articleId, versionNumber: 1 },
    );

    // 13) Per-invocation idempotency evidence. A replay keeps all business
    //     table counts unchanged and reports replayed command steps above.
    evidence.tableCountsAfter = await countTables(pool);
    evidence.replayCheck = {
      countsUnchanged: Object.keys(evidence.tableCountsBefore).every(
        (table) => evidence.tableCountsBefore[table] === evidence.tableCountsAfter[table],
      ),
      before: evidence.tableCountsBefore,
      after: evidence.tableCountsAfter,
    };

    let evidencePath: string | null = null;
    if (options.emitEvidence !== false) {
      evidencePath = options.evidencePath ?? join(tempRoot, "preview-scenario-evidence.json");
      await writeFile(
        evidencePath,
        JSON.stringify(
          { ...evidence, postgresUrl: postgresUrl.replace(/\/\/[^@]*@/, "//***@") },
          null,
          2,
        ),
      );
      process.stdout.write(`evidence written to ${evidencePath}\n`);
    }
    return { evidence, evidencePath };
  } finally {
    if (backend !== undefined) await stopPreviewScenarioBackend(backend);
    backend?.stdout?.destroy();
    backend?.stderr?.destroy();
    await pool.end().catch(() => undefined);
  }
};

const main = async (): Promise<void> => {
  const postgresUrl =
    process.env.PREVIEW_SCENARIO_PG_URL ?? "postgres://postgres@127.0.0.1:5435/preview_scenario";
  assertDisposablePostgresUrl(postgresUrl);
  const receiptStorageRoot = process.env.PREVIEW_SCENARIO_STORAGE_ROOT;
  assert.ok(receiptStorageRoot, "PREVIEW_SCENARIO_STORAGE_ROOT is required");
  await prepareDisposableScenarioTarget(postgresUrl);
  await runPreviewScenarioApplication({ postgresUrl, receiptStorageRoot });
};

if (import.meta.main) {
  main().catch((cause: unknown) => {
    process.stderr.write(`${String(cause)}\n`);
    process.exitCode = 1;
  });
}

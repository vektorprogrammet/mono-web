/**
 * Spec 0072 — representative preview scenario runner.
 *
 * Composes the existing seed surfaces into one small synthetic scenario shaped
 * like the deployed legacy organization (steering: NTNU/UiB/NMBU departments,
 * legacy team titles, @example.invalid contacts, legacy-register article and
 * receipt wording). Everything enters through native boundaries:
 *
 *   - identity:seed (better-auth engine, caller-supplied PersonIds)
 *   - POST /api/admin/departments|teams      (native Organization administration)
 *   - Organization.importLegacyOrganization  (memberships — no native create command)
 *   - POST /api/admin/admission-periods      (CreateAdmissionPeriod)
 *   - POST /api/applications                 (public application submit)
 *   - POST /api/admin/recruitment/interviews/assign
 *   - POST /api/receipts/submit              (multipart, payment authority prerequisite)
 *   - POST /api/admin/content/articles + /{id}/publish
 *
 * Named prerequisites (recorded, never silent): admission authority rows,
 * global administrator and payment-authority grants, and the interview schema.
 * Schools remain an explicit skip because no native write command exists.
 *
 * Usage:
 *   PREVIEW_SCENARIO_PG_URL='postgres://postgres@127.0.0.1:5435/preview_scenario' \
 *     bun infra/host/preview-scenario.ts
 *
 * Idempotent: safe re-run, every command replay returns replayed:true and
 * business-table counts stay stable. Loopback-only, disposable databases only.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseLive } from "../../packages/database/src/layers.js";
import { OrganizationLive } from "../../packages/domain/src/organization/postgres-layer.js";
import { Organization } from "../../packages/domain/src/organization/service.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
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
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) return null;
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
const { Effect, Layer, Redacted } = databaseRequire("effect");
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

const departmentId = "1";
const semesterId = "preview-0072-semester";
const admissionPeriodCommandId = "preview-0072-period-command";
const fieldOfStudyId = "preview-0072-fos-datateknologi";
const recruitmentTeamCommandId = "preview-0072-team-rekruttering-command";
const applicantEmail = "sofie.soker.preview.0072@example.invalid";
const applicationCommandId = "preview-0072-application-command";
const assignmentCommandId = "preview-0072-assignment-command";
const interviewSchemaId = "preview-0072-interview-schema";
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
  schemaRevision: "23_declarative-authorization-rules",
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
    departments: [
      "preview-0072-dept-ntnu-cmd",
      "preview-0072-dept-uib-cmd",
      "preview-0072-dept-nmbu-cmd",
    ],
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
}

const makeEvidence = (): PreviewScenarioEvidence => ({
  schemaRevision: null,
  steps: [],
  skips: [],
  tableCountsBefore: {},
  tableCountsAfter: {},
  replayCheck: null,
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
  const seed = spawnSync("bun", ["run", "identity:seed"], {
    cwd: join(repositoryRoot, "packages", "database"),
    env: {
      ...process.env,
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
        reason: "no native write command exists; rows are read-only via GET /api/admin/schools",
      },
    );

    // 3) Compose the real backend (real Layers + real better-auth AuthLive)
    evidence.tableCountsBefore = await countTables(pool);
    const backendEnv: NodeJS.ProcessEnv = {
      ...process.env,
      BACKEND_HOST: "127.0.0.1",
      BACKEND_PORT: String(backendPort),
      BACKEND_PG_URL: postgresUrl,
      BETTER_AUTH_SECRET: "preview-0072-better-auth-secret-0123456789abcdef",
      BETTER_AUTH_URL: backendOrigin,
      ADMISSION_AUTH_TOKENS: "{}",
      RECEIPT_AUTH_TOKENS: "{}",
      ORGANIZATION_AUTH_TOKENS: "{}",
      PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
      RECEIPT_E2E_TEST_MODE: "1",
      RECEIPT_STAGING_ROOT: join(tempRoot, "receipt-staging"),
      RECEIPT_COMMITTED_ROOT: join(tempRoot, "receipt-committed"),
    };
    backend = spawn("bun", ["run", "--cwd", "apps/backend", "start"], {
      cwd: repositoryRoot,
      env: backendEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const backendLogs: string[] = [];
    backend.stdout?.on("data", (chunk: Buffer) => backendLogs.push(chunk.toString()));
    backend.stderr?.on("data", (chunk: Buffer) => backendLogs.push(chunk.toString()));
    await waitForHttp(`${backendOrigin}/health`, backend);

    // 4) Sign in as admin via the real better-auth endpoint
    const adminCookie = await signIn(backendOrigin, persons.admin.email, persons.admin.password);
    assert.ok(
      adminCookie !== null && adminCookie.includes("session_token"),
      "admin sign-in returned no session cookie",
    );
    recordStep(evidence, "sign-in-admin", "ok", {});

    // 5) Native departments (legacy-aligned: NTNU/UiB/NMBU)
    const departments = [
      {
        id: "preview-0072-dept-ntnu-cmd",
        name: "Trondheim",
        shortName: "Trondheim",
        city: "Trondheim",
      },
      { id: "preview-0072-dept-uib-cmd", name: "Bergen", shortName: "Bergen", city: "Bergen" },
      { id: "preview-0072-dept-nmbu-cmd", name: "Ås", shortName: "Ås", city: "Ås" },
    ];
    let replayedDepartments = 0;
    for (const department of departments) {
      const response = await fetch(`${backendOrigin}/api/admin/departments`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: adminCookie },
        body: JSON.stringify({
          _tag: "CreateDepartment",
          commandId: department.id,
          name: department.name,
          shortName: department.shortName,
          email: `${department.shortName.toLowerCase()}@example.invalid`,
          address: null,
          city: department.city,
          latitude: null,
          longitude: null,
        }),
      });
      assert.ok(
        response.status === 201 || response.status === 200,
        `create department ${department.name} failed: ${response.status}`,
      );
      if (response.status === 200) replayedDepartments += 1;
    }
    const departmentCount = await pool.query(
      `SELECT COUNT(*)::int AS count FROM organization_departments WHERE department_id LIKE 'department-%'`,
    );
    assert.ok(departmentCount.rows[0].count >= 3, "native departments read-back failed");
    recordStep(
      evidence,
      "native-departments",
      replayedDepartments === departments.length ? "replayed" : "ok",
      {
        count: 3,
        legacy: "NTNU/UiB/NMBU",
      },
    );

    // 6) Native team (Styret/IT/Rekruttering style) under Trondheim
    const teamResponse = await fetch(`${backendOrigin}/api/admin/teams`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({
        _tag: "CreateTeam",
        commandId: recruitmentTeamCommandId,
        departmentId: departmentEntityIdFor(departments[0].id),
        name: "Rekruttering",
        email: "rekruttering@example.invalid",
        description: "Rekruttering og intervju",
        shortDescription: "Rekruttering",
        acceptApplication: true,
        deadline: null,
        active: true,
      }),
    });
    assert.ok(
      teamResponse.status === 201 || teamResponse.status === 200,
      `create team failed: ${teamResponse.status}`,
    );
    recordStep(evidence, "native-team", teamResponse.status === 200 ? "replayed" : "ok", {
      name: "Rekruttering",
    });

    // 8) Open admission period via native command (GlobalAdmin = admin)
    const periodResponse = await fetch(`${backendOrigin}/api/admin/admission-periods`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({
        commandId: admissionPeriodCommandId,
        semesterId,
        startAt: periodStartAt,
        endAt: periodEndAt,
        departmentId,
      }),
    });
    assert.ok(
      periodResponse.status === 201 || periodResponse.status === 200,
      `create admission period failed: ${periodResponse.status}`,
    );
    recordStep(evidence, "admission-period", periodResponse.status === 200 ? "replayed" : "ok", {
      open: true,
    });

    // 9) Public application submit (native public boundary)
    const applicationResponse = await fetch(`${backendOrigin}/api/applications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: applicationCommandId,
        departmentId,
        firstName: "Sofie",
        lastName: "Søker",
        phone: "+47 900 00 072",
        email: applicantEmail,
        gender: 1,
        fieldOfStudyId,
        yearOfStudy: 3,
      }),
    });
    const applicationResponseBody = await applicationResponse.clone().text();
    assert.ok(
      applicationResponse.status === 201 || applicationResponse.status === 200,
      `application submit failed: ${applicationResponse.status} ${applicationResponseBody}`,
    );
    const applicationObservation = JSON.parse(applicationResponseBody) as {
      applicationId?: string;
    };
    assert.ok(applicationObservation.applicationId, "application response omitted applicationId");
    recordStep(
      evidence,
      "public-application",
      applicationResponse.status === 200 ? "replayed" : "ok",
      {
        applicant: applicantEmail,
        applicationId: applicationObservation.applicationId,
      },
    );

    // 10) Interview assignment (leader scope), or an exact receipt read-back on replay.
    const assignmentReceipt = await pool.query(
      `SELECT interview_id AS "interviewId"
       FROM recruitment_assignment_command_receipts
       WHERE command_id = $1`,
      [assignmentCommandId],
    );
    const existingInterviewId = assignmentReceipt.rows[0]?.interviewId as string | undefined;
    if (existingInterviewId !== undefined) {
      recordStep(evidence, "interview-assignment", "replayed", {
        interviewId: existingInterviewId,
      });
    } else {
      const leaderCookie = await signIn(
        backendOrigin,
        persons.leader.email,
        persons.leader.password,
      );
      assert.ok(leaderCookie, "leader sign-in returned no session cookie");
      const boardResponse = await fetch(
        `${backendOrigin}/api/admin/recruitment/assignment-board?status=new`,
        { headers: { cookie: leaderCookie } },
      );
      const boardBody = await boardResponse.text();
      assert.equal(boardResponse.status, 200, `assignment board failed: ${boardBody}`);
      const board = JSON.parse(boardBody) as {
        candidates?: Array<{ applicationId: string }>;
        interviewers?: Array<{ personId: string }>;
        interviewSchemas?: Array<{ interviewSchemaId: string }>;
      };
      const candidate = board.candidates?.find(
        ({ applicationId }) => applicationId === applicationObservation.applicationId,
      );
      const interviewer = board.interviewers?.find(
        ({ personId }) => personId === persons.interviewer.personId,
      );
      const schema = board.interviewSchemas?.find(
        ({ interviewSchemaId: id }) => id === interviewSchemaId,
      );
      assert.ok(candidate, "assignment board omitted the scenario application");
      assert.ok(interviewer, "assignment board omitted the scenario interviewer");
      assert.ok(schema, "assignment board omitted the scenario interview schema");
      const assignResponse = await fetch(
        `${backendOrigin}/api/admin/recruitment/interviews/assign`,
        {
          method: "POST",
          headers: { "content-type": "application/json", cookie: leaderCookie },
          body: JSON.stringify({
            commandId: assignmentCommandId,
            applicationId: candidate.applicationId,
            interviewerPersonId: interviewer.personId,
            interviewSchemaId: schema.interviewSchemaId,
          }),
        },
      );
      const assignBody = await assignResponse.text();
      assert.ok(
        assignResponse.status === 201 || assignResponse.status === 200,
        `interview assign failed: ${assignResponse.status} ${assignBody}`,
      );
      const assignmentResult = JSON.parse(assignBody) as {
        observation?: { interview?: { interviewId?: string } };
        replayed?: boolean;
      };
      assert.ok(
        assignmentResult.observation?.interview?.interviewId,
        `assignment response omitted interviewId: ${assignBody}`,
      );
      recordStep(evidence, "interview-assignment", assignmentResult.replayed ? "replayed" : "ok", {
        interviewId: assignmentResult.observation.interview.interviewId,
      });
    }

    // 11) Receipt submit (multipart, owner with payment authority prerequisite)
    const ownerCookie = await signIn(
      backendOrigin,
      persons.receiptOwner.email,
      persons.receiptOwner.password,
    );
    assert.ok(ownerCookie, "receipt owner sign-in returned no session cookie");
    const form = new FormData();
    form.append("commandId", receiptCommandId);
    form.append("description", "Kaffetraktere og grenuttak til stand");
    form.append("amountOre", "1108");
    form.append("receiptDate", receiptDate);
    form.append("file", new File([receiptBytes], "receipt.png", { type: "image/png" }));
    const receiptResponse = await fetch(`${backendOrigin}/api/receipts/submit`, {
      method: "POST",
      headers: { cookie: ownerCookie },
      body: form,
    });
    const receiptBody = await receiptResponse.text();
    assert.ok(
      receiptResponse.status === 201 || receiptResponse.status === 200,
      `receipt submit failed: ${receiptResponse.status} ${receiptBody}`,
    );
    const pendingReceipt = await pool.query(
      `SELECT receipt.receipt_id AS "receiptId", receipt.status
       FROM economy_receipt_command_receipts AS command
       INNER JOIN economy_receipts AS receipt ON receipt.receipt_id = command.receipt_id
       WHERE command.command_id = $1`,
      [receiptCommandId],
    );
    assert.equal(pendingReceipt.rows[0]?.status, "Pending", "receipt is not pending");
    recordStep(evidence, "receipt-submit", receiptResponse.status === 200 ? "replayed" : "ok", {
      receiptId: pendingReceipt.rows[0]?.receiptId,
      receiptStatus: "Pending",
      description: "Kaffetraktere og grenuttak til stand",
    });

    // 12) Article draft + publish (member authors; team leader publishes)
    const existingDraftReceipt = await pool.query(
      `SELECT 1 FROM content_publication_command_receipts WHERE command_id = $1`,
      [draftCommandId],
    );
    const authorCookie = await signIn(backendOrigin, persons.author.email, persons.author.password);
    assert.ok(authorCookie, "article author sign-in returned no session cookie");
    const draftResponse = await fetch(`${backendOrigin}/api/admin/content/articles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: authorCookie },
      body: JSON.stringify({
        commandId: draftCommandId,
        title: "Vektorprogrammet starter opptaket",
        bodyHtml:
          "<p>Opptaket for det nye studieåret er i gang. Alle interesserte kan " +
          "sende inn søknad gjennom nettsiden. Vi gleder oss til å møte dere!</p>",
        departmentIds: [departmentId],
        sticky: false,
      }),
    });
    const draftBody = await draftResponse.text();
    assert.ok(
      draftResponse.status === 201 || draftResponse.status === 200,
      `article draft failed: ${draftResponse.status} ${draftBody}`,
    );
    const draft = JSON.parse(draftBody) as { articleId?: number };
    const articleId = draft.articleId;
    assert.ok(articleId, "article draft returned no id");
    const existingPublishReceipt = await pool.query(
      `SELECT 1 FROM content_publication_command_receipts WHERE command_id = $1`,
      [publishCommandId],
    );
    const publisherCookie = await signIn(
      backendOrigin,
      persons.leader.email,
      persons.leader.password,
    );
    assert.ok(publisherCookie, "article publisher sign-in returned no session cookie");
    const publishResponse = await fetch(
      `${backendOrigin}/api/admin/content/articles/${articleId}/publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: publisherCookie },
        body: JSON.stringify({ commandId: publishCommandId, articleId }),
      },
    );
    const publishBody = await publishResponse.text();
    assert.ok(
      publishResponse.status === 200 || publishResponse.status === 201,
      `article publish failed: ${publishResponse.status} ${publishBody}`,
    );
    const publishedArticle = await pool.query(
      `SELECT current_version_number AS "versionNumber"
       FROM content_articles
       WHERE article_id = $1`,
      [articleId],
    );
    assert.equal(
      publishedArticle.rows[0]?.versionNumber,
      1,
      "article does not have a published version",
    );
    recordStep(
      evidence,
      "content-publication",
      existingDraftReceipt.rowCount === 1 && existingPublishReceipt.rowCount === 1
        ? "replayed"
        : "ok",
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
    if (backend?.exitCode === null) {
      const { promise, resolve } = Promise.withResolvers<void>();
      backend.once("exit", () => resolve());
      backend.kill("SIGTERM");
      await Promise.race([promise, sleep(5_000)]);
    }
    backend?.stdout?.destroy();
    backend?.stderr?.destroy();
    await pool.end().catch(() => undefined);
  }
};

const main = async (): Promise<void> => {
  const postgresUrl =
    process.env.PREVIEW_SCENARIO_PG_URL ?? "postgres://postgres@127.0.0.1:5435/preview_scenario";
  assertDisposablePostgresUrl(postgresUrl);
  await prepareDisposableScenarioTarget(postgresUrl);
  await runPreviewScenarioApplication({ postgresUrl });
};

if (import.meta.main) {
  main().catch((cause: unknown) => {
    process.stderr.write(`${String(cause)}\n`);
    process.exitCode = 1;
  });
}

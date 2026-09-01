import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const databaseRoot = fileURLToPath(new URL("../../../packages/database/", import.meta.url));
const databaseRequire = createRequire(
  new URL("../../../packages/database/package.json", import.meta.url),
);
const { Pool } = databaseRequire("pg");

const postgresUrl = process.env.RECEIPT_APPROVAL_PG_URL;
const trustedOrigins = JSON.parse(process.env.NATIVE_IDENTITY_TRUSTED_ORIGINS ?? "null");
assert.ok(
  Array.isArray(trustedOrigins) &&
    trustedOrigins.length === 1 &&
    typeof trustedOrigins[0] === "string",
  "NATIVE_IDENTITY_TRUSTED_ORIGINS must contain one dashboard origin",
);
const dashboardOrigin = trustedOrigins[0];
assert.ok(postgresUrl !== undefined, "RECEIPT_APPROVAL_PG_URL is required");
assert.ok(process.env.BETTER_AUTH_SECRET !== undefined, "BETTER_AUTH_SECRET is required");

const parsedPostgresUrl = new URL(postgresUrl);
assert.ok(
  parsedPostgresUrl.protocol === "postgres:" || parsedPostgresUrl.protocol === "postgresql:",
  "Receipt approval seed requires PostgreSQL",
);
assert.ok(
  ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsedPostgresUrl.hostname),
  "Receipt approval seed is restricted to loopback PostgreSQL",
);
assert.equal(
  decodeURIComponent(parsedPostgresUrl.pathname.slice(1)),
  "receipt_proof",
  "Receipt approval seed requires the disposable receipt_proof database",
);
const parsedDashboardOrigin = new URL(dashboardOrigin);
assert.ok(
  parsedDashboardOrigin.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsedDashboardOrigin.hostname),
  "Receipt approval seed requires a loopback HTTP Better Auth origin",
);

export const receiptApprovalPersonas = {
  ownerA: {
    fixtureLabel: "owner-a-department-a-payment-authority",
    personId: "owner-a",
    firstName: "Oda",
    lastName: "Eier A",
    email: "owner-a.receipt.0037@example.invalid",
    password: "receipt-approval-0037-password",
  },
  ownerB: {
    fixtureLabel: "owner-b-department-b-payment-authority",
    personId: "owner-b",
    firstName: "Bård",
    lastName: "Eier B",
    email: "owner-b.receipt.0037@example.invalid",
    password: "receipt-approval-0037-password",
  },
  departmentA: {
    fixtureLabel: "approver-a-active-department-a-grant",
    personId: "approver-a",
    firstName: "Ada",
    lastName: "Godkjenner A",
    email: "approver-a.receipt.0037@example.invalid",
    password: "receipt-approval-0037-password",
  },
  departmentB: {
    fixtureLabel: "approver-b-active-department-b-grant",
    personId: "approver-b",
    firstName: "Bente",
    lastName: "Godkjenner B",
    email: "approver-b.receipt.0037@example.invalid",
    password: "receipt-approval-0037-password",
  },
  global: {
    fixtureLabel: "approver-global-active-global-receipt-grant",
    personId: "approver-global",
    firstName: "Guro",
    lastName: "Godkjenner Global",
    email: "approver-global.receipt.0037@example.invalid",
    password: "receipt-approval-0037-password",
  },
  inactive: {
    fixtureLabel: "approver-inactive-ended-department-a-membership",
    personId: "approver-inactive",
    firstName: "Ingrid",
    lastName: "Inaktiv",
    email: "approver-inactive.receipt.0037@example.invalid",
    password: "receipt-approval-0037-password",
  },
  noneScope: {
    fixtureLabel: "approver-none-active-without-receipt-grant",
    personId: "approver-none",
    firstName: "Nils",
    lastName: "Uten Godkjenning",
    email: "approver-none.receipt.0037@example.invalid",
    password: "receipt-approval-0037-password",
  },
};

export const receiptApprovalDepartments = {
  departmentA: "department-a",
  departmentB: "department-b",
};

const persons = Object.values(receiptApprovalPersonas);
const identityPersons = persons.map(({ fixtureLabel: _, ...person }) => person);
const personIds = persons.map(({ personId }) => personId);
const departmentIds = Object.values(receiptApprovalDepartments);
const teamIds = ["receipt-approval-team-a-0037", "receipt-approval-team-b-0037"];

const identitySeed = spawnSync("bun", ["run", "identity:seed"], {
  cwd: databaseRoot,
  env: {
    ...process.env,
    IDENTITY_SEED_PG_URL: postgresUrl,
    IDENTITY_SEED_PERSONS: JSON.stringify(identityPersons),
    NATIVE_IDENTITY_DEPLOYMENT: "local",
    NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin]),
  },
  encoding: "utf8",
});
assert.equal(
  identitySeed.status,
  0,
  `identity:seed failed:\n${identitySeed.stdout}\n${identitySeed.stderr}`,
);

const pool = new Pool({
  connectionString: postgresUrl,
  options: "-c search_path=auth,public",
  max: 1,
  application_name: "native-receipt-approval-seed-0037",
});
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO organization_departments (
      department_id, name, short_name, email, city, active, revision
    ) VALUES
      ($1, 'Receiptavdeling A', 'RA', 'receipt-a.0037@example.invalid', 'Trondheim', TRUE, 0),
      ($2, 'Receiptavdeling B', 'RB', 'receipt-b.0037@example.invalid', 'Oslo', TRUE, 0)`,
    departmentIds,
  );
  await client.query(
    `INSERT INTO organization_teams (team_id, department_id, name, active, revision)
     VALUES
       ($1, $3, 'Receiptteam A', TRUE, 0),
       ($2, $4, 'Receiptteam B', TRUE, 0)`,
    [teamIds[0], teamIds[1], departmentIds[0], departmentIds[1]],
  );
  await client.query(
    `INSERT INTO person_contact_profiles (person_id, email, phone, revision)
     SELECT seed.person_id, seed.email, seed.phone, 0
     FROM unnest($1::text[], $2::text[], $3::text[]) AS seed(person_id, email, phone)`,
    [
      personIds,
      persons.map(({ email }) => email),
      persons.map((_, index) => `+47 900 37 0${index}`),
    ],
  );
  await client.query(
    `INSERT INTO organization_memberships (
      membership_id, person_id, team_id, deleted_team_name, start_at, end_at,
      position_id, is_team_leader, is_suspended, revision
    ) VALUES
      ('receipt-membership-owner-a-0037', $1, $8, NULL, '2020-01-01T00:00:00Z', NULL, 'member', FALSE, FALSE, 0),
      ('receipt-membership-owner-b-0037', $2, $9, NULL, '2020-01-01T00:00:00Z', NULL, 'member', FALSE, FALSE, 0),
      ('receipt-membership-approver-a-0037', $3, $8, NULL, '2020-01-01T00:00:00Z', NULL, 'member', FALSE, FALSE, 0),
      ('receipt-membership-approver-b-0037', $4, $9, NULL, '2020-01-01T00:00:00Z', NULL, 'member', FALSE, FALSE, 0),
      ('receipt-membership-approver-global-0037', $5, $8, NULL, '2020-01-01T00:00:00Z', NULL, 'member', FALSE, FALSE, 0),
      ('receipt-membership-approver-inactive-0037', $6, $8, NULL, '2020-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 'member', FALSE, FALSE, 0),
      ('receipt-membership-approver-none-0037', $7, $8, NULL, '2020-01-01T00:00:00Z', NULL, 'member', FALSE, FALSE, 0)`,
    [...personIds, teamIds[0], teamIds[1]],
  );
  await client.query(
    `INSERT INTO economy_payment_authorities (
      payment_authority_id, person_id, department_id, payment_account_ciphertext,
      start_at, end_at, revision
    ) VALUES
      ('receipt-payment-owner-a-0037', $1, $3, 'ciphertext-owner-a-0037', '2020-01-01T00:00:00Z', NULL, 0),
      ('receipt-payment-owner-b-0037', $2, $4, 'ciphertext-owner-b-0037', '2020-01-01T00:00:00Z', NULL, 0)`,
    [
      receiptApprovalPersonas.ownerA.personId,
      receiptApprovalPersonas.ownerB.personId,
      receiptApprovalDepartments.departmentA,
      receiptApprovalDepartments.departmentB,
    ],
  );
  await client.query(
    `INSERT INTO economy_receipt_approval_grants (
      approval_grant_id, person_id, scope, department_id, start_at, end_at, revision
    ) VALUES
      ('receipt-approval-a-0037', $1, 'Department', $5, '2020-01-01T00:00:00Z', NULL, 0),
      ('receipt-approval-b-0037', $2, 'Department', $6, '2020-01-01T00:00:00Z', NULL, 0),
      ('receipt-approval-global-0037', $3, 'Global', NULL, '2020-01-01T00:00:00Z', NULL, 0),
      ('receipt-approval-inactive-0037', $4, 'Department', $5, '2020-01-01T00:00:00Z', NULL, 0)`,
    [
      receiptApprovalPersonas.departmentA.personId,
      receiptApprovalPersonas.departmentB.personId,
      receiptApprovalPersonas.global.personId,
      receiptApprovalPersonas.inactive.personId,
      receiptApprovalDepartments.departmentA,
      receiptApprovalDepartments.departmentB,
    ],
  );

  const counts = await client.query(
    `SELECT json_build_object(
      'identityUsers', (SELECT count(*)::int FROM auth."user"),
      'credentialAccounts', (SELECT count(*)::int FROM auth.account WHERE "providerId" = 'credential'),
      'personProfiles', (SELECT count(*)::int FROM public.person_profiles),
      'contactProfiles', (SELECT count(*)::int FROM public.person_contact_profiles),
      'departments', (SELECT count(*)::int FROM public.organization_departments),
      'teams', (SELECT count(*)::int FROM public.organization_teams),
      'organizationMemberships', (SELECT count(*)::int FROM public.organization_memberships),
      'activeMemberships', (
        SELECT count(*)::int FROM public.organization_memberships
        WHERE start_at <= now() AND (end_at IS NULL OR end_at > now()) AND NOT is_suspended
      ),
      'inactiveMemberships', (
        SELECT count(*)::int FROM public.organization_memberships
        WHERE end_at <= now() OR is_suspended
      ),
      'organizationGlobalAdministratorGrants', (
        SELECT count(*)::int FROM public.organization_global_administrator_grants
      ),
      'paymentAuthorities', (SELECT count(*)::int FROM public.economy_payment_authorities),
      'receiptApprovalGrants', (SELECT count(*)::int FROM public.economy_receipt_approval_grants)
    ) AS evidence`,
  );
  const fixtureCounts = counts.rows[0]?.evidence;
  assert.deepEqual(fixtureCounts, {
    identityUsers: 7,
    credentialAccounts: 7,
    personProfiles: 7,
    contactProfiles: 7,
    departments: 2,
    teams: 2,
    organizationMemberships: 7,
    activeMemberships: 6,
    inactiveMemberships: 1,
    organizationGlobalAdministratorGrants: 0,
    paymentAuthorities: 2,
    receiptApprovalGrants: 4,
  });
  await client.query("COMMIT");
  process.stdout.write(
    `${JSON.stringify({
      personas: persons.map(({ fixtureLabel, personId, email }) => ({
        fixtureLabel,
        personId,
        email,
      })),
      departments: receiptApprovalDepartments,
      fixtureCounts,
    })}\n`,
  );
} catch (cause) {
  await client.query("ROLLBACK");
  throw cause;
} finally {
  client.release();
  await pool.end();
}

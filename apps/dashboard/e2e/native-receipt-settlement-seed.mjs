import { Predicate } from "effect";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const databaseRoot = fileURLToPath(new URL("../../../packages/database/", import.meta.url));

const databaseRequire = createRequire(
  new URL("../../../packages/database/package.json", import.meta.url),
);

const { Pool } = databaseRequire("pg");

const postgresUrl = process.env.RECEIPT_SETTLEMENT_PG_URL;

const trustedOrigins = JSON.parse(process.env.NATIVE_IDENTITY_TRUSTED_ORIGINS ?? "null");

assert.ok(postgresUrl !== undefined, "RECEIPT_SETTLEMENT_PG_URL is required");

assert.ok(
  Array.isArray(trustedOrigins) && trustedOrigins.length === 1 && Predicate.isString(trustedOrigins[0]),
  "NATIVE_IDENTITY_TRUSTED_ORIGINS must contain exactly one dashboard origin",
);

assert.ok(process.env.BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET is required");

const parsedPostgresUrl = new URL(postgresUrl);

assert.ok(
  parsedPostgresUrl.protocol === "postgres:" || parsedPostgresUrl.protocol === "postgresql:",
  "Settlement fixture requires PostgreSQL",
);

assert.ok(
  ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsedPostgresUrl.hostname),
  "Settlement fixture is restricted to loopback PostgreSQL",
);

assert.equal(
  decodeURIComponent(parsedPostgresUrl.pathname.slice(1)),
  "receipt_proof",
  "Settlement fixture requires the disposable receipt_proof database",
);

const dashboardOrigin = new URL(trustedOrigins[0]);

assert.ok(
  dashboardOrigin.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(dashboardOrigin.hostname),
  "Settlement fixture requires a loopback Better Auth origin",
);

const password = "receipt-settlement-0114-password";

const paymentDestination = "synthetic-payment-destination-0114-only";

const paymentDestinationFingerprint = createHash("sha256")
  .update(paymentDestination, "utf8")
  .digest("hex");

export const receiptSettlementPersonas = {
  owner: {
    fixtureLabel: "settlement-owner-department-a-payment-authority",
    personId: "settlement-owner-0114",
    firstName: "Oda",
    lastName: "Eier",
    email: "settlement.owner.0114@example.invalid",
    password,
  },
  approver: {
    fixtureLabel: "settlement-approver-department-a-approval-only",
    personId: "settlement-approver-0114",
    firstName: "Ada",
    lastName: "Godkjenner",
    email: "settlement.approver.0114@example.invalid",
    password,
  },
  settler: {
    fixtureLabel: "settlement-current-department-a-grant",
    personId: "settlement-settler-0114",
    firstName: "Siv",
    lastName: "Oppgjør",
    email: "settlement.settler.0114@example.invalid",
    password,
  },
  ordinary: {
    fixtureLabel: "settlement-ordinary-member-without-grant",
    personId: "settlement-ordinary-0114",
    firstName: "Ola",
    lastName: "Medlem",
    email: "settlement.ordinary.0114@example.invalid",
    password,
  },
  inactiveSettler: {
    fixtureLabel: "settlement-inactive-department-a-grantee",
    personId: "settlement-inactive-0114",
    firstName: "Inga",
    lastName: "Inaktiv",
    email: "settlement.inactive.0114@example.invalid",
    password,
  },
  expiredSettler: {
    fixtureLabel: "settlement-expired-department-a-grantee",
    personId: "settlement-expired-0114",
    firstName: "Eva",
    lastName: "Utløpt",
    email: "settlement.expired.0114@example.invalid",
    password,
  },
  foreignSettler: {
    fixtureLabel: "settlement-current-wrong-department-grantee",
    personId: "settlement-foreign-0114",
    firstName: "Frida",
    lastName: "Feilavdeling",
    email: "settlement.foreign.0114@example.invalid",
    password,
  },
};

export const receiptSettlementDepartments = {
  departmentA: "settlement-department-a-0114",
  departmentB: "settlement-department-b-0114",
};

export const seededSettlementReceiptIds = {
  pending: "settlement-pending-0114",
  rejected: "settlement-rejected-0114",
  withdrawn: "settlement-withdrawn-0114",
  alreadySettled: "settlement-already-settled-0114",
  duplicateExternalReference: "settlement-duplicate-reference-0114",
  concurrent: "settlement-concurrent-0114",
  deliveryRetry: "settlement-delivery-retry-0114",
};

const personas = Object.values(receiptSettlementPersonas);

const identityPersons = personas.map(({ fixtureLabel: _, ...persona }) => persona);

const personIds = personas.map(({ personId }) => personId);

const teamIds = ["settlement-team-a-0114", "settlement-team-b-0114"];

const receiptIds = Object.values(seededSettlementReceiptIds);

const identitySeed = spawnSync("bun", ["run", "identity:seed"], {
  cwd: databaseRoot,
  env: {
    ...process.env,
    IDENTITY_SEED_PG_URL: postgresUrl,
    IDENTITY_SEED_PERSONS: JSON.stringify(identityPersons),
    NATIVE_IDENTITY_DEPLOYMENT: "local",
    NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin.origin]),
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
  application_name: "native-receipt-settlement-seed-0114",
});

const client = await pool.connect();

try {
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO organization_departments (
      department_id, name, short_name, email, city, active, revision
    ) VALUES
      ($1, 'Oppgjørsavdeling A', 'OA', 'settlement-a.0114@example.invalid', 'Trondheim', TRUE, 0),
      ($2, 'Oppgjørsavdeling B', 'OB', 'settlement-b.0114@example.invalid', 'Oslo', TRUE, 0)`,
    [receiptSettlementDepartments.departmentA, receiptSettlementDepartments.departmentB],
  );
  await client.query(
    `INSERT INTO organization_teams (team_id, department_id, name, active, revision)
     VALUES
       ($1, $3, 'Oppgjørsteam A', TRUE, 0),
       ($2, $4, 'Oppgjørsteam B', TRUE, 0)`,
    [
      teamIds[0],
      teamIds[1],
      receiptSettlementDepartments.departmentA,
      receiptSettlementDepartments.departmentB,
    ],
  );
  await client.query(
    `INSERT INTO person_contact_profiles (person_id, email, phone, revision)
     SELECT seed.person_id, seed.email, seed.phone, 0
     FROM unnest($1::text[], $2::text[], $3::text[]) AS seed(person_id, email, phone)`,
    [
      personIds,
      personas.map(({ email }) => email),
      personas.map((_, index) => `+47 911 14 0${index}`),
    ],
  );
  await client.query(
    `INSERT INTO organization_memberships (
      membership_id, person_id, team_id, deleted_team_name, start_at, end_at,
      position_id, is_team_leader, is_suspended, revision
    ) VALUES
      ('settlement-membership-owner-0114', $1, $8, NULL, '2020-01-01T00:00:00Z', NULL, 'member', FALSE, FALSE, 0),
      ('settlement-membership-approver-0114', $2, $8, NULL, '2020-01-01T00:00:00Z', NULL, 'member', FALSE, FALSE, 0),
      ('settlement-membership-settler-0114', $3, $8, NULL, '2020-01-01T00:00:00Z', NULL, 'member', FALSE, FALSE, 0),
      ('settlement-membership-ordinary-0114', $4, $8, NULL, '2020-01-01T00:00:00Z', NULL, 'member', FALSE, FALSE, 0),
      ('settlement-membership-inactive-0114', $5, $8, NULL, '2020-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 'member', FALSE, FALSE, 0),
      ('settlement-membership-expired-0114', $6, $8, NULL, '2020-01-01T00:00:00Z', NULL, 'member', FALSE, FALSE, 0),
      ('settlement-membership-foreign-0114', $7, $9, NULL, '2020-01-01T00:00:00Z', NULL, 'member', FALSE, FALSE, 0)`,
    [...personIds, teamIds[0], teamIds[1]],
  );
  await client.query(
    `INSERT INTO economy_payment_authorities (
      payment_authority_id, person_id, department_id, payment_account_ciphertext,
      start_at, end_at, revision
    ) VALUES
      ('settlement-owner-payment-authority-0114', $1, $2, $3, '2020-01-01T00:00:00Z', NULL, 0)`,
    [
      receiptSettlementPersonas.owner.personId,
      receiptSettlementDepartments.departmentA,
      paymentDestination,
    ],
  );
  await client.query(
    `INSERT INTO economy_receipt_approval_grants (
      approval_grant_id, person_id, scope, department_id, start_at, end_at, revision
    ) VALUES
      ('settlement-approval-grant-0114', $1, 'Department', $2, '2020-01-01T00:00:00Z', NULL, 0)`,
    [receiptSettlementPersonas.approver.personId, receiptSettlementDepartments.departmentA],
  );
  await client.query(
    `INSERT INTO economy_receipt_settlement_grants (
      settlement_grant_id, person_id, scope, department_id, start_at, end_at, revision
    ) VALUES
      ('settlement-active-grant-0114', $1, 'Department', $5, '2020-01-01T00:00:00Z', NULL, 0),
      ('settlement-inactive-grant-0114', $2, 'Department', $5, '2020-01-01T00:00:00Z', NULL, 0),
      ('settlement-expired-grant-0114', $3, 'Department', $5, '2020-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 0),
      ('settlement-foreign-grant-0114', $4, 'Department', $6, '2020-01-01T00:00:00Z', NULL, 0)`,
    [
      receiptSettlementPersonas.settler.personId,
      receiptSettlementPersonas.inactiveSettler.personId,
      receiptSettlementPersonas.expiredSettler.personId,
      receiptSettlementPersonas.foreignSettler.personId,
      receiptSettlementDepartments.departmentA,
      receiptSettlementDepartments.departmentB,
    ],
  );
  await client.query(
    `INSERT INTO economy_receipts (
      receipt_id, visual_id, owner_person_id, department_id, amount_ore, currency,
      description, receipt_date, submitted_at, status, approved_at,
      payment_account_ciphertext, file_ref, file_object_key, file_content_type,
      file_byte_length, file_sha256, revision
    ) VALUES
      ($1, 'OPP-0114-PENDING', $8, $9, 10100, 'NOK', 'Pending settlement source', '2026-09-01', '2026-09-02T09:00:00Z', 'Pending', NULL, $10, 'seed/$1', 'seed/$1.pdf', 'application/pdf', 1, repeat('a', 64), 0),
      ($2, 'OPP-0114-REJECTED', $8, $9, 10200, 'NOK', 'Rejected settlement source', '2026-09-01', '2026-09-02T09:00:00Z', 'Rejected', NULL, $10, 'seed/$2', 'seed/$2.pdf', 'application/pdf', 1, repeat('b', 64), 1),
      ($3, 'OPP-0114-WITHDRAWN', $8, $9, 10300, 'NOK', 'Withdrawn settlement source', '2026-09-01', '2026-09-02T09:00:00Z', 'Withdrawn', NULL, $10, 'seed/$3', 'seed/$3.pdf', 'application/pdf', 1, repeat('c', 64), 1),
      ($4, 'OPP-0114-SETTLED', $8, $9, 10400, 'NOK', 'Already settled source', '2026-09-01', '2026-09-02T09:00:00Z', 'Approved', '2026-09-03T09:00:00Z', $10, 'seed/$4', 'seed/$4.pdf', 'application/pdf', 1, repeat('d', 64), 2),
      ($5, 'OPP-0114-DUPLICATE', $8, $9, 10500, 'NOK', 'Duplicate external reference source', '2026-09-01', '2026-09-02T09:00:00Z', 'Approved', '2026-09-03T09:00:00Z', $10, 'seed/$5', 'seed/$5.pdf', 'application/pdf', 1, repeat('e', 64), 1),
      ($6, 'OPP-0114-CONCURRENT', $8, $9, 10600, 'NOK', 'Concurrent settlement source', '2026-09-01', '2026-09-02T09:00:00Z', 'Approved', '2026-09-03T09:00:00Z', $10, 'seed/$6', 'seed/$6.pdf', 'application/pdf', 1, repeat('f', 64), 1),
      ($7, 'OPP-0114-DELIVERY', $8, $9, 10700, 'NOK', 'Delivery retry settlement source', '2026-09-01', '2026-09-02T09:00:00Z', 'Approved', '2026-09-03T09:00:00Z', $10, 'seed/$7', 'seed/$7.pdf', 'application/pdf', 1, repeat('0', 64), 1)`,
    [
      receiptIds[0],
      receiptIds[1],
      receiptIds[2],
      receiptIds[3],
      receiptIds[4],
      receiptIds[5],
      receiptIds[6],
      receiptSettlementPersonas.owner.personId,
      receiptSettlementDepartments.departmentA,
      paymentDestination,
    ],
  );
  await client.query(
    `INSERT INTO economy_receipt_settlements (
      settlement_id, receipt_id, amount_ore, currency, payment_destination_fingerprint,
      external_authority, external_reference, settled_at, recorded_by_person_id,
      recorded_at, receipt_revision
    ) VALUES (
      'settlement-existing-evidence-0114', $1, 10400, 'NOK', $2,
      'Existing authority', 'existing-reference-0114', '2026-09-04T09:00:00Z', $3,
      '2026-09-04T10:00:00Z', 2
    )`,
    [
      seededSettlementReceiptIds.alreadySettled,
      paymentDestinationFingerprint,
      receiptSettlementPersonas.settler.personId,
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
      'memberships', (SELECT count(*)::int FROM public.organization_memberships),
      'activeMemberships', (SELECT count(*)::int FROM public.organization_memberships WHERE start_at <= now() AND (end_at IS NULL OR end_at > now()) AND NOT is_suspended),
      'paymentAuthorities', (SELECT count(*)::int FROM public.economy_payment_authorities),
      'approvalGrants', (SELECT count(*)::int FROM public.economy_receipt_approval_grants),
      'settlementGrants', (SELECT count(*)::int FROM public.economy_receipt_settlement_grants),
      'seededReceipts', (SELECT count(*)::int FROM public.economy_receipts WHERE receipt_id = ANY($1::text[])),
      'seededSettlements', (SELECT count(*)::int FROM public.economy_receipt_settlements WHERE receipt_id = $2)
    ) AS evidence`,
    [receiptIds, seededSettlementReceiptIds.alreadySettled],
  );

  const fixtureCounts = counts.rows[0]?.evidence;
  assert.deepEqual(fixtureCounts, {
    identityUsers: 7,
    credentialAccounts: 7,
    personProfiles: 7,
    contactProfiles: 7,
    departments: 2,
    teams: 2,
    memberships: 7,
    activeMemberships: 6,
    paymentAuthorities: 1,
    approvalGrants: 1,
    settlementGrants: 4,
    seededReceipts: 7,
    seededSettlements: 1,
  });
  await client.query("COMMIT");
  process.stdout.write(
    `${JSON.stringify({
      personas: personas.map(({ fixtureLabel, personId, email }) => ({ fixtureLabel, personId, email })),
      departments: receiptSettlementDepartments,
      seededReceiptIds: seededSettlementReceiptIds,
      paymentDestinationFingerprint,
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

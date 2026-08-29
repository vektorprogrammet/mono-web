import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const databaseRoot = join(repositoryRoot, "packages", "database");
const require = createRequire(join(repositoryRoot, "packages/database/package.json"));
const { Pool } = require("pg");

const postgresUrl = process.env.IDENTITY_EVIDENCE_PG_URL;
const password = process.env.IDENTITY_EVIDENCE_PASSWORD;
assert.equal(typeof postgresUrl, "string", "IDENTITY_EVIDENCE_PG_URL is required");
assert.equal(typeof password, "string", "IDENTITY_EVIDENCE_PASSWORD is required");
assert.ok(
  password.length >= 12,
  "IDENTITY_EVIDENCE_PASSWORD must satisfy Better Auth minimum length",
);
const parsedUrl = new URL(postgresUrl);
assert.ok(["postgres:", "postgresql:"].includes(parsedUrl.protocol));
assert.ok(["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsedUrl.hostname));

export const identityEvidencePersona = {
  personId: "journey-0065-admin",
  firstName: "Journey",
  lastName: "Identity",
  email: "admin.identity-0065@example.invalid",
};
const grantId = "grant-journey-0065-admin";
const phone = "+47 900 00 065";
const orthogonalPerson = {
  personId: "identity-0056-orthogonal-person",
  firstName: "Other",
  lastName: "Capability",
};
const authzFixture = {
  tagId: "identity-0056-orthogonal-tag",
  assignmentId: "identity-0056-orthogonal-assignment",
  activeRuleId: "identity-0056-active-other-person-rule",
  expiredRuleId: "identity-0056-expired-journey-person-rule",
};
const activeStartAt = "2020-01-01T00:00:00.000Z";
const expiredStartAt = "2019-01-01T00:00:00.000Z";
const expiredEndAt = "2020-01-01T00:00:00.000Z";

const normalizeRows = (rows) =>
  rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value instanceof Date ? value.toISOString() : value,
      ]),
    ),
  );

const readAuthSchemaState = async (observer) => {
  const users = await observer.query(
    `SELECT id, name, email, "emailVerified", image, "createdAt", "updatedAt"
     FROM auth."user" ORDER BY id`,
  );
  const accounts = await observer.query(
    `SELECT id, "accountId", "providerId", "userId", issuer, "createdAt", "updatedAt",
       ("password" IS NOT NULL) AS "passwordPresent",
       ("accessToken" IS NOT NULL OR "refreshToken" IS NOT NULL OR "idToken" IS NOT NULL)
         AS "providerSecretPresent"
     FROM auth.account ORDER BY id`,
  );
  const sessions = await observer.query(
    `SELECT count(*)::integer AS total,
       count(*) FILTER (WHERE "expiresAt" > now())::integer AS live
     FROM auth.session`,
  );
  const verification = await observer.query(
    `SELECT count(*)::integer AS total FROM auth.verification`,
  );
  return {
    users: normalizeRows(users.rows),
    accounts: normalizeRows(accounts.rows),
    sessions: {
      total: Number(sessions.rows[0].total),
      live: Number(sessions.rows[0].live),
    },
    verification: { total: Number(verification.rows[0].total) },
  };
};

const readPublicAuthzState = async (observer) => {
  const tags = await observer.query(
    `SELECT tag_id AS "tagId", name, revision
     FROM public.authz_tags ORDER BY tag_id`,
  );
  const assignments = await observer.query(
    `SELECT assignment_id AS "assignmentId", tag_id AS "tagId", person_id AS "personId",
       start_at AS "startAt", end_at AS "endAt", revision
     FROM public.authz_tag_assignments ORDER BY assignment_id`,
  );
  const rules = await observer.query(
    `SELECT rule_id AS "ruleId", capability_id AS "capabilityId",
       effect_kind AS "effectKind", subject_kind AS "subjectKind",
       subject_person_id AS "subjectPersonId", subject_tag_id AS "subjectTagId",
       scope, department_id AS "departmentId", params,
       start_at AS "startAt", end_at AS "endAt", revision
     FROM public.authz_rules ORDER BY rule_id`,
  );
  return {
    tags: normalizeRows(tags.rows),
    assignments: normalizeRows(assignments.rows),
    rules: normalizeRows(rules.rows),
  };
};

const expectedPublicAuthzState = {
  tags: [{ tagId: authzFixture.tagId, name: "Identity orthogonality 0056", revision: 0 }],
  assignments: [
    {
      assignmentId: authzFixture.assignmentId,
      tagId: authzFixture.tagId,
      personId: orthogonalPerson.personId,
      startAt: activeStartAt,
      endAt: null,
      revision: 0,
    },
  ],
  rules: [
    {
      ruleId: authzFixture.activeRuleId,
      capabilityId: "approveReceipt",
      effectKind: "delegate",
      subjectKind: "Tag",
      subjectPersonId: null,
      subjectTagId: authzFixture.tagId,
      scope: "Global",
      departmentId: null,
      params: { slot: "EconomyGlobalReceiptApprovalGrant" },
      startAt: activeStartAt,
      endAt: null,
      revision: 0,
    },
    {
      ruleId: authzFixture.expiredRuleId,
      capabilityId: "submitReceipt",
      effectKind: "delegate",
      subjectKind: "Person",
      subjectPersonId: identityEvidencePersona.personId,
      subjectTagId: null,
      scope: "Global",
      departmentId: null,
      params: {
        slot: "EconomyPaymentAuthority",
        paymentAccountCiphertext: "synthetic-only-no-secret",
      },
      startAt: expiredStartAt,
      endAt: expiredEndAt,
      revision: 0,
    },
  ],
};

const seed = spawnSync("bun", ["run", "identity:seed"], {
  cwd: databaseRoot,
  env: {
    ...process.env,
    IDENTITY_SEED_PG_URL: postgresUrl,
    IDENTITY_SEED_PERSONS: JSON.stringify([{ ...identityEvidencePersona, password }]),
  },
  encoding: "utf8",
});
assert.equal(seed.status, 0, `identity:seed failed (${seed.status ?? "signal"})`);

const observer = new Pool({
  connectionString: postgresUrl,
  options: "-c search_path=public",
  max: 1,
  application_name: "identity-browser-0065-seed-observer",
});
try {
  const authSchemaBeforePublicAuthz = await readAuthSchemaState(observer);
  await observer.query("BEGIN");
  await observer.query(
    `INSERT INTO public.person_contact_profiles (person_id, email, phone, revision)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (person_id) DO NOTHING`,
    [identityEvidencePersona.personId, identityEvidencePersona.email, phone],
  );
  await observer.query(
    `INSERT INTO public.organization_global_administrator_grants
      (grant_id, person_id, start_at, end_at, revision)
     VALUES ($1, $2, TIMESTAMPTZ '2026-01-01T00:00:00Z', NULL, 0)
     ON CONFLICT (grant_id) DO NOTHING`,
    [grantId, identityEvidencePersona.personId],
  );
  await observer.query(
    `INSERT INTO public.person_profiles (person_id, first_name, last_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (person_id) DO NOTHING`,
    [orthogonalPerson.personId, orthogonalPerson.firstName, orthogonalPerson.lastName],
  );
  await observer.query(
    `INSERT INTO public.authz_tags (tag_id, name, revision)
     VALUES ($1, 'Identity orthogonality 0056', 0)
     ON CONFLICT (tag_id) DO NOTHING`,
    [authzFixture.tagId],
  );
  await observer.query(
    `INSERT INTO public.authz_tag_assignments
      (assignment_id, tag_id, person_id, start_at, end_at, revision)
     VALUES ($1, $2, $3, $4::timestamptz, NULL, 0)
     ON CONFLICT (assignment_id) DO NOTHING`,
    [
      authzFixture.assignmentId,
      authzFixture.tagId,
      orthogonalPerson.personId,
      activeStartAt,
    ],
  );
  await observer.query(
    `INSERT INTO public.authz_rules (
       rule_id, capability_id, effect_kind, subject_kind, subject_person_id,
       subject_tag_id, scope, department_id, params, start_at, end_at, revision
     ) VALUES
       (
         $1, 'approveReceipt', 'delegate', 'Tag', NULL, $2, 'Global', NULL,
         '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb,
         $3::timestamptz, NULL, 0
       ),
       (
         $4, 'submitReceipt', 'delegate', 'Person', $5, NULL, 'Global', NULL,
         '{"slot":"EconomyPaymentAuthority","paymentAccountCiphertext":"synthetic-only-no-secret"}'::jsonb,
         $6::timestamptz, $7::timestamptz, 0
       )
     ON CONFLICT (rule_id) DO NOTHING`,
    [
      authzFixture.activeRuleId,
      authzFixture.tagId,
      activeStartAt,
      authzFixture.expiredRuleId,
      identityEvidencePersona.personId,
      expiredStartAt,
      expiredEndAt,
    ],
  );
  await observer.query("COMMIT");

  const authSchemaAfterPublicAuthz = await readAuthSchemaState(observer);
  assert.deepEqual(authSchemaAfterPublicAuthz, authSchemaBeforePublicAuthz);
  const publicAuthz = await readPublicAuthzState(observer);
  assert.deepEqual(publicAuthz, expectedPublicAuthzState);

  const result = await observer.query(
    `SELECT
       (SELECT count(*) FROM public.person_profiles WHERE person_id = $1) AS profiles,
       (SELECT count(*) FROM public.person_profiles WHERE person_id = $2) AS authz_subjects,
       (SELECT count(*) FROM public.person_contact_profiles WHERE person_id = $1) AS contacts,
       (SELECT count(*) FROM public.organization_global_administrator_grants
          WHERE person_id = $1 AND start_at <= now() AND (end_at IS NULL OR now() < end_at)) AS grants,
       (SELECT count(*) FROM auth."user" WHERE id = $1) AS users,
       (SELECT count(*) FROM auth.account WHERE "userId" = $1 AND "providerId" = 'credential') AS accounts,
       (SELECT count(*) FROM public.vektorprogrammet_schema_migrations
          WHERE migration_id = 15 AND name = 'native-identity-better-auth') AS identity_migration,
       (SELECT count(*) FROM public.vektorprogrammet_schema_migrations
          WHERE migration_id = 23 AND name = 'declarative-authorization-rules') AS authz_migration,
       (SELECT count(*) FROM public.vektorprogrammet_schema_migrations) AS applied_migrations`,
    [identityEvidencePersona.personId, orthogonalPerson.personId],
  );
  const row = result.rows[0];
  assert.equal(Number(row.profiles), 1);
  assert.equal(Number(row.authz_subjects), 1);
  assert.equal(Number(row.contacts), 1);
  assert.equal(Number(row.grants), 1);
  assert.equal(Number(row.users), 1);
  assert.equal(Number(row.accounts), 1);
  assert.equal(Number(row.identity_migration), 1);
  assert.equal(Number(row.authz_migration), 1);
  assert.ok(Number(row.applied_migrations) >= 23);

  process.stdout.write(
    `${JSON.stringify({
      personId: identityEvidencePersona.personId,
      emailClass: "synthetic.invalid",
      displayName: "Journey Identity",
      migrations: [
        { revision: 15, name: "native-identity-better-auth" },
        { revision: 23, name: "declarative-authorization-rules" },
      ],
      rows: {
        profiles: 1,
        contacts: 1,
        globalAdministratorGrants: 1,
        users: 1,
        credentialAccounts: 1,
      },
      authSchema: {
        beforePublicAuthz: authSchemaBeforePublicAuthz,
        afterPublicAuthz: authSchemaAfterPublicAuthz,
      },
      publicAuthz,
      account: "created-or-existing",
    })}\n`,
  );
} catch (error) {
  await observer.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await observer.end();
}

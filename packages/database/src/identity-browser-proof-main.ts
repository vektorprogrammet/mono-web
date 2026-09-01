import assert from "node:assert/strict";
import { Effect, Redacted } from "effect";
import { Pool } from "pg";
import { Database } from "@vektorprogrammet/domain/database";
import { DatabaseLive } from "./layers.js";

const personId = "journey-0065-admin";
const identityMigrationId = 15;
const authTables = [
  "account",
  "identity_security_audit",
  "session",
  "user",
  "verification",
] as const;
const authzTables = ["authz_rules", "authz_tag_assignments", "authz_tags"] as const;
const orthogonalPersonId = "identity-0056-orthogonal-person";
const activeRuleId = "identity-0056-active-other-person-rule";
const expiredRuleId = "identity-0056-expired-journey-person-rule";

const readBaseline = (name: string): unknown => {
  const raw = process.env[name];
  assert.ok(raw !== undefined && raw.length > 0, `${name} is required`);
  const decoded: unknown = JSON.parse(raw);
  return decoded;
};

const normalizeRows = (
  rows: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> =>
  rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value instanceof Date ? value.toISOString() : value,
      ]),
    ),
  );

const readAuthSchemaState = async (observer: Pool) => {
  const users = await observer.query<Record<string, unknown>>(
    `SELECT id, name, email, "emailVerified", image, "createdAt", "updatedAt"
     FROM auth."user" ORDER BY id`,
  );
  const accounts = await observer.query<Record<string, unknown>>(
    `SELECT id, "accountId", "providerId", "userId", issuer, "createdAt", "updatedAt",
       ("password" IS NOT NULL) AS "passwordPresent",
       ("accessToken" IS NOT NULL OR "refreshToken" IS NOT NULL OR "idToken" IS NOT NULL)
         AS "providerSecretPresent"
     FROM auth.account ORDER BY id`,
  );
  const sessions = await observer.query<{ readonly total: number; readonly live: number }>(
    `SELECT count(*)::integer AS total,
       count(*) FILTER (WHERE "expiresAt" > now())::integer AS live
     FROM auth.session`,
  );
  const verification = await observer.query<{ readonly total: number }>(
    `SELECT count(*)::integer AS total FROM auth.verification`,
  );
  return {
    users: normalizeRows(users.rows),
    accounts: normalizeRows(accounts.rows),
    sessions: {
      total: Number(sessions.rows[0]?.total),
      live: Number(sessions.rows[0]?.live),
    },
    verification: { total: Number(verification.rows[0]?.total) },
  };
};

const readPublicAuthzState = async (observer: Pool) => {
  const tags = await observer.query<Record<string, unknown>>(
    `SELECT tag_id AS "tagId", name, revision
     FROM public.authz_tags ORDER BY tag_id`,
  );
  const assignments = await observer.query<Record<string, unknown>>(
    `SELECT assignment_id AS "assignmentId", tag_id AS "tagId", person_id AS "personId",
       start_at AS "startAt", end_at AS "endAt", revision
     FROM public.authz_tag_assignments ORDER BY assignment_id`,
  );
  const rules = await observer.query<Record<string, unknown>>(
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

const loopbackDatabase = (value: string): void => {
  const url = new URL(value);
  assert.ok(
    ["postgres:", "postgresql:"].includes(url.protocol),
    "DATABASE_URL must use PostgreSQL",
  );
  assert.ok(
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname),
    "proof requires loopback PostgreSQL",
  );
};

const runMigrations = (url: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* Database;
      yield* database.health;
      return database.schemaRevision;
    }).pipe(
      Effect.provide(
        DatabaseLive({
          url: Redacted.make(url),
          applicationName: "identity-browser-0065-proof-migration",
          maxConnections: 1,
        }),
      ),
    ),
  );

const run = async () => {
  const url = process.env.IDENTITY_EVIDENCE_PG_URL ?? process.env.DATABASE_URL;
  assert.ok(url !== undefined, "IDENTITY_EVIDENCE_PG_URL is required");
  const authSchemaBaseline = readBaseline("IDENTITY_EVIDENCE_AUTH_SCHEMA_BASELINE");
  const publicAuthzBaseline = readBaseline("IDENTITY_EVIDENCE_PUBLIC_AUTHZ_BASELINE");
  loopbackDatabase(url);
  // oxlint-disable-next-line effect/no-premature-execution -- runtime proof composes the migration observer
  const schemaRevision = await Effect.runPromise(runMigrations(url));
  const observer = new Pool({
    connectionString: url,
    options: "-c search_path=public",
    max: 1,
    application_name: "identity-browser-0056-proof-observer",
  });
  try {
    const migration = await observer.query(
      `SELECT migration_id AS "migrationId", name
       FROM public.vektorprogrammet_schema_migrations
       WHERE migration_id = $1`,
      [identityMigrationId],
    );
    assert.deepEqual(migration.rows, [{ migrationId: 15, name: "native-identity-better-auth" }]);
    const authzMigration = await observer.query(
      `SELECT migration_id AS "migrationId", name
       FROM public.vektorprogrammet_schema_migrations
       WHERE migration_id = 23`,
    );
    assert.deepEqual(authzMigration.rows, [
      { migrationId: 23, name: "declarative-authorization-rules" },
    ]);
    const auditMigration = await observer.query(
      `SELECT migration_id AS "migrationId", name
       FROM public.vektorprogrammet_schema_migrations
       WHERE migration_id = 24`,
    );
    assert.deepEqual(auditMigration.rows, [{ migrationId: 24, name: "identity-security-audit" }]);
    const tables = await observer.query<{ readonly tableName: string }>(
      `SELECT table_name AS "tableName" FROM information_schema.tables
       WHERE table_schema = 'auth' AND table_name = ANY($1::text[]) ORDER BY table_name`,
      [[...authTables]],
    );
    assert.deepEqual(
      tables.rows.map((row) => row.tableName),
      [...authTables],
    );
    const publicTables = await observer.query<{ readonly tableName: string }>(
      `SELECT table_name AS "tableName" FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name`,
      [[...authTables]],
    );
    assert.deepEqual(publicTables.rows, []);
    const publicAuthzTables = await observer.query<{ readonly tableName: string }>(
      `SELECT table_name AS "tableName" FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name`,
      [[...authzTables]],
    );
    assert.deepEqual(
      publicAuthzTables.rows.map((row) => row.tableName),
      [...authzTables],
    );
    const authAuthzTables = await observer.query<{ readonly tableName: string }>(
      `SELECT table_name AS "tableName" FROM information_schema.tables
       WHERE table_schema = 'auth' AND table_name = ANY($1::text[]) ORDER BY table_name`,
      [[...authzTables]],
    );
    assert.deepEqual(authAuthzTables.rows, []);
    const identityForeignKey = await observer.query(
      `SELECT 1 FROM pg_constraint c
       JOIN pg_class source ON source.oid = c.conrelid
       JOIN pg_namespace source_schema ON source_schema.oid = source.relnamespace
       JOIN pg_class target ON target.oid = c.confrelid
       JOIN pg_namespace target_schema ON target_schema.oid = target.relnamespace
       WHERE c.contype = 'f' AND source_schema.nspname = 'auth' AND source.relname = 'user'
         AND target_schema.nspname = 'public' AND target.relname = 'person_profiles'
         AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = source.oid AND attname = 'id')]::smallint[]`,
    );
    assert.equal(identityForeignKey.rowCount, 1);
    const facts = await observer.query(
      `SELECT
         (SELECT count(*) FROM public.person_profiles WHERE person_id = $1) AS profiles,
         (SELECT count(*) FROM public.person_contact_profiles WHERE person_id = $1) AS contacts,
         (SELECT count(*) FROM public.organization_global_administrator_grants
           WHERE person_id = $1 AND start_at <= now() AND (end_at IS NULL OR now() < end_at)) AS grants,
         (SELECT count(*) FROM auth."user" WHERE id = $1) AS users,
         (SELECT count(*) FROM auth.account WHERE "userId" = $1 AND "providerId" = 'credential') AS accounts,
         (SELECT count(*) FROM auth.session WHERE "userId" = $1) AS "sessionsTotal",
         (SELECT count(*) FROM auth.session WHERE "userId" = $1 AND "expiresAt" > now()) AS "sessionsLive"`,
      [personId],
    );
    const row = facts.rows[0];
    const counts = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, Number(value)]),
    );
    assert.deepEqual(counts, {
      profiles: 1,
      contacts: 1,
      grants: 1,
      users: 1,
      accounts: 1,
      sessionsTotal: 0,
      sessionsLive: 0,
    });
    const authSchemaState = await readAuthSchemaState(observer);
    assert.deepEqual(authSchemaState, authSchemaBaseline);
    const publicAuthz = await readPublicAuthzState(observer);
    assert.deepEqual(publicAuthz, publicAuthzBaseline);
    const auditRows = await observer.query<{
      readonly eventKind: string;
      readonly eventCount: string;
      readonly requestBindingValid: boolean;
      readonly detailsClosed: boolean;
      readonly subjectsLinked: boolean;
    }>(
      `SELECT
         event_kind AS "eventKind",
         count(*)::text AS "eventCount",
         bool_and(
           CASE
             WHEN event_kind IN (
               'account-provisioned-administratively',
               'session-provisioned-administratively'
             ) THEN request_correlation IS NULL
             ELSE request_correlation IS NOT NULL
           END
         ) AS "requestBindingValid",
         bool_and(
           details ? 'outcomeCode'
           AND details ? 'affectedSessionCount'
           AND details - 'outcomeCode' - 'affectedSessionCount' = '{}'::jsonb
         ) AS "detailsClosed",
         bool_and(
           subject_person_id IS NULL
           OR EXISTS (
             SELECT 1 FROM public.person_profiles
             WHERE person_id = subject_person_id
           )
         ) AS "subjectsLinked"
       FROM auth.identity_security_audit
       GROUP BY event_kind
       ORDER BY event_kind`,
    );
    const auditCounts = Object.fromEntries(
      auditRows.rows.map((event) => [event.eventKind, Number(event.eventCount)]),
    );
    assert.deepEqual(auditCounts, {
      "account-provisioned-administratively": 2,
      "session-revoked-all": 1,
      "session-revoked-one": 1,
      "session-revoked-others": 1,
      "sign-in-failure": 10,
      "sign-in-success": 7,
      "sign-out": 4,
      "sign-up-rejected": 1,
      "trusted-origin-csrf-rejected": 1,
    });
    assert.ok(
      auditRows.rows.every(
        ({ requestBindingValid, detailsClosed, subjectsLinked }) =>
          requestBindingValid && detailsClosed && subjectsLinked,
      ),
    );
    const firstAuditEvent = await observer.query<{ readonly eventId: string }>(
      `SELECT event_id AS "eventId"
       FROM auth.identity_security_audit
       ORDER BY occurred_at, event_id
       LIMIT 1`,
    );
    const eventId = firstAuditEvent.rows[0]?.eventId;
    assert.ok(eventId !== undefined);
    const updateRejected = await observer
      .query(`UPDATE auth.identity_security_audit SET details = details WHERE event_id = $1`, [
        eventId,
      ])
      .then(
        () => false,
        () => true,
      );
    const deleteRejected = await observer
      .query(`DELETE FROM auth.identity_security_audit WHERE event_id = $1`, [eventId])
      .then(
        () => false,
        () => true,
      );
    assert.equal(updateRejected, true);
    assert.equal(deleteRejected, true);
    const activityResult = await observer.query<{
      readonly observedAt: Date;
      readonly activeAssignments: string;
      readonly activeRules: string;
      readonly expiredRules: string;
      readonly activeOtherPersonRules: string;
      readonly expiredJourneyPersonRules: string;
    }>(
      `SELECT now() AS "observedAt",
         (SELECT count(*) FROM public.authz_tag_assignments
           WHERE start_at <= now() AND (end_at IS NULL OR now() < end_at))
           AS "activeAssignments",
         (SELECT count(*) FROM public.authz_rules
           WHERE start_at <= now() AND (end_at IS NULL OR now() < end_at))
           AS "activeRules",
         (SELECT count(*) FROM public.authz_rules
           WHERE end_at IS NOT NULL AND end_at <= now())
           AS "expiredRules",
         (SELECT count(*) FROM public.authz_rules AS rule
           JOIN public.authz_tag_assignments AS assignment
             ON rule.subject_kind = 'Tag' AND assignment.tag_id = rule.subject_tag_id
           WHERE rule.rule_id = $2 AND rule.capability_id = 'approveReceipt'
             AND assignment.person_id = $3
             AND rule.start_at <= now() AND (rule.end_at IS NULL OR now() < rule.end_at)
             AND assignment.start_at <= now()
             AND (assignment.end_at IS NULL OR now() < assignment.end_at))
           AS "activeOtherPersonRules",
         (SELECT count(*) FROM public.authz_rules
           WHERE rule_id = $4 AND capability_id = 'submitReceipt'
             AND subject_kind = 'Person' AND subject_person_id = $1
             AND end_at IS NOT NULL AND end_at <= now())
           AS "expiredJourneyPersonRules"`,
      [personId, activeRuleId, orthogonalPersonId, expiredRuleId],
    );
    const activityRow = activityResult.rows[0];
    assert.ok(activityRow !== undefined);
    const authzActivity = {
      observedAt: activityRow.observedAt.toISOString(),
      activeAssignments: Number(activityRow.activeAssignments),
      activeRules: Number(activityRow.activeRules),
      expiredRules: Number(activityRow.expiredRules),
      activeOtherPersonRules: Number(activityRow.activeOtherPersonRules),
      expiredJourneyPersonRules: Number(activityRow.expiredJourneyPersonRules),
      activeDifferentCapabilityPerson: {
        ruleId: activeRuleId,
        capabilityId: "approveReceipt",
        personId: orthogonalPersonId,
        subjectPath: "TagAssignment",
      },
      expiredJourneyPerson: {
        ruleId: expiredRuleId,
        capabilityId: "submitReceipt",
        personId,
      },
    };
    assert.deepEqual(
      {
        activeAssignments: authzActivity.activeAssignments,
        activeRules: authzActivity.activeRules,
        expiredRules: authzActivity.expiredRules,
        activeOtherPersonRules: authzActivity.activeOtherPersonRules,
        expiredJourneyPersonRules: authzActivity.expiredJourneyPersonRules,
      },
      {
        activeAssignments: 1,
        activeRules: 1,
        expiredRules: 1,
        activeOtherPersonRules: 1,
        expiredJourneyPersonRules: 1,
      },
    );
    process.stdout.write(
      `${JSON.stringify({
        specId: "0065",
        extensionSpecId: "0056",
        database: "PostgreSQL",
        migrations: [
          { revision: 15, name: "native-identity-better-auth" },
          { revision: 23, name: "declarative-authorization-rules" },
          { revision: 24, name: "identity-security-audit" },
        ],
        schemaRevision,
        authTables: [...authTables],
        publicAuthTables: [],
        authzTables: { public: [...authzTables], auth: [] },
        personIdForeignKey: true,
        seedRows: {
          profiles: counts.profiles,
          contacts: counts.contacts,
          globalAdministratorGrants: counts.grants,
          users: counts.users,
          credentialAccounts: counts.accounts,
        },
        authSchemaState,
        publicAuthz,
        authzActivity,
        sessions: { total: counts.sessionsTotal, live: counts.sessionsLive },
        identitySecurityAudit: {
          counts: auditCounts,
          rowsBoundedAndLinked: true,
          appendOnlyUpdateRejected: updateRejected,
          appendOnlyDeleteRejected: deleteRejected,
          observer: "distinct-loopback-postgresql-connection",
          ordering: {
            nativeSessionMutations: "state change and audit append share one adapter transaction",
            betterAuthCredentialOperations:
              "Better Auth commits first; the bounded audit append follows in a separate transaction",
            atomicCredentialAuditClaimed: false,
          },
        },
        observer: "distinct-loopback-postgresql-connection",
        passed: true,
      })}\n`,
    );
  } finally {
    await observer.end();
  }
};

export const program = Effect.promise(run);

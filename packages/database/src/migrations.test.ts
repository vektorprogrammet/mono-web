import { describe, expect, it, layer } from "@effect/vitest";
import { startDisposablePostgres } from "@monoweb/postgres";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { Schema, Predicate, Effect, FileSystem, Path } from "effect";
import { Pool } from "pg";
import { Database } from "./service.js";
import { DatabaseTestLive, TestPlatform } from "./test-support/platform.js";
import { type DatabaseMigrationId, selectDatabaseMigration } from "./migrations.js";
import { pgQuery, pgTransaction } from "./pg-pool.js";
import { withPostgresTestDatabase } from "./test-support/postgres.js";

const inventory = [
  "organization_global_administrator_grants",
  "economy_payment_authorities",
  "economy_receipt_approval_grants",
  "authz_tags",
  "authz_tag_assignments",
  "authz_rules",
  "organization_team_interest_registrations",
  "schools_directory_schools",
  "schools_directory_departments",
  "content_articles",
  "content_article_versions",
  "content_article_departments",
  "content_publication_command_receipts",
  "content_publication_audit",
  "recruitment_interview_schema_questions",
  "recruitment_interview_question_snapshots",
  "recruitment_interview_conducts",
  "recruitment_interview_cancellations",
  "recruitment_interview_lifecycle_command_receipts",
  "recruitment_interview_lifecycle_audit",
] as const;

const checkedSourceUrls = [
  new URL("../migrations/0016-person-keyed-organization-authority.sql", import.meta.url),
  new URL("../migrations/0017-person-keyed-receipt-authority.sql", import.meta.url),
  new URL("../migrations/0018-organization-team-interest.sql", import.meta.url),
  new URL("../migrations/0019-schools-directory.sql", import.meta.url),
  new URL("../migrations/0020-content-publication.sql", import.meta.url),
  new URL("../migrations/0021-native-recruitment-interview-conduct.sql", import.meta.url),
  new URL("../migrations/0023-declarative-authorization-rules.sql", import.meta.url),
];

const ecmaScriptTrimBoundaryCharacters = [
  "\u0009",
  "\u000a",
  "\u000b",
  "\u000c",
  "\u000d",
  "\u0020",
  "\u00a0",
  "\u1680",
  "\u2000",
  "\u2001",
  "\u2002",
  "\u2003",
  "\u2004",
  "\u2005",
  "\u2006",
  "\u2007",
  "\u2008",
  "\u2009",
  "\u200a",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff",
] as const;

const readMigrationSource = (url: URL) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;

    return yield* fileSystem.readFileString(yield* path.fromFileUrl(url));
  }).pipe(Effect.provide(TestPlatform));

/** A PGlite without migrations for one test, closed when the test's scope closes. */
const disposablePglite = Effect.acquireRelease(
  Effect.promise(() => PGlite.create({ extensions: { btree_gist } })),
  (database) => Effect.promise(() => database.close()),
);

const applyMigrationsThrough = (database: PGlite, lastMigrationId: DatabaseMigrationId) => {
  const { migration: last, preceding } = selectDatabaseMigration(lastMigrationId);

  return Effect.forEach(
    [...preceding, last],
    (migration) =>
      Effect.flatMap(readMigrationSource(migration.url), (source) =>
        Effect.promise(() => database.exec(source)),
      ),
    { discard: true },
  );
};

layer(DatabaseTestLive(), { excludeTestServices: true, timeout: "30 seconds" })(
  "database migrations",
  (it) => {
    describe("native domain schema boundary", () => {
      it.effect(
        "matches the checked inventory against all post-identity CREATE TABLE sources",
        () =>
          Effect.gen(function* () {
            const sources = yield* Effect.forEach(checkedSourceUrls, readMigrationSource);

            const sourceTables = sources
              .flatMap((source) =>
                [
                  ...source.matchAll(/CREATE TABLE IF NOT EXISTS\s+(?:public\.)?([a-z0-9_]+)/gi),
                ].map((match) => match[1]!),
              )
              .sort();

            expect(sourceTables).toEqual([...inventory].sort());
          }),
      );

      it.effect(
        "keeps qualified inventory reads independent of search_path",
        () =>
          Effect.gen(function* () {
            const evidence = yield* Effect.gen(function* () {
              const database = yield* Database;
              yield* database`
          CREATE TABLE auth.content_articles (article_id bigint NOT NULL)
        `;
              yield* database`
          INSERT INTO auth.content_articles (article_id) VALUES (9007199254740991)
        `;
              yield* database`SET search_path TO auth, public`;

              const authFirst = yield* database<{ readonly count: string }>`
          SELECT count(*)::text AS "count" FROM public.content_articles
        `;

              yield* database`SET search_path TO public`;

              const publicFirst = yield* database<{ readonly count: string }>`
          SELECT count(*)::text AS "count" FROM public.content_articles
        `;

              yield* database`DROP TABLE auth.content_articles`;
              yield* database`SET search_path TO auth, public`;

              return { authFirst, publicFirst };
            });

            expect(evidence.authFirst).toEqual(evidence.publicFirst);
            expect(evidence.authFirst).toEqual([{ count: "0" }]);
          }),
        15_000,
      );

      it.effect("places the complete post-identity inventory in public on fresh replay", () =>
        Effect.gen(function* () {
          const evidence = yield* Effect.gen(function* () {
            const database = yield* Database;

            const relations = yield* database<{
              readonly tableName: string;
              readonly schemaName: string;
            }>`
          SELECT relation.relname AS "tableName", namespace.nspname AS "schemaName"
          FROM pg_catalog.pg_class AS relation
          INNER JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          WHERE ${database.in("relation.relname", [...inventory])}
            AND namespace.nspname IN ('auth', 'public')
            AND relation.relkind IN ('r', 'p', 'f')
          ORDER BY relation.relname, namespace.nspname
        `;

            const authTables = yield* database<{ readonly tableName: string }>`
          SELECT relation.relname AS "tableName"
          FROM pg_catalog.pg_class AS relation
          INNER JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'auth'
            AND relation.relname IN (
              'user', 'session', 'account', 'verification', 'identity_security_audit'
            )
            AND relation.relkind IN ('r', 'p', 'f')
          ORDER BY relation.relname
        `;

            const triggerFunctions = yield* database<{
              readonly functionName: string;
              readonly schemaName: string;
            }>`
          SELECT procedure.proname AS "functionName", namespace.nspname AS "schemaName"
          FROM pg_catalog.pg_proc AS procedure
          INNER JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = procedure.pronamespace
          WHERE procedure.proname IN (
            'prevent_content_publication_audit_mutation',
            'prevent_identity_security_audit_mutation',
            'prevent_recruitment_interview_question_snapshot_mutation',
            'prevent_recruitment_interview_lifecycle_mutation'
          )
            AND procedure.pronargs = 0
          ORDER BY procedure.proname
        `;

            return { relations, authTables, triggerFunctions };
          });

          expect(evidence.relations).toEqual(
            [...inventory].sort().map((tableName) => ({ tableName, schemaName: "public" })),
          );
          expect(evidence.authTables).toEqual(
            ["account", "identity_security_audit", "session", "user", "verification"].map(
              (tableName) => ({ tableName }),
            ),
          );
          expect(evidence.triggerFunctions).toEqual([
            { functionName: "prevent_content_publication_audit_mutation", schemaName: "public" },
            { functionName: "prevent_identity_security_audit_mutation", schemaName: "auth" },
            {
              functionName: "prevent_recruitment_interview_lifecycle_mutation",
              schemaName: "public",
            },
            {
              functionName: "prevent_recruitment_interview_question_snapshot_mutation",
              schemaName: "public",
            },
          ]);
        }),
      );
    });

    describe("native HTTP semantics schema boundary", () => {
      const nativeHttpMigration = selectDatabaseMigration("29_native-http-semantics").migration;

      it.effect(
        "places HTTP authorities in public with an auth-first search path",
        () =>
          Effect.gen(function* () {
            const database = yield* disposablePglite;

            yield* applyMigrationsThrough(database, "28_service-principal-grants");
            yield* Effect.promise(() => database.exec("SET search_path TO auth, public"));
            const nativeHttpSource = yield* readMigrationSource(nativeHttpMigration.url);
            yield* Effect.promise(() => database.exec(nativeHttpSource));

            const relations = yield* Effect.promise(() =>
              database.query<{
                readonly schemaName: string;
                readonly tableName: string;
              }>(`
        SELECT
          namespace.nspname AS "schemaName",
          relation.relname AS "tableName"
        FROM pg_catalog.pg_class AS relation
        INNER JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname IN ('auth', 'public')
          AND relation.relname IN (
            'native_http_idempotency_receipts',
            'profile_http_versions',
            'recruitment_invitation_response_command_receipts'
          )
          AND relation.relkind IN ('r', 'p', 'f')
        ORDER BY relation.relname, namespace.nspname
      `),
            );

            expect(relations.rows).toEqual([
              { schemaName: "public", tableName: "native_http_idempotency_receipts" },
              { schemaName: "public", tableName: "profile_http_versions" },
              {
                schemaName: "public",
                tableName: "recruitment_invitation_response_command_receipts",
              },
            ]);

            const functions = yield* Effect.promise(() =>
              database.query<{
                readonly functionName: string;
                readonly schemaName: string;
              }>(`
        SELECT
          procedure.proname AS "functionName",
          namespace.nspname AS "schemaName"
        FROM pg_catalog.pg_proc AS procedure
        INNER JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname IN ('auth', 'public')
          AND procedure.proname IN (
            'ensure_profile_http_version',
            'increment_profile_http_authority_version',
            'increment_native_http_revision',
            'increment_content_article_department_revision'
          )
          AND procedure.pronargs = 0
        ORDER BY procedure.proname, namespace.nspname
      `),
            );

            expect(functions.rows).toEqual([
              { functionName: "ensure_profile_http_version", schemaName: "public" },
              {
                functionName: "increment_content_article_department_revision",
                schemaName: "public",
              },
              { functionName: "increment_native_http_revision", schemaName: "public" },
              {
                functionName: "increment_profile_http_authority_version",
                schemaName: "public",
              },
            ]);

            const triggers = yield* Effect.promise(() =>
              database.query<{
                readonly functionName: string;
                readonly functionSchema: string;
                readonly tableName: string;
                readonly tableSchema: string;
                readonly triggerName: string;
              }>(`
        SELECT
          trigger.tgname AS "triggerName",
          table_namespace.nspname AS "tableSchema",
          relation.relname AS "tableName",
          function_namespace.nspname AS "functionSchema",
          procedure.proname AS "functionName"
        FROM pg_catalog.pg_trigger AS trigger
        INNER JOIN pg_catalog.pg_class AS relation
          ON relation.oid = trigger.tgrelid
        INNER JOIN pg_catalog.pg_namespace AS table_namespace
          ON table_namespace.oid = relation.relnamespace
        INNER JOIN pg_catalog.pg_proc AS procedure
          ON procedure.oid = trigger.tgfoid
        INNER JOIN pg_catalog.pg_namespace AS function_namespace
          ON function_namespace.oid = procedure.pronamespace
        WHERE NOT trigger.tgisinternal
          AND trigger.tgname IN (
            'person_profiles_http_version_insert',
            'organization_global_administrator_grants_profile_http_version',
            'organization_memberships_profile_http_version',
            'admission_period_departments_http_revision',
            'admission_period_semesters_http_revision',
            'admission_period_fields_of_study_http_revision',
            'content_article_departments_http_revision'
          )
        ORDER BY trigger.tgname
      `),
            );

            expect(triggers.rows).toEqual([
              {
                functionName: "increment_native_http_revision",
                functionSchema: "public",
                tableName: "admission_period_departments",
                tableSchema: "public",
                triggerName: "admission_period_departments_http_revision",
              },
              {
                functionName: "increment_native_http_revision",
                functionSchema: "public",
                tableName: "admission_period_fields_of_study",
                tableSchema: "public",
                triggerName: "admission_period_fields_of_study_http_revision",
              },
              {
                functionName: "increment_native_http_revision",
                functionSchema: "public",
                tableName: "admission_period_semesters",
                tableSchema: "public",
                triggerName: "admission_period_semesters_http_revision",
              },
              {
                functionName: "increment_content_article_department_revision",
                functionSchema: "public",
                tableName: "content_article_departments",
                tableSchema: "public",
                triggerName: "content_article_departments_http_revision",
              },
              {
                functionName: "increment_profile_http_authority_version",
                functionSchema: "public",
                tableName: "organization_global_administrator_grants",
                tableSchema: "public",
                triggerName: "organization_global_administrator_grants_profile_http_version",
              },
              {
                functionName: "increment_profile_http_authority_version",
                functionSchema: "public",
                tableName: "organization_memberships",
                tableSchema: "public",
                triggerName: "organization_memberships_profile_http_version",
              },
              {
                functionName: "ensure_profile_http_version",
                functionSchema: "public",
                tableName: "person_profiles",
                tableSchema: "public",
                triggerName: "person_profiles_http_version_insert",
              },
            ]);

            const exerciseAuthorities = (
              searchPath: "auth, public" | "public",
              personId: string,
              identitySha256: string,
            ) =>
              Effect.gen(function* () {
                yield* Effect.promise(() => database.exec(`SET search_path TO ${searchPath}`));
                yield* Effect.promise(() =>
                  database.query(
                    `
            INSERT INTO public.person_profiles (person_id, first_name, last_name)
            VALUES ($1, 'HTTP', 'Authority')
          `,
                    [personId],
                  ),
                );
                yield* Effect.promise(() =>
                  database.query(
                    `
            INSERT INTO public.native_http_idempotency_receipts (
              identity_sha256,
              request_sha256,
              operation_id,
              state,
              status,
              media_type,
              body_bytes,
              headers_json,
              committed_at,
              full_expires_at,
              tombstoned_at
            ) VALUES (
              $1,
              $2,
              $3,
              'Complete',
              204,
              NULL,
              NULL,
              '{}'::jsonb,
              date_trunc('milliseconds', transaction_timestamp(), 'UTC'),
              date_trunc('milliseconds', transaction_timestamp(), 'UTC') + interval '24 hours',
              NULL
            )
          `,
                    [identitySha256, "f".repeat(64), `profile.updateOwnProfile:${personId}`],
                  ),
                );

                return yield* Effect.promise(() =>
                  database.query<{
                    readonly invitationReceiptCount: number;
                    readonly profileRevision: number;
                    readonly receiptStatus: number;
                  }>(
                    `
            SELECT
              (
                SELECT representation_revision
                FROM public.profile_http_versions
                WHERE person_id = $1
              ) AS "profileRevision",
              (
                SELECT status
                FROM public.native_http_idempotency_receipts
                WHERE identity_sha256 = $2
              ) AS "receiptStatus",
              (
                SELECT count(*)::integer
                FROM public.recruitment_invitation_response_command_receipts
              ) AS "invitationReceiptCount"
          `,
                    [personId, identitySha256],
                  ),
                );
              });

            const authFirst = yield* exerciseAuthorities(
              "auth, public",
              "http-authority-auth-first",
              "a".repeat(64),
            );

            const publicOnly = yield* exerciseAuthorities(
              "public",
              "http-authority-public-only",
              "b".repeat(64),
            );

            const expectedObservation = [
              {
                invitationReceiptCount: 0,
                profileRevision: 0,
                receiptStatus: 204,
              },
            ];

            expect(authFirst.rows).toEqual(expectedObservation);
            expect(publicOnly.rows).toEqual(expectedObservation);
          }),
        15_000,
      );
    });

    describe("identity security audit migration in PGlite", () => {
      it.effect(
        "enforces the closed bounded append-only event contract",
        () =>
          Effect.gen(function* () {
            const evidence = yield* Effect.gen(function* () {
              const database = yield* Database;
              yield* database`
          INSERT INTO public.person_profiles (person_id, first_name, last_name)
          VALUES ('identity-audit-person', 'Identity', 'Audit')
          ON CONFLICT (person_id) DO NOTHING
        `;
              yield* database`
          INSERT INTO auth.identity_security_audit (
            event_id,
            event_kind,
            subject_person_id,
            session_id,
            actor_principal,
            request_correlation,
            source_ip,
            user_agent,
            details
          ) VALUES (
            'identity-audit-valid',
            'session-revoked-one',
            'identity-audit-person',
            'opaque-session-id',
            'person:identity-audit-person',
            'identity-audit-request',
            '127.0.0.1',
            'migration-test',
            ${database.json({ outcomeCode: "owned-session-revoked", affectedSessionCount: 1 })}
          )
        `;

              const update = yield* Effect.exit(
                database`
            UPDATE auth.identity_security_audit
            SET actor_principal = 'person:changed'
            WHERE event_id = 'identity-audit-valid'
          `.pipe(Effect.asVoid),
              );

              const deletion = yield* Effect.exit(
                database`
            DELETE FROM auth.identity_security_audit
            WHERE event_id = 'identity-audit-valid'
          `.pipe(Effect.asVoid),
              );

              const invalidKind = yield* Effect.exit(
                database`
            INSERT INTO auth.identity_security_audit (
              event_id, event_kind, subject_person_id, actor_principal,
              request_correlation, details
            ) VALUES (
              'identity-audit-open-kind',
              'arbitrary-event',
              'identity-audit-person',
              'person:identity-audit-person',
              'identity-audit-open-kind-request',
              ${database.json({ outcomeCode: "owned-session-revoked", affectedSessionCount: 1 })}
            )
          `.pipe(Effect.asVoid),
              );

              const unboundedDetails = yield* Effect.exit(
                database`
            INSERT INTO auth.identity_security_audit (
              event_id, event_kind, request_correlation, details
            ) VALUES (
              'identity-audit-secret-detail',
              'sign-in-failure',
              'identity-audit-secret-request',
              ${database.json({
                outcomeCode: "credential-rejected",
                affectedSessionCount: 0,
                password: "must-not-persist",
              })}
            )
          `.pipe(Effect.asVoid),
              );

              const missingCorrelation = yield* Effect.exit(
                database`
            INSERT INTO auth.identity_security_audit (
              event_id, event_kind, subject_person_id, actor_principal, details
            ) VALUES (
              'identity-audit-missing-correlation',
              'session-revoked-one',
              'identity-audit-person',
              'person:identity-audit-person',
              ${database.json({ outcomeCode: "owned-session-revoked", affectedSessionCount: 1 })}
            )
          `.pipe(Effect.asVoid),
              );

              const rows = yield* database<{
                readonly eventId: string;
                readonly details: unknown;
              }>`
          SELECT event_id AS "eventId", details
          FROM auth.identity_security_audit
          WHERE event_id = 'identity-audit-valid'
        `;

              return {
                updateRejected: Predicate.isTagged(update, "Failure"),
                deleteRejected: Predicate.isTagged(deletion, "Failure"),
                invalidKindRejected: Predicate.isTagged(invalidKind, "Failure"),
                unboundedDetailsRejected: Predicate.isTagged(unboundedDetails, "Failure"),
                missingCorrelationRejected: Predicate.isTagged(missingCorrelation, "Failure"),
                rows,
              };
            });

            expect(evidence).toEqual({
              updateRejected: true,
              deleteRejected: true,
              invalidKindRejected: true,
              unboundedDetailsRejected: true,
              missingCorrelationRejected: true,
              rows: [
                {
                  eventId: "identity-audit-valid",
                  details: { outcomeCode: "owned-session-revoked", affectedSessionCount: 1 },
                },
              ],
            });
          }),
        15_000,
      );
    });

    describe("declarative authorization rule migration in PGlite", () => {
      it.effect(
        "uses supported JSONB operators and rejects incomplete or inexact Submit params",
        () =>
          Effect.gen(function* () {
            const evidence = yield* Effect.gen(function* () {
              const database = yield* Database;
              yield* database`
          INSERT INTO public.person_profiles (person_id, first_name, last_name)
          VALUES ('authz-params-person', 'Authz', 'Params')
          ON CONFLICT (person_id) DO NOTHING
        `;

              const insertSubmitRule = (ruleId: string, params: Schema.Json) =>
                database`
            INSERT INTO public.authz_rules (
              rule_id,
              capability_id,
              effect_kind,
              subject_kind,
              subject_person_id,
              subject_tag_id,
              scope,
              department_id,
              params,
              start_at,
              end_at,
              revision
            ) VALUES (
              ${ruleId},
              'submitReceipt',
              'delegate',
              'Person',
              'authz-params-person',
              NULL,
              'Global',
              NULL,
              ${database.json(params)},
              '2030-01-01T00:00:00.000Z',
              NULL,
              0
            )
          `.pipe(Effect.asVoid);

              const valid = yield* Effect.exit(
                insertSubmitRule("authz-params-valid", {
                  slot: "EconomyPaymentAuthority",
                  paymentAccountCiphertext: "ciphertext",
                }),
              );

              const internalWhitespace = yield* Effect.exit(
                insertSubmitRule("authz-params-internal-whitespace", {
                  slot: "EconomyPaymentAuthority",
                  paymentAccountCiphertext: "ciphertext\u00a0account",
                }),
              );

              const remainingEcmaScriptTrimWhitespace = ecmaScriptTrimBoundaryCharacters.slice(2);

              const invalidParams: ReadonlyArray<readonly [string, Schema.Json]> = [
                ["missingKey", { slot: "EconomyPaymentAuthority" }],
                ["arbitraryKey", { slot: "EconomyPaymentAuthority", arbitrary: "ciphertext" }],
                [
                  "extraKey",
                  {
                    slot: "EconomyPaymentAuthority",
                    paymentAccountCiphertext: "ciphertext",
                    arbitrary: true,
                  },
                ],
                ["nonStringSlot", { slot: null, paymentAccountCiphertext: "ciphertext" }],
                [
                  "nonStringCiphertext",
                  { slot: "EconomyPaymentAuthority", paymentAccountCiphertext: 42 },
                ],
                [
                  "emptyCiphertext",
                  { slot: "EconomyPaymentAuthority", paymentAccountCiphertext: "" },
                ],
                [
                  "paddedCiphertext",
                  {
                    slot: "EconomyPaymentAuthority",
                    paymentAccountCiphertext: " ciphertext ",
                  },
                ],
                [
                  "tabPaddedCiphertext",
                  {
                    slot: "EconomyPaymentAuthority",
                    paymentAccountCiphertext: "ciphertext\t",
                  },
                ],
                [
                  "newlinePaddedCiphertext",
                  {
                    slot: "EconomyPaymentAuthority",
                    paymentAccountCiphertext: "\nciphertext",
                  },
                ],
                [
                  "carriageReturnPaddedCiphertext",
                  {
                    slot: "EconomyPaymentAuthority",
                    paymentAccountCiphertext: "ciphertext\r",
                  },
                ],
                [
                  "nbspPaddedCiphertext",
                  {
                    slot: "EconomyPaymentAuthority",
                    paymentAccountCiphertext: "\u00a0ciphertext",
                  },
                ],
              ];

              const rejected: Record<string, boolean> = {};

              for (const [name, params] of invalidParams) {
                const outcome = yield* Effect.exit(
                  insertSubmitRule(`authz-params-${name}`, params),
                );

                rejected[name] = Predicate.isTagged(outcome, "Failure");
              }

              let remainingEcmaScriptBoundariesRejected = true;

              for (const [index, whitespace] of remainingEcmaScriptTrimWhitespace.entries()) {
                const outcome = yield* Effect.exit(
                  insertSubmitRule(`authz-params-ecma-boundary-${index}`, {
                    slot: "EconomyPaymentAuthority",
                    paymentAccountCiphertext: `${whitespace}ciphertext`,
                  }),
                );

                remainingEcmaScriptBoundariesRejected &&= Predicate.isTagged(outcome, "Failure");
              }

              return {
                validAccepted: Predicate.isTagged(valid, "Success"),
                internalWhitespaceAccepted: Predicate.isTagged(internalWhitespace, "Success"),
                rejected,
                remainingEcmaScriptBoundariesRejected,
              };
            });

            expect(evidence).toEqual({
              validAccepted: true,
              internalWhitespaceAccepted: true,
              remainingEcmaScriptBoundariesRejected: true,
              rejected: {
                missingKey: true,
                arbitraryKey: true,
                extraKey: true,
                nonStringSlot: true,
                nonStringCiphertext: true,
                emptyCiphertext: true,
                paddedCiphertext: true,
                tabPaddedCiphertext: true,
                newlinePaddedCiphertext: true,
                carriageReturnPaddedCiphertext: true,
                nbspPaddedCiphertext: true,
              },
            });
          }),
        15_000,
      );

      it.effect(
        "rejects every ECMAScript-trimmed authorization identifier at the SQL boundary",
        () =>
          Effect.gen(function* () {
            const evidence = yield* Effect.gen(function* () {
              const database = yield* Database;
              const personId = "authz-identifiers-person";
              const validTagId = "authz-identifiers-valid-tag";
              yield* database`
          INSERT INTO public.person_profiles (person_id, first_name, last_name)
          VALUES (${personId}, 'Authz', 'Identifiers')
          ON CONFLICT (person_id) DO NOTHING
        `;
              yield* database`
          INSERT INTO public.authz_tags (tag_id, name)
          VALUES (${validTagId}, 'Authz Identifiers Valid Tag')
          ON CONFLICT (tag_id) DO NOTHING
        `;

              const boundaryCases = [
                { name: "empty", makeValue: (_base: string) => "" },
                ...ecmaScriptTrimBoundaryCharacters.flatMap((whitespace, index) => [
                  {
                    name: `leading-${index}`,
                    makeValue: (base: string) => `${whitespace}${base}`,
                  },
                  {
                    name: `trailing-${index}`,
                    makeValue: (base: string) => `${base}${whitespace}`,
                  },
                ]),
              ];

              const unexpectedlyAccepted: Array<string> = [];
              let attemptedCases = 0;

              for (const [index, boundaryCase] of boundaryCases.entries()) {
                const base = `authz-identifiers-${index}`;
                const invalid = boundaryCase.makeValue(base);

                const attempts = [
                  [
                    "tagId",
                    database`
                INSERT INTO public.authz_tags (tag_id, name)
                VALUES (${invalid}, ${`${base}-tag-name`})
              `.pipe(Effect.asVoid),
                  ],
                  [
                    "tagName",
                    database`
                INSERT INTO public.authz_tags (tag_id, name)
                VALUES (${`${base}-tag-id`}, ${invalid})
              `.pipe(Effect.asVoid),
                  ],
                  [
                    "assignmentId",
                    database`
                INSERT INTO public.authz_tag_assignments (
                  assignment_id, tag_id, person_id, start_at
                ) VALUES (
                  ${invalid}, ${validTagId}, ${personId}, '2030-01-01T00:00:00.000Z'
                )
              `.pipe(Effect.asVoid),
                  ],
                  [
                    "assignmentTagId",
                    database`
                INSERT INTO public.authz_tag_assignments (
                  assignment_id, tag_id, person_id, start_at
                ) VALUES (
                  ${`${base}-assignment-tag-id`},
                  ${invalid},
                  ${personId},
                  '2030-01-01T00:00:00.000Z'
                )
              `.pipe(Effect.asVoid),
                  ],
                  [
                    "ruleId",
                    database`
                INSERT INTO public.authz_rules (
                  rule_id, capability_id, effect_kind, subject_kind,
                  subject_person_id, subject_tag_id, scope, department_id,
                  params, start_at
                ) VALUES (
                  ${invalid}, 'approveReceipt', 'delegate', 'Person',
                  ${personId}, NULL, 'Global', NULL,
                  '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb,
                  '2030-01-01T00:00:00.000Z'
                )
              `.pipe(Effect.asVoid),
                  ],
                  [
                    "ruleSubjectTagId",
                    database`
                INSERT INTO public.authz_rules (
                  rule_id, capability_id, effect_kind, subject_kind,
                  subject_person_id, subject_tag_id, scope, department_id,
                  params, start_at
                ) VALUES (
                  ${`${base}-rule-subject-tag-id`},
                  'approveReceipt',
                  'delegate',
                  'Tag',
                  NULL,
                  ${invalid},
                  'Global',
                  NULL,
                  '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb,
                  '2030-01-01T00:00:00.000Z'
                )
              `.pipe(Effect.asVoid),
                  ],
                  [
                    "capabilityId",
                    database`
                INSERT INTO public.authz_rules (
                  rule_id, capability_id, effect_kind, subject_kind,
                  subject_person_id, subject_tag_id, scope, department_id,
                  params, start_at
                ) VALUES (
                  ${`${base}-capability-rule`},
                  ${boundaryCase.makeValue("approveReceipt")},
                  'delegate',
                  'Person',
                  ${personId},
                  NULL,
                  'Global',
                  NULL,
                  '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb,
                  '2030-01-01T00:00:00.000Z'
                )
              `.pipe(Effect.asVoid),
                  ],
                  [
                    "subjectKind",
                    database`
                INSERT INTO public.authz_rules (
                  rule_id, capability_id, effect_kind, subject_kind,
                  subject_person_id, subject_tag_id, scope, department_id,
                  params, start_at
                ) VALUES (
                  ${`${base}-subject-kind-rule`},
                  'approveReceipt',
                  'delegate',
                  ${boundaryCase.makeValue("Person")},
                  ${personId},
                  NULL,
                  'Global',
                  NULL,
                  '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb,
                  '2030-01-01T00:00:00.000Z'
                )
              `.pipe(Effect.asVoid),
                  ],
                ] as const;

                for (const [category, attempt] of attempts) {
                  attemptedCases += 1;
                  const outcome = yield* Effect.exit(attempt);

                  if (Predicate.isTagged(outcome, "Success")) {
                    unexpectedlyAccepted.push(`${category}:${boundaryCase.name}`);
                  }
                }
              }

              const internalTagId = "authz\tidentifiers-tag";

              const internalWhitespace = yield* Effect.exit(
                Effect.gen(function* () {
                  yield* database`
              INSERT INTO public.authz_tags (tag_id, name)
              VALUES (${internalTagId}, ${"Authz\u00a0Identifiers Tag"})
            `;
                  yield* database`
              INSERT INTO public.authz_tag_assignments (
                assignment_id, tag_id, person_id, start_at
              ) VALUES (
                ${"authz\nidentifiers-assignment"},
                ${internalTagId},
                ${personId},
                '2030-01-01T00:00:00.000Z'
              )
            `;
                  yield* database`
              INSERT INTO public.authz_rules (
                rule_id, capability_id, effect_kind, subject_kind,
                subject_person_id, subject_tag_id, scope, department_id,
                params, start_at
              ) VALUES (
                ${"authz\u2000identifiers-rule"},
                'approveReceipt',
                'delegate',
                'Tag',
                NULL,
                ${internalTagId},
                'Global',
                NULL,
                '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb,
                '2030-01-01T00:00:00.000Z'
              )
            `;
                }),
              );

              return {
                attemptedCases,
                internalWhitespaceAccepted: Predicate.isTagged(internalWhitespace, "Success"),
                unexpectedlyAccepted,
              };
            });

            expect(evidence).toEqual({
              attemptedCases: (1 + ecmaScriptTrimBoundaryCharacters.length * 2) * 8,
              internalWhitespaceAccepted: true,
              unexpectedlyAccepted: [],
            });
          }),
        30_000,
      );

      it.effect(
        "migration 25 accepts only Global, Domain(receipts), and Department rule scopes",
        () =>
          Effect.gen(function* () {
            const database = yield* disposablePglite;

            yield* applyMigrationsThrough(database, "25_principal-credential-access-algebra");
            yield* Effect.promise(() =>
              database.exec(`
        INSERT INTO public.person_profiles (person_id, first_name, last_name)
        VALUES ('authz-domain-person', 'Authz', 'Domain');
        INSERT INTO public.organization_departments (
          department_id, name, short_name, email, city
        ) VALUES (
          'authz-domain-department', 'Authz Domain Department', 'ADD',
          'authz-domain@example.invalid', 'Oslo'
        );
      `),
            );

            const insert = (
              ruleId: string,
              scope: string,
              domainId: string | null,
              departmentId: string | null,
            ) =>
              database.query(
                `
            INSERT INTO public.authz_rules (
              rule_id, capability_id, effect_kind, subject_kind, subject_person_id,
              subject_tag_id, scope, domain_id, department_id, params, start_at
            ) VALUES (
              $1, 'approveReceipt', 'delegate', 'Person', 'authz-domain-person',
              NULL, $2, $3, $4,
              '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb,
              '2030-01-01T00:00:00.000Z'
            )
          `,
                [ruleId, scope, domainId, departmentId],
              );

            const accepted = (
              ruleId: string,
              scope: string,
              domainId: string | null,
              departmentId: string | null,
            ) =>
              Effect.tryPromise(() => insert(ruleId, scope, domainId, departmentId)).pipe(
                Effect.match({ onFailure: () => false, onSuccess: () => true }),
              );

            const globalAccepted = yield* accepted("authz-global-valid", "Global", null, null);

            const domainAccepted = yield* accepted(
              "authz-domain-valid",
              "Domain",
              "receipts",
              null,
            );

            const departmentAccepted = yield* accepted(
              "authz-department-valid",
              "Department",
              null,
              "authz-domain-department",
            );

            const receiptRejected = !(yield* accepted(
              "authz-receipt-invalid",
              "Receipt",
              null,
              null,
            ));

            const tenantRejected = !(yield* accepted("authz-tenant-invalid", "Tenant", null, null));

            const missingDomainRejected = !(yield* accepted(
              "authz-domain-missing-id",
              "Domain",
              null,
              null,
            ));

            const wrongDomainRejected = !(yield* accepted(
              "authz-domain-wrong-id",
              "Domain",
              "organization",
              null,
            ));

            const rows = yield* Effect.promise(() =>
              database.query<{
                readonly departmentId: string | null;
                readonly domainId: string | null;
                readonly scope: string;
              }>(`
        SELECT
          department_id AS "departmentId",
          domain_id AS "domainId",
          scope
        FROM public.authz_rules
        WHERE rule_id IN ('authz-department-valid', 'authz-domain-valid', 'authz-global-valid')
        ORDER BY rule_id
      `),
            );

            expect({
              globalAccepted,
              domainAccepted,
              departmentAccepted,
              receiptRejected,
              tenantRejected,
              missingDomainRejected,
              wrongDomainRejected,
              rows: rows.rows,
            }).toEqual({
              globalAccepted: true,
              domainAccepted: true,
              departmentAccepted: true,
              receiptRejected: true,
              tenantRejected: true,
              missingDomainRejected: true,
              wrongDomainRejected: true,
              rows: [
                {
                  departmentId: "authz-domain-department",
                  domainId: null,
                  scope: "Department",
                },
                { departmentId: null, domainId: "receipts", scope: "Domain" },
                { departmentId: null, domainId: null, scope: "Global" },
              ],
            });
          }),
        15_000,
      );
    });

    describe("declarative rule reconciliation migration", () => {
      const reconciliationMigration = selectDatabaseMigration(
        "26_declarative-rule-reconciliation",
      ).migration;

      const prepareMigration25State = (database: PGlite) =>
        Effect.gen(function* () {
          yield* applyMigrationsThrough(database, "25_principal-credential-access-algebra");
          yield* Effect.promise(() =>
            database.exec(`
      INSERT INTO public.person_profiles (person_id, first_name, last_name)
      VALUES ('migration-preflight-person', 'Migration', 'Preflight');
      INSERT INTO public.organization_departments (
        department_id, name, short_name, email, city
      ) VALUES (
        'migration-preflight-department', 'Migration preflight',
        'MP', 'migration-preflight@example.invalid', 'Oslo'
      );
      INSERT INTO public.authz_tags (tag_id, name, revision)
      VALUES ('migration-preflight-tag', 'Migration preflight', 0);
    `),
          );
          yield* Effect.promise(() =>
            database.exec(`
      ALTER TABLE public.authz_rules
        DROP CONSTRAINT authz_rules_subject_person_id_fkey,
        DROP CONSTRAINT authz_rules_subject_tag_id_fkey,
        DROP CONSTRAINT authz_rules_department_id_fkey,
        DROP CONSTRAINT authz_rules_subject_declared,
        DROP CONSTRAINT authz_rules_scope_declared,
        DROP CONSTRAINT authz_rules_params_declared,
        DROP CONSTRAINT authz_rules_interval_ordered,
        DROP CONSTRAINT authz_rules_revision_nonnegative;
      ALTER TABLE public.authz_rules
        ADD CONSTRAINT authz_rules_params_declared CHECK (true);
    `),
          );
        });

      const insertValidPreflightRows = (database: PGlite) =>
        Effect.promise(() =>
          database.exec(`
      INSERT INTO public.authz_rules (
        rule_id, capability_id, effect_kind, subject_kind,
        subject_person_id, subject_tag_id, scope, domain_id, department_id,
        params, start_at, end_at, revision
      ) VALUES
        (
          'migration-preflight-valid-global', 'approveReceipt', 'delegate', 'Person',
          'migration-preflight-person', NULL, 'Global', NULL, NULL,
          '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb,
          '2030-01-01T00:00:00.000Z', NULL, 0
        ),
        (
          'migration-preflight-valid-domain', 'approveReceipt', 'requirement', 'Tag',
          NULL, 'migration-preflight-tag', 'Domain', 'receipts', NULL,
          '{"requirementId":"receipts.pending","parameters":{}}'::jsonb,
          '2030-01-01T00:00:00.000Z', NULL, 0
        ),
        (
          'migration-preflight-valid-department', 'approveReceipt', 'requirement', 'Person',
          'migration-preflight-person', NULL, 'Department', NULL,
          'migration-preflight-department',
          '{"requirementId":"receipts.approver-relationship","parameters":{}}'::jsonb,
          '2030-01-01T00:00:00.000Z', NULL, 0
        ),
        (
          'migration-preflight-valid-payment', 'submitReceipt', 'delegate', 'Person',
          'migration-preflight-person', NULL, 'Domain', 'receipts', NULL,
          '{"slot":"EconomyPaymentAuthority","paymentAccountCiphertext":"preflight-secret-ciphertext"}'::jsonb,
          '2030-01-01T00:00:00.000Z', NULL, 0
        );
    `),
        );

      it.effect(
        "reports every unsupported row once and aborts before mutation",
        () =>
          Effect.gen(function* () {
            const database = yield* disposablePglite;

            yield* prepareMigration25State(database);

            const columnsAfter25 = yield* Effect.promise(() =>
              database.query<{
                readonly columnName: string;
              }>(`
        SELECT column_name AS "columnName"
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'authz_rules'
          AND column_name IN ('domain_id', 'resource_id')
        ORDER BY column_name
      `),
            );

            expect(columnsAfter25.rows).toEqual([{ columnName: "domain_id" }]);
            yield* insertValidPreflightRows(database);
            yield* Effect.promise(() =>
              database.exec(`
        INSERT INTO public.authz_rules (
          rule_id, capability_id, effect_kind, subject_kind,
          subject_person_id, subject_tag_id, scope, domain_id, department_id,
          params, start_at, end_at, revision
        ) VALUES
          (
            'migration-preflight-subject-columns', 'approveReceipt', 'delegate', 'Person',
            'migration-preflight-person', 'migration-preflight-tag', 'Global', NULL, NULL,
            '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb,
            '2030-01-01T00:00:00.000Z', NULL, 0
          ),
          (
            'migration-preflight-subject-reference', 'approveReceipt', 'delegate', 'Person',
            'migration-preflight-missing-person', NULL, 'Global', NULL, NULL,
            '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb,
            '2030-01-01T00:00:00.000Z', NULL, 0
          ),
          (
            'migration-preflight-scope-columns', 'approveReceipt', 'delegate', 'Person',
            'migration-preflight-person', NULL, 'Global', 'receipts', NULL,
            '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb,
            '2030-01-01T00:00:00.000Z', NULL, 0
          ),
          (
            'migration-preflight-scope-reference', 'approveReceipt', 'delegate', 'Person',
            'migration-preflight-person', NULL, 'Department', NULL,
            'migration-preflight-missing-department',
            '{"slot":"EconomyDepartmentApprovalGrant"}'::jsonb,
            '2030-01-01T00:00:00.000Z', NULL, 0
          ),
          (
            'migration-preflight-interval', 'approveReceipt', 'delegate', 'Person',
            'migration-preflight-person', NULL, 'Global', NULL, NULL,
            '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb,
            '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', 0
          ),
          (
            'migration-preflight-revision', 'approveReceipt', 'delegate', 'Person',
            'migration-preflight-person', NULL, 'Global', NULL, NULL,
            '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb,
            '2030-01-01T00:00:00.000Z', NULL, -1
          ),
          (
            'migration-preflight-variant', 'approveReceipt', 'parameter', 'Person',
            'migration-preflight-person', NULL, 'Global', NULL, NULL,
            '{"slot":"unsupported","private":"do-not-report"}'::jsonb,
            '2030-01-01T00:00:00.000Z', NULL, 0
          );
      `),
            );

            const reconciliationSource = yield* readMigrationSource(reconciliationMigration.url);

            const failureMessage = yield* Effect.tryPromise({
              try: () => database.exec(reconciliationSource),
              catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
            }).pipe(Effect.match({ onFailure: (message) => message, onSuccess: () => "" }));

            const reportMatch = /authz_rules preflight failed: (\[.*\])/u.exec(failureMessage);
            expect(reportMatch).not.toBeNull();

            const report = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
              reportMatch![1]!,
            );

            expect(report).toEqual([
              {
                reasonCode: "INTERVAL_INVALID",
                ruleId: "migration-preflight-interval",
              },
              {
                reasonCode: "REVISION_INVALID",
                ruleId: "migration-preflight-revision",
              },
              {
                reasonCode: "SCOPE_COLUMNS_INVALID",
                ruleId: "migration-preflight-scope-columns",
              },
              {
                reasonCode: "SCOPE_REFERENCE_MISSING",
                ruleId: "migration-preflight-scope-reference",
              },
              {
                reasonCode: "SUBJECT_COLUMNS_INVALID",
                ruleId: "migration-preflight-subject-columns",
              },
              {
                reasonCode: "SUBJECT_REFERENCE_MISSING",
                ruleId: "migration-preflight-subject-reference",
              },
              {
                reasonCode: "VARIANT_INVALID",
                ruleId: "migration-preflight-variant",
              },
            ]);
            expect(failureMessage).not.toContain("preflight-secret-ciphertext");
            expect(failureMessage).not.toContain("do-not-report");
            expect(failureMessage).not.toContain("migration-preflight-valid-");

            const requirementConstraint = yield* Effect.promise(() =>
              database.query<{
                readonly definition: string;
              }>(`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'public.authz_rules'::regclass
          AND conname = 'authz_rules_params_declared'
      `),
            );

            expect(requirementConstraint.rows).toEqual([{ definition: "CHECK (true)" }]);
          }),
        15_000,
      );

      it.effect(
        "accepts complete valid rows from migration 25 state",
        () =>
          Effect.gen(function* () {
            const database = yield* disposablePglite;

            yield* prepareMigration25State(database);
            yield* insertValidPreflightRows(database);
            const reconciliationSource = yield* readMigrationSource(reconciliationMigration.url);
            yield* Effect.promise(() => database.exec(reconciliationSource));

            const rows = yield* Effect.promise(() =>
              database.query<{ readonly ruleId: string }>(`
        SELECT rule_id AS "ruleId"
        FROM public.authz_rules
        ORDER BY rule_id
      `),
            );

            expect(rows.rows).toEqual([
              { ruleId: "migration-preflight-valid-department" },
              { ruleId: "migration-preflight-valid-domain" },
              { ruleId: "migration-preflight-valid-global" },
              { ruleId: "migration-preflight-valid-payment" },
            ]);

            const constraint = yield* Effect.promise(() =>
              database.query<{ readonly definition: string }>(`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'public.authz_rules'::regclass
          AND conname = 'authz_rules_params_declared'
      `),
            );

            expect(constraint.rows[0]?.definition).toContain("receipts.pending");
          }),
        15_000,
      );

      it.effect(
        "accepts only exact requirements on allowed rule scopes",
        () =>
          Effect.gen(function* () {
            const evidence = yield* Effect.gen(function* () {
              const database = yield* Database;
              yield* database`
          INSERT INTO public.person_profiles (person_id, first_name, last_name)
          VALUES ('migration-requirement-person', 'Requirement', 'Rule')
        `;

              const insert = (
                ruleId: string,
                scope: string,
                domainId: string | null,
                params: Schema.Json,
              ) =>
                database`
            INSERT INTO public.authz_rules (
              rule_id, capability_id, effect_kind, subject_kind,
              subject_person_id, subject_tag_id, scope, domain_id, department_id,
              params, start_at, end_at, revision
            ) VALUES (
              ${ruleId}, 'approveReceipt', 'requirement', 'Person',
              'migration-requirement-person', NULL, ${scope}, ${domainId}, NULL,
              ${database.json(params)},
              '2030-01-01T00:00:00.000Z', NULL, 0
            )
          `.pipe(Effect.asVoid);

              yield* insert("migration-require-pending", "Domain", "receipts", {
                requirementId: "receipts.pending",
                parameters: {},
              });
              yield* insert("migration-require-approver", "Global", null, {
                requirementId: "receipts.approver-relationship",
                parameters: {},
              });

              const unsupported = yield* Effect.exit(
                insert("migration-require-unsupported", "Domain", "receipts", {
                  requirementId: "receipts.owner",
                  parameters: {},
                }),
              );

              const nonempty = yield* Effect.exit(
                insert("migration-require-nonempty", "Domain", "receipts", {
                  requirementId: "receipts.pending",
                  parameters: { unexpected: true },
                }),
              );

              const excess = yield* Effect.exit(
                insert("migration-require-excess", "Domain", "receipts", {
                  requirementId: "receipts.pending",
                  parameters: {},
                  unexpected: true,
                }),
              );

              const receiptScope = yield* Effect.exit(
                insert("migration-require-receipt-scope", "Receipt", null, {
                  requirementId: "receipts.pending",
                  parameters: {},
                }),
              );

              const rows = yield* database<{
                readonly domainId: string | null;
                readonly ruleId: string;
                readonly scope: string;
              }>`
          SELECT
            rule_id AS "ruleId",
            scope,
            domain_id AS "domainId"
          FROM public.authz_rules
          WHERE subject_person_id = 'migration-requirement-person'
          ORDER BY rule_id
        `;

              yield* database`
          DELETE FROM public.authz_rules
          WHERE subject_person_id = 'migration-requirement-person'
        `;
              yield* database`
          DELETE FROM public.person_profiles
          WHERE person_id = 'migration-requirement-person'
        `;

              return {
                excess: excess._tag,
                nonempty: nonempty._tag,
                receiptScope: receiptScope._tag,
                rows,
                unsupported: unsupported._tag,
              };
            });

            expect(evidence).toEqual({
              excess: "Failure",
              nonempty: "Failure",
              receiptScope: "Failure",
              rows: [
                {
                  domainId: null,
                  ruleId: "migration-require-approver",
                  scope: "Global",
                },
                {
                  domainId: "receipts",
                  ruleId: "migration-require-pending",
                  scope: "Domain",
                },
              ],
              unsupported: "Failure",
            });
          }),
        15_000,
      );
    });

    describe("instant precision boundary", () => {
      it.effect("guards every stored instant and its clock default at millisecond precision", () =>
        Effect.gen(function* () {
          const columns = yield* Effect.gen(function* () {
            const database = yield* Database;

            // The Migrator writes its own bookkeeping column with an untruncated default, and the
            // PersistedQueue store writes NOW() into its lease and visibility columns.
            return yield* database<{
              readonly column: string;
              readonly guarded: boolean;
              readonly untruncatedClockDefault: boolean;
            }>`
          SELECT
            format('%I.%I.%I', namespace.nspname, relation.relname, attribute.attname) AS "column",
            EXISTS (
              SELECT 1
              FROM pg_catalog.pg_constraint AS guard
              WHERE guard.conrelid = attribute.attrelid
                AND guard.contype = 'c'
                AND guard.conkey = ARRAY[attribute.attnum]
                AND pg_catalog.pg_get_constraintdef(guard.oid) = format(
                  'CHECK ((%1$s = date_trunc(''milliseconds''::text, %1$s, ''UTC''::text)))',
                  quote_ident(attribute.attname)
                )
            ) AS guarded,
            COALESCE(
              pg_catalog.pg_get_expr(column_default.adbin, column_default.adrelid) ~*
                '(now|current_timestamp|clock_timestamp|statement_timestamp|transaction_timestamp)'
              AND pg_catalog.pg_get_expr(column_default.adbin, column_default.adrelid) <>
                'date_trunc(''milliseconds''::text, now(), ''UTC''::text)',
              false
            ) AS "untruncatedClockDefault"
          FROM pg_catalog.pg_attribute AS attribute
          INNER JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
          INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          LEFT JOIN pg_catalog.pg_attrdef AS column_default
            ON column_default.adrelid = attribute.attrelid
            AND column_default.adnum = attribute.attnum
          WHERE attribute.attnum > 0
            AND NOT attribute.attisdropped
            AND attribute.atttypid = 'timestamptz'::regtype
            AND relation.relkind IN ('r', 'p')
            AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
            AND (namespace.nspname, relation.relname) NOT IN (
              ('public', 'vektorprogrammet_schema_migrations'),
              ('public', 'effect_queue')
            )
          ORDER BY 1
        `;
          });

          expect(columns.length).toBeGreaterThan(0);
          expect(columns.flatMap(({ column, guarded }) => (guarded ? [] : [column]))).toEqual([]);
          expect(
            columns.flatMap(({ column, untruncatedClockDefault }) =>
              untruncatedClockDefault ? [column] : [],
            ),
          ).toEqual([]);
        }),
      );
    });
  },
);

const precisionBaseline = selectDatabaseMigration("84_application-email-period-ownership");

const precisionPreceding = [...precisionBaseline.preceding, precisionBaseline.migration];

const precisionRepair = selectDatabaseMigration("85_application-decision-instant-precision");

// Registered 84 seed: completed, uncancelled Ja conduct closes a real Admitted citation.
// One early-closed window and its successor retain their own audit and command receipts.
const precisionSeed = `
INSERT INTO public.admission_period_departments(department_id,name) VALUES('precision-department','Precision');
INSERT INTO public.admission_period_semesters(semester_id,start_at,end_at) VALUES('precision-semester','2031-01-01','2032-01-01');
INSERT INTO public.admission_periods(admission_period_id,department_id,semester_id,start_at,end_at,last_command_id)
  VALUES('precision-period','precision-department','precision-semester','2031-01-01','2031-03-01','precision-period-created');
INSERT INTO public.admission_period_fields_of_study(field_of_study_id,department_id,name) VALUES('precision-field','precision-department','Math');
INSERT INTO public.person_profiles(person_id,first_name,last_name) VALUES
  ('precision-staff','Synthetic','Interviewer'),('precision-maintainer','Synthetic','Maintainer');
INSERT INTO public.admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study)
  SELECT 'precision-applicant-'||n,'precision-'||n||'@example.invalid','precision-'||n||'@example.invalid',
    'Synthetic','Applicant','90000000',0,'precision-field',2 FROM generate_series(1,2) n;
INSERT INTO public.admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at)
  SELECT 'precision-application-'||n,'precision-applicant-'||n,'precision-period','precision-department','precision-field',2,'2031-02-01'::timestamptz
    FROM generate_series(1,2) n;
INSERT INTO public.recruitment_interview_schemas(interview_schema_id,name,question_count) VALUES('precision-schema','Precision',0);
INSERT INTO public.recruitment_interviews(interview_id,application_id,department_id,interviewer_person_id,interview_schema_id,assigned_by_person_id,assigned_at,revision)
  SELECT 'precision-interview-'||n,'precision-application-'||n,'precision-department','precision-staff','precision-schema','precision-staff','2031-02-01'::timestamptz,1
    FROM generate_series(1,2) n;
INSERT INTO public.recruitment_interview_conducts(interview_id,answers,explanatory_power,role_model,suitability,finalized_by_person_id,finalized_at,interview_revision,recommendation)
  SELECT 'precision-interview-'||n,'[]'::jsonb,1,2,3,'precision-staff','2031-02-02'::timestamptz,1,'Ja' FROM generate_series(1,2) n;
INSERT INTO public.admission_application_outcomes(application_id,revision,outcome,decided_by_person_id,decided_at,provenance)
  VALUES('precision-application-1',1,'Admitted',NULL,'2031-02-03 10:00:00.123+00','Recommendation');
INSERT INTO public.recruitment_assessment_correction_windows(interview_id,sequence,opened_by,opened_at,ends_at,reason)
  VALUES('precision-interview-1',1,'precision-maintainer','2031-02-04 10:00:00.123+00','2031-02-05 10:00:00.456+00','Review original assessment');
UPDATE public.recruitment_assessment_correction_windows SET closed_by='precision-maintainer',closed_at='2031-02-04 11:00:00.789+00',close_reason='Review withdrawn'
  WHERE interview_id='precision-interview-1' AND sequence=1;
INSERT INTO public.recruitment_assessment_correction_windows(interview_id,sequence,opened_by,opened_at,ends_at,reason)
  VALUES('precision-interview-1',2,'precision-maintainer','2031-02-06 10:00:00.123+00','2031-02-07 10:00:00.456+00','Independent review');
INSERT INTO public.recruitment_maintenance_command_receipts(actor_person_id,command_id,command_digest,result_json)
  SELECT 'precision-maintainer','precision-window-command-'||n,repeat('a',64),
    jsonb_build_object('_tag',CASE n WHEN 2 THEN 'AssessmentCorrectionClosed' ELSE 'AssessmentCorrectionReopened' END,
      'interviewId','precision-interview-1','sequence',CASE n WHEN 3 THEN 2 ELSE 1 END) FROM generate_series(1,3) n;
INSERT INTO public.recruitment_assessment_correction_window_audit(actor_person_id,command_id,interview_id,sequence,action,reason,occurred_at)
  VALUES('precision-maintainer','precision-window-command-1','precision-interview-1',1,'Reopen','Review original assessment','2031-02-04 10:00:00.123+00'),
    ('precision-maintainer','precision-window-command-2','precision-interview-1',1,'Close','Review withdrawn','2031-02-04 11:00:00.789+00'),
    ('precision-maintainer','precision-window-command-3','precision-interview-1',2,'Reopen','Independent review','2031-02-06 10:00:00.123+00');
`;

const precisionSnapshotSql = `SELECT jsonb_build_object(
  'applications',(SELECT jsonb_agg(to_jsonb(a) ORDER BY application_id) FROM public.admission_applications a),
  'citations',(SELECT jsonb_agg(to_jsonb(e) ORDER BY application_id) FROM public.application_admission_decision_evidence e),
  'conducts',(SELECT jsonb_agg(to_jsonb(c) ORDER BY interview_id) FROM public.recruitment_interview_conducts c),
  'outcomes',(SELECT jsonb_agg(to_jsonb(o) ORDER BY application_id,revision) FROM public.admission_application_outcomes o),
  'windows',(SELECT jsonb_agg(to_jsonb(w) ORDER BY interview_id,sequence) FROM public.recruitment_assessment_correction_windows w),
  'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY actor_person_id,command_id) FROM public.recruitment_assessment_correction_window_audit a),
  'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY actor_person_id,command_id) FROM public.recruitment_maintenance_command_receipts r)
)::text AS bytes`;

const decodePrecisionSnapshot = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ bytes: Schema.String })),
);

const precisionSnapshot = Effect.fnUntraced(function* (pool: Pool) {
  return yield* decodePrecisionSnapshot((yield* pgQuery(pool, precisionSnapshotSql)).rows);
});

// Each probe runs in a server-side subtransaction, so even successful controls are undone.
// This keeps failed statements observable through PGlite's socket adapter as well as PG17/18.
const precisionObserver = `CREATE FUNCTION public.precision_attempt(statement text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE state text; violated text;
BEGIN
  BEGIN
    EXECUTE statement;
    RAISE EXCEPTION 'probe undone' USING ERRCODE='RB001';
  EXCEPTION WHEN SQLSTATE 'RB001' THEN
    RETURN jsonb_build_object('state','accepted','constraint',NULL);
  END;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS state=RETURNED_SQLSTATE,violated=CONSTRAINT_NAME;
  RETURN jsonb_build_object('state',state,'constraint',violated);
END $$;
CREATE FUNCTION public.precision_history_attempt(statement text,repair text,snapshot text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE state text; violated text; before_bytes text; after_bytes text; result jsonb;
BEGIN
  BEGIN
    EXECUTE statement;
    EXECUTE snapshot INTO before_bytes;
    BEGIN
      EXECUTE repair;
      state:='accepted';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS state=RETURNED_SQLSTATE,violated=CONSTRAINT_NAME;
    END;
    EXECUTE snapshot INTO after_bytes;
    result:=jsonb_build_object('state',state,'constraint',violated,'before',before_bytes,'after',after_bytes);
    RAISE EXCEPTION 'historical fixture undone' USING ERRCODE='RB001';
  EXCEPTION WHEN SQLSTATE 'RB001' THEN
    RETURN result;
  END;
END $$;`;

const decodePrecisionAttempt = Schema.decodeUnknownEffect(
  Schema.Struct({
    result: Schema.Struct({
      state: Schema.Literals(["accepted", "23514", "P0001"]),
      constraint: Schema.NullOr(Schema.String),
    }),
  }),
);

const precisionAttempt = Effect.fnUntraced(function* (pool: Pool, statement: string) {
  const rows = yield* pgQuery(pool, "SELECT public.precision_attempt($1) AS result", [statement]);

  return (yield* decodePrecisionAttempt(rows.rows[0])).result;
});

const decodePrecisionHistoryAttempt = Schema.decodeUnknownEffect(
  Schema.Struct({
    result: Schema.Struct({
      state: Schema.Literals(["accepted", "23514"]),
      constraint: Schema.NullOr(Schema.String),
      before: Schema.String,
      after: Schema.String,
    }),
  }),
);

const precisionHistoryAttempt = Effect.fnUntraced(function* (
  pool: Pool,
  statement: string,
  source: string,
) {
  const rows = yield* pgQuery(pool, "SELECT public.precision_history_attempt($1,$2,$3) AS result", [
    statement,
    source,
    precisionSnapshotSql,
  ]);

  return (yield* decodePrecisionHistoryAttempt(rows.rows[0])).result;
});

const precisionProbes = [
  {
    constraint: "application_admission_decision_evidence_closed_at_ms",
    statement: (fraction: string) =>
      `INSERT INTO public.application_admission_decision_evidence
      (application_id,basis,outcome,interview_id,assessment_revision,interview_completed,interview_cancelled,returning_registered,citation_state,closed_at)
      SELECT application_id,basis,'Admitted',interview_id,assessment_revision,interview_completed,interview_cancelled,returning_registered,citation_state,
        '2031-02-03 10:00:00.${fraction}+00'::timestamptz
      FROM public.application_admission_evidence WHERE application_id='precision-application-2'`,
  },
  {
    constraint: "recruitment_assessment_correction_window_audit_occurred_at_ms",
    statement: (fraction: string) =>
      `INSERT INTO public.recruitment_maintenance_command_receipts(actor_person_id,command_id,command_digest,result_json)
      VALUES('precision-maintainer','precision-window-command-4',repeat('b',64),'{"_tag":"AssessmentCorrectionClosed","interviewId":"precision-interview-1","sequence":2}');
      UPDATE public.recruitment_assessment_correction_windows SET closed_by='precision-maintainer',closed_at='2031-02-06 11:00:00.123+00',close_reason='Review withdrawn'
        WHERE interview_id='precision-interview-1' AND sequence=2;
      INSERT INTO public.recruitment_assessment_correction_window_audit(actor_person_id,command_id,interview_id,sequence,action,reason,occurred_at)
      VALUES('precision-maintainer','precision-window-command-4','precision-interview-1',2,'Close','Review withdrawn','2031-02-06 11:00:00.${fraction}+00')`,
  },
  {
    constraint: "recruitment_assessment_correction_windows_closed_at_ms",
    statement: (fraction: string) => `UPDATE public.recruitment_assessment_correction_windows
      SET closed_by='precision-maintainer',closed_at='2031-02-06 11:00:00.${fraction}+00',close_reason='Review withdrawn'
      WHERE interview_id='precision-interview-1' AND sequence=2`,
  },
  ...["ends_at", "opened_at"].map((column) => ({
    constraint: `recruitment_assessment_correction_windows_${column}_ms`,
    statement: (fraction: string) =>
      `INSERT INTO public.recruitment_assessment_correction_windows(interview_id,sequence,opened_by,opened_at,ends_at,reason)
      VALUES('precision-interview-1',3,'precision-maintainer',
        '2031-02-08 10:00:00.${column === "opened_at" ? fraction : "123"}+00','2031-02-09 10:00:00.${column === "ends_at" ? fraction : "456"}+00','Further independent review')`,
  })),
];

const proveDecisionPrecisionUpgrade = Effect.fnUntraced(function* (pool: Pool) {
  yield* pgQuery(pool, precisionSeed);
  yield* pgQuery(pool, precisionObserver);
  const historical = yield* precisionSnapshot(pool);
  const source = yield* readMigrationSource(precisionRepair.migration.url);

  for (const probe of precisionProbes) {
    // Valid 84 writes must stay valid; historical microseconds must abort instead of being rewritten.
    expect(yield* precisionAttempt(pool, probe.statement("123456"))).toEqual({
      state: "accepted",
      constraint: null,
    });
    const refusal = yield* precisionHistoryAttempt(pool, probe.statement("123456"), source);
    expect({ state: refusal.state, constraint: refusal.constraint }).toEqual({
      state: "23514",
      constraint: probe.constraint,
    });
    expect(refusal.after).toBe(refusal.before);
    expect(yield* precisionSnapshot(pool)).toEqual(historical);
  }

  yield* pgTransaction(pool, (client) => pgQuery(client, source));
  expect(yield* precisionSnapshot(pool)).toEqual(historical);

  for (const probe of precisionProbes) {
    expect(yield* precisionAttempt(pool, probe.statement("123"))).toEqual({
      state: "accepted",
      constraint: null,
    });
    expect(yield* precisionAttempt(pool, probe.statement("123456"))).toEqual({
      state: "23514",
      constraint: probe.constraint,
    });
  }

  for (const statement of [
    "UPDATE public.application_admission_decision_evidence SET closed_at=closed_at WHERE application_id='precision-application-1'",
    "DELETE FROM public.application_admission_decision_evidence WHERE application_id='precision-application-1'",
    "UPDATE public.recruitment_assessment_correction_window_audit SET reason=reason",
    "DELETE FROM public.recruitment_assessment_correction_window_audit",
    "UPDATE public.recruitment_assessment_correction_windows SET reason='Rewrite window' WHERE sequence=1",
    "DELETE FROM public.recruitment_assessment_correction_windows",
  ])
    expect((yield* precisionAttempt(pool, statement)).state).toBe("P0001");
  expect(yield* precisionSnapshot(pool)).toEqual(historical);
  yield* pgQuery(
    pool,
    "DROP FUNCTION public.precision_attempt(text); DROP FUNCTION public.precision_history_attempt(text,text,text)",
  );
});

// The existing harness and hosted supported-major matrix run the same upgrade on PG17 and PG18.
describe("decision instant precision upgrade from registered 84", () => {
  it.live(
    "preserves citations, audit and window history and enforces all five instants on PGlite",
    () =>
      withPostgresTestDatabase(proveDecisionPrecisionUpgrade, precisionPreceding).pipe(
        Effect.provide(TestPlatform),
      ),
    { timeout: 180_000 },
  );
  it.live(
    "preserves the same history and enforcement on the selected PostgreSQL major",
    () =>
      Effect.gen(function* () {
        const postgres = yield* Effect.acquireRelease(
          Effect.promise(() => startDisposablePostgres({ listen: "socket", maxConnections: 4 })),
          (opened) => Effect.promise(() => opened.stop()),
        );

        const pool = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: postgres.url, max: 1 })),
          (opened) => Effect.promise(() => opened.end()),
        );

        for (const migration of precisionPreceding)
          yield* pgQuery(pool, yield* readMigrationSource(migration.url));
        yield* proveDecisionPrecisionUpgrade(pool);
      }).pipe(Effect.scoped, Effect.provide(TestPlatform)),
    { timeout: 180_000 },
  );
});

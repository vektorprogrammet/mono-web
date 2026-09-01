import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Database } from "@vektorprogrammet/domain/database";
import { DatabaseTest } from "./layers.js";
import { makeControlledTestRuntime } from "../test/runtime.js";

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
  new URL("../../domain/src/schools/migrations/0001-schools-directory.sql", import.meta.url),
  new URL("../../domain/src/content/migrations/0001-content-publication.sql", import.meta.url),
  new URL("../migrations/0021-native-recruitment-interview-conduct.sql", import.meta.url),
  new URL("../migrations/0023-declarative-authorization-rules.sql", import.meta.url),
];

const runtime = makeControlledTestRuntime(DatabaseTest());

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

afterAll(async () => {
  await runtime.dispose();
});

describe("native domain schema boundary", () => {
  it("matches the checked inventory against all post-identity CREATE TABLE sources", async () => {
    const sourceTables = (await Promise.all(checkedSourceUrls.map((url) => readFile(url, "utf8"))))
      .flatMap((source) =>
        [...source.matchAll(/CREATE TABLE IF NOT EXISTS\s+(?:public\.)?([a-z0-9_]+)/gi)].map(
          (match) => match[1]!,
        ),
      )
      .sort();

    expect(sourceTables).toEqual([...inventory].sort());
  });

  it("keeps qualified inventory reads independent of search_path", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
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
      }),
    );

    expect(evidence.authFirst).toEqual(evidence.publicFirst);
    expect(evidence.authFirst).toEqual([{ count: "0" }]);
  }, 15_000);

  it("places the complete post-identity inventory in public on fresh replay", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
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
      }),
    );

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
  });
});

describe("identity security audit migration in PGlite", () => {
  it("enforces the closed bounded append-only event contract", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
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
          updateRejected: update._tag === "Failure",
          deleteRejected: deletion._tag === "Failure",
          invalidKindRejected: invalidKind._tag === "Failure",
          unboundedDetailsRejected: unboundedDetails._tag === "Failure",
          missingCorrelationRejected: missingCorrelation._tag === "Failure",
          rows,
        };
      }),
    );

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
  }, 15_000);
});

describe("declarative authorization rule migration in PGlite", () => {
  it("uses supported JSONB operators and rejects incomplete or inexact Submit params", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database`
          INSERT INTO public.person_profiles (person_id, first_name, last_name)
          VALUES ('authz-params-person', 'Authz', 'Params')
          ON CONFLICT (person_id) DO NOTHING
        `;
        const insertSubmitRule = (ruleId: string, params: unknown) =>
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
        const invalidParams: ReadonlyArray<readonly [string, unknown]> = [
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
          ["emptyCiphertext", { slot: "EconomyPaymentAuthority", paymentAccountCiphertext: "" }],
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
          const outcome = yield* Effect.exit(insertSubmitRule(`authz-params-${name}`, params));
          rejected[name] = outcome._tag === "Failure";
        }
        let remainingEcmaScriptBoundariesRejected = true;
        for (const [index, whitespace] of remainingEcmaScriptTrimWhitespace.entries()) {
          const outcome = yield* Effect.exit(
            insertSubmitRule(`authz-params-ecma-boundary-${index}`, {
              slot: "EconomyPaymentAuthority",
              paymentAccountCiphertext: `${whitespace}ciphertext`,
            }),
          );
          remainingEcmaScriptBoundariesRejected &&= outcome._tag === "Failure";
        }
        return {
          validAccepted: valid._tag === "Success",
          internalWhitespaceAccepted: internalWhitespace._tag === "Success",
          rejected,
          remainingEcmaScriptBoundariesRejected,
        };
      }),
    );

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
  }, 15_000);

  it("rejects every ECMAScript-trimmed authorization identifier at the SQL boundary", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
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
            if (outcome._tag === "Success") {
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
          internalWhitespaceAccepted: internalWhitespace._tag === "Success",
          unexpectedlyAccepted,
        };
      }),
    );

    expect(evidence).toEqual({
      attemptedCases: (1 + ecmaScriptTrimBoundaryCharacters.length * 2) * 8,
      internalWhitespaceAccepted: true,
      unexpectedlyAccepted: [],
    });
  }, 30_000);
});

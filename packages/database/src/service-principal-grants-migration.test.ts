import { afterAll, describe, expect, it } from "vitest";
import { Database } from "@vektorprogrammet/domain/database";
import { Effect } from "effect";
import { makeControlledTestRuntime } from "../test/runtime.js";
import { DatabaseTest } from "./layers.js";
import { databaseMigrationDefinitions, databaseSchemaRevision } from "./migrations.js";

const runtime = makeControlledTestRuntime(DatabaseTest());

afterAll(async () => {
  await runtime.dispose();
});

describe("service-principal grant migration", () => {
  it("registers 0028 and enforces bounded audit text plus both lock-order indexes", async () => {
    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database`
          INSERT INTO public.person_profiles (person_id, first_name, last_name)
          VALUES ('service-grant-migration-owner', 'Service grant', 'Owner')
        `;
        yield* database`
          INSERT INTO public.organization_departments (
            department_id, name, short_name, email, city
          ) VALUES (
            'service-grant-migration-department', 'Service grant migration', 'SGM',
            'service-grant-migration@example.invalid', 'Oslo'
          )
        `;
        yield* database`
          INSERT INTO public.economy_receipts (
            receipt_id, visual_id, owner_person_id, department_id, amount_ore,
            currency, description, receipt_date, submitted_at, status, refund_date,
            payment_account_ciphertext, file_ref, file_object_key, file_content_type,
            file_byte_length, file_sha256, revision
          ) VALUES (
            'service-grant-migration-receipt', 'SGM-RECEIPT',
            'service-grant-migration-owner', 'service-grant-migration-department',
            1000, 'NOK', 'Service grant migration receipt', '2032-06-01',
            '2032-06-01T11:00:00.000Z', 'Pending', NULL, 'ciphertext:migration',
            'service-grant-migration-file', 'service-grant-migration-object',
            'application/pdf', 100, ${"a".repeat(64)}, 0
          )
        `;
        yield* database`
          INSERT INTO public.service_principals (
            service_principal_id, name, state
          ) VALUES (
            'service-grant-migration-principal', 'Service grant migration principal', 'Active'
          )
        `;
        yield* database`
          INSERT INTO auth."oauthClient" (
            "id", "clientId", "redirectUris", "disabled", "scopes",
            "clientCredentialsScopes"
          ) VALUES (
            'service-grant-migration-client-row', 'service-grant-migration-client',
            ${database.json([])}, false, ${database.json(["native-api"])},
            ${database.json(["native-api"])}
          )
        `;
        yield* database`
          INSERT INTO auth.oauth_client_bindings (
            client_id, client_kind, service_principal_id, secret_expires_at
          ) VALUES (
            'service-grant-migration-client', 'Service',
            'service-grant-migration-principal', '2033-06-01T00:00:00.000Z'
          )
        `;
        yield* database`
          INSERT INTO auth."oauthResource" (
            "id", "identifier", "name", "disabled"
          ) VALUES (
            'service-grant-migration-resource-row',
            'urn:vektorprogrammet:native-api', 'Native API', false
          )
        `;
        yield* database`
          INSERT INTO auth."oauthClientResource" (
            "id", "clientId", "resourceId"
          ) VALUES (
            'service-grant-migration-link', 'service-grant-migration-client',
            'urn:vektorprogrammet:native-api'
          )
        `;
        yield* database`
          INSERT INTO public.service_principal_grants (
            grant_id, service_principal_id, client_id, protected_resource,
            operation_id, capability_id, resource_kind, resource_id, start_at
          ) VALUES (
            'service-grant-migration-grant', 'service-grant-migration-principal',
            'service-grant-migration-client', 'urn:vektorprogrammet:native-api',
            'receipts.listReceiptsForApproval', 'approveReceipt', 'receipt',
            'service-grant-migration-receipt', '2032-06-01T11:00:00.000Z'
          )
        `;

        const appendAudit = (
          eventId: string,
          operatorActor: string,
          requestCorrelation: string,
        ) =>
          database`
            INSERT INTO public.service_principal_grant_audit (
              event_id, occurred_at, event_kind, grant_id, service_principal_id,
              client_id, protected_resource, operation_id, capability_id,
              resource_id, revision, operator_actor, request_correlation
            ) VALUES (
              ${eventId}, '2032-06-01T12:00:00.000Z',
              'service-principal-grant-created', 'service-grant-migration-grant',
              'service-grant-migration-principal', 'service-grant-migration-client',
              'urn:vektorprogrammet:native-api', 'receipts.listReceiptsForApproval',
              'approveReceipt', 'service-grant-migration-receipt', 0,
              ${operatorActor}, ${requestCorrelation}
            )
          `.pipe(Effect.asVoid);

        yield* appendAudit(
          "service-grant-migration-valid",
          "operator",
          "service-grant-migration-valid-request",
        );
        const whitespaceEventId = yield* Effect.exit(
          appendAudit(" service-grant-migration-event ", "operator", "event-request"),
        );
        const whitespaceActor = yield* Effect.exit(
          appendAudit("service-grant-migration-actor", "\u00a0", "actor-request"),
        );
        const whitespaceCorrelation = yield* Effect.exit(
          appendAudit("service-grant-migration-correlation", "operator", " correlation "),
        );
        const overlongEventId = yield* Effect.exit(
          appendAudit("e".repeat(161), "operator", "event-length-request"),
        );
        const overlongActor = yield* Effect.exit(
          appendAudit(
            "service-grant-migration-actor-length",
            "a".repeat(161),
            "actor-length-request",
          ),
        );
        const overlongCorrelation = yield* Effect.exit(
          appendAudit(
            "service-grant-migration-correlation-length",
            "operator",
            "c".repeat(161),
          ),
        );
        const indexes = yield* database<{ readonly indexName: string }>`
          SELECT indexname AS "indexName"
          FROM pg_catalog.pg_indexes
          WHERE schemaname = 'public'
            AND indexname IN (
              'service_principal_grants_lock_order',
              'authz_rules_service_principal_lock_order'
            )
          ORDER BY indexname
        `;
        const countRows = yield* database<{ readonly count: string }>`
          SELECT count(*)::text AS count
          FROM public.service_principal_grant_audit
          WHERE grant_id = 'service-grant-migration-grant'
        `;
        return {
          whitespaceEventId: whitespaceEventId._tag,
          whitespaceActor: whitespaceActor._tag,
          whitespaceCorrelation: whitespaceCorrelation._tag,
          overlongEventId: overlongEventId._tag,
          overlongActor: overlongActor._tag,
          overlongCorrelation: overlongCorrelation._tag,
          indexes: indexes.map(({ indexName }) => indexName),
          count: countRows[0]?.count,
        };
      }),
    );

    expect(databaseMigrationDefinitions.at(-1)?.id).toBe("28_service-principal-grants");
    expect(databaseSchemaRevision).toBe("28_service_principal_grants");
    expect(evidence).toEqual({
      whitespaceEventId: "Failure",
      whitespaceActor: "Failure",
      whitespaceCorrelation: "Failure",
      indexes: [
        "authz_rules_service_principal_lock_order",
        "service_principal_grants_lock_order",
      ],
      overlongEventId: "Failure",
      overlongActor: "Failure",
      overlongCorrelation: "Failure",
      count: "1",
    });
  }, 15_000);
});

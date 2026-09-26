import {
  AcceptedOAuthServiceCredential,
  AuthorizationInstant,
  CredentialEvidenceRef,
  CredentialMechanismSchema,
  PrincipalSchema,
  ServicePrincipalId,
  ServicePrincipalGrantAuthorityError,
  ServicePrincipalReceiptGrantSchema,
  evaluateServicePrincipalReceiptApprovalAccess,
} from "@vektorprogrammet/domain/authz";
import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { makeServicePrincipalGrantAuthorityService } from "./service-principal-grants-live.js";
import { withPostgresTestDatabase } from "./test-support/postgres.js";

const authorizationInstant = AuthorizationInstant.make("2032-06-01T12:00:00.000Z");

const startAt = "2032-06-01T11:00:00.000Z";

const credential = AcceptedOAuthServiceCredential.make({
  mechanism: CredentialMechanismSchema.cases.OAuthServiceBearer.make({}),
  principal: PrincipalSchema.cases.ServicePrincipal.make({
    servicePrincipalId: ServicePrincipalId.make("service-receipt-approval"),
  }),
  evidenceRef: CredentialEvidenceRef.make(
    `oauth:ServicePrincipal:service-jti:service-client:${Date.parse(startAt) / 1000}`,
  ),
});

it(
  "commits grants with their audit, reads exact candidates, and fails closed for invalid persisted rules",
  () =>
    withPostgresTestDatabase(async (pool) => {
      await pool.query(`
    INSERT INTO public.person_profiles (person_id, first_name, last_name) VALUES ('receipt-owner', 'Receipt', 'Owner');
    INSERT INTO public.organization_departments (department_id, name, short_name, email, city) VALUES ('receipt-department', 'Receipt', 'R', 'receipt@example.invalid', 'Oslo');
    INSERT INTO public.service_principals (service_principal_id, name, state) VALUES ('service-receipt-approval', 'Approval service', 'Active');
    INSERT INTO auth."oauthClient" (id, "clientId", "redirectUris", scopes, "clientCredentialsScopes") VALUES ('client', 'service-client', '[]', '["native-api"]', '["native-api"]');
    INSERT INTO auth."oauthResource" (id, identifier, name) VALUES ('resource', 'urn:vektorprogrammet:native-api', 'Native API');
    INSERT INTO auth."oauthClientResource" (id, "clientId", "resourceId") VALUES ('binding', 'service-client', 'urn:vektorprogrammet:native-api');
    INSERT INTO auth.oauth_client_bindings (client_id, client_kind, service_principal_id, secret_expires_at) VALUES ('service-client', 'Service', 'service-receipt-approval', '2033-01-01');
    INSERT INTO auth.oauth_access_token_state (jti, client_id, principal_kind, service_principal_id, issued_at, expires_at) VALUES ('service-jti', 'service-client', 'ServicePrincipal', 'service-receipt-approval', '2032-06-01T11:00:00Z', '2032-06-02');
    INSERT INTO public.economy_receipts (
      receipt_id, visual_id, owner_person_id, department_id, amount_ore, currency, description, receipt_date,
      submitted_at, status, payment_account_ciphertext, file_ref, file_object_key, file_content_type, file_byte_length, file_sha256, revision
    ) VALUES ('receipt-1', 'SERVICE-1', 'receipt-owner', 'receipt-department', 1250, 'NOK', 'Service candidate', '2032-06-01',
      '2032-06-01', 'Pending', 'ciphertext:service', 'service-file', 'service-object', 'application/pdf', 100, repeat('a', 64), 0);
  `);
      const service = makeServicePrincipalGrantAuthorityService(pool);

      const grant = Schema.decodeSync(ServicePrincipalReceiptGrantSchema)({
        grantId: "grant-1",
        servicePrincipalId: "service-receipt-approval",
        clientId: "service-client",
        protectedResource: "urn:vektorprogrammet:native-api",
        operationId: "receipts.listReceiptsForApproval",
        capabilityId: "approveReceipt",
        resourceKind: "receipt",
        receiptId: "receipt-1",
        startAt,
        endAt: null,
        revokedAt: null,
        revision: 0,
      });

      const input = {
        grant,
        audit: {
          eventId: "created-1",
          occurredAt: authorizationInstant,
          operatorActor: "operator",
          requestCorrelation: "grant-create",
        },
      };

      await pool.query(`CREATE FUNCTION public.reject_grant_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
    CREATE TRIGGER reject_grant_audit BEFORE INSERT ON public.service_principal_grant_audit FOR EACH ROW EXECUTE FUNCTION public.reject_grant_audit()`);
      await expect(Effect.runPromise(service.createGrant(input))).rejects.toMatchObject({
        reason: "PersistenceFailure",
      });
      expect(
        (await pool.query(`SELECT grant_id FROM public.service_principal_grants`)).rows,
      ).toEqual([]);
      await pool.query(
        `DROP TRIGGER reject_grant_audit ON public.service_principal_grant_audit; DROP FUNCTION public.reject_grant_audit()`,
      );
      expect(await Effect.runPromise(service.createGrant(input))).toEqual(grant);
      expect(
        (
          await pool.query(
            `SELECT event_kind, grant_id, request_correlation FROM public.service_principal_grant_audit`,
          )
        ).rows,
      ).toEqual([
        {
          event_kind: "service-principal-grant-created",
          grant_id: "grant-1",
          request_correlation: "grant-create",
        },
      ]);
      await pool.query(`INSERT INTO public.authz_rules (rule_id, capability_id, effect_kind, subject_kind, subject_service_principal_id, scope, resource_kind, resource_id, params, start_at, revision)
    VALUES ('pending-rule', 'approveReceipt', 'requirement', 'ServicePrincipal', 'service-receipt-approval', 'Resource', 'receipt', 'receipt-1', '{"requirementId":"receipts.pending","parameters":{}}', '2032-06-01T11:00:00Z', 0)`);

      const authority = await Effect.runPromise(
        service.readReceiptApprovalCandidates(credential, authorizationInstant),
      );

      expect(
        authority.candidates.map(({ grant: candidateGrant, receipt }) => [
          candidateGrant.grantId,
          receipt.receiptId,
          receipt.amountOre,
        ]),
      ).toEqual([["grant-1", "receipt-1", "1250"]]);
      expect(authority.rules.map(({ ruleId }) => ruleId)).toEqual(["pending-rule"]);
      await pool.query(
        `UPDATE public.authz_rules SET start_at = '-infinity' WHERE rule_id = 'pending-rule'`,
      );

      const invalidRule = await Effect.runPromise(
        Effect.flip(service.readReceiptApprovalCandidates(credential, authorizationInstant)),
      );

      expect(invalidRule).toBeInstanceOf(ServicePrincipalGrantAuthorityError);
      expect(invalidRule.reason).toBe("PersistenceFailure");
      await pool.query(`UPDATE public.authz_rules SET start_at = '2032-06-01T11:00:00Z' WHERE rule_id = 'pending-rule';
        INSERT INTO public.economy_receipts (
          receipt_id, visual_id, owner_person_id, department_id, amount_ore, currency, description,
          receipt_date, submitted_at, status, approved_at, payment_account_ciphertext,
          file_ref, file_object_key, file_content_type, file_byte_length, file_sha256, revision
        ) SELECT 'service-page-' || side || '-' || lpad(n::text, 3, '0'),
          'SERVICE-PAGE-' || side || '-' || n, 'receipt-owner', 'receipt-department', 1250, 'NOK', 'Paged service receipt',
          '2032-06-01', CASE WHEN side = 'b' THEN '2032-06-01T10:00:00.123Z'::timestamptz ELSE '2032-06-01T09:00:00.123Z'::timestamptz END,
          CASE WHEN side = 'b' THEN 'Approved' ELSE 'Pending' END,
          CASE WHEN side = 'b' THEN '2032-06-01T11:00:00Z'::timestamptz ELSE NULL END,
          'ciphertext:page', 'service-page-file-' || side || '-' || n, 'service-page-object-' || side || '-' || n,
          'application/pdf', 100, repeat('a', 64), 0
        FROM generate_series(0, 59) AS n CROSS JOIN (VALUES ('a'), ('b')) AS sides(side);
        INSERT INTO public.service_principal_grants (
          grant_id, service_principal_id, client_id, protected_resource, operation_id, capability_id,
          resource_kind, resource_id, start_at, end_at, revoked_at, revision
        ) SELECT 'grant-' || receipt_id, 'service-receipt-approval', 'service-client', 'urn:vektorprogrammet:native-api',
          'receipts.listReceiptsForApproval', 'approveReceipt', 'receipt', receipt_id, '2032-06-01T11:00:00Z', NULL, NULL, 0
        FROM public.economy_receipts WHERE receipt_id LIKE 'service-page-%';
        INSERT INTO public.service_principal_grants (
          grant_id, service_principal_id, client_id, protected_resource, operation_id, capability_id,
          resource_kind, resource_id, start_at, end_at, revoked_at, revision
        ) SELECT 'grant-page-duplicate', service_principal_id, client_id, protected_resource, operation_id, capability_id,
          resource_kind, resource_id, start_at, end_at, revoked_at, revision FROM public.service_principal_grants
          WHERE grant_id = 'grant-service-page-a-049';
        INSERT INTO public.authz_rules (
          rule_id, capability_id, effect_kind, subject_kind, subject_service_principal_id, scope,
          resource_kind, resource_id, params, start_at, revision
        ) SELECT 'pending-' || receipt_id, 'approveReceipt', 'requirement', 'ServicePrincipal', 'service-receipt-approval',
          'Resource', 'receipt', receipt_id, '{"requirementId":"receipts.pending","parameters":{}}', '2032-06-01T11:00:00Z', 0
        FROM public.economy_receipts WHERE receipt_id LIKE 'service-page-%';`);

      const firstPage = await Effect.runPromise(
        service.readReceiptApprovalCandidates(credential, authorizationInstant),
      );

      expect([...new Set(firstPage.candidates.map(({ receipt }) => receipt.receiptId))]).toEqual(
        Array.from(
          { length: 50 },
          (_, index) => `service-page-a-${String(index).padStart(3, "0")}`,
        ),
      );
      expect(
        firstPage.candidates
          .filter(({ receipt }) => receipt.receiptId === "service-page-a-049")
          .map(({ grant }) => grant.grantId)
          .sort(),
      ).toEqual(["grant-page-duplicate", "grant-service-page-a-049"]);

      if (firstPage.nextCursor === undefined) throw new Error("Service page lost continuation");
      await pool.query(
        `UPDATE public.economy_receipts SET status = 'Approved', approved_at = '2032-06-01T11:00:00Z' WHERE receipt_id = 'service-page-a-000'`,
      );

      const nextPage = await Effect.runPromise(
        service.readReceiptApprovalCandidates(
          credential,
          authorizationInstant,
          undefined,
          firstPage.nextCursor,
        ),
      );

      expect(nextPage.candidates.map(({ receipt }) => receipt.receiptId)).toEqual([
        ...Array.from(
          { length: 10 },
          (_, index) => `service-page-a-${String(index + 50).padStart(3, "0")}`,
        ),
        "receipt-1",
      ]);
      expect(nextPage.nextCursor).toBeUndefined();

      const noMatchingStatus = await Effect.runPromise(
        service.readReceiptApprovalCandidates(credential, authorizationInstant, "Rejected"),
      );

      expect(
        evaluateServicePrincipalReceiptApprovalAccess(
          credential,
          noMatchingStatus,
          authorizationInstant,
        )._tag,
      ).toBe("Allow");
      expect(
        noMatchingStatus.candidates.every(({ receipt }) => receipt.status !== "Rejected"),
      ).toBe(true);
    }),
  20_000,
);

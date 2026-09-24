import {
  AcceptedOAuthServiceCredential,
  AuthorizationInstant,
  CredentialEvidenceRef,
  CredentialMechanismSchema,
  PrincipalSchema,
  ServicePrincipalId,
  ServicePrincipalGrantAuthorityError,
  ServicePrincipalReceiptGrantSchema,
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

      const grant = Schema.decodeUnknownSync(ServicePrincipalReceiptGrantSchema)({
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
    }),
  20_000,
);

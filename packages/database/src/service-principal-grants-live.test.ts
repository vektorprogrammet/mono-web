import {
  AUTHZ_LOCK_PROTOCOL,
  AuthorizationInstant,
  CredentialEvidenceRef,
  NATIVE_API_PROTECTED_RESOURCE,
  RECEIPT_APPROVAL_QUEUE_OPERATION,
  ServicePrincipalId,
  type AcceptedOAuthServiceCredential,
} from "@vektorprogrammet/domain/authz";
import { Effect } from "effect";
import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it } from "vitest";
import { makeServicePrincipalGrantAuthorityService } from "./service-principal-grants-live.js";

const authorizationInstant = AuthorizationInstant.make("2032-06-01T12:00:00.000Z");
const credential: AcceptedOAuthServiceCredential = {
  _tag: "Accepted",
  mechanism: { _tag: "OAuthServiceBearer" },
  principal: {
    _tag: "ServicePrincipal",
    servicePrincipalId: ServicePrincipalId.make("service-receipt-approval"),
  },
  evidenceRef: CredentialEvidenceRef.make(
    "oauth:ServicePrincipal:service-jti:service-receipt-approval-client:1969873200",
  ),
};

const persistedGrant = {
  grant_id: "service-receipt-approval-grant",
  service_principal_id: "service-receipt-approval",
  client_id: "service-receipt-approval-client",
  protected_resource: NATIVE_API_PROTECTED_RESOURCE,
  operation_id: RECEIPT_APPROVAL_QUEUE_OPERATION,
  capability_id: "approveReceipt",
  resource_kind: "receipt",
  resource_id: "service-receipt-approval-pending",
  start_at: new Date("2032-06-01T11:00:00.000Z"),
  end_at: null,
  revoked_at: null,
  grant_revision: 0,
};

const persistedRule = {
  rule_id: "service-receipt-pending-rule",
  capability_id: "approveReceipt",
  effect_kind: "requirement",
  subject_kind: "ServicePrincipal",
  subject_person_id: null,
  subject_tag_id: null,
  subject_service_principal_id: "service-receipt-approval",
  scope: "Resource",
  domain_id: null,
  department_id: null,
  resource_kind: "receipt",
  resource_id: "service-receipt-approval-pending",
  params: { requirementId: "receipts.pending", parameters: {} },
  start_at: new Date("2032-06-01T11:00:00.000Z"),
  end_at: null,
  revision: 0,
};

type RecordingPool = {
  readonly pool: Pool;
  readonly statements: Array<string>;
  readonly values: Array<ReadonlyArray<unknown>>;
};

const queryResult = <A extends Record<string, unknown>>(rows: ReadonlyArray<A>) =>
  ({ rows: [...rows], rowCount: rows.length }) as QueryResult<A>;

const recordingPool = (
  ruleRows: ReadonlyArray<Record<string, unknown>> = [persistedRule],
): RecordingPool => {
  const statements: Array<string> = [];
  const values: Array<ReadonlyArray<unknown>> = [];
  const client = {
    query: async (
      text: string,
      parameters: ReadonlyArray<unknown> = [],
    ): Promise<QueryResult<Record<string, unknown>>> => {
      statements.push(text);
      values.push(parameters);
      if (text.includes("FROM auth.oauth_access_token_state")) {
        return queryResult([{ client_id: "service-receipt-approval-client" }]);
      }
      if (text.includes("FROM public.service_principal_grants")) {
        return queryResult([
          {
            ...persistedGrant,
            owner_person_id: "service-receipt-owner",
            department_id: "service-receipt-department",
            receipt_status: "Pending",
            receipt_revision: 0,
          },
        ]);
      }
      if (text.includes("FROM public.authz_rules")) return queryResult(ruleRows);
      if (text.includes("INSERT INTO public.service_principal_grants")) {
        return queryResult([persistedGrant]);
      }
      return queryResult([]);
    },
    release: () => undefined,
  } as unknown as PoolClient;
  return {
    statements,
    values,
    pool: {
      connect: async () => client,
    } as unknown as Pool,
  };
};

const statementIndex = (statements: ReadonlyArray<string>, fragment: string): number =>
  statements.findIndex((statement) => statement.includes(fragment));

describe("service-principal grant PostgreSQL authority", () => {
  it("takes the shared authz lock before ordered grant and rule snapshot reads", async () => {
    const recording = recordingPool();
    const authority = await Effect.runPromise(
      makeServicePrincipalGrantAuthorityService(recording.pool).readReceiptApprovalCandidates(
        credential,
        authorizationInstant,
      ),
    );
    expect(authority.rules.map((rule) => rule.ruleId)).toEqual([
      "service-receipt-pending-rule",
    ]);
    const sharedLock = statementIndex(
      recording.statements,
      "pg_advisory_xact_lock_shared",
    );
    const tokenRead = statementIndex(recording.statements, "oauth_access_token_state");
    const grantRead = statementIndex(recording.statements, "service_principal_grants AS");
    const ruleRead = statementIndex(recording.statements, "FROM public.authz_rules");
    expect(recording.values[sharedLock]).toEqual([AUTHZ_LOCK_PROTOCOL.advisoryKey]);
    expect(AUTHZ_LOCK_PROTOCOL.rowOrder).toEqual([
      "public.authz_tag_assignments",
      "public.service_principal_grants",
      "public.authz_rules",
    ]);
    expect(recording.values[ruleRead]).toEqual([
      "service-receipt-approval",
      authorizationInstant,
      ["service-receipt-approval-pending"],
    ]);
    expect(recording.statements[ruleRead]).toContain("resource_id = ANY($3::text[])");
    expect(sharedLock).toBeGreaterThanOrEqual(0);
    expect(sharedLock).toBeLessThan(tokenRead);
    expect(tokenRead).toBeLessThan(grantRead);
    expect(grantRead).toBeLessThan(ruleRead);
  });

  it("fails the complete authority read when a current service rule is invalid", async () => {
    const recording = recordingPool([
      {
        ...persistedRule,
        effect_kind: "delegate",
        params: { slot: "EconomyDepartmentApprovalGrant" },
      },
    ]);
    await expect(
      Effect.runPromise(
        makeServicePrincipalGrantAuthorityService(recording.pool).readReceiptApprovalCandidates(
          credential,
          authorizationInstant,
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "ServicePrincipalGrantAuthorityError",
      reason: "PersistenceFailure",
    });
  });

  it("takes the exclusive authz lock before grant mutation and audit append", async () => {
    const recording = recordingPool();
    const created = await Effect.runPromise(
      makeServicePrincipalGrantAuthorityService(recording.pool).createGrant({
        grant: {
          grantId: "service-receipt-approval-grant" as never,
          servicePrincipalId: credential.principal.servicePrincipalId,
          clientId: "service-receipt-approval-client" as never,
          protectedResource: NATIVE_API_PROTECTED_RESOURCE,
          operationId: RECEIPT_APPROVAL_QUEUE_OPERATION,
          capabilityId: "approveReceipt",
          resourceKind: "receipt",
          receiptId: "service-receipt-approval-pending" as never,
          startAt: "2032-06-01T11:00:00.000Z" as never,
          endAt: null,
          revokedAt: null,
          revision: 0,
        },
        audit: {
          eventId: "service-receipt-approval-created",
          occurredAt: authorizationInstant,
          operatorActor: "operator",
          requestCorrelation: "service-receipt-approval-create",
        },
      }),
    );
    expect(created.grantId).toBe("service-receipt-approval-grant");
    const exclusiveLock = statementIndex(
      recording.statements,
      "pg_advisory_xact_lock(",
    );
    const mutation = statementIndex(
      recording.statements,
      "INSERT INTO public.service_principal_grants",
    );
    const audit = statementIndex(
      recording.statements,
      "INSERT INTO public.service_principal_grant_audit",
    );
    expect(exclusiveLock).toBeGreaterThanOrEqual(0);
    expect(exclusiveLock).toBeLessThan(mutation);
    expect(mutation).toBeLessThan(audit);
  });
});

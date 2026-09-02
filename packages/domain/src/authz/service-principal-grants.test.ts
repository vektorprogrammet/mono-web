import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AuthorizationInstant, CredentialEvidenceRef, ServicePrincipalId } from "./access.js";
import {
  NATIVE_API_PROTECTED_RESOURCE,
  RECEIPT_APPROVAL_QUEUE_OPERATION,
  composeServicePrincipalReceiptRuleRequirements,
  evaluateServicePrincipalReceiptApprovalAccess,
  makeServicePrincipalReceiptGrant,
  servicePrincipalReceiptGrantActiveAt,
  type AcceptedOAuthServiceCredential,
  type ServicePrincipalReceiptGrant,
  type ServicePrincipalReceiptGrantAuthority,
} from "./service-principal-grants.js";
import { authzRuleSubjectApplies } from "./rules.js";
import { AuthzRuleSchema, type AuthzRule } from "./schema.js";

const instant = AuthorizationInstant.make("2032-06-01T12:00:00.000Z");
const servicePrincipalId = ServicePrincipalId.make("service-receipt-approval");

const credential: AcceptedOAuthServiceCredential = {
  _tag: "Accepted",
  mechanism: { _tag: "OAuthServiceBearer" },
  principal: { _tag: "ServicePrincipal", servicePrincipalId },
  evidenceRef: CredentialEvidenceRef.make(
    "oauth:ServicePrincipal:service-jti:service-receipt-approval-client:1970000000",
  ),
};

const grant = (
  overrides: Partial<Record<keyof ServicePrincipalReceiptGrant, unknown>> = {},
): ServicePrincipalReceiptGrant =>
  makeServicePrincipalReceiptGrant({
    grantId: "service-receipt-approval-grant",
    servicePrincipalId,
    clientId: "service-receipt-approval-client",
    protectedResource: NATIVE_API_PROTECTED_RESOURCE,
    operationId: RECEIPT_APPROVAL_QUEUE_OPERATION,
    capabilityId: "approveReceipt",
    resourceKind: "receipt",
    receiptId: "service-receipt-approval-pending",
    startAt: "2032-06-01T11:00:00.000Z",
    endAt: null,
    revokedAt: null,
    revision: 0,
    ...overrides,
  });

const authority = (
  candidates: ServicePrincipalReceiptGrantAuthority["candidates"],
  rules: ReadonlyArray<AuthzRule> = [],
): ServicePrincipalReceiptGrantAuthority => ({
  servicePrincipalId,
  clientId: grant().clientId,
  protectedResource: NATIVE_API_PROTECTED_RESOURCE,
  candidates,
  rules,
});

const receipt = (
  receiptId: string,
  status: "Pending" | "Refunded" | "Rejected",
  resourceGrant: ServicePrincipalReceiptGrant,
): ServicePrincipalReceiptGrantAuthority["candidates"][number] => ({
  grant: resourceGrant,
  receipt: {
    receiptId:
      resourceGrant.receiptId === receiptId ? resourceGrant.receiptId : (receiptId as never),
    visualId: "SERVICE-1" as never,
    ownerPersonId: "service-receipt-owner" as never,
    departmentId: "service-receipt-department" as never,
    amountOre: "1250",
    currency: "NOK",
    description: "Service candidate",
    receiptDate: "2032-06-01",
    status,
    revision: 0,
  },
});

describe("service-principal receipt grants", () => {
  it("accepts only the exact closed resource binding", () => {
    expect(grant().operationId).toBe(RECEIPT_APPROVAL_QUEUE_OPERATION);
    expect(() => grant({ operationId: "receipts.listReceipts" })).toThrow();
    expect(() => grant({ capabilityId: "submitReceipt" })).toThrow();
    expect(() => grant({ resourceKind: "department" })).toThrow();
    expect(() =>
      makeServicePrincipalReceiptGrant({
        ...grant(),
        scope: { _tag: "Global" },
      }),
    ).toThrow();
  });

  it("uses start-inclusive, end-exclusive, immediate revocation semantics", () => {
    const ended = grant({ endAt: instant });
    expect(servicePrincipalReceiptGrantActiveAt(ended, instant)).toBe(false);
    expect(
      servicePrincipalReceiptGrantActiveAt(
        ended,
        AuthorizationInstant.make("2032-06-01T11:59:59.999Z"),
      ),
    ).toBe(true);
    expect(servicePrincipalReceiptGrantActiveAt(grant({ revokedAt: instant }), instant)).toBe(
      false,
    );
    expect(() => grant({ endAt: "2032-06-01T10:59:59.999Z" })).toThrow();
  });

  it("denies without an explicit active grant", () => {
    expect(
      evaluateServicePrincipalReceiptApprovalAccess(credential, authority([]), instant),
    ).toEqual({
      _tag: "Deny",
      stage: "Capability",
      reason: "CapabilityMissing",
    });
  });

  it("allows only the matching pending receipt and preserves per-receipt requirements", () => {
    const pendingGrant = grant();
    const nonpendingGrant = grant({
      grantId: "service-receipt-approval-nonpending-grant",
      receiptId: "service-receipt-approval-nonpending",
    });
    const evaluation = evaluateServicePrincipalReceiptApprovalAccess(
      credential,
      authority([
        receipt("service-receipt-approval-pending", "Pending", pendingGrant),
        receipt("service-receipt-approval-nonpending", "Refunded", nonpendingGrant),
      ]),
      instant,
    );
    expect(evaluation._tag).toBe("Allow");
    if (evaluation._tag !== "Allow") throw new TypeError("expected service receipt access");
    expect(evaluation.resolution.contexts.map((context) => context.resource?.id)).toEqual([
      "service-receipt-approval-pending",
    ]);
    expect(evaluation.resolution.contexts[0]?.facts.approverServicePrincipalIds).toEqual([
      servicePrincipalId,
    ]);
  });

  it("cannot use one grant for a different receipt", () => {
    const evaluation = evaluateServicePrincipalReceiptApprovalAccess(
      credential,
      authority([receipt("service-receipt-approval-foreign", "Pending", grant())]),
      instant,
    );
    expect(evaluation).toEqual({
      _tag: "Deny",
      stage: "Capability",
      reason: "CapabilityMissing",
    });
  });

  it("accepts only exact resource-scoped service requirement rules", () => {
    const serviceRule = {
      ruleId: "service-receipt-pending-rule",
      capabilityId: "approveReceipt",
      effectKind: "requirement",
      subject: { _tag: "ServicePrincipal", servicePrincipalId },
      scope: {
        _tag: "Resource",
        resource: { kind: "receipt", id: "service-receipt-approval-pending" },
      },
      params: {
        requirementId: "receipts.pending",
        parameters: {},
      },
      startAt: "2032-06-01T11:00:00.000Z",
      endAt: null,
      revision: 0,
    };
    const decoded = Schema.decodeUnknownSync(AuthzRuleSchema)(serviceRule, {
      onExcessProperty: "error",
    });
    expect(authzRuleSubjectApplies(decoded, credential.principal, instant, [])).toBe(true);
    expect(
      authzRuleSubjectApplies(
        decoded,
        { _tag: "Person", personId: "service-receipt-owner" as never },
        instant,
        [],
      ),
    ).toBe(false);
    expect(() =>
      Schema.decodeUnknownSync(AuthzRuleSchema)(
        {
          ...serviceRule,
          effectKind: "delegate",
          params: { slot: "EconomyDepartmentApprovalGrant" },
        },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AuthzRuleSchema)(
        { ...serviceRule, scope: { _tag: "Global" } },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
  });

  it("composes the service rule snapshot and denies ambiguous rule requirements", () => {
    const pendingGrant = grant();
    const candidate = receipt("service-receipt-approval-pending", "Pending", pendingGrant);
    const pendingRule = Schema.decodeUnknownSync(AuthzRuleSchema)(
      {
        ruleId: "service-receipt-pending-a",
        capabilityId: "approveReceipt",
        effectKind: "requirement",
        subject: { _tag: "ServicePrincipal", servicePrincipalId },
        scope: {
          _tag: "Resource",
          resource: { kind: "receipt", id: "service-receipt-approval-pending" },
        },
        params: { requirementId: "receipts.pending", parameters: {} },
        startAt: "2032-06-01T11:00:00.000Z",
        endAt: null,
        revision: 0,
      },
      { onExcessProperty: "error" },
    );
    const allowed = evaluateServicePrincipalReceiptApprovalAccess(
      credential,
      authority([candidate], [pendingRule]),
      instant,
    );
    expect(allowed._tag).toBe("Allow");
    if (allowed._tag !== "Allow") throw new TypeError("expected rule-composed access");
    const allowedContext = allowed.resolution.contexts[0];
    if (allowedContext === undefined) throw new TypeError("expected an allowed receipt context");
    const composition = composeServicePrincipalReceiptRuleRequirements(
      authority([candidate], [pendingRule]),
      allowedContext,
      instant,
    );
    expect(composition.contributingRuleIds).toEqual(["service-receipt-pending-a"]);
    expect(composition.requirements._tag).toBe("Satisfied");
    const failedComposition = composeServicePrincipalReceiptRuleRequirements(
      authority([candidate], [pendingRule]),
      {
        ...allowedContext,
        facts: { ...allowedContext.facts, state: "Rejected" },
      },
      instant,
    );
    expect(failedComposition.decision).toEqual({
      _tag: "Deny",
      reason: "RequirementFailed",
    });

    const conflictingRule = {
      ...pendingRule,
      ruleId: "service-receipt-pending-b",
      params: {
        requirementId: "receipts.pending",
        parameters: { conflicting: true },
      },
    } as unknown as AuthzRule;
    expect(
      evaluateServicePrincipalReceiptApprovalAccess(
        credential,
        authority([candidate], [pendingRule, conflictingRule]),
        instant,
      ),
    ).toEqual({
      _tag: "Deny",
      stage: "Requirement",
      reason: "RequirementFailed",
    });
  });
});

import { DepartmentId, PersonId } from "../organization/schema.js";
import { ReceiptId, ReceiptVisualId } from "../receipt/schema.js";
import { deny } from "./decision.js";
import { Predicate, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ResourceKind,
  ResourceId,
  ResourceRefSchema,
  AccessEvaluation,
  Scope,
  PrincipalSchema,
  CredentialMechanismSchema,
  AuthorizationInstant,
  CredentialEvidenceRef,
  ServicePrincipalId,
} from "./access.js";
import {
  ServicePrincipalReceiptGrantSchema,
  NATIVE_API_PROTECTED_RESOURCE,
  RECEIPT_APPROVAL_QUEUE_OPERATION,
  composeServicePrincipalReceiptRuleRequirements,
  evaluateServicePrincipalReceiptApprovalAccess,
  makeServicePrincipalReceiptGrant,
  servicePrincipalReceiptGrantActiveAt,
  AcceptedOAuthServiceCredential,
  type ServicePrincipalReceiptGrant,
  type ServicePrincipalReceiptGrantAuthority,
} from "./service-principal-grants.js";
import { authzRuleSubjectApplies } from "./rules.js";
import { AuthzRuleId, AuthzRuleSchema, type AuthzRule } from "./schema.js";

const instant = AuthorizationInstant.make("2032-06-01T12:00:00.000Z");

const servicePrincipalId = ServicePrincipalId.make("service-receipt-approval");

const credential: AcceptedOAuthServiceCredential = AcceptedOAuthServiceCredential.make({
  mechanism: CredentialMechanismSchema.cases.OAuthServiceBearer.make({}),
  principal: PrincipalSchema.cases.ServicePrincipal.make({ servicePrincipalId }),
  evidenceRef: CredentialEvidenceRef.make(
    "oauth:ServicePrincipal:service-jti:service-receipt-approval-client:1970000000",
  ),
});

const grant = (
  overrides: Partial<typeof ServicePrincipalReceiptGrantSchema.Encoded> = {},
): ServicePrincipalReceiptGrant =>
  makeServicePrincipalReceiptGrant({
    grantId: "service-receipt-approval-grant",
    servicePrincipalId,
    clientId: "service-receipt-approval-client",
    protectedResource: NATIVE_API_PROTECTED_RESOURCE,
    operationId: RECEIPT_APPROVAL_QUEUE_OPERATION,
    capabilityId: "approveReceipt",
    resourceKind: "receipt",
    receiptId: ReceiptId.make("service-receipt-approval-pending"),
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
  status: "Pending" | "Approved" | "Rejected",
  resourceGrant: ServicePrincipalReceiptGrant,
): ServicePrincipalReceiptGrantAuthority["candidates"][number] => ({
  grant: resourceGrant,
  receipt: {
    receiptId: ReceiptId.make(receiptId),
    visualId: ReceiptVisualId.make("SERVICE-1"),
    ownerPersonId: PersonId.make("service-receipt-owner"),
    departmentId: DepartmentId.make("service-receipt-department"),
    amountOre: "1250",
    currency: "NOK",
    description: "Service candidate",
    receiptDate: "2032-06-01",
    status,
    approvedAt: status === "Approved" ? "2032-06-02T00:00:00.000Z" : null,
    revision: 0,
  },
});

describe("service-principal receipt grants", () => {
  it("accepts only the exact closed resource binding", () => {
    expect(grant().operationId).toBe(RECEIPT_APPROVAL_QUEUE_OPERATION);
    expect(() =>
      makeServicePrincipalReceiptGrant({ ...grant(), operationId: "receipts.listReceipts" }),
    ).toThrow();
    expect(() =>
      makeServicePrincipalReceiptGrant({ ...grant(), capabilityId: "submitReceipt" }),
    ).toThrow();
    expect(() =>
      makeServicePrincipalReceiptGrant({ ...grant(), resourceKind: "department" }),
    ).toThrow();
    expect(() =>
      makeServicePrincipalReceiptGrant({
        ...grant(),
        scope: Scope.Global(),
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
    ).toEqual(AccessEvaluation.Deny({ stage: "Capability", reason: "CapabilityMissing" }));
  });

  it("lists explicitly granted receipts across statuses and preserves per-receipt authority", () => {
    const pendingGrant = grant();

    const nonpendingGrant = grant({
      grantId: "service-receipt-approval-nonpending-grant",
      receiptId: ReceiptId.make("service-receipt-approval-nonpending"),
    });

    const evaluation = evaluateServicePrincipalReceiptApprovalAccess(
      credential,
      authority([
        receipt("service-receipt-approval-pending", "Pending", pendingGrant),
        receipt("service-receipt-approval-nonpending", "Approved", nonpendingGrant),
      ]),
      instant,
    );

    expect(evaluation._tag).toBe("Allow");

    if (!Predicate.isTagged(evaluation, "Allow"))
      throw new TypeError("expected service receipt access");
    expect(evaluation.resolution.contexts.map((context) => context.resource?.id)).toEqual([
      "service-receipt-approval-nonpending",
      "service-receipt-approval-pending",
    ]);

    for (const context of evaluation.resolution.contexts)
      expect(context.facts.approverServicePrincipalIds).toEqual([servicePrincipalId]);
  });

  it("cannot use one grant for a different receipt", () => {
    const evaluation = evaluateServicePrincipalReceiptApprovalAccess(
      credential,
      authority([receipt("service-receipt-approval-foreign", "Pending", grant())]),
      instant,
    );

    expect(evaluation).toEqual(
      AccessEvaluation.Deny({ stage: "Capability", reason: "CapabilityMissing" }),
    );
  });

  it("accepts only exact resource-scoped service requirement rules", () => {
    const serviceRule = {
      ruleId: AuthzRuleId.make("service-receipt-pending-rule"),
      capabilityId: "approveReceipt",
      effectKind: "requirement",
      subject: PrincipalSchema.cases.ServicePrincipal.make({ servicePrincipalId }),
      scope: Scope.Resource({
        resource: ResourceRefSchema.make({
          kind: ResourceKind.make("receipt"),
          id: ResourceId.make("service-receipt-approval-pending"),
        }),
      }),
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
        PrincipalSchema.cases.Person.make({ personId: PersonId.make("service-receipt-owner") }),
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
        { ...serviceRule, scope: Scope.Global() },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
  });

  it("composes service rule snapshots and rejects invalid requirement parameters", () => {
    const pendingGrant = grant();
    const candidate = receipt("service-receipt-approval-pending", "Pending", pendingGrant);

    const pendingRule = Schema.decodeSync(AuthzRuleSchema)(
      {
        ruleId: AuthzRuleId.make("service-receipt-pending-a"),
        capabilityId: "approveReceipt",
        effectKind: "requirement",
        subject: PrincipalSchema.cases.ServicePrincipal.make({ servicePrincipalId }),
        scope: Scope.Resource({
          resource: ResourceRefSchema.make({
            kind: ResourceKind.make("receipt"),
            id: ResourceId.make("service-receipt-approval-pending"),
          }),
        }),
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

    if (!Predicate.isTagged(allowed, "Allow")) throw new TypeError("expected rule-composed access");
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

    expect(failedComposition.decision).toEqual(deny("RequirementFailed"));

    const conflictingRule = {
      ...pendingRule,
      ruleId: AuthzRuleId.make("service-receipt-pending-b"),
      params: {
        requirementId: "receipts.pending",
        parameters: { conflicting: true },
      },
    };

    expect(
      Schema.decodeUnknownResult(AuthzRuleSchema)(conflictingRule, { onExcessProperty: "error" })
        ._tag,
    ).toBe("Failure");
  });
});

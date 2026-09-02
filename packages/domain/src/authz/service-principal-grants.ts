import { Context, Data, Effect, Schema } from "effect";
import { DepartmentId, PersonId } from "../organization/schema.js";
import { ReceiptId, ReceiptStatusSchema } from "../receipt/schema.js";
import { compareRfc3339Instants } from "../time.js";
import {
  APPROVE_RECEIPT_CAPABILITY,
  AuthorityRef,
  AuthorizationInstant,
  AuthorityVersion,
  CredentialEvidenceRef,
  evaluateAccess,
  RECEIPT_APPROVAL_QUEUE_ACCESS,
  type AccessEvaluation,
  type CanonicalResourceContext,
  type Grant,
  GrantId,
  makeGrant,
  RECEIPT_DOMAIN_ID,
  RECEIPT_RESOURCE_KIND,
  type ReceiptAccessFacts,
  ResourceId,
  ServicePrincipalId,
} from "./access.js";
import { composeCapabilityEvidence } from "./rules.js";
import type { AuthzRule } from "./schema.js";

const TrimmedNonEmpty = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.length > 0 && value.trim() === value, {
      message: "a trimmed non-empty string",
    }),
  ),
);
const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

export const NATIVE_API_PROTECTED_RESOURCE = "urn:vektorprogrammet:native-api" as const;
export const RECEIPT_APPROVAL_QUEUE_OPERATION = "receipts.listReceiptsForApproval" as const;

export const OAuthClientId = TrimmedNonEmpty.pipe(Schema.brand("OAuthClientId"));
export type OAuthClientId = typeof OAuthClientId.Type;

export const ServicePrincipalReceiptGrantSchema = Schema.Struct({
  grantId: GrantId,
  servicePrincipalId: ServicePrincipalId,
  clientId: OAuthClientId,
  protectedResource: Schema.Literal(NATIVE_API_PROTECTED_RESOURCE),
  operationId: Schema.Literal(RECEIPT_APPROVAL_QUEUE_OPERATION),
  capabilityId: Schema.Literal("approveReceipt"),
  resourceKind: Schema.Literal("receipt"),
  receiptId: ReceiptId,
  startAt: AuthorizationInstant,
  endAt: Schema.NullOr(AuthorizationInstant),
  revokedAt: Schema.NullOr(AuthorizationInstant),
  revision: Revision,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (grant) =>
        (grant.endAt === null || compareRfc3339Instants(grant.endAt, grant.startAt) > 0) &&
        (grant.revokedAt === null || compareRfc3339Instants(grant.revokedAt, grant.startAt) >= 0),
      { message: "an ordered service-principal receipt grant" },
    ),
  ),
);
export type ServicePrincipalReceiptGrant =
  typeof ServicePrincipalReceiptGrantSchema.Type;
export type AcceptedOAuthServiceCredential = {
  readonly _tag: "Accepted";
  readonly mechanism: { readonly _tag: "OAuthServiceBearer" };
  readonly principal: {
    readonly _tag: "ServicePrincipal";
    readonly servicePrincipalId: ServicePrincipalId;
  };
  readonly evidenceRef: CredentialEvidenceRef;
};

export const ServicePrincipalReceiptCandidateSchema = Schema.Struct({
  receiptId: ReceiptId,
  ownerPersonId: PersonId,
  departmentId: DepartmentId,
  status: ReceiptStatusSchema,
  revision: Revision,
});
export type ServicePrincipalReceiptCandidate =
  typeof ServicePrincipalReceiptCandidateSchema.Type;

export type ServicePrincipalReceiptGrantCandidate = {
  readonly grant: ServicePrincipalReceiptGrant;
  readonly receipt: ServicePrincipalReceiptCandidate;
};

export type ServicePrincipalReceiptGrantAuthority = {
  readonly servicePrincipalId: ServicePrincipalId;
  readonly clientId: OAuthClientId;
  readonly protectedResource: typeof NATIVE_API_PROTECTED_RESOURCE;
  readonly candidates: ReadonlyArray<ServicePrincipalReceiptGrantCandidate>;
  readonly rules: ReadonlyArray<AuthzRule>;
};
const BoundedAuditText = TrimmedNonEmpty.pipe(
  Schema.check(Schema.isMaxLength(160)),
);

export const ServicePrincipalGrantAuditContextSchema = Schema.Struct({
  eventId: BoundedAuditText,
  occurredAt: AuthorizationInstant,
  operatorActor: BoundedAuditText,
  requestCorrelation: BoundedAuditText,
});
export type ServicePrincipalGrantAuditContext =
  typeof ServicePrincipalGrantAuditContextSchema.Type;

export const CreateServicePrincipalGrantInputSchema = Schema.Struct({
  grant: ServicePrincipalReceiptGrantSchema,
  audit: ServicePrincipalGrantAuditContextSchema,
});
export type CreateServicePrincipalGrantInput =
  typeof CreateServicePrincipalGrantInputSchema.Type;

export const EndServicePrincipalGrantInputSchema = Schema.Struct({
  grantId: GrantId,
  endAt: AuthorizationInstant,
  expectedRevision: Revision,
  audit: ServicePrincipalGrantAuditContextSchema,
});
export type EndServicePrincipalGrantInput =
  typeof EndServicePrincipalGrantInputSchema.Type;

export const RevokeServicePrincipalGrantInputSchema = Schema.Struct({
  grantId: GrantId,
  revokedAt: AuthorizationInstant,
  expectedRevision: Revision,
  audit: ServicePrincipalGrantAuditContextSchema,
});
export type RevokeServicePrincipalGrantInput =
  typeof RevokeServicePrincipalGrantInputSchema.Type;

export class ServicePrincipalGrantAuthorityError extends Data.TaggedError(
  "ServicePrincipalGrantAuthorityError",
)<{
  readonly reason:
    | "InvalidCredentialEvidence"
    | "CurrentBindingRejected"
    | "MutationRejected"
    | "PersistenceFailure";
  readonly message: string;
}> {}

export interface ServicePrincipalGrantAuthorityShape {
  readonly readReceiptApprovalCandidates: (
    credential: AcceptedOAuthServiceCredential,
    authorizationInstant: AuthorizationInstant,
  ) => Effect.Effect<
    ServicePrincipalReceiptGrantAuthority,
    ServicePrincipalGrantAuthorityError
  >;
  readonly createGrant: (
    input: CreateServicePrincipalGrantInput,
  ) => Effect.Effect<ServicePrincipalReceiptGrant, ServicePrincipalGrantAuthorityError>;
  readonly endGrant: (
    input: EndServicePrincipalGrantInput,
  ) => Effect.Effect<ServicePrincipalReceiptGrant, ServicePrincipalGrantAuthorityError>;
  readonly revokeGrant: (
    input: RevokeServicePrincipalGrantInput,
  ) => Effect.Effect<ServicePrincipalReceiptGrant, ServicePrincipalGrantAuthorityError>;
}

export class ServicePrincipalGrantAuthority extends Context.Service<
  ServicePrincipalGrantAuthority,
  ServicePrincipalGrantAuthorityShape
>()("@vektorprogrammet/domain/ServicePrincipalGrantAuthority") {}

export const makeServicePrincipalReceiptGrant = (input: unknown): ServicePrincipalReceiptGrant =>
  Schema.decodeUnknownSync(ServicePrincipalReceiptGrantSchema)(input, {
    onExcessProperty: "error",
  });

export const composeServicePrincipalReceiptRuleRequirements = (
  authority: ServicePrincipalReceiptGrantAuthority,
  context: CanonicalResourceContext<ReceiptAccessFacts>,
  authorizationInstant: AuthorizationInstant,
) =>
  composeCapabilityEvidence(
    "approveReceipt",
    {},
    authority.rules,
    {
      principal: {
        _tag: "ServicePrincipal",
        servicePrincipalId: authority.servicePrincipalId,
      },
      authorizationInstant,
      context,
      tagAssignments: [],
    },
  );
export const evaluateServicePrincipalReceiptApprovalAccess = (
  credential: AcceptedOAuthServiceCredential,
  authority: ServicePrincipalReceiptGrantAuthority,
  authorizationInstant: AuthorizationInstant,
): AccessEvaluation<ReceiptAccessFacts> => {
  if (
    credential.principal.servicePrincipalId !== authority.servicePrincipalId ||
    authority.protectedResource !== NATIVE_API_PROTECTED_RESOURCE
  ) {
    return {
      _tag: "Deny",
      stage: "PrincipalKind",
      reason: "PrincipalKindNotAccepted",
    };
  }

  const candidateByReceipt = new Map<
    string,
    ServicePrincipalReceiptGrantCandidate
  >();
  const activeGrants: Array<ServicePrincipalReceiptGrant> = [];
  for (const candidate of authority.candidates) {
    const grant = candidate.grant;
    if (
      grant.servicePrincipalId !== authority.servicePrincipalId ||
      grant.clientId !== authority.clientId ||
      grant.protectedResource !== authority.protectedResource ||
      grant.operationId !== RECEIPT_APPROVAL_QUEUE_OPERATION ||
      grant.capabilityId !== "approveReceipt" ||
      grant.resourceKind !== RECEIPT_RESOURCE_KIND ||
      grant.receiptId !== candidate.receipt.receiptId ||
      !servicePrincipalReceiptGrantActiveAt(grant, authorizationInstant)
    ) {
      continue;
    }
    activeGrants.push(grant);
    if (!candidateByReceipt.has(candidate.receipt.receiptId)) {
      candidateByReceipt.set(candidate.receipt.receiptId, candidate);
    }
  }

  if (activeGrants.length === 0) {
    return {
      _tag: "Deny",
      stage: "Capability",
      reason: "CapabilityMissing",
    };
  }

  const contexts = [...candidateByReceipt.values()]
    .sort((left, right) => compareText(left.receipt.receiptId, right.receipt.receiptId))
    .map(({ receipt }) => ({
      domainId: RECEIPT_DOMAIN_ID,
      departmentId: receipt.departmentId,
      resource: {
        kind: RECEIPT_RESOURCE_KIND,
        id: ResourceId.make(receipt.receiptId),
      },
      facts: {
        ownerPersonId: receipt.ownerPersonId,
        state: receipt.status,
        approverPersonIds: [],
        approverServicePrincipalIds: [authority.servicePrincipalId],
        internalEvidenceEnabled: false,
      },
      authorityVersion: AuthorityVersion.make(
        [
          `service-principal:${authority.servicePrincipalId}`,
          `client:${authority.clientId}`,
          `receipt:${receipt.receiptId}:${receipt.revision}`,
          ...activeGrants
            .filter((grant) => grant.receiptId === receipt.receiptId)
            .map((grant) => `grant:${grant.grantId}:${grant.revision}`)
            .sort(compareText),
          ...authority.rules
            .map((rule) => `rule:${rule.ruleId}:${rule.revision}`)
            .sort(compareText),
        ].join("|"),
      ),
    }));

  const baseEvaluation = evaluateAccess({
    spec: RECEIPT_APPROVAL_QUEUE_ACCESS,
    credential,
    resolution: {
      selection: "AllMatching",
      contexts,
    },
    grants: activeGrants
      .sort((left, right) => compareText(left.grantId, right.grantId))
      .map(servicePrincipalReceiptGrantToAccessGrant),
    authorizationInstant,
  });
  if (baseEvaluation._tag !== "Allow") return baseEvaluation;

  const allowedContexts = baseEvaluation.resolution.contexts.filter((context) => {
    const composition = composeServicePrincipalReceiptRuleRequirements(
      authority,
      context,
      authorizationInstant,
    );
    return composition.decision._tag === "Allow";
  });
  if (allowedContexts.length === 0) {
    return {
      _tag: "Deny",
      stage: "Requirement",
      reason: "RequirementFailed",
    };
  }
  return {
    ...baseEvaluation,
    resolution: {
      ...baseEvaluation.resolution,
      contexts: allowedContexts,
    },
  };
};

export const servicePrincipalReceiptGrantActiveAt = (
  grant: ServicePrincipalReceiptGrant,
  authorizationInstant: AuthorizationInstant,
): boolean =>
  grant.revokedAt === null &&
  compareRfc3339Instants(grant.startAt, authorizationInstant) <= 0 &&
  (grant.endAt === null || compareRfc3339Instants(authorizationInstant, grant.endAt) < 0);

export const servicePrincipalReceiptGrantToAccessGrant = (
  grant: ServicePrincipalReceiptGrant,
): Grant =>
  makeGrant({
    grantId: grant.grantId,
    subject: {
      _tag: "ServicePrincipal",
      servicePrincipalId: grant.servicePrincipalId,
    },
    capability: { type: APPROVE_RECEIPT_CAPABILITY },
    scope: {
      _tag: "Resource",
      resource: {
        kind: RECEIPT_RESOURCE_KIND,
        id: ResourceId.make(grant.receiptId),
      },
    },
    startAt: grant.startAt,
    endAt: grant.endAt,
    requirements: [],
    source: AuthorityRef.make(`service-principal-grant:${grant.grantId}`),
    revision: grant.revision,
  });

const compareText = (left: string, right: string): -1 | 0 | 1 =>
  left < right ? -1 : left > right ? 1 : 0;

export const activeServicePrincipalReceiptGrants = (
  grants: ReadonlyArray<ServicePrincipalReceiptGrant>,
  servicePrincipalId: ServicePrincipalId,
  authorizationInstant: AuthorizationInstant,
): ReadonlyArray<ServicePrincipalReceiptGrant> =>
  [
    ...new Map(
      grants
        .filter(
          (grant) =>
            grant.servicePrincipalId === servicePrincipalId &&
            servicePrincipalReceiptGrantActiveAt(grant, authorizationInstant),
        )
        .map((grant) => [grant.grantId, grant]),
    ).values(),
  ].sort((left, right) => compareText(left.grantId, right.grantId));

export const servicePrincipalApproverIdsForContext = (
  grants: ReadonlyArray<ServicePrincipalReceiptGrant>,
  context: CanonicalResourceContext,
  authorizationInstant: AuthorizationInstant,
): ReadonlyArray<ServicePrincipalId> => {
  if (context.resource === null || context.resource.kind !== RECEIPT_RESOURCE_KIND) return [];
  return [
    ...new Set(
      grants
        .filter(
          (grant) =>
            servicePrincipalReceiptGrantActiveAt(grant, authorizationInstant) &&
            ResourceId.make(grant.receiptId) === context.resource?.id,
        )
        .map((grant) => grant.servicePrincipalId),
    ),
  ].sort(compareText);
};

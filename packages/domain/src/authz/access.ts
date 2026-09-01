import { Effect, Schema } from "effect";
import { DepartmentId, PersonId } from "../organization/schema.js";
import { compareRfc3339Instants, Rfc3339InstantSchema } from "../time.js";

const TrimmedNonEmpty = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.length > 0 && value.trim() === value, {
      message: "a trimmed non-empty string",
    }),
  ),
);
const RevisionSchema = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const EmptyRequirementParametersSchema = Schema.Record(Schema.String, Schema.Never);

export const ServicePrincipalId = TrimmedNonEmpty.pipe(Schema.brand("ServicePrincipalId"));
export type ServicePrincipalId = typeof ServicePrincipalId.Type;
export const CapabilityId = TrimmedNonEmpty.pipe(Schema.brand("CapabilityId"));
export type CapabilityId = typeof CapabilityId.Type;
export const GrantId = TrimmedNonEmpty.pipe(Schema.brand("GrantId"));
export type GrantId = typeof GrantId.Type;
export const AuthorityRef = TrimmedNonEmpty.pipe(Schema.brand("AuthorityRef"));
export type AuthorityRef = typeof AuthorityRef.Type;
export const AuthorityVersion = TrimmedNonEmpty.pipe(Schema.brand("AuthorityVersion"));
export type AuthorityVersion = typeof AuthorityVersion.Type;
export const AuthorizationInstant = Rfc3339InstantSchema.pipe(Schema.brand("AuthorizationInstant"));
export type AuthorizationInstant = typeof AuthorizationInstant.Type;

export const CAPABILITY_TYPE_IDS = [
  "approveReceipt",
  "submitReceipt",
  "reviewApplicants",
  "recruitment.invitation-response",
  "receipts.read-internal-evidence",
] as const;
const ruleTargetCapabilityTypeIds: ReadonlySet<(typeof CAPABILITY_TYPE_IDS)[number]> = new Set([
  "approveReceipt",
  "submitReceipt",
  "reviewApplicants",
]);
export const CAPABILITY_TYPES = Object.fromEntries(
  CAPABILITY_TYPE_IDS.map((id) => [
    id,
    {
      ruleTarget: ruleTargetCapabilityTypeIds.has(id),
      objectCapability: id === "recruitment.invitation-response",
    },
  ]),
) as {
  readonly [Id in (typeof CAPABILITY_TYPE_IDS)[number]]: {
    readonly ruleTarget: boolean;
    readonly objectCapability: boolean;
  };
};
export const CapabilityTypeId = Schema.Literals(CAPABILITY_TYPE_IDS).pipe(
  Schema.brand("CapabilityTypeId"),
);
export type CapabilityTypeId = typeof CapabilityTypeId.Type;
export const APPROVE_RECEIPT_CAPABILITY = CapabilityTypeId.make("approveReceipt");
export const OBJECT_CAPABILITY_TYPE_IDS: ReadonlyArray<CapabilityTypeId> =
  CAPABILITY_TYPE_IDS.filter((id) => CAPABILITY_TYPES[id].objectCapability).map((id) =>
    CapabilityTypeId.make(id),
  );
export const SUBMIT_RECEIPT_CAPABILITY = CapabilityTypeId.make("submitReceipt");
export const INVITATION_RESPONSE_CAPABILITY = CapabilityTypeId.make(
  "recruitment.invitation-response",
);
export const READ_INTERNAL_RECEIPT_EVIDENCE_CAPABILITY = CapabilityTypeId.make(
  "receipts.read-internal-evidence",
);

export const DOMAIN_ID_VALUES = [
  "admissions",
  "content",
  "identity",
  "organization",
  "profile",
  "receipts",
  "recruitment",
  "schools",
  "system",
] as const;
export const DOMAIN_IDS = Object.fromEntries(DOMAIN_ID_VALUES.map((id) => [id, true])) as {
  readonly [Id in (typeof DOMAIN_ID_VALUES)[number]]: true;
};
export const DomainId = Schema.Literals(DOMAIN_ID_VALUES).pipe(Schema.brand("DomainId"));
export type DomainId = typeof DomainId.Type;
export const RECEIPT_DOMAIN_ID = DomainId.make("receipts");
export const SYSTEM_DOMAIN_ID = DomainId.make("system");

export const RESOURCE_KIND_VALUES = ["receipt", "recruitment-invitation"] as const;
export const RESOURCE_KINDS = Object.fromEntries(
  RESOURCE_KIND_VALUES.map((kind) => [kind, true]),
) as {
  readonly [Kind in (typeof RESOURCE_KIND_VALUES)[number]]: true;
};
export const ResourceKind = Schema.Literals(RESOURCE_KIND_VALUES).pipe(
  Schema.brand("ResourceKind"),
);
export type ResourceKind = typeof ResourceKind.Type;
export const RECEIPT_RESOURCE_KIND = ResourceKind.make("receipt");
export const RECRUITMENT_INVITATION_RESOURCE_KIND = ResourceKind.make("recruitment-invitation");
export const ResourceId = TrimmedNonEmpty.pipe(Schema.brand("ResourceId"));
export type ResourceId = typeof ResourceId.Type;

export const REQUIREMENT_IDS = [
  "internal-evidence.enabled",
  "receipts.owner",
  "receipts.pending",
  "receipts.approver-relationship",
] as const;
export const RequirementId = Schema.Literals(REQUIREMENT_IDS).pipe(Schema.brand("RequirementId"));
const requirementRegistryKey = (id: RequirementId): (typeof REQUIREMENT_IDS)[number] => id;
export type RequirementId = typeof RequirementId.Type;
export const INTERNAL_EVIDENCE_ENABLED_REQUIREMENT = RequirementId.make(
  "internal-evidence.enabled",
);
export const RECEIPT_OWNER_REQUIREMENT = RequirementId.make("receipts.owner");
export const RECEIPT_PENDING_REQUIREMENT = RequirementId.make("receipts.pending");
export const RECEIPT_APPROVER_REQUIREMENT = RequirementId.make("receipts.approver-relationship");

export const SCOPE_RESOLVER_IDS = ["receipts.by-id", "system.public"] as const;
export const ScopeResolverId = Schema.Literals(SCOPE_RESOLVER_IDS).pipe(
  Schema.brand("ScopeResolverId"),
);
const scopeResolverRegistryKey = (id: ScopeResolverId): (typeof SCOPE_RESOLVER_IDS)[number] => id;
export type ScopeResolverId = typeof ScopeResolverId.Type;
export const RECEIPT_BY_ID_SCOPE_RESOLVER = ScopeResolverId.make("receipts.by-id");
export const SYSTEM_PUBLIC_SCOPE_RESOLVER = ScopeResolverId.make("system.public");

export const PrincipalSchema = Schema.TaggedUnion({
  Anonymous: {},
  Person: { personId: PersonId },
  ServicePrincipal: { servicePrincipalId: ServicePrincipalId },
  CapabilityHolder: { capabilityId: CapabilityId },
});
export type Principal = typeof PrincipalSchema.Type;
export type PrincipalKind = Principal["_tag"];
const NonAnonymousPrincipalSchema = Schema.Union([
  Schema.TaggedStruct("Person", { personId: PersonId }),
  Schema.TaggedStruct("ServicePrincipal", { servicePrincipalId: ServicePrincipalId }),
  Schema.TaggedStruct("CapabilityHolder", { capabilityId: CapabilityId }),
]);
export type NonAnonymousPrincipal = typeof NonAnonymousPrincipalSchema.Type;
export const PRINCIPAL_KINDS = [
  "Anonymous",
  "Person",
  "ServicePrincipal",
  "CapabilityHolder",
] as const;
export const PrincipalKindSchema = Schema.Literals(PRINCIPAL_KINDS);

export const CREDENTIAL_MECHANISM_KINDS = [
  "None",
  "BetterAuthCookie",
  "OAuthUserBearer",
  "OAuthServiceBearer",
  "ObjectCapability",
] as const;
export const CredentialMechanismSchema = Schema.TaggedUnion({
  None: {},
  BetterAuthCookie: {},
  OAuthUserBearer: {},
  OAuthServiceBearer: {},
  ObjectCapability: { capabilityType: CapabilityTypeId },
});
export type CredentialMechanism = typeof CredentialMechanismSchema.Type;
export const CredentialEvidenceRef = TrimmedNonEmpty.pipe(Schema.brand("CredentialEvidenceRef"));
export type CredentialEvidenceRef = typeof CredentialEvidenceRef.Type;
export const CredentialFailureReasonSchema = Schema.Literals([
  "Missing",
  "Malformed",
  "Invalid",
  "Expired",
  "Revoked",
  "WrongMechanism",
  "AmbiguousMechanism",
]);
export type CredentialFailureReason = typeof CredentialFailureReasonSchema.Type;
export const CredentialOutcomeSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literals(["Accepted"]),
    mechanism: CredentialMechanismSchema,
    principal: PrincipalSchema,
    evidenceRef: CredentialEvidenceRef,
  }),
  Schema.Struct({
    _tag: Schema.Literals(["Rejected"]),
    reason: CredentialFailureReasonSchema,
  }),
]);
export type CredentialOutcome = typeof CredentialOutcomeSchema.Type;

export const CapabilitySchema = Schema.Struct({ type: CapabilityTypeId });
export type Capability = typeof CapabilitySchema.Type;
const CapabilityListSchema = Schema.Array(CapabilitySchema).pipe(
  Schema.check(
    Schema.makeFilter(
      (capabilities) =>
        capabilities.length > 0 &&
        new Set(capabilities.map((capability) => capability.type)).size === capabilities.length,
      { message: "a non-empty capability list without duplicate types" },
    ),
  ),
);
export const CapabilityExpressionSchema = Schema.TaggedUnion({
  None: {},
  One: { capability: CapabilitySchema },
  All: { capabilities: CapabilityListSchema },
  Any: { capabilities: CapabilityListSchema },
});
export type CapabilityExpression = typeof CapabilityExpressionSchema.Type;

export const ResourceRefSchema = Schema.Struct({
  kind: ResourceKind,
  id: ResourceId,
});
export type ResourceRef = typeof ResourceRefSchema.Type;
type EncodedResourceRef = typeof ResourceRefSchema.Encoded;
export type Scope =
  | { readonly _tag: "Global" }
  | { readonly _tag: "Domain"; readonly domainId: DomainId }
  | { readonly _tag: "Department"; readonly departmentId: DepartmentId }
  | { readonly _tag: "Resource"; readonly resource: ResourceRef }
  | { readonly _tag: "And"; readonly left: Scope; readonly right: Scope }
  | { readonly _tag: "Or"; readonly left: Scope; readonly right: Scope };
type EncodedScope =
  | { readonly _tag: "Global" }
  | { readonly _tag: "Domain"; readonly domainId: typeof DomainId.Encoded }
  | { readonly _tag: "Department"; readonly departmentId: string }
  | { readonly _tag: "Resource"; readonly resource: EncodedResourceRef }
  | { readonly _tag: "And"; readonly left: EncodedScope; readonly right: EncodedScope }
  | { readonly _tag: "Or"; readonly left: EncodedScope; readonly right: EncodedScope };
const ScopeNodeSchema: Schema.Codec<Scope, EncodedScope> = Schema.TaggedUnion({
  Global: {},
  Domain: { domainId: DomainId },
  Department: { departmentId: DepartmentId },
  Resource: { resource: ResourceRefSchema },
  And: {
    left: Schema.suspend((): Schema.Codec<Scope, EncodedScope> => ScopeSchema),
    right: Schema.suspend((): Schema.Codec<Scope, EncodedScope> => ScopeSchema),
  },
  Or: {
    left: Schema.suspend((): Schema.Codec<Scope, EncodedScope> => ScopeSchema),
    right: Schema.suspend((): Schema.Codec<Scope, EncodedScope> => ScopeSchema),
  },
});
const scopeDepth = (scope: Scope): number =>
  scope._tag === "And" || scope._tag === "Or"
    ? 1 + Math.max(scopeDepth(scope.left), scopeDepth(scope.right))
    : 1;
export const ScopeSchema: Schema.Codec<Scope, EncodedScope> = ScopeNodeSchema.pipe(
  Schema.check(
    Schema.makeFilter((scope) => scopeDepth(scope) <= 16 && JSON.stringify(scope).length <= 4_096, {
      message: "a scope with at most 16 levels and 4096 encoded bytes",
    }),
  ),
);

export const ReceiptAccessFactsSchema = Schema.Struct({
  ownerPersonId: PersonId,
  state: Schema.String,
  approverPersonIds: Schema.Array(PersonId),
  internalEvidenceEnabled: Schema.Boolean,
});
export type ReceiptAccessFacts = typeof ReceiptAccessFactsSchema.Type;
export interface CanonicalResourceContext<C = unknown> {
  readonly domainId: DomainId;
  readonly departmentId: DepartmentId | null;
  readonly resource: ResourceRef | null;
  readonly facts: C;
  readonly authorityVersion: AuthorityVersion;
}
export interface CanonicalScopeResolution<C = unknown> {
  readonly selection: "ExactlyOne" | "AllMatching";
  readonly contexts: ReadonlyArray<CanonicalResourceContext<C>>;
}

const ReceiptRequirementContextSchema = Schema.Struct({
  domainId: DomainId,
  departmentId: Schema.NullOr(DepartmentId),
  resource: Schema.NullOr(ResourceRefSchema),
  facts: ReceiptAccessFactsSchema,
  authorityVersion: AuthorityVersion,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (context) =>
        context.domainId === RECEIPT_DOMAIN_ID &&
        context.resource !== null &&
        context.resource.kind === RECEIPT_RESOURCE_KIND,
      { message: "a canonical receipt resource context" },
    ),
  ),
);
const PublicResourceContextSchema = Schema.Struct({
  domainId: DomainId,
  departmentId: Schema.NullOr(DepartmentId),
  resource: Schema.NullOr(ResourceRefSchema),
  facts: Schema.Record(Schema.String, Schema.Unknown),
  authorityVersion: AuthorityVersion,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (context) => context.domainId === SYSTEM_DOMAIN_ID && context.resource === null,
      { message: "a canonical public system context" },
    ),
  ),
);

type RegisteredRequirementEvaluation =
  | { readonly _tag: "Satisfied" }
  | { readonly _tag: "Failed"; readonly reason: string };
type RequirementEvaluator = (
  parameters: typeof EmptyRequirementParametersSchema.Type,
  principal: Principal,
  context: typeof ReceiptRequirementContextSchema.Type,
) => RegisteredRequirementEvaluation;
const requirementEvaluators = [
  (
    _parameters: typeof EmptyRequirementParametersSchema.Type,
    _principal: Principal,
    context: typeof ReceiptRequirementContextSchema.Type,
  ): RegisteredRequirementEvaluation =>
    context.facts.internalEvidenceEnabled
      ? { _tag: "Satisfied" }
      : { _tag: "Failed", reason: "Disabled" },
  (
    _parameters: typeof EmptyRequirementParametersSchema.Type,
    principal: Principal,
    context: typeof ReceiptRequirementContextSchema.Type,
  ): RegisteredRequirementEvaluation =>
    principal._tag === "Person" && principal.personId === context.facts.ownerPersonId
      ? { _tag: "Satisfied" }
      : { _tag: "Failed", reason: "NotOwner" },
  (
    _parameters: typeof EmptyRequirementParametersSchema.Type,
    _principal: Principal,
    context: typeof ReceiptRequirementContextSchema.Type,
  ): RegisteredRequirementEvaluation =>
    context.facts.state === "Pending"
      ? { _tag: "Satisfied" }
      : { _tag: "Failed", reason: "NotPending" },
  (
    _parameters: typeof EmptyRequirementParametersSchema.Type,
    principal: Principal,
    context: typeof ReceiptRequirementContextSchema.Type,
  ): RegisteredRequirementEvaluation =>
    principal._tag === "Person" && context.facts.approverPersonIds.includes(principal.personId)
      ? { _tag: "Satisfied" }
      : { _tag: "Failed", reason: "NotApprover" },
] as const satisfies ReadonlyArray<RequirementEvaluator>;
export const REQUIREMENT_TYPES = Object.fromEntries(
  REQUIREMENT_IDS.map((id, index) => [
    id,
    {
      resolverIds: [RECEIPT_BY_ID_SCOPE_RESOLVER],
      parameterSchema: EmptyRequirementParametersSchema,
      contextSchema: ReceiptRequirementContextSchema,
      evaluate: requirementEvaluators[index]!,
    },
  ]),
) as unknown as {
  readonly [Id in (typeof REQUIREMENT_IDS)[number]]: {
    readonly resolverIds: readonly [ScopeResolverId];
    readonly parameterSchema: typeof EmptyRequirementParametersSchema;
    readonly contextSchema: typeof ReceiptRequirementContextSchema;
    readonly evaluate: RequirementEvaluator;
  };
};

const scopeResolverRegistrations = [
  {
    selection: "ExactlyOne",
    requirements: REQUIREMENT_IDS,
    contextSchema: ReceiptRequirementContextSchema,
  },
  {
    selection: "ExactlyOne",
    requirements: [],
    contextSchema: PublicResourceContextSchema,
  },
] as const;
export const SCOPE_RESOLVERS = Object.fromEntries(
  SCOPE_RESOLVER_IDS.map((id, index) => [id, scopeResolverRegistrations[index]!]),
) as {
  readonly [Id in (typeof SCOPE_RESOLVER_IDS)[number]]: (typeof scopeResolverRegistrations)[number];
};

const registeredRequirementSchemas = REQUIREMENT_IDS.map((id) =>
  Schema.Struct({
    id: RequirementId.pipe(
      Schema.check(
        Schema.makeFilter((requirementId) => requirementId === id, {
          message: `requirement id ${id}`,
        }),
      ),
    ),
    parameters: REQUIREMENT_TYPES[id].parameterSchema,
  }),
);
export const TypedRequirementSchema = Schema.Union(
  registeredRequirementSchemas as unknown as readonly [
    (typeof registeredRequirementSchemas)[number],
    ...(typeof registeredRequirementSchemas)[number][],
  ],
);
export type TypedRequirement = typeof TypedRequirementSchema.Type;
export type RequirementResult =
  | { readonly id: RequirementId; readonly _tag: "Satisfied" }
  | { readonly id: RequirementId; readonly _tag: "Failed"; readonly reason: string };

export const GrantSchema = Schema.Struct({
  grantId: GrantId,
  subject: NonAnonymousPrincipalSchema,
  capability: CapabilitySchema,
  scope: ScopeSchema,
  startAt: AuthorizationInstant,
  endAt: Schema.NullOr(AuthorizationInstant),
  requirements: Schema.Array(TypedRequirementSchema),
  source: AuthorityRef,
  revision: RevisionSchema,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (grant) => grant.endAt === null || compareRfc3339Instants(grant.endAt, grant.startAt) > 0,
      { message: "a half-open grant interval" },
    ),
  ),
);
export type Grant = typeof GrantSchema.Type;
export type RoleMacro = {
  readonly roleId: string;
  readonly grants: ReadonlyArray<Grant>;
};

export const assertRequirementRegistration = (
  resolverId: ScopeResolverId,
  requirementId: RequirementId,
): void => {
  const resolver = SCOPE_RESOLVERS[scopeResolverRegistryKey(resolverId)];
  const requirement = REQUIREMENT_TYPES[requirementRegistryKey(requirementId)];
  const registeredResolverIds: ReadonlyArray<ScopeResolverId> = requirement.resolverIds;
  const registeredRequirements: ReadonlyArray<string> = resolver.requirements;
  if (
    !registeredResolverIds.includes(resolverId) ||
    !registeredRequirements.includes(requirementId) ||
    resolver.contextSchema !== requirement.contextSchema
  ) {
    throw new TypeError(
      `scope resolver ${resolverId} output schema does not match requirement ${requirementId} input schema`,
    );
  }
};

export const AuthorizationModeSchema = Schema.Literals(["SnapshotRead", "Transaction"]);
export type AuthorizationMode = typeof AuthorizationModeSchema.Type;
export const ExposureSchema = Schema.Literals(["External", "Internal"]);
export type Exposure = typeof ExposureSchema.Type;
export const ConcealmentPolicySchema = Schema.TaggedUnion({
  Reveal: {},
  NotFound: {
    conceal: Schema.Array(
      Schema.Literals(["CredentialFailure", "PrincipalKind", "Capability", "Scope", "Requirement"]),
    ).pipe(
      Schema.check(
        Schema.makeFilter((values) => values.length > 0, {
          message: "a non-empty concealment list",
        }),
      ),
    ),
  },
});
export type ConcealmentPolicy = typeof ConcealmentPolicySchema.Type;
const AcceptedCredentialsSchema = Schema.Array(CredentialMechanismSchema).pipe(
  Schema.check(
    Schema.makeFilter((values) => values.length > 0, {
      message: "at least one accepted credential",
    }),
  ),
);
const PrincipalKindsSchema = Schema.Array(PrincipalKindSchema).pipe(
  Schema.check(
    Schema.makeFilter((values) => values.length > 0 && new Set(values).size === values.length, {
      message: "at least one principal kind without duplicates",
    }),
  ),
);
export const AccessSpecSchema = Schema.Struct({
  exposure: ExposureSchema,
  acceptedCredentials: AcceptedCredentialsSchema,
  principalKinds: PrincipalKindsSchema,
  capabilities: CapabilityExpressionSchema,
  requirements: Schema.Array(TypedRequirementSchema),
  canonicalScopeResolver: ScopeResolverId,
  concealment: ConcealmentPolicySchema,
  decisionTime: AuthorizationModeSchema,
});
export type AccessSpec = typeof AccessSpecSchema.Type;

const mechanismPrincipalKind = (mechanism: CredentialMechanism): PrincipalKind => {
  switch (mechanism._tag) {
    case "None":
      return "Anonymous";
    case "BetterAuthCookie":
    case "OAuthUserBearer":
      return "Person";
    case "OAuthServiceBearer":
      return "ServicePrincipal";
    case "ObjectCapability":
      return "CapabilityHolder";
  }
};
const sameCredentialMechanism = (left: CredentialMechanism, right: CredentialMechanism): boolean =>
  left._tag === right._tag &&
  (left._tag !== "ObjectCapability" ||
    (right._tag === "ObjectCapability" && left.capabilityType === right.capabilityType));
const credentialMatchesAccessSpec = (
  spec: AccessSpec,
  credential: Extract<CredentialOutcome, { readonly _tag: "Accepted" }>,
): boolean =>
  mechanismPrincipalKind(credential.mechanism) === credential.principal._tag &&
  spec.acceptedCredentials.some((accepted) =>
    sameCredentialMechanism(accepted, credential.mechanism),
  );
const capabilityTypesIn = (expression: CapabilityExpression): ReadonlyArray<CapabilityTypeId> => {
  switch (expression._tag) {
    case "None":
      return [];
    case "One":
      return [expression.capability.type];
    case "All":
    case "Any":
      return expression.capabilities.map((capability) => capability.type);
  }
};
export const scopeResolverDeclaration = (resolverId: ScopeResolverId) => {
  switch (resolverId) {
    case "receipts.by-id":
      return SCOPE_RESOLVERS["receipts.by-id"];
    case "system.public":
      return SCOPE_RESOLVERS["system.public"];
  }
  throw new TypeError(`unknown scope resolver ${resolverId}`);
};
const stableRequirementKey = (requirement: TypedRequirement): string =>
  `${requirement.id}:${JSON.stringify(requirement.parameters)}`;

export const makeAccessSpec = (input: unknown): AccessSpec => {
  const decoded = Schema.decodeUnknownSync(AccessSpecSchema)(input, {
    onExcessProperty: "error",
  });
  const anonymousOnly =
    decoded.principalKinds.length === 1 && decoded.principalKinds[0] === "Anonymous";
  if (anonymousOnly) {
    if (
      decoded.acceptedCredentials.length !== 1 ||
      decoded.acceptedCredentials[0]?._tag !== "None" ||
      decoded.capabilities._tag !== "None"
    ) {
      throw new TypeError("Anonymous access requires only None credentials and no capability");
    }
  } else if (decoded.acceptedCredentials.some((mechanism) => mechanism._tag === "None")) {
    throw new TypeError("None credentials are valid only for Anonymous access");
  }
  const mechanismKinds = new Set(decoded.acceptedCredentials.map(mechanismPrincipalKind));
  for (const principalKind of decoded.principalKinds) {
    if (!mechanismKinds.has(principalKind)) {
      throw new TypeError(`principal kind ${principalKind} has no accepted credential mechanism`);
    }
  }
  for (const mechanismKind of mechanismKinds) {
    if (!decoded.principalKinds.includes(mechanismKind)) {
      throw new TypeError(`credential mechanism resolves unlisted principal kind ${mechanismKind}`);
    }
  }
  const capabilityTypes = capabilityTypesIn(decoded.capabilities);
  for (const mechanism of decoded.acceptedCredentials) {
    if (
      mechanism._tag === "ObjectCapability" &&
      !capabilityTypes.includes(mechanism.capabilityType)
    ) {
      throw new TypeError("object capability credential must match an endpoint capability");
    }
  }
  for (const requirement of decoded.requirements) {
    assertRequirementRegistration(decoded.canonicalScopeResolver, requirement.id);
  }
  const requirementKeys = decoded.requirements.map(stableRequirementKey);
  const uniqueRequirements = decoded.requirements.filter(
    (_, index) => requirementKeys.indexOf(requirementKeys[index]!) === index,
  );
  return { ...decoded, requirements: uniqueRequirements };
};

const stableScope = (scope: Scope): string => JSON.stringify(scope);
const canonicalScopeTree = (
  operator: "And" | "Or",
  members: ReadonlyArray<Scope>,
  start = 0,
  end = members.length,
): Scope => {
  if (end - start === 1) return members[start]!;
  const middle = start + Math.ceil((end - start) / 2);
  return {
    _tag: operator,
    left: canonicalScopeTree(operator, members, start, middle),
    right: canonicalScopeTree(operator, members, middle, end),
  };
};
export const normalizeScope = (scope: Scope): Scope => {
  if (scope._tag !== "And" && scope._tag !== "Or") return scope;
  const operator = scope._tag;
  const members: Array<Scope> = [];
  const collect = (candidate: Scope): void => {
    if (candidate._tag === operator) {
      collect(candidate.left);
      collect(candidate.right);
      return;
    }
    members.push(normalizeScope(candidate));
  };
  collect(scope);
  const canonicalMembers = [
    ...new Map(
      members
        .map((member) => [stableScope(member), member] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ).values(),
  ];
  return canonicalScopeTree(operator, canonicalMembers);
};
export const makeGrant = (input: unknown): Grant => {
  const grant = Schema.decodeUnknownSync(GrantSchema)(input, { onExcessProperty: "error" });
  return { ...grant, scope: normalizeScope(grant.scope) };
};
export const expandAuthorityMacros = (
  directGrants: ReadonlyArray<Grant>,
  roles: ReadonlyArray<RoleMacro>,
): ReadonlyArray<Grant> => [...directGrants, ...roles.flatMap((role) => role.grants)];

export const scopeMatches = (scope: Scope, context: CanonicalResourceContext): boolean => {
  switch (scope._tag) {
    case "Global":
      return true;
    case "Domain":
      return scope.domainId === context.domainId;
    case "Department":
      return context.departmentId !== null && scope.departmentId === context.departmentId;
    case "Resource":
      return (
        context.resource !== null &&
        scope.resource.kind === context.resource.kind &&
        scope.resource.id === context.resource.id
      );
    case "And":
      return scopeMatches(scope.left, context) && scopeMatches(scope.right, context);
    case "Or":
      return scopeMatches(scope.left, context) || scopeMatches(scope.right, context);
  }
};
const samePrincipal = (left: NonAnonymousPrincipal, right: Principal): boolean => {
  if (left._tag !== right._tag) return false;
  switch (left._tag) {
    case "Person":
      return right._tag === "Person" && left.personId === right.personId;
    case "ServicePrincipal":
      return (
        right._tag === "ServicePrincipal" && left.servicePrincipalId === right.servicePrincipalId
      );
    case "CapabilityHolder":
      return right._tag === "CapabilityHolder" && left.capabilityId === right.capabilityId;
  }
};
const activeAt = (grant: Grant, instant: AuthorizationInstant): boolean =>
  compareRfc3339Instants(grant.startAt, instant) <= 0 &&
  (grant.endAt === null || compareRfc3339Instants(instant, grant.endAt) < 0);
export const evaluateRequirement = (
  requirement: TypedRequirement,
  principal: Principal,
  context: CanonicalResourceContext,
): RequirementResult => {
  const registration = REQUIREMENT_TYPES[requirementRegistryKey(requirement.id)];
  if (!Schema.is(registration.parameterSchema)(requirement.parameters)) {
    return { id: requirement.id, _tag: "Failed", reason: "InvalidParameters" };
  }
  if (!Schema.is(registration.contextSchema)(context)) {
    return { id: requirement.id, _tag: "Failed", reason: "InvalidContext" };
  }
  const parameters = Schema.decodeSync(registration.parameterSchema)(requirement.parameters);
  const registeredContext = Schema.decodeSync(registration.contextSchema)(context);
  const evaluation = registration.evaluate(parameters, principal, registeredContext);
  return { id: requirement.id, ...evaluation };
};

export type AccessDenialStage = "PrincipalKind" | "Capability" | "Scope" | "Requirement";
export type AccessDenialReason =
  | "PrincipalKindNotAccepted"
  | "CapabilityMissing"
  | "AuthorityInactive"
  | "NotInScope"
  | "RequirementFailed"
  | "InvalidScopeResolution"
  | "EmptyContextSet";
export type AccessDecision<C = unknown> =
  | {
      readonly _tag: "Allow";
      readonly principal: Principal;
      readonly resolution: CanonicalScopeResolution<C>;
      readonly authorizationInstant: AuthorizationInstant;
    }
  | {
      readonly _tag: "Deny";
      readonly stage: AccessDenialStage;
      readonly reason: AccessDenialReason;
    };
export type AccessEvaluation<C = unknown> =
  | { readonly _tag: "CredentialRejected"; readonly reason: CredentialFailureReason }
  | AccessDecision<C>;

type AccessDenial = Extract<AccessDecision, { readonly _tag: "Deny" }>;
const denied = (stage: AccessDenialStage, reason: AccessDenialReason): AccessDenial => ({
  _tag: "Deny",
  stage,
  reason,
});
const requirementsSatisfied = (
  requirements: ReadonlyArray<TypedRequirement>,
  principal: Principal,
  context: CanonicalResourceContext,
): boolean =>
  requirements.every(
    (requirement) => evaluateRequirement(requirement, principal, context)._tag === "Satisfied",
  );
type ContextCapabilityResult = { readonly allowed: true } | { readonly denial: AccessDenial };
const capabilityForContext = (
  capability: Capability,
  principal: Principal,
  context: CanonicalResourceContext,
  grants: ReadonlyArray<Grant>,
  instant: AuthorizationInstant,
): ContextCapabilityResult => {
  const matchingCapability = grants.filter(
    (grant) => samePrincipal(grant.subject, principal) && grant.capability.type === capability.type,
  );
  if (matchingCapability.length === 0) {
    return { denial: denied("Capability", "CapabilityMissing") };
  }
  const active = matchingCapability.filter((grant) => activeAt(grant, instant));
  if (active.length === 0) return { denial: denied("Capability", "AuthorityInactive") };
  const scoped = active.filter((grant) => scopeMatches(grant.scope, context));
  if (scoped.length === 0) return { denial: denied("Scope", "NotInScope") };
  if (!scoped.some((grant) => requirementsSatisfied(grant.requirements, principal, context))) {
    return { denial: denied("Requirement", "RequirementFailed") };
  }
  return { allowed: true };
};
const expressionForContext = (
  expression: CapabilityExpression,
  principal: Principal,
  context: CanonicalResourceContext,
  grants: ReadonlyArray<Grant>,
  instant: AuthorizationInstant,
): ContextCapabilityResult => {
  switch (expression._tag) {
    case "None":
      return { allowed: true };
    case "One":
      return capabilityForContext(expression.capability, principal, context, grants, instant);
    case "All": {
      for (const capability of expression.capabilities) {
        const result = capabilityForContext(capability, principal, context, grants, instant);
        if ("denial" in result) return result;
      }
      return { allowed: true };
    }
    case "Any": {
      let strongestDenial = denied("Capability", "CapabilityMissing");
      for (const capability of expression.capabilities) {
        const result = capabilityForContext(capability, principal, context, grants, instant);
        if ("allowed" in result) return result;
        if (
          result.denial._tag === "Deny" &&
          (result.denial.stage === "Requirement" ||
            (result.denial.stage === "Scope" &&
              strongestDenial._tag === "Deny" &&
              strongestDenial.stage === "Capability"))
        ) {
          strongestDenial = result.denial;
        }
      }
      return { denial: strongestDenial };
    }
  }
};

export const evaluateAccess = <C>(input: {
  readonly spec: AccessSpec;
  readonly credential: CredentialOutcome;
  readonly resolution: CanonicalScopeResolution<C>;
  readonly grants: ReadonlyArray<Grant>;
  readonly authorizationInstant: AuthorizationInstant;
}): AccessEvaluation<C> => {
  if (input.credential._tag === "Rejected") {
    return { _tag: "CredentialRejected", reason: input.credential.reason };
  }
  if (!credentialMatchesAccessSpec(input.spec, input.credential)) {
    return { _tag: "CredentialRejected", reason: "WrongMechanism" };
  }
  const principal = input.credential.principal;
  if (!input.spec.principalKinds.includes(principal._tag)) {
    return denied("PrincipalKind", "PrincipalKindNotAccepted");
  }
  if (
    input.resolution.selection !==
      scopeResolverDeclaration(input.spec.canonicalScopeResolver).selection ||
    (input.resolution.selection === "ExactlyOne" && input.resolution.contexts.length !== 1)
  ) {
    return denied("Scope", "InvalidScopeResolution");
  }
  const allowedContexts: Array<CanonicalResourceContext<C>> = [];
  let lastDenial = denied("Scope", "EmptyContextSet");
  for (const context of input.resolution.contexts) {
    const capability = expressionForContext(
      input.spec.capabilities,
      principal,
      context,
      input.grants,
      input.authorizationInstant,
    );
    if ("denial" in capability) {
      lastDenial = capability.denial;
      continue;
    }
    if (!requirementsSatisfied(input.spec.requirements, principal, context)) {
      lastDenial = denied("Requirement", "RequirementFailed");
      continue;
    }
    allowedContexts.push(context);
  }
  if (allowedContexts.length === 0) return lastDenial;
  return {
    _tag: "Allow",
    principal,
    resolution: { ...input.resolution, contexts: allowedContexts },
    authorizationInstant: input.authorizationInstant,
  };
};

export interface AccessJourneyServices<I, C, E, R> {
  readonly now: Effect.Effect<AuthorizationInstant, E, R>;
  readonly resolveCredential: (
    instant: AuthorizationInstant,
  ) => Effect.Effect<CredentialOutcome, E, R>;
  readonly resolveScope: (
    input: I,
    principal: Principal,
    instant: AuthorizationInstant,
    mode: AuthorizationMode,
  ) => Effect.Effect<CanonicalScopeResolution<C>, E, R>;
  readonly resolveGrants: (
    principal: Principal,
    resolution: CanonicalScopeResolution<C>,
    instant: AuthorizationInstant,
    mode: AuthorizationMode,
  ) => Effect.Effect<ReadonlyArray<Grant>, E, R>;
}
export const evaluateAccessJourney = <I, C, E, R>(
  spec: AccessSpec,
  input: I,
  services: AccessJourneyServices<I, C, E, R>,
): Effect.Effect<AccessEvaluation<C>, E, R> =>
  Effect.gen(function* () {
    const authorizationInstant = yield* services.now;
    const credential = yield* services.resolveCredential(authorizationInstant);
    if (credential._tag === "Rejected") {
      return { _tag: "CredentialRejected", reason: credential.reason } as const;
    }
    if (!credentialMatchesAccessSpec(spec, credential)) {
      return { _tag: "CredentialRejected", reason: "WrongMechanism" } as const;
    }
    const resolution = yield* services.resolveScope(
      input,
      credential.principal,
      authorizationInstant,
      spec.decisionTime,
    );
    const grants = yield* services.resolveGrants(
      credential.principal,
      resolution,
      authorizationInstant,
      spec.decisionTime,
    );
    return evaluateAccess({ spec, credential, resolution, grants, authorizationInstant });
  });

const concealed = (policy: ConcealmentPolicy, stage: string): boolean =>
  policy._tag === "NotFound" && policy.conceal.includes(stage as never);
export const accessHttpStatus = (
  evaluation: AccessEvaluation,
  policy: ConcealmentPolicy,
): 200 | 401 | 403 | 404 => {
  if (evaluation._tag === "Allow") return 200;
  if (evaluation._tag === "CredentialRejected") {
    return concealed(policy, "CredentialFailure") ? 404 : 401;
  }
  return concealed(policy, evaluation.stage) ? 404 : 403;
};

export interface AccessTrace {
  readonly declarationId: string;
  readonly exposure: Exposure;
  readonly credentialMechanism: CredentialMechanism["_tag"];
  readonly credentialOutcome: "Accepted" | "Rejected";
  readonly principalKind: PrincipalKind | null;
  readonly scopeResolverId: ScopeResolverId | null;
  readonly domainId: DomainId | null;
  readonly departmentId: DepartmentId | null;
  readonly resourceKind: ResourceKind | null;
  readonly decisionTime: AuthorizationMode | null;
  readonly capabilityOutcome: "Satisfied" | "Failed" | null;
  readonly failedRequirementIds: ReadonlyArray<RequirementId>;
  readonly decision: "Allow" | "Deny" | null;
  readonly projectedStatus: number;
}
export const traceAccess = (input: {
  readonly declarationId: string;
  readonly spec: AccessSpec;
  readonly mechanism: CredentialMechanism;
  readonly credential: CredentialOutcome;
  readonly resolution: CanonicalScopeResolution;
  readonly grants: ReadonlyArray<Grant>;
  readonly evaluation: AccessEvaluation;
}): AccessTrace => {
  const accepted = input.credential._tag === "Accepted";
  const principal = accepted ? input.credential.principal : null;
  const context = input.resolution.contexts[0];
  const failedRequirements =
    principal === null || context === undefined
      ? []
      : [...input.spec.requirements, ...input.grants.flatMap((grant) => grant.requirements)]
          .filter(
            (requirement) => evaluateRequirement(requirement, principal, context)._tag === "Failed",
          )
          .map((requirement) => requirement.id)
          .filter((id, index, values) => values.indexOf(id) === index)
          .sort((left, right) => REQUIREMENT_IDS.indexOf(left) - REQUIREMENT_IDS.indexOf(right));
  const capabilityOutcome =
    !accepted || input.spec.capabilities._tag === "None"
      ? null
      : input.evaluation._tag === "Deny" &&
          (input.evaluation.stage === "Capability" || input.evaluation.stage === "Scope")
        ? "Failed"
        : "Satisfied";
  return {
    declarationId: input.declarationId,
    exposure: input.spec.exposure,
    credentialMechanism: input.mechanism._tag,
    credentialOutcome: accepted ? "Accepted" : "Rejected",
    principalKind: principal?._tag ?? null,
    scopeResolverId: accepted ? input.spec.canonicalScopeResolver : null,
    domainId: context?.domainId ?? null,
    departmentId: context?.departmentId ?? null,
    resourceKind: context?.resource?.kind ?? null,
    decisionTime: accepted ? input.spec.decisionTime : null,
    capabilityOutcome,
    failedRequirementIds: failedRequirements,
    decision: input.evaluation._tag === "CredentialRejected" ? null : input.evaluation._tag,
    projectedStatus: accessHttpStatus(input.evaluation, input.spec.concealment),
  };
};

export const PUBLIC_SYSTEM_ACCESS = makeAccessSpec({
  exposure: "External",
  acceptedCredentials: [{ _tag: "None" }],
  principalKinds: ["Anonymous"],
  capabilities: { _tag: "None" },
  requirements: [],
  canonicalScopeResolver: SYSTEM_PUBLIC_SCOPE_RESOLVER,
  concealment: { _tag: "Reveal" },
  decisionTime: "SnapshotRead",
});

export const INTERNAL_RECEIPT_EVIDENCE_ACCESS = makeAccessSpec({
  exposure: "Internal",
  acceptedCredentials: [{ _tag: "BetterAuthCookie" }],
  principalKinds: ["Person"],
  capabilities: {
    _tag: "One",
    capability: { type: READ_INTERNAL_RECEIPT_EVIDENCE_CAPABILITY },
  },
  requirements: [
    { id: INTERNAL_EVIDENCE_ENABLED_REQUIREMENT, parameters: {} },
    { id: RECEIPT_OWNER_REQUIREMENT, parameters: {} },
  ],
  canonicalScopeResolver: RECEIPT_BY_ID_SCOPE_RESOLVER,
  concealment: { _tag: "Reveal" },
  decisionTime: "SnapshotRead",
});

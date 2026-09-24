import { describe, expect, it } from "@effect/vitest";
import { Predicate, Effect, Schema } from "effect";
import { DepartmentId, PersonId } from "../organization/schema.js";
import {
  AccessEvaluation,
  Scope,
  ConcealmentPolicySchema,
  CapabilityExpressionSchema,
  CredentialOutcomeSchema,
  SCOPE_RESOLVER_IDS,
  APPROVE_RECEIPT_CAPABILITY,
  AuthorityRef,
  AuthorityVersion,
  AuthorizationInstant,
  CapabilityId,
  CredentialEvidenceRef,
  GrantId,
  INTERNAL_RECEIPT_EVIDENCE_ACCESS,
  INVITATION_RESPONSE_CAPABILITY,
  READ_INTERNAL_RECEIPT_EVIDENCE_CAPABILITY,
  RECEIPT_APPROVER_REQUIREMENT,
  RECEIPT_OWNER_REQUIREMENT,
  CredentialMechanismSchema,
  RECEIPT_BY_ID_SCOPE_RESOLVER,
  RECEIPT_DOMAIN_ID,
  RECEIPT_PENDING_REQUIREMENT,
  RECEIPT_RESOURCE_KIND,
  RECRUITMENT_INVITATION_RESOURCE_KIND,
  ResourceId,
  SYSTEM_DOMAIN_ID,
  SYSTEM_PUBLIC_SCOPE_RESOLVER,
  ScopeSchema,
  assertRequirementRegistration,
  accessHttpStatus,
  PrincipalSchema,
  evaluateRequirement,
  RequirementId,
  DomainId,
  ResourceKind,
  evaluateAccess,
  evaluateAccessJourney,
  expandAuthorityMacros,
  makeAccessSpec,
  ServicePrincipalId,
  decodeGrant,
  normalizeScope,
  scopeMatches,
  traceAccess,
  type CanonicalResourceContext,
  type CredentialOutcome,
  type Grant,
  type ReceiptAccessFacts,
} from "./access.js";

const instant = AuthorizationInstant.make("2031-09-15T12:00:00.000Z");

const personId = PersonId.make("access-person");

const otherPersonId = PersonId.make("access-other-person");

const alphaDepartment = DepartmentId.make("department-alpha");

const betaDepartment = DepartmentId.make("department-beta");

const receiptId = ResourceId.make("receipt-access");

const personCredential: CredentialOutcome = CredentialOutcomeSchema.cases.Accepted.make({
  mechanism: CredentialMechanismSchema.cases.BetterAuthCookie.make({}),
  principal: PrincipalSchema.cases.Person.make({ personId }),
  evidenceRef: CredentialEvidenceRef.make("better-auth:session-1"),
});

const receiptContext = (
  departmentId = alphaDepartment,
  ownerPersonId = personId,
): CanonicalResourceContext<ReceiptAccessFacts> => ({
  domainId: RECEIPT_DOMAIN_ID,
  departmentId,
  resource: { kind: RECEIPT_RESOURCE_KIND, id: receiptId },
  facts: {
    ownerPersonId,
    state: "Pending",
    approverPersonIds: [personId],
    approverServicePrincipalIds: [],
    internalEvidenceEnabled: true,
  },
  authorityVersion: AuthorityVersion.make("receipt:1"),
});

const receiptGrant = (scope: Grant["scope"]): Grant =>
  decodeGrant({
    grantId: GrantId.make("grant-receipt-access"),
    subject: PrincipalSchema.cases.Person.make({ personId }),
    capability: { type: READ_INTERNAL_RECEIPT_EVIDENCE_CAPABILITY },
    scope,
    startAt: AuthorizationInstant.make("2031-01-01T00:00:00.000Z"),
    endAt: null,
    requirements: [],
    source: AuthorityRef.make("test.receipt-authority"),
    revision: 0,
  });

const publicAccess = makeAccessSpec({
  exposure: "External",
  acceptedCredentials: [CredentialMechanismSchema.cases.None.make({})],
  principalKinds: ["Anonymous"],
  capabilities: CapabilityExpressionSchema.cases.None.make({}),
  requirements: [],
  canonicalScopeResolver: SYSTEM_PUBLIC_SCOPE_RESOLVER,
  concealment: ConcealmentPolicySchema.cases.Reveal.make({}),
  decisionTime: "SnapshotRead",
});

const receiptCommandAccess = makeAccessSpec({
  exposure: "External",
  acceptedCredentials: [CredentialMechanismSchema.cases.BetterAuthCookie.make({})],
  principalKinds: ["Person"],
  capabilities: CapabilityExpressionSchema.cases.One.make({
    capability: { type: APPROVE_RECEIPT_CAPABILITY },
  }),
  requirements: [
    { id: RECEIPT_PENDING_REQUIREMENT, parameters: {} },
    { id: RECEIPT_APPROVER_REQUIREMENT, parameters: {} },
  ],
  canonicalScopeResolver: RECEIPT_BY_ID_SCOPE_RESOLVER,

  concealment: ConcealmentPolicySchema.cases.Reveal.make({}),
  decisionTime: "Transaction",
});

describe("principal, credential, and access algebra", () => {
  it("decodes every deferred OAuth credential and the service principal independently", () => {
    const servicePrincipal = Schema.decodeUnknownSync(PrincipalSchema)(
      PrincipalSchema.cases.ServicePrincipal.make({
        servicePrincipalId: ServicePrincipalId.make("service-sync"),
      }),
    );

    const mechanisms = [
      Schema.decodeUnknownSync(CredentialMechanismSchema)(
        CredentialMechanismSchema.cases.OAuthUserBearer.make({}),
      ),
      Schema.decodeUnknownSync(CredentialMechanismSchema)(
        CredentialMechanismSchema.cases.OAuthServiceBearer.make({}),
      ),
    ];

    expect(servicePrincipal).toEqual(
      PrincipalSchema.cases.ServicePrincipal.make({
        servicePrincipalId: ServicePrincipalId.make("service-sync"),
      }),
    );
    expect(mechanisms.map(({ _tag }) => _tag)).toEqual(["OAuthUserBearer", "OAuthServiceBearer"]);
  });

  it("records the bounded 0055.1 tracer journey without credential material", () => {
    const context = receiptContext();

    const anonymousCredential: CredentialOutcome = CredentialOutcomeSchema.cases.Accepted.make({
      mechanism: CredentialMechanismSchema.cases.None.make({}),
      principal: PrincipalSchema.cases.Anonymous.make({}),
      evidenceRef: CredentialEvidenceRef.make("anonymous:none"),
    });

    const publicContext: CanonicalResourceContext = {
      domainId: SYSTEM_DOMAIN_ID,
      departmentId: null,
      resource: null,
      facts: {},
      authorityVersion: AuthorityVersion.make("system:1"),
    };

    const publicResolution = { selection: "ExactlyOne" as const, contexts: [publicContext] };

    const publicDecision = evaluateAccess({
      spec: publicAccess,
      credential: anonymousCredential,
      resolution: publicResolution,
      grants: [],
      authorizationInstant: instant,
    });

    const ownerGrant = receiptGrant(Scope.Resource({ resource: context.resource! }));
    const receiptResolution = { selection: "ExactlyOne" as const, contexts: [context] };

    const ownerDecision = evaluateAccess({
      spec: INTERNAL_RECEIPT_EVIDENCE_ACCESS,
      credential: personCredential,
      resolution: receiptResolution,
      grants: [ownerGrant],
      authorizationInstant: instant,
    });

    const wrongContext = receiptContext(betaDepartment, otherPersonId);
    const wrongResolution = { selection: "ExactlyOne" as const, contexts: [wrongContext] };

    const wrongDecision = evaluateAccess({
      spec: INTERNAL_RECEIPT_EVIDENCE_ACCESS,
      credential: personCredential,
      resolution: wrongResolution,
      grants: [ownerGrant],
      authorizationInstant: instant,
    });

    const traces = [
      traceAccess({
        declarationId: "proof.public-read",
        spec: publicAccess,
        mechanism: CredentialMechanismSchema.cases.None.make({}),
        credential: anonymousCredential,
        resolution: publicResolution,
        grants: [],
        evaluation: publicDecision,
      }),
      traceAccess({
        declarationId: "proof.protected-read",
        spec: INTERNAL_RECEIPT_EVIDENCE_ACCESS,
        mechanism: CredentialMechanismSchema.cases.BetterAuthCookie.make({}),
        credential: personCredential,
        resolution: receiptResolution,
        grants: [ownerGrant],
        evaluation: ownerDecision,
      }),
      traceAccess({
        declarationId: "proof.wrong-department",
        spec: INTERNAL_RECEIPT_EVIDENCE_ACCESS,
        mechanism: CredentialMechanismSchema.cases.BetterAuthCookie.make({}),
        credential: personCredential,
        resolution: wrongResolution,
        grants: [ownerGrant],
        evaluation: wrongDecision,
      }),
    ];

    expect(
      traces.map(({ declarationId, principalKind, decision, projectedStatus }) => ({
        declarationId,
        principalKind,
        decision,
        projectedStatus,
      })),
    ).toEqual([
      {
        declarationId: "proof.public-read",
        principalKind: "Anonymous",
        decision: "Allow",
        projectedStatus: 200,
      },
      {
        declarationId: "proof.protected-read",
        principalKind: "Person",
        decision: "Allow",
        projectedStatus: 200,
      },
      {
        declarationId: "proof.wrong-department",
        principalKind: "Person",
        decision: "Deny",
        projectedStatus: 403,
      },
    ]);
    expect(JSON.stringify(traces)).not.toMatch(
      /receipt-test-session|authorization|cookieHeader|rawHeader|secret/iu,
    );
  });
  it("rejects incomplete declarations, unknown identifiers, Tenant, and the legacy Receipt scope", () => {
    expect(() => makeAccessSpec({ exposure: "External" })).toThrow();
    expect(() =>
      makeAccessSpec({
        ...publicAccess,
        canonicalScopeResolver: "unknown.resolver",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ScopeSchema)(
        Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
          '{"_tag":"Tenant","tenantId":"tenant-one"}',
        ),
      ),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ScopeSchema)(
        Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))('{"_tag":"Receipt"}'),
      ),
    ).toThrow();
    expect(() =>
      makeAccessSpec({
        ...publicAccess,
        acceptedCredentials: [
          CredentialMechanismSchema.cases.None.make({}),
          CredentialMechanismSchema.cases.BetterAuthCookie.make({}),
        ],
      }),
    ).toThrow();
    expect(() =>
      makeAccessSpec({
        ...receiptCommandAccess,
        requirements: [
          {
            id: RECEIPT_PENDING_REQUIREMENT,
            parameters: { unexpected: true },
          },
        ],
      }),
    ).toThrow();
    let tooDeep: Scope = Scope.Global();

    for (let depth = 0; depth < 16; depth += 1) {
      tooDeep = Scope.And({ left: Scope.Global(), right: tooDeep });
    }

    expect(() => Schema.decodeUnknownSync(ScopeSchema)(tooDeep)).toThrow();
  });

  it("rejects resolver and requirement context-schema mismatches at registration", () => {
    expect(() =>
      assertRequirementRegistration(SYSTEM_PUBLIC_SCOPE_RESOLVER, RECEIPT_OWNER_REQUIREMENT),
    ).toThrow(/output schema does not match requirement/);
  });

  it("rejects an accepted credential with the wrong mechanism before authorization", () => {
    const context = receiptContext();
    const resolution = { selection: "ExactlyOne" as const, contexts: [context] };

    const oauthAtCookieEndpoint = evaluateAccess({
      spec: receiptCommandAccess,
      credential: CredentialOutcomeSchema.cases.Accepted.make({
        mechanism: CredentialMechanismSchema.cases.OAuthUserBearer.make({}),
        principal: PrincipalSchema.cases.Person.make({ personId }),
        evidenceRef: CredentialEvidenceRef.make("oauth:user"),
      }),
      resolution,
      grants: [],
      authorizationInstant: instant,
    });

    const mechanismPrincipalMismatch = evaluateAccess({
      spec: receiptCommandAccess,
      credential: CredentialOutcomeSchema.cases.Accepted.make({
        mechanism: CredentialMechanismSchema.cases.BetterAuthCookie.make({}),
        principal: PrincipalSchema.cases.ServicePrincipal.make({
          servicePrincipalId: ServicePrincipalId.make("invalid-cookie-service"),
        }),
        evidenceRef: CredentialEvidenceRef.make("cookie:invalid-principal"),
      }),
      resolution,
      grants: [],
      authorizationInstant: instant,
    });

    const invitationSpec = makeAccessSpec({
      exposure: "External",
      acceptedCredentials: [
        CredentialMechanismSchema.cases.ObjectCapability.make({
          capabilityType: INVITATION_RESPONSE_CAPABILITY,
        }),
      ],
      principalKinds: ["CapabilityHolder"],
      capabilities: CapabilityExpressionSchema.cases.Any.make({
        capabilities: [
          { type: INVITATION_RESPONSE_CAPABILITY },
          { type: READ_INTERNAL_RECEIPT_EVIDENCE_CAPABILITY },
        ],
      }),
      requirements: [],
      canonicalScopeResolver: SYSTEM_PUBLIC_SCOPE_RESOLVER,
      concealment: ConcealmentPolicySchema.cases.Reveal.make({}),
      decisionTime: "SnapshotRead",
    });

    const wrongObjectCapabilityType = evaluateAccess({
      spec: invitationSpec,
      credential: CredentialOutcomeSchema.cases.Accepted.make({
        mechanism: CredentialMechanismSchema.cases.ObjectCapability.make({
          capabilityType: READ_INTERNAL_RECEIPT_EVIDENCE_CAPABILITY,
        }),
        principal: PrincipalSchema.cases.CapabilityHolder.make({
          capabilityId: CapabilityId.make("wrong-capability-type"),
        }),
        evidenceRef: CredentialEvidenceRef.make("capability:wrong-type"),
      }),
      resolution: {
        selection: "ExactlyOne",
        contexts: [
          {
            domainId: SYSTEM_DOMAIN_ID,
            departmentId: null,
            resource: null,
            facts: {},
            authorityVersion: AuthorityVersion.make("system:wrong-capability"),
          },
        ],
      },
      grants: [],
      authorizationInstant: instant,
    });

    expect(oauthAtCookieEndpoint).toEqual(
      AccessEvaluation.CredentialRejected({ reason: "WrongMechanism" }),
    );
    expect(mechanismPrincipalMismatch).toEqual(
      AccessEvaluation.CredentialRejected({ reason: "WrongMechanism" }),
    );
    expect(wrongObjectCapabilityType).toEqual(
      AccessEvaluation.CredentialRejected({ reason: "WrongMechanism" }),
    );
  });

  it.effect("does not resolve scope or grants for the wrong accepted mechanism", () =>
    Effect.gen(function* () {
      let scopeReads = 0;
      let grantReads = 0;

      const decision = yield* evaluateAccessJourney(
        receiptCommandAccess,
        { receiptId },
        {
          now: Effect.succeed(instant),
          resolveCredential: () =>
            Effect.succeed(
              CredentialOutcomeSchema.cases.Accepted.make({
                mechanism: CredentialMechanismSchema.cases.OAuthUserBearer.make({}),
                principal: PrincipalSchema.cases.Person.make({ personId }),
                evidenceRef: CredentialEvidenceRef.make("oauth:wrong-endpoint"),
              }),
            ),
          resolveScope: () =>
            Effect.sync(() => {
              scopeReads += 1;

              return { selection: "ExactlyOne" as const, contexts: [receiptContext()] };
            }),
          resolveGrants: () =>
            Effect.sync(() => {
              grantReads += 1;

              return [];
            }),
        },
      );

      expect(decision).toEqual(AccessEvaluation.CredentialRejected({ reason: "WrongMechanism" }));
      expect({ scopeReads, grantReads }).toEqual({ scopeReads: 0, grantReads: 0 });
    }),
  );

  it("evaluates endpoint requirements for Anonymous instead of bypassing them", () => {
    const spec = makeAccessSpec({
      ...publicAccess,
      requirements: [{ id: RECEIPT_OWNER_REQUIREMENT, parameters: {} }],
      canonicalScopeResolver: RECEIPT_BY_ID_SCOPE_RESOLVER,
    });

    const decision = evaluateAccess({
      spec,
      credential: CredentialOutcomeSchema.cases.Accepted.make({
        mechanism: CredentialMechanismSchema.cases.None.make({}),
        principal: PrincipalSchema.cases.Anonymous.make({}),
        evidenceRef: CredentialEvidenceRef.make("anonymous:requirement"),
      }),
      resolution: { selection: "ExactlyOne", contexts: [receiptContext()] },
      grants: [],
      authorizationInstant: instant,
    });

    expect(decision).toEqual(
      AccessEvaluation.Deny({ stage: "Requirement", reason: "RequirementFailed" }),
    );
  });

  it("keeps Domain and Department independent and normalizes And and Or", () => {
    const context = receiptContext();
    expect(scopeMatches(Scope.Domain({ domainId: RECEIPT_DOMAIN_ID }), context)).toBe(true);
    expect(scopeMatches(Scope.Department({ departmentId: betaDepartment }), context)).toBe(false);
    expect(
      scopeMatches(
        Scope.And({
          left: Scope.Domain({ domainId: RECEIPT_DOMAIN_ID }),
          right: Scope.Department({ departmentId: betaDepartment }),
        }),
        context,
      ),
    ).toBe(false);
    const domain = Scope.Domain({ domainId: RECEIPT_DOMAIN_ID });
    expect(normalizeScope(Scope.Or({ left: domain, right: domain }))).toEqual(domain);
    const global = Scope.Global();
    const department = Scope.Department({ departmentId: alphaDepartment });
    expect(
      normalizeScope(
        Scope.And({ left: Scope.And({ left: global, right: domain }), right: department }),
      ),
    ).toEqual(
      normalizeScope(
        Scope.And({ left: global, right: Scope.And({ left: domain, right: department }) }),
      ),
    );
    expect(
      normalizeScope(
        Scope.Or({ left: Scope.Or({ left: global, right: domain }), right: department }),
      ),
    ).toEqual(
      normalizeScope(
        Scope.Or({ left: global, right: Scope.Or({ left: domain, right: department }) }),
      ),
    );
    expect(
      normalizeScope(
        Scope.Or({ left: domain, right: Scope.Or({ left: domain, right: department }) }),
      ),
    ).toEqual(normalizeScope(Scope.Or({ left: domain, right: department })));
    expect(
      normalizeScope(
        Scope.And({ left: domain, right: Scope.And({ left: domain, right: department }) }),
      ),
    ).toEqual(normalizeScope(Scope.And({ left: domain, right: department })));
  });

  it("allows the internal owner and returns 401 only for credential failure", () => {
    const context = receiptContext();
    const grant = receiptGrant(Scope.Resource({ resource: context.resource! }));

    const allowed = evaluateAccess({
      spec: INTERNAL_RECEIPT_EVIDENCE_ACCESS,
      credential: personCredential,
      resolution: { selection: "ExactlyOne", contexts: [context] },
      grants: [grant],
      authorizationInstant: instant,
    });

    const rejected = evaluateAccess({
      spec: INTERNAL_RECEIPT_EVIDENCE_ACCESS,
      credential: CredentialOutcomeSchema.cases.Rejected.make({ reason: "Missing" }),
      resolution: { selection: "ExactlyOne", contexts: [context] },
      grants: [],
      authorizationInstant: instant,
    });

    expect(allowed._tag).toBe("Allow");
    expect(accessHttpStatus(allowed, INTERNAL_RECEIPT_EVIDENCE_ACCESS.concealment)).toBe(200);
    expect(rejected).toEqual(AccessEvaluation.CredentialRejected({ reason: "Missing" }));
    expect(accessHttpStatus(rejected, INTERNAL_RECEIPT_EVIDENCE_ACCESS.concealment)).toBe(401);
  });

  it("does not let a global-administrator role macro bypass ownership", () => {
    const context = receiptContext(alphaDepartment, otherPersonId);
    const globalGrant = receiptGrant(Scope.Global());

    const grants = expandAuthorityMacros(
      [],
      [{ roleId: "global-administrator", grants: [globalGrant] }],
    );

    const decision = evaluateAccess({
      spec: INTERNAL_RECEIPT_EVIDENCE_ACCESS,
      credential: personCredential,
      resolution: { selection: "ExactlyOne", contexts: [context] },
      grants,
      authorizationInstant: instant,
    });

    expect(decision).toEqual(
      AccessEvaluation.Deny({ stage: "Requirement", reason: "RequirementFailed" }),
    );
    expect(accessHttpStatus(decision, INTERNAL_RECEIPT_EVIDENCE_ACCESS.concealment)).toBe(403);
  });

  it("keeps a wrong department denial at 403 and performs no transaction effect", () => {
    const context = receiptContext(betaDepartment);

    const grant = decodeGrant({
      grantId: GrantId.make("grant-approve-alpha"),
      subject: PrincipalSchema.cases.Person.make({ personId }),
      capability: { type: APPROVE_RECEIPT_CAPABILITY },
      scope: Scope.Department({ departmentId: alphaDepartment }),
      startAt: AuthorizationInstant.make("2031-01-01T00:00:00.000Z"),
      endAt: null,
      requirements: [],
      source: AuthorityRef.make("test.receipt-approval"),
      revision: 0,
    });

    const decision = evaluateAccess({
      spec: receiptCommandAccess,
      credential: personCredential,
      resolution: { selection: "ExactlyOne", contexts: [context] },
      grants: [grant],
      authorizationInstant: instant,
    });

    let transitions = 0;

    if (Predicate.isTagged(decision, "Allow")) transitions += 1;

    expect(decision).toEqual(AccessEvaluation.Deny({ stage: "Scope", reason: "NotInScope" }));
    expect(accessHttpStatus(decision, receiptCommandAccess.concealment)).toBe(403);
    expect(transitions).toBe(0);
  });

  it.effect("captures a new instant and authority set for each retry", () =>
    Effect.gen(function* () {
      let attempts = 0;
      let credentialReads = 0;
      let scopeReads = 0;
      let grantReads = 0;
      const context = receiptContext();
      const grant = receiptGrant(Scope.Resource({ resource: context.resource! }));

      const services = {
        now: Effect.sync(() => {
          attempts += 1;

          return AuthorizationInstant.make(
            attempts === 1 ? "2031-09-15T12:00:00.000Z" : "2031-09-15T12:00:01.000Z",
          );
        }),
        resolveCredential: () =>
          Effect.sync(() => {
            credentialReads += 1;

            return personCredential;
          }),
        resolveScope: () =>
          Effect.sync(() => {
            scopeReads += 1;

            return { selection: "ExactlyOne" as const, contexts: [context] };
          }),
        resolveGrants: () =>
          Effect.sync(() => {
            grantReads += 1;

            return grantReads === 1 ? [grant] : [];
          }),
      };

      const first = yield* evaluateAccessJourney(
        INTERNAL_RECEIPT_EVIDENCE_ACCESS,
        { receiptId },
        services,
      );

      const retry = yield* evaluateAccessJourney(
        INTERNAL_RECEIPT_EVIDENCE_ACCESS,
        { receiptId },
        services,
      );

      expect(first._tag).toBe("Allow");
      expect(retry).toEqual(
        AccessEvaluation.Deny({ stage: "Capability", reason: "CapabilityMissing" }),
      );
      expect({ attempts, credentialReads, scopeReads, grantReads }).toEqual({
        attempts: 2,
        credentialReads: 2,
        scopeReads: 2,
        grantReads: 2,
      });
    }),
  );

  it("conceals only an explicitly listed invalid object capability and allows the valid holder", () => {
    const capabilityId = CapabilityId.make("invitation-capability-instance");

    const mechanism = CredentialMechanismSchema.cases.ObjectCapability.make({
      capabilityType: INVITATION_RESPONSE_CAPABILITY,
    });

    const spec = makeAccessSpec({
      exposure: "External",
      acceptedCredentials: [mechanism],
      principalKinds: ["CapabilityHolder"],
      capabilities: CapabilityExpressionSchema.cases.One.make({
        capability: { type: INVITATION_RESPONSE_CAPABILITY },
      }),
      requirements: [],
      canonicalScopeResolver: SYSTEM_PUBLIC_SCOPE_RESOLVER,
      concealment: ConcealmentPolicySchema.cases.NotFound.make({ conceal: ["CredentialFailure"] }),
      decisionTime: "SnapshotRead",
    });

    const invitationContext = {
      domainId: SYSTEM_DOMAIN_ID,
      departmentId: null,
      resource: {
        kind: RECRUITMENT_INVITATION_RESOURCE_KIND,
        id: ResourceId.make("invitation-one"),
      },
      facts: {},
      authorityVersion: AuthorityVersion.make("invitation:1"),
    } satisfies CanonicalResourceContext;

    const rejectedCredential: CredentialOutcome = CredentialOutcomeSchema.cases.Rejected.make({
      reason: "Invalid",
    });

    const rejected = evaluateAccess({
      spec,
      credential: rejectedCredential,
      resolution: { selection: "ExactlyOne", contexts: [invitationContext] },
      grants: [],
      authorizationInstant: instant,
    });

    const principal = PrincipalSchema.cases.CapabilityHolder.make({ capabilityId });

    const grant = decodeGrant({
      grantId: GrantId.make("grant-invitation-one"),
      subject: principal,
      capability: { type: INVITATION_RESPONSE_CAPABILITY },
      scope: Scope.Resource({ resource: invitationContext.resource }),
      startAt: AuthorizationInstant.make("2031-01-01T00:00:00.000Z"),
      endAt: null,
      requirements: [],
      source: AuthorityRef.make("recruitment.invitation-authority"),
      revision: 0,
    });

    const acceptedCredential: CredentialOutcome = CredentialOutcomeSchema.cases.Accepted.make({
      mechanism,
      principal,
      evidenceRef: CredentialEvidenceRef.make("invitation:resolved-capability"),
    });

    const accepted = evaluateAccess({
      spec,
      credential: acceptedCredential,
      resolution: { selection: "ExactlyOne", contexts: [invitationContext] },
      grants: [grant],
      authorizationInstant: instant,
    });

    const rejectedTrace = traceAccess({
      declarationId: "proof.object-capability",
      spec,
      mechanism,
      credential: rejectedCredential,
      resolution: { selection: "ExactlyOne", contexts: [] },
      grants: [],
      evaluation: rejected,
    });

    expect(accessHttpStatus(rejected, spec.concealment)).toBe(404);
    expect(accepted._tag).toBe("Allow");
    expect(rejectedTrace).toEqual({
      declarationId: "proof.object-capability",
      exposure: "External",
      credentialMechanism: "ObjectCapability",
      credentialOutcome: "Rejected",
      principalKind: null,
      scopeResolverId: null,
      domainId: null,
      departmentId: null,
      resourceKind: null,
      decisionTime: null,
      capabilityOutcome: null,
      failedRequirementIds: [],
      decision: null,
      projectedStatus: 404,
    });
  });

  it("allows an anonymous proof declaration without authority facts", () => {
    const context: CanonicalResourceContext = {
      domainId: SYSTEM_DOMAIN_ID,
      departmentId: null,
      resource: null,
      facts: {},
      authorityVersion: AuthorityVersion.make("system:1"),
    };

    const credential: CredentialOutcome = CredentialOutcomeSchema.cases.Accepted.make({
      mechanism: CredentialMechanismSchema.cases.None.make({}),
      principal: PrincipalSchema.cases.Anonymous.make({}),
      evidenceRef: CredentialEvidenceRef.make("anonymous:none"),
    });

    const decision = evaluateAccess({
      spec: publicAccess,
      credential,
      resolution: { selection: "ExactlyOne", contexts: [context] },
      grants: [],
      authorizationInstant: instant,
    });

    expect(decision._tag).toBe("Allow");
    expect(
      traceAccess({
        declarationId: "proof.public-read",
        spec: publicAccess,
        mechanism: CredentialMechanismSchema.cases.None.make({}),
        credential,
        resolution: { selection: "ExactlyOne", contexts: [context] },
        grants: [],
        evaluation: decision,
      }),
    ).toMatchObject({
      credentialMechanism: "None",
      principalKind: "Anonymous",
      decisionTime: "SnapshotRead",
      decision: "Allow",
    });
  });
});

it("fails known-self or absent/malformed interview identity facts and permits explicit unknown/different links", () => {
  for (const [linked, allowed] of [
    [personId, false],
    [otherPersonId, true],
    [null, true],
    [undefined, false],
    ["", false],
    [42, false],
  ] as const) {
    const result = evaluateRequirement(
      { id: RequirementId.make("recruitment.not-known-self"), parameters: {} },
      PrincipalSchema.cases.Person.make({ personId }),
      {
        domainId: DomainId.make("recruitment"),
        departmentId: alphaDepartment,
        resource: {
          kind: ResourceKind.make("recruitment-interview"),
          id: ResourceId.make("interview"),
        },
        authorityVersion: AuthorityVersion.make("known-identity-test"),
        facts: { linkedApplicantPersonId: linked },
      },
    );

    expect(result._tag).toBe(allowed ? "Satisfied" : "Failed");
  }
});

it("accepts only listed primary or co-interviewer participants", () => {
  const requirement = {
    id: RequirementId.make("recruitment.assigned-interviewer-or-co-interviewer"),
    parameters: {},
  };

  const context = {
    domainId: DomainId.make("recruitment"),
    departmentId: alphaDepartment,
    resource: {
      kind: ResourceKind.make("recruitment-interview"),
      id: ResourceId.make("interview"),
    },
    authorityVersion: AuthorityVersion.make("participant-test"),
    facts: { interviewParticipantPersonIds: [personId, otherPersonId] },
  };

  for (const [participant, allowed] of [
    [personId, true],
    [otherPersonId, true],
    [PersonId.make("access-unassigned-person"), false],
  ] as const) {
    const result = evaluateRequirement(
      requirement,
      PrincipalSchema.cases.Person.make({ personId: participant }),
      context,
    );

    expect(result._tag).toBe(allowed ? "Satisfied" : "Failed");
  }
});

it("registers each canonical scope resolver exactly once", () => {
  expect(new Set(SCOPE_RESOLVER_IDS).size).toBe(SCOPE_RESOLVER_IDS.length);
});

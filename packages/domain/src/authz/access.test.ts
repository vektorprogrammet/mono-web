import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { DepartmentId, PersonId } from "../organization/schema.js";
import {
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
  evaluateAccess,
  evaluateAccessJourney,
  expandAuthorityMacros,
  makeAccessSpec,
  ServicePrincipalId,
  makeGrant,
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
const personCredential: CredentialOutcome = {
  _tag: "Accepted",
  mechanism: { _tag: "BetterAuthCookie" },
  principal: { _tag: "Person", personId },
  evidenceRef: CredentialEvidenceRef.make("better-auth:session-1"),
};
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
  makeGrant({
    grantId: GrantId.make("grant-receipt-access"),
    subject: { _tag: "Person", personId },
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
  acceptedCredentials: [{ _tag: "None" }],
  principalKinds: ["Anonymous"],
  capabilities: { _tag: "None" },
  requirements: [],
  canonicalScopeResolver: SYSTEM_PUBLIC_SCOPE_RESOLVER,
  concealment: { _tag: "Reveal" },
  decisionTime: "SnapshotRead",
});

const receiptCommandAccess = makeAccessSpec({
  exposure: "External",
  acceptedCredentials: [{ _tag: "BetterAuthCookie" }],
  principalKinds: ["Person"],
  capabilities: { _tag: "One", capability: { type: APPROVE_RECEIPT_CAPABILITY } },
  requirements: [
    { id: RECEIPT_PENDING_REQUIREMENT, parameters: {} },
    { id: RECEIPT_APPROVER_REQUIREMENT, parameters: {} },
  ],
  canonicalScopeResolver: RECEIPT_BY_ID_SCOPE_RESOLVER,

  concealment: { _tag: "Reveal" },
  decisionTime: "Transaction",
});

describe("principal, credential, and access algebra", () => {
  it("decodes every deferred OAuth credential and the service principal independently", () => {
    const servicePrincipal = Schema.decodeUnknownSync(PrincipalSchema)({
      _tag: "ServicePrincipal",
      servicePrincipalId: ServicePrincipalId.make("service-sync"),
    });
    const mechanisms = [
      Schema.decodeUnknownSync(CredentialMechanismSchema)({ _tag: "OAuthUserBearer" }),
      Schema.decodeUnknownSync(CredentialMechanismSchema)({ _tag: "OAuthServiceBearer" }),
    ];

    expect(servicePrincipal).toEqual({
      _tag: "ServicePrincipal",
      servicePrincipalId: "service-sync",
    });
    expect(mechanisms.map(({ _tag }) => _tag)).toEqual(["OAuthUserBearer", "OAuthServiceBearer"]);
  });

  it("records the bounded 0055.1 tracer journey without credential material", () => {
    const context = receiptContext();
    const anonymousCredential: CredentialOutcome = {
      _tag: "Accepted",
      mechanism: { _tag: "None" },
      principal: { _tag: "Anonymous" },
      evidenceRef: CredentialEvidenceRef.make("anonymous:none"),
    };
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
    const ownerGrant = receiptGrant({ _tag: "Resource", resource: context.resource! });
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
        mechanism: { _tag: "None" },
        credential: anonymousCredential,
        resolution: publicResolution,
        grants: [],
        evaluation: publicDecision,
      }),
      traceAccess({
        declarationId: "proof.protected-read",
        spec: INTERNAL_RECEIPT_EVIDENCE_ACCESS,
        mechanism: { _tag: "BetterAuthCookie" },
        credential: personCredential,
        resolution: receiptResolution,
        grants: [ownerGrant],
        evaluation: ownerDecision,
      }),
      traceAccess({
        declarationId: "proof.wrong-department",
        spec: INTERNAL_RECEIPT_EVIDENCE_ACCESS,
        mechanism: { _tag: "BetterAuthCookie" },
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
      Schema.decodeUnknownSync(ScopeSchema)({ _tag: "Tenant", tenantId: "tenant-one" }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(ScopeSchema)({ _tag: "Receipt" })).toThrow();
    expect(() =>
      makeAccessSpec({
        ...publicAccess,
        acceptedCredentials: [{ _tag: "None" }, { _tag: "BetterAuthCookie" }],
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
    let tooDeep: unknown = { _tag: "Global" };
    for (let depth = 0; depth < 16; depth += 1) {
      tooDeep = { _tag: "And", left: { _tag: "Global" }, right: tooDeep };
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
      credential: {
        _tag: "Accepted",
        mechanism: { _tag: "OAuthUserBearer" },
        principal: { _tag: "Person", personId },
        evidenceRef: CredentialEvidenceRef.make("oauth:user"),
      },
      resolution,
      grants: [],
      authorizationInstant: instant,
    });
    const mechanismPrincipalMismatch = evaluateAccess({
      spec: receiptCommandAccess,
      credential: {
        _tag: "Accepted",
        mechanism: { _tag: "BetterAuthCookie" },
        principal: {
          _tag: "ServicePrincipal",
          servicePrincipalId: ServicePrincipalId.make("invalid-cookie-service"),
        },
        evidenceRef: CredentialEvidenceRef.make("cookie:invalid-principal"),
      },
      resolution,
      grants: [],
      authorizationInstant: instant,
    });
    const invitationSpec = makeAccessSpec({
      exposure: "External",
      acceptedCredentials: [
        {
          _tag: "ObjectCapability",
          capabilityType: INVITATION_RESPONSE_CAPABILITY,
        },
      ],
      principalKinds: ["CapabilityHolder"],
      capabilities: {
        _tag: "Any",
        capabilities: [
          { type: INVITATION_RESPONSE_CAPABILITY },
          { type: READ_INTERNAL_RECEIPT_EVIDENCE_CAPABILITY },
        ],
      },
      requirements: [],
      canonicalScopeResolver: SYSTEM_PUBLIC_SCOPE_RESOLVER,
      concealment: { _tag: "Reveal" },
      decisionTime: "SnapshotRead",
    });
    const wrongObjectCapabilityType = evaluateAccess({
      spec: invitationSpec,
      credential: {
        _tag: "Accepted",
        mechanism: {
          _tag: "ObjectCapability",
          capabilityType: READ_INTERNAL_RECEIPT_EVIDENCE_CAPABILITY,
        },
        principal: {
          _tag: "CapabilityHolder",
          capabilityId: CapabilityId.make("wrong-capability-type"),
        },
        evidenceRef: CredentialEvidenceRef.make("capability:wrong-type"),
      },
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

    expect(oauthAtCookieEndpoint).toEqual({
      _tag: "CredentialRejected",
      reason: "WrongMechanism",
    });
    expect(mechanismPrincipalMismatch).toEqual({
      _tag: "CredentialRejected",
      reason: "WrongMechanism",
    });
    expect(wrongObjectCapabilityType).toEqual({
      _tag: "CredentialRejected",
      reason: "WrongMechanism",
    });
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
            Effect.succeed({
              _tag: "Accepted" as const,
              mechanism: { _tag: "OAuthUserBearer" as const },
              principal: { _tag: "Person" as const, personId },
              evidenceRef: CredentialEvidenceRef.make("oauth:wrong-endpoint"),
            }),
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

      expect(decision).toEqual({ _tag: "CredentialRejected", reason: "WrongMechanism" });
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
      credential: {
        _tag: "Accepted",
        mechanism: { _tag: "None" },
        principal: { _tag: "Anonymous" },
        evidenceRef: CredentialEvidenceRef.make("anonymous:requirement"),
      },
      resolution: { selection: "ExactlyOne", contexts: [receiptContext()] },
      grants: [],
      authorizationInstant: instant,
    });

    expect(decision).toEqual({
      _tag: "Deny",
      stage: "Requirement",
      reason: "RequirementFailed",
    });
  });

  it("keeps Domain and Department independent and normalizes And and Or", () => {
    const context = receiptContext();
    expect(scopeMatches({ _tag: "Domain", domainId: RECEIPT_DOMAIN_ID }, context)).toBe(true);
    expect(scopeMatches({ _tag: "Department", departmentId: betaDepartment }, context)).toBe(false);
    expect(
      scopeMatches(
        {
          _tag: "And",
          left: { _tag: "Domain", domainId: RECEIPT_DOMAIN_ID },
          right: { _tag: "Department", departmentId: betaDepartment },
        },
        context,
      ),
    ).toBe(false);
    const domain = { _tag: "Domain" as const, domainId: RECEIPT_DOMAIN_ID };
    expect(normalizeScope({ _tag: "Or", left: domain, right: domain })).toEqual(domain);
    const global = { _tag: "Global" as const };
    const department = { _tag: "Department" as const, departmentId: alphaDepartment };
    expect(
      normalizeScope({
        _tag: "And",
        left: { _tag: "And", left: global, right: domain },
        right: department,
      }),
    ).toEqual(
      normalizeScope({
        _tag: "And",
        left: global,
        right: { _tag: "And", left: domain, right: department },
      }),
    );
    expect(
      normalizeScope({
        _tag: "Or",
        left: { _tag: "Or", left: global, right: domain },
        right: department,
      }),
    ).toEqual(
      normalizeScope({
        _tag: "Or",
        left: global,
        right: { _tag: "Or", left: domain, right: department },
      }),
    );
    expect(
      normalizeScope({
        _tag: "Or",
        left: domain,
        right: { _tag: "Or", left: domain, right: department },
      }),
    ).toEqual(normalizeScope({ _tag: "Or", left: domain, right: department }));
    expect(
      normalizeScope({
        _tag: "And",
        left: domain,
        right: { _tag: "And", left: domain, right: department },
      }),
    ).toEqual(normalizeScope({ _tag: "And", left: domain, right: department }));
  });

  it("allows the internal owner and returns 401 only for credential failure", () => {
    const context = receiptContext();
    const grant = receiptGrant({ _tag: "Resource", resource: context.resource! });
    const allowed = evaluateAccess({
      spec: INTERNAL_RECEIPT_EVIDENCE_ACCESS,
      credential: personCredential,
      resolution: { selection: "ExactlyOne", contexts: [context] },
      grants: [grant],
      authorizationInstant: instant,
    });
    const rejected = evaluateAccess({
      spec: INTERNAL_RECEIPT_EVIDENCE_ACCESS,
      credential: { _tag: "Rejected", reason: "Missing" },
      resolution: { selection: "ExactlyOne", contexts: [context] },
      grants: [],
      authorizationInstant: instant,
    });

    expect(allowed._tag).toBe("Allow");
    expect(accessHttpStatus(allowed, INTERNAL_RECEIPT_EVIDENCE_ACCESS.concealment)).toBe(200);
    expect(rejected).toEqual({ _tag: "CredentialRejected", reason: "Missing" });
    expect(accessHttpStatus(rejected, INTERNAL_RECEIPT_EVIDENCE_ACCESS.concealment)).toBe(401);
  });

  it("does not let a global-administrator role macro bypass ownership", () => {
    const context = receiptContext(alphaDepartment, otherPersonId);
    const globalGrant = receiptGrant({ _tag: "Global" });
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

    expect(decision).toEqual({
      _tag: "Deny",
      stage: "Requirement",
      reason: "RequirementFailed",
    });
    expect(accessHttpStatus(decision, INTERNAL_RECEIPT_EVIDENCE_ACCESS.concealment)).toBe(403);
  });

  it("keeps a wrong department denial at 403 and performs no transaction effect", () => {
    const context = receiptContext(betaDepartment);
    const grant = makeGrant({
      grantId: GrantId.make("grant-approve-alpha"),
      subject: { _tag: "Person", personId },
      capability: { type: APPROVE_RECEIPT_CAPABILITY },
      scope: { _tag: "Department", departmentId: alphaDepartment },
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
    if (decision._tag === "Allow") transitions += 1;

    expect(decision).toEqual({ _tag: "Deny", stage: "Scope", reason: "NotInScope" });
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
      const grant = receiptGrant({ _tag: "Resource", resource: context.resource! });
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
      expect(retry).toEqual({
        _tag: "Deny",
        stage: "Capability",
        reason: "CapabilityMissing",
      });
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
    const mechanism = {
      _tag: "ObjectCapability" as const,
      capabilityType: INVITATION_RESPONSE_CAPABILITY,
    };
    const spec = makeAccessSpec({
      exposure: "External",
      acceptedCredentials: [mechanism],
      principalKinds: ["CapabilityHolder"],
      capabilities: {
        _tag: "One",
        capability: { type: INVITATION_RESPONSE_CAPABILITY },
      },
      requirements: [],
      canonicalScopeResolver: SYSTEM_PUBLIC_SCOPE_RESOLVER,
      concealment: { _tag: "NotFound", conceal: ["CredentialFailure"] },
      decisionTime: "SnapshotRead",
    });
    const invitationContext: CanonicalResourceContext = {
      domainId: SYSTEM_DOMAIN_ID,
      departmentId: null,
      resource: {
        kind: RECRUITMENT_INVITATION_RESOURCE_KIND,
        id: ResourceId.make("invitation-one"),
      },
      facts: {},
      authorityVersion: AuthorityVersion.make("invitation:1"),
    };
    const rejectedCredential: CredentialOutcome = { _tag: "Rejected", reason: "Invalid" };
    const rejected = evaluateAccess({
      spec,
      credential: rejectedCredential,
      resolution: { selection: "ExactlyOne", contexts: [invitationContext] },
      grants: [],
      authorizationInstant: instant,
    });
    const principal = { _tag: "CapabilityHolder" as const, capabilityId };
    const grant = makeGrant({
      grantId: GrantId.make("grant-invitation-one"),
      subject: principal,
      capability: { type: INVITATION_RESPONSE_CAPABILITY },
      scope: { _tag: "Resource", resource: invitationContext.resource },
      startAt: AuthorizationInstant.make("2031-01-01T00:00:00.000Z"),
      endAt: null,
      requirements: [],
      source: AuthorityRef.make("recruitment.invitation-authority"),
      revision: 0,
    });
    const acceptedCredential: CredentialOutcome = {
      _tag: "Accepted",
      mechanism,
      principal,
      evidenceRef: CredentialEvidenceRef.make("invitation:resolved-capability"),
    };
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
    const credential: CredentialOutcome = {
      _tag: "Accepted",
      mechanism: { _tag: "None" },
      principal: { _tag: "Anonymous" },
      evidenceRef: CredentialEvidenceRef.make("anonymous:none"),
    };
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
        mechanism: { _tag: "None" },
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

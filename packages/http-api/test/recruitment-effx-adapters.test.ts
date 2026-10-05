import { Capability, Concealment, type HttpAccessAnnotationSpec } from "@effx/runtime";
import { Context, Option, Predicate, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { RecruitmentApi } from "../.effx/generated/recruitment-contract.js";
import { AccessSpecAnnotation, reflectAccessSpec } from "../src/access.js";
import { InvitationCapabilitySecurity, PersonSecurity } from "../src/common.js";
import {
  RecruitmentScopeResolvers,
  invitationCommandAccessAnnotations,
  invitationReadAccessAnnotations,
  recruitmentCommandAccessAnnotations,
  recruitmentReadAccessAnnotations,
} from "../src/recruitment-effx-adapters.js";

/** The generated group supplies the inventory; each control alters one authority fact. */
const cases = Object.values(RecruitmentApi.endpoints).map((endpoint) => {
  const native = Option.getOrThrow(reflectAccessSpec(endpoint));

  if (!Predicate.isTagged(native.capabilities, "One")) {
    throw new TypeError("Every repaired Recruitment operation requires one capability");
  }

  const resolver = RecruitmentScopeResolvers.find(
    (symbol) => symbol.id === native.canonicalScopeResolver,
  );

  if (resolver === undefined) throw new TypeError("Unknown Recruitment scope resolver");

  const invitation = native.principalKinds[0] === "CapabilityHolder";

  const declared: HttpAccessAnnotationSpec = {
    exposure: "External",
    acceptedCredentials: invitation ? ["ObjectCapability"] : ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: invitation ? ["CapabilityHolder"] : ["Person"],
    capabilities: Capability.one(native.capabilities.capability.type),
    requirements: native.requirements,
    canonicalScopeResolver: resolver,
    concealment: invitation
      ? Concealment.notFound("CredentialFailure", "PrincipalKind", "Capability", "Scope", "Requirement")
      : Concealment.reveal,
    decisionTime: native.decisionTime,
  };

  const annotate = invitation
    ? native.decisionTime === "SnapshotRead"
      ? invitationReadAccessAnnotations
      : invitationCommandAccessAnnotations
    : native.decisionTime === "SnapshotRead"
      ? recruitmentReadAccessAnnotations
      : recruitmentCommandAccessAnnotations;

  return { endpoint, native, declared, annotate, invitation };
});

describe("Recruitment generated authority contract", () => {
  it("keeps the repaired access policy and dedicated credential at every generated operation", () => {
    expect(cases).toHaveLength(16);
    expect(cases.filter(({ invitation }) => invitation)).toHaveLength(4);

    for (const { endpoint, native, declared, annotate, invitation } of cases) {
      expect(Context.get(annotate(declared), AccessSpecAnnotation)).toEqual(native);
      let hasInvitationSecurity = false;
      let hasPersonSecurity = false;

      for (const middleware of endpoint.middlewares) {
        if (middleware === InvitationCapabilitySecurity) hasInvitationSecurity = true;

        if (middleware === PersonSecurity) hasPersonSecurity = true;
      }

      expect(hasInvitationSecurity).toBe(invitation);
      expect(hasPersonSecurity).toBe(!invitation);
    }
  });

  for (const { endpoint, declared, annotate, invitation } of cases) {
    it(`${endpoint.identifier} rejects widened credentials, capability, resolver, time, concealment and requirements`, () => {
      const mutations = [
        { ...declared, exposure: "Internal" },
        { ...declared, acceptedCredentials: ["None"] as const },
        { ...declared, acceptedCredentials: ["ObjectCapability", "BetterAuthCookie"] as const },
        { ...declared, principalKinds: ["Anonymous"] as const },
        { ...declared, capabilities: Capability.none },
        { ...declared, capabilities: Capability.one("contact.submit") },
        { ...declared, capabilities: Capability.any("recruitment.invitation-response", "reviewApplicants") },
        { ...declared, canonicalScopeResolver: { id: "recruitment.interview-by-id" } },
        { ...declared, canonicalScopeResolver: {} },
        {
          ...declared,
          decisionTime: declared.decisionTime === "Transaction" ? "SnapshotRead" : "Transaction",
        },
        {
          ...declared,
          concealment: invitation ? Concealment.reveal : Concealment.notFound("Scope"),
        },
        {
          ...declared,
          requirements: declared.requirements.length === 0
            ? [{ id: "recruitment.not-known-self" }]
            : declared.requirements.slice(0, -1),
        },
        {
          ...declared,
          requirements: [{ id: "recruitment.not-known-self", parameters: { unexpected: true } }],
        },
        Object.assign({}, declared, { extra: "unexpected" }),
      ] satisfies ReadonlyArray<HttpAccessAnnotationSpec>;

      for (const mutation of mutations) expect(() => annotate(mutation)).toThrow();
    });

    if (invitation) {
      it(`${endpoint.identifier} cannot reveal any omitted concealment stage or accept a Person policy`, () => {
        for (const missing of ["CredentialFailure", "PrincipalKind", "Capability", "Scope", "Requirement"]) {
          const stages = ["CredentialFailure", "PrincipalKind", "Capability", "Scope", "Requirement"].filter(
            (stage) => stage !== missing,
          );

          expect(() => annotate({ ...declared, concealment: Concealment.notFound(...Schema.decodeUnknownSync(Schema.NonEmptyArray(Schema.String))(stages)) })).toThrow();
        }

        expect(() => annotate({
          ...declared,
          acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
          principalKinds: ["Person"],
        })).toThrow();
      });
    }
  }
});

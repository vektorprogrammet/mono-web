import { Capability, Concealment, type HttpAccessAnnotationSpec } from "@effx/runtime";
import { describe, expect, it } from "vitest";
import {
  AdmissionsApplicationCreateResolver,
  AdmissionsManagementPeriodsResolver,
  AdmissionsPeriodByIdResolver,
  AdmissionsPublicApplicationByIdResolver,
  AdmissionsPublicOpenPeriodsResolver,
  admissionsAccessAnnotations,
} from "../src/admissions-effx-adapters.js";
import { ProfileCurrentPerson } from "../src/profile-effx-adapters.js";

/** An exported resolver symbol that a declaration names. */
interface ResolverSymbol {
  readonly id: string;
}

const person = (
  capability: string,
  canonicalScopeResolver: ResolverSymbol,
  decisionTime: HttpAccessAnnotationSpec["decisionTime"],
  requirements: HttpAccessAnnotationSpec["requirements"] = [],
): HttpAccessAnnotationSpec => ({
  exposure: "External",
  acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
  principalKinds: ["Person"],
  capabilities: Capability.one(capability),
  requirements,
  canonicalScopeResolver,
  concealment: Concealment.reveal,
  decisionTime,
});

const anonymous = (
  canonicalScopeResolver: ResolverSymbol,
  decisionTime: HttpAccessAnnotationSpec["decisionTime"],
): HttpAccessAnnotationSpec => ({
  exposure: "External",
  acceptedCredentials: ["None"],
  principalKinds: ["Anonymous"],
  capabilities: Capability.none,
  requirements: [],
  canonicalScopeResolver,
  concealment: Concealment.reveal,
  decisionTime,
});

describe("Admissions access adapter", () => {
  it("annotates the approved accesses", () => {
    const approved = [
      anonymous(AdmissionsPublicOpenPeriodsResolver, "SnapshotRead"),
      anonymous(AdmissionsApplicationCreateResolver, "Transaction"),
      anonymous(AdmissionsPublicApplicationByIdResolver, "SnapshotRead"),
      person("admissions.read-applicant-progress", ProfileCurrentPerson, "SnapshotRead", [
        { id: "profile.owner" },
      ]),
      person("admissions.read-periods", AdmissionsManagementPeriodsResolver, "SnapshotRead"),
      person("admissions.revise-period", AdmissionsPeriodByIdResolver, "Transaction"),
      person("placements.self", ProfileCurrentPerson, "SnapshotRead"),
      person("placements.self", ProfileCurrentPerson, "Transaction"),
    ];

    for (const access of approved) {
      expect(() => admissionsAccessAnnotations(access)).not.toThrow();
    }
  });

  it("rejects a public access that is not public, a widened person access and a wrong time", () => {
    const refused = [
      anonymous(AdmissionsPeriodByIdResolver, "SnapshotRead"),
      anonymous(AdmissionsApplicationCreateResolver, "SnapshotRead"),
      person("admissions.revise-period", AdmissionsPeriodByIdResolver, "SnapshotRead"),
      person("admissions.read-applicant-progress", ProfileCurrentPerson, "SnapshotRead"),
      person("admissions.create-period", AdmissionsPeriodByIdResolver, "Transaction"),
    ];

    for (const access of refused) {
      expect(() => admissionsAccessAnnotations(access)).toThrow();
    }
  });
});

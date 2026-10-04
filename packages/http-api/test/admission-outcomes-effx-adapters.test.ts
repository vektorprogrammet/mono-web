import { Capability, Concealment, type HttpAccessAnnotationSpec } from "@effx/runtime";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AdmissionOutcomeCommandProblemCodes,
  AdmissionOutcomeProblemCodes,
  AdmissionOutcomeTemplateProblemCodes,
} from "../src/admission-outcomes.js";
import {
  AdmissionOutcomeCommandCodes,
  AdmissionOutcomeReadCodes,
  AdmissionOutcomeTemplateCodes,
  admissionOutcomesAccessAnnotations,
  AdmissionOutcomesAnnouncementResolver,
  AdmissionOutcomesApplicationOutcomesResolver,
  AdmissionOutcomesTemplatesResolver,
} from "../src/admission-outcomes-effx-adapters.js";

/**
 * `admission-outcomes.ts` owns the order of the three problem lists, composed with spreads. The
 * effx declarations need flat literal tuples, so the adapters repeat them. Each flat tuple must
 * equal its source element for element, in order, at runtime and at the type level, so that a
 * reordered or edited code on either side fails here.
 */
describe("flat outcome problem tuples", () => {
  it("equals the composed source of the three reads", () => {
    expect([...AdmissionOutcomeReadCodes]).toStrictEqual([...AdmissionOutcomeProblemCodes]);
    expectTypeOf<typeof AdmissionOutcomeReadCodes>().toEqualTypeOf<
      typeof AdmissionOutcomeProblemCodes
    >();
  });

  it("equals the composed source of the three commands", () => {
    expect([...AdmissionOutcomeCommandCodes]).toStrictEqual([
      ...AdmissionOutcomeCommandProblemCodes,
    ]);
    expectTypeOf<typeof AdmissionOutcomeCommandCodes>().toEqualTypeOf<
      typeof AdmissionOutcomeCommandProblemCodes
    >();
  });

  it("equals the composed source of the template read and preview", () => {
    expect([...AdmissionOutcomeTemplateCodes]).toStrictEqual([
      ...AdmissionOutcomeTemplateProblemCodes,
    ]);
    expectTypeOf<typeof AdmissionOutcomeTemplateCodes>().toEqualTypeOf<
      typeof AdmissionOutcomeTemplateProblemCodes
    >();
  });

  it("has the 17, 24 and 18 codes of spec 0026", () => {
    expect([
      AdmissionOutcomeReadCodes.length,
      AdmissionOutcomeCommandCodes.length,
      AdmissionOutcomeTemplateCodes.length,
    ]).toStrictEqual([17, 24, 18]);
  });
});

/** An exported resolver symbol that a declaration names. */
interface ResolverSymbol {
  readonly id: string;
}

const access = (
  capabilities: HttpAccessAnnotationSpec["capabilities"],
  canonicalScopeResolver: ResolverSymbol,
  decisionTime: HttpAccessAnnotationSpec["decisionTime"],
  requirements: HttpAccessAnnotationSpec["requirements"] = [],
): HttpAccessAnnotationSpec => ({
  exposure: "External",
  acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
  principalKinds: ["Person"],
  capabilities,
  requirements,
  canonicalScopeResolver,
  concealment: Concealment.reveal,
  decisionTime,
});

describe("outcome access adapter", () => {
  it("annotates the approved policies", () => {
    const approved = [
      access(
        Capability.any("admissions.outcomes.read", "admissions.outcomes.announce"),
        AdmissionOutcomesApplicationOutcomesResolver,
        "SnapshotRead",
      ),
      access(
        Capability.one("admissions.outcomes.decide"),
        AdmissionOutcomesApplicationOutcomesResolver,
        "Transaction",
      ),
      access(
        Capability.one("admissions.outcomes.announce"),
        AdmissionOutcomesAnnouncementResolver,
        "Transaction",
        [{ id: "admissions.department-coordinator" }],
      ),
      access(
        Capability.one("admissions.outcome-templates.edit"),
        AdmissionOutcomesTemplatesResolver,
        "SnapshotRead",
      ),
    ];

    for (const spec of approved) {
      expect(() => admissionOutcomesAccessAnnotations(spec)).not.toThrow();
    }
  });

  it("rejects a widened capability, another resolver, another time or a dropped requirement", () => {
    const refused = [
      access(
        Capability.one("admissions.outcomes.announce"),
        AdmissionOutcomesApplicationOutcomesResolver,
        "Transaction",
      ),
      access(
        Capability.one("admissions.outcomes.decide"),
        AdmissionOutcomesTemplatesResolver,
        "Transaction",
      ),
      access(
        Capability.one("admissions.outcomes.decide"),
        AdmissionOutcomesApplicationOutcomesResolver,
        "SnapshotRead",
      ),
      access(
        Capability.one("admissions.outcomes.announce"),
        AdmissionOutcomesAnnouncementResolver,
        "Transaction",
      ),
      access(
        Capability.any("admissions.outcomes.announce", "admissions.outcomes.read"),
        AdmissionOutcomesApplicationOutcomesResolver,
        "SnapshotRead",
      ),
    ];

    for (const spec of refused) {
      expect(() => admissionOutcomesAccessAnnotations(spec)).toThrow();
    }
  });
});

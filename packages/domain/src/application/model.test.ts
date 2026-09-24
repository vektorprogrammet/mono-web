import { DepartmentId } from "../organization/schema.js";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { ApplicantRecord, PublicApplication } from "./schema.js";

it.effect("strictly decodes persisted records without exposing sensitive fields", () => {
  const applicant = {
    id: "applicant-model-1",
    normalizedEmail: "ada@example.com",
    email: "ADA@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    phone: "+47 12345678",
    gender: 1,
    fieldOfStudyId: "field-1",
    yearOfStudy: 3,
    activationDigest: null,
  };

  const application = {
    id: "application-model-1",
    applicantId: "applicant-model-1",
    admissionPeriodId: "period-1",
    departmentId: DepartmentId.make("department-1"),
    fieldOfStudyId: "field-1",
    yearOfStudy: 3,
    submittedAt: "2026-08-23T12:00:00.000Z",
    revision: 0,
    activationDigest: null,
  };

  return Effect.gen(function* () {
    const decodedApplicant = yield* Schema.decodeUnknownEffect(ApplicantRecord)(applicant, {
      onExcessProperty: "error",
    });

    expect(decodedApplicant).not.toBe(applicant);
    applicant.email = "changed@example.com";
    expect(decodedApplicant.email).toBe("ADA@example.com");

    const decodedApplication = yield* Schema.decodeUnknownEffect(PublicApplication)(application, {
      onExcessProperty: "error",
    });

    expect(decodedApplication.id).toBe("application-model-1");

    const excess = yield* Effect.flip(
      Schema.decodeUnknownEffect(ApplicantRecord)(
        { ...applicant, email: "ADA@example.com", duplicateAuthority: true },
        { onExcessProperty: "error" },
      ),
    );

    expect(String(excess)).toContain("duplicateAuthority");

    const invalidInteger = yield* Effect.flip(
      Schema.decodeUnknownEffect(PublicApplication)(
        { ...application, yearOfStudy: 2.5 },
        { onExcessProperty: "error" },
      ),
    );

    expect(String(invalidInteger)).toContain("yearOfStudy");

    const invalidActivation = yield* Effect.flip(
      Schema.decodeUnknownEffect(PublicApplication)(
        { ...application, activationDigest: "not-a-sha256" },
        { onExcessProperty: "error" },
      ),
    );

    expect(String(invalidActivation)).toContain("activationDigest");
  });
});

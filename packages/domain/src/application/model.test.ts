import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { ApplicantRecord, PublicApplication } from "./schema.js";

const keys = (fields: object): ReadonlyArray<string> => Object.keys(fields).sort();

it("derives applicant and public-application variants from one Model declaration", () => {
  expect(keys(ApplicantRecord.fields)).toEqual([
    "activationDigest",
    "email",
    "fieldOfStudyId",
    "firstName",
    "gender",
    "id",
    "lastName",
    "normalizedEmail",
    "phone",
    "yearOfStudy",
  ]);
  expect(keys(ApplicantRecord.insert.fields)).toEqual([
    "activationDigest",
    "email",
    "fieldOfStudyId",
    "firstName",
    "gender",
    "id",
    "lastName",
    "normalizedEmail",
    "phone",
    "yearOfStudy",
  ]);
  expect(keys(ApplicantRecord.update.fields)).toEqual([
    "activationDigest",
    "email",
    "fieldOfStudyId",
    "firstName",
    "gender",
    "lastName",
    "phone",
    "yearOfStudy",
  ]);
  expect(keys(ApplicantRecord.json.fields)).toEqual([
    "fieldOfStudyId",
    "firstName",
    "gender",
    "id",
    "lastName",
    "phone",
    "yearOfStudy",
  ]);
  expect(keys(ApplicantRecord.jsonCreate.fields)).toEqual([
    "fieldOfStudyId",
    "firstName",
    "gender",
    "lastName",
    "phone",
    "yearOfStudy",
  ]);
  expect(keys(ApplicantRecord.jsonUpdate.fields)).toEqual([
    "fieldOfStudyId",
    "firstName",
    "gender",
    "lastName",
    "phone",
    "yearOfStudy",
  ]);

  expect(keys(PublicApplication.fields)).toEqual([
    "activationDigest",
    "admissionPeriodId",
    "applicantId",
    "departmentId",
    "fieldOfStudyId",
    "id",
    "revision",
    "submittedAt",
    "yearOfStudy",
  ]);
  expect(keys(PublicApplication.insert.fields)).toEqual([
    "activationDigest",
    "admissionPeriodId",
    "applicantId",
    "departmentId",
    "fieldOfStudyId",
    "id",
    "revision",
    "submittedAt",
    "yearOfStudy",
  ]);
  expect(keys(PublicApplication.update.fields)).toEqual([]);
  expect(keys(PublicApplication.json.fields)).toEqual([
    "admissionPeriodId",
    "applicantId",
    "departmentId",
    "fieldOfStudyId",
    "id",
    "revision",
    "submittedAt",
    "yearOfStudy",
  ]);
  expect(keys(PublicApplication.jsonCreate.fields)).toEqual([]);
  expect(keys(PublicApplication.jsonUpdate.fields)).toEqual([]);
});

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
    departmentId: "department-1",
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

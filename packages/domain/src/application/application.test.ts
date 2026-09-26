import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { AdmissionFieldOfStudyId, AdmissionPeriodId } from "../admission-period/schema.js";
import { DepartmentId } from "../organization/schema.js";
import {
  ApplicantIdSchema,
  makePublicApplicationOutboxRequests,
  makeRecordingPublicApplicationEffectInterpreter,
  PublicApplicationIdSchema,
  publicApplicationCommandDigest,
  recordPublicApplicationEffects,
  decodePublicApplicationSubmitInput,
} from "./index.js";

const activationToken = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

const availability = {
  mondayUnavailable: false,
  tuesdayUnavailable: true,
  wednesdayUnavailable: false,
  thursdayUnavailable: false,
  fridayUnavailable: false,
  positionWeeks: 4,
  preferredGroup: "all",
  language: "Norsk",
} as const;

const input = {
  commandId: "command-1",
  departmentId: DepartmentId.make("department-1"),
  firstName: " Ada ",
  lastName: " Lovelace ",
  phone: " +47 12345678 ",
  email: " ADA@EXAMPLE.COM ",
  gender: 1,
  fieldOfStudyId: "field-1",
  yearOfStudy: 3,
  availability,
} as const;

const application = {
  id: PublicApplicationIdSchema.make("application-1"),
  applicantId: ApplicantIdSchema.make("applicant-1"),
  admissionPeriodId: AdmissionPeriodId.make("period-1"),
  departmentId: DepartmentId.make("department-1"),
  fieldOfStudyId: AdmissionFieldOfStudyId.make("field-1"),
  yearOfStudy: 3,
  submittedAt: "2026-08-23T12:00:00.000Z",
  revision: 0,
  activationDigest: null,
  availability,
} as const;

const applicant = {
  id: ApplicantIdSchema.make("applicant-1"),
  normalizedEmail: "ada@example.com",
  email: "ADA@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  phone: "+47 12345678",
  gender: 1 as const,
  fieldOfStudyId: AdmissionFieldOfStudyId.make("field-1"),
  yearOfStudy: 3,
  activationDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
} as const;

describe("public applicant domain", () => {
  it.effect("normalizes identity without changing the exact field set", () =>
    Effect.gen(function* () {
      const normalized = yield* decodePublicApplicationSubmitInput(input);
      expect(normalized).toEqual({
        ...input,
        firstName: "Ada",
        lastName: "Lovelace",
        phone: "+47 12345678",
        email: "ada@example.com",
      });
      expect(Object.keys(normalized)).toEqual([
        "commandId",
        "departmentId",
        "firstName",
        "lastName",
        "phone",
        "email",
        "gender",
        "fieldOfStudyId",
        "yearOfStudy",
        "availability",
      ]);
    }),
  );

  it.effect("uses normalized canonical bytes for replay identity", () =>
    Effect.gen(function* () {
      const normalized = yield* decodePublicApplicationSubmitInput(input);

      const equivalent = yield* decodePublicApplicationSubmitInput({
        ...input,
        firstName: "Ada",
        lastName: "Lovelace",
        phone: "+47 12345678",
        email: "ada@example.com",
      });

      expect(publicApplicationCommandDigest(normalized)).toBe(
        publicApplicationCommandDigest(equivalent),
      );

      // A replay that states other availability is another command, not the same one.
      const otherAvailability = yield* decodePublicApplicationSubmitInput({
        ...input,
        availability: { ...availability, positionWeeks: 8 },
      });

      expect(publicApplicationCommandDigest(otherAvailability)).not.toBe(
        publicApplicationCommandDigest(normalized),
      );
    }),
  );

  it.effect("records only ordered effect metadata and deduplicates delivery state", () =>
    Effect.gen(function* () {
      const normalized = yield* decodePublicApplicationSubmitInput(input);

      const requests = makePublicApplicationOutboxRequests(
        normalized,
        application,
        applicant,
        applicant.email,
        activationToken,
      );

      expect(requests[0]).toMatchObject({ activationToken });
      const interpreter = makeRecordingPublicApplicationEffectInterpreter();
      const first = yield* recordPublicApplicationEffects(requests, interpreter);
      const retry = yield* recordPublicApplicationEffects([requests[0]!], interpreter);
      expect(first.map((entry) => entry.kind)).toEqual([
        "SendApplicantActivationOrConfirmation",
        "CreateAdmissionSubscription",
        "WriteApplicationAudit",
      ]);
      expect(retry[0]?.attempts).toBe(2);
      expect(interpreter.duplicateDeliveryCount()).toBe(1);
      expect(interpreter.snapshot()).toHaveLength(3);
      expect(first[0]).not.toHaveProperty("email");
    }),
  );
});

import { Schema } from "effect";

/** Stable IDs are opaque, non-empty, and free of control characters. */
export const PublicApplicationIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => value.trim().length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value),
      { message: "a non-empty stable identifier" },
    ),
  ),
);
export type PublicApplicationId = typeof PublicApplicationIdSchema.Type;



export const isPublicApplicationName = (value: string): boolean => {
  const normalized = value.trim();
  return (
    normalized.length > 0 &&
    Array.from(normalized).length <= 100 &&
    !/[\p{Cc}\p{Cf}]/u.test(normalized)
  );
};

export const isPublicApplicationPhone = (value: string): boolean => {
  const normalized = value.trim();
  return (
    normalized.length > 0 &&
    Array.from(normalized).length <= 32 &&
    !/[\p{Cc}\p{Cf}]/u.test(normalized)
  );
};

export const isPublicApplicationEmail = (value: string): boolean => {
  const normalized = value.trim();
  return (
    normalized.length > 0 &&
    Array.from(normalized).length <= 254 &&
    !/[\p{Cc}\p{Cf}\s]/u.test(normalized) &&
    /^[^@]+@[^@]+\.[^@]+$/u.test(normalized)
  );
};

export const PublicApplicationNameSchema = Schema.String.pipe(
  Schema.check(Schema.makeFilter(isPublicApplicationName, { message: "a valid name" })),
);

export const PublicApplicationPhoneSchema = Schema.String.pipe(
  Schema.check(Schema.makeFilter(isPublicApplicationPhone, { message: "a valid phone" })),
);

export const PublicApplicationEmailSchema = Schema.String.pipe(
  Schema.check(Schema.makeFilter(isPublicApplicationEmail, { message: "a valid email" })),
);

export const PublicApplicationGenderSchema = Schema.Literals([0, 1]);
export type PublicApplicationGender = typeof PublicApplicationGenderSchema.Type;

export const PublicApplicationYearOfStudySchema = Schema.Int.pipe(
  Schema.check(Schema.makeFilter((value) => value >= 1 && value <= 5, { message: "a year from 1 to 5" })),
);

const Sha256Schema = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value) => /^[a-f0-9]{64}$/u.test(value), { message: "a SHA-256 digest" })),
);

const PublicApplicationInstantPattern =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

export const isPublicApplicationInstant = (value: string): boolean => {
  const match = PublicApplicationInstantPattern.exec(value);
  if (match === null || Number.isNaN(Date.parse(value))) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(Number(match[1]), month, 0)).getUTCDate();
};

export const PublicApplicationInstantSchema = Schema.String.pipe(
  Schema.check(Schema.makeFilter(isPublicApplicationInstant, { message: "an RFC 3339 instant" })),
);
export type PublicApplicationInstant = typeof PublicApplicationInstantSchema.Type;

const SubmitPublicApplicationFields = {
  commandId: PublicApplicationIdSchema,
  departmentId: PublicApplicationIdSchema,
  firstName: PublicApplicationNameSchema,
  lastName: PublicApplicationNameSchema,
  phone: PublicApplicationPhoneSchema,
  email: PublicApplicationEmailSchema,
  gender: PublicApplicationGenderSchema,
  fieldOfStudyId: PublicApplicationIdSchema,
  yearOfStudy: PublicApplicationYearOfStudySchema,
};

/** Exact public request body. No `_tag`, applicant, period, or status fields are accepted. */
export const PublicApplicationSubmitInputSchema = Schema.Struct(SubmitPublicApplicationFields);
export type PublicApplicationSubmitInput = typeof PublicApplicationSubmitInputSchema.Type;

export const SubmitPublicApplicationInputSchema = PublicApplicationSubmitInputSchema;
export type SubmitPublicApplicationInput = PublicApplicationSubmitInput;

export const SubmitPublicApplicationCommandSchema = Schema.TaggedUnion({
  SubmitPublicApplication: SubmitPublicApplicationFields,
});
export type SubmitPublicApplicationCommand = typeof SubmitPublicApplicationCommandSchema.Type;

const ApplicantFields = {
  id: PublicApplicationIdSchema,
  normalizedEmail: PublicApplicationEmailSchema,
  firstName: PublicApplicationNameSchema,
  lastName: PublicApplicationNameSchema,
  phone: PublicApplicationPhoneSchema,
  gender: PublicApplicationGenderSchema,
  fieldOfStudyId: PublicApplicationIdSchema,
  yearOfStudy: PublicApplicationYearOfStudySchema,
  activationDigest: Schema.optional(Sha256Schema),
};

export const ApplicantSchema = Schema.Struct(ApplicantFields);
export type Applicant = typeof ApplicantSchema.Type;

/** Private persistence record; `email` never crosses the public response boundary. */
export const ApplicantRecordSchema = Schema.Struct({
  ...ApplicantFields,
  email: PublicApplicationEmailSchema,
});
export type ApplicantRecord = typeof ApplicantRecordSchema.Type;

export const PublicApplicationSchema = Schema.Struct({
  id: PublicApplicationIdSchema,
  applicantId: PublicApplicationIdSchema,
  admissionPeriodId: PublicApplicationIdSchema,
  departmentId: PublicApplicationIdSchema,
  fieldOfStudyId: PublicApplicationIdSchema,
  yearOfStudy: PublicApplicationYearOfStudySchema,
  submittedAt: PublicApplicationInstantSchema,
  revision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type PublicApplication = typeof PublicApplicationSchema.Type;

export const PublicApplicationSubmitObservationSchema = Schema.TaggedUnion({
  Submitted: {
    commandId: PublicApplicationIdSchema,
    applicationId: PublicApplicationIdSchema,
  },
});
export type PublicApplicationSubmitObservation = typeof PublicApplicationSubmitObservationSchema.Type;

export const PublicApplicationObservationSchema = PublicApplicationSubmitObservationSchema;
export type PublicApplicationObservation = PublicApplicationSubmitObservation;

export const PublicApplicationConfirmationSchema = Schema.Struct({
  _tag: Schema.Literals(["ApplicationConfirmed"]),
  applicationId: PublicApplicationIdSchema,
});
export type PublicApplicationConfirmation = typeof PublicApplicationConfirmationSchema.Type;

export const PublicApplicationFieldOfStudySchema = Schema.Struct({
  fieldOfStudyId: PublicApplicationIdSchema,
  name: Schema.String.pipe(Schema.check(Schema.makeFilter((value) => value.trim().length > 0, { message: "a field name" }))),
});
export type PublicApplicationFieldOfStudy = typeof PublicApplicationFieldOfStudySchema.Type;

export const PublicApplicationCatalogDepartmentSchema = Schema.Struct({
  departmentId: PublicApplicationIdSchema,
  name: Schema.String.pipe(Schema.check(Schema.makeFilter((value) => value.trim().length > 0, { message: "a department name" }))),
  closesAt: PublicApplicationInstantSchema,
  fieldsOfStudy: Schema.Array(PublicApplicationFieldOfStudySchema),
});
export type PublicApplicationCatalogDepartment = typeof PublicApplicationCatalogDepartmentSchema.Type;

export const PublicApplicationCatalogSchema = Schema.Struct({
  departments: Schema.Array(PublicApplicationCatalogDepartmentSchema),
});
export type PublicApplicationCatalog = typeof PublicApplicationCatalogSchema.Type;

export interface PublicApplicationCatalogContext {
  readonly now: string;
}

export interface PublicApplicationSubmitContext {
  readonly now: string;
  /** Optional server-generated opaque ID. It is never accepted from the public body. */
  readonly applicationId?: string;
  /** Optional server-owned applicant identity hint for a new normalized email. */
  readonly applicantId?: string;
}

export interface PublicApplicationSubmitResult {
  readonly observation: PublicApplicationSubmitObservation;
  readonly replayed: boolean;
  readonly outboxCount: number;
}

export const decodePublicApplicationConfirmation = (input: unknown) =>
  Schema.decodeUnknownEffect(PublicApplicationConfirmationSchema)(input, {
    onExcessProperty: "error",
  });

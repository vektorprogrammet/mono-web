import { Schema } from "effect";
import { Model } from "effect/unstable/schema";
import {
  AdmissionDepartment,
  AdmissionFieldOfStudy,
} from "../admission-period/schema.js";
import { isRfc3339Instant, Rfc3339InstantSchema } from "../time.js";

/** Stable IDs are opaque, non-empty, and free of control characters. */
export const PublicApplicationIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value), {
      message: "a non-empty stable identifier",
    }),
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
  Schema.check(
    Schema.makeFilter((value) => value >= 1 && value <= 5, { message: "a year from 1 to 5" }),
  ),
);

const Sha256Schema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => /^[a-f0-9]{64}$/u.test(value), { message: "a SHA-256 digest" }),
  ),
);

export const isPublicApplicationInstant = isRfc3339Instant;
export const PublicApplicationInstantSchema = Rfc3339InstantSchema;
export type PublicApplicationInstant = typeof PublicApplicationInstantSchema.Type;

export class ApplicantRecord extends Model.Class<ApplicantRecord>("ApplicantRecord")({
  id: Model.Field({
    select: PublicApplicationIdSchema,
    insert: PublicApplicationIdSchema,
    json: PublicApplicationIdSchema,
  }),
  normalizedEmail: Model.Field({
    select: PublicApplicationEmailSchema,
    insert: PublicApplicationEmailSchema,
    json: PublicApplicationEmailSchema,
  }),
  email: Model.Sensitive(PublicApplicationEmailSchema),
  firstName: Model.Field({
    select: PublicApplicationNameSchema,
    insert: PublicApplicationNameSchema,
    update: PublicApplicationNameSchema,
    json: PublicApplicationNameSchema,
    jsonCreate: PublicApplicationNameSchema,
    jsonUpdate: PublicApplicationNameSchema,
  }),
  lastName: Model.Field({
    select: PublicApplicationNameSchema,
    insert: PublicApplicationNameSchema,
    update: PublicApplicationNameSchema,
    json: PublicApplicationNameSchema,
    jsonCreate: PublicApplicationNameSchema,
    jsonUpdate: PublicApplicationNameSchema,
  }),
  phone: Model.Field({
    select: PublicApplicationPhoneSchema,
    insert: PublicApplicationPhoneSchema,
    update: PublicApplicationPhoneSchema,
    json: PublicApplicationPhoneSchema,
    jsonCreate: PublicApplicationPhoneSchema,
    jsonUpdate: PublicApplicationPhoneSchema,
  }),
  gender: Model.Field({
    select: PublicApplicationGenderSchema,
    insert: PublicApplicationGenderSchema,
    update: PublicApplicationGenderSchema,
    json: PublicApplicationGenderSchema,
    jsonCreate: PublicApplicationGenderSchema,
    jsonUpdate: PublicApplicationGenderSchema,
  }),
  fieldOfStudyId: Model.Field({
    select: PublicApplicationIdSchema,
    insert: PublicApplicationIdSchema,
    update: PublicApplicationIdSchema,
    json: PublicApplicationIdSchema,
    jsonCreate: PublicApplicationIdSchema,
    jsonUpdate: PublicApplicationIdSchema,
  }),
  yearOfStudy: Model.Field({
    select: PublicApplicationYearOfStudySchema,
    insert: PublicApplicationYearOfStudySchema,
    update: PublicApplicationYearOfStudySchema,
    json: PublicApplicationYearOfStudySchema,
    jsonCreate: PublicApplicationYearOfStudySchema,
    jsonUpdate: PublicApplicationYearOfStudySchema,
  }),
  activationDigest: Model.Sensitive(Schema.NullOr(Sha256Schema)),
}) {}

/** Model-derived non-email applicant boundary used by effect payload construction. */
export const ApplicantSchema = ApplicantRecord.json;
export type Applicant = typeof ApplicantSchema.Type;
export const ApplicantRecordSchema = ApplicantRecord;

export class PublicApplication extends Model.Class<PublicApplication>("PublicApplication")({
  id: Model.Field({
    select: PublicApplicationIdSchema,
    insert: PublicApplicationIdSchema,
    json: PublicApplicationIdSchema,
  }),
  applicantId: Model.Field({
    select: PublicApplicationIdSchema,
    insert: PublicApplicationIdSchema,
    json: PublicApplicationIdSchema,
  }),
  admissionPeriodId: Model.Field({
    select: PublicApplicationIdSchema,
    insert: PublicApplicationIdSchema,
    json: PublicApplicationIdSchema,
  }),
  departmentId: Model.Field({
    select: PublicApplicationIdSchema,
    insert: PublicApplicationIdSchema,
    json: PublicApplicationIdSchema,
  }),
  fieldOfStudyId: Model.Field({
    select: PublicApplicationIdSchema,
    insert: PublicApplicationIdSchema,
    json: PublicApplicationIdSchema,
  }),
  yearOfStudy: Model.Field({
    select: PublicApplicationYearOfStudySchema,
    insert: PublicApplicationYearOfStudySchema,
    json: PublicApplicationYearOfStudySchema,
  }),
  submittedAt: Model.Field({
    select: PublicApplicationInstantSchema,
    insert: PublicApplicationInstantSchema,
    json: PublicApplicationInstantSchema,
  }),
  revision: Model.Field({
    select: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
    insert: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
    json: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  /** Activation is a private immutable snapshot, never an API field. */
  activationDigest: Model.Field({
    select: Schema.NullOr(Sha256Schema),
    insert: Schema.NullOr(Sha256Schema),
  }),
}) {}

export const PublicApplicationSchema = PublicApplication;

const ApplicantCreateFields = ApplicantRecord.jsonCreate.fields;
const ApplicantInsertFields = ApplicantRecord.insert.fields;

/** Exact public request body. No `_tag`, applicant, period, or status fields are accepted. */
const SubmitPublicApplicationFields = {
  commandId: PublicApplicationIdSchema,
  departmentId: PublicApplicationIdSchema,
  firstName: ApplicantCreateFields.firstName,
  lastName: ApplicantCreateFields.lastName,
  phone: ApplicantCreateFields.phone,
  email: ApplicantInsertFields.email,
  gender: ApplicantCreateFields.gender,
  fieldOfStudyId: ApplicantCreateFields.fieldOfStudyId,
  yearOfStudy: ApplicantCreateFields.yearOfStudy,
};

export const PublicApplicationSubmitInputSchema = Schema.Struct(SubmitPublicApplicationFields);
export type PublicApplicationSubmitInput = typeof PublicApplicationSubmitInputSchema.Type;

export const SubmitPublicApplicationInputSchema = PublicApplicationSubmitInputSchema;
export type SubmitPublicApplicationInput = PublicApplicationSubmitInput;

export const PublicApplicationActivationTokenSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => /^[A-Za-z0-9_-]{43,128}$/u.test(value), {
      message: "a server-generated activation token",
    }),
  ),
);
export type PublicApplicationActivationToken = typeof PublicApplicationActivationTokenSchema.Type;

export const SubmitPublicApplicationCommandSchema = Schema.TaggedUnion({
  SubmitPublicApplication: SubmitPublicApplicationFields,
});
export type SubmitPublicApplicationCommand = typeof SubmitPublicApplicationCommandSchema.Type;

export const PublicApplicationSubmitObservationSchema = Schema.TaggedUnion({
  Submitted: {
    commandId: PublicApplicationIdSchema,
    applicationId: PublicApplicationIdSchema,
  },
});
export type PublicApplicationSubmitObservation =
  typeof PublicApplicationSubmitObservationSchema.Type;

export const PublicApplicationObservationSchema = PublicApplicationSubmitObservationSchema;
export type PublicApplicationObservation = PublicApplicationSubmitObservation;

export const PublicApplicationConfirmationSchema = Schema.Struct({
  _tag: Schema.Literals(["ApplicationConfirmed"]),
  applicationId: PublicApplicationIdSchema,
});
export type PublicApplicationConfirmation = typeof PublicApplicationConfirmationSchema.Type;

export const PublicApplicationFieldOfStudySchema = Schema.Struct({
  fieldOfStudyId: AdmissionFieldOfStudy.json.fields.fieldOfStudyId,
  name: AdmissionFieldOfStudy.json.fields.name,
});
export type PublicApplicationFieldOfStudy = typeof PublicApplicationFieldOfStudySchema.Type;

export const PublicApplicationCatalogDepartmentSchema = Schema.Struct({
  departmentId: AdmissionDepartment.json.fields.departmentId,
  name: AdmissionDepartment.json.fields.name,
  closesAt: PublicApplicationInstantSchema,
  fieldsOfStudy: Schema.Array(PublicApplicationFieldOfStudySchema),
});
export type PublicApplicationCatalogDepartment =
  typeof PublicApplicationCatalogDepartmentSchema.Type;

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
  /** Server-generated token for a new or inactive applicant. */
  readonly activationToken: string;
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

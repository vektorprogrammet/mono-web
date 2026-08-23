import { Schema } from "effect";
import { Rfc3339Instant } from "./admission-period.js";

const StableId = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, {
      message: () => "must be a non-empty identifier",
    }),
  ),
);

const boundedText = (max: number, message: string) =>
  Schema.String.pipe(
    Schema.check(
      Schema.makeFilter(
        (value) => value.trim().length > 0 && [...value].length <= max,
        { message: () => message },
      ),
    ),
  );

const ApplicantName = boundedText(100, "must be a non-empty name of at most 100 characters");
const ApplicantPhone = boundedText(32, "must be a non-empty phone value of at most 32 characters");
const ApplicantEmail = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) =>
        value.trim().length <= 254 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()),
      { message: () => "must be a valid email address of at most 254 characters" },
    ),
  ),
);
const Gender = Schema.Literals([0, 1]);
const YearOfStudy = Schema.Int.pipe(
  Schema.check(
    Schema.makeFilter((value) => value >= 1 && value <= 5, {
      message: () => "must be an integer from 1 through 5",
    }),
  ),
);

export class PublicApplicationSubmitInput extends Schema.Class<PublicApplicationSubmitInput>(
  "PublicApplicationSubmitInput",
)({
  commandId: StableId,
  departmentId: StableId,
  firstName: ApplicantName,
  lastName: ApplicantName,
  phone: ApplicantPhone,
  email: ApplicantEmail,
  gender: Gender,
  fieldOfStudyId: StableId,
  yearOfStudy: YearOfStudy,
}) {}

export class PublicApplicationSubmitResponse extends Schema.Class<PublicApplicationSubmitResponse>(
  "PublicApplicationSubmitResponse",
)({
  _tag: Schema.Literals(["Submitted"]),
  commandId: StableId,
  applicationId: StableId,
}) {}

export class PublicApplicationFieldOfStudy extends Schema.Class<PublicApplicationFieldOfStudy>(
  "PublicApplicationFieldOfStudy",
)({
  fieldOfStudyId: StableId,
  name: Schema.NonEmptyString,
}) {}

export class PublicApplicationDepartment extends Schema.Class<PublicApplicationDepartment>(
  "PublicApplicationDepartment",
)({
  departmentId: StableId,
  name: Schema.NonEmptyString,
  closesAt: Rfc3339Instant,
  fieldsOfStudy: Schema.Array(PublicApplicationFieldOfStudy),
}) {}

export class PublicApplicationCatalog extends Schema.Class<PublicApplicationCatalog>(
  "PublicApplicationCatalog",
)({
  departments: Schema.Array(PublicApplicationDepartment),
}) {}

export class PublicApplicationConfirmation extends Schema.Class<PublicApplicationConfirmation>(
  "PublicApplicationConfirmation",
)({
  _tag: Schema.Literals(["ApplicationConfirmed"]),
  applicationId: StableId,
}) {}


export const PublicApplicationSubmitInputSchema = PublicApplicationSubmitInput;
export const PublicApplicationSubmitResponseSchema = PublicApplicationSubmitResponse;
export const PublicApplicationFieldOfStudySchema = PublicApplicationFieldOfStudy;
export const PublicApplicationDepartmentSchema = PublicApplicationDepartment;
export const PublicApplicationCatalogSchema = PublicApplicationCatalog;
export const PublicApplicationConfirmationSchema = PublicApplicationConfirmation;

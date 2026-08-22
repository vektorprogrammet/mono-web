import { Schema } from "effect";

const StableId = Schema.NonEmptyString;

export class AdmissionApplication extends Schema.Class<AdmissionApplication>(
  "AdmissionApplication",
)({
  id: StableId,
  applicantId: StableId,
  admissionPeriodId: StableId,
}) {}

export class AdmissionApplicationSubmitInput extends Schema.Class<AdmissionApplicationSubmitInput>(
  "AdmissionApplicationSubmitInput",
)({
  commandId: StableId,
  departmentId: StableId,
  applicantId: StableId,
}) {}

export class AdmissionApplicationSubmitResponse extends Schema.Class<AdmissionApplicationSubmitResponse>(
  "AdmissionApplicationSubmitResponse",
)({
  _tag: Schema.Literals(["Submitted"]),
  application: AdmissionApplication,
}) {}

export const AdmissionApplicationSchema = AdmissionApplication;
export const AdmissionApplicationSubmitInputSchema = AdmissionApplicationSubmitInput;
export const AdmissionApplicationSubmitResponseSchema = AdmissionApplicationSubmitResponse;

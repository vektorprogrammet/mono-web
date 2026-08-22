import { Schema } from "effect";
import { StableIdSchema } from "./schema.js";

export class AdmissionPeriodDecodeError extends Schema.TaggedError<AdmissionPeriodDecodeError>()(
  "AdmissionPeriodDecodeError",
  { message: Schema.String },
) {}

export class UnauthenticatedActor extends Schema.TaggedError<UnauthenticatedActor>()(
  "UnauthenticatedActor",
  { message: Schema.String },
) {}

export class InactiveActor extends Schema.TaggedError<InactiveActor>()("InactiveActor", {
  personId: StableIdSchema,
}) {}

export class AdmissionRoleDenied extends Schema.TaggedError<AdmissionRoleDenied>()(
  "AdmissionRoleDenied",
  { personId: StableIdSchema },
) {}

export class AdmissionScopeDenied extends Schema.TaggedError<AdmissionScopeDenied>()(
  "AdmissionScopeDenied",
  {
    personId: StableIdSchema,
    departmentId: StableIdSchema,
    admissionPeriodId: Schema.optional(StableIdSchema),
  },
) {}

export class DepartmentRequired extends Schema.TaggedError<DepartmentRequired>()(
  "DepartmentRequired",
  {},
) {}

export class DepartmentNotFound extends Schema.TaggedError<DepartmentNotFound>()(
  "DepartmentNotFound",
  { departmentId: StableIdSchema },
) {}

export class SemesterNotFound extends Schema.TaggedError<SemesterNotFound>()("SemesterNotFound", {
  semesterId: StableIdSchema,
}) {}

export class AdmissionPeriodNotFound extends Schema.TaggedError<AdmissionPeriodNotFound>()(
  "AdmissionPeriodNotFound",
  { admissionPeriodId: StableIdSchema },
) {}

export class InvalidAdmissionPeriodWindow extends Schema.TaggedError<InvalidAdmissionPeriodWindow>()(
  "InvalidAdmissionPeriodWindow",
  {
    startAt: Schema.String,
    endAt: Schema.String,
    reason: Schema.Literals(["EqualBounds", "ReversedBounds"]),
  },
) {}

export class AdmissionWindowOutsideSemester extends Schema.TaggedError<AdmissionWindowOutsideSemester>()(
  "AdmissionWindowOutsideSemester",
  {
    semesterId: StableIdSchema,
    startAt: Schema.String,
    endAt: Schema.String,
    semesterStartAt: Schema.String,
    semesterEndAt: Schema.String,
  },
) {}

export class AdmissionPeriodAlreadyExists extends Schema.TaggedError<AdmissionPeriodAlreadyExists>()(
  "AdmissionPeriodAlreadyExists",
  { departmentId: StableIdSchema, semesterId: StableIdSchema },
) {}

export class StaleAdmissionPeriodRevision extends Schema.TaggedError<StaleAdmissionPeriodRevision>()(
  "StaleAdmissionPeriodRevision",
  {
    admissionPeriodId: StableIdSchema,
    expected: Schema.Int,
    actual: Schema.Int,
  },
) {}

export class DuplicateAdmissionPeriodCommandConflict extends Schema.TaggedError<DuplicateAdmissionPeriodCommandConflict>()(
  "DuplicateAdmissionPeriodCommandConflict",
  { commandId: StableIdSchema },
) {}
export class AdmissionApplicationDecodeError extends Schema.TaggedError<AdmissionApplicationDecodeError>()(
  "AdmissionApplicationDecodeError",
  { message: Schema.String },
) {}

export class NoOpenAdmissionPeriod extends Schema.TaggedError<NoOpenAdmissionPeriod>()(
  "NoOpenAdmissionPeriod",
  { departmentId: StableIdSchema },
) {}

export class AdmissionApplicationAlreadyExists extends Schema.TaggedError<AdmissionApplicationAlreadyExists>()(
  "AdmissionApplicationAlreadyExists",
  { applicationId: StableIdSchema },
) {}

export class DuplicateAdmissionApplicationCommandConflict extends Schema.TaggedError<DuplicateAdmissionApplicationCommandConflict>()(
  "DuplicateAdmissionApplicationCommandConflict",
  { commandId: StableIdSchema },
) {}

export class AdmissionApplicationPersistenceError extends Schema.TaggedError<AdmissionApplicationPersistenceError>()(
  "AdmissionApplicationPersistenceError",
  { operation: Schema.String, message: Schema.String },
) {}

export type AdmissionApplicationFailure =
  | AdmissionApplicationDecodeError
  | NoOpenAdmissionPeriod
  | AdmissionApplicationAlreadyExists
  | DuplicateAdmissionApplicationCommandConflict
  | AdmissionApplicationPersistenceError;


export class AdmissionPeriodPersistenceError extends Schema.TaggedError<AdmissionPeriodPersistenceError>()(
  "AdmissionPeriodPersistenceError",
  { operation: Schema.String, message: Schema.String },
) {}

export type AdmissionPeriodFailure =
  | AdmissionPeriodDecodeError
  | UnauthenticatedActor
  | InactiveActor
  | AdmissionRoleDenied
  | AdmissionScopeDenied
  | DepartmentRequired
  | DepartmentNotFound
  | SemesterNotFound
  | AdmissionPeriodNotFound
  | InvalidAdmissionPeriodWindow
  | AdmissionWindowOutsideSemester
  | AdmissionPeriodAlreadyExists
  | StaleAdmissionPeriodRevision
  | DuplicateAdmissionPeriodCommandConflict
  | AdmissionPeriodPersistenceError;

import { Schema } from "effect";
import { Rfc3339InstantSchema } from "../time.js";
export { isRfc3339Instant } from "../time.js";

/** A stable identifier supplied by a caller or persisted in PostgreSQL. */
export const StableIdSchema = Schema.NonEmptyString;

export const RevisionSchema = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

const AdmissionPeriodFields = {
  id: StableIdSchema,
  departmentId: StableIdSchema,
  semesterId: StableIdSchema,
  startAt: Rfc3339InstantSchema,
  endAt: Rfc3339InstantSchema,
  revision: RevisionSchema,
  lastCommandId: StableIdSchema,
};

export const AdmissionPeriodSchema = Schema.Struct(AdmissionPeriodFields);
export type AdmissionPeriod = typeof AdmissionPeriodSchema.Type;

export const AdmissionSemesterSchema = Schema.Struct({
  semesterId: StableIdSchema,
  startAt: Rfc3339InstantSchema,
  endAt: Rfc3339InstantSchema,
});
export type AdmissionSemester = typeof AdmissionSemesterSchema.Type;

export const AdmissionPeriodActorSchema = Schema.TaggedUnion({
  DepartmentLeader: {
    personId: StableIdSchema,
    departmentId: StableIdSchema,
    active: Schema.Boolean,
  },
  Member: {
    personId: StableIdSchema,
    departmentId: StableIdSchema,
    active: Schema.Boolean,
  },
  GlobalAdmin: {
    personId: StableIdSchema,
    active: Schema.Boolean,
  },
});
export type AdmissionPeriodActor = typeof AdmissionPeriodActorSchema.Type;

const CreateAdmissionPeriodFields = {
  commandId: StableIdSchema,
  semesterId: StableIdSchema,
  startAt: Rfc3339InstantSchema,
  endAt: Rfc3339InstantSchema,
  departmentId: Schema.optional(StableIdSchema),
};

export const CreateAdmissionPeriodInputSchema = Schema.Struct(CreateAdmissionPeriodFields);
export type CreateAdmissionPeriodInput = typeof CreateAdmissionPeriodInputSchema.Type;

const ReviseAdmissionPeriodFields = {
  commandId: StableIdSchema,
  admissionPeriodId: StableIdSchema,
  expectedRevision: RevisionSchema,
  startAt: Rfc3339InstantSchema,
  endAt: Rfc3339InstantSchema,
};

export const ReviseAdmissionPeriodInputSchema = Schema.Struct(ReviseAdmissionPeriodFields);
export type ReviseAdmissionPeriodInput = typeof ReviseAdmissionPeriodInputSchema.Type;

export const AdmissionPeriodCommandSchema = Schema.TaggedUnion({
  CreateAdmissionPeriod: CreateAdmissionPeriodFields,
  ReviseAdmissionPeriod: ReviseAdmissionPeriodFields,
});
export type AdmissionPeriodCommand = typeof AdmissionPeriodCommandSchema.Type;

export const AdmissionPeriodProjectionSchema = Schema.Struct({
  ...AdmissionPeriodFields,
  eligible: Schema.Boolean,
});
export type AdmissionPeriodProjection = typeof AdmissionPeriodProjectionSchema.Type;

const CreatedObservationSchema = Schema.Struct({
  _tag: Schema.Literals(["Created"]),
  commandId: StableIdSchema,
  period: AdmissionPeriodSchema,
});
const RevisedObservationSchema = Schema.Struct({
  _tag: Schema.Literals(["Revised"]),
  commandId: StableIdSchema,
  period: AdmissionPeriodSchema,
});

export const AdmissionPeriodObservationSchema = Schema.TaggedUnion({
  Created: {
    commandId: StableIdSchema,
    period: AdmissionPeriodSchema,
  },
  Revised: {
    commandId: StableIdSchema,
    period: AdmissionPeriodSchema,
  },
  Replayed: {
    commandId: StableIdSchema,
    original: Schema.Union([CreatedObservationSchema, RevisedObservationSchema]),
  },
  Rejected: {
    commandId: StableIdSchema,
    reason: StableIdSchema,
  },
});
export type AdmissionPeriodObservation = typeof AdmissionPeriodObservationSchema.Type;

export const AdmissionPeriodListSchema = Schema.Array(AdmissionPeriodProjectionSchema);
export type AdmissionPeriodList = typeof AdmissionPeriodListSchema.Type;

export const decodeAdmissionPeriodCommand = (input: unknown) =>
  Schema.decodeUnknownEffect(AdmissionPeriodCommandSchema)(input, {
    onExcessProperty: "error",
  });

export const decodeCreateAdmissionPeriodInput = (input: unknown) =>
  Schema.decodeUnknownEffect(CreateAdmissionPeriodInputSchema)(input, {
    onExcessProperty: "error",
  });

export const decodeReviseAdmissionPeriodInput = (input: unknown) =>
  Schema.decodeUnknownEffect(ReviseAdmissionPeriodInputSchema)(input, {
    onExcessProperty: "error",
  });

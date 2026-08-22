import { Schema } from "effect";

/** A stable identifier supplied by a caller or persisted in PostgreSQL. */
export const StableIdSchema = Schema.NonEmptyString;

const Rfc3339InstantPattern =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/**
 * RFC 3339 timestamp validation used at every external and persisted boundary.
 * Date.parse alone accepts normalised-but-invalid calendar dates, so calendar
 * bounds are checked before accepting the instant.
 */
export const isRfc3339Instant = (value: string): boolean => {
  const match = Rfc3339InstantPattern.exec(value);
  if (match === null || Number.isNaN(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
};

export const Rfc3339InstantSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(isRfc3339Instant, {
      message: "an RFC 3339 instant with an explicit UTC offset",
    }),
  ),
);

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

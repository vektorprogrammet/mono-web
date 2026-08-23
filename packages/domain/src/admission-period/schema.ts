import { Schema } from "effect";
import { Model } from "effect/unstable/schema";
import { Rfc3339InstantSchema } from "../time.js";
export { Rfc3339InstantSchema, isRfc3339Instant } from "../time.js";

/** A stable identifier supplied by a caller or persisted in PostgreSQL. */
export const StableIdSchema = Schema.NonEmptyString;

export const RevisionSchema = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

const ReferenceNameSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, { message: "a non-empty name" }),
  ),
);

export class AdmissionDepartment extends Model.Class<AdmissionDepartment>("AdmissionDepartment")({
  departmentId: Model.Field({
    select: StableIdSchema,
    insert: StableIdSchema,
    json: StableIdSchema,
  }),
  name: Model.Field({
    select: ReferenceNameSchema,
    insert: ReferenceNameSchema,
    json: ReferenceNameSchema,
  }),
}) {}

export class AdmissionSemester extends Model.Class<AdmissionSemester>("AdmissionSemester")({
  semesterId: Model.Field({
    select: StableIdSchema,
    insert: StableIdSchema,
    json: StableIdSchema,
  }),
  startAt: Model.Field({
    select: Rfc3339InstantSchema,
    insert: Rfc3339InstantSchema,
    json: Rfc3339InstantSchema,
  }),
  endAt: Model.Field({
    select: Rfc3339InstantSchema,
    insert: Rfc3339InstantSchema,
    json: Rfc3339InstantSchema,
  }),
}) {}

export class AdmissionFieldOfStudy extends Model.Class<AdmissionFieldOfStudy>(
  "AdmissionFieldOfStudy",
)({
  fieldOfStudyId: Model.Field({
    select: StableIdSchema,
    insert: StableIdSchema,
    json: StableIdSchema,
  }),
  departmentId: Model.Field({
    select: StableIdSchema,
    insert: StableIdSchema,
    json: StableIdSchema,
  }),
  name: Model.Field({
    select: ReferenceNameSchema,
    insert: ReferenceNameSchema,
    json: ReferenceNameSchema,
  }),
  active: Model.Field({
    select: Schema.Boolean,
    insert: Schema.Boolean,
    json: Schema.Boolean,
  }),
}) {}

export class AdmissionPeriod extends Model.Class<AdmissionPeriod>("AdmissionPeriod")({
  id: Model.Field({
    select: StableIdSchema,
    insert: StableIdSchema,
    json: StableIdSchema,
  }),
  departmentId: Model.Field({
    select: StableIdSchema,
    insert: StableIdSchema,
    json: StableIdSchema,
    jsonCreate: Schema.optional(StableIdSchema),
  }),
  semesterId: Model.Field({
    select: StableIdSchema,
    insert: StableIdSchema,
    json: StableIdSchema,
    jsonCreate: StableIdSchema,
  }),
  startAt: Model.Field({
    select: Rfc3339InstantSchema,
    insert: Rfc3339InstantSchema,
    update: Rfc3339InstantSchema,
    json: Rfc3339InstantSchema,
    jsonCreate: Rfc3339InstantSchema,
    jsonUpdate: Rfc3339InstantSchema,
  }),
  endAt: Model.Field({
    select: Rfc3339InstantSchema,
    insert: Rfc3339InstantSchema,
    update: Rfc3339InstantSchema,
    json: Rfc3339InstantSchema,
    jsonCreate: Rfc3339InstantSchema,
    jsonUpdate: Rfc3339InstantSchema,
  }),
  revision: Model.GeneratedByApp(RevisionSchema),
  lastCommandId: Model.GeneratedByApp(StableIdSchema),
}) {}

export const AdmissionPeriodSchema = AdmissionPeriod;
export const AdmissionSemesterSchema = AdmissionSemester;
export const AdmissionDepartmentSchema = AdmissionDepartment;
export const AdmissionFieldOfStudySchema = AdmissionFieldOfStudy;

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

const AdmissionPeriodCreateFields = AdmissionPeriod.jsonCreate.fields;
const AdmissionPeriodUpdateFields = AdmissionPeriod.jsonUpdate.fields;

const CreateAdmissionPeriodFields = {
  commandId: StableIdSchema,
  semesterId: AdmissionPeriodCreateFields.semesterId,
  startAt: AdmissionPeriodCreateFields.startAt,
  endAt: AdmissionPeriodCreateFields.endAt,
  departmentId: AdmissionPeriodCreateFields.departmentId,
};

/** Exact create command body; department is omitted for department-scoped actors. */
export const CreateAdmissionPeriodInputSchema = Schema.Struct(CreateAdmissionPeriodFields);
export type CreateAdmissionPeriodInput = typeof CreateAdmissionPeriodInputSchema.Type;

const ReviseAdmissionPeriodFields = {
  commandId: StableIdSchema,
  admissionPeriodId: AdmissionPeriod.json.fields.id,
  expectedRevision: AdmissionPeriod.update.fields.revision,
  startAt: AdmissionPeriodUpdateFields.startAt,
  endAt: AdmissionPeriodUpdateFields.endAt,
};

export const ReviseAdmissionPeriodInputSchema = Schema.Struct(ReviseAdmissionPeriodFields);
export type ReviseAdmissionPeriodInput = typeof ReviseAdmissionPeriodInputSchema.Type;

export const AdmissionPeriodCommandSchema = Schema.TaggedUnion({
  CreateAdmissionPeriod: CreateAdmissionPeriodFields,
  ReviseAdmissionPeriod: ReviseAdmissionPeriodFields,
});
export type AdmissionPeriodCommand = typeof AdmissionPeriodCommandSchema.Type;

export const AdmissionPeriodProjectionSchema = Schema.Struct({
  ...AdmissionPeriod.json.fields,
  eligible: Schema.Boolean,
});
export type AdmissionPeriodProjection = typeof AdmissionPeriodProjectionSchema.Type;

const CreatedObservationSchema = Schema.Struct({
  _tag: Schema.Literals(["Created"]),
  commandId: StableIdSchema,
  period: AdmissionPeriod,
});
const RevisedObservationSchema = Schema.Struct({
  _tag: Schema.Literals(["Revised"]),
  commandId: StableIdSchema,
  period: AdmissionPeriod,
});

export const AdmissionPeriodObservationSchema = Schema.TaggedUnion({
  Created: {
    commandId: StableIdSchema,
    period: AdmissionPeriod,
  },
  Revised: {
    commandId: StableIdSchema,
    period: AdmissionPeriod,
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

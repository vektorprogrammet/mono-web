import { Schema } from "effect";
import { Rfc3339InstantSchema } from "./admission-period.js";

const StableId = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, {
      message: "a non-empty stable identifier",
    }),
  ),
);
const text = (maxLength: number) =>
  Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((value) => value.trim().length > 0, {
        message: "a non-empty string",
      }),
      Schema.isMaxLength(maxLength),
    ),
  );
const nullableText = (maxLength: number) => Schema.NullOr(text(maxLength));
const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

export const DepartmentId = StableId.pipe(Schema.brand("DepartmentId"));
export type DepartmentId = typeof DepartmentId.Type;

export const TeamId = StableId.pipe(Schema.brand("TeamId"));
export type TeamId = typeof TeamId.Type;

export const FieldOfStudyId = StableId.pipe(Schema.brand("FieldOfStudyId"));
export type FieldOfStudyId = typeof FieldOfStudyId.Type;

export const OrganizationCommandId = StableId.pipe(Schema.brand("OrganizationCommandId"));
export type OrganizationCommandId = typeof OrganizationCommandId.Type;

export const OrganizationEntityKindSchema = Schema.Literals(["Department", "Team", "FieldOfStudy"]);
export type OrganizationEntityKind = typeof OrganizationEntityKindSchema.Type;

const DepartmentJsonFields = {
  departmentId: DepartmentId,
  name: text(250),
  shortName: text(50),
  email: text(250),
  address: nullableText(250),
  city: text(250),
  latitude: nullableText(255),
  longitude: nullableText(255),
  logoPath: nullableText(255),
  active: Schema.Boolean,
};

const TeamJsonFields = {
  teamId: TeamId,
  departmentId: DepartmentId,
  name: text(250),
  email: nullableText(250),
  description: nullableText(5_000),
  shortDescription: nullableText(125),
  acceptApplication: Schema.NullOr(Schema.Boolean),
  deadline: Schema.NullOr(Rfc3339InstantSchema),
  active: Schema.Boolean,
};

const FieldOfStudyJsonFields = {
  fieldOfStudyId: FieldOfStudyId,
  name: text(250),
  shortName: text(50),
  departmentId: Schema.NullOr(DepartmentId),
  active: Schema.Boolean,
};

export const DepartmentJsonSchema = Schema.Struct({
  ...DepartmentJsonFields,
  slackChannel: nullableText(255),
  revision: Revision,
});
export type DepartmentJson = typeof DepartmentJsonSchema.Type;

export const TeamJsonSchema = Schema.Struct({
  ...TeamJsonFields,
  revision: Revision,
});
export type TeamJson = typeof TeamJsonSchema.Type;

export const FieldOfStudyJsonSchema = Schema.Struct({
  ...FieldOfStudyJsonFields,
  revision: Revision,
});
export type FieldOfStudyJson = typeof FieldOfStudyJsonSchema.Type;

export const DepartmentListSchema = Schema.Array(DepartmentJsonSchema);
export type DepartmentList = typeof DepartmentListSchema.Type;

export const TeamListSchema = Schema.Array(TeamJsonSchema);
export type TeamList = typeof TeamListSchema.Type;

export const FieldOfStudyListSchema = Schema.Array(FieldOfStudyJsonSchema);
export type FieldOfStudyList = typeof FieldOfStudyListSchema.Type;

export const CreateDepartmentCommandSchema = Schema.Struct({
  _tag: Schema.Literals(["CreateDepartment"]),
  commandId: OrganizationCommandId,
  name: text(250),
  shortName: text(50),
  email: text(250),
  address: nullableText(250),
  city: text(250),
  latitude: nullableText(255),
  longitude: nullableText(255),
});
export type CreateDepartmentCommand = typeof CreateDepartmentCommandSchema.Type;

export const CreateTeamCommandSchema = Schema.Struct({
  _tag: Schema.Literals(["CreateTeam"]),
  commandId: OrganizationCommandId,
  departmentId: DepartmentId,
  name: text(250),
  email: nullableText(250),
  description: nullableText(5_000),
  shortDescription: nullableText(125),
  acceptApplication: Schema.NullOr(Schema.Boolean),
  deadline: Schema.NullOr(Rfc3339InstantSchema),
  active: Schema.Boolean,
});
export type CreateTeamCommand = typeof CreateTeamCommandSchema.Type;

export const CreateFieldOfStudyCommandSchema = Schema.Struct({
  _tag: Schema.Literals(["CreateFieldOfStudy"]),
  commandId: OrganizationCommandId,
  name: text(250),
  shortName: text(50),
  departmentId: Schema.NullOr(DepartmentId),
});
export type CreateFieldOfStudyCommand = typeof CreateFieldOfStudyCommandSchema.Type;

export const OrganizationCreateCommandSchema = Schema.Union([
  CreateDepartmentCommandSchema,
  CreateTeamCommandSchema,
  CreateFieldOfStudyCommandSchema,
]);
export type OrganizationCreateCommand = typeof OrganizationCreateCommandSchema.Type;

export const DepartmentCreatedObservationSchema = Schema.Struct({
  _tag: Schema.Literals(["DepartmentCreated"]),
  commandId: OrganizationCommandId,
  department: DepartmentJsonSchema,
});
export type DepartmentCreatedObservation = typeof DepartmentCreatedObservationSchema.Type;

export const TeamCreatedObservationSchema = Schema.Struct({
  _tag: Schema.Literals(["TeamCreated"]),
  commandId: OrganizationCommandId,
  team: TeamJsonSchema,
});
export type TeamCreatedObservation = typeof TeamCreatedObservationSchema.Type;

export const FieldOfStudyCreatedObservationSchema = Schema.Struct({
  _tag: Schema.Literals(["FieldOfStudyCreated"]),
  commandId: OrganizationCommandId,
  fieldOfStudy: FieldOfStudyJsonSchema,
});
export type FieldOfStudyCreatedObservation = typeof FieldOfStudyCreatedObservationSchema.Type;

export const OrganizationCreatedObservationSchema = Schema.Union([
  DepartmentCreatedObservationSchema,
  TeamCreatedObservationSchema,
  FieldOfStudyCreatedObservationSchema,
]);
export type OrganizationCreatedObservation = typeof OrganizationCreatedObservationSchema.Type;

export const DepartmentReplayedObservationSchema = Schema.Struct({
  _tag: Schema.Literals(["Replayed"]),
  commandId: OrganizationCommandId,
  original: DepartmentCreatedObservationSchema,
});
export type DepartmentReplayedObservation = typeof DepartmentReplayedObservationSchema.Type;

export const TeamReplayedObservationSchema = Schema.Struct({
  _tag: Schema.Literals(["Replayed"]),
  commandId: OrganizationCommandId,
  original: TeamCreatedObservationSchema,
});
export type TeamReplayedObservation = typeof TeamReplayedObservationSchema.Type;

export const FieldOfStudyReplayedObservationSchema = Schema.Struct({
  _tag: Schema.Literals(["Replayed"]),
  commandId: OrganizationCommandId,
  original: FieldOfStudyCreatedObservationSchema,
});
export type FieldOfStudyReplayedObservation = typeof FieldOfStudyReplayedObservationSchema.Type;

export const OrganizationReplayedObservationSchema = Schema.Union([
  DepartmentReplayedObservationSchema,
  TeamReplayedObservationSchema,
  FieldOfStudyReplayedObservationSchema,
]);
export type OrganizationReplayedObservation = typeof OrganizationReplayedObservationSchema.Type;

export const OrganizationCreateObservationSchema = Schema.Union([
  OrganizationCreatedObservationSchema,
  OrganizationReplayedObservationSchema,
]);
export type OrganizationCreateObservation = typeof OrganizationCreateObservationSchema.Type;

export const CreateDepartmentResultSchema = Schema.Union([
  Schema.Struct({
    committed: Schema.Literals([true]),
    observation: DepartmentCreatedObservationSchema,
  }),
  Schema.Struct({
    committed: Schema.Literals([false]),
    observation: DepartmentReplayedObservationSchema,
  }),
]);
export type CreateDepartmentResult = typeof CreateDepartmentResultSchema.Type;

export const CreateTeamResultSchema = Schema.Union([
  Schema.Struct({
    committed: Schema.Literals([true]),
    observation: TeamCreatedObservationSchema,
  }),
  Schema.Struct({
    committed: Schema.Literals([false]),
    observation: TeamReplayedObservationSchema,
  }),
]);
export type CreateTeamResult = typeof CreateTeamResultSchema.Type;

export const CreateFieldOfStudyResultSchema = Schema.Union([
  Schema.Struct({
    committed: Schema.Literals([true]),
    observation: FieldOfStudyCreatedObservationSchema,
  }),
  Schema.Struct({
    committed: Schema.Literals([false]),
    observation: FieldOfStudyReplayedObservationSchema,
  }),
]);
export type CreateFieldOfStudyResult = typeof CreateFieldOfStudyResultSchema.Type;

export const OrganizationCreateResultSchema = Schema.Union([
  CreateDepartmentResultSchema,
  CreateTeamResultSchema,
  CreateFieldOfStudyResultSchema,
]);
export type OrganizationCreateResult = typeof OrganizationCreateResultSchema.Type;

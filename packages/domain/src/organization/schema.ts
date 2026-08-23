import { Schema } from "effect";
import { Model } from "effect/unstable/schema";
import { compareRfc3339Instants, isRfc3339Instant, Rfc3339InstantSchema } from "../time.js";

const NonEmpty = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, { message: "a non-empty string" }),
  ),
);

const text = (max: number) =>
  Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((value) => value.trim().length > 0, { message: "a non-empty string" }),
      Schema.isMaxLength(max),
    ),
  );

const nullableText = (max: number) => Schema.NullOr(text(max));
const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const BooleanValue = Schema.Boolean;

export const DepartmentId = NonEmpty.pipe(Schema.brand("DepartmentId"));
export type DepartmentId = typeof DepartmentId.Type;

export const TeamId = NonEmpty.pipe(Schema.brand("TeamId"));
export type TeamId = typeof TeamId.Type;

export const MembershipId = NonEmpty.pipe(Schema.brand("MembershipId"));
export type MembershipId = typeof MembershipId.Type;

export const PersonId = NonEmpty.pipe(Schema.brand("PersonId"));
export type PersonId = typeof PersonId.Type;

export const PositionId = NonEmpty.pipe(Schema.brand("PositionId"));
export type PositionId = typeof PositionId.Type;

export const SemesterId = NonEmpty.pipe(Schema.brand("SemesterId"));
export type SemesterId = typeof SemesterId.Type;

const nullableInstant = Schema.NullOr(Rfc3339InstantSchema);

export class Department extends Model.Class<Department>("Organization.Department")({
  departmentId: Model.Field({
    select: DepartmentId,
    insert: DepartmentId,
    json: DepartmentId,
  }),
  name: Model.Field({
    select: text(250),
    insert: text(250),
    update: text(250),
    json: text(250),
    jsonCreate: text(250),
    jsonUpdate: text(250),
  }),
  shortName: Model.Field({
    select: text(50),
    insert: text(50),
    update: text(50),
    json: text(50),
    jsonCreate: text(50),
    jsonUpdate: text(50),
  }),
  email: Model.Field({
    select: text(250),
    insert: text(250),
    update: text(250),
    json: text(250),
    jsonCreate: text(250),
    jsonUpdate: text(250),
  }),
  address: Model.Field({
    select: nullableText(250),
    insert: nullableText(250),
    update: nullableText(250),
    json: nullableText(250),
    jsonCreate: nullableText(250),
    jsonUpdate: nullableText(250),
  }),
  city: Model.Field({
    select: text(250),
    insert: text(250),
    update: text(250),
    json: text(250),
    jsonCreate: text(250),
    jsonUpdate: text(250),
  }),
  latitude: Model.Field({
    select: nullableText(255),
    insert: nullableText(255),
    update: nullableText(255),
    json: nullableText(255),
    jsonCreate: nullableText(255),
    jsonUpdate: nullableText(255),
  }),
  longitude: Model.Field({
    select: nullableText(255),
    insert: nullableText(255),
    update: nullableText(255),
    json: nullableText(255),
    jsonCreate: nullableText(255),
    jsonUpdate: nullableText(255),
  }),
  slackChannel: Model.Field({
    select: nullableText(255),
    insert: nullableText(255),
    update: nullableText(255),
    json: nullableText(255),
    jsonCreate: nullableText(255),
    jsonUpdate: nullableText(255),
  }),
  logoPath: Model.Field({
    select: nullableText(255),
    insert: nullableText(255),
    update: nullableText(255),
    json: nullableText(255),
    jsonCreate: nullableText(255),
    jsonUpdate: nullableText(255),
  }),
  active: Model.Field({
    select: BooleanValue,
    insert: BooleanValue,
    update: BooleanValue,
    json: BooleanValue,
    jsonCreate: BooleanValue,
    jsonUpdate: BooleanValue,
  }),
  revision: Model.GeneratedByDb(Revision),
}) {}

export class Team extends Model.Class<Team>("Organization.Team")({
  teamId: Model.Field({
    select: TeamId,
    insert: TeamId,
    json: TeamId,
  }),
  departmentId: Model.Field({
    select: DepartmentId,
    insert: DepartmentId,
    json: DepartmentId,
  }),
  name: Model.Field({
    select: text(250),
    insert: text(250),
    update: text(250),
    json: text(250),
    jsonCreate: text(250),
    jsonUpdate: text(250),
  }),
  email: Model.Field({
    select: nullableText(250),
    insert: nullableText(250),
    update: nullableText(250),
    json: nullableText(250),
    jsonCreate: nullableText(250),
    jsonUpdate: nullableText(250),
  }),
  description: Model.Field({
    select: nullableText(5000),
    insert: nullableText(5000),
    update: nullableText(5000),
    json: nullableText(5000),
    jsonCreate: nullableText(5000),
    jsonUpdate: nullableText(5000),
  }),
  shortDescription: Model.Field({
    select: nullableText(125),
    insert: nullableText(125),
    update: nullableText(125),
    json: nullableText(125),
    jsonCreate: nullableText(125),
    jsonUpdate: nullableText(125),
  }),
  acceptApplication: Model.Field({
    select: Schema.NullOr(BooleanValue),
    insert: Schema.NullOr(BooleanValue),
    update: Schema.NullOr(BooleanValue),
    json: Schema.NullOr(BooleanValue),
    jsonCreate: Schema.NullOr(BooleanValue),
    jsonUpdate: Schema.NullOr(BooleanValue),
  }),
  deadline: Model.Field({
    select: nullableInstant,
    insert: nullableInstant,
    update: nullableInstant,
    json: nullableInstant,
    jsonCreate: nullableInstant,
    jsonUpdate: nullableInstant,
  }),
  active: Model.Field({
    select: BooleanValue,
    insert: BooleanValue,
    update: BooleanValue,
    json: BooleanValue,
    jsonCreate: BooleanValue,
    jsonUpdate: BooleanValue,
  }),
  revision: Model.GeneratedByDb(Revision),
}) {}

export class Membership extends Model.Class<Membership>("Organization.Membership")({
  membershipId: Model.Field({
    select: MembershipId,
    insert: MembershipId,
    json: MembershipId,
  }),
  personId: Model.Field({
    select: PersonId,
    insert: PersonId,
    json: PersonId,
  }),
  teamId: Model.Field({
    select: Schema.NullOr(TeamId),
    insert: Schema.NullOr(TeamId),
    json: Schema.NullOr(TeamId),
  }),
  deletedTeamName: Model.Field({
    select: nullableText(250),
    insert: nullableText(250),
  }),
  startAt: Model.Field({
    select: Rfc3339InstantSchema,
    insert: Rfc3339InstantSchema,
    json: Rfc3339InstantSchema,
  }),
  endAt: Model.Field({
    select: nullableInstant,
    insert: nullableInstant,
    update: nullableInstant,
    json: nullableInstant,
    jsonCreate: nullableInstant,
    jsonUpdate: nullableInstant,
  }),
  positionId: Model.Field({
    select: Schema.NullOr(PositionId),
    insert: Schema.NullOr(PositionId),
    update: Schema.NullOr(PositionId),
    json: Schema.NullOr(PositionId),
    jsonCreate: Schema.NullOr(PositionId),
    jsonUpdate: Schema.NullOr(PositionId),
  }),
  isTeamLeader: Model.Field({
    select: BooleanValue,
    insert: BooleanValue,
    update: BooleanValue,
    json: BooleanValue,
    jsonCreate: BooleanValue,
    jsonUpdate: BooleanValue,
  }),
  isSuspended: Model.Field({
    select: BooleanValue,
    insert: BooleanValue,
    update: BooleanValue,
    json: BooleanValue,
    jsonCreate: BooleanValue,
    jsonUpdate: BooleanValue,
  }),
  revision: Model.GeneratedByDb(Revision),
}) {}

export type DepartmentSelect = typeof Department.Encoded;
export type DepartmentInsert = typeof Department.insert.Encoded;
export type DepartmentUpdate = typeof Department.update.Encoded;
export type DepartmentJson = typeof Department.json.Type;
export type DepartmentJsonCreate = typeof Department.jsonCreate.Type;
export type DepartmentJsonUpdate = typeof Department.jsonUpdate.Type;

export type TeamSelect = typeof Team.Encoded;
export type TeamInsert = typeof Team.insert.Encoded;
export type TeamUpdate = typeof Team.update.Encoded;
export type TeamJson = typeof Team.json.Type;
export type TeamJsonCreate = typeof Team.jsonCreate.Type;
export type TeamJsonUpdate = typeof Team.jsonUpdate.Type;

export type MembershipSelect = typeof Membership.Encoded;
export type MembershipInsert = typeof Membership.insert.Encoded;
export type MembershipUpdate = typeof Membership.update.Encoded;
export type MembershipJson = typeof Membership.json.Type;
export type MembershipJsonCreate = typeof Membership.jsonCreate.Type;
export type MembershipJsonUpdate = typeof Membership.jsonUpdate.Type;

export const isMembershipInterval = (membership: Pick<Membership, "startAt" | "endAt">): boolean =>
  membership.endAt === null || compareRfc3339Instants(membership.endAt, membership.startAt) > 0;

export const isMembershipHistorical = (
  membership: Pick<Membership, "teamId" | "deletedTeamName">,
): boolean => membership.teamId === null && membership.deletedTeamName !== null;

export const isMembershipDetached = (
  membership: Pick<Membership, "teamId" | "deletedTeamName">,
): boolean => membership.teamId === null;

export const isMembershipShapeValid = (
  membership: Pick<Membership, "teamId" | "deletedTeamName" | "startAt" | "endAt">,
): boolean =>
  isMembershipInterval(membership) &&
  (membership.teamId !== null
    ? membership.deletedTeamName === null
    : membership.deletedTeamName !== null && membership.deletedTeamName.trim().length > 0);

export const isRfc3339 = isRfc3339Instant;

export const MembershipInvariantSchema = Membership.pipe(
  Schema.check(
    Schema.makeFilter(isMembershipShapeValid, {
      message:
        "a membership with an ordered interval and explicit live or historical team identity",
    }),
  ),
);

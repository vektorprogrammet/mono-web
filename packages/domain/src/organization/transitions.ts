import { Effect, Schema } from "effect";
import {
  MembershipInvariantSchema,
  Membership,
  MembershipId,
  PositionId,
  isMembershipInterval,
  isMembershipShapeValid,
  isRfc3339,
} from "./schema.js";
import {
  MembershipInvalidInterval,
  MembershipStaleRevision,
  OrganizationDecodeError,
} from "./errors.js";

const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const NullablePositionId = Schema.NullOr(PositionId);

export const MembershipRevisionCommandSchema = Schema.TaggedUnion({
  ReviseMembership: {
    membershipId: MembershipId,
    expectedRevision: Revision,
    endAt: Schema.NullOr(Schema.String.pipe(Schema.check(Schema.makeFilter(isRfc3339)))),
    positionId: NullablePositionId,
    isTeamLeader: Schema.Boolean,
    isSuspended: Schema.Boolean,
  },
  SuspendMembership: {
    membershipId: MembershipId,
    expectedRevision: Revision,
  },
  ReinstateMembership: {
    membershipId: MembershipId,
    expectedRevision: Revision,
  },
});
export type MembershipRevisionCommand = typeof MembershipRevisionCommandSchema.Type;

export const decodeMembershipRevisionCommand = (
  input: unknown,
): Effect.Effect<MembershipRevisionCommand, OrganizationDecodeError> =>
  Schema.decodeUnknownEffect(MembershipRevisionCommandSchema)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(
      (cause) =>
        new OrganizationDecodeError({
          operation: "decode membership revision command",
          message: String(cause),
        }),
    ),
  );

export const membershipIsActiveAt = (membership: Membership, at: string): boolean => {
  if (!isRfc3339(at) || !isMembershipInterval(membership)) return false;
  const timestamp = Date.parse(at);
  const start = Date.parse(membership.startAt);
  const end = membership.endAt === null ? undefined : Date.parse(membership.endAt);
  return timestamp >= start && (end === undefined || timestamp < end) && !membership.isSuspended;
};

const revisionFor = (
  membership: Membership,
  expectedRevision: number,
): Effect.Effect<void, MembershipStaleRevision> =>
  membership.revision === expectedRevision
    ? Effect.void
    : Effect.fail(
        new MembershipStaleRevision({
          membershipId: membership.membershipId,
          expectedRevision,
          actualRevision: membership.revision,
        }),
      );

const revised = (
  current: Membership,
  command: Extract<MembershipRevisionCommand, { readonly _tag: "ReviseMembership" }>,
): Effect.Effect<Membership, MembershipInvalidInterval | MembershipStaleRevision> => {
  const next: Membership = {
    ...current,
    endAt: command.endAt,
    positionId: command.positionId,
    isTeamLeader: command.isTeamLeader,
    isSuspended: command.isSuspended,
    revision: current.revision + 1,
  };
  if (!isMembershipShapeValid(next)) {
    return Effect.fail(new MembershipInvalidInterval({ membershipId: current.membershipId }));
  }
  return Effect.succeed(next);
};

export const reviseMembership = (
  current: Membership,
  command: Extract<MembershipRevisionCommand, { readonly _tag: "ReviseMembership" }>,
): Effect.Effect<Membership, MembershipInvalidInterval | MembershipStaleRevision> =>
  revisionFor(current, command.expectedRevision).pipe(Effect.andThen(revised(current, command)));

export const suspendMembership = (
  current: Membership,
  command: Extract<MembershipRevisionCommand, { readonly _tag: "SuspendMembership" }>,
): Effect.Effect<Membership, MembershipStaleRevision | MembershipInvalidInterval> =>
  revisionFor(current, command.expectedRevision).pipe(
    Effect.andThen(() => {
      const next = { ...current, isSuspended: true, revision: current.revision + 1 };
      return isMembershipShapeValid(next)
        ? Effect.succeed(next)
        : Effect.fail(new MembershipInvalidInterval({ membershipId: current.membershipId }));
    }),
  );

export const reinstateMembership = (
  current: Membership,
  command: Extract<MembershipRevisionCommand, { readonly _tag: "ReinstateMembership" }>,
): Effect.Effect<Membership, MembershipStaleRevision | MembershipInvalidInterval> =>
  revisionFor(current, command.expectedRevision).pipe(
    Effect.andThen(() => {
      const next = { ...current, isSuspended: false, revision: current.revision + 1 };
      return isMembershipShapeValid(next)
        ? Effect.succeed(next)
        : Effect.fail(new MembershipInvalidInterval({ membershipId: current.membershipId }));
    }),
  );

export const applyMembershipRevision = (
  current: Membership,
  command: MembershipRevisionCommand,
): Effect.Effect<Membership, MembershipInvalidInterval | MembershipStaleRevision> => {
  switch (command._tag) {
    case "ReviseMembership":
      return reviseMembership(current, command);
    case "SuspendMembership":
      return suspendMembership(current, command);
    case "ReinstateMembership":
      return reinstateMembership(current, command);
  }
};

export const membershipRevisionSelectSchema = MembershipInvariantSchema;

export const membershipIdFromUnknown = (
  value: unknown,
): Effect.Effect<typeof MembershipId.Type, OrganizationDecodeError> =>
  Schema.decodeUnknownEffect(MembershipId)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (cause) =>
        new OrganizationDecodeError({
          operation: "decode membership id",
          message: String(cause),
        }),
    ),
  );

export const membershipImmutableFields = [
  "membershipId",
  "personId",
  "teamId",
  "deletedTeamName",
  "startAt",
] as const;

import { Effect, Schema } from "effect";
import {
  Department,
  DepartmentId,
  Membership,
  MembershipId,
  PersonId,
  PositionId,
  SemesterId,
  Team,
  TeamId,
  isMembershipShapeValid,
  isRfc3339,
} from "./schema.js";
import { OrganizationImportError } from "./errors.js";

const BooleanFlag = Schema.Union([Schema.Boolean, Schema.Literals([0, 1])]);
const OptionalBooleanFlag = Schema.optional(BooleanFlag);
const OptionalNullableInteger = Schema.optional(Schema.NullOr(Schema.Int));
const OptionalNullableString = Schema.optional(Schema.NullOr(Schema.String));

export const LegacyDepartmentRowSchema = Schema.Struct({
  id: Schema.Int,
  name: Schema.optional(Schema.String),
  shortName: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  address: Schema.optional(Schema.NullOr(Schema.String)),
  city: Schema.optional(Schema.String),
  latitude: Schema.optional(Schema.NullOr(Schema.String)),
  longitude: Schema.optional(Schema.NullOr(Schema.String)),
  slackChannel: Schema.optional(Schema.NullOr(Schema.String)),
  logoPath: Schema.optional(Schema.NullOr(Schema.String)),
  active: Schema.optional(Schema.Boolean),
});
export type LegacyDepartmentRow = typeof LegacyDepartmentRowSchema.Type;

export const LegacyTeamRowSchema = Schema.Struct({
  id: Schema.Int,
  departmentId: Schema.NullOr(Schema.Int),
  name: Schema.optional(Schema.String),
  email: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  shortDescription: Schema.optional(Schema.NullOr(Schema.String)),
  acceptApplication: Schema.optional(Schema.NullOr(Schema.Boolean)),
  deadline: Schema.optional(Schema.NullOr(Schema.String)),
  active: Schema.optional(Schema.Boolean),
});
export type LegacyTeamRow = typeof LegacyTeamRowSchema.Type;

export const LegacyMembershipRowSchema = Schema.Struct({
  id: Schema.Int,
  userId: Schema.Int,
  teamId: Schema.NullOr(Schema.Int),
  deletedTeamName: OptionalNullableString,
  startAt: Schema.optional(Schema.String),
  endAt: Schema.optional(Schema.NullOr(Schema.String)),
  startSemesterId: OptionalNullableInteger,
  endSemesterId: OptionalNullableInteger,
  positionId: OptionalNullableInteger,
  isTeamLeader: OptionalBooleanFlag,
  isLeader: OptionalBooleanFlag,
  isSuspended: OptionalBooleanFlag,
  isActive: OptionalBooleanFlag,
});
export type LegacyMembershipRow = typeof LegacyMembershipRowSchema.Type;

export interface LegacyOrganizationSnapshot {
  readonly sourceRepository: string;
  readonly sourceRevision: string;
  readonly snapshotId: string;
  readonly transformationRevision: string;
  readonly departments: ReadonlyArray<unknown>;
  readonly teams: ReadonlyArray<unknown>;
  readonly memberships: ReadonlyArray<unknown>;
}

export const ORGANIZATION_IMPORT_REASONS = [
  "DECODE_FAILURE",
  "MISSING_DEPARTMENT_FIELD",
  "MISSING_TEAM_FIELD",
  "DEPARTMENT_UNRESOLVED",
  "DUPLICATE_DEPARTMENT",
  "DUPLICATE_TEAM",
  "DUPLICATE_MEMBERSHIP",
  "TEAM_UNRESOLVED",
  "MISSING_TEMPORAL_INTERVAL",
  "INVALID_TEMPORAL_INTERVAL",
  "NULL_TEAM_WITHOUT_HISTORICAL_NAME",
  "LIVE_TEAM_WITH_HISTORICAL_NAME",
  "INVALID_TEAM_DEADLINE",
] as const;
export type OrganizationImportReason = (typeof ORGANIZATION_IMPORT_REASONS)[number];

export interface OrganizationQuarantine {
  readonly sourceKind: "department" | "team" | "membership";
  readonly sourcePrimaryKey: string;
  readonly reason: OrganizationImportReason;
  readonly raw: unknown;
}

export interface OrganizationImportLedgerEntry {
  readonly sourceRepository: string;
  readonly sourceRevision: string;
  readonly snapshotId: string;
  readonly sourcePrimaryKey: string;
  readonly transformationRevision: string;
  readonly targetSemanticIdentity: string;
  readonly destinationIdentity: string | null;
  readonly result: "Accepted" | "Quarantined";
  readonly reason: OrganizationImportReason | null;
}

export interface OrganizationImportResult {
  readonly departments: ReadonlyArray<Department>;
  readonly teams: ReadonlyArray<Team>;
  readonly memberships: ReadonlyArray<Membership>;
  readonly quarantined: ReadonlyArray<OrganizationQuarantine>;
  readonly ledger: ReadonlyArray<OrganizationImportLedgerEntry>;
}

type DecodeOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

const decode = <A>(
  schema: Schema.ConstraintDecoder<A, never>,
  input: unknown,
): DecodeOutcome<A> => {
  try {
    return {
      ok: true,
      value: Schema.decodeUnknownSync(schema)(input, { onExcessProperty: "error" }),
    };
  } catch (cause) {
    return { ok: false, message: String(cause) };
  }
};

const nonEmpty = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value.trim().length > 0;

const bool = (value: boolean | 0 | 1 | undefined, fallback: boolean): boolean =>
  value === undefined ? fallback : value === true || value === 1;

const sourceId = (value: number): string => String(value);

const quarantine = (
  output: {
    readonly quarantined: OrganizationQuarantine[];
    readonly ledger: OrganizationImportLedgerEntry[];
  },
  snapshot: LegacyOrganizationSnapshot,
  sourceKind: OrganizationQuarantine["sourceKind"],
  sourcePrimaryKey: string,
  targetSemanticIdentity: string,
  reason: OrganizationImportReason,
  raw: unknown,
): void => {
  output.quarantined.push({ sourceKind, sourcePrimaryKey, reason, raw });
  output.ledger.push({
    sourceRepository: snapshot.sourceRepository,
    sourceRevision: snapshot.sourceRevision,
    snapshotId: snapshot.snapshotId,
    sourcePrimaryKey,
    transformationRevision: snapshot.transformationRevision,
    targetSemanticIdentity,
    destinationIdentity: null,
    result: "Quarantined",
    reason,
  });
};

const accepted = (
  output: { readonly ledger: OrganizationImportLedgerEntry[] },
  snapshot: LegacyOrganizationSnapshot,
  sourcePrimaryKey: string,
  targetSemanticIdentity: string,
  destinationIdentity: string,
): void => {
  output.ledger.push({
    sourceRepository: snapshot.sourceRepository,
    sourceRevision: snapshot.sourceRevision,
    snapshotId: snapshot.snapshotId,
    sourcePrimaryKey,
    transformationRevision: snapshot.transformationRevision,
    targetSemanticIdentity,
    destinationIdentity,
    result: "Accepted",
    reason: null,
  });
};

const departmentFromLegacy = (row: LegacyDepartmentRow): Department | undefined => {
  if (
    !nonEmpty(row.name) ||
    !nonEmpty(row.shortName) ||
    !nonEmpty(row.email) ||
    !nonEmpty(row.city)
  ) {
    return undefined;
  }
  return {
    departmentId: DepartmentId.make(sourceId(row.id)),
    name: row.name,
    shortName: row.shortName,
    email: row.email,
    address: row.address ?? null,
    city: row.city,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    slackChannel: row.slackChannel ?? null,
    logoPath: row.logoPath ?? null,
    active: row.active ?? true,
    revision: 0,
  };
};

const teamFromLegacy = (
  row: LegacyTeamRow,
  departments: ReadonlySet<number>,
): { readonly team?: Team; readonly reason?: OrganizationImportReason } => {
  if (row.departmentId === null || !departments.has(row.departmentId) || !nonEmpty(row.name)) {
    return { reason: "MISSING_TEAM_FIELD" };
  }
  if (row.deadline !== undefined && row.deadline !== null && !isRfc3339(row.deadline)) {
    return { reason: "INVALID_TEAM_DEADLINE" };
  }
  return {
    team: {
      teamId: TeamId.make(sourceId(row.id)),
      departmentId: DepartmentId.make(sourceId(row.departmentId)),
      name: row.name,
      email: row.email ?? null,
      description: row.description ?? null,
      shortDescription: row.shortDescription ?? null,
      acceptApplication: row.acceptApplication ?? null,
      deadline: row.deadline ?? null,
      active: row.active ?? true,
      revision: 0,
    },
  };
};

const membershipFromLegacy = (
  row: LegacyMembershipRow,
  teams: ReadonlySet<number>,
): { readonly membership?: Membership; readonly reason?: OrganizationImportReason } => {
  if (row.startAt === undefined || row.startAt.length === 0) {
    return { reason: "MISSING_TEMPORAL_INTERVAL" };
  }
  if (
    !isRfc3339(row.startAt) ||
    (row.endAt !== null && row.endAt !== undefined && !isRfc3339(row.endAt))
  ) {
    return { reason: "INVALID_TEMPORAL_INTERVAL" };
  }
  const legacyTeamId = row.teamId;
  const teamId = legacyTeamId === null ? null : TeamId.make(sourceId(legacyTeamId));
  if (legacyTeamId !== null && !teams.has(legacyTeamId)) return { reason: "TEAM_UNRESOLVED" };
  const deletedTeamName = row.deletedTeamName ?? null;
  if (teamId === null && !nonEmpty(deletedTeamName)) {
    return { reason: "NULL_TEAM_WITHOUT_HISTORICAL_NAME" };
  }
  if (teamId !== null && deletedTeamName !== null) {
    return { reason: "LIVE_TEAM_WITH_HISTORICAL_NAME" };
  }
  const membership: Membership = {
    membershipId: MembershipId.make(sourceId(row.id)),
    personId: PersonId.make(sourceId(row.userId)),
    teamId,
    deletedTeamName,
    startAt: row.startAt,
    endAt: row.endAt ?? null,
    positionId:
      row.positionId === null || row.positionId === undefined
        ? null
        : PositionId.make(sourceId(row.positionId)),
    isTeamLeader: bool(row.isTeamLeader ?? row.isLeader, false),
    isSuspended: bool(row.isSuspended, false),
    revision: 0,
  };
  return isMembershipShapeValid(membership)
    ? { membership }
    : { reason: "INVALID_TEMPORAL_INTERVAL" };
};

export const importLegacyOrganization = (
  snapshot: LegacyOrganizationSnapshot,
): OrganizationImportResult => {
  const output: {
    readonly departments: Department[];
    readonly teams: Team[];
    readonly memberships: Membership[];
    readonly quarantined: OrganizationQuarantine[];
    readonly ledger: OrganizationImportLedgerEntry[];
  } = { departments: [], teams: [], memberships: [], quarantined: [], ledger: [] };

  const departmentIds = new Set<number>();
  const acceptedDepartmentIds = new Set<number>();
  for (const [index, raw] of snapshot.departments.entries()) {
    const decoded = decode(LegacyDepartmentRowSchema, raw);
    const sourcePrimaryKey = decoded.ok ? sourceId(decoded.value.id) : `unknown:${index}`;
    if (!decoded.ok) {
      quarantine(
        output,
        snapshot,
        "department",
        sourcePrimaryKey,
        `department:${sourcePrimaryKey}`,
        "DECODE_FAILURE",
        raw,
      );
      continue;
    }
    const target = `department:${sourceId(decoded.value.id)}`;
    if (departmentIds.has(decoded.value.id)) {
      quarantine(
        output,
        snapshot,
        "department",
        sourcePrimaryKey,
        target,
        "DUPLICATE_DEPARTMENT",
        raw,
      );
      continue;
    }
    departmentIds.add(decoded.value.id);
    const department = departmentFromLegacy(decoded.value);
    if (department === undefined) {
      quarantine(
        output,
        snapshot,
        "department",
        sourcePrimaryKey,
        target,
        "MISSING_DEPARTMENT_FIELD",
        raw,
      );
      continue;
    }
    acceptedDepartmentIds.add(decoded.value.id);
    output.departments.push(department);
    accepted(output, snapshot, sourcePrimaryKey, target, department.departmentId);
  }
  const teamIds = new Set<number>();
  const acceptedTeamIds = new Set<number>();
  for (const [index, raw] of snapshot.teams.entries()) {
    const decoded = decode(LegacyTeamRowSchema, raw);
    const sourcePrimaryKey = decoded.ok ? sourceId(decoded.value.id) : `unknown:${index}`;
    if (!decoded.ok) {
      quarantine(
        output,
        snapshot,
        "team",
        sourcePrimaryKey,
        `team:${sourcePrimaryKey}`,
        "DECODE_FAILURE",
        raw,
      );
      continue;
    }
    const target = `team:${sourceId(decoded.value.id)}`;
    if (teamIds.has(decoded.value.id)) {
      quarantine(output, snapshot, "team", sourcePrimaryKey, target, "DUPLICATE_TEAM", raw);
      continue;
    }
    teamIds.add(decoded.value.id);
    if (
      decoded.value.departmentId !== null &&
      !acceptedDepartmentIds.has(decoded.value.departmentId)
    ) {
      quarantine(output, snapshot, "team", sourcePrimaryKey, target, "DEPARTMENT_UNRESOLVED", raw);
      continue;
    }
    const teamDecision = teamFromLegacy(decoded.value, acceptedDepartmentIds);
    if (teamDecision.team === undefined) {
      quarantine(
        output,
        snapshot,
        "team",
        sourcePrimaryKey,
        target,
        teamDecision.reason ?? "MISSING_TEAM_FIELD",
        raw,
      );
      continue;
    }
    const team = teamDecision.team;
    acceptedTeamIds.add(decoded.value.id);
    output.teams.push(team);
    accepted(output, snapshot, sourcePrimaryKey, target, team.teamId);
  }

  const membershipRows: Array<{ readonly row: LegacyMembershipRow; readonly raw: unknown }> = [];
  for (const [index, raw] of snapshot.memberships.entries()) {
    const decoded = decode(LegacyMembershipRowSchema, raw);
    if (!decoded.ok) {
      const sourcePrimaryKey = `unknown:${index}`;
      quarantine(
        output,
        snapshot,
        "membership",
        sourcePrimaryKey,
        `membership:${sourcePrimaryKey}`,
        "DECODE_FAILURE",
        raw,
      );
      continue;
    }
    membershipRows.push({ row: decoded.value, raw });
  }
  membershipRows.sort((left, right) => left.row.id - right.row.id);
  const membershipIdentity = new Set<string>();
  for (const { row, raw } of membershipRows) {
    const sourcePrimaryKey = sourceId(row.id);
    const position =
      row.positionId === null || row.positionId === undefined ? "null" : sourceId(row.positionId);
    const team =
      row.teamId === null ? `historical:${row.deletedTeamName ?? "null"}` : sourceId(row.teamId);
    const semanticIdentity = `${sourceId(row.userId)}|${team}|${row.startAt ?? "missing"}|${position}`;
    const decision = membershipFromLegacy(row, acceptedTeamIds);
    if (decision.membership === undefined) {
      quarantine(
        output,
        snapshot,
        "membership",
        sourcePrimaryKey,
        semanticIdentity,
        decision.reason ?? "DECODE_FAILURE",
        raw,
      );
      continue;
    }
    if (membershipIdentity.has(semanticIdentity)) {
      quarantine(
        output,
        snapshot,
        "membership",
        sourcePrimaryKey,
        semanticIdentity,
        "DUPLICATE_MEMBERSHIP",
        raw,
      );
      continue;
    }
    membershipIdentity.add(semanticIdentity);
    output.memberships.push(decision.membership);
    accepted(
      output,
      snapshot,
      sourcePrimaryKey,
      semanticIdentity,
      decision.membership.membershipId,
    );
  }

  return output;
};

export const importLegacyOrganizationEffect = (
  snapshot: LegacyOrganizationSnapshot,
): Effect.Effect<OrganizationImportResult, OrganizationImportError> =>
  Effect.succeed(importLegacyOrganization(snapshot)).pipe(
    Effect.mapError(
      (cause) =>
        new OrganizationImportError({
          operation: "import legacy organization",
          message: String(cause),
        }),
    ),
  );

export const legacySemesterId = (value: number): typeof SemesterId.Type =>
  SemesterId.make(sourceId(value));

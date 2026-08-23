import { Effect, Schema } from "effect";
import { canonicalJson, sha256Hex } from "../tutor/evidence.js";
import { normalizeRfc3339Instant } from "../time.js";
import {
  Department,
  DepartmentId,
  Membership,
  MembershipInvariantSchema,
  MembershipId,
  PersonId,
  PositionId,
  SemesterId,
  Team,
  TeamId,
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
  "DESTINATION_IDENTITY_COLLISION",
  "INVALID_TEMPORAL_INTERVAL",
  "NULL_TEAM_WITHOUT_HISTORICAL_NAME",
  "LIVE_TEAM_WITH_HISTORICAL_NAME",
  "INVALID_TEAM_DEADLINE",
] as const;
export type OrganizationImportReason = (typeof ORGANIZATION_IMPORT_REASONS)[number];

export interface OrganizationQuarantine {
  readonly sourceKind: "department" | "team" | "membership";
  readonly sourcePrimaryKey: string;
  readonly sourceOccurrence: number;
  readonly targetSemanticIdentity: string;
  readonly reason: OrganizationImportReason;
  readonly raw: unknown;
}

export interface LegacyMembershipSourceMetadata {
  readonly startSemesterId: number | null;
  readonly endSemesterId: number | null;
}

export interface OrganizationImportLedgerEntry {
  readonly sourceRepository: string;
  readonly sourceRevision: string;
  readonly sourceKind: OrganizationQuarantine["sourceKind"];
  readonly snapshotId: string;
  readonly sourceOccurrence: number;
  readonly sourceRaw: unknown;
  readonly sourcePrimaryKey: string;
  readonly transformationRevision: string;
  readonly targetSemanticIdentity: string;
  readonly destinationIdentity: string | null;
  readonly result: "Accepted" | "Quarantined";
  readonly reason: OrganizationImportReason | null;
  readonly sourceMetadata: LegacyMembershipSourceMetadata | null;
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
const canonicalInstant = normalizeRfc3339Instant;
const safeCanonicalRaw = (raw: unknown): string => {
  try {
    return `json:${canonicalJson(raw)}`;
  } catch {
    if (raw === undefined) return "unsupported:undefined";
    if (typeof raw === "bigint") return `unsupported:bigint:${raw.toString()}`;
    if (typeof raw === "symbol") return `unsupported:symbol:${raw.description ?? ""}`;
    if (typeof raw === "function") return `unsupported:function:${raw.name}`;
    return `unsupported:${Object.prototype.toString.call(raw)}`;
  }
};
const rawEvidence = (raw: unknown): unknown => {
  try {
    return JSON.parse(canonicalJson(raw)) as unknown;
  } catch {
    return { unsupported: safeCanonicalRaw(raw) };
  }
};

const unknownSourcePrimaryKey = (raw: unknown, occurrences: Map<string, number>): string => {
  const digest = sha256Hex(new TextEncoder().encode(safeCanonicalRaw(raw)));
  const occurrence = occurrences.get(digest) ?? 0;
  occurrences.set(digest, occurrence + 1);
  return `unknown:${digest}:${occurrence}`;
};
const orderedRaw = (rows: ReadonlyArray<unknown>): ReadonlyArray<unknown> =>
  [...rows].sort((left, right) => safeCanonicalRaw(left).localeCompare(safeCanonicalRaw(right)));

const sourceId = (value: number): string => String(value);

const legacyMembershipSourceMetadata = (raw: unknown): LegacyMembershipSourceMetadata | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  return {
    startSemesterId:
      typeof row.startSemesterId === "number" && Number.isInteger(row.startSemesterId)
        ? row.startSemesterId
        : null,
    endSemesterId:
      typeof row.endSemesterId === "number" && Number.isInteger(row.endSemesterId)
        ? row.endSemesterId
        : null,
  };
};

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
  sourceOccurrence = 0,
): void => {
  if (!Number.isSafeInteger(sourceOccurrence) || sourceOccurrence < 0) {
    throw new Error("source occurrence must be a non-negative safe integer");
  }
  output.quarantined.push({
    sourceKind,
    sourcePrimaryKey,
    sourceOccurrence,
    targetSemanticIdentity,
    reason,
    raw: rawEvidence(raw),
  });
  output.ledger.push({
    sourceRepository: snapshot.sourceRepository,
    sourceRevision: snapshot.sourceRevision,
    snapshotId: snapshot.snapshotId,
    sourceKind,
    sourcePrimaryKey,
    sourceOccurrence,
    sourceRaw: rawEvidence(raw),
    transformationRevision: snapshot.transformationRevision,
    targetSemanticIdentity,
    destinationIdentity: null,
    result: "Quarantined",
    reason,
    sourceMetadata: sourceKind === "membership" ? legacyMembershipSourceMetadata(raw) : null,
  });
};

const accepted = (
  output: { readonly ledger: OrganizationImportLedgerEntry[] },
  snapshot: LegacyOrganizationSnapshot,
  sourceKind: OrganizationQuarantine["sourceKind"],
  sourcePrimaryKey: string,
  targetSemanticIdentity: string,
  destinationIdentity: string,
  sourceRaw: unknown,
  sourceMetadata: LegacyMembershipSourceMetadata | null = null,
  sourceOccurrence = 0,
): void => {
  if (!Number.isSafeInteger(sourceOccurrence) || sourceOccurrence < 0) {
    throw new Error("source occurrence must be a non-negative safe integer");
  }
  output.ledger.push({
    sourceRepository: snapshot.sourceRepository,
    sourceRevision: snapshot.sourceRevision,
    snapshotId: snapshot.snapshotId,
    sourceKind,
    sourcePrimaryKey,
    sourceOccurrence,
    sourceRaw: rawEvidence(sourceRaw),
    transformationRevision: snapshot.transformationRevision,
    targetSemanticIdentity,
    destinationIdentity,
    result: "Accepted",
    reason: null,
    sourceMetadata,
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
  const candidate = {
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
  const decoded = decode(Department, candidate);
  return decoded.ok ? decoded.value : undefined;
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
  const candidate = {
    teamId: TeamId.make(sourceId(row.id)),
    departmentId: DepartmentId.make(sourceId(row.departmentId)),
    name: row.name,
    email: row.email ?? null,
    description: row.description ?? null,
    shortDescription: row.shortDescription ?? null,
    acceptApplication: row.acceptApplication ?? null,
    deadline:
      row.deadline === null || row.deadline === undefined ? null : canonicalInstant(row.deadline),
    active: row.active ?? true,
    revision: 0,
  };
  const decoded = decode(Team, candidate);
  return decoded.ok ? { team: decoded.value } : { reason: "MISSING_TEAM_FIELD" };
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
  const candidate = {
    membershipId: MembershipId.make(sourceId(row.id)),
    personId: PersonId.make(sourceId(row.userId)),
    teamId,
    deletedTeamName,
    startAt: canonicalInstant(row.startAt),
    endAt: row.endAt === null || row.endAt === undefined ? null : canonicalInstant(row.endAt),
    positionId:
      row.positionId === null || row.positionId === undefined
        ? null
        : PositionId.make(sourceId(row.positionId)),
    isTeamLeader: bool(row.isTeamLeader ?? row.isLeader, false),
    isSuspended: bool(row.isSuspended, false),
    revision: 0,
  };
  const decoded = decode(MembershipInvariantSchema, candidate);
  return decoded.ok ? { membership: decoded.value } : { reason: "INVALID_TEMPORAL_INTERVAL" };
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

  const orderedDepartments = orderedRaw(snapshot.departments);
  const departmentIdCounts = new Map<number, number>();
  for (const raw of orderedDepartments) {
    const decoded = decode(LegacyDepartmentRowSchema, raw);
    if (decoded.ok) {
      departmentIdCounts.set(decoded.value.id, (departmentIdCounts.get(decoded.value.id) ?? 0) + 1);
    }
  }
  const unknownDepartmentOccurrences = new Map<string, number>();
  const departmentIdOccurrences = new Map<number, number>();
  const acceptedDepartmentIds = new Set<number>();
  for (const raw of orderedDepartments) {
    const decoded = decode(LegacyDepartmentRowSchema, raw);
    const sourcePrimaryKey = decoded.ok
      ? sourceId(decoded.value.id)
      : unknownSourcePrimaryKey(raw, unknownDepartmentOccurrences);
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
    const target = `department:${sourcePrimaryKey}`;
    const sourceOccurrence = departmentIdOccurrences.get(decoded.value.id) ?? 0;
    departmentIdOccurrences.set(decoded.value.id, sourceOccurrence + 1);
    if ((departmentIdCounts.get(decoded.value.id) ?? 0) > 1) {
      quarantine(
        output,
        snapshot,
        "department",
        sourcePrimaryKey,
        target,
        "DUPLICATE_DEPARTMENT",
        raw,
        sourceOccurrence,
      );
      continue;
    }
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
    accepted(
      output,
      snapshot,
      "department",
      sourcePrimaryKey,
      target,
      department.departmentId,
      raw,
    );
  }

  const orderedTeams = orderedRaw(snapshot.teams);
  const teamIdCounts = new Map<number, number>();
  for (const raw of orderedTeams) {
    const decoded = decode(LegacyTeamRowSchema, raw);
    if (decoded.ok) {
      teamIdCounts.set(decoded.value.id, (teamIdCounts.get(decoded.value.id) ?? 0) + 1);
    }
  }
  const unknownTeamOccurrences = new Map<string, number>();
  const teamIdOccurrences = new Map<number, number>();
  const acceptedTeamIds = new Set<number>();
  for (const raw of orderedTeams) {
    const decoded = decode(LegacyTeamRowSchema, raw);
    const sourcePrimaryKey = decoded.ok
      ? sourceId(decoded.value.id)
      : unknownSourcePrimaryKey(raw, unknownTeamOccurrences);
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
    const target = `team:${sourcePrimaryKey}`;
    const sourceOccurrence = teamIdOccurrences.get(decoded.value.id) ?? 0;
    teamIdOccurrences.set(decoded.value.id, sourceOccurrence + 1);
    if ((teamIdCounts.get(decoded.value.id) ?? 0) > 1) {
      quarantine(
        output,
        snapshot,
        "team",
        sourcePrimaryKey,
        target,
        "DUPLICATE_TEAM",
        raw,
        sourceOccurrence,
      );
      continue;
    }
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
    accepted(output, snapshot, "team", sourcePrimaryKey, target, team.teamId, raw);
  }

  const membershipRows: Array<{ readonly row: LegacyMembershipRow; readonly raw: unknown }> = [];
  const unknownMembershipOccurrences = new Map<string, number>();
  for (const raw of orderedRaw(snapshot.memberships)) {
    const decoded = decode(LegacyMembershipRowSchema, raw);
    if (!decoded.ok) {
      const sourcePrimaryKey = unknownSourcePrimaryKey(raw, unknownMembershipOccurrences);
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
  membershipRows.sort(
    (left, right) =>
      left.row.id - right.row.id ||
      safeCanonicalRaw(left.raw).localeCompare(safeCanonicalRaw(right.raw)),
  );
  const membershipSourceIdCounts = new Map<number, number>();
  const membershipSemanticIdentityCounts = new Map<string, number>();
  const semanticIdentityOf = (row: LegacyMembershipRow): string => {
    const position =
      row.positionId === null || row.positionId === undefined ? "null" : sourceId(row.positionId);
    const team =
      row.teamId === null ? `historical:${row.deletedTeamName ?? "null"}` : sourceId(row.teamId);
    const startAt =
      row.startAt === undefined || !isRfc3339(row.startAt)
        ? "missing"
        : canonicalInstant(row.startAt);
    return `${sourceId(row.userId)}|${team}|${startAt}|${position}`;
  };
  for (const { row } of membershipRows) {
    membershipSourceIdCounts.set(row.id, (membershipSourceIdCounts.get(row.id) ?? 0) + 1);
    const semanticIdentity = semanticIdentityOf(row);
    membershipSemanticIdentityCounts.set(
      semanticIdentity,
      (membershipSemanticIdentityCounts.get(semanticIdentity) ?? 0) + 1,
    );
  }
  const membershipSourceIdOccurrences = new Map<number, number>();
  for (const { row, raw } of membershipRows) {
    const sourcePrimaryKey = sourceId(row.id);
    const sourceOccurrence = membershipSourceIdOccurrences.get(row.id) ?? 0;
    membershipSourceIdOccurrences.set(row.id, sourceOccurrence + 1);
    const semanticIdentity = semanticIdentityOf(row);
    if (
      (membershipSourceIdCounts.get(row.id) ?? 0) > 1 ||
      (membershipSemanticIdentityCounts.get(semanticIdentity) ?? 0) > 1
    ) {
      quarantine(
        output,
        snapshot,
        "membership",
        sourcePrimaryKey,
        semanticIdentity,
        "DUPLICATE_MEMBERSHIP",
        raw,
        sourceOccurrence,
      );
      continue;
    }
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
    output.memberships.push(decision.membership);
    accepted(
      output,
      snapshot,
      "membership",
      sourcePrimaryKey,
      semanticIdentity,
      decision.membership.membershipId,
      raw,
      legacyMembershipSourceMetadata(raw),
    );
  }

  return output;
};

export const importLegacyOrganizationEffect = (
  snapshot: LegacyOrganizationSnapshot,
): Effect.Effect<OrganizationImportResult, OrganizationImportError> =>
  Effect.try({
    try: () => importLegacyOrganization(snapshot),
    catch: (cause) =>
      new OrganizationImportError({
        operation: "import legacy organization",
        message: String(cause),
      }),
  });

export const legacySemesterId = (value: number): typeof SemesterId.Type =>
  SemesterId.make(sourceId(value));

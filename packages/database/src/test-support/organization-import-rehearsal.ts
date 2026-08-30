import {
  LegacyDepartmentRowSchema,
  LegacyMembershipRowSchema,
  LegacyTeamRowSchema,
  type LegacyOrganizationSnapshot,
  type OrganizationImportResult,
} from "@vektorprogrammet/domain/organization";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import { Data, Effect, Schema } from "effect";
import type { DatabaseShape } from "@vektorprogrammet/domain/database";

export const SPEC_0067 = {
  contractRevision: "0067.0",
  frozenCodeBaseHead: "5f9f4c7a6a7c3cb54104d21756311d53d6cc1d48",
  implementationBaseHead: "15062ae453b6b6c1470c960e914602179710ac07",
  sourceRepository: "synthetic://spec-0067/legacy-organization",
  sourceRevision: "organization-source-0067-v1",
  transformationRevision: "organization-import-0067-v1",
  snapshotHash: "1d79748e449c2e87f5e4a467a3442c2913d6403bac11252630cbf1e347d449a3",
  snapshotId: "sha256:1d79748e449c2e87f5e4a467a3442c2913d6403bac11252630cbf1e347d449a3",
  authorizationInstant: "2037-01-15T12:00:00.000Z",
  administratorPersonId: "person-organization-import-admin-0067",
  importedMemberPersonId: "6731",
  administratorGrantId: "grant-organization-import-admin-0067",
  sessionCookieName: "better-auth.session_token",
  sessionExpiresAt: "2037-02-01T00:00:00.000Z",
  failureTrigger: "spec_0067_fail_organization_ledger",
  failureFunction: "public.spec_0067_fail_organization_ledger()",
  failureSqlState: "P0001",
  failureMessage: "spec 0067 injected organization ledger failure",
  evidencePath: "/tmp/mono-web-0067-organization-import-evidence.json",
} as const;

export const NATIVE_BROWSER_JOURNEY_REQUIREMENTS = [
  { path: "/api/admin/users", access: "BoundedSession", requestSource: "DashboardSsr" },
  { path: "/api/departments", access: "Public", requestSource: "BrowserCrossOrigin" },
  { path: "/api/me", access: "BoundedSession", requestSource: "DashboardSsr" },
  { path: "/api/me/session", access: "BoundedSession", requestSource: "DashboardSsr" },
  { path: "/api/teams", access: "Public", requestSource: "BrowserCrossOrigin" },
] as const;

export const SPEC_0067_PREREQUISITES = {
  persons: [
    {
      personId: SPEC_0067.administratorPersonId,
      firstName: "Spec",
      lastName: "Administrator",
      email: "organization-import-admin.0067@example.invalid",
      phone: "+4700000067",
      revision: 0,
    },
    {
      personId: SPEC_0067.importedMemberPersonId,
      firstName: "Imported",
      lastName: "Member",
      email: "imported-member.0067@example.invalid",
      phone: "+4700006731",
      revision: 0,
    },
  ],
  administratorGrant: {
    grantId: SPEC_0067.administratorGrantId,
    personId: SPEC_0067.administratorPersonId,
    startAt: "2037-01-01T00:00:00.000Z",
    endAt: "2037-02-01T00:00:00.000Z",
    revision: 0,
  },
} as const;

const deepFreeze = <A>(value: A): A => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

export const frozenOrganizationSnapshotCore = deepFreeze({
  sourceRepository: SPEC_0067.sourceRepository,
  sourceRevision: SPEC_0067.sourceRevision,
  transformationRevision: SPEC_0067.transformationRevision,
  departments: [
    {
      id: 6702,
      name: "",
      shortName: "Q67",
      email: "quarantine.0067@example.invalid",
      city: "Trondheim",
      active: true,
    },
    {
      id: 6701,
      name: "Spec 0067 Department",
      shortName: "S67",
      email: "department.0067@example.invalid",
      city: "Trondheim",
      active: true,
    },
  ],
  teams: [
    {
      id: 6712,
      departmentId: 6799,
      name: "Unresolved Team",
      email: "unresolved-team.0067@example.invalid",
      active: true,
    },
    {
      id: 6711,
      departmentId: 6701,
      name: "Spec 0067 Team",
      email: "team.0067@example.invalid",
      description: "Imported by the synthetic rehearsal.",
      shortDescription: "Spec 0067",
      acceptApplication: false,
      deadline: null,
      active: true,
    },
  ],
  memberships: [
    {
      id: 6723,
      userId: 6733,
      teamId: 6798,
      deletedTeamName: null,
      startAt: "2037-01-01T00:00:00.000Z",
      endAt: null,
      positionId: null,
      isTeamLeader: false,
      isSuspended: false,
    },
    {
      id: 6722,
      userId: 6732,
      teamId: 6711,
      deletedTeamName: null,
      startAt: "2037-01-01T00:00:00.000Z",
      endAt: null,
      positionId: 6743,
      isTeamLeader: false,
      isSuspended: false,
    },
    {
      id: 6721,
      userId: 6731,
      teamId: 6711,
      deletedTeamName: null,
      startAt: "2037-01-01T00:00:00.000Z",
      endAt: null,
      startSemesterId: 501,
      endSemesterId: null,
      positionId: 6741,
      isTeamLeader: true,
      isSuspended: false,
      isActive: true,
    },
    {
      id: 6722,
      userId: 6732,
      teamId: 6711,
      deletedTeamName: null,
      startAt: "2037-01-01T00:00:00.000Z",
      endAt: null,
      positionId: 6742,
      isTeamLeader: false,
      isSuspended: false,
    },
  ],
});

const FrozenOrganizationSnapshotSchema = Schema.Struct({
  sourceRepository: Schema.String,
  sourceRevision: Schema.String,
  snapshotId: Schema.String,
  transformationRevision: Schema.String,
  departments: Schema.Array(LegacyDepartmentRowSchema),
  teams: Schema.Array(LegacyTeamRowSchema),
  memberships: Schema.Array(LegacyMembershipRowSchema),
});

export class FrozenOrganizationFixtureDecodeError extends Data.TaggedError(
  "FrozenOrganizationFixtureDecodeError",
)<{
  readonly message: string;
}> {}

export const frozenOrganizationSnapshotInput = deepFreeze({
  ...frozenOrganizationSnapshotCore,
  snapshotId: SPEC_0067.snapshotId,
});

export const decodeFrozenOrganizationSnapshot = (
  input: unknown,
): Effect.Effect<LegacyOrganizationSnapshot, FrozenOrganizationFixtureDecodeError> =>
  Schema.decodeUnknownEffect(FrozenOrganizationSnapshotSchema)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(
      (cause) => new FrozenOrganizationFixtureDecodeError({ message: String(cause) }),
    ),
    Effect.flatMap((decoded) => {
      const {
        snapshotId,
        sourceRepository,
        sourceRevision,
        transformationRevision,
        departments,
        teams,
        memberships,
      } = decoded;
      const core = {
        sourceRepository,
        sourceRevision,
        transformationRevision,
        departments,
        teams,
        memberships,
      };
      const snapshotHash = sha256Hex(canonicalJsonBytes(core));
      const valid =
        snapshotHash === SPEC_0067.snapshotHash &&
        snapshotId === SPEC_0067.snapshotId &&
        sourceRepository === SPEC_0067.sourceRepository &&
        sourceRevision === SPEC_0067.sourceRevision &&
        transformationRevision === SPEC_0067.transformationRevision;
      return valid
        ? Effect.succeed(deepFreeze(decoded) as LegacyOrganizationSnapshot)
        : Effect.fail(
            new FrozenOrganizationFixtureDecodeError({
              message: "spec 0067 frozen snapshot reference or canonical hash mismatch",
            }),
          );
    }),
  );

export interface OrganizationImportOutcomeEvidence {
  readonly order: number;
  readonly kind: "department" | "team" | "membership";
  readonly sourcePrimaryKey: string;
  readonly sourceOccurrence: number;
  readonly result: "Accepted" | "Quarantined";
  readonly reason: string | null;
  readonly destinationIdentity: string | null;
  readonly targetSemanticIdentity: string;
}

export const expectedOrganizationImportOutcomeMatrix: ReadonlyArray<OrganizationImportOutcomeEvidence> =
  deepFreeze([
    {
      order: 1,
      kind: "department",
      sourcePrimaryKey: "6701",
      sourceOccurrence: 0,
      result: "Accepted",
      reason: null,
      destinationIdentity: "6701",
      targetSemanticIdentity: "department:6701",
    },
    {
      order: 2,
      kind: "department",
      sourcePrimaryKey: "6702",
      sourceOccurrence: 0,
      result: "Quarantined",
      reason: "MISSING_DEPARTMENT_FIELD",
      destinationIdentity: null,
      targetSemanticIdentity: "department:6702",
    },
    {
      order: 3,
      kind: "team",
      sourcePrimaryKey: "6711",
      sourceOccurrence: 0,
      result: "Accepted",
      reason: null,
      destinationIdentity: "6711",
      targetSemanticIdentity: "team:6711",
    },
    {
      order: 4,
      kind: "team",
      sourcePrimaryKey: "6712",
      sourceOccurrence: 0,
      result: "Quarantined",
      reason: "DEPARTMENT_UNRESOLVED",
      destinationIdentity: null,
      targetSemanticIdentity: "team:6712",
    },
    {
      order: 5,
      kind: "membership",
      sourcePrimaryKey: "6721",
      sourceOccurrence: 0,
      result: "Accepted",
      reason: null,
      destinationIdentity: "6721",
      targetSemanticIdentity: "6731|6711|2037-01-01T00:00:00.000Z|6741",
    },
    {
      order: 6,
      kind: "membership",
      sourcePrimaryKey: "6722",
      sourceOccurrence: 0,
      result: "Quarantined",
      reason: "DUPLICATE_MEMBERSHIP",
      destinationIdentity: null,
      targetSemanticIdentity: "6732|6711|2037-01-01T00:00:00.000Z|6742",
    },
    {
      order: 7,
      kind: "membership",
      sourcePrimaryKey: "6722",
      sourceOccurrence: 1,
      result: "Quarantined",
      reason: "DUPLICATE_MEMBERSHIP",
      destinationIdentity: null,
      targetSemanticIdentity: "6732|6711|2037-01-01T00:00:00.000Z|6743",
    },
    {
      order: 8,
      kind: "membership",
      sourcePrimaryKey: "6723",
      sourceOccurrence: 0,
      result: "Quarantined",
      reason: "TEAM_UNRESOLVED",
      destinationIdentity: null,
      targetSemanticIdentity: "6733|6798|2037-01-01T00:00:00.000Z|null",
    },
  ]);

export const organizationImportOutcomeMatrix = (
  result: OrganizationImportResult,
): ReadonlyArray<OrganizationImportOutcomeEvidence> =>
  result.ledger.map((entry, index) => ({
    order: index + 1,
    kind: entry.sourceKind,
    sourcePrimaryKey: entry.sourcePrimaryKey,
    sourceOccurrence: entry.sourceOccurrence,
    result: entry.result,
    reason: entry.reason,
    destinationIdentity: entry.destinationIdentity,
    targetSemanticIdentity: entry.targetSemanticIdentity,
  }));

export const organizationImportProvenanceEvidence = (result: OrganizationImportResult) =>
  result.ledger.map((entry) => ({
    sourceRepository: entry.sourceRepository,
    sourceRevision: entry.sourceRevision,
    snapshotId: entry.snapshotId,
    transformationRevision: entry.transformationRevision,
    sourceKind: entry.sourceKind,
    sourcePrimaryKey: entry.sourcePrimaryKey,
    sourceOccurrence: entry.sourceOccurrence,
    targetSemanticIdentity: entry.targetSemanticIdentity,
    destinationIdentity: entry.destinationIdentity,
    result: entry.result,
    reason: entry.reason,
    sourceRawSha256: sha256Hex(canonicalJsonBytes(entry.sourceRaw)),
    sourceMetadata: entry.sourceMetadata,
  }));

export type OrganizationImportSqlPhase =
  | "DepartmentInsert"
  | "TeamInsert"
  | "MembershipInsert"
  | "QuarantineInsert"
  | "LedgerInsert"
  | "LedgerSqlError";

export type OrganizationImportSqlTraceEntry =
  | { readonly phase: Exclude<OrganizationImportSqlPhase, "LedgerSqlError"> }
  | {
      readonly phase: "LedgerSqlError";
      readonly sqlState: string | null;
      readonly message: string;
    };

export interface OrganizationImportSqlObserverState {
  captureImportTrace: boolean;
  readonly importTrace: Array<OrganizationImportSqlTraceEntry>;
  readonly delegatedSqlErrors: Array<{
    readonly sqlState: string | null;
    readonly message: string;
    readonly statementTemplate: string;
  }>;
  ruleDmlAttempts: number;
  authDmlAttempts: number;
  receiptDmlAttempts: number;
  outboxDmlAttempts: number;
  outboxClaimAttempts: number;
  personAuthorizationLockAttempts: number;
}

export const makeOrganizationImportSqlObserverState = (): OrganizationImportSqlObserverState => ({
  captureImportTrace: false,
  importTrace: [],
  delegatedSqlErrors: [],
  ruleDmlAttempts: 0,
  authDmlAttempts: 0,
  receiptDmlAttempts: 0,
  outboxDmlAttempts: 0,
  outboxClaimAttempts: 0,
  personAuthorizationLockAttempts: 0,
});

const normalizeSqlIdentifiers = (text: string): string =>
  text
    .replace(/"((?:""|[^"])*)"/gu, (_match, identifier: string) =>
      identifier.replaceAll('""', '"').toLowerCase(),
    )
    .replace(/\s*\.\s*/gu, ".");

const dmlStatement = (text: string): boolean => {
  const withoutLeadingComments = text.replace(
    /^(?:(?:\s+)|(?:--[^\n]*(?:\n|$))|(?:\/\*[\s\S]*?\*\/))*/u,
    "",
  );
  const withoutReadLocks = withoutLeadingComments.replace(
    /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b/giu,
    "FOR_LOCK",
  );
  return /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO)\b/iu.test(withoutReadLocks);
};

const classifyImportWrite = (
  text: string,
): Exclude<OrganizationImportSqlPhase, "LedgerSqlError"> | undefined => {
  if (/\bINSERT\s+INTO\s+(?:public\.)?organization_departments\b/iu.test(text)) {
    return "DepartmentInsert";
  }
  if (/\bINSERT\s+INTO\s+(?:public\.)?organization_teams\b/iu.test(text)) {
    return "TeamInsert";
  }
  if (/\bINSERT\s+INTO\s+(?:public\.)?organization_memberships\b/iu.test(text)) {
    return "MembershipInsert";
  }
  if (/\bINSERT\s+INTO\s+(?:public\.)?organization_membership_quarantine\b/iu.test(text)) {
    return "QuarantineInsert";
  }
  if (/\bINSERT\s+INTO\s+(?:public\.)?organization_import_ledger\b/iu.test(text)) {
    return "LedgerInsert";
  }
  return undefined;
};

const nestedString = (
  input: unknown,
  field: "code" | "message",
  seen = new Set<unknown>(),
): string | undefined => {
  if (typeof input !== "object" || input === null || seen.has(input)) return undefined;
  seen.add(input);
  const record = input as Record<string, unknown>;
  const direct = record[field];
  if (typeof direct === "string") {
    if (field === "code" || direct.includes(SPEC_0067.failureMessage)) return direct;
  }
  for (const link of ["reason", "cause"] as const) {
    const nested = nestedString(record[link], field, seen);
    if (nested !== undefined) return nested;
  }
  for (const value of Object.values(record)) {
    const nested = nestedString(value, field, seen);
    if (nested !== undefined) return nested;
  }
  return typeof direct === "string" ? direct : undefined;
};

const observeStatement = <A>(
  statement: Effect.Effect<ReadonlyArray<A>, unknown>,
  text: string,
  state: OrganizationImportSqlObserverState,
  values: ReadonlyArray<unknown> = [],
): Effect.Effect<ReadonlyArray<A>, unknown> => {
  const normalizedText = normalizeSqlIdentifiers(text);
  const phase = classifyImportWrite(normalizedText);
  const dml = dmlStatement(normalizedText);
  const personAuthorizationLock =
    text.includes("vektorprogrammet:person-authorization:v1:") ||
    values.some(
      (value) =>
        typeof value === "string" && value.startsWith("vektorprogrammet:person-authorization:v1:"),
    );
  const outboxAccess = /\b[A-Za-z0-9_]*_outbox\b/iu.test(normalizedText);
  const outboxClaim =
    outboxAccess &&
    (/\b(?:FOR\s+UPDATE|SKIP\s+LOCKED)\b/iu.test(normalizedText) ||
      (dml && /\b(?:claim_id|claimed_at)\b/iu.test(normalizedText)));
  if (!dml && phase === undefined && !personAuthorizationLock && !outboxClaim) return statement;
  const before = Effect.sync(() => {
    if (dml && /\b(?:public\.)?authz_(?:tags|tag_assignments|rules)\b/iu.test(normalizedText)) {
      state.ruleDmlAttempts += 1;
    }
    if (dml && /\bauth\.(?:user|session|account|verification)\b/iu.test(normalizedText)) {
      state.authDmlAttempts += 1;
    }
    if (dml && /\b(?:public\.)?economy_(?:receipts|receipt_|payment_)/iu.test(normalizedText)) {
      state.receiptDmlAttempts += 1;
    }
    if (dml && outboxAccess) state.outboxDmlAttempts += 1;
    if (outboxClaim) state.outboxClaimAttempts += 1;
    if (personAuthorizationLock) state.personAuthorizationLockAttempts += 1;
    if (state.captureImportTrace && phase !== undefined) state.importTrace.push({ phase });
  });
  const delegated = before.pipe(
    Effect.andThen(statement),
    Effect.tapError((cause) =>
      Effect.sync(() => {
        state.delegatedSqlErrors.push({
          sqlState: nestedString(cause, "code") ?? null,
          statementTemplate: text.replace(/\s+/gu, " ").trim().slice(0, 1_000),
          message: nestedString(cause, "message") ?? String(cause),
        });
      }),
    ),
  );
  return phase === "LedgerInsert"
    ? delegated.pipe(
        Effect.tapError((cause) =>
          Effect.sync(() => {
            if (!state.captureImportTrace) return;
            state.importTrace.push({
              phase: "LedgerSqlError",
              sqlState: nestedString(cause, "code") ?? null,
              message: nestedString(cause, "message") ?? String(cause),
            });
          }),
        ),
      )
    : delegated;
};

/** Evidence-only proxy: results, failures, and transaction ownership stay with DatabaseLive. */
export const observeOrganizationImportSql = (
  sql: DatabaseShape,
  state: OrganizationImportSqlObserverState,
): DatabaseShape =>
  new Proxy(sql, {
    apply(target, thisArgument, argumentsList) {
      const statement = Reflect.apply(target, thisArgument, argumentsList) as Effect.Effect<
        ReadonlyArray<unknown>,
        unknown
      >;
      const strings = argumentsList[0] as TemplateStringsArray;
      return observeStatement(statement, strings.join("?"), state, argumentsList.slice(1));
    },
    get(target, property) {
      if (property === "unsafe") {
        return (text: string, params: ReadonlyArray<unknown> = []) =>
          observeStatement(target.unsafe(text, params), text, state, params);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DatabaseShape;
const NotObservedSectionSchema = Schema.Struct({
  status: Schema.Literal("NotObservedDueToFailure"),
});
const StringArraySchema = Schema.Array(Schema.String);
const ImportCountsSchema = Schema.Struct({
  departments: Schema.Number,
  teams: Schema.Number,
  memberships: Schema.Number,
  quarantine: Schema.Number,
  ledger: Schema.Number,
});
const StableTableProjectionSchema = Schema.Struct({
  qualifiedName: Schema.String,
  rowCount: Schema.Number,
  byteLength: Schema.Number,
  sha256: Schema.String,
});
const StableByteSetSchema = Schema.Struct({
  byteLength: Schema.Number,
  sha256: Schema.String,
  tables: Schema.Array(StableTableProjectionSchema),
});
const StableByteSetsSchema = Schema.Struct({
  canonical: StableByteSetSchema,
  provenance: StableByteSetSchema,
  prerequisite: StableByteSetSchema,
  rule: StableByteSetSchema,
  auth: StableByteSetSchema,
  receipt: StableByteSetSchema,
  outbox: StableByteSetSchema,
});
const StableStateEvidenceSchema = Schema.Struct({
  counts: ImportCountsSchema,
  byteSets: StableByteSetsSchema,
});
const StableComparisonItemSchema = Schema.Struct({
  byteLengthEqual: Schema.Boolean,
  sha256Equal: Schema.Boolean,
  directBytesEqual: Schema.Boolean,
});
const StableComparisonSchema = Schema.Struct({
  canonical: StableComparisonItemSchema,
  provenance: StableComparisonItemSchema,
  prerequisite: StableComparisonItemSchema,
  rule: StableComparisonItemSchema,
  auth: StableComparisonItemSchema,
  receipt: StableComparisonItemSchema,
  outbox: StableComparisonItemSchema,
});
const OutcomeReasonSchema = Schema.Union([
  Schema.Null,
  Schema.Literal("MISSING_DEPARTMENT_FIELD"),
  Schema.Literal("DEPARTMENT_UNRESOLVED"),
  Schema.Literal("DUPLICATE_MEMBERSHIP"),
  Schema.Literal("TEAM_UNRESOLVED"),
]);
const OutcomeMatrixEntrySchema = Schema.Struct({
  order: Schema.Number,
  kind: Schema.Union([
    Schema.Literal("department"),
    Schema.Literal("team"),
    Schema.Literal("membership"),
  ]),
  sourcePrimaryKey: Schema.String,
  sourceOccurrence: Schema.Number,
  result: Schema.Union([Schema.Literal("Accepted"), Schema.Literal("Quarantined")]),
  reason: OutcomeReasonSchema,
  destinationIdentity: Schema.NullOr(Schema.String),
  targetSemanticIdentity: Schema.String,
});
const SourceMetadataSchema = Schema.Union([
  Schema.Null,
  Schema.Struct({
    startSemesterId: Schema.NullOr(Schema.Number),
    endSemesterId: Schema.NullOr(Schema.Number),
  }),
]);
const ProvenanceEntrySchema = Schema.Struct({
  sourceRepository: Schema.String,
  sourceRevision: Schema.String,
  snapshotId: Schema.String,
  sourceKind: Schema.Union([
    Schema.Literal("department"),
    Schema.Literal("team"),
    Schema.Literal("membership"),
  ]),
  sourcePrimaryKey: Schema.String,
  sourceOccurrence: Schema.Number,
  transformationRevision: Schema.String,
  targetSemanticIdentity: Schema.String,
  destinationIdentity: Schema.NullOr(Schema.String),
  result: Schema.Union([Schema.Literal("Accepted"), Schema.Literal("Quarantined")]),
  reason: OutcomeReasonSchema,
  sourceRawSha256: Schema.String,
  sourceMetadata: SourceMetadataSchema,
});
const ImportResultEvidenceSchema = Schema.Struct({
  byteLength: Schema.Number,
  sha256: Schema.String,
  counts: ImportCountsSchema,
  outcomeMatrix: Schema.Array(OutcomeMatrixEntrySchema),
  provenance: Schema.Array(ProvenanceEntrySchema),
});
const TriggerCatalogSchema = Schema.Struct({
  triggerCount: Schema.Number,
  functionCount: Schema.Number,
});
const ProcessObservationSchema = Schema.Struct({
  label: Schema.String,
  outcome: Schema.Union([
    Schema.Literal("Exited"),
    Schema.Literal("SpawnFailed"),
    Schema.Literal("Stopped"),
    Schema.Literal("AlreadyExited"),
    Schema.Literal("NotStarted"),
  ]),
  exitCode: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
});
const GeneratedOutputRestorationSchema = Schema.Struct({
  path: Schema.String,
  preexisting: Schema.Boolean,
  beforeSha256: Schema.NullOr(Schema.String),
  afterSha256: Schema.NullOr(Schema.String),
  restored: Schema.Boolean,
});
const BackendRequestSchema = Schema.Struct({
  method: Schema.String,
  path: Schema.String,
  status: Schema.Number,
  sessionCookieAuth: Schema.Boolean,
});
const ProxyRequestSchema = Schema.Struct({
  method: Schema.String,
  path: Schema.String,
  status: Schema.Number,
  sessionCookieAuth: Schema.Boolean,
  requestSource: Schema.Union([
    Schema.Literal("BrowserCrossOrigin"),
    Schema.Literal("DashboardSsr"),
    Schema.Literal("UnexpectedOrigin"),
  ]),
});
const NativeBrowserPathObservationSchema = Schema.Struct({
  path: Schema.String,
  status: Schema.Number,
  sessionCookieAuth: Schema.Boolean,
  access: Schema.Union([Schema.Literal("Public"), Schema.Literal("BoundedSession")]),
  requestSource: Schema.Union([
    Schema.Literal("BrowserCrossOrigin"),
    Schema.Literal("DashboardSsr"),
  ]),
});
const NativeBrowserPathObservationsSchema = Schema.Array(NativeBrowserPathObservationSchema).pipe(
  Schema.check(
    Schema.makeFilter(
      (observations) =>
        observations.length === NATIVE_BROWSER_JOURNEY_REQUIREMENTS.length &&
        NATIVE_BROWSER_JOURNEY_REQUIREMENTS.every((requirement, index) => {
          const observation = observations[index];
          return (
            observation !== undefined &&
            observation.path === requirement.path &&
            observation.status === 200 &&
            observation.sessionCookieAuth === (requirement.access === "BoundedSession") &&
            observation.access === requirement.access &&
            observation.requestSource === requirement.requestSource
          );
        }),
      { message: "the exact ordered native browser path authority observations" },
    ),
  ),
);
const BrowserRequestSchema = Schema.Struct({
  method: Schema.String,
  origin: Schema.Literal("api-proxy-loopback"),
  path: Schema.String,
  resourceType: Schema.String,
});
const UnexpectedApiRequestSchema = Schema.Struct({
  method: Schema.String,
  path: Schema.String,
});
const ExistingPageSessionCapabilityObservationSchema = Schema.Struct({
  path: Schema.String,
  status: Schema.Number,
  location: Schema.NullOr(Schema.String),
});

const BrowserPageSchema = Schema.Union([
  Schema.Struct({
    path: Schema.String,
    observed: StringArraySchema,
  }),
  Schema.Struct({
    path: Schema.String,
    observed: StringArraySchema,
    contactSha256: StringArraySchema,
  }),
]);
const OrganizationImportDashboardRuntimeSchema = Schema.Struct({
  build: Schema.Literal("ReactRouterProductionBuild"),
  server: Schema.Literal("ReactRouterServe"),
  viteDependencyOptimizer: Schema.Literal("NotUsed"),
});

const BrowserDiagnosticTextSchema = Schema.String.pipe(Schema.check(Schema.isMaxLength(2_000)));
const BrowserDiagnosticStringArraySchema = Schema.Array(BrowserDiagnosticTextSchema).pipe(
  Schema.check(
    Schema.makeFilter((values) => values.length <= 128, {
      message: "at most 128 bounded browser diagnostic strings",
    }),
  ),
);
const BrowserDiagnosticOriginSchema = Schema.Union([
  Schema.Literal("dashboard-loopback"),
  Schema.Literal("api-proxy-loopback"),
]);
const BrowserConsoleMessageSchema = Schema.Struct({
  type: BrowserDiagnosticTextSchema,
  text: BrowserDiagnosticTextSchema,
});
const BrowserConsoleMessagesSchema = Schema.Array(BrowserConsoleMessageSchema).pipe(
  Schema.check(
    Schema.makeFilter((messages) => messages.length <= 128, {
      message: "at most 128 bounded browser console messages",
    }),
  ),
);
const BrowserDiagnosticRequestSchema = Schema.Struct({
  method: BrowserDiagnosticTextSchema,
  origin: BrowserDiagnosticOriginSchema,
  path: BrowserDiagnosticTextSchema,
  resourceType: BrowserDiagnosticTextSchema,
});
const BrowserDiagnosticRequestsSchema = Schema.Array(BrowserDiagnosticRequestSchema).pipe(
  Schema.check(
    Schema.makeFilter((requests) => requests.length <= 128, {
      message: "at most 128 bounded browser request observations",
    }),
  ),
);
const BrowserFailedResponseSchema = Schema.Struct({
  origin: BrowserDiagnosticOriginSchema,
  path: BrowserDiagnosticTextSchema,
  status: Schema.Number,
});
const BrowserFailedResponsesSchema = Schema.Array(BrowserFailedResponseSchema).pipe(
  Schema.check(
    Schema.makeFilter((responses) => responses.length <= 128, {
      message: "at most 128 bounded browser failed-response observations",
    }),
  ),
);
const EmptyBrowserFailedResponsesSchema = BrowserFailedResponsesSchema.pipe(
  Schema.check(
    Schema.makeFilter((responses) => responses.length === 0, {
      message: "observed browser evidence must contain no failed responses",
    }),
  ),
);

export const OrganizationImportBrowserObservedEvidenceSchema = Schema.Struct({
  authorizationInstant: Schema.String,
  pages: Schema.Array(BrowserPageSchema),
  pageErrors: StringArraySchema,
  legacyOrganizationRequests: Schema.Number,
  rejectedDestinations: StringArraySchema,
  unexpectedApiRequests: Schema.Array(UnexpectedApiRequestSchema),
  requests: Schema.Array(BrowserRequestSchema),
  failedResponses: EmptyBrowserFailedResponsesSchema,
  viteDependencyRequests: Schema.Literal(0),
  dependencyOptimizerFailures: Schema.Literal(0),
  status: Schema.Literal("Observed"),
});

const BrowserUnexpectedApiRequestsSchema = Schema.Array(
  Schema.Struct({
    method: BrowserDiagnosticTextSchema,
    path: BrowserDiagnosticTextSchema,
  }),
).pipe(
  Schema.check(
    Schema.makeFilter((requests) => requests.length <= 128, {
      message: "at most 128 bounded unexpected API request observations",
    }),
  ),
);
const BrowserDiagnosticElementStateSchema = Schema.Struct({
  connected: Schema.Boolean,
  childCount: Schema.Number,
});
const BrowserFinalPageStateSchema = Schema.Struct({
  path: BrowserDiagnosticTextSchema,
  customElementDefined: Schema.Boolean,
  host: BrowserDiagnosticElementStateSchema,
  container: BrowserDiagnosticElementStateSchema,
  headings: BrowserDiagnosticStringArraySchema,
  alerts: BrowserDiagnosticStringArraySchema,
});
export const OrganizationImportBrowserFailedEvidenceSchema = Schema.Struct({
  status: Schema.Literal("Failed"),
  failure: BrowserDiagnosticTextSchema,
  pageErrors: BrowserDiagnosticStringArraySchema,
  consoleMessages: BrowserConsoleMessagesSchema,
  rejectedDestinations: BrowserDiagnosticStringArraySchema,
  unexpectedApiRequests: BrowserUnexpectedApiRequestsSchema,
  requests: BrowserDiagnosticRequestsSchema,
  failedResponses: BrowserFailedResponsesSchema,
  finalPageState: BrowserFinalPageStateSchema,
});
export type OrganizationImportBrowserFailedEvidence =
  typeof OrganizationImportBrowserFailedEvidenceSchema.Type;

export const decodeOrganizationImportBrowserObservedEvidence = (input: unknown) =>
  Schema.decodeUnknownEffect(OrganizationImportBrowserObservedEvidenceSchema)(input, {
    onExcessProperty: "error",
  });

export const decodeOrganizationImportBrowserFailedEvidence = (input: unknown) =>
  Schema.decodeUnknownEffect(OrganizationImportBrowserFailedEvidenceSchema)(input, {
    onExcessProperty: "error",
  });
const DirectoryUserSchema = Schema.Struct({
  personId: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  emailSha256: Schema.String,
  phoneSha256: Schema.String,
  studyProgramme: Schema.NullOr(Schema.String),
  departments: StringArraySchema,
  isActive: Schema.Boolean,
});
const StrictNativeProjectionSchema = Schema.Struct({
  departments: Schema.Array(
    Schema.Struct({
      departmentId: Schema.String,
      name: Schema.String,
      shortName: Schema.String,
      city: Schema.String,
      emailSha256: Schema.String,
      address: Schema.NullOr(Schema.String),
      latitude: Schema.NullOr(Schema.Number),
      longitude: Schema.NullOr(Schema.Number),
      logoPath: Schema.NullOr(Schema.String),
      slackChannel: Schema.NullOr(Schema.String),
      active: Schema.Boolean,
      revision: Schema.Number,
    }),
  ),
  teams: Schema.Array(
    Schema.Struct({
      teamId: Schema.String,
      departmentId: Schema.String,
      name: Schema.String,
      description: Schema.String,
      shortDescription: Schema.String,
      emailSha256: Schema.String,
      deadline: Schema.NullOr(Schema.String),
      acceptApplication: Schema.Boolean,
      active: Schema.Boolean,
      revision: Schema.Number,
    }),
  ),
  session: Schema.Struct({
    personId: Schema.String,
    expiresAt: Schema.String,
  }),
  missingSession: Schema.Struct({
    error: Schema.Struct({ tag: Schema.String }),
  }),
  administratorDirectory: Schema.Struct({
    activeUsers: Schema.Array(DirectoryUserSchema),
    inactiveUsers: Schema.Array(DirectoryUserSchema),
  }),
});
const PersonAuthorityProjectionSchema = Schema.Struct({
  personId: Schema.String,
  evaluatedAt: Schema.String,
  globalAdministrator: Schema.String,
  memberships: Schema.Array(
    Schema.Struct({
      membershipId: Schema.String,
      teamId: Schema.String,
      departmentId: Schema.String,
      active: Schema.Boolean,
      teamLeader: Schema.Boolean,
    }),
  ),
});
const OrganizationImportRehearsalArtifactSchema = Schema.Struct({
  contract: Schema.Struct({
    revision: Schema.String,
    frozenCodeBaseHead: Schema.String,
    implementationBaseHead: Schema.String,
    runtimeHead: Schema.String,
    frozenBaseMergeBase: Schema.String,
    implementationBaseMergeBase: Schema.String,
    actualBaseVerified: Schema.Boolean,
  }),
  source: Schema.Struct({
    sourceRepository: Schema.String,
    sourceRevision: Schema.String,
    snapshotId: Schema.String,
    snapshotHash: Schema.String,
    transformationRevision: Schema.String,
    authorizationInstant: Schema.String,
    sessionCookieSha256: Schema.String,
  }),
  database: Schema.Union([
    NotObservedSectionSchema,
    Schema.Struct({
      status: Schema.Literal("Observed"),
      postgresqlVersion: Schema.String,
      databaseNameSha256: Schema.String,
      migrationCount: Schema.Number,
      databaseSchemaRevision: Schema.String,
      migration23: Schema.Struct({
        migrationId: Schema.Number,
        name: Schema.String,
      }),
    }),
  ]),
  inventory: Schema.Union([
    NotObservedSectionSchema,
    Schema.Struct({
      status: Schema.Literal("Observed"),
      qualifiedTables: StringArraySchema,
      authCatalogTables: StringArraySchema,
      misplacedNativeTables: StringArraySchema,
      expectedPublicTables: StringArraySchema,
      observedPublicTables: StringArraySchema,
      misplacedAuthTables: StringArraySchema,
    }),
  ]),
  prerequisites: Schema.Union([
    NotObservedSectionSchema,
    Schema.Struct({
      status: Schema.Literal("Observed"),
      persons: Schema.Array(
        Schema.Struct({
          personId: Schema.String,
          firstName: Schema.String,
          lastName: Schema.String,
          emailSha256: Schema.String,
          phoneSha256: Schema.String,
          revision: Schema.Number,
        }),
      ),
      administratorGrant: Schema.Struct({
        grantId: Schema.String,
        personId: Schema.String,
        startAt: Schema.String,
        endAt: Schema.NullOr(Schema.String),
        revision: Schema.Number,
      }),
      baseline: StableStateEvidenceSchema,
      authDataRowCount: Schema.Number,
    }),
  ]),
  classifier: Schema.Union([
    NotObservedSectionSchema,
    Schema.Struct({
      status: Schema.Literal("Observed"),
      strictRuntimeDecoded: Schema.Boolean,
      snapshotObjectFrozen: Schema.Boolean,
      byteLength: Schema.Number,
      sha256: Schema.String,
      counts: ImportCountsSchema,
      outcomeMatrix: Schema.Array(OutcomeMatrixEntrySchema),
      provenance: Schema.Array(ProvenanceEntrySchema),
    }),
  ]),
  rollback: Schema.Union([
    NotObservedSectionSchema,
    Schema.Struct({
      status: Schema.Literal("Observed"),
      serviceFailure: Schema.Struct({
        tag: Schema.Literal("OrganizationPersistenceError"),
        operation: Schema.String,
      }),
      sqlState: Schema.String,
      triggerMessage: Schema.String,
      writeAttemptTrace: Schema.Array(
        Schema.Union([
          Schema.Struct({
            phase: Schema.Union([
              Schema.Literal("DepartmentInsert"),
              Schema.Literal("TeamInsert"),
              Schema.Literal("MembershipInsert"),
              Schema.Literal("QuarantineInsert"),
              Schema.Literal("LedgerInsert"),
            ]),
          }),
          Schema.Struct({
            phase: Schema.Literal("LedgerSqlError"),
            sqlState: Schema.NullOr(Schema.String),
            message: Schema.String,
          }),
        ]),
      ),
      delegatedSqlErrors: Schema.Array(
        Schema.Struct({
          sqlState: Schema.NullOr(Schema.String),
          message: Schema.String,
          statementTemplate: Schema.String,
        }),
      ),
      triggerCatalog: TriggerCatalogSchema,
      before: StableStateEvidenceSchema,
      after: StableStateEvidenceSchema,
      equality: StableComparisonSchema,
    }),
  ]),
  commitAndReplay: Schema.Union([
    NotObservedSectionSchema,
    Schema.Struct({
      status: Schema.Literal("Observed"),
      serviceImportInvocationCount: Schema.Number,
      distinctServiceSnapshotObjectCount: Schema.Number,
      allServiceInvocationsUsedDecodedSnapshot: Schema.Boolean,
      committedResult: ImportResultEvidenceSchema,
      replayResult: ImportResultEvidenceSchema,
      resultDirectBytesEqual: Schema.Boolean,
      committed: StableStateEvidenceSchema,
      replayed: StableStateEvidenceSchema,
      equality: StableComparisonSchema,
      residualFailureObjects: TriggerCatalogSchema,
      persistedMemberships: Schema.Array(
        Schema.Struct({
          membershipId: Schema.String,
          personId: Schema.String,
          teamId: Schema.String,
          deletedTeamName: Schema.NullOr(Schema.String),
          startAt: Schema.String,
          endAt: Schema.NullOr(Schema.String),
          positionId: Schema.String,
          isTeamLeader: Schema.Boolean,
          isSuspended: Schema.Boolean,
          revision: Schema.Number,
        }),
      ),
    }),
  ]),
  http: Schema.Union([
    NotObservedSectionSchema,
    Schema.Struct({
      status: Schema.Literal("Observed"),
      backendRequests: Schema.Array(BackendRequestSchema),
      strictNative: StrictNativeProjectionSchema,
      sdkDecoded: Schema.Boolean,
      fixtureMode: Schema.Boolean,
    }),
  ]),
  personAuthority: Schema.Union([
    NotObservedSectionSchema,
    Schema.Struct({
      status: Schema.Literal("Observed"),
      projection: PersonAuthorityProjectionSchema,
      fixedEvaluatedAt: Schema.String,
      authzRuleRows: Schema.Array(StableTableProjectionSchema),
      personSpecificRuleLockAttempts: Schema.Number,
    }),
  ]),
  browser: Schema.Union([
    NotObservedSectionSchema,
    Schema.Struct({
      status: Schema.Literal("Observed"),
      dashboardRuntime: OrganizationImportDashboardRuntimeSchema,
      practicality: Schema.String,
      pageSessionPreflight: Schema.Array(ExistingPageSessionCapabilityObservationSchema),
      preflightBackendProxyRequests: Schema.Array(ProxyRequestSchema),
      evidence: OrganizationImportBrowserObservedEvidenceSchema,
      nativePathObservations: NativeBrowserPathObservationsSchema,
      backendProxyRequests: Schema.Array(ProxyRequestSchema),
    }),
    Schema.Struct({
      status: Schema.Literal("Failed"),
      dashboardRuntime: OrganizationImportDashboardRuntimeSchema,
      evidence: OrganizationImportBrowserFailedEvidenceSchema,
    }),
    Schema.Struct({
      status: Schema.Literal("BrowserNotPractical"),
      dashboardRuntime: OrganizationImportDashboardRuntimeSchema,
      capability: Schema.Literal("ExistingPageBoundedSession"),
      reason: Schema.String,
      pageSessionPreflight: Schema.Array(ExistingPageSessionCapabilityObservationSchema),
      backendProxyRequests: Schema.Array(ProxyRequestSchema),
    }),
  ]),
  forbiddenEffects: Schema.Union([
    NotObservedSectionSchema,
    Schema.Struct({
      status: Schema.Literal("Observed"),
      ruleWriteAttempts: Schema.Number,
      authWriteAttempts: Schema.Number,
      receiptWriteAttempts: Schema.Number,
      outboxWriteAttempts: Schema.Number,
      outboxClaimAttempts: Schema.Number,
      credentialAttempts: Schema.Number,
      identityMutationAttempts: Schema.Number,
      providerRequests: Schema.Number,
      legacyOrganizationRequests: Schema.Number,
      unexpectedApiRequestAttempts: Schema.Number,
      productionResourceAttempts: Schema.Number,
      deploymentAttempts: Schema.Number,
      remoteEffectAttempts: Schema.Number,
      allowedDestinations: StringArraySchema,
      rejectedDestinations: StringArraySchema,
    }),
  ]),
  cleanup: Schema.Struct({
    status: Schema.Union([Schema.Literal("Observed"), Schema.Literal("Failed")]),
    processExitStatuses: Schema.Array(ProcessObservationSchema),
    portRelease: Schema.Struct({
      backend: Schema.Boolean,
      proxy: Schema.Boolean,
      dashboard: Schema.Boolean,
    }),
    databaseDisposal: Schema.Struct({
      databaseAbsent: Schema.Boolean,
      residualConnections: Schema.Number,
    }),
    failureObjectsRemovedBeforeCommit: Schema.Union([
      Schema.Literal("NotObservedDueToFailure"),
      TriggerCatalogSchema,
    ]),
    cookieCleared: Schema.Boolean,
    processSecretCleared: Schema.Boolean,
    databaseUrlCleared: Schema.Boolean,
    unsanitizedBrowserArtifactRemoved: Schema.Boolean,
    residualGeneratedPaths: StringArraySchema,
    generatedOutputRestoration: Schema.Array(GeneratedOutputRestorationSchema),
    runnerTempRootRemoved: Schema.Boolean,
    lifecycle: Schema.Struct({
      databaseDisposalCompleted: Schema.Boolean,
      cleanupFinalizationCompleted: Schema.Boolean,
      artifactValidationRequiresCleanupFinalization: Schema.Boolean,
      evidenceWriteRequiresArtifactValidation: Schema.Boolean,
    }),
    errors: StringArraySchema,
  }),
  observations: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("Observed"),
      transitionSequence: StringArraySchema,
      provenanceAuthorities: Schema.Struct({
        snapshot: Schema.String,
        organizationTables: Schema.String,
        importLedger: Schema.String,
        identityLayer: Schema.String,
        browser: Schema.String,
      }),
    }),
    Schema.Struct({
      status: Schema.Literal("Failed"),
      failedStage: Schema.String,
      message: Schema.String,
    }),
  ]),
  evidenceClassification: Schema.Struct({
    class: Schema.String,
    productionReadinessClaim: Schema.Boolean,
    proofClaim: Schema.Boolean,
    status: Schema.Union([Schema.Literal("Accepted"), Schema.Literal("Failed")]),
    failedChecks: Schema.Array(
      Schema.Struct({
        stage: Schema.String,
        message: Schema.String,
      }),
    ),
  }),
  evidenceSha256: Schema.String,
});

export const decodeOrganizationImportRehearsalArtifact = (input: unknown) =>
  Schema.decodeUnknownEffect(OrganizationImportRehearsalArtifactSchema)(input, {
    onExcessProperty: "error",
  });

export class OrganizationImportRehearsalEvidenceDigestMismatch extends Data.TaggedError(
  "OrganizationImportRehearsalEvidenceDigestMismatch",
)<{
  readonly storedSha256: string;
  readonly computedSha256: string;
}> {}

export const verifyOrganizationImportRehearsalArtifact = (input: unknown) =>
  decodeOrganizationImportRehearsalArtifact(input).pipe(
    Effect.flatMap((artifact) => {
      const { evidenceSha256, ...artifactCore } = artifact;
      const computedSha256 = sha256Hex(canonicalJsonBytes(artifactCore));
      return computedSha256 === evidenceSha256
        ? Effect.succeed(artifact)
        : Effect.fail(
            new OrganizationImportRehearsalEvidenceDigestMismatch({
              storedSha256: evidenceSha256,
              computedSha256,
            }),
          );
    }),
  );

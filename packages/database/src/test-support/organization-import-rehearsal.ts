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
  const phase = classifyImportWrite(text);
  const dml = dmlStatement(text);
  const personAuthorizationLock =
    text.includes("vektorprogrammet:person-authorization:v1:") ||
    values.some(
      (value) =>
        typeof value === "string" && value.startsWith("vektorprogrammet:person-authorization:v1:"),
    );
  const outboxAccess = /\b[A-Za-z0-9_]*_outbox\b/iu.test(text);
  const outboxClaim =
    outboxAccess && /\b(?:claim_id|claimed_at|FOR\s+UPDATE|SKIP\s+LOCKED)\b/iu.test(text);
  if (!dml && phase === undefined && !personAuthorizationLock && !outboxClaim) return statement;
  const before = Effect.sync(() => {
    if (dml && /\b(?:public\.)?authz_(?:tags|tag_assignments|rules)\b/iu.test(text)) {
      state.ruleDmlAttempts += 1;
    }
    if (
      dml &&
      /\bauth\s*\.\s*(?:"(?:user|session|account|verification)"|(?:user|session|account|verification)\b)/iu.test(
        text,
      )
    ) {
      state.authDmlAttempts += 1;
    }
    if (dml && /\b(?:public\.)?economy_(?:receipts|receipt_|payment_)/iu.test(text)) {
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
const JsonValueSchema = Schema.Unknown;
const NotObservedSectionSchema = Schema.Struct({
  status: Schema.Literal("NotObservedDueToFailure"),
});
const StringArraySchema = Schema.Array(Schema.String);
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
const ImportResultEvidenceSchema = Schema.Struct({
  byteLength: Schema.Number,
  sha256: Schema.String,
  counts: JsonValueSchema,
  outcomeMatrix: JsonValueSchema,
  provenance: JsonValueSchema,
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
      migration23: JsonValueSchema,
    }),
  ]),
  inventory: Schema.Union([
    NotObservedSectionSchema,
    Schema.Struct({
      status: Schema.Literal("Observed"),
      qualifiedTables: StringArraySchema,
      authCatalogTables: StringArraySchema,
      misplacedNativeTables: StringArraySchema,
      requiredPublicTables: StringArraySchema,
      observedRequiredPublicTables: StringArraySchema,
      misplacedAuthTables: StringArraySchema,
    }),
  ]),
  prerequisites: Schema.Union([
    NotObservedSectionSchema,
    Schema.Struct({
      status: Schema.Literal("Observed"),
      persons: JsonValueSchema,
      administratorGrant: JsonValueSchema,
      baseline: JsonValueSchema,
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
      counts: JsonValueSchema,
      outcomeMatrix: JsonValueSchema,
      provenance: JsonValueSchema,
    }),
  ]),
  rollback: Schema.Union([
    NotObservedSectionSchema,
    Schema.Struct({
      status: Schema.Literal("Observed"),
      serviceFailure: JsonValueSchema,
      sqlState: Schema.String,
      triggerMessage: Schema.String,
      writeAttemptTrace: JsonValueSchema,
      delegatedSqlErrors: JsonValueSchema,
      triggerCatalog: JsonValueSchema,
      before: JsonValueSchema,
      after: JsonValueSchema,
      equality: JsonValueSchema,
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
      committed: JsonValueSchema,
      replayed: JsonValueSchema,
      equality: JsonValueSchema,
      residualFailureObjects: JsonValueSchema,
      persistedMemberships: JsonValueSchema,
    }),
  ]),
  http: Schema.Union([
    NotObservedSectionSchema,
    Schema.Struct({
      status: Schema.Literal("Observed"),
      backendRequests: JsonValueSchema,
      strictNative: JsonValueSchema,
      sdkDecoded: Schema.Boolean,
      fixtureMode: Schema.Boolean,
    }),
  ]),
  personAuthority: Schema.Union([
    NotObservedSectionSchema,
    Schema.Struct({
      status: Schema.Literal("Observed"),
      projection: JsonValueSchema,
      fixedEvaluatedAt: Schema.String,
      authzRuleRows: JsonValueSchema,
      personSpecificRuleLockAttempts: Schema.Number,
    }),
  ]),
  browser: Schema.Union([
    NotObservedSectionSchema,
    Schema.Struct({
      status: Schema.Literal("Observed"),
      practicality: Schema.String,
      evidence: JsonValueSchema,
      backendProxyRequests: JsonValueSchema,
    }),
    Schema.Struct({
      status: Schema.Literal("BrowserNotPractical"),
      reason: Schema.String,
      processObservation: JsonValueSchema,
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
    failureObjectsRemovedBeforeCommit: JsonValueSchema,
    cookieCleared: Schema.Boolean,
    processSecretCleared: Schema.Boolean,
    databaseUrlCleared: Schema.Boolean,
    unsanitizedBrowserArtifactRemoved: Schema.Boolean,
    residualGeneratedPaths: StringArraySchema,
    generatedOutputRestoration: Schema.Array(GeneratedOutputRestorationSchema),
    runnerTempRootRemoved: Schema.Boolean,
    lifecycle: Schema.Struct({
      databaseDisposalCompleted: Schema.Boolean,
      artifactValidationRequiresDatabaseDisposal: Schema.Boolean,
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

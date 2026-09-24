import { backendDatabase } from "../../test/database.js";
import {
  AcceptedOAuthServiceCredential,
  CredentialMechanismSchema,
  PrincipalSchema,
  CredentialOutcomeSchema,
  CredentialEvidenceRef,
  ServicePrincipalId,
  ServicePrincipalGrantAuthority,
  NATIVE_API_PROTECTED_RESOURCE,
  RECEIPT_APPROVAL_QUEUE_OPERATION,
  makeServicePrincipalReceiptGrant,
  type ServicePrincipalReceiptGrantAuthority,
} from "@vektorprogrammet/domain/authz";
import {
  type DatabaseOperations,
  Database,
  IdentitySnapshot,
  OAuthCredentialAuthority,
} from "@vektorprogrammet/database";
import {
  ReceiptApprovalQueueResponse,
  IdempotencyKey,
  ReceiptResource,
  ReceiptListItem,
  ReceiptsReopenReceiptProblem,
} from "@vektorprogrammet/http-api";
import {
  NativeHttpCommandOutcome,
  executeNativeHttpCommandPostgres,
} from "../http-api/receipt-transaction.js";
import {
  Identity,
  IdentityActor,
  IdentityEngineError,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import {
  Receipt,
  ReceiptId,
  ReceiptVisualId,
  ReceiptFileSchema,
  ReceiptSettlementEvidenceSchema,
  type ReceiptSettlementCommandRequest,
  ReceiptMutationAuthorization,
  type OwnedReceiptProjectionItem,
  ApprovalScopeSchema,
  ReceiptOutboxDeliveryResult,
  Economy,
  InactiveActor,
  ReceiptDecodeError,
  ReceiptFileService,
  ReceiptNotFound,
  ReceiptPersistenceError,
  ReceiptOwnerDenied,
  ReceiptScopeDenied,
  UnauthenticatedActor,
  type EconomyOperations,
  ReceiptCommandRequestSchema,
  type ReceiptCommandRequest,
  type ReceiptApprovalFileReadFailure,
  type ReceiptCommandPrincipal,
  type ReceiptFailure,
  type ReceiptLifecycleEvidenceProjection,
  type ReceiptFile,
  type ReceiptSettlementEvidence,
  type ReceiptStatus,
  type ReceiptSubmissionAllocation,
} from "@vektorprogrammet/domain/receipt";
import { Predicate, DateTime, Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { deriveHttpIdentity, deriveStrongETag } from "../http-semantics.js";
import {
  makeInternalReceiptTestHttp,
  makeReceiptTestHttp as makeReceiptApiHttp,
} from "../test/native-http.js";

import type { ReceiptApiConfig } from "./config.js";
import { resolveRequestCredentialAtInstant } from "../authority.js";
import type { ReceiptFileStore } from "./filesystem.js";
import type { ReceiptTestHttpOptions } from "../test/native-http.js";

type ReceiptApiHttp = { readonly fetch: (request: Request) => Promise<Response> };

type ProjectionRow = Omit<OwnedReceiptProjectionItem, "settlement">;

type ReceiptAccessRow = {
  readonly ownerPersonId: string;
  readonly departmentId: string;
  readonly status: string;
  readonly revision: number;
};

const personId = PersonId.make("person-receipt-http");

const departmentOne = DepartmentId.make("department-one");

const evaluatedAt = "2026-08-24T12:00:00.000Z";

const receiptId = ReceiptId.make("receipt-one");

const visualId = ReceiptVisualId.make("visual-one");

const serviceBearer = "receipt-service-token";

const personBearer = "receipt-person-credential";

const config: ReceiptApiConfig = {
  stagingRoot: "/tmp/receipt-http-test-staging",
  committedRoot: "/tmp/receipt-http-test-committed",
  maxFileBytes: 1024,
  now: () => evaluatedAt,
  nextReceiptId: () => receiptId,
  nextVisualId: () => visualId,
};

const pendingReceipt = (overrides: Partial<ProjectionRow> = {}): ProjectionRow => ({
  receiptId,
  visualId,
  ownerPersonId: personId,
  departmentId: departmentOne,
  amountOre: "1200",
  currency: "NOK",
  description: "bus ticket",
  receiptDate: "2026-08-01",
  submittedAt: evaluatedAt,
  approvedAt: null,
  status: "Pending",
  revision: 0,
  ...overrides,
});

const settlementEvidence = (
  overrides: Partial<ReceiptSettlementEvidence> = {},
): ReceiptSettlementEvidence =>
  Schema.decodeUnknownSync(ReceiptSettlementEvidenceSchema)({
    settlementId: "settlement-one",
    receiptId,
    amountOre: 1200,
    currency: "NOK",
    paymentDestinationFingerprint: "a".repeat(64),
    externalAuthority: "Bank AS",
    externalReference: "external-reference-1",
    settledAt: "2026-08-24T11:00:00.000Z",
    recordedByPersonId: personId,
    recordedAt: evaluatedAt,
    receiptRevision: 1,
    ...overrides,
  });

const receiptEtag = (id: string, revision: number): string =>
  deriveStrongETag({
    representationKind: "ReceiptResource",
    resourceIdentity: id,
    version: revision,
  });

const fileService = {
  stage: () => Effect.void,
  apply: () => Effect.void,
};

const fileStore: ReceiptFileStore = {
  readCommitted: async () => {
    throw new Error("unexpected file read");
  },
  service: fileService,
  layer: Layer.succeed(ReceiptFileService, fileService),
  stageBytes: async () => ({
    file: {
      fileRef: "staging/file-one",
      objectKey: "committed/file-one",
      contentType: "image/png",
      byteLength: 4,
      sha256: "aa".repeat(32),
    },
    created: true,
  }),
  cleanupStage: async () => undefined,
};

interface HarnessOptions {
  readonly serviceApproval?: ServicePrincipalReceiptGrantAuthority;
  readonly unauthenticated?: boolean;
  readonly privateFileOwner?: string;
  readonly privateFileUnavailable?: boolean;
  readonly approvalFileRow?: ProjectionRow;
  readonly approvalFileFailure?: "Decode" | "Inactive" | "Scope";
  readonly approvalFileContentType?: "image/jpeg" | "image/png" | "application/pdf";
  readonly ownedRows?: ReadonlyArray<ProjectionRow>;
  readonly approvalRows?: ReadonlyArray<ProjectionRow>;
  readonly commandFailure?: ReceiptScopeDenied | ReceiptNotFound | ReceiptPersistenceError;
  readonly settlementRows?: ReadonlyArray<ProjectionRow>;
  readonly settlementEvidence?: ReceiptSettlementEvidence;
  readonly evidenceAccessRows?: ReadonlyArray<ReceiptAccessRow>;
  readonly evidenceResult?: ReceiptLifecycleEvidenceProjection;
  readonly revokeSessionAfterSnapshotRead?: boolean;
  readonly initialCommittedVersion?: number;
  readonly identitySnapshotFailure?: IdentityEngineError;
}

type RevocableReceiptAuthority = "Owner" | "Approval";

const transactionId = Database.use(
  (sql) => sql<{ id: string }>`SELECT pg_current_xact_id()::text AS id`,
).pipe(
  Effect.orDie,
  Effect.map((rows) => rows[0]!.id),
);

const transactionIsolation = Database.use(
  (sql) => sql<{ isolation: string }>`SELECT current_setting('transaction_isolation') AS isolation`,
).pipe(
  Effect.orDie,
  Effect.map((rows) => rows[0]!.isolation),
);

const harness = (options: HarnessOptions = {}) => {
  const serviceCredential: AcceptedOAuthServiceCredential | undefined =
    options.serviceApproval === undefined
      ? undefined
      : AcceptedOAuthServiceCredential.make({
          mechanism: CredentialMechanismSchema.cases.OAuthServiceBearer.make({}),
          principal: PrincipalSchema.cases.ServicePrincipal.make({
            servicePrincipalId: options.serviceApproval.servicePrincipalId,
          }),
          evidenceRef: CredentialEvidenceRef.make(
            "oauth:ServicePrincipal:receipt-unit:client:1970000000",
          ),
        });

  let privateFileReads = 0;

  const approvalFileQueries: Array<{
    readonly receiptId: string;
    readonly personId: string;
    readonly authorizationInstant: string;
    readonly snapshotIsolation: string;
  }> = [];

  const commands: Array<ReceiptCommandRequest> = [];
  const principals: Array<ReceiptCommandPrincipal> = [];
  const allocations: Array<ReceiptSubmissionAllocation | undefined> = [];
  const settlementCommands: Array<ReceiptSettlementCommandRequest> = [];
  const settlementReads: Array<{ readonly receiptId: string; readonly personId: string }> = [];

  const approvalQueries: Array<{
    readonly personId: typeof personId;
    readonly authorizationInstant: string;
    readonly status: ReceiptStatus | undefined;
  }> = [];

  const evidenceReads: Array<{ readonly receiptId: string; readonly personId: string }> = [];

  const commandTransactionIds: Array<string> = [];

  const identitySnapshotIsolations: Array<string> = [];
  const identitySnapshotVersions: Array<number> = [];

  let authorizationPrincipalCalls = 0;
  const authorizationChecks: Array<string> = [];
  let revokedAuthority: RevocableReceiptAuthority | undefined;
  let revokedServiceBearer = false;

  const sourceReceipt = (command: ReceiptCommandRequest): ProjectionRow => {
    if (Predicate.isTagged(command, "SubmitReceipt")) {
      return pendingReceipt({
        receiptId: allocations.at(-1)?.receiptId ?? receiptId,
        visualId: allocations.at(-1)?.visualId ?? visualId,
        departmentId: DepartmentId.make(String(command.departmentId ?? departmentOne)),
        amountOre: String(command.amountOre),
        description: String(command.description),
        receiptDate: String(command.receiptDate),
      });
    }

    return (
      [...(options.ownedRows ?? []), ...(options.approvalRows ?? [])].find(
        (row) => row.receiptId === command.receiptId,
      ) ?? pendingReceipt()
    );
  };

  const receiptFromProjection = (row: ProjectionRow): Receipt =>
    new Receipt({
      ...row,
      amountOre: Number(row.amountOre),
      approvedAt: row.status === "Approved" ? "2026-08-24T12:00:00.000Z" : null,
      paymentAccountCiphertext: "encrypted",
      file: ReceiptFileSchema.make({
        fileRef: "staging/file-one",
        objectKey: "committed/file-one",
        contentType: "image/png",
        byteLength: 4,
        sha256: "aa".repeat(32),
      }),
    });

  const makeEconomy = (sql: DatabaseOperations) => {
    const executeReceipt: EconomyOperations["executeReceipt"] = (input, principal, allocation) =>
      Effect.gen(function* () {
        if (options.commandFailure !== undefined) return yield* options.commandFailure;

        const command = yield* Schema.decodeUnknownEffect(ReceiptCommandRequestSchema)(input).pipe(
          Effect.mapError((cause) => new ReceiptDecodeError({ message: cause.message })),
        );

        commands.push(command);
        principals.push(principal);
        allocations.push(allocation);
        commandTransactionIds.push(yield* transactionId);
        const source = sourceReceipt(command);

        const nextRevision = "expectedRevision" in command ? command.expectedRevision + 1 : 0;

        const status = Predicate.isTagged(command, "WithdrawPendingReceipt")
          ? "Withdrawn"
          : Predicate.isTagged(command, "ApproveReceipt")
            ? "Approved"
            : Predicate.isTagged(command, "RejectReceipt")
              ? "Rejected"
              : "Pending";

        const receipt = receiptFromProjection({
          ...source,
          description: "description" in command ? command.description : source.description,
          amountOre: String("amountOre" in command ? command.amountOre : source.amountOre),
          receiptDate: "receiptDate" in command ? command.receiptDate : source.receiptDate,
          status,
          revision: nextRevision,
        });

        return {
          observation: {
            commandId: String(command.commandId),
            receiptId: receipt.receiptId,
            visualId: receipt.visualId,
            status: receipt.status,
            revision: receipt.revision,
            replayed: false,
          },
          receipt,
          replayed: false,
          outboxCount: 0,
        };
      }).pipe(Effect.provideService(Database, sql));

    const authorizeReceiptMutation: EconomyOperations["authorizeReceiptMutation"] = (
      target,
      principal,
    ) =>
      Effect.suspend<ReceiptMutationAuthorization, ReceiptFailure, never>(() => {
        authorizationChecks.push(target._tag);

        if (Predicate.isTagged(target, "SubmitReceipt")) {
          return Effect.succeed(
            ReceiptMutationAuthorization[target._tag]({
              principal,
              actor: {
                personId: principal.personId,
                departmentId: target.departmentId ?? departmentOne,
                active: true,
                approvalScope: ApprovalScopeSchema.cases.None.make({}),
              },
              departmentId: target.departmentId ?? departmentOne,
              paymentAccountCiphertext: "encrypted",
            }),
          );
        }

        const approval =
          Predicate.isTagged(target, "ApproveReceipt") ||
          Predicate.isTagged(target, "RejectReceipt") ||
          Predicate.isTagged(target, "ReopenRejectedReceipt");

        const source = (approval ? options.approvalRows : options.ownedRows)?.find(
          (row) => row.receiptId === target.receiptId,
        );

        if (source === undefined) {
          return Effect.fail(
            approval
              ? new ReceiptScopeDenied({
                  receiptId: target.receiptId,
                  departmentId: departmentOne,
                })
              : new ReceiptNotFound({ receiptId: target.receiptId }),
          );
        }

        if (revokedAuthority === (approval ? "Approval" : "Owner")) {
          return Effect.fail(
            approval
              ? new ReceiptScopeDenied({
                  receiptId: target.receiptId,
                  departmentId: source.departmentId,
                })
              : new ReceiptOwnerDenied({
                  receiptId: target.receiptId,
                  personId: principal.personId,
                }),
          );
        }

        const authorization: ReceiptMutationAuthorization = ReceiptMutationAuthorization[
          target._tag
        ]({
          principal,
          actor: {
            personId: principal.personId,
            departmentId: source.departmentId,
            active: true,
            approvalScope: approval
              ? ApprovalScopeSchema.cases.Department.make({ departmentId: source.departmentId })
              : ApprovalScopeSchema.cases.None.make({}),
          },
          current: receiptFromProjection(source),
        });

        return Effect.succeed(authorization);
      });

    const executeAuthorizedReceipt: EconomyOperations["executeAuthorizedReceipt"] = (
      input,
      authorization,
      allocation,
    ) => executeReceipt(input, authorization.principal, allocation);

    const readReceiptSettlementRevision: EconomyOperations["readReceiptSettlementRevision"] = (
      requestedReceiptId,
    ) =>
      Effect.suspend(() => {
        const source = (options.settlementRows ?? []).find(
          (row) => row.receiptId === requestedReceiptId,
        );

        return source === undefined
          ? Effect.fail(new ReceiptNotFound({ receiptId: requestedReceiptId }))
          : Effect.succeed(source.revision);
      });

    const recordReceiptSettlement: EconomyOperations["recordReceiptSettlement"] = (
      command,
      principal,
    ) =>
      Effect.suspend(() => {
        const source = (options.settlementRows ?? []).find(
          (row) => row.receiptId === command.receiptId,
        );

        if (source === undefined) {
          return Effect.fail(new ReceiptNotFound({ receiptId: command.receiptId }));
        }

        settlementCommands.push(command);

        const receipt = {
          ...receiptFromProjection(source),
          revision: source.revision + 1,
        };

        const evidence = settlementEvidence({
          ...options.settlementEvidence,
          receiptId: receipt.receiptId,
          amountOre: receipt.amountOre,
          currency: "NOK",
          recordedByPersonId: principal.personId,
          receiptRevision: receipt.revision,
        });

        return Effect.succeed({
          observation: {
            commandId: String(command.commandId),
            receiptId: receipt.receiptId,
            settlementId: evidence.settlementId,
            revision: receipt.revision,
            replayed: false,
          },
          receipt,
          settlement: evidence,
          replayed: false,
          outboxCount: 1,
        });
      });

    const economy: EconomyOperations = {
      executeReceipt,
      authorizeReceiptMutation,
      executeAuthorizedReceipt,
      readReceiptSettlementRevision,
      recordReceiptSettlement,
      listReceiptsForSettlement: () =>
        Effect.succeed(
          (options.settlementRows ?? []).map((row) => {
            if (row.status !== "Approved" || row.approvedAt === null)
              throw new Error("Settlement queue fixtures must be approved");

            return { ...row, status: row.status, approvedAt: row.approvedAt };
          }),
        ),
      readReceiptSettlementForFinance: (requestedReceiptId, queryPersonId) =>
        Effect.suspend(() => {
          settlementReads.push({ receiptId: requestedReceiptId, personId: queryPersonId });
          const evidence = options.settlementEvidence;

          return evidence === undefined || evidence.receiptId !== requestedReceiptId
            ? Effect.fail(new ReceiptNotFound({ receiptId: requestedReceiptId }))
            : Effect.succeed(evidence);
        }),
      listOwnedReceipts: () =>
        Effect.succeed(
          (options.ownedRows ?? []).map((row) => ({
            ...row,
            settlement:
              options.settlementEvidence?.receiptId === row.receiptId
                ? options.settlementEvidence
                : null,
          })),
        ),
      listReceiptsForApproval: (queryPersonId, authorizationInstant, status) => {
        approvalQueries.push({ personId: queryPersonId, authorizationInstant, status });

        return Effect.succeed(options.approvalRows ?? []);
      },
      readReceiptFileForApproval: (requestedReceiptId, queryPersonId, authorizationInstant) =>
        transactionIsolation
          .pipe(
            Effect.flatMap((snapshotIsolation) =>
              Effect.suspend<ReceiptFile, ReceiptApprovalFileReadFailure, never>(() => {
                approvalFileQueries.push({
                  receiptId: requestedReceiptId,
                  personId: queryPersonId,
                  authorizationInstant,
                  snapshotIsolation,
                });
                const source = options.approvalFileRow;

                if (options.approvalFileFailure === "Decode") {
                  return Effect.fail(
                    new ReceiptDecodeError({ message: "malformed stored file metadata" }),
                  );
                }

                if (options.approvalFileFailure === "Inactive") {
                  return Effect.fail(new InactiveActor({ personId: queryPersonId }));
                }

                if (options.approvalFileFailure === "Scope") {
                  return Effect.fail(
                    new ReceiptScopeDenied({
                      receiptId: requestedReceiptId,
                      departmentId: source?.departmentId ?? departmentOne,
                    }),
                  );
                }

                if (source === undefined || source.receiptId !== requestedReceiptId) {
                  return Effect.fail(new ReceiptNotFound({ receiptId: requestedReceiptId }));
                }

                return Effect.succeed({
                  fileRef: "staging/approval-file",
                  objectKey: "committed/approval-file",
                  contentType: options.approvalFileContentType ?? "application/pdf",
                  byteLength: 4,
                  sha256: "b".repeat(64),
                });
              }),
            ),
          )
          .pipe(Effect.provideService(Database, sql)),
      readReceiptLifecycleEvidence: (id, ownerPersonId) =>
        Effect.sync(() => {
          evidenceReads.push({ receiptId: id, personId: ownerPersonId });

          if (options.evidenceResult === undefined)
            throw new Error("unexpected receipt evidence read");

          return options.evidenceResult;
        }),
      receiptStatusTotals: Effect.succeed([]),
      listStaleOutboxClaims: () => Effect.succeed([]),
      recoverStaleOutboxClaim: () => Effect.succeed(0),
      deliverNextOutboxEffect: () => Effect.succeed(ReceiptOutboxDeliveryResult.Idle()),
    };

    return economy;
  };

  const database = backendDatabase(
    Database.use((sql) =>
      Effect.gen(function* () {
        yield* sql`CREATE TABLE test_credential (version integer NOT NULL)`;
        yield* sql`INSERT INTO test_credential VALUES (1)`;

        const evidenceRows = (options.evidenceAccessRows ?? []).map((row) => ({
          ...row,
          receiptId,
          ownerPersonId: row.ownerPersonId,
        }));

        const privateRows =
          options.privateFileOwner === undefined
            ? []
            : [
                {
                  receiptId: ReceiptId.make("private"),
                  ownerPersonId: PersonId.make(options.privateFileOwner),
                  departmentId: departmentOne,
                  status: "Approved",
                  revision: 1,
                },
              ];

        for (const row of [...evidenceRows, ...privateRows])
          yield* sql`INSERT INTO economy_receipts (receipt_id,visual_id,owner_person_id,department_id,amount_ore,currency,description,receipt_date,submitted_at,status,approved_at,payment_account_ciphertext,file_ref,file_object_key,file_content_type,file_byte_length,file_sha256,revision) VALUES (${row.receiptId},${"visual-" + row.receiptId},${row.ownerPersonId},${row.departmentId},1200,'NOK','Evidence','2026-08-24',${evaluatedAt}::timestamptz,${row.status},${row.status === "Approved" ? evaluatedAt : null}::timestamptz,'encrypted','staging/private','committed/private','application/pdf',4,${"a".repeat(64)},${row.revision})`;
      }),
    ),
  );

  const economyLayer = Layer.effect(Economy, Effect.map(Database, makeEconomy)).pipe(
    Layer.provide(database.layer),
  );

  const identitySnapshot = IdentitySnapshot.of({
    resolveSession: (cookieHeader) =>
      Effect.gen(function* () {
        identitySnapshotIsolations.push(yield* transactionIsolation);

        const rows = yield* Database.use(
          (sql) => sql<{ version: number }>`SELECT version FROM test_credential`,
        ).pipe(Effect.orDie);

        const observedVersion = rows[0]!.version;
        identitySnapshotVersions.push(observedVersion);

        if (options.identitySnapshotFailure !== undefined)
          return yield* options.identitySnapshotFailure;

        if (cookieHeader === undefined || options.unauthenticated === true || observedVersion === 2)
          return yield* new IdentitySessionNotFound();

        return new IdentityActor({
          personId,
          sessionId: "receipt-http-session",
          expiresAt: DateTime.makeUnsafe(new Date("2031-09-16T12:00:00.000Z")),
        });
      }),
    revokeCurrentSession: () => Effect.die("unexpected session mutation"),
    revokeSession: () => Effect.die("unexpected session mutation"),
    revokeOtherSessions: () => Effect.die("unexpected session mutation"),
    revokeAllSessions: () => Effect.die("unexpected session mutation"),
  });

  const servicePrincipalGrantAuthority = ServicePrincipalGrantAuthority.of({
    readReceiptApprovalCandidates: () =>
      options.serviceApproval
        ? Effect.succeed(options.serviceApproval)
        : Effect.die("unexpected service receipt read"),
    createGrant: () => Effect.die("unexpected grant write"),
    endGrant: () => Effect.die("unexpected grant write"),
    revokeGrant: () => Effect.die("unexpected grant write"),
  });

  const identity = Identity.of({
    signIn: () => Promise.reject(new Error("unexpected sign-in")),
    resolveSession: async () =>
      new IdentityActor({
        personId,
        sessionId: "receipt-http-session",
        expiresAt: DateTime.makeUnsafe(new Date("2031-09-16T12:00:00.000Z")),
      }),
    readCurrentSession: () => Promise.reject(new Error("unexpected session read")),
    listSessions: () => Promise.reject(new Error("unexpected session list")),
    revokeCurrentSession: () => Promise.reject(new Error("unexpected session mutation")),
    revokeSession: () => Promise.reject(new Error("unexpected session mutation")),
    revokeOtherSessions: () => Promise.reject(new Error("unexpected session mutation")),
    revokeAllSessions: () => Promise.reject(new Error("unexpected session mutation")),
    recordSecurityEvent: () => Promise.reject(new Error("unexpected identity audit")),
    signOut: async () => ({ setCookies: [] }),
  } satisfies IdentityOperations);

  const oauthCredentialAuthority = OAuthCredentialAuthority.of({
    resolve: async (request, expected) => {
      if (
        request.headers.get("authorization") === `Bearer ${personBearer}` &&
        expected !== "OAuthServiceBearer"
      ) {
        return CredentialOutcomeSchema.cases.Accepted.make({
          mechanism: CredentialMechanismSchema.cases.OAuthUserBearer.make({}),
          principal: PrincipalSchema.cases.Person.make({ personId }),
          evidenceRef: CredentialEvidenceRef.make("oauth:Person:receipt-user:client:1970000000"),
        });
      }

      return options.serviceApproval !== undefined &&
        request.headers.get("authorization") === `Bearer ${serviceBearer}` &&
        expected === "Either" &&
        !revokedServiceBearer
        ? serviceCredential!
        : CredentialOutcomeSchema.cases.Rejected.make({ reason: "Revoked" as const });
    },
    resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
  });

  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Database | Economy | IdentitySnapshot | ServicePrincipalGrantAuthority
    >,
  ): Promise<A> =>
    database.run(
      effect.pipe(
        Effect.provide(economyLayer),
        Effect.provideService(IdentitySnapshot, identitySnapshot),
        Effect.provideService(ServicePrincipalGrantAuthority, servicePrincipalGrantAuthority),
      ),
    );

  const services = Layer.mergeAll(
    database.layer,
    economyLayer,
    Layer.succeed(IdentitySnapshot, identitySnapshot),
    Layer.succeed(ServicePrincipalGrantAuthority, servicePrincipalGrantAuthority),
    Layer.succeed(Identity, identity),
    Layer.succeed(OAuthCredentialAuthority, oauthCredentialAuthority),
  );

  const httpOptions = {
    config: { ...config, e2eTestMode: true },
    identity: {
      resolveApprovalCredential:
        serviceCredential === undefined
          ? undefined
          : (request: Request) =>
              resolveRequestCredentialAtInstant(request, "Either", { now: () => evaluatedAt }).pipe(
                Effect.provideService(Identity, identity),
                Effect.provideService(OAuthCredentialAuthority, oauthCredentialAuthority),
              ),
      resolveAuthorizationPrincipal: () =>
        Effect.suspend(() => {
          authorizationPrincipalCalls += 1;

          return options.unauthenticated === true
            ? Effect.fail(new UnauthenticatedActor({ message: "no session" }))
            : Effect.succeed({ personId, authorizationInstant: evaluatedAt });
        }),
      resolvePersonId: () => Effect.succeed(personId),
    },
    now: () => evaluatedAt,
    fileStore: {
      ...fileStore,
      readCommitted: async () => {
        privateFileReads++;

        if (options.privateFileUnavailable) throw new Error("private bytes unavailable");

        return new Uint8Array([1, 2, 3, 4]);
      },
    },
  } satisfies ReceiptTestHttpOptions<UnauthenticatedActor | IdentityEngineError, never>;

  return {
    http: makeReceiptApiHttp(httpOptions, services),
    internalHttp: makeInternalReceiptTestHttp(httpOptions, services),
    commands,
    settlementCommands,
    settlementReads: () => settlementReads,
    privateFileReads: () => privateFileReads,
    principals,
    allocations,
    approvalQueries,
    approvalFileQueries: () => approvalFileQueries,
    evidenceReads,
    nativeReceiptCount: () =>
      database.run(
        Database.use(
          (sql) =>
            sql<{
              count: number;
            }>`SELECT count(*)::integer AS count FROM public.native_http_idempotency_receipts`,
        ).pipe(Effect.map((rows) => rows[0]!.count)),
      ),
    run,
    currentTransactionId: transactionId,
    mutationTransactions: async () => ({
      commandTransactionIds,
      receiptWriteTransactionIds: await database.run(
        Database.use(
          (sql) =>
            sql<{
              id: string;
            }>`SELECT xmin::text AS id FROM public.native_http_idempotency_receipts ORDER BY committed_at`,
        ).pipe(Effect.map((rows) => rows.map((row) => row.id))),
      ),
    }),
    evidenceCounts: () => ({ evidenceReads }),
    snapshotObservations: async () => ({
      identitySnapshotIsolations,
      identitySnapshotVersions,
      committedVersion: await database.run(
        Database.use((sql) => sql<{ version: number }>`SELECT version FROM test_credential`).pipe(
          Effect.map((rows) => rows[0]!.version),
        ),
      ),
    }),
    revokeCredential: () =>
      database.run(
        Database.use((sql) => sql`UPDATE test_credential SET version=2`).pipe(Effect.asVoid),
      ),
    revokeAuthority: (authority: RevocableReceiptAuthority) => {
      revokedAuthority = authority;
    },
    revokeServiceBearer: () => {
      revokedServiceBearer = true;
    },
    authorizationChecks: () => authorizationChecks,
    authorizationPrincipalCalls: () => authorizationPrincipalCalls,
  };
};

const request = (
  http: ReceiptApiHttp,
  pathname: string,
  init?: RequestInit,
  includeCookie = true,
): Promise<Response> => {
  const headers = new Headers(init?.headers);

  if (includeCookie) headers.set("cookie", "better-auth.session_token=receipt-test-session");

  if (init?.method !== undefined && init.method !== "GET") {
    headers.set("origin", "http://127.0.0.1:5174");
  }

  return http.fetch(new Request(`http://backend.test${pathname}`, { ...init, headers }));
};

const submitRequest = (http: ReceiptApiHttp, idempotencyKey: string): Promise<Response> => {
  const boundary = "receipt-http-test-boundary";

  const body = [
    `--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\nbus ticket\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="amountOre"\r\n\r\n1200\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="receiptDate"\r\n\r\n2026-08-01\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="receipt.png"\r\nContent-Type: image/png\r\n\r\ntest\r\n`,
    `--${boundary}--\r\n`,
  ].join("");

  return request(http, "/api/receipts", {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(Buffer.byteLength(body)),
      "idempotency-key": idempotencyKey,
    },
    body,
  });
};

const actionRequest = (
  http: ReceiptApiHttp,
  pathname: string,
  idempotencyKey: string,
  revision = 0,
  body: Schema.Json = {},
): Promise<Response> =>
  request(http, pathname, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(JSON.stringify(body))),
      "idempotency-key": idempotencyKey,
      "if-match": receiptEtag(receiptId, revision),
    },
    body: JSON.stringify(body),
  });

const readJson = async (response: Response) =>
  Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(await response.json());

const expectProblem = async (
  response: Response,
  expected: {
    readonly code: string;
    readonly title: string;
    readonly status: number;
    readonly detail: string;
  },
) => {
  expect(response.status).toBe(expected.status);
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    type: `urn:vektorprogrammet:problem:v0.2:${expected.code}`,
    ...expected,
  });
};

describe("receipt v0.2 HTTP contract", () => {
  it("lists only the authenticated person's receipts with private projection ETags", async () => {
    const state = harness({ ownedRows: [pendingReceipt()] });
    const response = await request(state.http, "/api/receipts?status=Pending");
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toEqual({
      items: [
        Schema.decodeUnknownSync(ReceiptListItem)({
          ...pendingReceipt(),
          amountOre: 1200,
          settlement: null,
          etag: receiptEtag(receiptId, 0),
        }),
      ],
      totalItems: 1,
    });
    expect(state.authorizationPrincipalCalls()).toBe(1);
  });

  it("lists only approved unsettled receipts in the private settlement queue", async () => {
    const queueRow = pendingReceipt({
      status: "Approved",
      approvedAt: evaluatedAt,
      revision: 2,
    });

    const state = harness({ settlementRows: [queueRow] });
    const response = await request(state.http, "/api/receipt-settlement-queue");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Origin");
    expect(await readJson(response)).toEqual({
      items: [
        {
          receiptId,
          visualId,
          ownerPersonId: personId,
          departmentId: departmentOne,
          description: "bus ticket",
          amountOre: 1200,
          currency: "NOK",
          receiptDate: "2026-08-01",
          status: "Approved",
          approvedAt: evaluatedAt,
          revision: 2,
          etag: receiptEtag(receiptId, 2),
        },
      ],
      totalItems: 1,
    });
  });

  it("rejects settlement media types outside the declared JSON contract", async () => {
    const state = harness();

    const response = await request(state.http, `/api/receipts/${receiptId}:settle`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "idempotency-key": "settle-wrong-media-type-0001",
        "if-match": receiptEtag(receiptId, 2),
      },
      body: "not-json",
    });

    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ code: "media-type.unsupported" });
    expect(state.settlementCommands).toHaveLength(0);
  });

  it("stops reading an undeclared oversized settlement body", async () => {
    const state = harness();

    const response = await request(state.http, `/api/receipts/${receiptId}:settle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "settle-oversized-stream-0001",
        "if-match": receiptEtag(receiptId, 2),
      },
      body: "x".repeat(65_537),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "request.too-large" });
    expect(state.settlementCommands).toHaveLength(0);
  });

  it("records private immutable settlement evidence with revision and idempotent replay", async () => {
    const queueRow = pendingReceipt({
      status: "Approved",
      approvedAt: evaluatedAt,
      revision: 2,
    });

    const evidence = settlementEvidence({ receiptRevision: 3 });
    const state = harness({ settlementRows: [queueRow], settlementEvidence: evidence });

    const payload = {
      expectedRevision: 2,
      externalAuthority: evidence.externalAuthority,
      externalReference: evidence.externalReference,
      settledAt: evidence.settledAt,
    };

    const key = "settle-receipt-idempotency-key-0001";

    const recorded = await actionRequest(
      state.http,
      `/api/receipts/${receiptId}:settle`,
      key,
      2,
      payload,
    );

    const recordedBody = await readJson(recorded);

    const replay = await actionRequest(
      state.http,
      `/api/receipts/${receiptId}:settle`,
      key,
      2,
      payload,
    );

    const changedReplay = await actionRequest(
      state.http,
      `/api/receipts/${receiptId}:settle`,
      key,
      2,
      { ...payload, externalReference: "changed-external-reference" },
    );

    expect(changedReplay.status).toBe(409);
    expect(changedReplay.headers.get("cache-control")).toBe("private, no-store");
    expect(await changedReplay.json()).toMatchObject({ code: "idempotency.digest-conflict" });

    expect(recorded.status).toBe(200);
    expect(recorded.headers.get("cache-control")).toBe("private, no-store");
    expect(recorded.headers.get("vary")).toBe("Origin");
    expect(recorded.headers.get("etag")).toBe(receiptEtag(receiptId, 3));
    expect(recordedBody).toMatchObject(evidence);
    expect(await replay.json()).toEqual(recordedBody);
    expect(state.settlementCommands).toHaveLength(1);
  });

  it("reads finance settlement evidence privately and conceals a missing settlement", async () => {
    const evidence = settlementEvidence();
    const state = harness({ settlementEvidence: evidence });

    const visible = await request(
      state.http,
      `/api/receipt-settlement-queue/${encodeURIComponent(receiptId)}`,
    );

    const concealed = await request(state.http, "/api/receipt-settlement-queue/not-visible");

    expect(visible.status).toBe(200);
    expect(visible.headers.get("cache-control")).toBe("private, no-store");
    expect(await readJson(visible)).toMatchObject(evidence);
    expect(state.settlementReads()).toEqual([
      { receiptId, personId },
      { receiptId: ReceiptId.make("not-visible"), personId },
    ]);
    expect(concealed.status).toBe(404);
    expect(concealed.headers.get("cache-control")).toBe("private, no-store");
    expect(await concealed.json()).toMatchObject({ code: "receipt.not-found" });
  });

  it("returns the frozen RFC 9457 credential problem", async () => {
    const response = await request(
      harness({ unauthenticated: true }).http,
      "/api/receipts",
      undefined,
      false,
    );

    await expectProblem(response, {
      code: "credential.missing",
      title: "Credential required",
      status: 401,
      detail: "A credential is required for this operation.",
    });
  });

  it("derives opaque command identity only from credential, operation, target, and idempotency key", () => {
    const first = deriveHttpIdentity({
      credentialSubject: `Person:${personId}`,
      qualifiedOperationId: "receipts.submitReceipt",
      normalizedTarget: "/api/receipts",
      idempotencyKey: IdempotencyKey.make("submit-receipt-idempotency-key"),
    });

    const second = deriveHttpIdentity({
      credentialSubject: `Person:${personId}`,
      qualifiedOperationId: "receipts.submitReceipt",
      normalizedTarget: "/api/receipts",
      idempotencyKey: IdempotencyKey.make("another-receipt-idempotency-key"),
    });

    expect(first.commandId).toMatch(/^httpv2_[A-Za-z0-9_-]{43}$/u);
    expect(first.identitySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.commandId).not.toBe(first.commandId);
    expect(first.commandId).not.toContain(personId);
    expect(first.commandId).not.toContain("submit-receipt-idempotency-key");
  });

  it("persists and replays exact 201 and 200 response capsules in transaction-scoped native receipts", async () => {
    const state = harness();
    const executedIn: Array<string> = [];

    const cases = [
      {
        key: "created-response-idempotency-key",
        requestSha256: "a".repeat(64),
        operationId: "receipts.submitReceipt",
        capsule: {
          status: 201,
          mediaType: "application/json",
          bodyBytes: new TextEncoder().encode('{"receiptId":"receipt-one"}'),
          headers: {
            "content-type": "application/json",
            location: `/api/receipts/${receiptId}`,
            etag: receiptEtag(receiptId, 0),
          },
        },
      },
      {
        key: "entity-response-idempotency-key",
        requestSha256: "b".repeat(64),
        operationId: "receipts.withdrawReceipt",
        capsule: {
          status: 200,
          mediaType: "application/json",
          bodyBytes: new TextEncoder().encode('{"status":"Withdrawn"}'),
          headers: {
            "content-type": "application/json",
            etag: receiptEtag(receiptId, 1),
          },
        },
      },
    ] as const;

    for (const item of cases) {
      const derived = deriveHttpIdentity({
        credentialSubject: `Person:${personId}`,
        qualifiedOperationId: item.operationId,
        normalizedTarget: "/api/receipts",
        idempotencyKey: IdempotencyKey.make(item.key),
      });

      const identity = {
        identitySha256: derived.identitySha256,
        requestSha256: item.requestSha256,
        operationId: item.operationId,
      };

      const execute = Effect.gen(function* () {
        executedIn.push(yield* state.currentTransactionId);

        return item.capsule;
      });

      const plan = Effect.succeed({ identity, execute });
      const committed = await state.run(executeNativeHttpCommandPostgres(plan));
      const replayed = await state.run(executeNativeHttpCommandPostgres(plan));

      expect(committed).toEqual(NativeHttpCommandOutcome.Committed({ response: item.capsule }));
      expect(replayed._tag).toBe("Replay");

      if (!Predicate.isTagged(replayed, "Replay"))
        throw new Error("expected native receipt replay");

      expect({
        ...replayed.response,
        bodyBytes:
          replayed.response.bodyBytes === null ? null : Array.from(replayed.response.bodyBytes),
      }).toEqual({ ...item.capsule, bodyBytes: Array.from(item.capsule.bodyBytes) });
    }

    expect(executedIn).toHaveLength(2);
    expect(await state.nativeReceiptCount()).toBe(2);
    expect((await state.mutationTransactions()).receiptWriteTransactionIds).toEqual(executedIn);
  });

  it("preserves exact 201 and 200 statuses through the public HTTP replay path", async () => {
    const submitState = harness();
    const submitted = await submitRequest(submitState.http, "submit-http-replay-key-0001");
    const submittedBody = await readJson(submitted);
    expect(Schema.decodeUnknownSync(ReceiptResource)(submittedBody).approvedAt).toBeNull();
    const submitReplay = await submitRequest(submitState.http, "submit-http-replay-key-0001");
    expect(submitted.status).toBe(201);
    expect(submitReplay.status).toBe(201);
    expect(await submitReplay.json()).toEqual(submittedBody);
    expect(submitReplay.headers.get("location")).toBe(submitted.headers.get("location"));
    expect(submitReplay.headers.get("etag")).toBe(submitted.headers.get("etag"));
    expect(submitted.headers.get("cache-control")).toBe("no-store");
    expect(submitReplay.headers.get("cache-control")).toBe("no-store");
    expect(submitState.commands).toHaveLength(1);

    const actionState = harness({ ownedRows: [pendingReceipt()] });

    const withdrawn = await actionRequest(
      actionState.http,
      `/api/receipts/${receiptId}:withdraw`,
      "withdraw-http-replay-key-0001",
    );

    const withdrawnBody = await readJson(withdrawn);

    const withdrawReplay = await actionRequest(
      actionState.http,
      `/api/receipts/${receiptId}:withdraw`,
      "withdraw-http-replay-key-0001",
    );

    expect(withdrawn.status).toBe(200);
    expect(withdrawReplay.status).toBe(200);
    expect(withdrawn.headers.get("cache-control")).toBe("no-store");
    expect(withdrawReplay.headers.get("cache-control")).toBe("no-store");
    expect(await withdrawReplay.json()).toEqual(withdrawnBody);
    expect(withdrawReplay.headers.get("etag")).toBe(withdrawn.headers.get("etag"));
    expect(actionState.commands).toHaveLength(1);
  });

  it("authorizes and writes in one snapshot, then rejects replay after credential revocation", async () => {
    const state = harness({ ownedRows: [pendingReceipt()] });
    const pathname = `/api/receipts/${receiptId}:withdraw`;
    const idempotencyKey = "withdraw-current-auth-key-0001";

    const accepted = await actionRequest(state.http, pathname, idempotencyKey);
    expect(accepted.status).toBe(200);
    expect(await state.snapshotObservations()).toEqual({
      identitySnapshotIsolations: ["serializable"],
      identitySnapshotVersions: [1],

      committedVersion: 1,
    });
    const committedTransactions = await state.mutationTransactions();
    expect(committedTransactions.commandTransactionIds).toHaveLength(1);
    expect(committedTransactions.receiptWriteTransactionIds).toEqual(
      committedTransactions.commandTransactionIds,
    );
    expect(state.authorizationPrincipalCalls()).toBe(0);

    await state.revokeCredential();
    const revokedReplay = await actionRequest(state.http, pathname, idempotencyKey);
    expect(revokedReplay.status).toBe(401);
    expect(state.commands).toHaveLength(1);
    expect(await state.mutationTransactions()).toEqual(committedTransactions);
    expect(await state.snapshotObservations()).toEqual({
      identitySnapshotIsolations: ["serializable", "serializable"],
      identitySnapshotVersions: [1, 2],

      committedVersion: 2,
    });
  });

  it("denies a matching owner replay after owner authority revocation without another transition", async () => {
    const state = harness({ ownedRows: [pendingReceipt()] });
    const pathname = `/api/receipts/${receiptId}:withdraw`;
    const idempotencyKey = "withdraw-owner-revocation-key-0001";

    const accepted = await actionRequest(state.http, pathname, idempotencyKey);
    expect(accepted.status).toBe(200);
    expect(state.commands).toHaveLength(1);
    expect(state.authorizationChecks()).toEqual(["WithdrawPendingReceipt"]);

    const committedTransactions = await state.mutationTransactions();
    state.revokeAuthority("Owner");
    const revokedReplay = await actionRequest(state.http, pathname, idempotencyKey);
    await expectProblem(revokedReplay, {
      code: "authority.denied",
      title: "Authority denied",
      status: 403,
      detail: "The authenticated principal is not permitted to perform this operation.",
    });
    expect(state.authorizationChecks()).toEqual([
      "WithdrawPendingReceipt",
      "WithdrawPendingReceipt",
    ]);
    expect(state.commands).toHaveLength(1);
    expect(await state.nativeReceiptCount()).toBe(1);
    expect(await state.mutationTransactions()).toEqual(committedTransactions);
  });

  it("denies a matching approval replay after grant revocation without another transition", async () => {
    const state = harness({ approvalRows: [pendingReceipt()] });
    const pathname = `/api/receipts/${receiptId}:approve`;
    const idempotencyKey = "approve-approval-revocation-key-0001";

    const accepted = await actionRequest(state.http, pathname, idempotencyKey);
    expect(accepted.status).toBe(200);
    expect(state.commands).toHaveLength(1);
    expect(state.authorizationChecks()).toEqual(["ApproveReceipt"]);

    const committedTransactions = await state.mutationTransactions();
    state.revokeAuthority("Approval");
    const revokedReplay = await actionRequest(state.http, pathname, idempotencyKey);
    await expectProblem(revokedReplay, {
      code: "authority.denied",
      title: "Authority denied",
      status: 403,
      detail: "The authenticated principal is not permitted to perform this operation.",
    });
    expect(state.authorizationChecks()).toEqual(["ApproveReceipt", "ApproveReceipt"]);
    expect(state.commands).toHaveLength(1);
    expect(await state.nativeReceiptCount()).toBe(1);
    expect(await state.mutationTransactions()).toEqual(committedTransactions);
  });

  it("denies a matching reopening replay after grant revocation without another transition", async () => {
    const state = harness({ approvalRows: [{ ...pendingReceipt(), status: "Rejected" }] });
    const pathname = `/api/receipts/${receiptId}:reopen`;
    const idempotencyKey = "reopen-approval-revocation-key-0001";

    const accepted = await actionRequest(state.http, pathname, idempotencyKey);
    expect(accepted.status).toBe(200);
    expect(state.commands).toHaveLength(1);
    expect(state.authorizationChecks()).toEqual(["ReopenRejectedReceipt"]);

    const committedTransactions = await state.mutationTransactions();
    state.revokeAuthority("Approval");
    const revokedReplay = await actionRequest(state.http, pathname, idempotencyKey);
    await expectProblem(revokedReplay, {
      code: "authority.denied",
      title: "Authority denied",
      status: 403,
      detail: "The authenticated principal is not permitted to perform this operation.",
    });
    expect(state.authorizationChecks()).toEqual(["ReopenRejectedReceipt", "ReopenRejectedReceipt"]);
    expect(state.commands).toHaveLength(1);
    expect(await state.nativeReceiptCount()).toBe(1);
    expect(await state.mutationTransactions()).toEqual(committedTransactions);
  });

  it("registers and executes only the exact frozen action suffixes", async () => {
    const actions = [
      ["withdraw", "WithdrawPendingReceipt"],
      ["approve", "ApproveReceipt"],
      ["reject", "RejectReceipt"],
    ] as const;

    for (const [action, commandTag] of actions) {
      const state = harness({ ownedRows: [pendingReceipt()], approvalRows: [pendingReceipt()] });

      const exact = await actionRequest(
        state.http,
        `/api/receipts/${receiptId}:${action}`,
        `${action}-receipt-idempotency-key`,
      );

      expect(exact.status).toBe(200);
      expect(Schema.decodeUnknownSync(ReceiptResource)(await exact.json()).approvedAt).toBe(
        action === "approve" ? "2026-08-24T12:00:00.000Z" : null,
      );
      expect(state.commands).toHaveLength(1);
      {
        const observed = state.commands[0];
        expect(observed).toHaveProperty("_tag", commandTag);
        expect(observed).toMatchObject({ receiptId, expectedRevision: 0 });
      }

      expect(state.commands[0]?.commandId).toMatch(/^httpv2_[A-Za-z0-9_-]{43}$/u);
    }

    const aliases = harness({ ownedRows: [pendingReceipt()], approvalRows: [pendingReceipt()] });
    expect(
      (await actionRequest(aliases.http, `/api/receipts/${receiptId}/withdraw`, "slash-alias-key"))
        .status,
    ).toBe(404);
    expect(
      (
        await actionRequest(
          aliases.http,
          `/api/admin/receipts/${receiptId}/refund`,
          "admin-alias-key",
        )
      ).status,
    ).toBe(404);
  });

  it("returns RFC 9457 malformed-request problems for manual and schema query failures", async () => {
    for (const pathname of [
      "/api/receipts?status=Pending&status=Approved",
      "/api/receipts?status=Unknown",
      "/api/receipt-approval-queue?status=Pending&unexpected=1",
      "/api/receipt-approval-queue?status=Unknown",
    ]) {
      const response = await request(harness().http, pathname);
      await expectProblem(response, {
        code: "request.malformed",
        title: "Malformed request",
        status: 400,
        detail: "The request is malformed.",
      });
    }
  });

  it("rejects query parameters on semantic receipt commands before execution", async () => {
    const state = harness();

    const response = await actionRequest(
      state.http,
      `/api/receipts/${receiptId}:approve?unexpected=1`,
      "approve-query-rejected-0109",
    );

    await expectProblem(response, {
      code: "request.malformed",
      title: "Malformed request",
      status: 400,
      detail: "The request is malformed.",
    });
    expect(state.commands).toEqual([]);
  });

  it("projects receipt persistence failure through the reopening endpoint's declared problem schema", async () => {
    const state = harness({
      approvalRows: [{ ...pendingReceipt(), status: "Rejected" }],
      commandFailure: new ReceiptPersistenceError({
        operation: "synthetic",
        message: "private SQL details",
      }),
    });

    const response = await actionRequest(
      state.http,
      `/api/receipts/${receiptId}:reopen`,
      "reopen-failed-command-0102",
    );

    expect(response.status, await response.clone().text()).toBe(503);
    const body = Schema.decodeUnknownSync(ReceiptsReopenReceiptProblem)(await response.json());
    expect(body).toMatchObject({ code: "receipts.unavailable" });
    expect(JSON.stringify(body)).not.toContain("private SQL details");
    expect(await state.nativeReceiptCount()).toBe(0);
  });

  it("service-principal queue items expose the same entity condition consumed by person decisions", async () => {
    for (const action of ["approve", "reopen"] as const) {
      const receipt = pendingReceipt({
        status: action === "reopen" ? "Rejected" : "Pending",
        revision: 2,
      });

      const grant = makeServicePrincipalReceiptGrant({
        grantId: "service-queue0102",
        servicePrincipalId: "service0102",
        clientId: "client0102",
        protectedResource: NATIVE_API_PROTECTED_RESOURCE,
        operationId: RECEIPT_APPROVAL_QUEUE_OPERATION,
        capabilityId: "approveReceipt",
        resourceKind: "receipt",
        receiptId,
        startAt: "2026-01-01T00:00:00Z",
        endAt: null,
        revokedAt: null,
        revision: 0,
      });

      const service = harness({
        serviceApproval: {
          servicePrincipalId: ServicePrincipalId.make("service0102"),
          clientId: grant.clientId,
          protectedResource: NATIVE_API_PROTECTED_RESOURCE,
          candidates: [
            {
              grant,
              receipt: {
                ...receipt,
                receiptId: grant.receiptId,
                visualId: Schema.decodeUnknownSync(ReceiptResource.fields.visualId)(visualId),
                ownerPersonId: personId,
              },
            },
          ],
          rules: [],
        },
      });

      const listed = await request(
        service.http,
        `/api/receipt-approval-queue?status=${receipt.status}`,
        { headers: { authorization: `Bearer ${serviceBearer}` } },
        false,
      );

      expect(listed.status).toBe(200);
      const body = Schema.decodeUnknownSync(ReceiptApprovalQueueResponse)(await listed.json());
      const item = body.items[0]!;
      expect(item.etag).toBe(receiptEtag(receiptId, 2));
      const person = harness({ approvalRows: [receipt] });

      const accepted = await request(person.http, `/api/receipts/${receiptId}:${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `${action}-service-queue0102`,
          "if-match": item.etag,
        },
        body: "{}",
      });

      expect(accepted.status).toBe(200);
    }
  });

  it("authenticates scoped service bearers at HTTP ingress without widening person access", async () => {
    const scoped = pendingReceipt();

    const excluded = pendingReceipt({
      receiptId: ReceiptId.make("receipt-other"),
      visualId: ReceiptVisualId.make("visual-other"),
    });

    const grant = makeServicePrincipalReceiptGrant({
      grantId: "service-scoped",
      servicePrincipalId: "service0102",
      clientId: "client0102",
      protectedResource: NATIVE_API_PROTECTED_RESOURCE,
      operationId: RECEIPT_APPROVAL_QUEUE_OPERATION,
      capabilityId: "approveReceipt",
      resourceKind: "receipt",
      receiptId,
      startAt: "2026-01-01T00:00:00Z",
      endAt: null,
      revokedAt: null,
      revision: 0,
    });

    const candidate = (row: ProjectionRow, currentGrant: typeof grant) => ({
      grant: currentGrant,
      receipt: {
        ...row,
        receiptId: Schema.decodeUnknownSync(ReceiptResource.fields.receiptId)(row.receiptId),
        visualId: Schema.decodeUnknownSync(ReceiptResource.fields.visualId)(row.visualId),
        ownerPersonId: personId,
      },
    });

    const serviceApproval = {
      servicePrincipalId: grant.servicePrincipalId,
      clientId: grant.clientId,
      protectedResource: NATIVE_API_PROTECTED_RESOURCE,
      candidates: [
        candidate(scoped, grant),
        candidate(
          excluded,
          makeServicePrincipalReceiptGrant({
            ...grant,
            grantId: "service-revoked",
            receiptId: ReceiptId.make("receipt-other"),
            revokedAt: evaluatedAt,
          }),
        ),
      ],
      rules: [],
    } satisfies ServicePrincipalReceiptGrantAuthority;

    const state = harness({ serviceApproval, approvalRows: [scoped] });
    const bearer = { headers: { authorization: `Bearer ${serviceBearer}` } };
    const listed = await request(state.http, "/api/receipt-approval-queue", bearer, false);
    expect(listed.status).toBe(200);
    expect(await readJson(listed)).toMatchObject({
      totalItems: 1,
      items: [{ receiptId }],
    });
    expect(state.authorizationPrincipalCalls()).toBe(0);
    const serviceOnPersonOnly = await request(state.http, "/api/receipts", bearer, false);
    expect(serviceOnPersonOnly.status).toBe(401);

    const unscoped = harness({
      serviceApproval: { ...serviceApproval, candidates: [serviceApproval.candidates[1]!] },
    });

    const denied = await request(unscoped.http, "/api/receipt-approval-queue", bearer, false);
    expect(denied.status).toBe(403);
    expect(await readJson(denied)).toMatchObject({ error: { tag: "ReceiptScopeDenied" } });
    const mixed = await request(state.http, "/api/receipt-approval-queue", bearer);
    expect(mixed.status).toBe(401);
    state.revokeServiceBearer();
    const revoked = await request(state.http, "/api/receipt-approval-queue", bearer, false);
    expect(revoked.status).toBe(401);
    const person = harness({ approvalRows: [scoped] });
    const human = await request(person.http, "/api/receipt-approval-queue");
    expect(human.status).toBe(200);
    expect(await readJson(human)).toMatchObject({ totalItems: 1, items: [{ receiptId }] });

    const userBearer = await request(
      state.http,
      "/api/receipt-approval-queue",
      { headers: { authorization: `Bearer ${personBearer}` } },
      false,
    );

    expect(userBearer.status).toBe(200);
    expect(await readJson(userBearer)).toMatchObject({ totalItems: 1, items: [{ receiptId }] });
  });

  it("uses the queue's canonical receipt ETag for approval and reopening commands", async () => {
    for (const action of ["approve", "reopen"] as const) {
      const row = pendingReceipt({
        status: action === "reopen" ? "Rejected" : "Pending",
        revision: 2,
      });

      const state = harness({ approvalRows: [row] });
      const listed = await request(state.http, `/api/receipt-approval-queue?status=${row.status}`);
      const body = Schema.decodeUnknownSync(ReceiptApprovalQueueResponse)(await listed.json());
      const item = body.items[0]!;
      expect(item.etag).toBe(receiptEtag(receiptId, 2));

      const accepted = await request(state.http, `/api/receipts/${receiptId}:${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `${action}-from-queue-0102`,
          "if-match": item.etag,
        },
        body: "{}",
      });

      expect(accepted.status).toBe(200);
    }
  });

  it("uses the frozen approval-queue path and passes one canonical authorization instant", async () => {
    const row = pendingReceipt({ revision: 2 });
    const state = harness({ approvalRows: [row] });
    const response = await request(state.http, "/api/receipt-approval-queue?status=Pending");
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      items: [
        {
          receiptId,
          amountOre: 1200,
          status: "Pending",
          revision: 2,
        },
      ],
      totalItems: 1,
    });
    expect(state.approvalQueries).toEqual([
      { personId, authorizationInstant: evaluatedAt, status: "Pending" },
    ]);
    expect((await request(harness().http, "/api/admin/receipts")).status).toBe(404);
  });
});

describe("internal receipt evidence separation", () => {
  const internalPath = `/api/receipt-lifecycle-evidence-records/${receiptId}`;

  const evidence: ReceiptLifecycleEvidenceProjection = {
    receiptId,
    file: {
      fileRef: "file-one",
      objectKey: "committed/file-one",
      contentType: "image/png",
      byteLength: 4,
      sha256: "a".repeat(64),
    },
    settlement: settlementEvidence(),
    outbox: [],
    audit: [],
  };

  it("registers internal.readReceiptEvidence only on the internal Cookie surface", async () => {
    const state = harness({
      evidenceAccessRows: [
        {
          ownerPersonId: personId,
          departmentId: departmentOne,
          status: "Pending",
          revision: 2,
        },
      ],
      evidenceResult: evidence,
    });

    expect((await request(state.http, internalPath)).status).toBe(404);
    expect((await request(state.internalHttp, "/api/receipts")).status).toBe(404);

    const bearerOnly = await request(
      state.internalHttp,
      internalPath,
      { headers: { authorization: "Bearer service-token" } },
      false,
    );

    expect({ status: bearerOnly.status, body: await bearerOnly.json() }).toEqual({
      status: 401,
      body: { error: { tag: "UnauthenticatedActor" } },
    });

    const response = await request(state.internalHttp, internalPath);
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: evidence,
    });
  });

  it("does not read receipt state when the internal Cookie credential is unavailable", async () => {
    const missing = harness({ unauthenticated: true });
    const missingResponse = await request(missing.internalHttp, internalPath);
    expect({ status: missingResponse.status, body: await missingResponse.json() }).toEqual({
      status: 401,
      body: { error: { tag: "UnauthenticatedActor" } },
    });
    expect(missing.evidenceReads).toEqual([]);

    const unavailable = harness({
      identitySnapshotFailure: new IdentityEngineError({
        operation: "resolveSnapshotSession",
        message: "database unavailable",
      }),
    });

    const unavailableResponse = await request(unavailable.internalHttp, internalPath);
    expect({ status: unavailableResponse.status, body: await unavailableResponse.json() }).toEqual({
      status: 503,
      body: { error: { tag: "IdentityEngineError" } },
    });
    expect(unavailable.evidenceReads).toEqual([]);
  });
});

describe("private receipt owner reads", () => {
  it("uses canonical owner authorization before binary storage IO", async () => {
    const owner = harness({ privateFileOwner: personId });

    const response = await owner.http.fetch(
      new Request("http://localhost/api/receipts/private/file", {
        headers: { cookie: "better-auth.session_token=fixture" },
      }),
    );

    expect(response.status).toBe(200);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect({
      contentType: response.headers.get("content-type"),
      contentLength: response.headers.get("content-length"),
      contentDisposition: response.headers.get("content-disposition"),
      contentTypeOptions: response.headers.get("x-content-type-options"),
      cacheControl: response.headers.get("cache-control"),
      vary: response.headers.get("vary"),
    }).toEqual({
      contentType: "application/pdf",
      contentLength: "4",
      contentDisposition: 'inline; filename="receipt.pdf"',
      contentTypeOptions: "nosniff",
      cacheControl: "private, no-store",
      vary: "Origin",
    });
    expect(owner.privateFileReads()).toBe(1);
    const foreign = harness({ privateFileOwner: "different-person" });

    const denied = await foreign.http.fetch(
      new Request("http://localhost/api/receipts/private/file", {
        headers: { cookie: "better-auth.session_token=fixture" },
      }),
    );

    expect(denied.status).toBe(404);
    expect(foreign.privateFileReads()).toBe(0);
  });
  it("does not expose a successful attachment for unavailable private bytes", async () => {
    const owner = harness({ privateFileOwner: personId, privateFileUnavailable: true });

    const response = await owner.http.fetch(
      new Request("http://localhost/api/receipts/private/file", {
        headers: { cookie: "better-auth.session_token=fixture" },
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("content-disposition")).toBeNull();
  });
});

describe("scoped receipt approval file reads", () => {
  it("reads an active scoped terminal receipt in the credential snapshot with exact file headers", async () => {
    const state = harness({
      approvalFileRow: pendingReceipt({
        receiptId: ReceiptId.make("terminal-approval-file"),
        status: "Approved",
      }),
      approvalFileContentType: "application/pdf",
    });

    const response = await request(
      state.http,
      "/api/receipt-approval-queue/terminal-approval-file/file",
    );

    expect(response.status).toBe(200);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect({
      contentType: response.headers.get("content-type"),
      contentLength: response.headers.get("content-length"),
      contentDisposition: response.headers.get("content-disposition"),
      contentTypeOptions: response.headers.get("x-content-type-options"),
      cacheControl: response.headers.get("cache-control"),
      vary: response.headers.get("vary"),
    }).toEqual({
      contentType: "application/pdf",
      contentLength: "4",
      contentDisposition: 'inline; filename="receipt.pdf"',
      contentTypeOptions: "nosniff",
      cacheControl: "private, no-store",
      vary: "Origin",
    });
    expect(state.approvalFileQueries()).toEqual([
      {
        receiptId: ReceiptId.make("terminal-approval-file"),
        personId,
        authorizationInstant: evaluatedAt,
        snapshotIsolation: "repeatable read",
      },
    ]);
    expect((await state.snapshotObservations()).identitySnapshotIsolations).toEqual([
      "repeatable read",
    ]);
    expect(state.privateFileReads()).toBe(1);
    expect(state.commands).toEqual([]);
    expect(await state.nativeReceiptCount()).toBe(0);
  });

  it("does not widen scoped approver access into the owner route", async () => {
    const state = harness({
      approvalFileRow: pendingReceipt({ receiptId: ReceiptId.make("approver-only-file") }),
    });

    const approval = await request(
      state.http,
      "/api/receipt-approval-queue/approver-only-file/file",
    );

    expect(approval.status).toBe(200);

    const owner = await request(state.http, "/api/receipts/approver-only-file/file");
    await expectProblem(owner, {
      code: "resource.not-found",
      title: "Resource not found",
      status: 404,
      detail: "The requested resource was not found.",
    });
    expect(state.privateFileReads()).toBe(1);
  });

  it("keeps credential, absence, foreign scope, and inactive authority failures typed", async () => {
    const unauthenticated = harness({ unauthenticated: true });
    await expectProblem(
      await request(
        unauthenticated.http,
        "/api/receipt-approval-queue/approval-file/file",
        undefined,
        false,
      ),
      {
        code: "credential.missing",
        title: "Credential required",
        status: 401,
        detail: "A credential is required for this operation.",
      },
    );
    expect(unauthenticated.privateFileReads()).toBe(0);

    const invalid = harness({ unauthenticated: true });
    await expectProblem(
      await request(invalid.http, "/api/receipt-approval-queue/approval-file/file"),
      {
        code: "credential.invalid",
        title: "Invalid credential",
        status: 401,
        detail: "The supplied credential is invalid.",
      },
    );
    expect(invalid.privateFileReads()).toBe(0);

    const missing = harness();
    await expectProblem(
      await request(missing.http, "/api/receipt-approval-queue/missing-file/file"),
      {
        code: "resource.not-found",
        title: "Resource not found",
        status: 404,
        detail: "The requested resource was not found.",
      },
    );
    expect(missing.privateFileReads()).toBe(0);

    for (const approvalFileFailure of ["Scope", "Inactive"] as const) {
      const denied = harness({
        approvalFileRow: pendingReceipt({ receiptId: ReceiptId.make("foreign-file") }),
        approvalFileFailure,
      });

      await expectProblem(
        await request(denied.http, "/api/receipt-approval-queue/foreign-file/file"),
        {
          code: "authority.denied",
          title: "Authority denied",
          status: 403,
          detail: "The authenticated principal is not permitted to perform this operation.",
        },
      );
      expect(denied.privateFileReads()).toBe(0);
    }
  });

  it("does not expose file headers when the approved object is unavailable", async () => {
    const state = harness({
      approvalFileRow: pendingReceipt({ receiptId: ReceiptId.make("missing-approval-object") }),
      privateFileUnavailable: true,
    });

    const response = await request(
      state.http,
      "/api/receipt-approval-queue/missing-approval-object/file",
    );

    await expectProblem(response, {
      code: "receipts.unavailable",
      title: "Receipts unavailable",
      status: 503,
      detail: "The receipt service is temporarily unavailable.",
    });
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(state.privateFileReads()).toBe(1);
    expect(state.commands).toEqual([]);
  });

  it("maps malformed stored file metadata to the declared unavailable response", async () => {
    const state = harness({
      approvalFileRow: pendingReceipt({ receiptId: ReceiptId.make("malformed-approval-file") }),
      approvalFileFailure: "Decode",
    });

    const response = await request(
      state.http,
      "/api/receipt-approval-queue/malformed-approval-file/file",
    );

    await expectProblem(response, {
      code: "receipts.unavailable",
      title: "Receipts unavailable",
      status: 503,
      detail: "The receipt service is temporarily unavailable.",
    });
    expect(state.privateFileReads()).toBe(0);
    expect(state.commands).toEqual([]);
  });
});

it("owned list response preserves the canonical private cache contract consumed by the SDK", async () => {
  const owner = harness();

  const response = await owner.http.fetch(
    new Request("http://localhost/api/receipts", {
      headers: { cookie: "better-auth.session_token=fixture" },
    }),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});

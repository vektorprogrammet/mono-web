import { describe, expect, it } from "@effect/vitest";
import {
  type DatabaseOperations,
  Database,
  IdentitySnapshot,
  OAuthCredentialAuthority,
} from "@vektorprogrammet/database";
import {
  AcceptedOAuthServiceCredential,
  CredentialEvidenceRef,
  CredentialMechanismSchema,
  CredentialOutcomeSchema,
  NATIVE_API_PROTECTED_RESOURCE,
  PrincipalSchema,
  RECEIPT_APPROVAL_QUEUE_OPERATION,
  ServicePrincipalGrantAuthority,
  ServicePrincipalId,
  makeServicePrincipalReceiptGrant,
  type ServicePrincipalReceiptGrantAuthority,
} from "@vektorprogrammet/domain/authz";
import {
  Identity,
  IdentityActor,
  IdentityEngineError,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import {
  ApprovalScopeSchema,
  Economy,
  InactiveActor,
  Receipt,
  ReceiptCommandRequestSchema,
  ReceiptDecodeError,
  ReceiptFileSchema,
  ReceiptFileService,
  ReceiptId,
  ReceiptMutationAuthorization,
  ReceiptNotFound,
  ReceiptOutboxDeliveryResult,
  ReceiptOwnerDenied,
  ReceiptPersistenceError,
  ReceiptScopeDenied,
  ReceiptSettlementEvidenceSchema,
  ReceiptVisualId,
  type EconomyOperations,
  type OwnedReceiptProjectionItem,
  type ReceiptApprovalFileReadFailure,
  type ReceiptCommandRequest,
  type ReceiptFailure,
  type ReceiptFile,
  type ReceiptLifecycleEvidenceProjection,
  type ReceiptSettlementCommandRequest,
  type ReceiptSettlementEvidence,
  type ReceiptStatus,
  type ReceiptSubmissionAllocation,
} from "@vektorprogrammet/domain/receipt";
import {
  InternalNativeRpcs,
  NativeRpcs,
  ReceiptListItem,
  ReceiptResource,
  internalNativeRpcPath,
} from "@vektorprogrammet/rpc";
import { IdempotencyKey, isProblem, type Problem, StrongETag } from "@vektorprogrammet/rpc/problem";
import { DateTime, Effect, Layer, Match, Predicate, Schema, Struct } from "effect";
import { Etag, HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { backendTestConfig } from "../../test/config.js";
import { backendDatabase } from "../../test/database.js";
import { deriveHttpIdentity, deriveStrongETag } from "../http-semantics.js";
import { InternalNativeRpcRouterLive } from "../router.js";
import { jsonText } from "../rpc/problem.js";
import {
  NativeHttpCommandOutcome,
  executeNativeHttpCommandPostgres,
} from "../rpc/receipt-transaction.js";
import { makeBackendTestRpc } from "../test/native-rpc.js";
import { TestPlatform } from "../test/platform.js";
import type { ReceiptApiConfig } from "./config.js";
import { RECEIPT_E2E_CONCURRENCY_REQUEST_HEADER } from "./e2e-support.js";
import { ReceiptFileStoreError, type ReceiptFileStore } from "./filesystem.js";

type ProjectionRow = Omit<OwnedReceiptProjectionItem, "settlement">;

type ReceiptAccessRow = {
  readonly ownerPersonId: string;
  readonly departmentId: string;
  readonly status: string;
  readonly revision: number;
};

const personId = PersonId.make("person-receipt-rpc");

const departmentOne = DepartmentId.make("department-one");

const evaluatedAt = "2026-08-24T12:00:00.000Z";

const receiptId = ReceiptId.make("receipt-one");

const visualId = ReceiptVisualId.make("visual-one");

const serviceBearer = "receipt-service-token";

const personBearer = "receipt-person-credential";

const sessionCookie = "better-auth.session_token=receipt-test-session";

const receiptConfig: ReceiptApiConfig = {
  stagingRoot: "/tmp/receipt-rpc-test-staging",
  committedRoot: "/tmp/receipt-rpc-test-committed",
  maxFileBytes: 1024,
  now: () => evaluatedAt,
  nextReceiptId: () => receiptId,
  nextVisualId: () => visualId,
  e2e: {},
};

const config = { ...backendTestConfig, receipt: receiptConfig };

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
  Schema.decodeSync(ReceiptSettlementEvidenceSchema)({
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

const receiptEtag = (id: string, revision: number) =>
  deriveStrongETag({
    representationKind: "ReceiptResource",
    resourceIdentity: id,
    version: revision,
  });

const key = (value: string) => IdempotencyKey.make(value.padEnd(22, "0"));

const pngBytes = new Uint8Array([137, 80, 78, 71]);

const submission = {
  description: "bus ticket",
  amountOre: 1200,
  receiptDate: "2026-08-01",
  file: { contentType: "image/png", bytes: pngBytes },
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
  readonly identitySnapshotFailure?: IdentityEngineError;
  readonly transportHeaders?: Readonly<Record<string, string>>;
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

const fileService = {
  stage: () => Effect.void,
  apply: () => Effect.void,
};

const actorOf = () =>
  IdentityActor.make({
    personId,
    sessionId: "receipt-rpc-session",
    expiresAt: DateTime.makeUnsafe("2031-09-16T12:00:00.000Z"),
  });

/** Serves the internal RPC routes alone, as the internal ingress composes them. */
const makeInternalTestRpc = (
  services: Layer.Layer<
    | Database
    | Economy
    | Identity
    | IdentitySnapshot
    | OAuthCredentialAuthority
    | ServicePrincipalGrantAuthority
    | ReceiptFileService
  >,
) => {
  const routerLayer = InternalNativeRpcRouterLive({ config, now: () => evaluatedAt }).pipe(
    Layer.provideMerge(services),
    Layer.provideMerge(Layer.mergeAll(TestPlatform, Etag.layer)),
  );

  const httpClient = HttpClient.make((request) =>
    Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routerLayer, { disableLogger: true })),
      ({ handler }) =>
        Effect.promise(() =>
          handler(
            new Request(new URL(internalNativeRpcPath, "http://internal-rpc.test"), {
              method: request.method,
              headers: request.headers,
              body: Predicate.isTagged(request.body, "Uint8Array") ? request.body.body : undefined,
            }),
          ),
        ).pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response))),
      ({ dispose }) => Effect.promise(() => dispose()),
    ),
  );

  return RpcClient.make(InternalNativeRpcs).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url: `http://internal-rpc.test${internalNativeRpcPath}` }).pipe(
        Layer.provide(RpcSerialization.layerJson),
        Layer.provide(Layer.succeed(HttpClient.HttpClient)(httpClient)),
      ),
    ),
  );
};

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
  const allocations: Array<ReceiptSubmissionAllocation | undefined> = [];
  const settlementCommands: Array<ReceiptSettlementCommandRequest> = [];
  const settlementReads: Array<{ readonly receiptId: string; readonly personId: string }> = [];

  const approvalQueries: Array<{
    readonly personId: string;
    readonly authorizationInstant: string;
    readonly status: ReceiptStatus | undefined;
  }> = [];

  const evidenceReads: Array<{ readonly receiptId: string; readonly personId: string }> = [];
  const commandTransactionIds: Array<string> = [];
  const identitySnapshotIsolations: Array<string> = [];
  const identitySnapshotVersions: Array<number> = [];
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
    Receipt.make({
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
    const executeReceipt: EconomyOperations["executeReceipt"] = (input, _principal, allocation) =>
      Effect.gen(function* () {
        if (options.commandFailure !== undefined) return yield* options.commandFailure;

        const command = yield* Schema.decodeEffect(ReceiptCommandRequestSchema)(input).pipe(
          Effect.mapError((cause) => ReceiptDecodeError.make({ message: cause.message })),
        );

        commands.push(command);
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
              ? ReceiptScopeDenied.make({
                  receiptId: target.receiptId,
                  departmentId: departmentOne,
                })
              : ReceiptNotFound.make({ receiptId: target.receiptId }),
          );
        }

        if (revokedAuthority === (approval ? "Approval" : "Owner")) {
          return Effect.fail(
            approval
              ? ReceiptScopeDenied.make({
                  receiptId: target.receiptId,
                  departmentId: source.departmentId,
                })
              : ReceiptOwnerDenied.make({
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
          ? Effect.fail(ReceiptNotFound.make({ receiptId: requestedReceiptId }))
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
          return Effect.fail(ReceiptNotFound.make({ receiptId: command.receiptId }));
        }

        settlementCommands.push(command);

        const receipt = Struct.assign(receiptFromProjection(source), {
          revision: source.revision + 1,
        });

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
        Effect.succeed({
          items: (options.settlementRows ?? []).map((row) => {
            if (row.status !== "Approved" || row.approvedAt === null)
              throw new Error("Settlement queue fixtures must be approved");

            return { ...row, status: row.status, approvedAt: row.approvedAt };
          }),
        }),
      readReceiptSettlementForFinance: (requestedReceiptId, queryPersonId) =>
        Effect.suspend(() => {
          settlementReads.push({ receiptId: requestedReceiptId, personId: queryPersonId });
          const evidence = options.settlementEvidence;

          return evidence === undefined || evidence.receiptId !== requestedReceiptId
            ? Effect.fail(ReceiptNotFound.make({ receiptId: requestedReceiptId }))
            : Effect.succeed(evidence);
        }),
      listOwnedReceipts: () =>
        Effect.succeed({
          items: (options.ownedRows ?? []).map((row) => ({
            ...row,
            settlement:
              options.settlementEvidence?.receiptId === row.receiptId
                ? options.settlementEvidence
                : null,
          })),
        }),
      listReceiptsForApproval: (queryPersonId, authorizationInstant, status) => {
        approvalQueries.push({ personId: queryPersonId, authorizationInstant, status });

        return Effect.succeed({ items: options.approvalRows ?? [] });
      },
      readReceiptFileForApproval: (requestedReceiptId, queryPersonId, authorizationInstant) =>
        transactionIsolation.pipe(
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
                  ReceiptDecodeError.make({ message: "malformed stored file metadata" }),
                );
              }

              if (options.approvalFileFailure === "Inactive") {
                return Effect.fail(InactiveActor.make({ personId: queryPersonId }));
              }

              if (options.approvalFileFailure === "Scope") {
                return Effect.fail(
                  ReceiptScopeDenied.make({
                    receiptId: requestedReceiptId,
                    departmentId: source?.departmentId ?? departmentOne,
                  }),
                );
              }

              if (source === undefined || source.receiptId !== requestedReceiptId) {
                return Effect.fail(ReceiptNotFound.make({ receiptId: requestedReceiptId }));
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
          Effect.provideService(Database, sql),
        ),
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
          return yield* IdentitySessionNotFound.make({});

        return actorOf();
      }),
    revokeCurrentSession: () => Effect.die("unexpected session mutation"),
    revokeSession: () => Effect.die("unexpected session mutation"),
    revokeOtherSessions: () => Effect.die("unexpected session mutation"),
    revokeAllSessions: () => Effect.die("unexpected session mutation"),
  });

  const servicePrincipalGrantAuthority = ServicePrincipalGrantAuthority.of({
    readReceiptApprovalCandidates: () =>
      options.serviceApproval === undefined
        ? Effect.die("unexpected service receipt read")
        : Effect.succeed(options.serviceApproval),
    createGrant: () => Effect.die("unexpected grant write"),
    endGrant: () => Effect.die("unexpected grant write"),
    revokeGrant: () => Effect.die("unexpected grant write"),
  });

  // The ingress session check: the transaction re-resolves it through IdentitySnapshot.
  const identity = Identity.of({
    signIn: () => Effect.die("unexpected sign-in"),
    resolveSession: () =>
      options.unauthenticated === true
        ? Effect.fail(IdentitySessionNotFound.make({}))
        : Effect.succeed(actorOf()),
    readCurrentSession: () => Effect.die("unexpected session read"),
    listSessions: () => Effect.die("unexpected session list"),
    revokeCurrentSession: () => Effect.die("unexpected session mutation"),
    revokeSession: () => Effect.die("unexpected session mutation"),
    revokeOtherSessions: () => Effect.die("unexpected session mutation"),
    revokeAllSessions: () => Effect.die("unexpected session mutation"),
    recordSecurityEvent: () => Effect.die("unexpected identity audit"),
    signOut: () => Effect.succeed({ setCookies: [] }),
  } satisfies IdentityOperations);

  const oauthCredentialAuthority = OAuthCredentialAuthority.of({
    resolve: (request, expected) =>
      Effect.sync(() => {
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

        return serviceCredential !== undefined &&
          request.headers.get("authorization") === `Bearer ${serviceBearer}` &&
          expected === "Either" &&
          !revokedServiceBearer
          ? serviceCredential
          : CredentialOutcomeSchema.cases.Rejected.make({ reason: "Revoked" as const });
      }),
    resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
  });

  const services = Layer.mergeAll(
    database.layer,
    economyLayer,
    Layer.succeed(IdentitySnapshot, identitySnapshot),
    Layer.succeed(ServicePrincipalGrantAuthority, servicePrincipalGrantAuthority),
    Layer.succeed(Identity, identity),
    Layer.succeed(OAuthCredentialAuthority, oauthCredentialAuthority),
    Layer.succeed(ReceiptFileService, fileService),
  );

  const receiptFileStore: ReceiptFileStore = {
    service: fileService,
    layer: Layer.succeed(ReceiptFileService, fileService),
    stageBytes: () =>
      Effect.succeed({
        file: {
          fileRef: "staging/file-one",
          objectKey: "committed/file-one",
          contentType: "image/png",
          byteLength: 4,
          sha256: "aa".repeat(32),
        },
        created: true,
      }),
    cleanupStage: () => Effect.void,
    readCommitted: () =>
      Effect.suspend(() => {
        privateFileReads++;

        return options.privateFileUnavailable === true
          ? Effect.fail(
              new ReceiptFileStoreError({
                operation: "readCommitted",
                message: "private bytes unavailable",
              }),
            )
          : Effect.succeed(new Uint8Array([1, 2, 3, 4]));
      }),
  };

  const backend = makeBackendTestRpc({
    config,
    services,
    options: { now: () => evaluatedAt, receiptFileStore },
    transportHeaders: options.transportHeaders,
  });

  const run = <A, E>(effect: Effect.Effect<A, E, Database>): Effect.Effect<A, E> =>
    database.run(effect);

  return {
    client: backend.client,
    internalClient: makeInternalTestRpc(services),
    commands,
    settlementCommands,
    settlementReads: () => settlementReads,
    privateFileReads: () => privateFileReads,
    allocations,
    approvalQueries,
    approvalFileQueries: () => approvalFileQueries,
    evidenceReads,
    nativeReceiptCount: () =>
      run(
        Database.use(
          (sql) =>
            sql<{
              count: number;
            }>`SELECT count(*)::integer AS count FROM public.native_http_idempotency_receipts`,
        ).pipe(Effect.map((rows) => rows[0]!.count)),
      ),
    run,
    currentTransactionId: transactionId,
    mutationTransactions: () =>
      Effect.gen(function* () {
        return {
          commandTransactionIds: [...commandTransactionIds],
          receiptWriteTransactionIds: yield* run(
            Database.use(
              (sql) =>
                sql<{
                  id: string;
                }>`SELECT xmin::text AS id FROM public.native_http_idempotency_receipts ORDER BY committed_at`,
            ).pipe(Effect.map((rows) => rows.map((row) => row.id))),
          ),
        };
      }),
    snapshotObservations: () =>
      Effect.gen(function* () {
        return {
          identitySnapshotIsolations: [...identitySnapshotIsolations],
          identitySnapshotVersions: [...identitySnapshotVersions],
          committedVersion: yield* run(
            Database.use(
              (sql) => sql<{ version: number }>`SELECT version FROM test_credential`,
            ).pipe(Effect.map((rows) => rows[0]!.version)),
          ),
        };
      }),
    revokeCredential: () =>
      run(Database.use((sql) => sql`UPDATE test_credential SET version=2`).pipe(Effect.asVoid)),
    revokeAuthority: (authority: RevocableReceiptAuthority) => {
      revokedAuthority = authority;
    },
    revokeServiceBearer: () => {
      revokedServiceBearer = true;
    },
    authorizationChecks: () => authorizationChecks,
  };
};

/** Runs one call with the person's session cookie. */
const withCookie = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  RpcClient.withHeaders(effect, { cookie: sessionCookie });

/** Runs one call with an OAuth bearer. */
const withBearer = <A, E, R>(effect: Effect.Effect<A, E, R>, bearer: string) =>
  RpcClient.withHeaders(effect, { authorization: `Bearer ${bearer}` });

/** The problem code of a failed call; a transport failure or defect has none. */
const codeOf = (failure: Problem | RpcClientError) =>
  isProblem(failure) ? failure.code : "defect";

const transition = (idempotencyKey: string, revision = 0) => ({
  receiptId,
  idempotencyKey: key(idempotencyKey),
  ifMatch: receiptEtag(receiptId, revision),
});

describe("receipt RPCs", () => {
  it.live("lists only the authenticated person's receipts with projection entity tags", () =>
    Effect.gen(function* () {
      const state = harness({ ownedRows: [pendingReceipt()] });
      const client = yield* state.client;

      const body = yield* withCookie(client["receipts.listReceipts"]({ status: "Pending" }));

      expect(body).toEqual({
        items: [
          yield* Schema.decodeEffect(ReceiptListItem)({
            ...pendingReceipt(),
            amountOre: 1200,
            settlement: null,
            etag: receiptEtag(receiptId, 0),
          }),
        ],
      });
    }),
  );

  it.live("lists only approved unsettled receipts in the settlement queue", () =>
    Effect.gen(function* () {
      const queueRow = pendingReceipt({
        status: "Approved",
        approvedAt: evaluatedAt,
        revision: 2,
      });

      const state = harness({ settlementRows: [queueRow] });
      const client = yield* state.client;

      expect(yield* withCookie(client["receipts.listReceiptsForSettlement"]({}))).toEqual({
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
      });
    }),
  );

  it.live("records immutable settlement evidence with revision and idempotent replay", () =>
    Effect.gen(function* () {
      const queueRow = pendingReceipt({
        status: "Approved",
        approvedAt: evaluatedAt,
        revision: 2,
      });

      const evidence = settlementEvidence({ receiptRevision: 3 });
      const state = harness({ settlementRows: [queueRow], settlementEvidence: evidence });
      const client = yield* state.client;

      const request = {
        expectedRevision: 2,
        externalAuthority: evidence.externalAuthority,
        externalReference: evidence.externalReference,
        settledAt: evidence.settledAt,
      };

      const settle = (body: typeof request) =>
        withCookie(
          client["receipts.settleReceipt"]({ ...transition("settleReceiptKey", 2), request: body }),
        );

      const recorded = yield* settle(request);
      const replay = yield* settle(request);

      const changedReplay = yield* settle({
        ...request,
        externalReference: "changed-external-reference",
      }).pipe(Effect.flip);

      expect(codeOf(changedReplay)).toBe("idempotency.digest-conflict");
      expect(recorded).toMatchObject(evidence);
      expect(replay).toEqual(recorded);
      expect(state.settlementCommands).toHaveLength(1);
    }),
  );

  it.live("reads finance settlement evidence and conceals a missing settlement", () =>
    Effect.gen(function* () {
      const evidence = settlementEvidence();
      const state = harness({ settlementEvidence: evidence });
      const client = yield* state.client;

      const visible = yield* withCookie(
        client["receipts.readReceiptSettlementForFinance"]({ receiptId }),
      );

      const concealed = yield* withCookie(
        client["receipts.readReceiptSettlementForFinance"]({
          receiptId: ReceiptId.make("not-visible"),
        }),
      ).pipe(Effect.flip);

      expect(visible).toMatchObject(evidence);
      expect(state.settlementReads()).toEqual([
        { receiptId, personId },
        { receiptId: ReceiptId.make("not-visible"), personId },
      ]);
      expect(codeOf(concealed)).toBe("receipt.not-found");
    }),
  );

  it.live("answers credential.missing without a credential", () =>
    Effect.gen(function* () {
      const client = yield* harness({ unauthenticated: true }).client;
      const failure = yield* client["receipts.listReceipts"]({}).pipe(Effect.flip);

      expect(isProblem(failure) && [failure.code, failure.status]).toEqual([
        "credential.missing",
        401,
      ]);
    }),
  );

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

  it.live(
    "persists and replays exact 201 and 200 response capsules in transaction-scoped native receipts",
    () =>
      Effect.gen(function* () {
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
          const committed = yield* state.run(executeNativeHttpCommandPostgres(plan));
          const replayed = yield* state.run(executeNativeHttpCommandPostgres(plan));

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
        expect(yield* state.nativeReceiptCount()).toBe(2);
        expect((yield* state.mutationTransactions()).receiptWriteTransactionIds).toEqual(
          executedIn,
        );
      }),
  );

  it.live("replays a submission and a withdrawal with their first answers", () =>
    Effect.gen(function* () {
      const submitState = harness();
      const submitClient = yield* submitState.client;

      const submit = withCookie(
        submitClient["receipts.submitReceipt"]({
          idempotencyKey: key("submitReplayKey"),
          request: submission,
        }),
      );

      const submitted = yield* submit;
      expect(submitted.approvedAt).toBeNull();
      expect(submitted.etag).toBe(receiptEtag(receiptId, 0));
      expect(yield* submit).toEqual(submitted);
      expect(submitState.commands).toHaveLength(1);

      // The receipt stores the HTTP capsule, so a replay across the cutover answers the same.
      const stored = yield* submitState.run(
        Database.use(
          (sql) =>
            sql<{ readonly status: number; readonly headers: unknown }>`
              SELECT status, headers_json AS headers FROM public.native_http_idempotency_receipts
            `,
        ),
      );

      expect(stored).toEqual([
        {
          status: 201,
          headers: {
            "content-type": "application/json",
            etag: receiptEtag(receiptId, 0),
            location: `/api/receipts/${receiptId}`,
          },
        },
      ]);

      const actionState = harness({ ownedRows: [pendingReceipt()] });
      const actionClient = yield* actionState.client;

      const withdraw = withCookie(
        actionClient["receipts.withdrawReceipt"](transition("withdrawReplayKey")),
      );

      const withdrawn = yield* withdraw;
      expect(withdrawn.status).toBe("Withdrawn");
      expect(withdrawn.etag).toBe(receiptEtag(receiptId, 1));
      expect(yield* withdraw).toEqual(withdrawn);
      expect(actionState.commands).toHaveLength(1);
    }),
  );

  it.live("checks the upload bounds of the multipart reader before any transaction", () =>
    Effect.gen(function* () {
      const state = harness({ ownedRows: [pendingReceipt()] });
      const client = yield* state.client;

      const submit = (request: typeof submission, departmentId?: string) =>
        withCookie(
          client["receipts.submitReceipt"]({
            idempotencyKey: key("submitBounds"),
            departmentId,
            request,
          }),
        ).pipe(Effect.flip, Effect.map(codeOf));

      const rejected = [
        yield* submit({ ...submission, file: { contentType: "image/gif", bytes: pngBytes } }),
        yield* submit({
          ...submission,
          file: { contentType: "image/png", bytes: new Uint8Array(1025) },
        }),
        yield* submit({
          ...submission,
          file: { contentType: "image/png", bytes: new Uint8Array() },
        }),
        yield* submit({ ...submission, description: "" }),
        yield* submit({ ...submission, amountOre: 12.5 }),
        yield* submit({ ...submission, amountOre: 0 }),
        yield* submit({ ...submission, receiptDate: "2026-02-30" }),
        yield* submit(submission, " "),
      ];

      const revision = yield* withCookie(
        client["receipts.reviseReceipt"]({ ...transition("reviseNothing"), request: {} }),
      ).pipe(Effect.flip, Effect.map(codeOf));

      expect([...rejected, revision]).toEqual(Array(9).fill("validation.failed"));
      expect(state.authorizationChecks()).toEqual([]);
      expect(yield* state.nativeReceiptCount()).toBe(0);
    }),
  );

  it.live("revises a pending receipt with a replacement file", () =>
    Effect.gen(function* () {
      const state = harness({ ownedRows: [pendingReceipt()] });
      const client = yield* state.client;

      const revised = yield* withCookie(
        client["receipts.reviseReceipt"]({
          ...transition("reviseWithFile"),
          request: { amountOre: 1500, file: { contentType: "application/pdf", bytes: pngBytes } },
        }),
      );

      expect(revised).toMatchObject({ amountOre: 1500, revision: 1 });
      expect(Predicate.isTagged(state.commands[0], "RevisePendingReceipt")).toBe(true);
      expect(state.commands[0]).toMatchObject({
        amountOre: 1500,
        description: "bus ticket",
        file: { fileRef: "staging/file-one" },
      });
    }),
  );

  it.live(
    "authorizes and writes in one snapshot, then rejects replay after credential revocation",
    () =>
      Effect.gen(function* () {
        const state = harness({ ownedRows: [pendingReceipt()] });
        const client = yield* state.client;

        const withdraw = withCookie(
          client["receipts.withdrawReceipt"](transition("withdrawCurrentAuth")),
        );

        yield* withdraw;
        expect(yield* state.snapshotObservations()).toEqual({
          identitySnapshotIsolations: ["serializable"],
          identitySnapshotVersions: [1],
          committedVersion: 1,
        });
        const committedTransactions = yield* state.mutationTransactions();
        expect(committedTransactions.commandTransactionIds).toHaveLength(1);
        expect(committedTransactions.receiptWriteTransactionIds).toEqual(
          committedTransactions.commandTransactionIds,
        );

        yield* state.revokeCredential();
        const revokedReplay = yield* withdraw.pipe(Effect.flip);
        expect(codeOf(revokedReplay)).toBe("credential.invalid");
        expect(state.commands).toHaveLength(1);
        expect(yield* state.mutationTransactions()).toEqual(committedTransactions);
        expect(yield* state.snapshotObservations()).toEqual({
          identitySnapshotIsolations: ["serializable", "serializable"],
          identitySnapshotVersions: [1, 2],
          committedVersion: 2,
        });
      }),
  );

  it.live("denies a matching replay after authority revocation without another transition", () =>
    Effect.gen(function* () {
      const cases = [
        ["withdraw", "Owner", pendingReceipt(), "WithdrawPendingReceipt"],
        ["approve", "Approval", pendingReceipt(), "ApproveReceipt"],
        ["reopen", "Approval", pendingReceipt({ status: "Rejected" }), "ReopenRejectedReceipt"],
      ] as const;

      for (const [action, authority, row, target] of cases) {
        const state = harness(
          authority === "Owner" ? { ownedRows: [row] } : { approvalRows: [row] },
        );

        const client = yield* state.client;
        const payload = transition(`${action}Revocation`);

        const command = withCookie(
          Match.value(action).pipe(
            Match.when("withdraw", () => client["receipts.withdrawReceipt"](payload)),
            Match.when("approve", () => client["receipts.approveReceipt"](payload)),
            Match.when("reopen", () => client["receipts.reopenReceipt"](payload)),
            Match.exhaustive,
          ),
        );

        yield* command;
        expect(state.commands).toHaveLength(1);
        expect(state.authorizationChecks()).toEqual([target]);

        const committedTransactions = yield* state.mutationTransactions();
        state.revokeAuthority(authority);
        const revokedReplay = yield* command.pipe(Effect.flip);

        expect(isProblem(revokedReplay) && [revokedReplay.code, revokedReplay.status]).toEqual([
          "authority.denied",
          403,
        ]);
        expect(state.authorizationChecks()).toEqual([target, target]);
        expect(state.commands).toHaveLength(1);
        expect(yield* state.nativeReceiptCount()).toBe(1);
        expect(yield* state.mutationTransactions()).toEqual(committedTransactions);
      }
    }),
  );

  it.live("executes each transition as its own command", () =>
    Effect.gen(function* () {
      const actions = [
        ["withdraw", "WithdrawPendingReceipt"],
        ["approve", "ApproveReceipt"],
        ["reject", "RejectReceipt"],
      ] as const;

      for (const [action, commandTag] of actions) {
        const state = harness({ ownedRows: [pendingReceipt()], approvalRows: [pendingReceipt()] });
        const client = yield* state.client;
        const payload = transition(`${action}ReceiptKey`);

        const answered = yield* withCookie(
          Match.value(action).pipe(
            Match.when("withdraw", () => client["receipts.withdrawReceipt"](payload)),
            Match.when("approve", () => client["receipts.approveReceipt"](payload)),
            Match.when("reject", () => client["receipts.rejectReceipt"](payload)),
            Match.exhaustive,
          ),
        );

        expect(answered.approvedAt).toBe(action === "approve" ? "2026-08-24T12:00:00.000Z" : null);
        expect(state.commands).toHaveLength(1);
        expect(state.commands[0]).toMatchObject({
          _tag: commandTag,
          receiptId,
          expectedRevision: 0,
        });
        expect(state.commands[0]?.commandId).toMatch(/^httpv2_[A-Za-z0-9_-]{43}$/u);
      }

      // The internal evidence RPC is not part of the external contract.
      expect(NativeRpcs.requests.has("receipts.readReceiptEvidence")).toBe(false);
      expect(InternalNativeRpcs.requests.has("receipts.readReceiptEvidence")).toBe(true);
    }),
  );

  it.live("keeps the HTTP route as the normalized target of each command identity", () =>
    Effect.gen(function* () {
      const state = harness({ approvalRows: [pendingReceipt()] });
      const client = yield* state.client;

      yield* withCookie(client["receipts.approveReceipt"](transition("approveTargetKey")));

      const derived = deriveHttpIdentity({
        credentialSubject: `Person:${personId}`,
        qualifiedOperationId: "receipts.approveReceipt",
        normalizedTarget: `/api/receipts/${receiptId}/approve`,
        idempotencyKey: key("approveTargetKey"),
      });

      expect(state.commands[0]?.commandId).toBe(derived.commandId);
    }),
  );

  it.live("answers a stale If-Match with precondition.failed before any transition", () =>
    Effect.gen(function* () {
      const state = harness({ approvalRows: [pendingReceipt({ revision: 1 })] });
      const client = yield* state.client;

      const stale = yield* withCookie(
        client["receipts.approveReceipt"](transition("approveStaleKey", 0)),
      ).pipe(Effect.flip);

      expect(codeOf(stale)).toBe("precondition.failed");
      expect(state.commands).toEqual([]);
    }),
  );

  it.live("answers receipts.unavailable for a failed reopening without its private detail", () =>
    Effect.gen(function* () {
      const state = harness({
        approvalRows: [pendingReceipt({ status: "Rejected" })],
        commandFailure: ReceiptPersistenceError.make({
          operation: "synthetic",
          message: "private SQL details",
        }),
      });

      const client = yield* state.client;

      const failure = yield* withCookie(
        client["receipts.reopenReceipt"](transition("reopenFailedCommand")),
      ).pipe(Effect.flip);

      expect(codeOf(failure)).toBe("receipts.unavailable");
      expect(yield* jsonText(failure)).not.toContain("private SQL details");
      expect(yield* state.nativeReceiptCount()).toBe(0);
    }),
  );

  it.live("routes an E2E probe header of the HTTP request to the approval barrier", () =>
    Effect.gen(function* () {
      // A probe that names another lane is a defect of the driver, answered internal.error.
      const state = harness({
        approvalRows: [pendingReceipt()],
        transportHeaders: { [RECEIPT_E2E_CONCURRENCY_REQUEST_HEADER]: "reject" },
      });

      const client = yield* state.client;

      const failure = yield* withCookie(
        client["receipts.approveReceipt"](transition("approveProbeKey")),
      ).pipe(Effect.flip);

      expect(codeOf(failure)).toBe("internal.error");
      expect(state.commands).toEqual([]);
    }),
  );

  it.live(
    "uses the queue's entity tag for approval and reopening, from a person or a service",
    () =>
      Effect.gen(function* () {
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
                    visualId: yield* Schema.decodeEffect(ReceiptResource.fields.visualId)(visualId),
                    ownerPersonId: personId,
                  },
                },
              ],
              rules: [],
            },
          });

          const serviceClient = yield* service.client;

          const serviceQueue = yield* withBearer(
            serviceClient["receipts.listReceiptsForApproval"]({ status: receipt.status }),
            serviceBearer,
          );

          expect(serviceQueue.items[0]?.etag).toBe(receiptEtag(receiptId, 2));

          const person = harness({ approvalRows: [receipt] });
          const personClient = yield* person.client;

          const personQueue = yield* withCookie(
            personClient["receipts.listReceiptsForApproval"]({ status: receipt.status }),
          );

          const etag = personQueue.items[0]?.etag ?? StrongETag.make('"missing"');
          expect(etag).toBe(receiptEtag(receiptId, 2));

          const payload = {
            receiptId,
            idempotencyKey: key(`${action}FromQueue`),
            ifMatch: etag,
          };

          yield* withCookie(
            action === "approve"
              ? personClient["receipts.approveReceipt"](payload)
              : personClient["receipts.reopenReceipt"](payload),
          );

          expect(person.commands).toHaveLength(1);
        }
      }),
  );

  it.live("authenticates scoped service bearers without widening person access", () =>
    Effect.gen(function* () {
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
          receiptId: Schema.decodeSync(ReceiptResource.fields.receiptId)(row.receiptId),
          visualId: Schema.decodeSync(ReceiptResource.fields.visualId)(row.visualId),
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
      const client = yield* state.client;
      const queue = client["receipts.listReceiptsForApproval"]({});

      expect(yield* withBearer(queue, serviceBearer)).toMatchObject({
        items: [{ receiptId }],
      });
      expect(state.approvalQueries).toEqual([]);

      const serviceOnPersonOnly = yield* withBearer(
        client["receipts.listReceipts"]({}),
        serviceBearer,
      ).pipe(Effect.flip);

      expect(codeOf(serviceOnPersonOnly)).toBe("credential.invalid");

      const unscoped = harness({
        serviceApproval: { ...serviceApproval, candidates: [serviceApproval.candidates[1]!] },
      });

      const unscopedClient = yield* unscoped.client;

      const denied = yield* withBearer(
        unscopedClient["receipts.listReceiptsForApproval"]({}),
        serviceBearer,
      ).pipe(Effect.flip);

      expect(codeOf(denied)).toBe("authority.denied");

      const mixed = yield* RpcClient.withHeaders(queue, {
        cookie: sessionCookie,
        authorization: `Bearer ${serviceBearer}`,
      }).pipe(Effect.flip);

      expect(codeOf(mixed)).toBe("credential.invalid");
      state.revokeServiceBearer();
      expect(codeOf(yield* withBearer(queue, serviceBearer).pipe(Effect.flip))).toBe(
        "credential.invalid",
      );

      const person = harness({ approvalRows: [scoped] });
      const personClient = yield* person.client;

      expect(yield* withCookie(personClient["receipts.listReceiptsForApproval"]({}))).toMatchObject(
        { items: [{ receiptId }] },
      );

      expect(yield* withBearer(queue, personBearer)).toMatchObject({ items: [{ receiptId }] });
    }),
  );

  it.live("passes one canonical authorization instant to the approval queue", () =>
    Effect.gen(function* () {
      const row = pendingReceipt({ revision: 2 });
      const state = harness({ approvalRows: [row] });
      const client = yield* state.client;

      const body = yield* withCookie(
        client["receipts.listReceiptsForApproval"]({ status: "Pending" }),
      );

      expect(body).toMatchObject({
        items: [{ receiptId, amountOre: 1200, status: "Pending", revision: 2 }],
      });
      expect(state.approvalQueries).toEqual([
        { personId, authorizationInstant: evaluatedAt, status: "Pending" },
      ]);
    }),
  );
});

describe("internal receipt evidence", () => {
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

  it.live("reads evidence with the Cookie credential on the internal surface only", () =>
    Effect.gen(function* () {
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

      const client = yield* state.internalClient;

      const bearerOnly = yield* withBearer(
        client["receipts.readReceiptEvidence"]({ receiptId }),
        "service-token",
      ).pipe(Effect.flip);

      expect(codeOf(bearerOnly)).toBe("credential.invalid");

      expect(yield* withCookie(client["receipts.readReceiptEvidence"]({ receiptId }))).toEqual(
        evidence,
      );
    }),
  );

  it.live("does not read receipt state when the internal Cookie credential is unavailable", () =>
    Effect.gen(function* () {
      const missing = harness({ unauthenticated: true });
      const missingClient = yield* missing.internalClient;

      const missingFailure = yield* withCookie(
        missingClient["receipts.readReceiptEvidence"]({ receiptId }),
      ).pipe(Effect.flip);

      expect(codeOf(missingFailure)).toBe("credential.invalid");
      expect(missing.evidenceReads).toEqual([]);

      const unavailable = harness({
        identitySnapshotFailure: IdentityEngineError.make({
          operation: "resolveSnapshotSession",
          message: "database unavailable",
        }),
      });

      const unavailableClient = yield* unavailable.internalClient;

      const unavailableFailure = yield* withCookie(
        unavailableClient["receipts.readReceiptEvidence"]({ receiptId }),
      ).pipe(Effect.flip);

      expect(codeOf(unavailableFailure)).toBe("receipts.unavailable");
      expect(unavailable.evidenceReads).toEqual([]);
    }),
  );
});

describe("private receipt owner reads", () => {
  it.live("uses canonical owner authorization before binary storage IO", () =>
    Effect.gen(function* () {
      const owner = harness({ privateFileOwner: personId });
      const ownerClient = yield* owner.client;
      const privateId = ReceiptId.make("private");

      const file = yield* withCookie(
        ownerClient["receipts.readReceiptFile"]({ receiptId: privateId }),
      );

      expect({ contentType: file.contentType, bytes: [...file.bytes] }).toEqual({
        contentType: "application/pdf",
        bytes: [1, 2, 3, 4],
      });
      expect(owner.privateFileReads()).toBe(1);

      const foreign = harness({ privateFileOwner: "different-person" });
      const foreignClient = yield* foreign.client;

      const denied = yield* withCookie(
        foreignClient["receipts.readReceiptFile"]({ receiptId: privateId }),
      ).pipe(Effect.flip);

      expect(codeOf(denied)).toBe("resource.not-found");
      expect(foreign.privateFileReads()).toBe(0);
    }),
  );

  it.live("answers receipts.unavailable for unavailable private bytes", () =>
    Effect.gen(function* () {
      const owner = harness({ privateFileOwner: personId, privateFileUnavailable: true });
      const client = yield* owner.client;

      const failure = yield* withCookie(
        client["receipts.readReceiptFile"]({ receiptId: ReceiptId.make("private") }),
      ).pipe(Effect.flip);

      expect(codeOf(failure)).toBe("receipts.unavailable");
    }),
  );
});

describe("scoped receipt approval file reads", () => {
  it.live("reads an active scoped terminal receipt in the credential snapshot", () =>
    Effect.gen(function* () {
      const fileId = ReceiptId.make("terminal-approval-file");

      const state = harness({
        approvalFileRow: pendingReceipt({ receiptId: fileId, status: "Approved" }),
        approvalFileContentType: "application/pdf",
      });

      const client = yield* state.client;

      const file = yield* withCookie(
        client["receipts.readReceiptFileForApproval"]({ receiptId: fileId }),
      );

      expect({ contentType: file.contentType, bytes: [...file.bytes] }).toEqual({
        contentType: "application/pdf",
        bytes: [1, 2, 3, 4],
      });
      expect(state.approvalFileQueries()).toEqual([
        {
          receiptId: fileId,
          personId,
          authorizationInstant: evaluatedAt,
          snapshotIsolation: "repeatable read",
        },
      ]);
      expect((yield* state.snapshotObservations()).identitySnapshotIsolations).toEqual([
        "repeatable read",
      ]);
      expect(state.privateFileReads()).toBe(1);
      expect(state.commands).toEqual([]);
      expect(yield* state.nativeReceiptCount()).toBe(0);
    }),
  );

  it.live("does not widen scoped approver access into the owner read", () =>
    Effect.gen(function* () {
      const fileId = ReceiptId.make("approver-only-file");
      const state = harness({ approvalFileRow: pendingReceipt({ receiptId: fileId }) });
      const client = yield* state.client;

      yield* withCookie(client["receipts.readReceiptFileForApproval"]({ receiptId: fileId }));

      const owner = yield* withCookie(
        client["receipts.readReceiptFile"]({ receiptId: fileId }),
      ).pipe(Effect.flip);

      expect(codeOf(owner)).toBe("resource.not-found");
      expect(state.privateFileReads()).toBe(1);
    }),
  );

  it.live("keeps credential, absence, foreign scope, and inactive authority failures typed", () =>
    Effect.gen(function* () {
      const read = (state: ReturnType<typeof harness>, id: string, cookie: boolean) =>
        Effect.gen(function* () {
          const client = yield* state.client;

          const call = client["receipts.readReceiptFileForApproval"]({
            receiptId: ReceiptId.make(id),
          });

          return codeOf(yield* (cookie ? withCookie(call) : call).pipe(Effect.flip));
        });

      const unauthenticated = harness({ unauthenticated: true });
      expect(yield* read(unauthenticated, "approval-file", false)).toBe("credential.missing");
      expect(unauthenticated.privateFileReads()).toBe(0);

      const invalid = harness({ unauthenticated: true });
      expect(yield* read(invalid, "approval-file", true)).toBe("credential.invalid");
      expect(invalid.privateFileReads()).toBe(0);

      const missing = harness();
      expect(yield* read(missing, "missing-file", true)).toBe("resource.not-found");
      expect(missing.privateFileReads()).toBe(0);

      for (const approvalFileFailure of ["Scope", "Inactive"] as const) {
        const denied = harness({
          approvalFileRow: pendingReceipt({ receiptId: ReceiptId.make("foreign-file") }),
          approvalFileFailure,
        });

        expect(yield* read(denied, "foreign-file", true)).toBe("authority.denied");
        expect(denied.privateFileReads()).toBe(0);
      }
    }),
  );

  it.live("answers receipts.unavailable when the object or its stored metadata is unreadable", () =>
    Effect.gen(function* () {
      const unavailable = harness({
        approvalFileRow: pendingReceipt({ receiptId: ReceiptId.make("missing-object") }),
        privateFileUnavailable: true,
      });

      const unavailableClient = yield* unavailable.client;

      const objectFailure = yield* withCookie(
        unavailableClient["receipts.readReceiptFileForApproval"]({
          receiptId: ReceiptId.make("missing-object"),
        }),
      ).pipe(Effect.flip);

      expect(codeOf(objectFailure)).toBe("receipts.unavailable");
      expect(unavailable.privateFileReads()).toBe(1);

      const malformed = harness({
        approvalFileRow: pendingReceipt({ receiptId: ReceiptId.make("malformed-file") }),
        approvalFileFailure: "Decode",
      });

      const malformedClient = yield* malformed.client;

      const metadataFailure = yield* withCookie(
        malformedClient["receipts.readReceiptFileForApproval"]({
          receiptId: ReceiptId.make("malformed-file"),
        }),
      ).pipe(Effect.flip);

      expect(codeOf(metadataFailure)).toBe("receipts.unavailable");
      expect(malformed.privateFileReads()).toBe(0);
      expect(malformed.commands).toEqual([]);
    }),
  );
});

import {
  AuthorizationInstant,
  CredentialEvidenceRef,
  ServicePrincipalId,
  ServicePrincipalGrantAuthority,
  NATIVE_API_PROTECTED_RESOURCE,
  RECEIPT_APPROVAL_QUEUE_OPERATION,
  makeServicePrincipalReceiptGrant,
  type AcceptedOAuthServiceCredential,
  type ServicePrincipalReceiptGrantAuthority,
} from "@vektorprogrammet/domain/authz";
import {
  Database,
  IdentitySnapshot,
  OAuthCredentialAuthority,
  type DatabaseShape,
} from "@vektorprogrammet/database";
import {
  ReceiptResource,
  ReceiptListItem,
  ReceiptsReopenReceiptProblem,
} from "@vektorprogrammet/http-api";
import { executeNativeHttpCommandPostgres } from "../http-api/receipt-transaction.js";
import {
  Identity,
  IdentityActor,
  IdentityEngineError,
  IdentitySessionNotFound,
  type IdentityShape,
} from "@vektorprogrammet/domain/identity";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import {
  Economy,
  InactiveActor,
  ReceiptDecodeError,
  ReceiptFileService,
  ReceiptNotFound,
  ReceiptPersistenceError,
  ReceiptOwnerDenied,
  ReceiptScopeDenied,
  UnauthenticatedActor,
  type EconomyShape,
  type Receipt,
  type ReceiptApprovalFileReadFailure,
  type ReceiptCommandPrincipal,
  type ReceiptFailure,
  type ReceiptFile,
  type ReceiptMutationAuthorization,
  type ReceiptStatus,
  type ReceiptSubmissionAllocation,
} from "@vektorprogrammet/domain/receipt";
import { DateTime, Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { deriveHttpIdentity, deriveStrongETag } from "../http-semantics.js";
import {
  makeInternalReceiptTestHttp,
  makeReceiptTestHttp as makeReceiptApiHttp,
} from "../test/native-http.js";
import { runTestPromise } from "../../test/runtime.js";
import type { ReceiptApiConfig } from "./config.js";
import type { ReceiptFileStore } from "./filesystem.js";
import type { ReceiptApiHttpOptions } from "./http.js";

type ReceiptApiHttp = { readonly fetch: (request: Request) => Promise<Response> };
type ProjectionRow = {
  readonly receiptId: string;
  readonly visualId: string;
  readonly ownerPersonId: string;
  readonly departmentId: DepartmentId;
  readonly amountOre: string;
  readonly currency: "NOK";
  readonly description: string;
  readonly receiptDate: string;
  readonly submittedAt: string;
  readonly status: ReceiptStatus;
  readonly revision: number;
};
type NativeReceiptRow = {
  readonly requestSha256: string;
  readonly operationId: string;
  readonly state: "Complete";
  readonly status: number;
  readonly mediaType: string | null;
  readonly bodyBytes: Uint8Array | null;
  readonly headers: unknown;
};
type ReceiptAccessRow = {
  readonly ownerPersonId: string;
  readonly departmentId: string;
  readonly status: string;
  readonly revision: number;
};

const personId = PersonId.make("person-receipt-http");
const departmentOne = DepartmentId.make("department-one");
const evaluatedAt = "2026-08-24T12:00:00.000Z";
const receiptId = "receipt-one";
const visualId = "visual-one";

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
  status: "Pending",
  revision: 0,
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
  readonly evidenceAccessRows?: ReadonlyArray<ReceiptAccessRow>;
  readonly evidenceResult?: unknown;
  readonly revokeSessionAfterSnapshotRead?: boolean;
  readonly initialCommittedVersion?: number;
  readonly identitySnapshotFailure?: IdentityEngineError;
}
type RevocableReceiptAuthority = "Owner" | "Approval";

const harness = (options: HarnessOptions = {}) => {
  const serviceCredential: AcceptedOAuthServiceCredential | undefined =
    options.serviceApproval === undefined
      ? undefined
      : {
          _tag: "Accepted",
          mechanism: { _tag: "OAuthServiceBearer" },
          principal: {
            _tag: "ServicePrincipal",
            servicePrincipalId: options.serviceApproval.servicePrincipalId,
          },
          evidenceRef: CredentialEvidenceRef.make(
            "oauth:ServicePrincipal:receipt-unit:client:1970000000",
          ),
        };
  let privateFileReads = 0;
  const approvalFileQueries: Array<{
    readonly receiptId: string;
    readonly personId: string;
    readonly authorizationInstant: string;
    readonly snapshotDepth: number;
  }> = [];
  const commands: Array<Record<string, unknown>> = [];
  const principals: Array<ReceiptCommandPrincipal> = [];
  const allocations: Array<ReceiptSubmissionAllocation | undefined> = [];
  const approvalQueries: Array<{
    readonly personId: typeof personId;
    readonly authorizationInstant: string;
    readonly status: ReceiptStatus | undefined;
  }> = [];
  const evidenceReads: Array<{ readonly receiptId: string; readonly personId: string }> = [];
  const nativeReceipts = new Map<string, NativeReceiptRow>();
  const commandTransactionIds: Array<number> = [];
  const receiptWriteTransactionIds: Array<number> = [];
  const evidenceContextSnapshotDepths: Array<number> = [];
  const evidenceProjectionSnapshotDepths: Array<number> = [];
  const identitySnapshotDepths: Array<number> = [];
  const identitySnapshotVersions: Array<number> = [];
  const receiptContextVersions: Array<number> = [];
  let evidenceContextReads = 0;
  let committedVersion = options.initialCommittedVersion ?? 1;
  let snapshotVersion: number | null = null;
  let snapshotDepth = 0;
  let nextTransactionId = 0;
  let currentTransactionId = 0;
  let authorizationPrincipalCalls = 0;
  const authorizationChecks: Array<string> = [];
  let revokedAuthority: RevocableReceiptAuthority | undefined;

  const sourceReceipt = (command: Record<string, unknown>): ProjectionRow => {
    if (command._tag === "SubmitReceipt") {
      return pendingReceipt({
        receiptId: String(allocations.at(-1)?.receiptId ?? receiptId),
        visualId: String(allocations.at(-1)?.visualId ?? visualId),
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
    ({
      ...row,
      amountOre: Number(row.amountOre),
      refundDate: row.status === "Refunded" ? "2026-08-24T12:00:00.000Z" : null,
      paymentAccountCiphertext: "encrypted",
      file: {
        fileRef: "staging/file-one",
        objectKey: "committed/file-one",
        contentType: "image/png",
        byteLength: 4,
        sha256: "aa".repeat(32),
      },
    }) as Receipt;

  const executeReceipt: EconomyShape["executeReceipt"] = (input, principal, allocation) =>
    Effect.gen(function* () {
      if (options.commandFailure !== undefined) return yield* options.commandFailure;
      const command = input as unknown as Record<string, unknown>;
      commands.push(command);
      principals.push(principal);
      allocations.push(allocation);
      commandTransactionIds.push(currentTransactionId);
      const source = sourceReceipt(command);
      const nextRevision =
        command._tag === "SubmitReceipt" ? 0 : Number(command.expectedRevision) + 1;
      const status =
        command._tag === "WithdrawPendingReceipt"
          ? "Withdrawn"
          : command._tag === "RefundReceipt"
            ? "Refunded"
            : command._tag === "RejectReceipt"
              ? "Rejected"
              : "Pending";
      const receipt = {
        ...source,
        description: String(command.description ?? source.description),
        amountOre: String(command.amountOre ?? source.amountOre),
        receiptDate: String(command.receiptDate ?? source.receiptDate),
        status,
        revision: nextRevision,
        refundDate: status === "Refunded" ? "2026-08-24T12:00:00.000Z" : null,
        paymentAccountCiphertext: "encrypted",
        file: {
          fileRef: "staging/file-one",
          objectKey: "committed/file-one",
          contentType: "image/png",
          byteLength: 4,
          sha256: "aa".repeat(32),
        },
      };
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
      } as never;
    });

  const authorizeReceiptMutation: EconomyShape["authorizeReceiptMutation"] = (target, principal) =>
    Effect.suspend<ReceiptMutationAuthorization, ReceiptFailure, never>(() => {
      authorizationChecks.push(target._tag);
      if (target._tag === "SubmitReceipt") {
        return Effect.succeed({
          _tag: target._tag,
          principal,
          actor: {
            personId: principal.personId,
            departmentId: target.departmentId ?? departmentOne,
            active: true,
            approvalScope: { _tag: "None" },
          },
          departmentId: target.departmentId ?? departmentOne,
          paymentAccountCiphertext: "encrypted",
        });
      }
      const approval =
        target._tag === "RefundReceipt" ||
        target._tag === "RejectReceipt" ||
        target._tag === "ReopenRejectedReceipt";
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
      const authorization: ReceiptMutationAuthorization = {
        _tag: target._tag,
        principal,
        actor: {
          personId: principal.personId,
          departmentId: source.departmentId,
          active: true,
          approvalScope: approval
            ? { _tag: "Department", departmentId: source.departmentId }
            : { _tag: "None" },
        },
        current: receiptFromProjection(source),
      };
      return Effect.succeed(authorization);
    });

  const executeAuthorizedReceipt: EconomyShape["executeAuthorizedReceipt"] = (
    input,
    authorization,
    allocation,
  ) => executeReceipt(input, authorization.principal, allocation);

  const economy: EconomyShape = {
    executeReceipt,
    authorizeReceiptMutation,
    executeAuthorizedReceipt,
    listOwnedReceipts: () => Effect.succeed((options.ownedRows ?? []) as never),
    listReceiptsForApproval: (queryPersonId, authorizationInstant, status) => {
      approvalQueries.push({ personId: queryPersonId, authorizationInstant, status });
      return Effect.succeed((options.approvalRows ?? []) as never);
    },
    readReceiptFileForApproval: (requestedReceiptId, queryPersonId, authorizationInstant) =>
      Effect.suspend<ReceiptFile, ReceiptApprovalFileReadFailure, never>(() => {
        approvalFileQueries.push({
          receiptId: requestedReceiptId,
          personId: queryPersonId,
          authorizationInstant,
          snapshotDepth,
        });
        const source = options.approvalFileRow;
        if (options.approvalFileFailure === "Decode") {
          return Effect.fail(new ReceiptDecodeError({ message: "malformed stored file metadata" }));
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
        } as never);
      }),
    readReceiptLifecycleEvidence: (id, ownerPersonId) =>
      Effect.sync(() => {
        evidenceReads.push({ receiptId: id, personId: ownerPersonId });
        evidenceProjectionSnapshotDepths.push(snapshotDepth);
        return options.evidenceResult as never;
      }),
    receiptStatusTotals: Effect.succeed([]),
    listStaleOutboxClaims: () => Effect.succeed([]),
    recoverStaleOutboxClaim: () => Effect.succeed(0),
    deliverNextOutboxEffect: () => Effect.succeed({ _tag: "Idle" }),
  };

  const sql = Object.assign(
    ((strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
      const statement = strings.join(" ");
      if (statement.includes("SET TRANSACTION ISOLATION LEVEL")) return Effect.void;
      if (statement.includes("SELECT pg_try_advisory_xact_lock")) {
        return Effect.succeed([{ acquired: true }]);
      }
      if (statement.includes("UPDATE public.native_http_idempotency_receipts")) {
        return Effect.succeed([]);
      }
      if (statement.includes("FROM public.native_http_idempotency_receipts")) {
        const stored = nativeReceipts.get(String(values[0]));
        return Effect.succeed(stored === undefined ? [] : [stored]);
      }
      if (statement.includes("INSERT INTO public.native_http_idempotency_receipts")) {
        nativeReceipts.set(String(values[0]), {
          requestSha256: String(values[1]),
          operationId: String(values[2]),
          state: "Complete",
          status: Number(values[3]),
          mediaType: values[4] as string | null,
          bodyBytes: values[5] as Uint8Array | null,
          headers: values[6],
        });
        receiptWriteTransactionIds.push(currentTransactionId);
        return Effect.succeed([]);
      }
      if (statement.includes("file_ref AS") && statement.includes("owner_person_id =")) {
        if (options.privateFileOwner !== values[1]) return Effect.succeed([]);
        return Effect.succeed([
          {
            departmentId: departmentOne,
            revision: 1,
            status: "Refunded",
            fileRef: "staging/private",
            objectKey: "committed/private",
            contentType: "application/pdf",
            byteLength: 4,
            sha256: "a".repeat(64),
          },
        ]);
      }
      if (statement.includes("FROM public.economy_receipts")) {
        evidenceContextReads += 1;
        evidenceContextSnapshotDepths.push(snapshotDepth);
        const observedVersion = snapshotVersion ?? committedVersion;
        receiptContextVersions.push(observedVersion);
        const rows = options.evidenceAccessRows ?? [];
        return Effect.succeed(
          options.revokeSessionAfterSnapshotRead === true && observedVersion === 2
            ? rows.map((row) => ({ ...row, ownerPersonId: "owner-after-revocation" }))
            : rows,
        );
      }
      return Effect.succeed([]);
    }) as unknown as DatabaseShape,
    {
      health: Effect.void,
      json: (value: unknown) => value,
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.suspend(() => {
          const previousTransactionId = currentTransactionId;
          const previousSnapshotVersion = snapshotVersion;
          snapshotDepth += 1;
          currentTransactionId = ++nextTransactionId;
          snapshotVersion = committedVersion;
          return effect.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                snapshotVersion = previousSnapshotVersion;
                currentTransactionId = previousTransactionId;
                snapshotDepth -= 1;
              }),
            ),
          );
        }),
    },
  ) as unknown as DatabaseShape;

  const identitySnapshot = IdentitySnapshot.of({
    resolveSession: (cookieHeader) =>
      Effect.suspend<IdentityActor, IdentityEngineError | IdentitySessionNotFound, never>(() => {
        identitySnapshotDepths.push(snapshotDepth);
        const observedVersion = snapshotVersion ?? committedVersion;
        identitySnapshotVersions.push(observedVersion);
        if (options.identitySnapshotFailure !== undefined) {
          return Effect.fail(options.identitySnapshotFailure);
        }
        if (
          cookieHeader === undefined ||
          options.unauthenticated === true ||
          observedVersion === 2
        ) {
          return Effect.fail(new IdentitySessionNotFound());
        }
        if (options.revokeSessionAfterSnapshotRead === true) committedVersion = 2;
        return Effect.succeed(
          new IdentityActor({
            personId,
            sessionId: "receipt-http-session",
            expiresAt: DateTime.makeUnsafe(new Date("2031-09-16T12:00:00.000Z")),
          }),
        );
      }),
    revokeCurrentSession: () => Effect.die("unexpected receipt-test session mutation"),
    revokeSession: () => Effect.die("unexpected receipt-test session mutation"),
    revokeOtherSessions: () => Effect.die("unexpected receipt-test session mutation"),
    revokeAllSessions: () => Effect.die("unexpected receipt-test session mutation"),
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
  } satisfies IdentityShape);
  const oauthCredentialAuthority = OAuthCredentialAuthority.of({
    resolve: () => Promise.reject(new Error("unexpected OAuth credential resolution")),
    resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
  });
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Database | Economy | IdentitySnapshot | ServicePrincipalGrantAuthority
    >,
  ): Promise<A> =>
    runTestPromise(
      effect.pipe(
        Effect.provideService(Database, sql),
        Effect.provideService(Economy, economy),
        Effect.provideService(IdentitySnapshot, identitySnapshot),
        Effect.provideService(ServicePrincipalGrantAuthority, servicePrincipalGrantAuthority),
      ),
    );
  const services = Layer.mergeAll(
    Layer.succeed(Database, sql),
    Layer.succeed(Economy, economy),
    Layer.succeed(IdentitySnapshot, identitySnapshot),
    Layer.succeed(ServicePrincipalGrantAuthority, servicePrincipalGrantAuthority),
    Layer.succeed(Identity, identity),
    Layer.succeed(OAuthCredentialAuthority, oauthCredentialAuthority),
  );
  const httpOptions = {
    config: { ...config, e2eTestMode: true },
    identity: {
      ...(serviceCredential === undefined
        ? {}
        : {
            resolveApprovalCredential: () =>
              Effect.succeed({
                credential: serviceCredential,
                authorizationInstant: AuthorizationInstant.make(evaluatedAt),
              }),
          }),
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
  } satisfies ReceiptApiHttpOptions<UnauthenticatedActor, never>;
  return {
    http: makeReceiptApiHttp(httpOptions, services),
    internalHttp: makeInternalReceiptTestHttp(httpOptions, services),
    commands,
    privateFileReads: () => privateFileReads,
    principals,
    allocations,
    approvalQueries,
    approvalFileQueries: () => approvalFileQueries,
    evidenceReads,
    nativeReceiptCount: () => nativeReceipts.size,
    run,
    currentTransactionId: () => currentTransactionId,
    mutationTransactions: () => ({ commandTransactionIds, receiptWriteTransactionIds }),
    evidenceCounts: () => ({
      evidenceContextReads,
      evidenceContextSnapshotDepths,
      evidenceProjectionSnapshotDepths,
    }),
    snapshotObservations: () => ({
      identitySnapshotDepths,
      identitySnapshotVersions,
      receiptContextVersions,
      committedVersion,
    }),
    revokeCredential: () => {
      committedVersion = 2;
    },
    revokeAuthority: (authority: RevocableReceiptAuthority) => {
      revokedAuthority = authority;
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
  body: unknown = {},
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

const readJson = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

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
          etag: receiptEtag(receiptId, 0),
        }),
      ],
      totalItems: 1,
    });
    expect(state.authorizationPrincipalCalls()).toBe(1);
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
      idempotencyKey: "submit-receipt-idempotency-key" as never,
    });
    const second = deriveHttpIdentity({
      credentialSubject: `Person:${personId}`,
      qualifiedOperationId: "receipts.submitReceipt",
      normalizedTarget: "/api/receipts",
      idempotencyKey: "another-receipt-idempotency-key" as never,
    });

    expect(first.commandId).toMatch(/^httpv2_[A-Za-z0-9_-]{43}$/u);
    expect(first.identitySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.commandId).not.toBe(first.commandId);
    expect(first.commandId).not.toContain(personId);
    expect(first.commandId).not.toContain("submit-receipt-idempotency-key");
  });

  it("persists and replays exact 201 and 200 response capsules in transaction-scoped native receipts", async () => {
    const state = harness();
    const executedIn: Array<number> = [];
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
        idempotencyKey: item.key as never,
      });
      const identity = {
        identitySha256: derived.identitySha256,
        requestSha256: item.requestSha256,
        operationId: item.operationId,
      };
      const execute = Effect.sync(() => {
        executedIn.push(state.currentTransactionId());
        return item.capsule;
      });
      const plan = Effect.succeed({ identity, execute });
      const committed = await state.run(executeNativeHttpCommandPostgres(plan));
      const replayed = await state.run(executeNativeHttpCommandPostgres(plan));

      expect(committed).toEqual({ _tag: "Committed", response: item.capsule });
      expect(replayed).toEqual({ _tag: "Replay", response: item.capsule });
      if (replayed._tag !== "Replay") throw new Error("expected native receipt replay");
      expect(replayed.response.status).toBe(item.capsule.status);
    }

    expect(executedIn).toEqual([1, 3]);
    expect(state.nativeReceiptCount()).toBe(2);
    expect(state.mutationTransactions().receiptWriteTransactionIds).toEqual([1, 3]);
  });

  it("preserves exact 201 and 200 statuses through the public HTTP replay path", async () => {
    const submitState = harness();
    const submitted = await submitRequest(submitState.http, "submit-http-replay-key-0001");
    const submittedBody = await readJson(submitted);
    expect(Schema.decodeUnknownSync(ReceiptResource)(submittedBody).refundDate).toBeNull();
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
    expect(state.snapshotObservations()).toEqual({
      identitySnapshotDepths: [1],
      identitySnapshotVersions: [1],
      receiptContextVersions: [],
      committedVersion: 1,
    });
    expect(state.mutationTransactions()).toEqual({
      commandTransactionIds: [1],
      receiptWriteTransactionIds: [1],
    });
    expect(state.authorizationPrincipalCalls()).toBe(0);

    state.revokeCredential();
    const revokedReplay = await actionRequest(state.http, pathname, idempotencyKey);
    expect(revokedReplay.status).toBe(401);
    expect(state.commands).toHaveLength(1);
    expect(state.mutationTransactions()).toEqual({
      commandTransactionIds: [1],
      receiptWriteTransactionIds: [1],
    });
    expect(state.snapshotObservations()).toEqual({
      identitySnapshotDepths: [1, 1],
      identitySnapshotVersions: [1, 2],
      receiptContextVersions: [],
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
    expect(state.nativeReceiptCount()).toBe(1);
    expect(state.mutationTransactions()).toEqual({
      commandTransactionIds: [1],
      receiptWriteTransactionIds: [1],
    });
  });

  it("denies a matching approval replay after grant revocation without another transition", async () => {
    const state = harness({ approvalRows: [pendingReceipt()] });
    const pathname = `/api/receipts/${receiptId}:refund`;
    const idempotencyKey = "refund-approval-revocation-key-0001";

    const accepted = await actionRequest(state.http, pathname, idempotencyKey);
    expect(accepted.status).toBe(200);
    expect(state.commands).toHaveLength(1);
    expect(state.authorizationChecks()).toEqual(["RefundReceipt"]);

    state.revokeAuthority("Approval");
    const revokedReplay = await actionRequest(state.http, pathname, idempotencyKey);
    await expectProblem(revokedReplay, {
      code: "authority.denied",
      title: "Authority denied",
      status: 403,
      detail: "The authenticated principal is not permitted to perform this operation.",
    });
    expect(state.authorizationChecks()).toEqual(["RefundReceipt", "RefundReceipt"]);
    expect(state.commands).toHaveLength(1);
    expect(state.nativeReceiptCount()).toBe(1);
    expect(state.mutationTransactions()).toEqual({
      commandTransactionIds: [1],
      receiptWriteTransactionIds: [1],
    });
  });

  it("denies a matching reopening replay after grant revocation without another transition", async () => {
    const state = harness({ approvalRows: [{ ...pendingReceipt(), status: "Rejected" }] });
    const pathname = `/api/receipts/${receiptId}:reopen`;
    const idempotencyKey = "reopen-approval-revocation-key-0001";

    const accepted = await actionRequest(state.http, pathname, idempotencyKey);
    expect(accepted.status).toBe(200);
    expect(state.commands).toHaveLength(1);
    expect(state.authorizationChecks()).toEqual(["ReopenRejectedReceipt"]);

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
    expect(state.nativeReceiptCount()).toBe(1);
    expect(state.mutationTransactions()).toEqual({
      commandTransactionIds: [1],
      receiptWriteTransactionIds: [1],
    });
  });

  it("registers and executes only the exact frozen action suffixes", async () => {
    const actions = [
      ["withdraw", "WithdrawPendingReceipt"],
      ["refund", "RefundReceipt"],
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
      expect(Schema.decodeUnknownSync(ReceiptResource)(await exact.json()).refundDate).toBe(
        action === "refund" ? "2026-08-24T12:00:00.000Z" : null,
      );
      expect(state.commands).toHaveLength(1);
      expect(state.commands[0]).toMatchObject({
        _tag: commandTag,
        receiptId,
        expectedRevision: 0,
      });
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
      "/api/receipts?status=Pending&status=Refunded",
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
      `/api/receipts/${receiptId}:refund?unexpected=1`,
      "refund-query-rejected-0109",
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
    expect(state.nativeReceiptCount()).toBe(0);
  });

  it("service-principal queue items expose the same entity condition consumed by person decisions", async () => {
    for (const action of ["refund", "reopen"] as const) {
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
      );
      expect(listed.status).toBe(200);
      const body = await readJson(listed);
      const item = (body.items as Array<{ etag: string }>)[0]!;
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

  it("uses the queue's canonical receipt ETag for approval and reopening commands", async () => {
    for (const action of ["refund", "reopen"] as const) {
      const row = pendingReceipt({
        status: action === "reopen" ? "Rejected" : "Pending",
        revision: 2,
      });
      const state = harness({ approvalRows: [row] });
      const listed = await request(state.http, `/api/receipt-approval-queue?status=${row.status}`);
      const body = await readJson(listed);
      const item = (body.items as Array<{ etag: string }>)[0]!;
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
      evidenceResult: { proof: "bounded-evidence" },
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
      body: { proof: "bounded-evidence" },
    });
    expect(state.evidenceReads).toEqual([{ receiptId, personId }]);
    expect(state.evidenceCounts()).toEqual({
      evidenceContextReads: 1,
      evidenceContextSnapshotDepths: [1],
      evidenceProjectionSnapshotDepths: [1],
    });
  });

  it("keeps authentication, authorization context, and projection in one read transaction", async () => {
    const state = harness({
      revokeSessionAfterSnapshotRead: true,
      evidenceAccessRows: [
        {
          ownerPersonId: personId,
          departmentId: departmentOne,
          status: "Pending",
          revision: 2,
        },
      ],
      evidenceResult: { proof: "same-snapshot" },
    });
    const response = await request(state.internalHttp, internalPath);

    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { proof: "same-snapshot" },
    });
    expect(state.snapshotObservations()).toEqual({
      identitySnapshotDepths: [1],
      identitySnapshotVersions: [1],
      receiptContextVersions: [1],
      committedVersion: 2,
    });
  });

  it("does not read receipt state when the internal Cookie credential is unavailable", async () => {
    const missing = harness({ unauthenticated: true });
    const missingResponse = await request(missing.internalHttp, internalPath);
    expect({ status: missingResponse.status, body: await missingResponse.json() }).toEqual({
      status: 401,
      body: { error: { tag: "UnauthenticatedActor" } },
    });
    expect(missing.evidenceCounts().evidenceContextReads).toBe(0);

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
    expect(unavailable.evidenceCounts().evidenceContextReads).toBe(0);
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
        receiptId: "terminal-approval-file",
        status: "Refunded",
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
        receiptId: "terminal-approval-file",
        personId,
        authorizationInstant: evaluatedAt,
        snapshotDepth: 1,
      },
    ]);
    expect(state.snapshotObservations().identitySnapshotDepths).toEqual([1]);
    expect(state.privateFileReads()).toBe(1);
    expect(state.commands).toEqual([]);
    expect(state.nativeReceiptCount()).toBe(0);
  });

  it("does not widen scoped approver access into the owner route", async () => {
    const state = harness({
      approvalFileRow: pendingReceipt({ receiptId: "approver-only-file" }),
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
        approvalFileRow: pendingReceipt({ receiptId: "foreign-file" }),
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
      approvalFileRow: pendingReceipt({ receiptId: "missing-approval-object" }),
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
      approvalFileRow: pendingReceipt({ receiptId: "malformed-approval-file" }),
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

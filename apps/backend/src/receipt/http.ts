import { reflectAccessSpec } from "../../../../packages/http-api/src/access.js";
import { readOwnedReceiptFile } from "@vektorprogrammet/database/receipt";
import { randomUUID } from "node:crypto";

import {
  CapabilityTypeId,
  AuthorityRef,
  AuthorityVersion,
  AuthorizationInstant,
  CredentialEvidenceRef,
  GrantId,
  INTERNAL_RECEIPT_EVIDENCE_ACCESS,
  READ_INTERNAL_RECEIPT_EVIDENCE_CAPABILITY,
  RECEIPT_DOMAIN_ID,
  RECEIPT_RESOURCE_KIND,
  ResourceId,
  ServicePrincipalGrantAuthority,
  accessHttpStatus,
  evaluateAccess,
  evaluateServicePrincipalReceiptApprovalAccess,
  makeGrant,
  type AcceptedOAuthServiceCredential,
  type AccessEvaluation,
  type CredentialOutcome,
  type ReceiptAccessFacts,
} from "@vektorprogrammet/domain/authz";
import { Database, IdentitySnapshot } from "@vektorprogrammet/database";
import {
  executeNativeHttpCommandPostgres,
  type NativeHttpResponseCapsule,
} from "../http-api/receipt-transaction.js";
import { Effect, Option } from "effect";
import {
  Economy,
  ReceiptDecodeError,
  ReceiptFileService,
  ReceiptPersistenceError,
  ReceiptNotFound,
  ReceiptId,
  ReceiptVisualId,
  UnauthenticatedActor,
  isIsoDate,
  type Receipt,
  type ReceiptCommandPrincipal,
  type ReceiptFile,
  type ReceiptMutationAuthorization,
  type ReceiptMutationAuthorizationTarget,
  type ReceiptStatus,
  type ReceiptSubmissionAllocation,
  type OwnedReceiptProjectionItem,
} from "@vektorprogrammet/domain/receipt";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import {
  ReadReceiptFileEndpoint,
  ExternalNativeApi,
  InternalNativeApi,
  type ReceiptResource,
  type ReceiptListItem,
} from "@vektorprogrammet/http-api";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { toHttpApiResponse } from "../http-api/transport.js";
import {
  HttpSemanticFailure,
  deriveHttpIdentity,
  deriveStrongETag,
  nativeProblemResponse,
  parseIdempotencyKey,
  parseJsonWithoutDuplicateMembers,
  parseRequiredIfMatch,
  semanticRequestDigest,
  semanticMutationRequest,
  type NativeIdempotencyIdentity,
} from "../http-semantics.js";
import { resolveRequestCredentialInTransaction } from "../authority.js";
import { nativeCommandOutcomeResponse } from "../native-operation.js";
import { hasBetterAuthSessionCredential } from "../session-security.js";
import type { ReceiptApiConfig } from "./config.js";
import {
  makeReceiptFileStore,
  type ReceiptFileStore,
  type StagedReceiptFile,
} from "./filesystem.js";

const SUPPORTED_CONTENT_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;
type SupportedContentType = (typeof SUPPORTED_CONTENT_TYPES)[number];
const isReceiptStatus = (value: string): value is ReceiptStatus => {
  switch (value) {
    case "Pending":
    case "Refunded":
    case "Rejected":
    case "Withdrawn":
      return true;
    default:
      return false;
  }
};

type AcceptedCredential = Extract<CredentialOutcome, { readonly _tag: "Accepted" }>;

type ReceiptE2EConcurrencyLane = "file-read" | "refund" | "reject";

type ReceiptE2ETransactionBarrier = (
  request: Request,
  receiptId: string,
  lane: ReceiptE2EConcurrencyLane,
) => Promise<boolean>;

export interface ReceiptIdentityResolvers<E = never, R = never> {
  /** Request credential -> canonical person and one instant; never role or authority facts. */
  readonly resolveAuthorizationPrincipal: (
    request: Request,
  ) => Effect.Effect<ReceiptCommandPrincipal, E, R>;
  /** Request credential -> owner person id; no role or authority facts. */
  readonly resolvePersonId: (request: Request) => Effect.Effect<string, E, R>;
  /** Exact row 42 credential bridge; no token-carried authorization facts. */
  readonly resolveApprovalCredential?: (request: Request) => Effect.Effect<
    {
      readonly credential: AcceptedCredential;
      readonly authorizationInstant: AuthorizationInstant;
    },
    E,
    R
  >;
}

export interface ReceiptApiHttpOptions<E = never, R = never> {
  readonly config: ReceiptApiConfig;
  readonly identity: ReceiptIdentityResolvers<E, R>;
  readonly now?: () => string;
  readonly fileStore?: ReceiptFileStore;
  /**
   * Stable worker claim identity used to recover its stale in-flight effects.
   * The composition root may supply an operationally durable identity.
   */
  readonly outboxClaimId?: string;
  /** Local evidence-only transaction barrier; absent from every non-E2E composition. */
  readonly e2eTransactionBarrier?: ReceiptE2ETransactionBarrier;
}

const RECEIPT_E2E_CONCURRENCY_REQUEST_HEADER = "x-receipt-e2e-concurrency-probe";
const RECEIPT_E2E_CONCURRENCY_RESPONSE_HEADER = "x-receipt-e2e-concurrency-synchronized";

const makeReceiptE2ETransactionBarrier = (): ReceiptE2ETransactionBarrier => {
  let targetReceiptId: string | undefined;
  const arrived = new Set<ReceiptE2EConcurrencyLane>();
  let pending: Promise<void> | undefined;
  let release: (() => void) | undefined;
  let reject: ((cause: Error) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let synchronized = false;

  return (request, receiptId, lane) => {
    try {
      const marker = request.headers.get(RECEIPT_E2E_CONCURRENCY_REQUEST_HEADER);
      if (marker === null) return Promise.resolve(false);
      if (marker !== lane) {
        throw new HttpSemanticFailure("request.malformed", 400);
      }
      if (targetReceiptId === undefined) targetReceiptId = receiptId;
      if (targetReceiptId !== receiptId) {
        throw new HttpSemanticFailure("request.malformed", 400);
      }
      if (arrived.has(lane)) {
        if (synchronized) return Promise.resolve(true);
        throw new HttpSemanticFailure("request.malformed", 400);
      }
      if (pending === undefined) {
        pending = new Promise<void>((resolve, rejectPending) => {
          release = resolve;
          reject = rejectPending;
        });
        timer = setTimeout(() => {
          reject?.(new Error("Receipt E2E transaction concurrency barrier timed out"));
        }, 10_000);
      }
      arrived.add(lane);
      if (arrived.size === 3) {
        synchronized = true;
        clearTimeout(timer);
        release?.();
      }
      return pending.then(() => true);
    } catch (cause) {
      return Promise.reject(cause);
    }
  };
};

interface ErrorBody {
  readonly error: { readonly tag: string; readonly message?: string };
}

const COMPOSED_DENIAL_MESSAGES = {
  AmbiguousParameterFill: "Authorization parameter fill is ambiguous",
  FailedComposedRequirement: "Composed authorization requirement failed",
} as const;

const jsonResponse = (
  body: unknown,
  status = 200,
  cacheControl: "no-store" | "private, no-store" = "no-store",
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": cacheControl,
    },
  });

const errorResponse = (cause: unknown, fallback = "ReceiptPersistenceError"): Response => {
  const tag =
    cause !== null && typeof cause === "object" && "_tag" in cause && typeof cause._tag === "string"
      ? cause._tag
      : fallback;
  const status =
    tag === "UnauthenticatedActor"
      ? 401
      : tag === "InactiveActor" ||
          tag === "ReceiptOwnerDenied" ||
          tag === "ReceiptScopeDenied" ||
          tag === "ReceiptAuthorityDenied" ||
          tag === "AmbiguousPaymentSelection" ||
          tag === "AmbiguousParameterFill" ||
          tag === "FailedComposedRequirement"
        ? 403
        : tag === "ReceiptNotFound"
          ? 404
          : tag === "ReceiptDecodeError" || tag === "ReceiptFileNotStaged"
            ? 422
            : tag === "ReceiptAlreadyExists" ||
                tag === "DuplicateReceiptCommandConflict" ||
                tag === "StaleReceiptRevision" ||
                tag === "InvalidReceiptTransition"
              ? 409
              : 503;
  const message =
    tag === "AmbiguousParameterFill" || tag === "FailedComposedRequirement"
      ? COMPOSED_DENIAL_MESSAGES[tag]
      : undefined;
  const body: ErrorBody = {
    error: message === undefined ? { tag } : { tag, message },
  };
  return jsonResponse(body, status);
};
const publicReceiptErrorResponse = (cause: unknown): Response => {
  if (cause instanceof HttpSemanticFailure) {
    return nativeProblemResponse(cause.code, cause.status);
  }
  const tag =
    cause !== null && typeof cause === "object" && "_tag" in cause && typeof cause._tag === "string"
      ? cause._tag
      : "ReceiptPersistenceError";
  switch (tag) {
    case "UnauthenticatedActor":
      return nativeProblemResponse("credential.missing", 401);
    case "InactiveActor":
    case "ReceiptOwnerDenied":
    case "ReceiptScopeDenied":
    case "ReceiptAuthorityDenied":
    case "AmbiguousPaymentSelection":
    case "AmbiguousParameterFill":
    case "FailedComposedRequirement":
      return nativeProblemResponse("authority.denied", 403);
    case "ReceiptNotFound":
      return nativeProblemResponse("receipt.not-found", 404);
    case "StaleReceiptRevision":
      return nativeProblemResponse("precondition.failed", 412);
    case "ReceiptDecodeError":
      return nativeProblemResponse("validation.failed", 422);
    case "ReceiptFileNotStaged":
      return nativeProblemResponse("receipt.file-not-staged", 422);
    case "ReceiptAlreadyExists":
      return nativeProblemResponse("receipt.already-exists", 409);
    case "DuplicateReceiptCommandConflict":
      return nativeProblemResponse("idempotency.digest-conflict", 409);
    case "InvalidReceiptTransition":
      return nativeProblemResponse("receipt.invalid-transition", 409);
    default:
      return nativeProblemResponse("receipts.unavailable", 503);
  }
};

const isSupportedContentType = (value: string): value is SupportedContentType =>
  (SUPPORTED_CONTENT_TYPES as readonly string[]).includes(value);

const receiptFileName = (contentType: ReceiptFile["contentType"]): string => {
  switch (contentType) {
    case "image/jpeg":
      return "receipt.jpg";
    case "image/png":
      return "receipt.png";
    case "application/pdf":
      return "receipt.pdf";
  }
};

const readPrivateReceiptFile = (
  file: ReceiptFile,
  fileStore: ReceiptFileStore,
  maxFileBytes: number,
  extraHeaders: Readonly<Record<string, string>> = {},
) =>
  Effect.tryPromise({
    try: () => fileStore.readCommitted(file, maxFileBytes),
    catch: () => new HttpSemanticFailure("receipts.unavailable", 503),
  }).pipe(
    Effect.map((bytes) =>
      HttpServerResponse.uint8Array(bytes, {
        contentType: file.contentType,
        headers: {
          ...extraHeaders,
          "content-disposition": `inline; filename="${receiptFileName(file.contentType)}"`,
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
          vary: "Origin",
        },
      }),
    ),
  );

const toPrivateFileHttpApiResponse = <E, R>(
  request: HttpServerRequest.HttpServerRequest,
  handle: (request: Request) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  HttpServerRequest.toWeb(request).pipe(
    Effect.flatMap(handle),
    Effect.catch((cause) =>
      Effect.succeed(HttpServerResponse.fromWeb(publicReceiptErrorResponse(cause))),
    ),
  );

const parseSafeAmountOre = (value: string): number => {
  if (!/^[1-9]\d*$/.test(value)) throw new ReceiptDecodeError({ message: "invalid amountOre" });
  const amountOre = Number(value);
  if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
    throw new ReceiptDecodeError({ message: "invalid amountOre" });
  }
  return amountOre;
};

const readSingleField = (
  fields: ReadonlyMap<string, Array<string | File>>,
  name: string,
): string => {
  const values = fields.get(name);
  if (values === undefined || values.length !== 1 || typeof values[0] !== "string") {
    throw new ReceiptDecodeError({ message: `invalid ${name}` });
  }
  return values[0];
};

const decodeMultipartFields = (request: Request, maxFileBytes: number) =>
  Effect.tryPromise({
    try: async () => {
      const contentType = request.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
        throw new ReceiptDecodeError({ message: "multipart form required" });
      }
      const contentLength = request.headers.get("content-length");
      if (contentLength === null || !/^\d+$/.test(contentLength)) {
        throw new ReceiptDecodeError({ message: "valid body length required" });
      }
      const bodyLength = Number(contentLength);
      if (
        !Number.isSafeInteger(bodyLength) ||
        bodyLength <= 0 ||
        bodyLength > maxFileBytes + 131_072
      ) {
        throw new ReceiptDecodeError({ message: "multipart body exceeds configured limit" });
      }

      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        throw new ReceiptDecodeError({ message: "invalid multipart body" });
      }
      const fields = new Map<string, Array<string | File>>();
      for (const [name, value] of form.entries()) {
        const values = fields.get(name);
        if (values === undefined) fields.set(name, [value]);
        else values.push(value);
      }
      return fields;
    },
    catch: (cause) => cause,
  });

const requireMultipartFields = (
  fields: ReadonlyMap<string, Array<string | File>>,
  required: Readonly<Record<string, true>>,
  optional: Readonly<Record<string, true>> = {},
): void => {
  for (const name of fields.keys()) {
    if (required[name] !== true && optional[name] !== true) {
      throw new ReceiptDecodeError({ message: "unexpected multipart field" });
    }
  }
  const requiredNames = Object.keys(required);
  if (
    fields.size < requiredNames.length ||
    fields.size > requiredNames.length + Object.keys(optional).length
  ) {
    throw new ReceiptDecodeError({ message: "invalid multipart fields" });
  }
  for (const name of requiredNames) {
    if (!fields.has(name)) throw new ReceiptDecodeError({ message: "missing multipart field" });
  }
};

const decodeReceiptFile = (
  fields: ReadonlyMap<string, Array<string | File>>,
  maxFileBytes: number,
  required: boolean,
): { readonly file?: File; readonly contentType?: SupportedContentType } => {
  const fileValues = fields.get("file");
  if (fileValues === undefined) {
    if (required) throw new ReceiptDecodeError({ message: "receipt file is required" });
    return {};
  }
  if (fileValues.length !== 1 || !(fileValues[0] instanceof File)) {
    throw new ReceiptDecodeError({ message: "invalid receipt file" });
  }
  const file = fileValues[0];
  if (file.size <= 0 || file.size > maxFileBytes || !isSupportedContentType(file.type)) {
    throw new ReceiptDecodeError({ message: "unsupported receipt file" });
  }
  return { file, contentType: file.type };
};

const invalidSessionFailure = (request: Request, cause: unknown): unknown =>
  cause !== null &&
  typeof cause === "object" &&
  "_tag" in cause &&
  cause._tag === "UnauthenticatedActor" &&
  hasBetterAuthSessionCredential(request.headers.get("cookie"))
    ? new HttpSemanticFailure("credential.invalid", 401)
    : cause;

const authorizationPrincipalFor = <E, R>(request: Request, options: ReceiptApiHttpOptions<E, R>) =>
  options.identity.resolveAuthorizationPrincipal(request).pipe(
    Effect.catch((cause) => {
      const classified = invalidSessionFailure(request, cause);
      return classified !== cause
        ? Effect.fail(classified)
        : cause !== null && typeof cause === "object" && "_tag" in cause
          ? Effect.fail(cause)
          : Effect.fail(new UnauthenticatedActor({ message: "authentication required" }));
    }),
  );

const authorizationPrincipalInTransaction = <E, R>(
  request: Request,
  options: ReceiptApiHttpOptions<E, R>,
) =>
  resolveRequestCredentialInTransaction(request, "OAuthUserBearer", { now: options.now }).pipe(
    Effect.catch((cause) => Effect.fail(invalidSessionFailure(request, cause))),
    Effect.flatMap((authenticated) =>
      authenticated.credential.principal._tag === "Person"
        ? Effect.succeed({
            personId: authenticated.credential.principal.personId,
            authorizationInstant: authenticated.authorizationInstant,
          })
        : Effect.fail(new UnauthenticatedActor({ message: "authentication required" })),
    ),
  );

type ReceiptApprovalRoute = {
  readonly action: "refund" | "reject" | "reopen";
  readonly receiptId: string;
};

interface ReceiptAccessRow {
  readonly ownerPersonId: string;
  readonly departmentId: string;
  readonly status: string;
  readonly revision: number;
}

const receiptLifecycleEvidence = <E, R>(
  request: Request,
  receiptId: string,
  options: ReceiptApiHttpOptions<E, R>,
) =>
  Effect.gen(function* () {
    const authorizationInstant = yield* Effect.sync(() =>
      AuthorizationInstant.make(options.now?.() ?? new Date().toISOString()),
    );
    const sql = yield* Database;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY
        `.pipe(Effect.asVoid);
        const credential = yield* IdentitySnapshot.use(({ resolveSession }) =>
          resolveSession(request.headers.get("cookie") ?? undefined, authorizationInstant),
        ).pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: "Failure" as const, error }),
            onSuccess: (actor) => ({ _tag: "Success" as const, actor }),
          }),
        );
        if (credential._tag === "Failure") {
          if (credential.error._tag !== "IdentitySessionNotFound") {
            return jsonResponse({ error: { tag: "IdentityEngineError" } }, 503);
          }
          const evaluation: AccessEvaluation = {
            _tag: "CredentialRejected",
            reason: "Invalid",
          };
          return jsonResponse(
            { error: { tag: "UnauthenticatedActor" } },
            accessHttpStatus(evaluation, INTERNAL_RECEIPT_EVIDENCE_ACCESS.concealment),
          );
        }
        const personId = credential.actor.personId;
        const rows = yield* sql<ReceiptAccessRow>`
          SELECT owner_person_id AS "ownerPersonId", department_id AS "departmentId",
            status, revision
          FROM public.economy_receipts
          WHERE receipt_id = ${receiptId}
        `;
        const row = rows[0];
        if (row === undefined) return yield* new ReceiptNotFound({ receiptId });
        const principal = { _tag: "Person" as const, personId };
        const context = {
          domainId: RECEIPT_DOMAIN_ID,
          departmentId: DepartmentId.make(row.departmentId),
          resource: {
            kind: RECEIPT_RESOURCE_KIND,
            id: ResourceId.make(receiptId),
          },
          facts: {
            ownerPersonId: PersonId.make(row.ownerPersonId),
            state: row.status,
            approverPersonIds: [],
            approverServicePrincipalIds: [],
            internalEvidenceEnabled: options.config.e2eTestMode === true,
          } satisfies ReceiptAccessFacts,
          authorityVersion: AuthorityVersion.make(`receipt:${row.revision}`),
        };
        const grant = makeGrant({
          grantId: GrantId.make(`internal-evidence:${receiptId}:${personId}`),
          subject: principal,
          capability: { type: READ_INTERNAL_RECEIPT_EVIDENCE_CAPABILITY },
          scope: {
            _tag: "And",
            left: { _tag: "Domain", domainId: RECEIPT_DOMAIN_ID },
            right: {
              _tag: "And",
              left: { _tag: "Department", departmentId: context.departmentId },
              right: { _tag: "Resource", resource: context.resource },
            },
          },
          startAt: AuthorizationInstant.make("1970-01-01T00:00:00.000Z"),
          endAt: null,
          requirements: [],
          source: AuthorityRef.make("backend.receipt.internal-evidence"),
          revision: row.revision,
        });
        const evaluation = evaluateAccess({
          spec: INTERNAL_RECEIPT_EVIDENCE_ACCESS,
          credential: {
            _tag: "Accepted",
            mechanism: { _tag: "BetterAuthCookie" },
            principal,
            evidenceRef: CredentialEvidenceRef.make("better-auth:resolved-session"),
          },
          resolution: { selection: "ExactlyOne", contexts: [context] },
          grants: [grant],
          authorizationInstant,
        });
        if (evaluation._tag !== "Allow") {
          return jsonResponse(
            { error: { tag: "ReceiptAuthorityDenied" } },
            accessHttpStatus(evaluation, INTERNAL_RECEIPT_EVIDENCE_ACCESS.concealment),
          );
        }
        const evidence = yield* Economy.use(({ readReceiptLifecycleEvidence }) =>
          readReceiptLifecycleEvidence(receiptId, personId),
        );
        return jsonResponse(evidence);
      }),
    );
  });

const DEFAULT_OUTBOX_CLAIM_ID = `backend-${process.pid}`;
const STALE_OUTBOX_CLAIM_AGE_MS = 60_000;

const deliverOutbox = (
  claimId: string,
  claimedAt: string,
  fileStore: ReceiptFileStore,
  receiptId: string,
) =>
  Economy.use(({ deliverNextOutboxEffect }) =>
    deliverNextOutboxEffect(claimId, claimedAt, receiptId),
  ).pipe(Effect.provideService(ReceiptFileService, fileStore.service));

const staleOutboxCutoff = (now: string): string => {
  const timestamp = Date.parse(now);
  return Number.isFinite(timestamp)
    ? new Date(timestamp - STALE_OUTBOX_CLAIM_AGE_MS).toISOString()
    : now;
};

const drainOutbox = <E, R>(
  options: ReceiptApiHttpOptions<E, R>,
  fileStore: ReceiptFileStore,
  receiptId: string,
) =>
  Effect.gen(function* () {
    const claimBase = options.outboxClaimId ?? DEFAULT_OUTBOX_CLAIM_ID;
    const claimId = `${claimBase}-${randomUUID()}`;
    const claimedBefore = staleOutboxCutoff(options.config.now());
    const staleClaimIds = yield* Economy.use(({ listStaleOutboxClaims }) =>
      listStaleOutboxClaims(claimedBefore, receiptId),
    ).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
    for (const staleClaimId of staleClaimIds) {
      yield* Economy.use(({ recoverStaleOutboxClaim }) =>
        recoverStaleOutboxClaim(staleClaimId, claimedBefore),
      ).pipe(Effect.catch(() => Effect.void));
    }
    for (let attempt = 0; attempt < 256; attempt += 1) {
      const delivery = yield* deliverOutbox(
        claimId,
        options.config.now(),
        fileStore,
        receiptId,
      ).pipe(
        Effect.match({
          onFailure: () => ({ _tag: "TransportFailure" as const }),
          onSuccess: (result) => ({ _tag: "Delivery" as const, result }),
        }),
      );
      if (delivery._tag === "TransportFailure") return "Failed";
      if (delivery.result._tag === "Idle") return "Idle";
      if (delivery.result._tag === "Failed") return "Failed";
    }
    return "Limit";
  });

const headerValues = (request: Request, name: string): ReadonlyArray<string> => {
  const value = request.headers.get(name);
  return value === null ? [] : [value];
};

const receiptEtag = (receiptId: string, revision: number) =>
  deriveStrongETag({
    representationKind: "ReceiptResource",
    resourceIdentity: receiptId,
    version: revision,
  });

const receiptResource = (receipt: Receipt): typeof ReceiptResource.Type => {
  const amountOre = Number(receipt.amountOre);
  if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
    throw new ReceiptPersistenceError({
      operation: "decode receipt resource",
      message: "invalid amount",
    });
  }
  return {
    receiptId: receipt.receiptId,
    visualId: receipt.visualId,
    ownerPersonId: receipt.ownerPersonId,
    departmentId: receipt.departmentId,
    description: receipt.description,
    amountOre,
    currency: receipt.currency,
    receiptDate: receipt.receiptDate,
    status: receipt.status,
    submittedAt: receipt.submittedAt,
    refundDate: receipt.refundDate,
    revision: receipt.revision,
    etag: receiptEtag(receipt.receiptId, receipt.revision),
  };
};

const receiptMutationCapsule = (
  receipt: Receipt,
  status: 200 | 201,
  location?: string,
): NativeHttpResponseCapsule => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    etag: receiptEtag(receipt.receiptId, receipt.revision),
  };
  if (status === 201) {
    if (location === undefined) throw new HttpSemanticFailure("internal.error", 500);
    headers.location = location;
  }
  return {
    status,
    mediaType: "application/json",
    bodyBytes: new TextEncoder().encode(JSON.stringify(receiptResource(receipt))),
    headers,
  };
};

const decodeV2SubmitMultipart = (request: Request, maxFileBytes: number) =>
  Effect.gen(function* () {
    const fields = yield* decodeMultipartFields(request, maxFileBytes);
    return yield* Effect.try({
      try: () => {
        requireMultipartFields(fields, {
          description: true,
          amountOre: true,
          receiptDate: true,
          file: true,
        });
        const description = readSingleField(fields, "description");
        const amountOre = parseSafeAmountOre(readSingleField(fields, "amountOre"));
        const receiptDate = readSingleField(fields, "receiptDate");
        if (description.length < 1 || description.length > 5000) {
          throw new ReceiptDecodeError({ message: "invalid receipt description" });
        }
        if (!isIsoDate(receiptDate)) {
          throw new ReceiptDecodeError({ message: "invalid receipt date" });
        }
        const decodedFile = decodeReceiptFile(fields, maxFileBytes, true);
        if (decodedFile.file === undefined || decodedFile.contentType === undefined) {
          throw new ReceiptDecodeError({ message: "receipt file is required" });
        }
        return {
          description,
          amountOre,
          receiptDate,
          file: decodedFile.file,
          contentType: decodedFile.contentType,
        };
      },
      catch: (cause) => cause,
    });
  });

const decodeV2ReviseMultipart = (request: Request, maxFileBytes: number) =>
  Effect.gen(function* () {
    const fields = yield* decodeMultipartFields(request, maxFileBytes);
    return yield* Effect.try({
      try: () => {
        requireMultipartFields(
          fields,
          {},
          {
            description: true,
            amountOre: true,
            receiptDate: true,
            file: true,
          },
        );
        if (fields.size === 0) {
          throw new ReceiptDecodeError({
            message: "receipt revision must change at least one field",
          });
        }
        const description = fields.has("description")
          ? readSingleField(fields, "description")
          : undefined;
        if (description !== undefined && (description.length < 1 || description.length > 5000)) {
          throw new ReceiptDecodeError({ message: "invalid receipt description" });
        }
        const amountOre = fields.has("amountOre")
          ? parseSafeAmountOre(readSingleField(fields, "amountOre"))
          : undefined;
        const receiptDate = fields.has("receiptDate")
          ? readSingleField(fields, "receiptDate")
          : undefined;
        if (receiptDate !== undefined && !isIsoDate(receiptDate)) {
          throw new ReceiptDecodeError({ message: "invalid receipt date" });
        }
        const decodedFile = decodeReceiptFile(fields, maxFileBytes, false);
        return {
          ...(description === undefined ? {} : { description }),
          ...(amountOre === undefined ? {} : { amountOre }),
          ...(receiptDate === undefined ? {} : { receiptDate }),
          ...decodedFile,
        };
      },
      catch: (cause) => cause,
    });
  });

const decodeExactEmptyJson = (request: Request) =>
  Effect.tryPromise({
    try: async () => {
      const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") {
        throw new HttpSemanticFailure("request.malformed", 400);
      }
      const contentLength = request.headers.get("content-length");
      if (contentLength !== null) {
        if (!/^\d+$/.test(contentLength) || Number(contentLength) > 65_536) {
          throw new HttpSemanticFailure("request.too-large", 413);
        }
      }
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > 65_536) {
        throw new HttpSemanticFailure("request.too-large", 413);
      }
      const body = parseJsonWithoutDuplicateMembers(new TextEncoder().encode(text));
      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 0
      ) {
        throw new ReceiptDecodeError({ message: "request body must be the exact empty object" });
      }
      return {};
    },
    catch: (cause) => cause,
  });

const normalizedSubmitQuery = (request: Request) =>
  Effect.try({
    try: () => {
      const entries = [...new URL(request.url).searchParams.entries()];
      if (
        entries.some(([name]) => name !== "departmentId") ||
        entries.filter(([name]) => name === "departmentId").length > 1
      ) {
        throw new HttpSemanticFailure("request.malformed", 400);
      }
      const value = entries[0]?.[1];
      if (value === undefined) return undefined;
      if (value.trim().length === 0) {
        throw new ReceiptDecodeError({ message: "invalid departmentId" });
      }
      return DepartmentId.make(value);
    },
    catch: (cause) => cause,
  });

const mutationIdentity = (
  request: Request,
  principal: ReceiptCommandPrincipal,
  qualifiedOperationId: string,
  normalizedTarget: string,
) =>
  deriveHttpIdentity({
    credentialSubject: `Person:${principal.personId}`,
    qualifiedOperationId,
    normalizedTarget,
    idempotencyKey: parseIdempotencyKey(headerValues(request, "idempotency-key")),
  } satisfies NativeIdempotencyIdentity);

interface PreparedV2ReceiptMutation {
  readonly identity: {
    readonly identitySha256: string;
    readonly commandId: string;
  };
  readonly operationId: string;
  readonly requestSha256: string;
  readonly command: unknown;
  readonly principal: ReceiptCommandPrincipal;
  readonly authorization: ReceiptMutationAuthorization;
  readonly response: {
    readonly status: 200 | 201;
    readonly location?: string;
    readonly ifMatch?: string;
    readonly currentEtag?: string;
  };
  readonly allocation?: ReceiptSubmissionAllocation;
}
type ReceiptMutationAuthorizationFor<Target extends ReceiptMutationAuthorizationTarget> =
  Target["_tag"] extends "SubmitReceipt"
    ? Extract<ReceiptMutationAuthorization, { readonly _tag: "SubmitReceipt" }>
    : Exclude<ReceiptMutationAuthorization, { readonly _tag: "SubmitReceipt" }>;

const authorizeReceiptMutationInTransaction = <Target extends ReceiptMutationAuthorizationTarget>(
  target: Target,
  principal: ReceiptCommandPrincipal,
) =>
  Economy.use(({ authorizeReceiptMutation }) => authorizeReceiptMutation(target, principal)).pipe(
    Effect.flatMap((authorization) =>
      authorization._tag === target._tag
        ? Effect.succeed(authorization as ReceiptMutationAuthorizationFor<Target>)
        : Effect.fail(
            new ReceiptPersistenceError({
              operation: "authorize Receipt mutation",
              message: "authorization target mismatch",
            }),
          ),
    ),
  );

const executeV2ReceiptMutation = <E, R>(
  prepare: () => Effect.Effect<PreparedV2ReceiptMutation, E, R>,
  execution: { readonly retry?: "serialization-once" } = {},
) =>
  executeNativeHttpCommandPostgres(
    Effect.gen(function* () {
      const prepared = yield* prepare();
      return {
        identity: {
          identitySha256: prepared.identity.identitySha256,
          requestSha256: prepared.requestSha256,
          operationId: prepared.operationId,
        },
        execute: Economy.use(({ executeAuthorizedReceipt }) =>
          Effect.gen(function* () {
            if (
              prepared.response.ifMatch !== undefined &&
              prepared.response.currentEtag !== undefined &&
              prepared.response.ifMatch !== prepared.response.currentEtag
            ) {
              return yield* Effect.fail(new HttpSemanticFailure("precondition.failed", 412));
            }
            const result = yield* executeAuthorizedReceipt(
              prepared.command,
              prepared.authorization,
              prepared.allocation,
            );
            return receiptMutationCapsule(
              result.receipt,
              prepared.response.status,
              prepared.response.location,
            );
          }),
        ),
      };
    }),
    execution,
  );

const ownedReceiptResource = (receipt: OwnedReceiptProjectionItem): typeof ReceiptListItem.Type => {
  const amountOre = Number(receipt.amountOre);
  if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
    throw new ReceiptPersistenceError({
      operation: "decode owned receipt projection",
      message: "invalid amount",
    });
  }
  return {
    receiptId: receipt.receiptId,
    visualId: receipt.visualId,
    ownerPersonId: receipt.ownerPersonId,
    departmentId: receipt.departmentId,
    description: receipt.description,
    amountOre,
    currency: receipt.currency,
    receiptDate: receipt.receiptDate,
    status: receipt.status,
    revision: receipt.revision,
    etag: receiptEtag(receipt.receiptId, receipt.revision),
  };
};

const cleanupStagedFile = (fileStore: ReceiptFileStore, staged: StagedReceiptFile) =>
  Effect.tryPromise({
    try: () => fileStore.cleanupStage(staged.file),
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.void));

const listOwnedV2 = <E, R>(request: Request, options: ReceiptApiHttpOptions<E, R>) =>
  Effect.gen(function* () {
    const selectedStatus = yield* Effect.try({
      try: () => {
        const entries = [...new URL(request.url).searchParams.entries()];
        if (
          entries.some(([name]) => name !== "status") ||
          entries.filter(([name]) => name === "status").length > 1
        ) {
          throw new HttpSemanticFailure("request.malformed", 400);
        }
        const status = entries[0]?.[1];
        if (status !== undefined && !isReceiptStatus(status)) {
          throw new ReceiptDecodeError({ message: "invalid receipt status" });
        }
        return status;
      },
      catch: (cause) => cause,
    });
    const principal = yield* authorizationPrincipalFor(request, options);
    const rows = yield* Economy.use(({ listOwnedReceipts }) =>
      listOwnedReceipts(principal.personId, selectedStatus),
    );
    const items = yield* Effect.try({
      try: () => rows.map(ownedReceiptResource),
      catch: (cause) => cause,
    });
    return jsonResponse({ items, totalItems: items.length }, 200, "private, no-store");
  });

const submitV2 = <E, R>(
  request: Request,
  options: ReceiptApiHttpOptions<E, R>,
  fileStore: ReceiptFileStore,
) => {
  let staged: StagedReceiptFile | undefined;
  let allocation: ReceiptSubmissionAllocation | undefined;
  let committed = false;
  return Effect.gen(function* () {
    const departmentId = yield* normalizedSubmitQuery(request);
    const fields = yield* decodeV2SubmitMultipart(request, options.config.maxFileBytes);
    const outcome = yield* executeV2ReceiptMutation(() =>
      Effect.gen(function* () {
        const principal = yield* authorizationPrincipalInTransaction(request, options);
        const authorization = yield* authorizeReceiptMutationInTransaction(
          {
            _tag: "SubmitReceipt",
            ...(departmentId === undefined ? {} : { departmentId }),
          },
          principal,
        );
        const identity = yield* Effect.try({
          try: () =>
            mutationIdentity(request, principal, "receipts.submitReceipt", "/api/receipts"),
          catch: (cause) => cause,
        });
        const nextStaged = yield* Effect.tryPromise({
          try: () =>
            fileStore.stageBytes(
              fields.file,
              identity.commandId,
              fields.contentType,
              options.config.maxFileBytes,
            ),
          catch: (cause) => cause,
        });
        staged = nextStaged;
        yield* fileStore.service.stage(nextStaged.file);
        const semanticBody = {
          ...(departmentId === undefined ? {} : { departmentId }),
          description: fields.description,
          amountOre: fields.amountOre,
          receiptDate: fields.receiptDate,
          file: {
            contentType: nextStaged.file.contentType,
            byteLength: nextStaged.file.byteLength,
            sha256: nextStaged.file.sha256,
          },
        };
        const command = {
          _tag: "SubmitReceipt" as const,
          commandId: identity.commandId,
          ...(departmentId === undefined ? {} : { departmentId }),
          description: fields.description,
          amountOre: fields.amountOre,
          receiptDate: fields.receiptDate,
          file: nextStaged.file,
        };
        const nextAllocation = {
          receiptId: ReceiptId.make(options.config.nextReceiptId()),
          visualId: ReceiptVisualId.make(options.config.nextVisualId()),
        };
        allocation = nextAllocation;
        return {
          identity,
          operationId: "receipts.submitReceipt",
          requestSha256: semanticRequestDigest({ body: semanticBody }),
          command,
          principal,
          authorization,
          response: {
            status: 201,
            location: `/api/receipts/${encodeURIComponent(nextAllocation.receiptId)}`,
          },
          allocation: nextAllocation,
        };
      }),
    );
    if (outcome._tag === "Committed") {
      if (allocation === undefined) {
        return yield* Effect.fail(
          new ReceiptPersistenceError({
            operation: "submit receipt allocation",
            message: "transaction preparation produced no allocation",
          }),
        );
      }
      committed = true;
      yield* drainOutbox(options, fileStore, allocation.receiptId);
    } else if (staged?.created === true) {
      yield* cleanupStagedFile(fileStore, staged);
    }
    return nativeCommandOutcomeResponse(outcome);
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        !committed && staged?.created === true ? cleanupStagedFile(fileStore, staged) : Effect.void,
      ),
    ),
  );
};

const reviseV2 = <E, R>(
  request: Request,
  receiptId: string,
  options: ReceiptApiHttpOptions<E, R>,
  fileStore: ReceiptFileStore,
) => {
  let staged: StagedReceiptFile | undefined;
  let committed = false;
  return Effect.gen(function* () {
    const ifMatch = yield* Effect.try({
      try: () => parseRequiredIfMatch(headerValues(request, "if-match")),
      catch: (cause) => cause,
    });
    const fields = yield* decodeV2ReviseMultipart(request, options.config.maxFileBytes);
    const outcome = yield* executeV2ReceiptMutation(() =>
      Effect.gen(function* () {
        const principal = yield* authorizationPrincipalInTransaction(request, options);
        const authorization = yield* authorizeReceiptMutationInTransaction(
          { _tag: "RevisePendingReceipt", receiptId },
          principal,
        );
        const current = authorization.current;
        const identity = yield* Effect.try({
          try: () =>
            mutationIdentity(
              request,
              principal,
              "receipts.reviseReceipt",
              `/api/receipts/${encodeURIComponent(receiptId)}`,
            ),
          catch: (cause) => cause,
        });
        if (fields.file !== undefined) {
          const file = fields.file;
          const contentType = fields.contentType;
          if (contentType === undefined) {
            return yield* Effect.fail(new ReceiptDecodeError({ message: "invalid receipt file" }));
          }
          const nextStaged = yield* Effect.tryPromise({
            try: () =>
              fileStore.stageBytes(
                file,
                identity.commandId,
                contentType,
                options.config.maxFileBytes,
              ),
            catch: (cause) => cause,
          });
          staged = nextStaged;
          yield* fileStore.service.stage(nextStaged.file);
        }
        const amountOre =
          fields.amountOre ??
          (yield* Effect.try({
            try: () => {
              const value = Number(current.amountOre);
              if (!Number.isSafeInteger(value) || value <= 0) {
                throw new ReceiptPersistenceError({
                  operation: "decode current receipt amount",
                  message: "invalid amount",
                });
              }
              return value;
            },
            catch: (cause) => cause,
          }));
        const semanticBody = {
          ...(fields.description === undefined ? {} : { description: fields.description }),
          ...(fields.amountOre === undefined ? {} : { amountOre: fields.amountOre }),
          ...(fields.receiptDate === undefined ? {} : { receiptDate: fields.receiptDate }),
          ...(staged === undefined
            ? {}
            : {
                file: {
                  contentType: staged.file.contentType,
                  byteLength: staged.file.byteLength,
                  sha256: staged.file.sha256,
                },
              }),
        };
        const command = {
          _tag: "RevisePendingReceipt" as const,
          commandId: identity.commandId,
          receiptId,
          expectedRevision: current.revision,
          description: fields.description ?? current.description,
          amountOre,
          receiptDate: fields.receiptDate ?? current.receiptDate,
          file: staged?.file ?? { _tag: "KeepCurrentFile" as const },
        };
        return {
          identity,
          operationId: "receipts.reviseReceipt",
          requestSha256: semanticRequestDigest(semanticMutationRequest(semanticBody, ifMatch)),
          command,
          principal,
          authorization,
          response: {
            status: 200,
            ifMatch,
            currentEtag: receiptEtag(receiptId, current.revision),
          },
        };
      }),
    );
    if (outcome._tag === "Committed") {
      committed = true;
      yield* drainOutbox(options, fileStore, receiptId);
    } else if (staged?.created === true) {
      yield* cleanupStagedFile(fileStore, staged);
    }
    return nativeCommandOutcomeResponse(outcome);
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        !committed && staged?.created === true ? cleanupStagedFile(fileStore, staged) : Effect.void,
      ),
    ),
  );
};

const withdrawV2 = <E, R>(
  request: Request,
  receiptId: string,
  options: ReceiptApiHttpOptions<E, R>,
  fileStore: ReceiptFileStore,
) =>
  Effect.gen(function* () {
    const ifMatch = yield* Effect.try({
      try: () => parseRequiredIfMatch(headerValues(request, "if-match")),
      catch: (cause) => cause,
    });
    const body = yield* decodeExactEmptyJson(request);
    const outcome = yield* executeV2ReceiptMutation(() =>
      Effect.gen(function* () {
        const principal = yield* authorizationPrincipalInTransaction(request, options);
        const authorization = yield* authorizeReceiptMutationInTransaction(
          { _tag: "WithdrawPendingReceipt", receiptId },
          principal,
        );
        const current = authorization.current;
        const identity = yield* Effect.try({
          try: () =>
            mutationIdentity(
              request,
              principal,
              "receipts.withdrawReceipt",
              `/api/receipts/${encodeURIComponent(receiptId)}/withdraw`,
            ),
          catch: (cause) => cause,
        });
        return {
          identity,
          operationId: "receipts.withdrawReceipt",
          requestSha256: semanticRequestDigest(semanticMutationRequest(body, ifMatch)),
          command: {
            _tag: "WithdrawPendingReceipt" as const,
            commandId: identity.commandId,
            receiptId,
            expectedRevision: current.revision,
          },
          principal,
          authorization,
          response: {
            status: 200,
            ifMatch,
            currentEtag: receiptEtag(receiptId, current.revision),
          },
        };
      }),
    );
    if (outcome._tag === "Committed") yield* drainOutbox(options, fileStore, receiptId);
    return nativeCommandOutcomeResponse(outcome);
  });

const approvalCommandV2 = <E, R>(
  request: Request,
  route: ReceiptApprovalRoute,
  options: ReceiptApiHttpOptions<E, R>,
  fileStore: ReceiptFileStore,
) => {
  let synchronized = false;
  return Effect.gen(function* () {
    yield* Effect.try({
      try: () => {
        if (new URL(request.url).search.length > 0) {
          throw new HttpSemanticFailure("request.malformed", 400);
        }
      },
      catch: (cause) => cause,
    });
    const ifMatch = yield* Effect.try({
      try: () => parseRequiredIfMatch(headerValues(request, "if-match")),
      catch: (cause) => cause,
    });
    const body = yield* decodeExactEmptyJson(request);
    const operationId =
      route.action === "refund"
        ? "receipts.refundReceipt"
        : route.action === "reopen"
          ? "receipts.reopenReceipt"
          : "receipts.rejectReceipt";
    const normalizedTarget = `/api/receipts/${encodeURIComponent(route.receiptId)}/${route.action}`;
    const execution = yield* executeV2ReceiptMutation(
      () =>
        Effect.gen(function* () {
          const principal = yield* authorizationPrincipalInTransaction(request, options);
          if (route.action !== "reopen") {
            const lane = route.action;
            const barrier = options.e2eTransactionBarrier;
            synchronized =
              barrier === undefined
                ? false
                : yield* Effect.tryPromise({
                    try: () => barrier(request, route.receiptId, lane),
                    catch: (cause) => cause,
                  });
          }
          const authorization = yield* authorizeReceiptMutationInTransaction(
            {
              _tag:
                route.action === "refund"
                  ? ("RefundReceipt" as const)
                  : route.action === "reopen"
                    ? ("ReopenRejectedReceipt" as const)
                    : ("RejectReceipt" as const),
              receiptId: route.receiptId,
            },
            principal,
          );
          const current = authorization.current;
          const identity = yield* Effect.try({
            try: () => mutationIdentity(request, principal, operationId, normalizedTarget),
            catch: (cause) => cause,
          });
          return {
            identity,
            operationId,
            requestSha256: semanticRequestDigest(semanticMutationRequest(body, ifMatch)),
            command: {
              _tag:
                route.action === "refund"
                  ? ("RefundReceipt" as const)
                  : route.action === "reopen"
                    ? ("ReopenRejectedReceipt" as const)
                    : ("RejectReceipt" as const),
              commandId: identity.commandId,
              receiptId: route.receiptId,
              expectedRevision: current.revision,
            },
            principal,
            authorization,
            response: {
              status: 200,
              ifMatch,
              currentEtag: receiptEtag(route.receiptId, current.revision),
            },
          };
        }),
      route.action === "reopen" ? {} : { retry: "serialization-once" },
    ).pipe(
      Effect.match({
        onFailure: (cause) => ({ _tag: "Failure" as const, cause }),
        onSuccess: (outcome) => ({ _tag: "Success" as const, outcome }),
      }),
    );
    if (execution._tag === "Failure") {
      if (!synchronized) return yield* Effect.fail(execution.cause);
      const response = publicReceiptErrorResponse(execution.cause);
      response.headers.set(RECEIPT_E2E_CONCURRENCY_RESPONSE_HEADER, "1");
      return response;
    }
    const outcome = execution.outcome;
    if (outcome._tag === "Committed" && route.action !== "reopen") {
      yield* drainOutbox(options, fileStore, route.receiptId);
    }
    const response = nativeCommandOutcomeResponse(outcome);
    if (synchronized) response.headers.set(RECEIPT_E2E_CONCURRENCY_RESPONSE_HEADER, "1");
    return response;
  });
};

const decodeApprovalStatusFilter = (request: Request) =>
  Effect.try({
    try: () => {
      const entries = [...new URL(request.url).searchParams.entries()];
      const statusEntries = entries.filter(([name]) => name === "status");
      if (entries.some(([name]) => name !== "status") || statusEntries.length > 1) {
        throw new HttpSemanticFailure("request.malformed", 400);
      }
      const status = statusEntries[0]?.[1];
      if (status === undefined) return undefined;
      if (!isReceiptStatus(status)) {
        throw new HttpSemanticFailure("request.malformed", 400);
      }
      return status;
    },
    catch: (cause) => cause,
  });

const approvalList = <E, R>(request: Request, options: ReceiptApiHttpOptions<E, R>) =>
  Effect.gen(function* () {
    const status = yield* decodeApprovalStatusFilter(request);
    const resolved =
      options.identity.resolveApprovalCredential === undefined
        ? undefined
        : yield* options.identity
            .resolveApprovalCredential(request)
            .pipe(Effect.catch((cause) => Effect.fail(invalidSessionFailure(request, cause))));
    if (
      resolved !== undefined &&
      resolved.credential.mechanism._tag === "OAuthServiceBearer" &&
      resolved.credential.principal._tag === "ServicePrincipal"
    ) {
      const credential = resolved.credential as AcceptedOAuthServiceCredential;
      const authority = yield* ServicePrincipalGrantAuthority.use(
        ({ readReceiptApprovalCandidates }) =>
          readReceiptApprovalCandidates(credential, resolved.authorizationInstant),
      ).pipe(
        Effect.catch(() =>
          Effect.fail(
            new ReceiptPersistenceError({
              operation: "read service receipt approval authority",
              message: "service receipt approval authority is unavailable",
            }),
          ),
        ),
      );
      const evaluation = evaluateServicePrincipalReceiptApprovalAccess(
        credential,
        authority,
        resolved.authorizationInstant,
      );
      if (evaluation._tag !== "Allow") {
        return jsonResponse({ error: { tag: "ReceiptScopeDenied" } }, 403);
      }
      const items = yield* Effect.try({
        try: () => {
          const allowed = new Set<string>(
            evaluation.resolution.contexts.flatMap((context) =>
              context.resource === null ? [] : [context.resource.id],
            ),
          );
          const seen = new Set<string>();
          return authority.candidates.flatMap(({ receipt }) => {
            if (seen.has(receipt.receiptId) || !allowed.has(receipt.receiptId)) return [];
            seen.add(receipt.receiptId);
            if (status !== undefined && receipt.status !== status) return [];
            const amountOre = Number(receipt.amountOre);
            if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
              throw new ReceiptPersistenceError({
                operation: "decode service approver projection",
                message: "invalid amount",
              });
            }
            return [
              {
                receiptId: receipt.receiptId,
                visualId: receipt.visualId,
                ownerPersonId: receipt.ownerPersonId,
                departmentId: receipt.departmentId,
                amountOre,
                currency: receipt.currency,
                description: receipt.description,
                receiptDate: receipt.receiptDate,
                status: receipt.status,
                revision: receipt.revision,
                etag: receiptEtag(receipt.receiptId, receipt.revision),
              },
            ];
          });
        },
        catch: (cause) => cause,
      });
      return jsonResponse({ items, totalItems: items.length }, 200, "private, no-store");
    }

    const principal =
      resolved !== undefined && resolved.credential.principal._tag === "Person"
        ? {
            personId: resolved.credential.principal.personId,
            authorizationInstant: resolved.authorizationInstant,
          }
        : yield* authorizationPrincipalFor(request, options);
    const rows = yield* Economy.use(({ listReceiptsForApproval }) =>
      listReceiptsForApproval(principal.personId, principal.authorizationInstant, status),
    );
    const items = yield* Effect.try({
      try: () =>
        rows.map((row) => {
          const amountOre = Number(row.amountOre);
          if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
            throw new ReceiptPersistenceError({
              operation: "decode approver projection",
              message: "invalid amount",
            });
          }
          return {
            receiptId: row.receiptId,
            visualId: row.visualId,
            ownerPersonId: row.ownerPersonId,
            departmentId: row.departmentId,
            amountOre,
            currency: row.currency,
            description: row.description,
            receiptDate: row.receiptDate,
            status: row.status,
            revision: row.revision,
            etag: receiptEtag(row.receiptId, row.revision),
          };
        }),
      catch: (cause) => cause,
    });
    return jsonResponse({ items, totalItems: items.length }, 200, "private, no-store");
  });

/**
 * Reads one approver-visible receipt file without granting owner access.
 * Credential resolution and rule-aware metadata selection share one snapshot.
 */
const approvalReceiptFile = <E, R>(
  request: Request,
  receiptId: string,
  options: ReceiptApiHttpOptions<E, R>,
  fileStore: ReceiptFileStore,
) => {
  let synchronized = false;
  return Effect.gen(function* () {
    const sql = yield* Database;
    const file = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
        const authenticated = yield* resolveRequestCredentialInTransaction(
          request,
          "OAuthUserBearer",
          { now: options.now },
        ).pipe(Effect.mapError((cause) => invalidSessionFailure(request, cause)));
        const principal = authenticated.credential.principal;
        if (principal._tag !== "Person") {
          return yield* Effect.fail(new HttpSemanticFailure("credential.invalid", 401));
        }
        const barrier = options.e2eTransactionBarrier;
        if (barrier !== undefined) {
          synchronized = yield* Effect.tryPromise({
            try: () => barrier(request, receiptId, "file-read"),
            catch: (cause) => cause,
          });
        }
        return yield* Economy.use(({ readReceiptFileForApproval }) =>
          readReceiptFileForApproval(
            receiptId,
            principal.personId,
            authenticated.authorizationInstant,
          ).pipe(
            Effect.catchTag("ReceiptNotFound", () =>
              Effect.fail(new HttpSemanticFailure("resource.not-found", 404)),
            ),
            Effect.catchTag("ReceiptDecodeError", () =>
              Effect.fail(new HttpSemanticFailure("receipts.unavailable", 503)),
            ),
          ),
        );
      }),
    );
    return yield* readPrivateReceiptFile(
      file,
      fileStore,
      options.config.maxFileBytes,
      synchronized ? { [RECEIPT_E2E_CONCURRENCY_RESPONSE_HEADER]: "1" } : {},
    );
  });
};

/** Native HttpApi implementations for receipt lifecycle endpoints. */
export const ReceiptApiHandlers = <E, R>(input: ReceiptApiHttpOptions<E, R>) => {
  const fileStore =
    input.fileStore ??
    makeReceiptFileStore({
      stagingRoot: input.config.stagingRoot,
      committedRoot: input.config.committedRoot,
      failNextPromotionEffectId: input.config.e2eTestMode
        ? input.config.e2eFailNextPromotionEffectId
        : undefined,
    });
  const approvalOptions =
    input.config.e2eTestMode === true
      ? { ...input, e2eTransactionBarrier: makeReceiptE2ETransactionBarrier() }
      : input;
  return HttpApiBuilder.group(ExternalNativeApi, "receipts", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("readReceiptFile", ({ request, params }) =>
          toPrivateFileHttpApiResponse(request, (webRequest) =>
            Effect.gen(function* () {
              const sql = yield* Database;
              const file = yield* sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
                  const authenticated = yield* resolveRequestCredentialInTransaction(
                    webRequest,
                    "OAuthUserBearer",
                    { now: input.now },
                  );
                  const principal = authenticated.credential.principal;
                  if (principal._tag !== "Person") {
                    return yield* Effect.fail(new HttpSemanticFailure("credential.invalid", 401));
                  }
                  const owned = yield* readOwnedReceiptFile(params.receiptId, principal.personId);
                  if (owned === undefined) {
                    return yield* Effect.fail(new HttpSemanticFailure("resource.not-found", 404));
                  }
                  const resource = {
                    kind: RECEIPT_RESOURCE_KIND,
                    id: ResourceId.make(params.receiptId),
                  };
                  const evaluation = evaluateAccess({
                    spec: Option.getOrThrow(reflectAccessSpec(ReadReceiptFileEndpoint)),
                    credential: authenticated.credential,
                    resolution: {
                      selection: "ExactlyOne",
                      contexts: [
                        {
                          domainId: RECEIPT_DOMAIN_ID,
                          departmentId: DepartmentId.make(owned.departmentId),
                          resource,
                          facts: {
                            ownerPersonId: principal.personId,
                            state: owned.status,
                            approverPersonIds: [],
                            approverServicePrincipalIds: [],
                            internalEvidenceEnabled: false,
                          } satisfies ReceiptAccessFacts,
                          authorityVersion: AuthorityVersion.make(`receipt:${owned.revision}`),
                        },
                      ],
                    },
                    grants: [
                      makeGrant({
                        grantId: GrantId.make(`receipt-owner:${params.receiptId}`),
                        subject: principal,
                        capability: { type: CapabilityTypeId.make("receipts.read-owned") },
                        scope: { _tag: "Resource", resource },
                        startAt: AuthorizationInstant.make("1970-01-01T00:00:00.000Z"),
                        endAt: null,
                        requirements: [],
                        source: AuthorityRef.make("economy_receipts.owner_person_id"),
                        revision: owned.revision,
                      }),
                    ],
                    authorizationInstant: authenticated.authorizationInstant,
                  });
                  if (evaluation._tag !== "Allow") {
                    return yield* Effect.fail(new HttpSemanticFailure("authority.denied", 403));
                  }
                  return owned.file;
                }),
              );
              return yield* readPrivateReceiptFile(file, fileStore, input.config.maxFileBytes);
            }),
          ),
        )
        .handleRaw("readReceiptFileForApproval", ({ request, params }) =>
          toPrivateFileHttpApiResponse(request, (webRequest) =>
            approvalReceiptFile(webRequest, params.receiptId, approvalOptions, fileStore),
          ),
        )
        .handleRaw("submitReceipt", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => submitV2(webRequest, input, fileStore),
            publicReceiptErrorResponse,
          ),
        )
        .handleRaw("reviseReceipt", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => reviseV2(webRequest, params.receiptId, input, fileStore),
            publicReceiptErrorResponse,
          ),
        )
        .handleRaw("withdrawReceipt", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => withdrawV2(webRequest, params.receiptId, input, fileStore),
            publicReceiptErrorResponse,
          ),
        )
        .handleRaw("listReceipts", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => listOwnedV2(webRequest, input),
            publicReceiptErrorResponse,
          ),
        )
        .handleRaw("listReceiptsForApproval", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => approvalList(webRequest, input),
            publicReceiptErrorResponse,
          ),
        )
        .handleRaw("refundReceipt", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              approvalCommandV2(
                webRequest,
                { action: "refund", receiptId: params.receiptId },
                approvalOptions,
                fileStore,
              ),
            publicReceiptErrorResponse,
          ),
        )
        .handleRaw("rejectReceipt", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              approvalCommandV2(
                webRequest,
                { action: "reject", receiptId: params.receiptId },
                approvalOptions,
                fileStore,
              ),
            publicReceiptErrorResponse,
          ),
        )
        .handleRaw("reopenReceipt", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              approvalCommandV2(
                webRequest,
                { action: "reopen", receiptId: params.receiptId },
                approvalOptions,
                fileStore,
              ),
            publicReceiptErrorResponse,
          ),
        ),
    ),
  );
};

/** Native HttpApi implementation for the internal receipt evidence endpoint. */
export const InternalReceiptApiHandlers = <E, R>(input: ReceiptApiHttpOptions<E, R>) =>
  HttpApiBuilder.group(InternalNativeApi, "internal", (handlers) =>
    Effect.succeed(
      handlers.handleRaw("readReceiptEvidence", ({ request, params }) =>
        toHttpApiResponse(
          request,
          (webRequest) => receiptLifecycleEvidence(webRequest, params.receiptId, input),
          errorResponse,
        ),
      ),
    ),
  );

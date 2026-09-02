import { randomUUID } from "node:crypto";

import {
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
import { Database } from "@vektorprogrammet/domain/database";
import {
  executeNativeHttpCommandPostgres,
  type NativeHttpResponseCapsule,
} from "@vektorprogrammet/domain/http-semantics";
import { IdentitySnapshot, OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { Effect } from "effect";
import {
  Economy,
  ReceiptAuxiliaryEffectConflict,
  ReceiptAuxiliaryEffects,
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
  type ReceiptOutboxDeliveryResult,
  type ReceiptStatus,
  type ReceiptSubmissionAllocation,
  type OwnedReceiptProjectionItem,
} from "@vektorprogrammet/domain/receipt";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { ExternalNativeApi, InternalNativeApi } from "@vektorprogrammet/http-api";
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
import {
  nativeCommandOutcomeResponse,
  prepareNativeHttpCommand,
} from "../native-operation.js";
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

export interface ReceiptIdentityResolvers {
  /** Request credential -> canonical person and one instant; never role or authority facts. */
  readonly resolveAuthorizationPrincipal: (request: Request) => Promise<ReceiptCommandPrincipal>;
  /** Request credential -> owner person id; no role or authority facts. */
  readonly resolvePersonId: (request: Request) => Promise<string>;
  /** Exact row 42 credential bridge; no token-carried authorization facts. */
  readonly resolveApprovalCredential?: (request: Request) => Promise<{
    readonly credential: AcceptedCredential;
    readonly authorizationInstant: AuthorizationInstant;
  }>;
}

export interface ReceiptApiHttpOptions {
  readonly config: ReceiptApiConfig;
  readonly identity: ReceiptIdentityResolvers;
  readonly run: <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | Database
      | Economy
      | IdentitySnapshot
      | OAuthCredentialAuthority
      | ServicePrincipalGrantAuthority
    >,
  ) => Promise<A>;
  readonly now?: () => string;
  readonly fileStore?: ReceiptFileStore;
  /**
   * Stable worker claim identity used to recover its stale in-flight effects.
   * The composition root may supply an operationally durable identity.
   */
  readonly outboxClaimId?: string;
}

interface ErrorBody {
  readonly error: { readonly tag: string; readonly message?: string };
}

const COMPOSED_DENIAL_MESSAGES = {
  AmbiguousParameterFill: "Authorization parameter fill is ambiguous",
  FailedComposedRequirement: "Composed authorization requirement failed",
} as const;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
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

const decodeMultipartFields = async (
  request: Request,
  maxFileBytes: number,
): Promise<Map<string, Array<string | File>>> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new ReceiptDecodeError({ message: "multipart form required" });
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength === null || !/^\d+$/.test(contentLength)) {
    throw new ReceiptDecodeError({ message: "valid body length required" });
  }
  const bodyLength = Number(contentLength);
  if (!Number.isSafeInteger(bodyLength) || bodyLength <= 0 || bodyLength > maxFileBytes + 131_072) {
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
};

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

const authorizationPrincipalFor = async (
  request: Request,
  options: ReceiptApiHttpOptions,
): Promise<ReceiptCommandPrincipal> => {
  try {
    return await options.identity.resolveAuthorizationPrincipal(request);
  } catch (cause) {
    if (cause !== null && typeof cause === "object" && "_tag" in cause) throw cause;
    throw new UnauthenticatedActor({ message: "authentication required" });
  }
};
const authorizationPrincipalInTransaction = async (
  request: Request,
  options: ReceiptApiHttpOptions,
  run: ReceiptApiHttpOptions["run"],
): Promise<ReceiptCommandPrincipal> => {
  const authenticated = await resolveRequestCredentialInTransaction(
    request,
    "OAuthUserBearer",
    { run, now: options.now },
  );
  if (authenticated.credential.principal._tag !== "Person") {
    throw new UnauthenticatedActor({ message: "authentication required" });
  }
  return {
    personId: authenticated.credential.principal.personId,
    authorizationInstant: authenticated.authorizationInstant,
  };
};


type ReceiptApprovalRoute = {
  readonly action: "refund" | "reject";
  readonly receiptId: string;
};

interface ReceiptAccessRow {
  readonly ownerPersonId: string;
  readonly departmentId: string;
  readonly status: string;
  readonly revision: number;
}

const receiptLifecycleEvidence = async (
  request: Request,
  receiptId: string,
  options: ReceiptApiHttpOptions,
): Promise<Response> => {
  const authorizationInstant = AuthorizationInstant.make(
    options.now?.() ?? new Date().toISOString(),
  );
  return runDatabase(
    Effect.gen(function* () {
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
    }),
    options.run,
  );
};
const runDatabase = <A>(
  effect: Effect.Effect<A, unknown, Database | Economy | IdentitySnapshot>,
  run: ReceiptApiHttpOptions["run"],
): Promise<A> => run(effect);

const auxiliaryEffects = (() => {
  const applied = new Map<string, string>();
  return ReceiptAuxiliaryEffects.of({
    apply: (request) =>
      Effect.gen(function* () {
        const digest = JSON.stringify(request);
        const previous = applied.get(request.effectId);
        if (previous !== undefined && previous !== digest) {
          return yield* new ReceiptAuxiliaryEffectConflict({ effectId: request.effectId });
        }
        yield* Effect.sync(() => void applied.set(request.effectId, digest));
      }),
  });
})();

const DEFAULT_OUTBOX_CLAIM_ID = `backend-${process.pid}`;
const STALE_OUTBOX_CLAIM_AGE_MS = 60_000;

const deliverOutbox = (
  claimId: string,
  claimedAt: string,
  options: ReceiptApiHttpOptions,
  fileStore: ReceiptFileStore,
  receiptId: string,
): Promise<ReceiptOutboxDeliveryResult> =>
  options.run(
    Economy.use(({ deliverNextOutboxEffect }) =>
      deliverNextOutboxEffect(claimId, claimedAt, receiptId),
    ).pipe(
      Effect.provideService(ReceiptFileService, fileStore.service),
      Effect.provideService(ReceiptAuxiliaryEffects, auxiliaryEffects),
    ),
  );

const staleOutboxCutoff = (now: string): string => {
  const timestamp = Date.parse(now);
  return Number.isFinite(timestamp)
    ? new Date(timestamp - STALE_OUTBOX_CLAIM_AGE_MS).toISOString()
    : now;
};

const drainOutbox = async (
  options: ReceiptApiHttpOptions,
  fileStore: ReceiptFileStore,
  receiptId: string,
): Promise<"Idle" | "Failed" | "Limit"> => {
  const claimBase = options.outboxClaimId ?? DEFAULT_OUTBOX_CLAIM_ID;
  const claimId = `${claimBase}-${randomUUID()}`;
  const claimedBefore = staleOutboxCutoff(options.config.now());
  let staleClaimIds: ReadonlyArray<string> = [];
  try {
    staleClaimIds = await runDatabase(
      Economy.use(({ listStaleOutboxClaims }) => listStaleOutboxClaims(claimedBefore, receiptId)),
      options.run,
    );
  } catch {
    // Delivery remains best-effort after the authority transaction commits.
  }
  for (const staleClaimId of staleClaimIds) {
    try {
      await runDatabase(
        Economy.use(({ recoverStaleOutboxClaim }) =>
          recoverStaleOutboxClaim(staleClaimId, claimedBefore),
        ),
        options.run,
      );
    } catch {
      // A concurrent worker may have completed or recovered this exact claim.
    }
  }
  for (let attempt = 0; attempt < 256; attempt += 1) {
    let result: ReceiptOutboxDeliveryResult;
    try {
      result = await deliverOutbox(claimId, options.config.now(), options, fileStore, receiptId);
    } catch {
      return "Failed";
    }
    if (result._tag === "Idle") return "Idle";
    if (result._tag === "Failed") return "Failed";
  }
  return "Limit";
};

interface V2SubmitFields {
  readonly description: string;
  readonly amountOre: number;
  readonly receiptDate: string;
  readonly file: File;
  readonly contentType: SupportedContentType;
}

interface V2ReviseFields {
  readonly description?: string;
  readonly amountOre?: number;
  readonly receiptDate?: string;
  readonly file?: File;
  readonly contentType?: SupportedContentType;
}

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

const receiptResource = (receipt: Receipt) => {
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

const decodeV2SubmitMultipart = async (
  request: Request,
  maxFileBytes: number,
): Promise<V2SubmitFields> => {
  const fields = await decodeMultipartFields(request, maxFileBytes);
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
  if (!isIsoDate(receiptDate)) throw new ReceiptDecodeError({ message: "invalid receipt date" });
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
};

const decodeV2ReviseMultipart = async (
  request: Request,
  maxFileBytes: number,
): Promise<V2ReviseFields> => {
  const fields = await decodeMultipartFields(request, maxFileBytes);
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
    throw new ReceiptDecodeError({ message: "receipt revision must change at least one field" });
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
};

const decodeExactEmptyJson = async (request: Request): Promise<Record<string, never>> => {
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
};

const normalizedSubmitQuery = (request: Request): DepartmentId | undefined => {
  const entries = [...new URL(request.url).searchParams.entries()];
  if (
    entries.some(([name]) => name !== "departmentId") ||
    entries.filter(([name]) => name === "departmentId").length > 1
  ) {
    throw new HttpSemanticFailure("request.malformed", 400);
  }
  const value = entries[0]?.[1];
  if (value === undefined) return undefined;
  if (value.trim().length === 0) throw new ReceiptDecodeError({ message: "invalid departmentId" });
  return DepartmentId.make(value);
};

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
  readonly response: {
    readonly status: 200 | 201;
    readonly location?: string;
    readonly ifMatch?: string;
    readonly currentEtag?: string;
  };
  readonly allocation?: ReceiptSubmissionAllocation;
}

const executeV2ReceiptMutation = (
  options: ReceiptApiHttpOptions,
  prepare: (run: ReceiptApiHttpOptions["run"]) => Promise<PreparedV2ReceiptMutation>,
) =>
  options.run(
    executeNativeHttpCommandPostgres(
      prepareNativeHttpCommand(options.run, async (txRun) => {
        const prepared = await prepare(txRun);
        return {
          identity: {
            identitySha256: prepared.identity.identitySha256,
            requestSha256: prepared.requestSha256,
            operationId: prepared.operationId,
          },
          execute: Economy.use(({ executeReceipt }) =>
            Effect.gen(function* () {
              if (
                prepared.response.ifMatch !== undefined &&
                prepared.response.currentEtag !== undefined &&
                prepared.response.ifMatch !== prepared.response.currentEtag
              ) {
                return yield* Effect.fail(new HttpSemanticFailure("precondition.failed", 412));
              }
              const result = yield* executeReceipt(
                prepared.command,
                prepared.principal,
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
    ),
  );

const currentOwnedReceipt = async (
  principal: ReceiptCommandPrincipal,
  receiptId: string,
  options: ReceiptApiHttpOptions,
  run: ReceiptApiHttpOptions["run"] = options.run,
): Promise<OwnedReceiptProjectionItem> => {
  const rows = await runDatabase(
    Economy.use(({ listOwnedReceipts }) => listOwnedReceipts(principal.personId)),
    run,
  );
  const current = rows.find((row) => row.receiptId === receiptId);
  if (current === undefined) throw new ReceiptNotFound({ receiptId });
  return current;
};

const currentApprovalReceipt = async (
  principal: ReceiptCommandPrincipal,
  receiptId: string,
  options: ReceiptApiHttpOptions,
  run: ReceiptApiHttpOptions["run"] = options.run,
) => {
  const rows = await runDatabase(
    Economy.use(({ listReceiptsForApproval }) =>
      listReceiptsForApproval(
        PersonId.make(principal.personId),
        AuthorizationInstant.make(principal.authorizationInstant),
      ),
    ),
    run,
  );
  const current = rows.find((row) => row.receiptId === receiptId);
  if (current === undefined) {
    throw new HttpSemanticFailure("authority.denied", 403);
  }
  return current;
};
const ownedReceiptResource = (receipt: OwnedReceiptProjectionItem) => {
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
    submittedAt: receipt.submittedAt,
    revision: receipt.revision,
    etag: receiptEtag(receipt.receiptId, receipt.revision),
  };
};

const listOwnedV2 = async (request: Request, options: ReceiptApiHttpOptions): Promise<Response> => {
  const entries = [...new URL(request.url).searchParams.entries()];
  if (
    entries.some(([name]) => name !== "status") ||
    entries.filter(([name]) => name === "status").length > 1
  ) {
    throw new HttpSemanticFailure("request.malformed", 400);
  }
  const selectedStatus = entries[0]?.[1];
  if (selectedStatus !== undefined && !isReceiptStatus(selectedStatus)) {
    throw new ReceiptDecodeError({ message: "invalid receipt status" });
  }
  const principal = await authorizationPrincipalFor(request, options);
  const rows = await runDatabase(
    Economy.use(({ listOwnedReceipts }) => listOwnedReceipts(principal.personId, selectedStatus)),
    options.run,
  );
  const items = rows.map(ownedReceiptResource);
  return jsonResponse({ items, totalItems: items.length });
};

const submitV2 = async (
  request: Request,
  options: ReceiptApiHttpOptions,
  fileStore: ReceiptFileStore,
): Promise<Response> => {
  const departmentId = normalizedSubmitQuery(request);
  const fields = await decodeV2SubmitMultipart(request, options.config.maxFileBytes);

  let staged: StagedReceiptFile | undefined;
  let allocation: ReceiptSubmissionAllocation | undefined;
  let committed = false;
  try {
    const outcome = await executeV2ReceiptMutation(options, async (txRun) => {
      const principal = await authorizationPrincipalInTransaction(request, options, txRun);
      const identity = mutationIdentity(
        request,
        principal,
        "receipts.submitReceipt",
        "/api/receipts",
      );
      staged = await fileStore.stageBytes(
        fields.file,
        identity.commandId,
        fields.contentType,
        options.config.maxFileBytes,
      );
      await txRun(fileStore.service.stage(staged.file));
      const semanticBody = {
        ...(departmentId === undefined ? {} : { departmentId }),
        description: fields.description,
        amountOre: fields.amountOre,
        receiptDate: fields.receiptDate,
        file: {
          contentType: staged.file.contentType,
          byteLength: staged.file.byteLength,
          sha256: staged.file.sha256,
        },
      };
      const command = {
        _tag: "SubmitReceipt" as const,
        commandId: identity.commandId,
        ...(departmentId === undefined ? {} : { departmentId }),
        description: fields.description,
        amountOre: fields.amountOre,
        receiptDate: fields.receiptDate,
        file: staged.file,
      };
      allocation = {
        receiptId: ReceiptId.make(options.config.nextReceiptId()),
        visualId: ReceiptVisualId.make(options.config.nextVisualId()),
      };
      return {
        identity,
        operationId: "receipts.submitReceipt",
        requestSha256: semanticRequestDigest({ body: semanticBody }),
        command,
        principal,
        response: {
          status: 201,
          location: `/api/receipts/${encodeURIComponent(allocation.receiptId)}`,
        },
        allocation,
      };
    });
    if (outcome._tag === "Committed") {
      if (allocation === undefined) {
        throw new ReceiptPersistenceError({
          operation: "submit receipt allocation",
          message: "transaction preparation produced no allocation",
        });
      }
      committed = true;
      await drainOutbox(options, fileStore, allocation.receiptId);
    } else if (staged?.created === true) {
      await fileStore.cleanupStage(staged.file).catch(() => undefined);
    }
    return nativeCommandOutcomeResponse(outcome);
  } finally {
    if (!committed && staged?.created === true) {
      await fileStore.cleanupStage(staged.file).catch(() => undefined);
    }
  }
};

const reviseV2 = async (
  request: Request,
  receiptId: string,
  options: ReceiptApiHttpOptions,
  fileStore: ReceiptFileStore,
): Promise<Response> => {
  const ifMatch = parseRequiredIfMatch(headerValues(request, "if-match"));
  const fields = await decodeV2ReviseMultipart(request, options.config.maxFileBytes);
  let staged: StagedReceiptFile | undefined;
  let committed = false;
  try {
    const outcome = await executeV2ReceiptMutation(options, async (txRun) => {
      const principal = await authorizationPrincipalInTransaction(request, options, txRun);
      const current = await currentOwnedReceipt(principal, receiptId, options, txRun);
      const identity = mutationIdentity(
        request,
        principal,
        "receipts.reviseReceipt",
        `/api/receipts/${encodeURIComponent(receiptId)}`,
      );
      if (fields.file !== undefined) {
        if (fields.contentType === undefined) {
          throw new ReceiptDecodeError({ message: "invalid receipt file" });
        }
        staged = await fileStore.stageBytes(
          fields.file,
          identity.commandId,
          fields.contentType,
          options.config.maxFileBytes,
        );
        await txRun(fileStore.service.stage(staged.file));
      }
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
        amountOre:
          fields.amountOre ??
          (() => {
            const value = Number(current.amountOre);
            if (!Number.isSafeInteger(value) || value <= 0) {
              throw new ReceiptPersistenceError({
                operation: "decode current receipt amount",
                message: "invalid amount",
              });
            }
            return value;
          })(),
        receiptDate: fields.receiptDate ?? current.receiptDate,
        file: staged?.file ?? { _tag: "KeepCurrentFile" as const },
      };
      return {
        identity,
        operationId: "receipts.reviseReceipt",
        requestSha256: semanticRequestDigest(
          semanticMutationRequest(semanticBody, ifMatch),
        ),
        command,
        principal,
        response: {
          status: 200,
          ifMatch,
          currentEtag: receiptEtag(receiptId, current.revision),
        },
      };
    });
    if (outcome._tag === "Committed") {
      committed = true;
      await drainOutbox(options, fileStore, receiptId);
    } else if (staged?.created === true) {
      await fileStore.cleanupStage(staged.file).catch(() => undefined);
    }
    return nativeCommandOutcomeResponse(outcome);
  } finally {
    if (!committed && staged?.created === true) {
      await fileStore.cleanupStage(staged.file).catch(() => undefined);
    }
  }
};

const withdrawV2 = async (
  request: Request,
  receiptId: string,
  options: ReceiptApiHttpOptions,
  fileStore: ReceiptFileStore,
): Promise<Response> => {
  const ifMatch = parseRequiredIfMatch(headerValues(request, "if-match"));
  const body = await decodeExactEmptyJson(request);
  const outcome = await executeV2ReceiptMutation(options, async (txRun) => {
    const principal = await authorizationPrincipalInTransaction(request, options, txRun);
    const current = await currentOwnedReceipt(principal, receiptId, options, txRun);
    const identity = mutationIdentity(
      request,
      principal,
      "receipts.withdrawReceipt",
      `/api/receipts/${encodeURIComponent(receiptId)}/withdraw`,
    );
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
      response: {
        status: 200,
        ifMatch,
        currentEtag: receiptEtag(receiptId, current.revision),
      },
    };
  });
  if (outcome._tag === "Committed") await drainOutbox(options, fileStore, receiptId);
  return nativeCommandOutcomeResponse(outcome);
};

const approvalCommandV2 = async (
  request: Request,
  route: ReceiptApprovalRoute,
  options: ReceiptApiHttpOptions,
  fileStore: ReceiptFileStore,
): Promise<Response> => {
  const ifMatch = parseRequiredIfMatch(headerValues(request, "if-match"));
  const body = await decodeExactEmptyJson(request);
  const operationId =
    route.action === "refund" ? "receipts.refundReceipt" : "receipts.rejectReceipt";
  const normalizedTarget = `/api/receipts/${encodeURIComponent(route.receiptId)}/${route.action}`;
  const outcome = await executeV2ReceiptMutation(options, async (txRun) => {
    const principal = await authorizationPrincipalInTransaction(request, options, txRun);
    const current = await currentApprovalReceipt(principal, route.receiptId, options, txRun);
    const identity = mutationIdentity(request, principal, operationId, normalizedTarget);
    return {
      identity,
      operationId,
      requestSha256: semanticRequestDigest(semanticMutationRequest(body, ifMatch)),
      command: {
        _tag: route.action === "refund" ? ("RefundReceipt" as const) : ("RejectReceipt" as const),
        commandId: identity.commandId,
        receiptId: route.receiptId,
        expectedRevision: current.revision,
      },
      principal,
      response: {
        status: 200,
        ifMatch,
        currentEtag: receiptEtag(route.receiptId, current.revision),
      },
    };
  });
  if (outcome._tag === "Committed") await drainOutbox(options, fileStore, route.receiptId);
  return nativeCommandOutcomeResponse(outcome);
};

const decodeApprovalStatusFilter = (request: Request): ReceiptStatus | undefined => {
  const entries = [...new URL(request.url).searchParams.entries()];
  const statusEntries = entries.filter(([name]) => name === "status");
  if (entries.some(([name]) => name !== "status") || statusEntries.length > 1) {
    throw new ReceiptDecodeError({ message: "invalid receipt filter" });
  }
  const status = statusEntries[0]?.[1];
  if (status === undefined) return undefined;
  if (!isReceiptStatus(status)) {
    throw new ReceiptDecodeError({ message: "invalid receipt status filter" });
  }
  return status;
};

const approvalList = async (
  request: Request,
  options: ReceiptApiHttpOptions,
): Promise<Response> => {
  const status = decodeApprovalStatusFilter(request);
  const resolved = await options.identity.resolveApprovalCredential?.(request);
  if (
    resolved !== undefined &&
    resolved.credential.mechanism._tag === "OAuthServiceBearer" &&
    resolved.credential.principal._tag === "ServicePrincipal"
  ) {
    const credential = resolved.credential as AcceptedOAuthServiceCredential;
    const authority = await options
      .run(
        ServicePrincipalGrantAuthority.use(({ readReceiptApprovalCandidates }) =>
          readReceiptApprovalCandidates(credential, resolved.authorizationInstant),
        ),
      )
      .catch(() => {
        throw new ReceiptPersistenceError({
          operation: "read service receipt approval authority",
          message: "service receipt approval authority is unavailable",
        });
      });
    const evaluation = evaluateServicePrincipalReceiptApprovalAccess(
      credential,
      authority,
      resolved.authorizationInstant,
    );
    if (evaluation._tag !== "Allow") {
      return jsonResponse({ error: { tag: "ReceiptScopeDenied" } }, 403);
    }
    const allowed = new Set<string>(
      evaluation.resolution.contexts.flatMap((context) =>
        context.resource === null ? [] : [context.resource.id],
      ),
    );
    const seen = new Set<string>();
    const items = authority.candidates.flatMap(({ receipt }) => {
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
          etag: deriveStrongETag({
            representationKind: "ReceiptApprovalQueueItem",
            resourceIdentity: receipt.receiptId,
            version: receipt.revision,
          }),
        },
      ];
    });
    return jsonResponse({ items, totalItems: items.length });
  }

  const principal =
    resolved !== undefined && resolved.credential.principal._tag === "Person"
      ? {
          personId: resolved.credential.principal.personId,
          authorizationInstant: resolved.authorizationInstant,
        }
      : await authorizationPrincipalFor(request, options);
  const rows = await runDatabase(
    Economy.use(({ listReceiptsForApproval }) =>
      listReceiptsForApproval(principal.personId, principal.authorizationInstant, status),
    ),
    options.run,
  );
  const items = rows.map((row) => {
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
      etag: deriveStrongETag({
        representationKind: "ReceiptApprovalQueueItem",
        resourceIdentity: row.receiptId,
        version: row.revision,
      }),
    };
  });
  return jsonResponse({ items, totalItems: items.length });
};

/** Native HttpApi implementations for receipt lifecycle endpoints. */
export const ReceiptApiHandlers = (input: ReceiptApiHttpOptions) => {
  const fileStore =
    input.fileStore ??
    makeReceiptFileStore({
      stagingRoot: input.config.stagingRoot,
      committedRoot: input.config.committedRoot,
      failNextPromotionEffectId: input.config.e2eTestMode
        ? input.config.e2eFailNextPromotionEffectId
        : undefined,
    });
  return HttpApiBuilder.group(ExternalNativeApi, "receipts", (handlers) =>
    Effect.succeed(
      handlers
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
                input,
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
                input,
                fileStore,
              ),
            publicReceiptErrorResponse,
          ),
        ),
    ),
  );
};

/** Native HttpApi implementation for the internal receipt evidence endpoint. */
export const InternalReceiptApiHandlers = (input: ReceiptApiHttpOptions) =>
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

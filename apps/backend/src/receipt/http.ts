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
  accessHttpStatus,
  evaluateAccess,
  makeGrant,
  type AccessEvaluation,
  type ReceiptAccessFacts,
} from "@vektorprogrammet/domain/authz";
import { Database } from "@vektorprogrammet/domain/database";
import { IdentitySnapshot } from "@vektorprogrammet/database";
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
  type ReceiptCommandPrincipal,
  type ReceiptObservation,
  type ReceiptOutboxDeliveryResult,
  type ReceiptStatus,
  type ReceiptSubmissionAllocation,
} from "@vektorprogrammet/domain/receipt";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { ExternalNativeApi, InternalNativeApi } from "@vektorprogrammet/http-api";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { toHttpApiResponse } from "../http-api/transport.js";
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

interface SubmitFields {
  readonly commandId: string;
  readonly description: string;
  readonly amountOre: number;
  readonly receiptDate: string;
  readonly file: File;
  readonly contentType: SupportedContentType;
}

interface ReviseFields {
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly description: string;
  readonly amountOre: number;
  readonly receiptDate: string;
  readonly file?: File;
  readonly contentType?: SupportedContentType;
}

interface WithdrawFields {
  readonly commandId: string;
  readonly expectedRevision: number;
}

export interface ReceiptIdentityResolvers {
  /** Cookie -> canonical person and one instant; never role or authority facts. */
  readonly resolveAuthorizationPrincipal: (
    cookieHeader: string | undefined,
  ) => Promise<ReceiptCommandPrincipal>;
  /** Cookie -> owner person id (session-only; no role facts). */
  readonly resolvePersonId: (cookieHeader: string | undefined) => Promise<string>;
}

export interface ReceiptApiHttpOptions {
  readonly config: ReceiptApiConfig;
  readonly identity: ReceiptIdentityResolvers;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, Database | Economy | IdentitySnapshot>,
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
      "content-type": "application/json; charset=utf-8",
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
const parseSafeRevision = (value: string): number => {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new ReceiptDecodeError({ message: "invalid expectedRevision" });
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new ReceiptDecodeError({ message: "invalid expectedRevision" });
  }
  return revision;
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

const decodeMultipart = async (request: Request, maxFileBytes: number): Promise<SubmitFields> => {
  const fields = await decodeMultipartFields(request, maxFileBytes);
  const expected = {
    commandId: true,
    description: true,
    amountOre: true,
    receiptDate: true,
    file: true,
  } as const;
  requireMultipartFields(fields, expected);

  const commandId = readSingleField(fields, "commandId");
  const description = readSingleField(fields, "description");
  const amountOre = parseSafeAmountOre(readSingleField(fields, "amountOre"));
  const receiptDate = readSingleField(fields, "receiptDate");
  if (commandId.length === 0 || description.length < 1 || description.length > 5000) {
    throw new ReceiptDecodeError({ message: "invalid receipt text" });
  }
  if (!isIsoDate(receiptDate)) throw new ReceiptDecodeError({ message: "invalid receipt date" });

  const decodedFile = decodeReceiptFile(fields, maxFileBytes, true);
  if (decodedFile.file === undefined || decodedFile.contentType === undefined) {
    throw new ReceiptDecodeError({ message: "receipt file is required" });
  }
  return {
    commandId,
    description,
    amountOre,
    receiptDate,
    file: decodedFile.file,
    contentType: decodedFile.contentType,
  };
};

const decodeReviseMultipart = async (
  request: Request,
  maxFileBytes: number,
): Promise<ReviseFields> => {
  const fields = await decodeMultipartFields(request, maxFileBytes);
  const required = {
    commandId: true,
    expectedRevision: true,
    description: true,
    amountOre: true,
    receiptDate: true,
  } as const;
  const optional = { file: true } as const;
  requireMultipartFields(fields, required, optional);

  const commandId = readSingleField(fields, "commandId");
  const expectedRevision = parseSafeRevision(readSingleField(fields, "expectedRevision"));
  const description = readSingleField(fields, "description");
  const amountOre = parseSafeAmountOre(readSingleField(fields, "amountOre"));
  const receiptDate = readSingleField(fields, "receiptDate");
  if (commandId.length === 0 || description.length < 1 || description.length > 5000) {
    throw new ReceiptDecodeError({ message: "invalid receipt text" });
  }
  if (!isIsoDate(receiptDate)) throw new ReceiptDecodeError({ message: "invalid receipt date" });

  const decodedFile = decodeReceiptFile(fields, maxFileBytes, false);
  return {
    commandId,
    expectedRevision,
    description,
    amountOre,
    receiptDate,
    file: decodedFile.file,
    contentType: decodedFile.contentType,
  };
};

const personIdFor = async (request: Request, options: ReceiptApiHttpOptions): Promise<string> => {
  try {
    return await options.identity.resolvePersonId(request.headers.get("cookie") ?? undefined);
  } catch (cause) {
    if (cause !== null && typeof cause === "object" && "_tag" in cause) throw cause;
    throw new UnauthenticatedActor({ message: "authentication required" });
  }
};

const authorizationPrincipalFor = async (
  request: Request,
  options: ReceiptApiHttpOptions,
): Promise<ReceiptCommandPrincipal> => {
  try {
    return await options.identity.resolveAuthorizationPrincipal(
      request.headers.get("cookie") ?? undefined,
    );
  } catch (cause) {
    if (cause !== null && typeof cause === "object" && "_tag" in cause) throw cause;
    throw new UnauthenticatedActor({ message: "authentication required" });
  }
};
const decodeCommandJson = async (
  request: Request,
  operation: "withdraw" | "approval",
): Promise<WithdrawFields> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new ReceiptDecodeError({ message: "json body required" });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ReceiptDecodeError({ message: "invalid json body" });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ReceiptDecodeError({ message: `${operation} body must be an object` });
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    !Object.prototype.hasOwnProperty.call(record, "commandId") ||
    !Object.prototype.hasOwnProperty.call(record, "expectedRevision")
  ) {
    throw new ReceiptDecodeError({ message: `invalid ${operation} fields` });
  }
  const commandId = record.commandId;
  const expectedRevision = record.expectedRevision;
  if (
    typeof commandId !== "string" ||
    commandId.length === 0 ||
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    throw new ReceiptDecodeError({ message: `invalid ${operation} fields` });
  }
  return { commandId, expectedRevision };
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
const executeEconomyReceipt = (
  command: unknown,
  principal: ReceiptCommandPrincipal,
  options: ReceiptApiHttpOptions,
  allocation?: ReceiptSubmissionAllocation,
) => {
  const transaction = Economy.use(({ executeReceipt }) =>
    executeReceipt(command, principal, allocation),
  );
  return runDatabase(transaction, options.run);
};

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

const submit = async (
  request: Request,
  options: ReceiptApiHttpOptions,
  fileStore: ReceiptFileStore,
): Promise<Response> => {
  const queryEntries = [...new URL(request.url).searchParams.entries()];
  const selectedDepartments = queryEntries.filter(([name]) => name === "departmentId");
  if (queryEntries.some(([name]) => name !== "departmentId") || selectedDepartments.length > 1) {
    throw new ReceiptDecodeError({ message: "invalid receipt submission query" });
  }
  const selected = selectedDepartments[0]?.[1];
  if (selected !== undefined && selected.trim().length === 0) {
    throw new ReceiptDecodeError({ message: "invalid departmentId selection" });
  }
  const departmentId = selected === undefined ? undefined : DepartmentId.make(selected);
  const fields = await decodeMultipart(request, options.config.maxFileBytes);
  const principal = await authorizationPrincipalFor(request, options);
  let staged: StagedReceiptFile | undefined;
  let committed = false;
  try {
    staged = await fileStore.stageBytes(
      fields.file,
      fields.commandId,
      fields.contentType,
      options.config.maxFileBytes,
    );
    await options.run(fileStore.service.stage(staged.file));
    const command = {
      _tag: "SubmitReceipt" as const,
      commandId: fields.commandId,
      ...(departmentId === undefined ? {} : { departmentId }),
      description: fields.description,
      amountOre: fields.amountOre,
      receiptDate: fields.receiptDate,
      file: staged.file,
    };
    const allocation = {
      receiptId: ReceiptId.make(options.config.nextReceiptId()),
      visualId: ReceiptVisualId.make(options.config.nextVisualId()),
    };
    const result = await executeEconomyReceipt(command, principal, options, allocation);
    if (result.replayed && staged.created) await fileStore.cleanupStage(staged.file);
    committed = true;
    await drainOutbox(options, fileStore, result.observation.receiptId);
    const status = result.replayed ? 200 : 201;
    return jsonResponse(result.observation satisfies ReceiptObservation, status);
  } finally {
    if (!committed && staged?.created === true)
      await fileStore.cleanupStage(staged.file).catch(() => undefined);
  }
};

const revise = async (
  request: Request,
  receiptId: string,
  options: ReceiptApiHttpOptions,
  fileStore: ReceiptFileStore,
): Promise<Response> => {
  const fields = await decodeReviseMultipart(request, options.config.maxFileBytes);
  const principal = await authorizationPrincipalFor(request, options);
  let staged: StagedReceiptFile | undefined;
  let committed = false;
  try {
    if (fields.file !== undefined) {
      const contentType = fields.contentType;
      if (contentType === undefined) {
        throw new ReceiptDecodeError({ message: "invalid receipt file" });
      }
      staged = await fileStore.stageBytes(
        fields.file,
        fields.commandId,
        contentType,
        options.config.maxFileBytes,
      );
      await options.run(fileStore.service.stage(staged.file));
    }
    const command = {
      _tag: "RevisePendingReceipt" as const,
      commandId: fields.commandId,
      receiptId,
      expectedRevision: fields.expectedRevision,
      description: fields.description,
      amountOre: fields.amountOre,
      receiptDate: fields.receiptDate,
      file: staged?.file ?? { _tag: "KeepCurrentFile" as const },
    };
    const result = await executeEconomyReceipt(command, principal, options);
    if (result.replayed && staged?.created === true) {
      await fileStore.cleanupStage(staged.file).catch(() => undefined);
    }
    committed = true;
    await drainOutbox(options, fileStore, result.observation.receiptId);
    return jsonResponse(result.observation satisfies ReceiptObservation);
  } finally {
    if (!committed && staged?.created === true) {
      await fileStore.cleanupStage(staged.file).catch(() => undefined);
    }
  }
};

const withdraw = async (
  request: Request,
  receiptId: string,
  options: ReceiptApiHttpOptions,
  fileStore: ReceiptFileStore,
): Promise<Response> => {
  const principal = await authorizationPrincipalFor(request, options);
  const fields = await decodeCommandJson(request, "withdraw");
  const command = {
    _tag: "WithdrawPendingReceipt" as const,
    commandId: fields.commandId,
    receiptId,
    expectedRevision: fields.expectedRevision,
  };
  const result = await executeEconomyReceipt(command, principal, options);
  await drainOutbox(options, fileStore, result.observation.receiptId);
  return jsonResponse(result.observation satisfies ReceiptObservation);
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
  const principal = await authorizationPrincipalFor(request, options);
  const status = decodeApprovalStatusFilter(request);
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
    };
  });
  return jsonResponse({ items, totalItems: items.length });
};

const approvalCommand = async (
  request: Request,
  route: ReceiptApprovalRoute,
  options: ReceiptApiHttpOptions,
  fileStore: ReceiptFileStore,
): Promise<Response> => {
  const principal = await authorizationPrincipalFor(request, options);
  const fields = await decodeCommandJson(request, "approval");
  if (new URL(request.url).search.length !== 0) {
    throw new ReceiptDecodeError({ message: "unexpected receipt command query" });
  }
  const command = {
    _tag: route.action === "refund" ? ("RefundReceipt" as const) : ("RejectReceipt" as const),
    commandId: fields.commandId,
    receiptId: route.receiptId,
    expectedRevision: fields.expectedRevision,
  };
  const result = await executeEconomyReceipt(command, principal, options);
  await drainOutbox(options, fileStore, result.observation.receiptId);
  return jsonResponse(result.observation satisfies ReceiptObservation);
};

const list = async (request: Request, options: ReceiptApiHttpOptions): Promise<Response> => {
  const personId = await personIdFor(request, options);
  const statusParameter = new URL(request.url).searchParams.get("status");
  let status: ReceiptStatus | undefined;
  if (statusParameter !== null) {
    if (!isReceiptStatus(statusParameter)) {
      throw new ReceiptDecodeError({ message: "invalid receipt status filter" });
    }
    status = statusParameter;
  }
  const rows = await runDatabase(
    Economy.use(({ listOwnedReceipts }) => listOwnedReceipts(personId, status)),
    options.run,
  );
  const items = rows.map((row) => {
    const amountOre = Number(row.amountOre);
    if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
      throw new ReceiptPersistenceError({
        operation: "decode owner projection",
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
            (webRequest) => submit(webRequest, input, fileStore),
            errorResponse,
          ),
        )
        .handleRaw("reviseReceipt", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => revise(webRequest, params.receiptId, input, fileStore),
            errorResponse,
          ),
        )
        .handleRaw("withdrawReceipt", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => withdraw(webRequest, params.receiptId, input, fileStore),
            errorResponse,
          ),
        )
        .handleRaw("listReceipts", ({ request }) =>
          toHttpApiResponse(request, (webRequest) => list(webRequest, input), errorResponse),
        )
        .handleRaw("listReceiptsForApproval", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => approvalList(webRequest, input),
            errorResponse,
          ),
        )
        .handleRaw("refundReceipt", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              approvalCommand(
                webRequest,
                { action: "refund", receiptId: params.receiptId },
                input,
                fileStore,
              ),
            errorResponse,
          ),
        )
        .handleRaw("rejectReceipt", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              approvalCommand(
                webRequest,
                { action: "reject", receiptId: params.receiptId },
                input,
                fileStore,
              ),
            errorResponse,
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

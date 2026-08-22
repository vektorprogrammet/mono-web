import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  ReceiptAuxiliaryEffectConflict,
  InactiveActor,
  ReceiptAuthority,
  ReceiptAuxiliaryEffects,
  ReceiptDecodeError,
  ReceiptFileSchema,
  ReceiptFileService,
  ReceiptPersistenceError,
  ReceiptScopeDenied,
  type ReceiptFile,
  type ReceiptStatus,
  type ReceiptTransactionResult,
  UnauthenticatedActor,
  isIsoDate,
  type ReceiptObservation,
} from "@vektorprogrammet/domain/receipt";
import {
  ReceiptAuthorityPostgres,
  deliverNextReceiptOutbox,
  listApproverReceipts,
  listOwnedReceiptProjection,
  migrateReceiptPostgres,
  type ReceiptOutboxDeliveryResult,
} from "@vektorprogrammet/domain/receipt/postgres";
import { randomUUID } from "node:crypto";
import type { ReceiptApiConfig, ReceiptApiPrincipal } from "./config.js";
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

export interface ReceiptApiHttpOptions {
  readonly config: ReceiptApiConfig;
  readonly migrationSql: string;
  readonly postgresLayer: Layer.Layer<PgClient.PgClient, SqlError>;
  readonly fileStore?: ReceiptFileStore;
}

interface ErrorBody {
  readonly error: { readonly tag: string };
}

export interface ReceiptApiHttp {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly migrate: () => Promise<void>;
}

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
      : tag === "InactiveActor" || tag === "ReceiptOwnerDenied" || tag === "ReceiptScopeDenied"
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
  const body: ErrorBody = { error: { tag } };
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
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new ReceiptDecodeError({ message: "invalid body length" });
    }
    const bodyLength = Number(contentLength);
    if (!Number.isSafeInteger(bodyLength) || bodyLength > maxFileBytes + 131_072) {
      throw new ReceiptDecodeError({ message: "multipart body exceeds configured limit" });
    }
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

const principalFor = (
  request: Request,
  tokens: ReadonlyMap<string, ReceiptApiPrincipal>,
): ReceiptApiPrincipal => {
  const authorization = request.headers.get("authorization");
  const match = authorization === null ? undefined : /^Bearer ([^\s]+)$/.exec(authorization);
  const principal =
    match === null || match === undefined || match[1] === undefined
      ? undefined
      : tokens.get(match[1]);
  if (principal === undefined)
    throw new UnauthenticatedActor({ message: "authentication required" });
  return principal;
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

type ReceiptCommandRoute =
  | { readonly action: "revise"; readonly receiptId: string }
  | { readonly action: "withdraw"; readonly receiptId: string };

const receiptCommandRoute = (pathname: string): ReceiptCommandRoute | undefined => {
  const match = /^\/api\/receipts\/([^/]+)\/(revise|withdraw)$/.exec(pathname);
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  let receiptId: string;
  try {
    receiptId = decodeURIComponent(match[1]);
  } catch {
    throw new ReceiptDecodeError({ message: "invalid receipt id" });
  }
  if (receiptId.length === 0 || receiptId.includes("/")) {
    throw new ReceiptDecodeError({ message: "invalid receipt id" });
  }
  return match[2] === "revise"
    ? { action: "revise", receiptId }
    : { action: "withdraw", receiptId };
};
type ReceiptApprovalRoute = {
  readonly action: "refund" | "reject";
  readonly receiptId: string;
};

const receiptApprovalRoute = (pathname: string): ReceiptApprovalRoute | undefined => {
  const match = /^\/api\/admin\/receipts\/([^/]+)\/(refund|reject)$/.exec(pathname);
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  let receiptId: string;
  try {
    receiptId = decodeURIComponent(match[1]);
  } catch {
    throw new ReceiptDecodeError({ message: "invalid receipt id" });
  }
  if (receiptId.length === 0 || receiptId.includes("/")) {
    throw new ReceiptDecodeError({ message: "invalid receipt id" });
  }
  return match[2] === "refund"
    ? { action: "refund", receiptId }
    : { action: "reject", receiptId };
};

interface ReceiptFileRow {
  readonly fileRef: string;
  readonly objectKey: string;
  readonly contentType: string;
  readonly byteLength: string;
  readonly sha256: string;
}

const unresolvedReceiptFile: ReceiptFile = {
  fileRef: "staging/unresolved-receipt-file",
  objectKey: "committed/unresolved-receipt-file",
  contentType: "application/pdf",
  byteLength: 1,
  sha256: "0".repeat(64),
};

const currentReceiptFile = async (
  receiptId: string,
  options: ReceiptApiHttpOptions,
): Promise<ReceiptFile | undefined> =>
  runPostgres(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<ReceiptFileRow>`
        SELECT file_ref AS "fileRef", file_object_key AS "objectKey",
          file_content_type AS "contentType", file_byte_length::text AS "byteLength",
          file_sha256 AS "sha256"
        FROM economy_receipts
        WHERE receipt_id = ${receiptId}
      `.pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            new ReceiptPersistenceError({
              operation: "read receipt file",
              message: String(cause),
            }),
          ),
        ),
      );
      const row = rows[0];
      if (row === undefined) return undefined;
      return yield* Schema.decodeUnknownEffect(ReceiptFileSchema)({
        fileRef: row.fileRef,
        objectKey: row.objectKey,
        contentType: row.contentType,
        byteLength: Number(row.byteLength),
        sha256: row.sha256,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ReceiptPersistenceError({
              operation: "decode receipt file",
              message: String(cause),
            }),
        ),
      );
    }),
    options.postgresLayer,
  );

const runPostgres = <A>(
  effect: Effect.Effect<A, unknown, PgClient.PgClient>,
  postgresLayer: Layer.Layer<PgClient.PgClient, SqlError>,
): Promise<A> => Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(postgresLayer))));
interface ReceiptCommandContext {
  readonly receiptId: string;
  readonly visualId: string;
  readonly now: string;
}

const executeReceiptAuthority = (
  command: unknown,
  context: ReceiptCommandContext,
  options: ReceiptApiHttpOptions,
) => {
  const transaction = ReceiptAuthority.use(({ execute }) => execute(command, context)).pipe(
    Effect.provide(ReceiptAuthorityPostgres),
  );
  return runPostgres(transaction, options.postgresLayer);
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

const deliverOutbox = (
  claimId: string,
  claimedAt: string,
  options: ReceiptApiHttpOptions,
  fileStore: ReceiptFileStore,
): Promise<ReceiptOutboxDeliveryResult> =>
  Effect.runPromise(
    Effect.scoped(
      deliverNextReceiptOutbox(claimId, claimedAt).pipe(
        Effect.provideService(ReceiptFileService, fileStore.service),
        Effect.provideService(ReceiptAuxiliaryEffects, auxiliaryEffects),
        Effect.provide(options.postgresLayer),
      ),
    ),
  );

const drainOutbox = async (
  options: ReceiptApiHttpOptions,
  fileStore: ReceiptFileStore,
): Promise<"Idle" | "Failed" | "Limit"> => {
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const result = await deliverOutbox(
      `http-${randomUUID()}`,
      options.config.now(),
      options,
      fileStore,
    );
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
  const principal = principalFor(request, options.config.tokens);
  if (!principal.actor.active) throw new InactiveActor({ personId: principal.actor.personId });
  const fields = await decodeMultipart(request, options.config.maxFileBytes);
  let staged: StagedReceiptFile | undefined;
  let committed = false;
  try {
    staged = await fileStore.stageBytes(
      fields.file,
      fields.commandId,
      fields.contentType,
      options.config.maxFileBytes,
    );
    await Effect.runPromise(fileStore.service.stage(staged.file));
    const command = {
      _tag: "SubmitReceipt" as const,
      commandId: fields.commandId,
      actor: principal.actor,
      departmentId: principal.actor.departmentId,
      paymentAccountCiphertext: principal.paymentAccountCiphertext,
      description: fields.description,
      amountOre: fields.amountOre,
      receiptDate: fields.receiptDate,
      file: staged.file,
    };
    const context = {
      receiptId: options.config.nextReceiptId(),
      visualId: options.config.nextVisualId(),
      now: options.config.now(),
    };
    const transaction = ReceiptAuthority.use(({ execute }) => execute(command, context)).pipe(
      Effect.provide(ReceiptAuthorityPostgres),
    );
    const result = await runPostgres(transaction, options.postgresLayer);
    if (result.replayed && staged.created) await fileStore.cleanupStage(staged.file);
    committed = true;
    const delivery = await drainOutbox(options, fileStore);
    if (delivery !== "Idle") {
      return errorResponse(
        new ReceiptPersistenceError({
          operation: "deliver Receipt outbox",
          message: "delivery pending",
        }),
      );
    }
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
  const principal = principalFor(request, options.config.tokens);
  if (!principal.actor.active) throw new InactiveActor({ personId: principal.actor.personId });
  const fields = await decodeReviseMultipart(request, options.config.maxFileBytes);
  let staged: StagedReceiptFile | undefined;
  let committed = false;
  try {
    let commandFile: ReceiptFile;
    if (fields.file === undefined) {
      commandFile = (await currentReceiptFile(receiptId, options)) ?? unresolvedReceiptFile;
    } else {
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
      await Effect.runPromise(fileStore.service.stage(staged.file));
      commandFile = staged.file;
    }
    const command = {
      _tag: "RevisePendingReceipt" as const,
      commandId: fields.commandId,
      actor: principal.actor,
      receiptId,
      expectedRevision: fields.expectedRevision,
      description: fields.description,
      amountOre: fields.amountOre,
      receiptDate: fields.receiptDate,
      file: commandFile,
    };
    const result = await executeReceiptAuthority(
      command,
      { receiptId, visualId: receiptId, now: options.config.now() },
      options,
    );
    if (result.replayed && staged?.created === true) {
      await fileStore.cleanupStage(staged.file).catch(() => undefined);
    }
    committed = true;
    const delivery = await drainOutbox(options, fileStore);
    if (delivery !== "Idle") {
      return errorResponse(
        new ReceiptPersistenceError({
          operation: "deliver Receipt outbox",
          message: "delivery pending",
        }),
      );
    }
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
  const principal = principalFor(request, options.config.tokens);
  if (!principal.actor.active) throw new InactiveActor({ personId: principal.actor.personId });
  const fields = await decodeCommandJson(request, "withdraw");
  const command = {
    _tag: "WithdrawPendingReceipt" as const,
    commandId: fields.commandId,
    actor: principal.actor,
    receiptId,
    expectedRevision: fields.expectedRevision,
  };
  const result = await executeReceiptAuthority(
    command,
    { receiptId, visualId: receiptId, now: options.config.now() },
    options,
  );
  const delivery = await drainOutbox(options, fileStore);
  if (delivery !== "Idle") {
    return errorResponse(
      new ReceiptPersistenceError({
        operation: "deliver Receipt outbox",
        message: "delivery pending",
      }),
    );
  }
  return jsonResponse(result.observation satisfies ReceiptObservation);
};
const approvalScopeFor = (principal: ReceiptApiPrincipal) => {
  const scope = principal.actor.approvalScope;
  if (scope._tag === "None") {
    throw new ReceiptScopeDenied({
      receiptId: "approval-projection",
      departmentId: principal.actor.departmentId,
    });
  }
  return scope;
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
  const principal = principalFor(request, options.config.tokens);
  if (!principal.actor.active) throw new InactiveActor({ personId: principal.actor.personId });
  const scope = approvalScopeFor(principal);
  const status = decodeApprovalStatusFilter(request);
  const rows = await runPostgres(listApproverReceipts(scope), options.postgresLayer);
  const visibleRows = status === undefined ? rows : rows.filter((row) => row.status === status);
  const items = visibleRows.map((row) => {
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
  const principal = principalFor(request, options.config.tokens);
  if (!principal.actor.active) throw new InactiveActor({ personId: principal.actor.personId });
  const scope = approvalScopeFor(principal);
  if (new URL(request.url).search.length !== 0) {
    throw new ReceiptDecodeError({ message: "unexpected receipt command query" });
  }
  const fields = await decodeCommandJson(request, "approval");
  const command = {
    _tag: route.action === "refund" ? ("RefundReceipt" as const) : ("RejectReceipt" as const),
    commandId: fields.commandId,
    actor: principal.actor,
    receiptId: route.receiptId,
    expectedRevision: fields.expectedRevision,
  };
  let result: ReceiptTransactionResult;
  try {
    result = await executeReceiptAuthority(
      command,
      { receiptId: route.receiptId, visualId: route.receiptId, now: options.config.now() },
      options,
    );
  } catch (cause) {
    if (
      scope._tag === "Department" &&
      cause !== null &&
      typeof cause === "object" &&
      "_tag" in cause &&
      cause._tag === "ReceiptNotFound"
    ) {
      throw new ReceiptScopeDenied({
        receiptId: route.receiptId,
        departmentId: scope.departmentId,
      });
    }
    throw cause;
  }
  const delivery = await drainOutbox(options, fileStore);
  if (delivery !== "Idle") {
    return errorResponse(
      new ReceiptPersistenceError({
        operation: "deliver Receipt outbox",
        message: "delivery pending",
      }),
    );
  }
  return jsonResponse(result.observation satisfies ReceiptObservation);
};

const list = async (request: Request, options: ReceiptApiHttpOptions): Promise<Response> => {
  const principal = principalFor(request, options.config.tokens);
  if (!principal.actor.active) throw new InactiveActor({ personId: principal.actor.personId });
  const statusParameter = new URL(request.url).searchParams.get("status");
  let status: ReceiptStatus | undefined;
  if (statusParameter !== null) {
    if (!isReceiptStatus(statusParameter)) {
      throw new ReceiptDecodeError({ message: "invalid receipt status filter" });
    }
    status = statusParameter;
  }
  const rows = await runPostgres(
    listOwnedReceiptProjection(principal.actor.personId, status),
    options.postgresLayer,
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
const profile = (request: Request, options: ReceiptApiHttpOptions): Response => {
  const principal = principalFor(request, options.config.tokens);
  if (!principal.actor.active) throw new InactiveActor({ personId: principal.actor.personId });
  return jsonResponse({
    id: null,
    firstName: principal.actor.personId,
    lastName: "",
    userName: principal.actor.personId,
    email: `${principal.actor.personId}@local.invalid`,
    phone: null,
    gender: null,
    fieldOfStudy: null,
    accountNumber: null,
    role: "assistant",
    profilePhoto: null,
  });
};

export const makeReceiptApiHttp = (input: ReceiptApiHttpOptions): ReceiptApiHttp => {
  const fileStore = input.fileStore ?? makeReceiptFileStore(input.config);
  return {
    migrate: () => runPostgres(migrateReceiptPostgres(input.migrationSql), input.postgresLayer),
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") return new Response(null, { status: 204 });
      if (request.method === "GET" && url.pathname === "/health") {
        try {
          await runPostgres(
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient;
              yield* sql`SELECT 1`;
            }),
            input.postgresLayer,
          );
          return jsonResponse({ status: "ok" });
        } catch {
          return jsonResponse({ status: "unavailable" }, 503);
        }
      }
      try {
        if (
          request.method === "GET" &&
          (url.pathname === "/api/me/profile" || url.pathname === "/api/me")
        ) {
          return profile(request, input);
        }
        if (request.method === "POST" && url.pathname === "/api/receipts/submit") {
          return await submit(request, input, fileStore);
        }
        if (request.method === "POST") {
          const commandRoute = receiptCommandRoute(url.pathname);
          if (commandRoute?.action === "revise") {
            return await revise(request, commandRoute.receiptId, input, fileStore);
          }
          if (commandRoute?.action === "withdraw") {
            return await withdraw(request, commandRoute.receiptId, input, fileStore);
          }
          const approvalRoute = receiptApprovalRoute(url.pathname);
          if (approvalRoute !== undefined) {
            return await approvalCommand(request, approvalRoute, input, fileStore);
          }
        }
        if (request.method === "GET" && url.pathname === "/api/admin/receipts") {
          return await approvalList(request, input);
        }
        if (request.method === "GET" && url.pathname === "/api/receipts") {
          return await list(request, input);
        }
        return jsonResponse({ error: { tag: "RouteNotFound" } }, 404);
      } catch (cause) {
        return errorResponse(cause);
      }
    },
  };
};

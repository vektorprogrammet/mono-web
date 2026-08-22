import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Layer } from "effect";
import {
  ReceiptAuxiliaryEffectConflict,
  InactiveActor,
  ReceiptAuthority,
  ReceiptAuxiliaryEffects,
  ReceiptDecodeError,
  ReceiptFileService,
  ReceiptPersistenceError,
  ReceiptOwnerDenied,
  ReceiptScopeDenied,
  type ReceiptStatus,
  UnauthenticatedActor,
  isIsoDate,
  listOwnedReceiptProjection,
  migrateReceiptPostgres,
  type ReceiptObservation,
} from "@vektorprogrammet/domain/receipt";
import { ReceiptAuthorityPostgres } from "@vektorprogrammet/domain/receipt/postgres";
import {
  deliverNextReceiptOutbox,
  type ReceiptOutboxDeliveryResult,
} from "@vektorprogrammet/domain/receipt/postgres";
import { randomUUID } from "node:crypto";
import type { ReceiptApiConfig, ReceiptApiPrincipal } from "./config.js";
import { makeReceiptFileStore, type ReceiptFileStore, type StagedReceiptFile } from "./filesystem.js";

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

export interface ReceiptApiHttpOptions {
  readonly config: ReceiptApiConfig;
  readonly migrationSql: string;
  readonly postgresLayer: Layer.Layer<PgClient.PgClient>;
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
        : tag === "ReceiptDecodeError" || tag === "ReceiptFileNotStaged"
          ? 422
          : tag === "ReceiptAlreadyExists" || tag === "DuplicateReceiptCommandConflict"
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

const readSingleField = (fields: ReadonlyMap<string, FormDataEntryValue[]>, name: string): string => {
  const values = fields.get(name);
  if (values === undefined || values.length !== 1 || typeof values[0] !== "string") {
    throw new ReceiptDecodeError({ message: `invalid ${name}` });
  }
  return values[0];
};

const decodeMultipart = async (request: Request, maxFileBytes: number): Promise<SubmitFields> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new ReceiptDecodeError({ message: "multipart form required" });
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw new ReceiptDecodeError({ message: "invalid body length" });
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
  const fields = new Map<string, FormDataEntryValue[]>();
  for (const [name, value] of form.entries()) {
    const values = fields.get(name);
    if (values === undefined) fields.set(name, [value]);
    else values.push(value);
  }
  const expected = new Set(["commandId", "description", "amountOre", "receiptDate", "file"]);
  for (const name of fields.keys()) {
    if (!expected.has(name)) throw new ReceiptDecodeError({ message: "unexpected multipart field" });
  }
  if (fields.size !== expected.size) throw new ReceiptDecodeError({ message: "missing multipart field" });

  const commandId = readSingleField(fields, "commandId");
  const description = readSingleField(fields, "description");
  const amountOre = parseSafeAmountOre(readSingleField(fields, "amountOre"));
  const receiptDate = readSingleField(fields, "receiptDate");
  if (commandId.length === 0 || description.length < 1 || description.length > 5000) {
    throw new ReceiptDecodeError({ message: "invalid receipt text" });
  }
  if (!isIsoDate(receiptDate)) throw new ReceiptDecodeError({ message: "invalid receipt date" });

  const fileValues = fields.get("file");
  if (fileValues === undefined || fileValues.length !== 1 || !(fileValues[0] instanceof File)) {
    throw new ReceiptDecodeError({ message: "receipt file is required" });
  }
  const file = fileValues[0];
  if (file.size <= 0 || file.size > maxFileBytes || !isSupportedContentType(file.type)) {
    throw new ReceiptDecodeError({ message: "unsupported receipt file" });
  }
  return { commandId, description, amountOre, receiptDate, file, contentType: file.type };
};

const principalFor = (
  request: Request,
  tokens: ReadonlyMap<string, ReceiptApiPrincipal>,
): ReceiptApiPrincipal => {
  const authorization = request.headers.get("authorization");
  const match = authorization === null ? undefined : /^Bearer ([^\s]+)$/.exec(authorization);
  const principal = match === undefined ? undefined : tokens.get(match[1]);
  if (principal === undefined) throw new UnauthenticatedActor({ message: "authentication required" });
  return principal;
};

const runPostgres = <A>(
  effect: Effect.Effect<A, unknown, PgClient.PgClient>,
  postgresLayer: Layer.Layer<PgClient.PgClient>,
): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(postgresLayer))));

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
        new ReceiptPersistenceError({ operation: "deliver Receipt outbox", message: "delivery pending" }),
      );
    }
    const status = result.replayed ? 200 : 201;
    return jsonResponse(result.observation satisfies ReceiptObservation, status);
  } finally {
    if (!committed && staged?.created === true) await fileStore.cleanupStage(staged.file).catch(() => undefined);
  }
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

import * as PgClient from "@effect/sql-pg/PgClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { Effect, Layer, Schema } from "effect";
import {
  AdmissionScopeDenied,
  InactiveActor,
  UnauthenticatedActor,
  executeAdmissionPeriodCommand,
  listAdmissionPeriodsForManagement,
  listOpenAdmissionPeriods,
  StableIdSchema,
  Rfc3339InstantSchema,
  RevisionSchema,
  type AdmissionPeriodActor,
} from "@vektorprogrammet/domain/admission-period";
import {
  executePublicApplicationCommand,
  findPublicApplicationConfirmation,
  listPublicApplicationCatalog,
  migratePublicApplicationPostgres,
  PublicApplicationSubmitInputSchema,
} from "@vektorprogrammet/domain/application";
import type { AdmissionApiConfig, AdmissionApiPrincipal } from "./config.js";

export interface AdmissionApiHttpOptions {
  readonly config: AdmissionApiConfig;
  readonly migrationSql: string;
  readonly postgresLayer: Layer.Layer<PgClient.PgClient, SqlError>;
}

export interface AdmissionApiHttp {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly migrate: () => Promise<void>;
}

interface ErrorBody {
  readonly error: { readonly tag: string };
}

type TaggedHttpError = Error & { readonly _tag: string };

const taggedError = (tag: string): TaggedHttpError => {
  const error = new Error(tag) as TaggedHttpError;
  Object.defineProperty(error, "_tag", { value: tag, enumerable: true });
  return error;
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const errorTag = (cause: unknown): string =>
  cause !== null && typeof cause === "object" && "_tag" in cause && typeof cause._tag === "string"
    ? cause._tag
    : "AdmissionPeriodPersistenceError";

const errorResponse = (cause: unknown): Response => {
  const tag = errorTag(cause);
  let status: number;
  switch (tag) {
    case "UnauthenticatedActor":
      status = 401;
      break;
    case "InactiveActor":
    case "AdmissionRoleDenied":
    case "AdmissionScopeDenied":
      status = 403;
      break;
    case "DepartmentNotFound":
    case "AdmissionPeriodNotFound":
    case "PublicApplicationNotFound":
      status = 404;
      break;
    case "RequestBodyTooLarge":
      status = 413;
      break;
    case "PublicApplicationRateLimitExceeded":
      status = 429;
      break;
    case "PublicApplicationDecodeError":
    case "FieldOfStudyNotFound":
    case "FieldOfStudyInactive":
    case "FieldOfStudyDepartmentMismatch":
    case "AdmissionPeriodDecodeError":
    case "InvalidAdmissionPeriodWindow":
    case "AdmissionWindowOutsideSemester":
      status = 422;
      break;
    case "NoEligibleAdmissionPeriod":
    case "DuplicatePublicApplication":
    case "DuplicatePublicApplicationCommandConflict":
    case "AdmissionPeriodAlreadyExists":
    case "StaleAdmissionPeriodRevision":
    case "DuplicateAdmissionPeriodCommandConflict":
      status = 409;
      break;
    default:
      status = 503;
  }
  const body: ErrorBody = { error: { tag } };
  return jsonResponse(body, status);
};

const runPostgres = <A, E>(
  effect: Effect.Effect<A, E, PgClient.PgClient>,
  postgresLayer: Layer.Layer<PgClient.PgClient, SqlError>,
): Promise<A> => Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(postgresLayer))));

const principalFor = (
  request: Request,
  tokens: ReadonlyMap<string, AdmissionApiPrincipal>,
): AdmissionApiPrincipal => {
  const authorization = request.headers.get("authorization");
  const match = authorization === null ? undefined : /^Bearer ([^\s]+)$/.exec(authorization);
  const principal = match?.[1] === undefined ? undefined : tokens.get(match[1]);
  if (principal === undefined) throw new UnauthenticatedActor({ message: "authentication required" });
  return principal;
};

const requireActive = (principal: AdmissionApiPrincipal): AdmissionPeriodActor => {
  if (!principal.actor.active) throw new InactiveActor({ personId: principal.actor.personId });
  return principal.actor;
};

const profile = (request: Request, input: AdmissionApiHttpOptions): Response => {
  const principal = principalFor(request, input.config.tokens);
  const actor = requireActive(principal);
  return jsonResponse({
    id: null,
    firstName: actor.personId,
    lastName: "",
    userName: actor.personId,
    email: `${actor.personId}@local.invalid`,
    phone: null,
    gender: null,
    fieldOfStudy: null,
    accountNumber: null,
    role: "assistant",
    profilePhoto: null,
  });
};
const requireNoQuery = (
  request: Request,
  tag = "AdmissionPeriodDecodeError",
): void => {
  if (new URL(request.url).search !== "") {
    throw taggedError(tag);
  }
};

const readBoundedBody = async (
  request: Request,
  maxBytes: number,
  decodeTag: string,
): Promise<string> => {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw taggedError(decodeTag);
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
      throw taggedError("RequestBodyTooLarge");
    }
  }
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw taggedError("RequestBodyTooLarge");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

const decodeJson = async <S extends Schema.ConstraintDecoder<unknown, never>>(
  request: Request,
  schema: S,
  maxBodyBytes: number,
  tag: string,
): Promise<S["Type"]> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw taggedError(tag);
  let body: unknown;
  try {
    body = JSON.parse(await readBoundedBody(request, maxBodyBytes, tag)) as unknown;
  } catch (cause) {
    if (cause !== null && typeof cause === "object" && "_tag" in cause) throw cause;
    throw taggedError(tag);
  }
  return await Effect.runPromise(
    Schema.decodeUnknownEffect(schema)(body, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => taggedError(tag)),
    ),
  );
};

const createPayloadSchema = Schema.Struct({
  commandId: StableIdSchema,
  semesterId: StableIdSchema,
  startAt: Rfc3339InstantSchema,
  endAt: Rfc3339InstantSchema,
  departmentId: Schema.optional(StableIdSchema),
});

const revisePayloadSchema = Schema.Struct({
  commandId: StableIdSchema,
  expectedRevision: RevisionSchema,
  startAt: Rfc3339InstantSchema,
  endAt: Rfc3339InstantSchema,
});

const executeCommand = async (
  command: unknown,
  context: { readonly actor: AdmissionPeriodActor; readonly now: string; readonly admissionPeriodId?: string },
  input: AdmissionApiHttpOptions,
): Promise<{ readonly observation: unknown; readonly replayed: boolean }> => {
  const result = await runPostgres(
    executeAdmissionPeriodCommand(command, context),
    input.postgresLayer,
  );
  return { observation: result.observation, replayed: result.replayed };
};

const listManagement = async (
  request: Request,
  input: AdmissionApiHttpOptions,
): Promise<Response> => {
  requireNoQuery(request);
  const actor = requireActive(principalFor(request, input.config.tokens));
  const rows = await runPostgres(
    listAdmissionPeriodsForManagement({ actor, now: input.config.now() }),
    input.postgresLayer,
  );
  return jsonResponse({ items: rows, totalItems: rows.length });
};

const create = async (request: Request, input: AdmissionApiHttpOptions): Promise<Response> => {
  requireNoQuery(request);
  const actor = requireActive(principalFor(request, input.config.tokens));
  const payload = await decodeJson(
    request,
    createPayloadSchema,
    input.config.maxBodyBytes,
    "AdmissionPeriodDecodeError",
  );
  if (actor._tag === "DepartmentLeader" && payload.departmentId !== undefined) {
    throw new AdmissionScopeDenied({ personId: actor.personId, departmentId: payload.departmentId });
  }
  const result = await executeCommand(
    { _tag: "CreateAdmissionPeriod", ...payload },
    { actor, now: input.config.now(), admissionPeriodId: input.config.nextAdmissionPeriodId() },
    input,
  );
  return jsonResponse(result.observation, result.replayed ? 200 : 201);
};

const revise = async (
  request: Request,
  admissionPeriodId: string,
  input: AdmissionApiHttpOptions,
): Promise<Response> => {
  requireNoQuery(request);
  const actor = requireActive(principalFor(request, input.config.tokens));
  const payload = await decodeJson(
    request,
    revisePayloadSchema,
    input.config.maxBodyBytes,
    "AdmissionPeriodDecodeError",
  );
  const result = await executeCommand(
    { _tag: "ReviseAdmissionPeriod", admissionPeriodId, ...payload },
    { actor, now: input.config.now(), admissionPeriodId },
    input,
  );
  return jsonResponse(result.observation, result.replayed ? 200 : 200);
};

const listOpen = async (request: Request, input: AdmissionApiHttpOptions): Promise<Response> => {
  requireNoQuery(request);
  const rows = await runPostgres(listOpenAdmissionPeriods(input.config.now()), input.postgresLayer);
  return jsonResponse({ items: rows, totalItems: rows.length });
};

const publicRateLimitKey = (request: Request): string => {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded === null || forwarded.trim() === "") return "local";
  return forwarded.split(",", 1)[0]?.trim() || "local";
};

const listPublicCatalog = async (
  request: Request,
  input: AdmissionApiHttpOptions,
): Promise<Response> => {
  requireNoQuery(request, "PublicApplicationDecodeError");
  const catalog = await runPostgres(
    listPublicApplicationCatalog({ now: input.config.now() }),
    input.postgresLayer,
  );
  return jsonResponse(catalog);
};

const submitApplication = async (
  request: Request,
  input: AdmissionApiHttpOptions,
): Promise<Response> => {
  requireNoQuery(request, "PublicApplicationDecodeError");
  if (!input.config.rateLimit.consume(publicRateLimitKey(request), input.config.now())) {
    throw taggedError("PublicApplicationRateLimitExceeded");
  }
  const payload = await decodeJson(
    request,
    PublicApplicationSubmitInputSchema,
    input.config.maxBodyBytes,
    "PublicApplicationDecodeError",
  );
  const result = await runPostgres(
    executePublicApplicationCommand(payload, {
      now: input.config.now(),
      applicationId: input.config.nextApplicationId(),
      applicantId: input.config.nextApplicantId(),
    }),
    input.postgresLayer,
  );
  return jsonResponse(result.observation, result.replayed ? 200 : 201);
};

const publicConfirmation = async (
  request: Request,
  applicationId: string,
  input: AdmissionApiHttpOptions,
): Promise<Response> => {
  requireNoQuery(request, "PublicApplicationDecodeError");
  const confirmation = await runPostgres(
    findPublicApplicationConfirmation(applicationId),
    input.postgresLayer,
  );
  if (confirmation === undefined) throw taggedError("PublicApplicationNotFound");
  return jsonResponse(confirmation);
};

export const makeAdmissionApiHttp = (input: AdmissionApiHttpOptions): AdmissionApiHttp => ({
  migrate: () => runPostgres(migratePublicApplicationPostgres(input.migrationSql), input.postgresLayer),
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
      if (request.method === "GET" && url.pathname === "/api/admin/admission-periods") {
        return await listManagement(request, input);
      }
      if (request.method === "POST" && url.pathname === "/api/admin/admission-periods") {
        return await create(request, input);
      }
      const reviseMatch = /^\/api\/admin\/admission-periods\/([^/]+)\/revise$/.exec(url.pathname);
      if (request.method === "POST" && reviseMatch?.[1] !== undefined) {
        return await revise(request, decodeURIComponent(reviseMatch[1]), input);
      }
      if (request.method === "GET" && url.pathname === "/api/admission-periods/open") {
        return await listOpen(request, input);
      }
      if (request.method === "GET" && url.pathname === "/api/applications/catalog") {
        return await listPublicCatalog(request, input);
      }
      if (request.method === "POST" && url.pathname === "/api/applications") {
        return await submitApplication(request, input);
      }
      const confirmationMatch = /^\/api\/applications\/([^/]+)\/confirmation$/.exec(url.pathname);
      if (request.method === "GET" && confirmationMatch?.[1] !== undefined) {
        return await publicConfirmation(
          request,
          decodeURIComponent(confirmationMatch[1]),
          input,
        );
      }
      return jsonResponse({ error: { tag: "RouteNotFound" } }, 404);
    } catch (cause) {
      return errorResponse(cause);
    }
  },
});

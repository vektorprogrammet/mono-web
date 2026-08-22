import * as PgClient from "@effect/sql-pg/PgClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { Effect, Layer, Schema } from "effect";
import {
  AdmissionApplicationDecodeError,
  AdmissionPeriodDecodeError,
  AdmissionScopeDenied,
  InactiveActor,
  UnauthenticatedActor,
  executeAdmissionApplicationCommand,
  executeAdmissionPeriodCommand,
  listAdmissionPeriodsForManagement,
  listOpenAdmissionPeriods,
  migrateAdmissionPeriodPostgres,
  SubmitAdmissionApplicationInputSchema,
  StableIdSchema,
  Rfc3339InstantSchema,
  RevisionSchema,
  type AdmissionPeriodActor,
} from "@vektorprogrammet/domain/admission-period";
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
  const status =
    tag === "UnauthenticatedActor"
      ? 401
      : tag === "InactiveActor" ||
          tag === "AdmissionRoleDenied" ||
          tag === "AdmissionScopeDenied"
        ? 403
        : tag === "DepartmentNotFound" ||
            tag === "SemesterNotFound" ||
            tag === "AdmissionPeriodNotFound"
          ? 404
          : tag === "AdmissionPeriodDecodeError" || tag === "AdmissionApplicationDecodeError"
            ? 422
            : tag === "InvalidAdmissionPeriodWindow" || tag === "AdmissionWindowOutsideSemester"
              ? 422
              : tag === "AdmissionPeriodAlreadyExists" ||
                  tag === "StaleAdmissionPeriodRevision" ||
                  tag === "DuplicateAdmissionPeriodCommandConflict" ||
                  tag === "NoOpenAdmissionPeriod" ||
                  tag === "AdmissionApplicationAlreadyExists" ||
                  tag === "DuplicateAdmissionApplicationCommandConflict"
                ? 409
                : 503;
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

const requireNoQuery = (request: Request): void => {
  if (new URL(request.url).search !== "") {
    throw new AdmissionPeriodDecodeError({ message: "unexpected query parameters" });
  }
};

const decodeJson = async <A>(
  request: Request,
  schema: Schema.Schema<A, unknown>,
  decodeError: () => Error,
): Promise<A> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw decodeError();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw decodeError();
  }
  return await Effect.runPromise(
    Schema.decodeUnknownEffect(schema)(body, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => decodeError()),
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
  return jsonResponse(rows);
};

const create = async (request: Request, input: AdmissionApiHttpOptions): Promise<Response> => {
  requireNoQuery(request);
  const actor = requireActive(principalFor(request, input.config.tokens));
  const payload = await decodeJson(
    request,
    createPayloadSchema,
    () => new AdmissionPeriodDecodeError({ message: "invalid create body" }),
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
    () => new AdmissionPeriodDecodeError({ message: "invalid revise body" }),
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
  return jsonResponse(rows);
};

const submitApplication = async (
  request: Request,
  input: AdmissionApiHttpOptions,
): Promise<Response> => {
  requireNoQuery(request);
  const payload = await decodeJson(
    request,
    SubmitAdmissionApplicationInputSchema,
    () => new AdmissionApplicationDecodeError({ message: "invalid application body" }),
  );
  const result = await runPostgres(
    executeAdmissionApplicationCommand(
      { _tag: "SubmitAdmissionApplication", ...payload },
      { now: input.config.now(), applicationId: input.config.nextApplicationId() },
    ),
    input.postgresLayer,
  );
  return jsonResponse(
    { _tag: "Submitted", application: result.application },
    result.replayed ? 200 : 201,
  );
};

export const makeAdmissionApiHttp = (input: AdmissionApiHttpOptions): AdmissionApiHttp => ({
  migrate: () => runPostgres(migrateAdmissionPeriodPostgres(input.migrationSql), input.postgresLayer),
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
      if (request.method === "POST" && url.pathname === "/api/applications") {
        return await submitApplication(request, input);
      }
      return jsonResponse({ error: { tag: "RouteNotFound" } }, 404);
    } catch (cause) {
      return errorResponse(cause);
    }
  },
});

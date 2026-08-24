import {
  CreateDepartmentCommandSchema,
  CreateDepartmentResultSchema,
  CreateFieldOfStudyCommandSchema,
  CreateFieldOfStudyResultSchema,
  CreateTeamCommandSchema,
  CreateTeamResultSchema,
  DepartmentJsonSchema,
  FieldOfStudyJsonSchema,
  Organization,
  TeamJsonSchema,
  type OrganizationActor,
} from "@vektorprogrammet/domain/organization";
import { Effect, Match, Schema } from "effect";
import type { BackendRun } from "../router.js";
import type { OrganizationApiConfig } from "./config.js";

export interface OrganizationApiHttpOptions {
  readonly config: OrganizationApiConfig;
  readonly run: BackendRun;
}

export interface OrganizationApiHttp {
  readonly fetch: (request: Request) => Promise<Response>;
}

interface ErrorBody {
  readonly error: { readonly tag: OrganizationHttpErrorTag | "RouteNotFound" };
}

type TaggedHttpError = Error & { readonly _tag: string };

const OrganizationHttpErrorTagSchema = Schema.Literals([
  "UnauthenticatedActor",
  "OrganizationRoleDenied",
  "OrganizationInvalidReference",
  "OrganizationCommandConflict",
  "OrganizationDecodeError",
  "RequestBodyTooLarge",
  "OrganizationPersistenceError",
]);
type OrganizationHttpErrorTag = typeof OrganizationHttpErrorTagSchema.Type;
const isOrganizationHttpErrorTag = Schema.is(OrganizationHttpErrorTagSchema);

const taggedError = (tag: OrganizationHttpErrorTag): TaggedHttpError => {
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
      "access-control-allow-origin": "*",
    },
  });

const preflightResponse = (): Response =>
  new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "600",
      "cache-control": "no-store",
    },
  });

const errorTag = (cause: unknown): OrganizationHttpErrorTag => {
  const tag =
    cause !== null && typeof cause === "object" && "_tag" in cause && typeof cause._tag === "string"
      ? cause._tag
      : "OrganizationPersistenceError";
  return isOrganizationHttpErrorTag(tag) ? tag : "OrganizationPersistenceError";
};

const statusForErrorTag = (tag: OrganizationHttpErrorTag): number =>
  Match.value(tag).pipe(
    Match.when("UnauthenticatedActor", () => 401),
    Match.when("OrganizationRoleDenied", () => 403),
    Match.whenOr("OrganizationInvalidReference", "OrganizationDecodeError", () => 422),
    Match.when("OrganizationCommandConflict", () => 409),
    Match.when("RequestBodyTooLarge", () => 413),
    Match.when("OrganizationPersistenceError", () => 503),
    Match.exhaustive,
  );

const errorResponse = (cause: unknown): Response => {
  const tag = errorTag(cause);
  const body: ErrorBody = { error: { tag } };
  return jsonResponse(body, statusForErrorTag(tag));
};

const assertNoQuery = (request: Request): void => {
  if (new URL(request.url).search.length !== 0) {
    throw taggedError("OrganizationDecodeError");
  }
};

const bearerToken = (request: Request): string | undefined => {
  const authorization = request.headers.get("authorization");
  return authorization === null ? undefined : /^Bearer ([^\s]+)$/u.exec(authorization)?.[1];
};

const actorFor = (request: Request, config: OrganizationApiConfig): OrganizationActor => {
  const token = bearerToken(request);
  const actor = token === undefined ? undefined : config.actorsByToken.get(token);
  if (actor === undefined) throw taggedError("UnauthenticatedActor");
  return actor;
};

const readBoundedBody = async (request: Request, maxBytes: number): Promise<string> => {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) throw taggedError("OrganizationDecodeError");
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength)) throw taggedError("OrganizationDecodeError");
    if (declaredLength > maxBytes) throw taggedError("RequestBodyTooLarge");
  }
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw taggedError("RequestBodyTooLarge");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw taggedError("OrganizationDecodeError");
  }
};

const decodeCommand = async <S extends Schema.ConstraintDecoder<unknown, never>>(
  request: Request,
  schema: S,
  input: OrganizationApiHttpOptions,
): Promise<S["Type"]> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw taggedError("OrganizationDecodeError");
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBoundedBody(request, input.config.maxBodyBytes)) as unknown;
  } catch (cause) {
    if (cause !== null && typeof cause === "object" && "_tag" in cause) throw cause;
    throw taggedError("OrganizationDecodeError");
  }

  return await input.run(
    Schema.decodeUnknownEffect(schema)(body, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => taggedError("OrganizationDecodeError")),
    ),
  );
};

const strictJsonResponse = async <S extends Schema.ConstraintDecoder<unknown, never>>(
  value: unknown,
  schema: S,
  input: OrganizationApiHttpOptions,
  status = 200,
): Promise<Response> => {
  const decoded = await input.run(
    Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => taggedError("OrganizationPersistenceError")),
    ),
  );
  return jsonResponse(decoded, status);
};

const listDepartments = async (
  request: Request,
  input: OrganizationApiHttpOptions,
): Promise<Response> => {
  assertNoQuery(request);
  const rows = await input.run(Organization.use(({ listDepartments }) => listDepartments));
  return strictJsonResponse(rows, Schema.Array(DepartmentJsonSchema), input);
};

const listTeams = async (
  request: Request,
  input: OrganizationApiHttpOptions,
): Promise<Response> => {
  assertNoQuery(request);
  const rows = await input.run(Organization.use(({ listTeams }) => listTeams()));
  return strictJsonResponse(rows, Schema.Array(TeamJsonSchema), input);
};

const listFieldOfStudies = async (
  request: Request,
  input: OrganizationApiHttpOptions,
): Promise<Response> => {
  assertNoQuery(request);
  const rows = await input.run(
    Organization.use(({ listFieldOfStudies }) => listFieldOfStudies),
  );
  return strictJsonResponse(rows, Schema.Array(FieldOfStudyJsonSchema), input);
};

const createDepartment = async (
  request: Request,
  input: OrganizationApiHttpOptions,
): Promise<Response> => {
  assertNoQuery(request);
  const actor = actorFor(request, input.config);
  const command = await decodeCommand(request, CreateDepartmentCommandSchema, input);
  const result = await input.run(
    Organization.use(({ createDepartment }) => createDepartment(command, actor)),
  );
  return strictJsonResponse(
    result,
    CreateDepartmentResultSchema,
    input,
    result.committed ? 201 : 200,
  );
};

const createTeam = async (
  request: Request,
  input: OrganizationApiHttpOptions,
): Promise<Response> => {
  assertNoQuery(request);
  const actor = actorFor(request, input.config);
  const command = await decodeCommand(request, CreateTeamCommandSchema, input);
  const result = await input.run(
    Organization.use(({ createTeam }) => createTeam(command, actor)),
  );
  return strictJsonResponse(result, CreateTeamResultSchema, input, result.committed ? 201 : 200);
};

const createFieldOfStudy = async (
  request: Request,
  input: OrganizationApiHttpOptions,
): Promise<Response> => {
  assertNoQuery(request);
  const actor = actorFor(request, input.config);
  const command = await decodeCommand(request, CreateFieldOfStudyCommandSchema, input);
  const result = await input.run(
    Organization.use(({ createFieldOfStudy }) => createFieldOfStudy(command, actor)),
  );
  return strictJsonResponse(
    result,
    CreateFieldOfStudyResultSchema,
    input,
    result.committed ? 201 : 200,
  );
};

export const makeOrganizationApiHttp = (
  input: OrganizationApiHttpOptions,
): OrganizationApiHttp => ({
  fetch: async (request) => {
    const pathname = new URL(request.url).pathname;
    if (request.method === "OPTIONS") return preflightResponse();
    try {
      if (request.method === "GET" && pathname === "/api/departments") {
        return await listDepartments(request, input);
      }
      if (request.method === "GET" && pathname === "/api/teams") {
        return await listTeams(request, input);
      }
      if (request.method === "GET" && pathname === "/api/field_of_studies") {
        return await listFieldOfStudies(request, input);
      }
      if (request.method === "POST" && pathname === "/api/admin/departments") {
        return await createDepartment(request, input);
      }
      if (request.method === "POST" && pathname === "/api/admin/teams") {
        return await createTeam(request, input);
      }
      if (request.method === "POST" && pathname === "/api/admin/field-of-studies") {
        return await createFieldOfStudy(request, input);
      }
      const body: ErrorBody = { error: { tag: "RouteNotFound" } };
      return jsonResponse(body, 404);
    } catch (cause) {
      return errorResponse(cause);
    }
  },
});

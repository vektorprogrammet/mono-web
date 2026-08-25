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
  type DepartmentId,
  type OrganizationActor,
  type OrganizationPersonAuthority,
  type SemesterId,
  type TeamInterestFilter,
} from "@vektorprogrammet/domain/organization";
import { Effect, Match, Schema } from "effect";
import type { BackendRun } from "../router.js";
import type { OrganizationApiConfig } from "./config.js";

export interface OrganizationApiHttpOptions {
  readonly config: OrganizationApiConfig;
  /** Cookie -> Organization projection -> OrganizationAdministrator|Member. */
  readonly resolveActor: (request: Request) => Promise<OrganizationActor>;
  /**
   * Cookie -> full 0055 authority projection for leader-scoped admin reads
   * (specs 0059/0060). One captured authorizationInstant per request.
   */
  readonly resolveAuthority: (request: Request) => Promise<OrganizationPersonAuthority>;
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

/** Frozen fixture envelope for spec 0059: strict, no extra row fields. */
const TeamInterestEnvelopeSchema = Schema.Struct({
  "hydra:member": Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      userName: Schema.String,
      teamName: Schema.String,
    }),
  ),
  "hydra:totalItems": Schema.Number,
});

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

const actorFor = async (
  request: Request,
  input: OrganizationApiHttpOptions,
): Promise<OrganizationActor> => {
  try {
    return await input.resolveActor(request);
  } catch (cause) {
    if (cause !== null && typeof cause === "object" && "_tag" in cause) throw cause;
    throw taggedError("UnauthenticatedActor");
  }
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
  const rows = await input.run(Organization.use(({ listFieldOfStudies }) => listFieldOfStudies));
  return strictJsonResponse(rows, Schema.Array(FieldOfStudyJsonSchema), input);
};

const createDepartment = async (
  request: Request,
  input: OrganizationApiHttpOptions,
): Promise<Response> => {
  assertNoQuery(request);
  const actor = await actorFor(request, input);
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
  const actor = await actorFor(request, input);
  const command = await decodeCommand(request, CreateTeamCommandSchema, input);
  const result = await input.run(Organization.use(({ createTeam }) => createTeam(command, actor)));
  return strictJsonResponse(result, CreateTeamResultSchema, input, result.committed ? 201 : 200);
};

const createFieldOfStudy = async (
  request: Request,
  input: OrganizationApiHttpOptions,
): Promise<Response> => {
  assertNoQuery(request);
  const actor = await actorFor(request, input);
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

const MailingListTypeSchema = Schema.Literals(["assistants", "team", "all"]);

const optionalDepartmentParam = (request: Request): DepartmentId | undefined => {
  const value = new URL(request.url).searchParams.get("department");
  if (value === null) return undefined;
  if (value.trim().length === 0 || /[^a-zA-Z0-9._-]/u.test(value)) {
    throw taggedError("OrganizationDecodeError");
  }
  return value as DepartmentId;
};

const optionalSemesterParam = (request: Request): SemesterId | undefined => {
  const value = new URL(request.url).searchParams.get("semester");
  if (value === null) return undefined;
  if (value.trim().length === 0 || /[^a-zA-Z0-9._-]/u.test(value)) {
    throw taggedError("OrganizationDecodeError");
  }
  return value as SemesterId;
};

/** Spec 0059/0060 gating: globalAdmin -> all departments, else active-leader union. */
const authorizedDepartmentScope = async (
  authority: OrganizationPersonAuthority,
  input: OrganizationApiHttpOptions,
): Promise<ReadonlyArray<DepartmentId>> => {
  if (authority.globalAdministrator === "Active") {
    const departments = await input.run(Organization.use(({ listDepartments }) => listDepartments));
    return departments.map((department) => department.departmentId);
  }
  const departments = new Set<DepartmentId>();
  for (const membership of authority.memberships) {
    if (membership.active && membership.teamLeader) departments.add(membership.departmentId);
  }
  return [...departments];
};

/** Narrows the authorized scope; out-of-scope known department denies with 403. */
const narrowScopeOrThrow = (
  authorized: ReadonlyArray<DepartmentId>,
  departmentId: DepartmentId | undefined,
): ReadonlyArray<DepartmentId> => {
  if (departmentId === undefined) {
    return authorized;
  }
  if (!authorized.some((authorizedId) => authorizedId === departmentId)) {
    throw taggedError("OrganizationRoleDenied");
  }
  return [departmentId];
};

/** Unknown department reference denies with 422 before any data leaves the store. */
const assertDepartmentsExist = async (
  input: OrganizationApiHttpOptions,
  departmentIds: ReadonlyArray<DepartmentId>,
): Promise<void> => {
  const known = await input.run(Organization.use(({ listDepartments }) => listDepartments));
  for (const requested of departmentIds) {
    if (!known.some((department) => department.departmentId === requested)) {
      throw taggedError("OrganizationInvalidReference");
    }
  }
};

const listTeamInterest = async (
  request: Request,
  input: OrganizationApiHttpOptions,
): Promise<Response> => {
  const authority = await input.resolveAuthority(request);
  const requested = optionalDepartmentParam(request);
  // An authenticated caller with no active leader membership receives a typed
  // denial, never an empty success (spec 0059 authorization boundary). An
  // active global administrator is authorized for all departments even when
  // their membership list is empty.
  const leaderScope = await authorizedDepartmentScope(authority, input);
  if (leaderScope.length === 0 && authority.globalAdministrator !== "Active") {
    throw taggedError("OrganizationRoleDenied");
  }
  const authorized = narrowScopeOrThrow(leaderScope, requested);
  // Unknown department reference denies with 422 before any data leaves the store.
  if (requested !== undefined) await assertDepartmentsExist(input, [requested]);
  const filter: TeamInterestFilter = {
    authorizedDepartmentIds: authorized,
    semesterId: optionalSemesterParam(request),
  };
  const rows = await input.run(
    Organization.use(({ listTeamInterestRegistrations }) => listTeamInterestRegistrations(filter)),
  );
  const envelope = {
    "hydra:member": rows.map((row) => ({
      id: row.registrationId,
      userName: row.submitterName,
      teamName: row.teamName,
    })),
    "hydra:totalItems": rows.length,
  };
  return strictJsonResponse(envelope, TeamInterestEnvelopeSchema, input);
};

const listMailingLists = async (
  request: Request,
  input: OrganizationApiHttpOptions,
): Promise<Response> => {
  const rawType = new URL(request.url).searchParams.get("type") ?? "assistants";
  const decodedType = await input.run(
    Schema.decodeUnknownEffect(MailingListTypeSchema)(rawType, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => taggedError("OrganizationDecodeError"))),
  );
  const authority = await input.resolveAuthority(request);
  const requested = optionalDepartmentParam(request);
  const leaderScope = await authorizedDepartmentScope(authority, input);
  if (leaderScope.length === 0 && authority.globalAdministrator !== "Active") {
    throw taggedError("OrganizationRoleDenied");
  }
  const authorized = narrowScopeOrThrow(leaderScope, requested);
  if (requested !== undefined) await assertDepartmentsExist(input, [requested]);
  const lists = await input.run(
    Organization.use(({ projectMailingLists }) =>
      projectMailingLists({
        type: decodedType,
        authorizedDepartmentIds: authorized,
        semesterId: optionalSemesterParam(request),
      }),
    ),
  );
  return jsonResponse(lists);
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
      if (request.method === "GET" && pathname === "/api/admin/team-interest") {
        return await listTeamInterest(request, input);
      }
      if (request.method === "GET" && pathname === "/api/admin/mailing-lists") {
        return await listMailingLists(request, input);
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

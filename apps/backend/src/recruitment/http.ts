import { type Database } from "@vektorprogrammet/domain/database";
import { Admissions } from "@vektorprogrammet/domain/admissions";
import { Profile } from "@vektorprogrammet/domain/profile";
import {
  Recruitment,
  RecruitmentActorSchema,
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentAssignmentCommandSchema,
  RecruitmentDecodeError,
  RecruitmentScheduleCommandSchema,
  type RecruitmentAssignmentBoardQuery,
  type RecruitmentActor,
} from "@vektorprogrammet/domain/recruitment";
import { Organization } from "@vektorprogrammet/domain/organization";
import { Economy } from "@vektorprogrammet/domain/receipt";
import { Effect, Match, Schema } from "effect";
import { type RecruitmentApiConfig } from "./config.js";

export interface RecruitmentApiHttpOptions {
  readonly config: RecruitmentApiConfig;
  readonly run: <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Database | Admissions | Economy | Organization | Profile | Recruitment
    >,
  ) => Promise<A>;
}

export interface RecruitmentApiHttp {
  readonly fetch: (request: Request) => Promise<Response>;
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
const RecruitmentHttpErrorTag = Schema.Literals([
  "UnauthenticatedActor",
  "RecruitmentInactiveActor",
  "RecruitmentRoleDenied",
  "RecruitmentScopeDenied",
  "RecruitmentInterviewerNotEligible",
  "RecruitmentAdmissionPeriodNotFound",
  "RecruitmentApplicationNotFound",
  "RecruitmentInterviewSchemaNotFound",
  "RecruitmentApplicationAlreadyAssigned",
  "RecruitmentAmbiguousAdmissionPeriod",
  "RecruitmentAssignmentCommandConflict",
  "RecruitmentInterviewNotFound",
  "RecruitmentInterviewAlreadyScheduled",
  "RecruitmentInterviewStaleRevision",
  "RecruitmentScheduleCommandConflict",
  "RecruitmentScheduleInPast",
  "ProfileContactNotFound",
  "RecruitmentDecodeError",
  "RecruitmentInterviewSchemaInactive",
  "RecruitmentPersistenceError",
  "RequestBodyTooLarge",
]);
type RecruitmentHttpErrorTag = typeof RecruitmentHttpErrorTag.Type;
const isRecruitmentHttpErrorTag = Schema.is(RecruitmentHttpErrorTag);

const errorTag = (cause: unknown): RecruitmentHttpErrorTag => {
  const tag =
    cause !== null && typeof cause === "object" && "_tag" in cause && typeof cause._tag === "string"
      ? cause._tag
      : "RecruitmentPersistenceError";
  return isRecruitmentHttpErrorTag(tag) ? tag : "RecruitmentPersistenceError";
};

const statusForErrorTag = (tag: RecruitmentHttpErrorTag): number =>
  Match.value(tag).pipe(
    Match.when("UnauthenticatedActor", () => 401),
    Match.whenOr(
      "RecruitmentInactiveActor",
      "RecruitmentRoleDenied",
      "RecruitmentScopeDenied",
      "RecruitmentInterviewerNotEligible",
      () => 403,
    ),
    Match.whenOr(
      "RecruitmentAdmissionPeriodNotFound",
      "RecruitmentApplicationNotFound",
      "RecruitmentInterviewSchemaNotFound",
      "RecruitmentInterviewNotFound",
      () => 404,
    ),
    Match.whenOr(
      "RecruitmentApplicationAlreadyAssigned",
      "RecruitmentAmbiguousAdmissionPeriod",
      "RecruitmentAssignmentCommandConflict",
      "RecruitmentInterviewAlreadyScheduled",
      "RecruitmentInterviewStaleRevision",
      "RecruitmentScheduleCommandConflict",
      () => 409,
    ),
    Match.whenOr(
      "RecruitmentDecodeError",
      "RecruitmentInterviewSchemaInactive",
      "RecruitmentScheduleInPast",
      () => 422,
    ),
    Match.when("RequestBodyTooLarge", () => 413),
    Match.whenOr("ProfileContactNotFound", "RecruitmentPersistenceError", () => 503),
    Match.exhaustive,
  );

const errorResponse = (cause: unknown): Response => {
  const tag = errorTag(cause);
  const status = statusForErrorTag(tag);
  const body: ErrorBody = { error: { tag } };
  return jsonResponse(body, status);
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
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
};

const decodeJson = async <S extends Schema.ConstraintDecoder<unknown, never>>(
  request: Request,
  schema: S,
  maxBodyBytes: number,
): Promise<S["Type"]> => {
  const decodeTag = "RecruitmentDecodeError";
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw taggedError(decodeTag);
  let body: unknown;
  try {
    body = JSON.parse(await readBoundedBody(request, maxBodyBytes, decodeTag)) as unknown;
  } catch (cause) {
    if (cause !== null && typeof cause === "object" && "_tag" in cause) throw cause;
    throw taggedError(decodeTag);
  }
  return await Effect.runPromise(
    Schema.decodeUnknownEffect(schema)(body, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => taggedError(decodeTag)),
    ),
  );
};

const principalFor = (request: Request, config: RecruitmentApiConfig): RecruitmentActor => {
  const authorization = request.headers.get("authorization");
  const match = authorization === null ? undefined : /^Bearer ([^\s]+)$/.exec(authorization);
  const principal = match?.[1] === undefined ? undefined : config.tokens.get(match[1]);
  if (principal === undefined) throw taggedError("UnauthenticatedActor");
  try {
    return Schema.decodeUnknownSync(RecruitmentActorSchema)(principal.actor, {
      onExcessProperty: "error",
    });
  } catch {
    throw new RecruitmentDecodeError({ message: "invalid authenticated actor" });
  }
};

const decodeBoardQuery = (request: Request): RecruitmentAssignmentBoardQuery => {
  const params = [...new URL(request.url).searchParams.entries()];
  if (params.length !== 1 || params[0]?.[0] !== "status") {
    throw taggedError("RecruitmentDecodeError");
  }
  try {
    return Schema.decodeUnknownSync(RecruitmentAssignmentBoardQuerySchema)(
      { status: params[0][1] },
      { onExcessProperty: "error" },
    );
  } catch {
    throw new RecruitmentDecodeError({ message: "invalid assignment-board query" });
  }
};

const readAssignmentBoard = async (
  request: Request,
  input: RecruitmentApiHttpOptions,
): Promise<Response> => {
  const query = decodeBoardQuery(request);
  const actor = principalFor(request, input.config);
  const observation = await input.run(
    Recruitment.use(({ readAssignmentBoard: read }) =>
      read(query, { actor, now: input.config.now() }),
    ),
  );
  return jsonResponse(observation);
};

const readSchedulingBoard = async (
  request: Request,
  input: RecruitmentApiHttpOptions,
): Promise<Response> => {
  if (new URL(request.url).search !== "") throw taggedError("RecruitmentDecodeError");
  const actor = principalFor(request, input.config);
  const observation = await input.run(
    Recruitment.use(({ readSchedulingBoard: read }) =>
      read({ actor, now: input.config.now() }),
    ),
  );
  return jsonResponse(observation);
};

const assignApplicant = async (
  request: Request,
  input: RecruitmentApiHttpOptions,
): Promise<Response> => {
  if (new URL(request.url).search !== "") throw taggedError("RecruitmentDecodeError");
  const actor = principalFor(request, input.config);
  const command = await decodeJson(
    request,
    RecruitmentAssignmentCommandSchema,
    input.config.maxBodyBytes,
  );
  const result = await input.run(
    Recruitment.use(({ assignApplicant: assign }) =>
      assign(command, {
        actor,
        now: input.config.now(),
        interviewId: input.config.nextInterviewId(),
      }),
    ),
  );
  return jsonResponse({ observation: result.observation, replayed: result.replayed });
};

const scheduleInterview = async (
  request: Request,
  input: RecruitmentApiHttpOptions,
): Promise<Response> => {
  if (new URL(request.url).search !== "") throw taggedError("RecruitmentDecodeError");
  const actor = principalFor(request, input.config);
  const command = await decodeJson(
    request,
    RecruitmentScheduleCommandSchema,
    input.config.maxBodyBytes,
  );
  const now = input.config.now();
  const invitationId = input.config.nextInvitationId();
  const responseCapability = input.config.nextResponseCapability();
  const result = await input.run(
    Recruitment.use(({ scheduleInterview: schedule }) =>
      schedule(command, { actor, now, invitationId, responseCapability }),
    ),
  );
  return jsonResponse({ observation: result.observation, replayed: result.replayed });
};

export const makeRecruitmentApiHttp = (input: RecruitmentApiHttpOptions): RecruitmentApiHttp => ({
  fetch: async (request) => {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/admin/recruitment/assignment-board") {
        return await readAssignmentBoard(request, input);
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/admin/recruitment/interviews/scheduling-board"
      ) {
        return await readSchedulingBoard(request, input);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/admin/recruitment/interviews/assign"
      ) {
        return await assignApplicant(request, input);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/admin/recruitment/interviews/schedule"
      ) {
        return await scheduleInterview(request, input);
      }
      return jsonResponse({ error: { tag: "RouteNotFound" } }, 404);
    } catch (cause) {
      return errorResponse(cause);
    }
  },
});

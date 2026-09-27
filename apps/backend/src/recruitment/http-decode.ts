/** Recruitment request decoding: query strings, invitation capabilities, and JSON bodies. */
import {
  InterviewReportQuery,
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentInvitationCapabilitySchema,
} from "@vektorprogrammet/domain/recruitment";
import { Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Schema } from "effect";
import { decodeRequest, readJsonBody } from "../http-api/problem.js";

/**
 * Every recruitment request body is one bounded `application/json` document.
 *
 * @remarks
 * It reads the body with `readJsonBody` for the media type `application/json`, with or without
 * parameters, up to `maxBodyBytes`. `Effect.suspend` takes the body reader when the effect runs,
 * not when it is built, so a handler that builds the effect and never runs it leaves the body
 * unread.
 *
 * @sideEffects Reads and consumes the request body when the effect runs.
 *
 * @example
 * ```ts
 * const body = yield* readRecruitmentBody(request, input.config.maxBodyBytes);
 * ```
 *
 * @avoid A recruitment handler that reads its body with its own media type pattern or bound: the
 * recruitment endpoints then accept different bodies. Read it with this.
 *
 * @construct http-problem
 */
export const readRecruitmentBody = (
  request: Request,
  maxBodyBytes: number,
): Effect.Effect<
  Schema.Json,
  | Problem<"internal.error">
  | Problem<"media-type.unsupported">
  | Problem<"request.malformed">
  | Problem<"request.too-large">
> => Effect.suspend(() => readJsonBody(request, /^application\/json(?:\s*;|$)/iu, maxBodyBytes));

/** Decodes the single `status` assignment-board query parameter. */
export const decodeBoardQuery = (request: Request) => {
  const parameters = [...new URL(request.url).searchParams];

  return parameters.length !== 1 || parameters[0]?.[0] !== "status"
    ? Effect.fail(Problem.make("request.malformed"))
    : decodeRequest(RecruitmentAssignmentBoardQuerySchema)({ status: parameters[0][1] });
};

/** Decodes interview-report query parameters; each parameter may appear once. */
export const decodeInterviewReportQuery = (request: Request) => {
  const values = new URL(request.url).searchParams;

  return [...values.keys()].some((key) => values.getAll(key).length !== 1)
    ? Effect.fail(Problem.make("request.malformed"))
    : decodeRequest(InterviewReportQuery)(Object.fromEntries(values));
};

/** The invitation response capability; an absent or malformed one names no invitation. */
export const invitationCapability = (request: Request) =>
  Schema.decodeUnknownEffect(RecruitmentInvitationCapabilitySchema)(
    request.headers.get("x-recruitment-invitation-capability"),
    { onExcessProperty: "error" },
  ).pipe(Effect.mapError(() => Problem.make("resource.not-found")));

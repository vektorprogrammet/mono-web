/** Recruitment HTTP representations: cache policies, response schemas, ETags, and conditional reads. */
import type {
  RecruitmentAuthorityHttpSource,
  RecruitmentInterviewHttpSource,
  RecruitmentInvitationHttpSource,
  RecruitmentSchedulingBoard,
} from "@vektorprogrammet/domain/recruitment";
import type { StrongETag } from "@vektorprogrammet/http-api";
import { Effect, Predicate, Schema, flow } from "effect";
import {
  HttpSemanticFailure,
  deriveStrongETag,
  evaluateReadPreconditions,
  nativeProblemResponse,
  notModifiedResponse,
  parseIfNoneMatch,
  parseReadIfMatch,
} from "../http-semantics.js";
import { headerValues } from "./http-decode.js";
import { knownRecruitmentFailure } from "./http-problem.js";

export const NO_STORE = "no-store";

export const PRIVATE_NO_STORE = "private, no-store";

/** A domain observation that does not fit its response schema is an internal error. */
export const strictOutput = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) =>
  flow(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" }),
    Effect.mapError(() => new HttpSemanticFailure("internal.error", 500)),
  );

export const invitationETag = (source: RecruitmentInvitationHttpSource): StrongETag =>
  deriveStrongETag({
    representationKind: "InvitationResponseObservation",
    resourceIdentity: `recruitment-invitation:${source.invitationId}`,
    version: [source.scheduleRevision, source.responseRevision],
  });

export const interviewETag = (
  source: Omit<RecruitmentInterviewHttpSource, "linkedApplicantPersonId">,
): StrongETag =>
  deriveStrongETag({
    representationKind: "RecruitmentInterviewResource",
    resourceIdentity: `recruitment-interview:${source.interviewId}`,
    version: [
      source.interviewRevision,
      source.coInterviewerPersonId ?? "Absent",
      source.authority.map((item) => [item.kind, item.identity, item.revisions]),
    ],
  });

export const schedulingBoardWithETags = (
  board: RecruitmentSchedulingBoard,
  authority: ReadonlyArray<RecruitmentAuthorityHttpSource>,
) => ({
  ...board,
  interviews: board.interviews.map((interview) => ({
    ...interview,
    etag: interviewETag({
      interviewId: interview.interviewId,
      departmentId: interview.departmentId,
      interviewerPersonId: interview.interviewer.personId,
      coInterviewerPersonId:
        interview.coInterviewer === null ? null : interview.coInterviewer.personId,
      interviewRevision: interview.revision,
      authority,
    }),
  })),
});

export const conditionalJsonResponse = (request: Request, body: Schema.Json, etag: StrongETag) =>
  Effect.try({
    try: () => {
      const decision = evaluateReadPreconditions({
        currentETag: etag,
        ifMatch: parseReadIfMatch(headerValues(request, "if-match")),
        ifNoneMatch: parseIfNoneMatch(headerValues(request, "if-none-match")),
      });

      if (Predicate.isTagged(decision, "Failed"))
        return nativeProblemResponse(decision.code, decision.status);

      if (Predicate.isTagged(decision, "NotModified")) {
        return notModifiedResponse({ etag, cacheControl: PRIVATE_NO_STORE, vary: "Origin" });
      }

      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "cache-control": PRIVATE_NO_STORE,
          "content-type": "application/json",
          etag,
          vary: "Origin",
        },
      });
    },
    catch: knownRecruitmentFailure,
  });

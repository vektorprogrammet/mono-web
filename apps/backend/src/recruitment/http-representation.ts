/** Recruitment HTTP representations: ETags, scheduling items, and a legacy conditional read. */
import type {
  RecruitmentAuthorityHttpSource,
  RecruitmentInterviewHttpSource,
  RecruitmentInvitationHttpSource,
  RecruitmentSchedulingBoard,
} from "@vektorprogrammet/domain/recruitment";
import type { StrongETag } from "@vektorprogrammet/http-api";
import { Cause, Effect, Predicate, type Schema } from "effect";
import { headerValues } from "../http-api/problem.js";
import {
  HttpSemanticFailure,
  PRIVATE_NO_STORE,
  deriveStrongETag,
  evaluateReadPreconditions,
  nativeProblemResponse,
  notModifiedResponse,
  parseIfNoneMatch,
  parseReadIfMatch,
} from "../http-semantics.js";

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

/**
 * Legacy raw-problem conditional read that substitutes still imports.
 * Recruitment's own reads answer through the shared `conditionalJson`.
 */
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
    catch: (cause) =>
      cause instanceof HttpSemanticFailure ? cause : new Cause.UnknownError(cause),
  });

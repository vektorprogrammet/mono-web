/** Recruitment HTTP representations: ETags and scheduling items. */
import type {
  RecruitmentAuthorityHttpSource,
  RecruitmentInterviewHttpSource,
  RecruitmentInvitationHttpSource,
  RecruitmentSchedulingBoard,
} from "@vektorprogrammet/domain/recruitment";
import type { StrongETag } from "@vektorprogrammet/http-api";
import { deriveStrongETag } from "../http-semantics.js";

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

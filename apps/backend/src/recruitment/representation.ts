/** Recruitment representations: the strong entity tags of invitations and interviews. */
import type {
  RecruitmentAuthorityHttpSource,
  RecruitmentInterviewHttpSource,
  RecruitmentInvitationHttpSource,
  RecruitmentSchedulingBoard,
} from "@vektorprogrammet/domain/recruitment";
import type { SchedulingBoard } from "@vektorprogrammet/rpc";
import type { StrongETag } from "@vektorprogrammet/rpc/problem";
import { deriveStrongETag } from "../http-semantics.js";

/** The tag of an invitation, which an invitation response takes as `ifMatch`. */
export const invitationETag = (source: RecruitmentInvitationHttpSource): StrongETag =>
  deriveStrongETag({
    representationKind: "InvitationResponseObservation",
    resourceIdentity: `recruitment-invitation:${source.invitationId}`,
    version: [source.scheduleRevision, source.responseRevision],
  });

/** The tag of an interview, which scheduling and the conduct commands take as `ifMatch`. */
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

/** The scheduling board with the tag of each interview, as the caller's authority sees it. */
export const schedulingBoardWithETags = ({
  board,
  authority,
}: {
  readonly board: RecruitmentSchedulingBoard;
  readonly authority: ReadonlyArray<RecruitmentAuthorityHttpSource>;
}): SchedulingBoard => ({
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

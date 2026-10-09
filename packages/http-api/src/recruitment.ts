/**
 * Schemas and helpers for Recruitment; operations are declared in recruitment.effx.ts.
 *
 * @since 0.1.0
 */
import {
  RecruitmentMaintenanceCommand,
  RecruitmentMaintenanceResult,
  QuestionnaireManagement,
  InterviewStaffingManagement,
} from "@vektorprogrammet/domain/recruitment";
import { AdmissionPeriodId } from "@vektorprogrammet/domain/admission-period";
import { ApplicantIdSchema, PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import {
  CancelInterviewObservationSchema,
  AssessmentCorrection,
  CorrectionHistoryOriginalSchema,
  containsRecruitmentInvitationCapabilitySequence,
  FinalizeInterviewObservationSchema,
  InterviewRecommendationSchema,
  InterviewReport,
  InterviewReportQuery,
  InterviewSchemaId,
  interviewRecommendations,
  interviewScoreTotal,
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentAssignmentBoardSchema,
  RecruitmentInterviewConductObservationSchema,
  RecruitmentInterviewId,
  RecruitmentInterviewerOptionSchema,
  RecruitmentInvitationCapabilitySchema,
  RecruitmentInvitationRejectInputSchema,
  RecruitmentInvitationRequestNewTimeInputSchema,
  RecruitmentInvitationResponseMessageSchema,
  RecruitmentInvitationResponseObservationSchema,
  RecruitmentInterviewQuestionSnapshot,
  RecruitmentSchedulingInterviewSchema,
  RecruitmentSchedulingBoardSchema,
  type RecruitmentAssignmentBoard,
  type RecruitmentAssignmentBoardQuery,
  type RecruitmentInterviewConductObservation,
  type RecruitmentSchedulingInterview,
} from "@vektorprogrammet/domain/recruitment";

const InvitationResponseObservationExample: any = {
  scheduledAt: "2026-09-10T14:00:00.000Z",
  room: "Realfagbygget, R90",
  campus: "Gløshaugen",
  responseState: "Pending",
  responseMessage: null,
} as const;

const AssignmentBoardExample: any = {
  admissionPeriodId: AdmissionPeriodId.make("period-1"),
  departmentId: DepartmentId.make("1"),
  candidates: [
    {
      applicationId: PublicApplicationIdSchema.make("app-0080"),
      applicantId: ApplicantIdSchema.make("applicant-0080"),
      firstName: "Ming",
      lastName: "Medlem",
      email: "ming.medlem@example.org",
      submittedAt: "2026-08-15T12:00:00.000Z",
      applicationState: "Received",
      interviewState: "Unassigned",
      interviewer: null,
      interviewSchema: null,
      scheduledAt: null,
    },
  ],
  interviewers: [{ personId: PersonId.make("1001"), displayName: "Kari Leder" }],
  interviewSchemas: [
    {
      interviewSchemaId: InterviewSchemaId.make("interview-schema-1"),
      name: "Standardintervju",
      questionCount: 5,
      active: true,
      revision: 2,
    },
  ],
};

const SchedulingBoardExample: any = {
  departmentId: DepartmentId.make("1"),
  interviews: [
    {
      interviewId: RecruitmentInterviewId.make("interview-1"),
      applicationId: PublicApplicationIdSchema.make("app-0080"),
      departmentId: DepartmentId.make("1"),
      interviewer: {
        personId: PersonId.make("1001"),
        displayName: "Kari Leder",
        email: "kari.leder@example.org",
        phone: "+47 900 00 000",
      },
      coInterviewer: {
        personId: PersonId.make("1003"),
        displayName: "Ola Medintervjuer",
      },
      applicant: {
        applicationId: PublicApplicationIdSchema.make("app-0080"),
        applicantId: ApplicantIdSchema.make("applicant-0080"),
        firstName: "Ming",
        lastName: "Medlem",
        email: "ming.medlem@example.org",
        phone: "+47 900 00 000",
      },
      revision: 2,
      etag: StrongETag.make('"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"'),
      schedule: {
        interviewId: RecruitmentInterviewId.make("interview-1"),
        scheduledAt: "2026-09-10T14:00:00.000Z",
        room: "Realfagbygget, R90",
        campus: "Gløshaugen",
        mapLink: "https://maps.example.org/r90",
        message: "Interview invitation with room details.",
        scheduledByPersonId: PersonId.make("1002"),
        committedAt: "2026-08-20T10:05:00.000Z",
        scheduleRevision: 1,
      },
      notificationState: "Pending",
      responseState: "Pending",
      responseMessage: null,
    },
  ],
};

const ConductAssessmentExample = CorrectionHistoryOriginalSchema.make({
  revision: 3,
  answers: [{ questionId: "q-1", answer: "I am drawn to the study programme's breadth." }],
  score: { explanatoryPower: 7, roleModel: 8, suitability: 6 },
  recommendation: "Ja",
  finalizedByPersonId: PersonId.make("1001"),
  finalizedAt: "2026-09-12T15:00:00.000Z",
});

const ConductObservationExample = decodeExampleOrThrow(
  RecruitmentInterviewConductObservationSchema,
)({
  interviewId: RecruitmentInterviewId.make("interview-1"),
  applicationId: PublicApplicationIdSchema.make("app-0080"),
  applicant: {
    applicantId: ApplicantIdSchema.make("applicant-0080"),
    firstName: "Ming",
    lastName: "Medlem",
  },
  schedule: {
    interviewId: RecruitmentInterviewId.make("interview-1"),
    scheduledAt: "2026-09-10T14:00:00.000Z",
    room: "Realfagbygget, R90",
    campus: "Gløshaugen",
    mapLink: "https://maps.example.org/r90",
    message: "Interview invitation with room details.",
    scheduledByPersonId: PersonId.make("1002"),
    committedAt: "2026-08-20T10:05:00.000Z",
    scheduleRevision: 1,
  },
  invitationResponse: "Accepted",
  questions: [
    {
      interviewId: RecruitmentInterviewId.make("interview-1"),
      questionId: "q-1",
      ordinal: 1,
      prompt: "Why did you apply to this programme?",
      helpText: null,
      kind: "text",
      alternatives: [],
    },
  ],
  answers: ConductAssessmentExample.answers,
  score: ConductAssessmentExample.score,
  recommendation: ConductAssessmentExample.recommendation,
  completionState: "Completed",
  cancellationState: "NotCancelled",
  finalizedByPersonId: ConductAssessmentExample.finalizedByPersonId,
  finalizedAt: ConductAssessmentExample.finalizedAt,
  cancelledAt: null,
  revision: ConductAssessmentExample.revision,
  effectiveRevision: ConductAssessmentExample.revision,
  history: [ConductAssessmentExample],
  assessmentCorrection: AssessmentCorrection.cases.Ordinary.make({
    sequence: 0,
    canCorrect: true,
    canReopen: false,
    canClose: false,
  }),
  canFinalize: false,
  canCancel: false,
});

import * as Schema from "effect/Schema";
import { decodeExampleOrThrow, encodeExampleOrThrow } from "./declaration-decoding.js";
import { StrongETag } from "./http-semantics.js";
import { EmptyJsonRequest } from "./v2-schemas.js";

export {
  CancelInterviewObservationSchema,
  containsRecruitmentInvitationCapabilitySequence,
  FinalizeInterviewObservationSchema,
  InterviewRecommendationSchema,
  InterviewReport,
  InterviewReportQuery,
  InterviewSchemaId,
  interviewRecommendations,
  interviewScoreTotal,
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentAssignmentBoardSchema,
  RecruitmentInterviewConductObservationSchema,
  RecruitmentInterviewId,
  RecruitmentInterviewerOptionSchema,
  RecruitmentInvitationCapabilitySchema,
  RecruitmentInvitationResponseMessageSchema,
  RecruitmentInvitationResponseObservationSchema,
  RecruitmentInterviewQuestionSnapshot,
  RecruitmentSchedulingInterviewSchema,
};

export type {
  RecruitmentAssignmentBoard,
  RecruitmentAssignmentBoardQuery,
  RecruitmentInterviewConductObservation,
  RecruitmentSchedulingInterview,
};

/**
 * Exact empty JSON object required when accepting an invitation.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const ConfirmInvitationPayload = EmptyJsonRequest.annotate({
  identifier: "ConfirmInvitationRequest",
  description: "An exact empty JSON object.",
  examples: [{}],
});

export const InvitationRejectInput = RecruitmentInvitationRejectInputSchema.annotate({
  identifier: "InvitationRejectInput",
  description: "Optional short rejection message.",
  examples: [{ message: "Cannot attend that day." }, {}],
});

export const InvitationRequestNewTimeInput =
  RecruitmentInvitationRequestNewTimeInputSchema.annotate({
    identifier: "InvitationRequestNewTimeInput",
    description: "Short message proposing another time.",
    examples: [{ message: "Could we do Thursday instead?" }],
  });

export const InvitationResponseObservation =
  RecruitmentInvitationResponseObservationSchema.annotate({
    identifier: "InvitationResponseObservation",
    description: "Interview invitation state visible to the invitee.",
    examples: [InvitationResponseObservationExample],
  });

export const AssignmentBoard = RecruitmentAssignmentBoardSchema.annotate({
  identifier: "AssignmentBoard",
  description:
    "Candidates and interviewers in the departments where the caller manages interviews.",
  examples: [AssignmentBoardExample],
});

export const SchedulingInterview = RecruitmentSchedulingInterviewSchema.mapMembers((members) => [
  members[0].mapFields((fields) => ({ ...fields, etag: StrongETag })),
  members[1].mapFields((fields) => ({ ...fields, etag: StrongETag })),
  members[2].mapFields((fields) => ({ ...fields, etag: StrongETag })),
  members[3].mapFields((fields) => ({ ...fields, etag: StrongETag })),
]).annotate({
  identifier: "SchedulingInterview",
  description: "One interview with the strong validator for its mutation.",
});

export const SchedulingBoard = Schema.Struct({
  departmentId: RecruitmentSchedulingBoardSchema.fields.departmentId,
  interviews: Schema.Array(SchedulingInterview),
}).annotate({
  identifier: "SchedulingBoard",
  description: "Interviews visible to the current member.",
  examples: [SchedulingBoardExample],
});

/** Encode Model instances before documenting the public JSON representation. */
export const ConductObservation = RecruitmentInterviewConductObservationSchema.pipe(
  Schema.annotateEncoded<typeof RecruitmentInterviewConductObservationSchema>({
    identifier: "ConductObservation",
    description: "Interview questions, answers, and conduct state.",
    examples: [
      encodeExampleOrThrow(RecruitmentInterviewConductObservationSchema)(ConductObservationExample),
    ],
  }),
);

/** The empty input of a Recruitment operation with no path, query, or body. */
export const EmptyRecruitmentInput = Schema.Struct({});

export const RecruitmentApplicationParams = Schema.Struct({
  applicationId: PublicApplicationIdSchema,
});

export const RecruitmentInterviewParams = Schema.Struct({
  interviewId: RecruitmentInterviewId,
});

export {
  RecruitmentMaintenanceCommand,
  RecruitmentMaintenanceResult,
  QuestionnaireManagement,
  InterviewStaffingManagement,
};

export { RecruitmentInterviewQuestionKindSchema } from "@vektorprogrammet/domain/recruitment";

/**
 * Recruitment failures answered as the problems each endpoint declares.
 */
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import type {
  RecruitmentFailure,
  RecruitmentInterviewNotFound,
  RecruitmentMaintenanceFailure,
} from "@vektorprogrammet/domain/recruitment";
import { type CredentialPresentation, Problem } from "@vektorprogrammet/http-api/http-semantics";
import { type Cause, Effect, Match } from "effect";
import { isSerializationConflict, problemMapper } from "../http-api/problem.js";

/** Every failure a recruitment handler answers: the domain's, and resolving the request's person. */
type RecruitmentHttpFailure = RecruitmentFailure | IdentityEngineError | Cause.UnknownError;

const denied = () => Problem.make("authority.denied");

const replayConflict = () => Problem.make("idempotency.digest-conflict");

const fault = () => Problem.make("internal.error");

/**
 * The one answer for every recruitment failure. Reads answer an outage as
 * recruitment.unavailable and mutations as dependency.unavailable; a rejected
 * credential is answered from the request's own evidence.
 *
 * @construct http-problem
 */
export const recruitmentProblems = <
  const Unavailable extends "recruitment.unavailable" | "dependency.unavailable",
>(
  presentation: CredentialPresentation,
  unavailable: Unavailable,
) => {
  const outage = () => Problem.make(unavailable);

  return problemMapper<RecruitmentHttpFailure>()({
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    InactiveActor: denied,
    RecruitmentInactiveActor: denied,
    RecruitmentRoleDenied: denied,
    RecruitmentScopeDenied: denied,
    RecruitmentInterviewerNotEligible: denied,
    RecruitmentAdmissionPeriodNotFound: () =>
      Problem.make("recruitment.admission-period-not-found"),
    RecruitmentAmbiguousAdmissionPeriod: () => Problem.make("application.ambiguous-period"),
    RecruitmentApplicationNotFound: () => Problem.make("recruitment.application-not-found"),
    RecruitmentInterviewSchemaNotFound: () =>
      Problem.make("recruitment.interview-schema-not-found"),
    RecruitmentApplicationAlreadyAssigned: () =>
      Problem.make("recruitment.application-already-assigned"),
    RecruitmentInterviewSchemaInactive: () => Problem.make("recruitment.interview-schema-inactive"),
    RecruitmentInterviewNotFound: () => Problem.make("recruitment.interview-not-found"),
    RecruitmentInterviewAlreadyScheduled: () => Problem.make("recruitment.already-scheduled"),
    RecruitmentInterviewStaleRevision: () => Problem.make("precondition.failed"),
    RecruitmentScheduleInPast: () => Problem.make("recruitment.schedule-in-past"),
    RecruitmentInvitationNotFound: () => Problem.make("resource.not-found"),
    RecruitmentInvitationAlreadyResponded: () => Problem.make("invitation.already-responded"),
    RecruitmentInterviewAlreadyFinalized: () => Problem.make("recruitment.already-finalized"),
    RecruitmentInterviewAlreadyCancelled: () => Problem.make("recruitment.already-cancelled"),
    RecruitmentInterviewNotScheduled: () => Problem.make("recruitment.interview-not-scheduled"),
    RecruitmentInvitationNotAccepted: () => Problem.make("recruitment.invitation-not-accepted"),
    RecruitmentConductValidationError: () => Problem.make("recruitment.conduct-invalid"),
    RecruitmentAssignmentCommandConflict: replayConflict,
    RecruitmentScheduleCommandConflict: replayConflict,
    RecruitmentLifecycleCommandConflict: replayConflict,
    RecruitmentPersistenceError: outage,
    InterviewQuestionsUnavailable: outage,
    ProfileContactNotFound: outage,
    // What remains is a fault of recruitment itself or of a dependency's contract.
    RecruitmentDecodeError: fault,
    RecruitmentInvalidContext: fault,
    RecruitmentMaintenanceFailure: fault,
    AdmissionPeriodDecodeError: fault,
    AdmissionRoleDenied: fault,
    AdmissionScopeDenied: fault,
    DepartmentRequired: fault,
    DepartmentNotFound: fault,
    SemesterNotFound: fault,
    AdmissionPeriodNotFound: fault,
    InvalidAdmissionPeriodWindow: fault,
    AdmissionWindowOutsideSemester: fault,
    AdmissionPeriodAlreadyExists: fault,
    StaleAdmissionPeriodRevision: fault,
    DuplicateAdmissionPeriodCommandConflict: fault,
    AdmissionPeriodPersistenceError: fault,
    OrganizationDecodeError: fault,
    OrganizationPersistenceError: fault,
    ProfileDecodeError: fault,
    ProfileQueryLimitExceeded: fault,
    ProfileNotFound: fault,
    ProfileStaleRevision: fault,
    ProfileCommandConflict: fault,
    ProfilePersistenceError: fault,
    IdentityEngineError: fault,
    UnknownError: fault,
  });
};

/**
 * A failure that lost a serialization or deadlock race answers
 * transaction.conflict, whatever failure carried it. It runs after the
 * command executor, whose one retry reads the raw causes.
 *
 * @construct http-problem
 */
export const raceProblems = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.mapError(effect, (failure) =>
    isSerializationConflict(failure) ? Problem.make("transaction.conflict") : failure,
  );

/**
 * The maintenance API answers its own failures, an unknown interview, and an
 * identity outage in its own vocabulary; everything else as recruitment does.
 *
 * @construct http-problem
 */
export const maintenanceProblems = problemMapper<
  RecruitmentMaintenanceFailure | RecruitmentInterviewNotFound | IdentityEngineError
>()({
  RecruitmentMaintenanceFailure: ({ code }) =>
    Match.value(code).pipe(
      Match.when("Denied", denied),
      Match.when("NotFound", () => Problem.make("resource.not-found")),
      Match.when("Stale", () => Problem.make("precondition.failed")),
      Match.when("Conflict", replayConflict),
      Match.when("Invalid", () => Problem.make("recruitment.invalid-command")),
      Match.when("Ineligible", () => Problem.make("recruitment.ineligible")),
      Match.when("Terminal", () => Problem.make("recruitment.terminal")),
      Match.when("EmptyActiveQuestionnaire", () =>
        Problem.make("recruitment.empty-active-questionnaire"),
      ),
      Match.exhaustive,
    ),
  RecruitmentInterviewNotFound: () => Problem.make("resource.not-found"),
  IdentityEngineError: () => Problem.make("recruitment.unavailable"),
});

/** Problems only choosing a department's one open admission period answers. */
export const admissionPeriodProblems = [
  "recruitment.admission-period-not-found",
  "application.ambiguous-period",
] as const;

/** Problems only assigning an applicant answers. */
export const assignmentProblems = [
  "recruitment.application-not-found",
  "recruitment.interview-schema-not-found",
  "recruitment.application-already-assigned",
  "recruitment.interview-schema-inactive",
] as const;

/** Problems only scheduling an interview answers. */
export const schedulingProblems = [
  "recruitment.already-scheduled",
  "recruitment.schedule-in-past",
] as const;

/** Problems only reading or changing an interview's conduct answers. */
export const conductProblems = [
  "recruitment.interview-not-scheduled",
  "recruitment.invitation-not-accepted",
  "recruitment.already-finalized",
  "recruitment.already-cancelled",
  "recruitment.conduct-invalid",
] as const;

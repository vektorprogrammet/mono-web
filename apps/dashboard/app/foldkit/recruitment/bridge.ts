import { nativeProblemFrom } from "../../lib/native-problem";
import { Match, Schema as S } from "effect";
import { PublicApplicationIdSchema } from "@vektorprogrammet/http-api"
import { CancelInterviewObservationSchema,
FinalizeInterviewObservationSchema,
InterviewSchemaId,
RecruitmentAssignmentBoardQuerySchema,
RecruitmentAssignmentBoardSchema,
RecruitmentInterviewConductObservationSchema,
RecruitmentInterviewId, } from "@vektorprogrammet/http-api"
import { CancelInterviewRequest, CancelInterviewResponse, ConditionalReadHeaders, CreateApplicationInterviewRequest, FinalizeInterviewRequest, CorrectInterviewAssessmentRequest, CorrectInterviewAssessmentResponse, FinalizeInterviewResponse, IdempotencyHeaders, IdempotencyIfMatchHeaders, RecruitmentInterviewResource, SchedulingBoard, ScheduleInterviewRequest, ScheduleInterviewResponse, StrongETag } from "@vektorprogrammet/http-api";


export const RecruitmentBoardStatus = RecruitmentAssignmentBoardQuerySchema.fields.status;

export type RecruitmentBoardStatus = S.Schema.Type<typeof RecruitmentBoardStatus>;

const ReadAssignmentBoardOperation = S.Struct({
  operation: S.Literal("readAssignmentBoard"),
  query: RecruitmentAssignmentBoardQuerySchema,
});

export const CreateApplicationInterviewInputSchema = S.Struct({
  params: S.Struct({ applicationId: PublicApplicationIdSchema }),
  headers: IdempotencyHeaders,
  payload: CreateApplicationInterviewRequest,
});

const CreateApplicationInterviewOperation = S.Struct({
  operation: S.Literal("createApplicationInterview"),
  ...CreateApplicationInterviewInputSchema.fields,
});

const ReadSchedulingBoardOperation = S.Struct({
  operation: S.Literal("readSchedulingBoard"),
});

export const ScheduleInterviewInputSchema = S.Struct({
  params: S.Struct({ interviewId: RecruitmentInterviewId }),
  headers: IdempotencyIfMatchHeaders,
  payload: ScheduleInterviewRequest,
});

const ScheduleInterviewOperation = S.Struct({
  operation: S.Literal("scheduleInterview"),
  ...ScheduleInterviewInputSchema.fields,
});

export const ReadInterviewConductInputSchema = S.Struct({
  params: S.Struct({ interviewId: RecruitmentInterviewId }),
  headers: ConditionalReadHeaders,
});

const ReadInterviewConductOperation = S.Struct({
  operation: S.Literal("readInterviewConduct"),
  ...ReadInterviewConductInputSchema.fields,
});

export const FinalizeInterviewInputSchema = S.Struct({
  params: S.Struct({ interviewId: RecruitmentInterviewId }),
  headers: IdempotencyIfMatchHeaders,
  payload: FinalizeInterviewRequest,
});

const FinalizeInterviewOperation = S.Struct({
  operation: S.Literal("finalizeInterview"),
  ...FinalizeInterviewInputSchema.fields,
});

export const CancelInterviewInputSchema = S.Struct({
  params: S.Struct({ interviewId: RecruitmentInterviewId }),
  headers: IdempotencyIfMatchHeaders,
  payload: CancelInterviewRequest,
});

export const CorrectInterviewAssessmentInputSchema = S.Struct({
  params: S.Struct({ interviewId: RecruitmentInterviewId }),
  headers: IdempotencyIfMatchHeaders,
  payload: CorrectInterviewAssessmentRequest,
});

const CorrectInterviewAssessmentOperation = S.Struct({
  operation: S.Literal("correctInterviewAssessment"),
  ...CorrectInterviewAssessmentInputSchema.fields,
});

const CancelInterviewOperation = S.Struct({
  operation: S.Literal("cancelInterview"),
  ...CancelInterviewInputSchema.fields,
});

export const RecruitmentInterviewConductResourceSchema = S.Struct({
  detail: RecruitmentInterviewConductObservationSchema,
  etag: StrongETag,
});

export type RecruitmentInterviewConductResource = S.Schema.Type<
  typeof RecruitmentInterviewConductResourceSchema
>;

export {
  CancelInterviewObservationSchema,
  CancelInterviewRequest,
  CancelInterviewResponse,
  CreateApplicationInterviewRequest,
  FinalizeInterviewObservationSchema,
  FinalizeInterviewRequest,
  CorrectInterviewAssessmentRequest,
  CorrectInterviewAssessmentResponse,
  FinalizeInterviewResponse,
  InterviewSchemaId,
  RecruitmentAssignmentBoardSchema,
  RecruitmentInterviewConductObservationSchema,
  RecruitmentInterviewId,
  RecruitmentInterviewResource,
  ScheduleInterviewRequest,
  ScheduleInterviewResponse,
  SchedulingBoard,
};

export const RecruitmentBridgeOperation = S.Union([
  ReadAssignmentBoardOperation,
  CreateApplicationInterviewOperation,
  ReadSchedulingBoardOperation,
  ScheduleInterviewOperation,
  ReadInterviewConductOperation,
  FinalizeInterviewOperation,
  CorrectInterviewAssessmentOperation,
  CancelInterviewOperation,
]);

export type RecruitmentBridgeOperation = S.Schema.Type<typeof RecruitmentBridgeOperation>;

export const RecruitmentBridgeOperationJson = S.fromJsonString(RecruitmentBridgeOperation);

export const RecruitmentBridgeFailure = S.TaggedUnion({
"Unauthorized": { message: S.String },
"Forbidden": { message: S.String },
"NotFound": { message: S.String },
"Validation": { message: S.String },
"Conflict": { message: S.String },
"Network": { message: S.String },
"RateLimited": { message: S.String }
});

export type RecruitmentBridgeFailure = S.Schema.Type<typeof RecruitmentBridgeFailure>;

const failure = {
  Unauthorized: RecruitmentBridgeFailure.cases.Unauthorized.make({ message: "Authentication is required" }),
  Forbidden: RecruitmentBridgeFailure.cases.Forbidden.make({ message: "Recruitment access is denied" }),
  NotFound: RecruitmentBridgeFailure.cases.NotFound.make({ message: "Recruitment record was not found" }),
  Conflict: RecruitmentBridgeFailure.cases.Conflict.make({ message: "Recruitment state has changed" }),
  Validation: RecruitmentBridgeFailure.cases.Validation.make({ message: "Recruitment input is invalid" }),
  RateLimited: RecruitmentBridgeFailure.cases.RateLimited.make({ message: "Recruitment requests are rate limited" }),
  Network: RecruitmentBridgeFailure.cases.Network.make({ message: "Recruitment request failed" }),
} as const;

/** The browser's failure when the bridge is unreachable or answers outside its contract. */
export const recruitmentNetworkFailure: RecruitmentBridgeFailure = failure.Network;

/**
 * Projects a generated-SDK failure onto the bridge. Pass the SDK cause unchanged:
 * the problem's registry status decides the case, and anything else is a transport failure.
 */
export const recruitmentFailureFromSdk = (cause: unknown): RecruitmentBridgeFailure => {
  const problem = nativeProblemFrom(cause);

  if (problem === undefined) return failure.Network;

  return Match.value(problem.status).pipe(
    Match.when(401, () => failure.Unauthorized),
    Match.when(403, () => failure.Forbidden),
    Match.when(404, () => failure.NotFound),
    Match.whenOr(409, 412, 428, () => failure.Conflict),
    Match.whenOr(400, 413, 415, 422, () => failure.Validation),
    Match.when(429, () => failure.RateLimited),
    Match.whenOr(405, 500, 503, () => failure.Network),
    Match.exhaustive,
  );
};

export const boardFailureMessage = (failure: RecruitmentBridgeFailure): string =>
  Match.value(failure._tag).pipe(
    Match.whenOr("Unauthorized", "Forbidden", () => "Du har ikke tilgang til søkeroversikten."),
    Match.when("NotFound", () => "Det finnes ingen aktiv opptaksperiode for avdelingen."),
    Match.when("Validation", () => "Søkeroversikten inneholdt ugyldige data."),
    Match.when("Conflict", () => "Søkeroversikten ble endret. Prøv å hente den på nytt."),
    Match.whenOr(
      "Network",
      "RateLimited",
      () => "Søkeroversikten er midlertidig utilgjengelig. Prøv igjen senere.",
    ),
    Match.exhaustive,
  );

export const assignmentFailureMessage = (failure: RecruitmentBridgeFailure): string =>
  Match.value(failure._tag).pipe(
    Match.whenOr("Unauthorized", "Forbidden", () => "Du har ikke tilgang til å tildele intervju."),
    Match.when(
      "NotFound",
      () => "Søkeren, intervjueren eller intervjuskjemaet finnes ikke lenger.",
    ),
    Match.when(
      "Validation",
      () => "Valget er ikke lenger gyldig. Kontroller feltene og prøv igjen.",
    ),
    Match.when(
      "Conflict",
      () => "Søkeren er allerede tildelt, eller opplysningene er endret. Oppdater oversikten.",
    ),
    Match.whenOr(
      "Network",
      "RateLimited",
      () => "Intervjuet kunne ikke tildeles nå. Prøv igjen senere.",
    ),
    Match.exhaustive,
  );

export const schedulingBoardFailureMessage = (failure: RecruitmentBridgeFailure): string =>
  Match.value(failure._tag).pipe(
    Match.whenOr("Unauthorized", "Forbidden", () => "Du har ikke tilgang til intervjuoversikten."),
    Match.when("NotFound", () => "Intervjuoversikten finnes ikke lenger."),
    Match.when("Validation", () => "Intervjuoversikten inneholdt ugyldige data."),
    Match.when("Conflict", () => "Intervjuoversikten ble endret. Hent den på nytt."),
    Match.whenOr(
      "Network",
      "RateLimited",
      () => "Intervjuoversikten er midlertidig utilgjengelig. Prøv igjen senere.",
    ),
    Match.exhaustive,
  );

export const schedulingFailureMessage = (failure: RecruitmentBridgeFailure): string =>
  Match.value(failure._tag).pipe(
    Match.whenOr(
      "Unauthorized",
      "Forbidden",
      () => "Du har ikke tilgang til å planlegge intervjuet.",
    ),
    Match.when("NotFound", () => "Intervjuet eller kontaktopplysningene finnes ikke lenger."),
    Match.when("Validation", () => "Planen er ugyldig. Kontroller feltene og prøv igjen."),
    Match.when(
      "Conflict",
      () => "Intervjuet er allerede planlagt eller har blitt endret. Hent oversikten på nytt.",
    ),
    Match.whenOr(
      "Network",
      "RateLimited",
      () => "Intervjuet kunne ikke planlegges nå. Prøv igjen senere.",
    ),
    Match.exhaustive,
  );

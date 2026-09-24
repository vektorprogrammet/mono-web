import { nativeProblemFrom } from "../../lib/native-problem";
import { Predicate, Match, Schema as S, flow, Option } from "effect";
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
"RateLimited": { message: S.String },
"Configuration": { message: S.String }
});

export type RecruitmentBridgeFailure = S.Schema.Type<typeof RecruitmentBridgeFailure>;

export const toRecruitmentBridgeFailure = flow(
 S.decodeUnknownOption(S.Union([RecruitmentBridgeFailure, S.Struct({_tag: S.String}), S.Struct({body: S.Json}), S.Json])),
 Option.getOrUndefined,
 (error): RecruitmentBridgeFailure => {
  if (S.is(RecruitmentBridgeFailure)(error)) return error;

  const problem = nativeProblemFrom(error);

  if (problem !== undefined) {
    switch (problem.status) {
      case 401:
        return RecruitmentBridgeFailure.cases.Unauthorized.make({ message: "Authentication is required" });
      case 403:
        return RecruitmentBridgeFailure.cases.Forbidden.make({ message: "Recruitment access is denied" });
      case 404:
        return RecruitmentBridgeFailure.cases.NotFound.make({ message: "Recruitment record was not found" });
      case 409:
      case 412:
      case 428:
        return RecruitmentBridgeFailure.cases.Conflict.make({ message: "Recruitment state has changed" });
      case 400:
      case 413:
      case 415:
      case 422:
        return RecruitmentBridgeFailure.cases.Validation.make({ message: "Recruitment input is invalid" });
      case 429:
        return RecruitmentBridgeFailure.cases.RateLimited.make({ message: "Recruitment requests are rate limited" });
      case 500:
      case 503:
        return RecruitmentBridgeFailure.cases.Network.make({ message: "Recruitment request failed" });
    }
  }

  const tag =
    Predicate.isObjectOrArray(error) && error !== null && "_tag" in error && Predicate.isString(error._tag)
      ? error._tag
      : "";

  if (tag.toLowerCase().includes("configuration")) {
    return RecruitmentBridgeFailure.cases.Configuration.make({ message: "Recruitment is not configured" });
  }

  return RecruitmentBridgeFailure.cases.Network.make({ message: "Recruitment request failed" });
});

export const boardFailureMessage = (failure: RecruitmentBridgeFailure): string =>
  Match.value(failure._tag).pipe(
    Match.whenOr("Unauthorized", "Forbidden", () => "Du har ikke tilgang til søkeroversikten."),
    Match.when("NotFound", () => "Det finnes ingen aktiv opptaksperiode for avdelingen."),
    Match.when("Validation", () => "Søkeroversikten inneholdt ugyldige data."),
    Match.when("Conflict", () => "Søkeroversikten ble endret. Prøv å hente den på nytt."),
    Match.whenOr(
      "Network",
      "RateLimited",
      "Configuration",
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
      "Configuration",
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
      "Configuration",
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
      "Configuration",
      () => "Intervjuet kunne ikke planlegges nå. Prøv igjen senere.",
    ),
    Match.exhaustive,
  );

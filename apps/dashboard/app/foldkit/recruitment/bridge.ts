import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import {
  CancelInterviewObservationSchema,
  FinalizeInterviewObservationSchema,
  InterviewSchemaId,
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentAssignmentBoardSchema,
  RecruitmentInterviewConductObservationSchema,
  RecruitmentInterviewId,
} from "@vektorprogrammet/domain/recruitment";
import {
  CancelInterviewRequest,
  CancelInterviewResponse,
  ConditionalReadHeaders,
  CreateApplicationInterviewRequest,
  FinalizeInterviewRequest,
  FinalizeInterviewResponse,
  IdempotencyHeaders,
  IdempotencyIfMatchHeaders,
  NativeProblem,
  RecruitmentInterviewResource,
  SchedulingBoard,
  ScheduleInterviewRequest,
  ScheduleInterviewResponse,
  StrongETag,
} from "@vektorprogrammet/http-api";
import { Match, Schema as S } from "effect";

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
  CancelInterviewOperation,
]);
export type RecruitmentBridgeOperation = S.Schema.Type<typeof RecruitmentBridgeOperation>;
export const RecruitmentBridgeOperationJson = S.fromJsonString(RecruitmentBridgeOperation);

export const RecruitmentBridgeFailure = S.Struct({
  _tag: S.Literals([
    "Unauthorized",
    "Forbidden",
    "NotFound",
    "Validation",
    "Conflict",
    "Network",
    "RateLimited",
    "Configuration",
  ]),
  message: S.String,
});
export type RecruitmentBridgeFailure = S.Schema.Type<typeof RecruitmentBridgeFailure>;

const NativeProblemSummary = S.Struct({ status: S.Number, code: S.String });
type NativeProblemSummary = S.Schema.Type<typeof NativeProblemSummary>;

const nativeProblem = (error: unknown): NativeProblemSummary | undefined => {
  const problem = S.is(NativeProblem)(error)
    ? error
    : typeof error === "object" &&
        error !== null &&
        "body" in error &&
        S.is(NativeProblem)(error.body)
      ? error.body
      : undefined;
  return problem === undefined ? undefined : S.decodeUnknownSync(NativeProblemSummary)(problem);
};

export const toRecruitmentBridgeFailure = (error: unknown): RecruitmentBridgeFailure => {
  if (S.is(RecruitmentBridgeFailure)(error)) return error;

  const problem = nativeProblem(error);
  if (problem !== undefined) {
    switch (problem.status) {
      case 401:
        return { _tag: "Unauthorized", message: "Authentication is required" };
      case 403:
        return { _tag: "Forbidden", message: "Recruitment access is denied" };
      case 404:
        return { _tag: "NotFound", message: "Recruitment record was not found" };
      case 409:
      case 412:
      case 428:
        return { _tag: "Conflict", message: "Recruitment state has changed" };
      case 400:
      case 413:
      case 415:
      case 422:
        return { _tag: "Validation", message: "Recruitment input is invalid" };
      case 429:
        return { _tag: "RateLimited", message: "Recruitment requests are rate limited" };
      case 500:
      case 503:
        return { _tag: "Network", message: "Recruitment request failed" };
    }
  }

  const tag =
    typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
      ? error._tag
      : "";
  if (tag.toLowerCase().includes("configuration")) {
    return { _tag: "Configuration", message: "Recruitment is not configured" };
  }
  return { _tag: "Network", message: "Recruitment request failed" };
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

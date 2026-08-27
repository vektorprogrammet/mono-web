import {
  RecruitmentAssignmentBoardSchema,
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentAssignmentCommandSchema,
  RecruitmentAssignmentResultSchema,
  RecruitmentInterviewId,
  RecruitmentScheduleCommandSchema,
  RecruitmentScheduleResultSchema,
  RecruitmentSchedulingBoardSchema,
} from "@vektorprogrammet/sdk/effect";
import {
  CancelInterviewCommandSchema,
  CancelInterviewResultSchema,
  FinalizeInterviewCommandSchema,
  FinalizeInterviewResultSchema,
  RecruitmentInterviewConductObservationSchema,
} from "@vektorprogrammet/sdk";
import { Match, Schema as S } from "effect";

export const RecruitmentBoardStatus = RecruitmentAssignmentBoardQuerySchema.fields.status;
export type RecruitmentBoardStatus = S.Schema.Type<typeof RecruitmentBoardStatus>;

const ReadAssignmentBoardOperation = S.Struct({
  operation: S.Literal("readAssignmentBoard"),
  query: RecruitmentAssignmentBoardQuerySchema,
});

const AssignApplicantOperation = S.Struct({
  operation: S.Literal("assignApplicant"),
  command: RecruitmentAssignmentCommandSchema,
});

const ReadSchedulingBoardOperation = S.Struct({
  operation: S.Literal("readSchedulingBoard"),
});

const ScheduleInterviewOperation = S.Struct({
  operation: S.Literal("scheduleInterview"),
  command: RecruitmentScheduleCommandSchema,
});
const ReadInterviewConductOperation = S.Struct({
  operation: S.Literal("readInterviewConduct"),
  interviewId: RecruitmentInterviewId,
});

const FinalizeInterviewOperation = S.Struct({
  operation: S.Literal("finalizeInterview"),
  command: FinalizeInterviewCommandSchema,
});

const CancelInterviewOperation = S.Struct({
  operation: S.Literal("cancelInterview"),
  command: CancelInterviewCommandSchema,
});

export {
  CancelInterviewCommandSchema,
  CancelInterviewResultSchema,
  FinalizeInterviewCommandSchema,
  FinalizeInterviewResultSchema,
  RecruitmentInterviewConductObservationSchema,
};

export const RecruitmentBridgeOperation = S.Union([
  ReadAssignmentBoardOperation,
  AssignApplicantOperation,
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

export {
  RecruitmentAssignmentBoardSchema,
  RecruitmentAssignmentResultSchema,
  RecruitmentScheduleResultSchema,
  RecruitmentSchedulingBoardSchema,
};

const errorTag = (error: unknown): string => {
  if (typeof error !== "object" || error === null) return "";
  if ("_tag" in error && typeof error._tag === "string") return error._tag;
  if ("type" in error && typeof error.type === "string") return error.type;
  return "";
};

export const toRecruitmentBridgeFailure = (error: unknown): RecruitmentBridgeFailure => {
  const tag = errorTag(error).toLocaleLowerCase("en-US");

  if (tag.includes("unauthenticated") || tag === "unauthorized") {
    return { _tag: "Unauthorized", message: "Authentication is required" };
  }
  if (
    tag.includes("forbidden") ||
    tag.includes("denied") ||
    tag.includes("inactiveactor") ||
    tag.includes("role") ||
    tag.includes("scope")
  ) {
    return { _tag: "Forbidden", message: "Recruitment access is denied" };
  }
  if (tag.includes("notfound") || tag.includes("not_found")) {
    return { _tag: "NotFound", message: "Recruitment record was not found" };
  }
  if (
    tag.includes("conflict") ||
    tag.includes("alreadyassigned") ||
    tag.includes("alreadyscheduled") ||
    tag.includes("duplicate") ||
    tag.includes("revision") ||
    tag.includes("stale")
  ) {
    return { _tag: "Conflict", message: "Recruitment state has changed" };
  }
  if (tag.includes("validation") || tag.includes("decode") || tag.includes("parse")) {
    return { _tag: "Validation", message: "Recruitment input is invalid" };
  }
  if (tag.includes("ratelimit") || tag.includes("rate_limited")) {
    return { _tag: "RateLimited", message: "Recruitment requests are rate limited" };
  }
  if (tag.includes("configuration")) {
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

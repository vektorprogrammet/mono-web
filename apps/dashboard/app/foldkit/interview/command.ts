import {
  InterviewId,
  InterviewScheduleInput,
  ResponseCapability,
  type EffectSdk,
  type InternalSdkError,
} from "@vektorprogrammet/sdk/effect"
import { Effect, Schema as S } from "effect"
import { Command } from "foldkit"
import {
  FailedCandidateResponse,
  FailedLoadInterviews,
  FailedReadCandidate,
  FailedSchedule,
  SucceededCandidateResponse,
  SucceededLoadInterviews,
  SucceededReadCandidate,
  SucceededRefreshInterview,
  SucceededSchedule,
} from "./message"

const safeAdminError = (error: unknown): string => {
  if (typeof error !== "object" || error === null || !("_tag" in error)) {
    return "Kontroller opplysningene og prøv igjen."
  }

  switch ((error as InternalSdkError)._tag) {
    case "Unauthorized":
      return "Du har ikke tilgang til intervjuene."
    case "NotFound":
      return "Det valgte intervjuet finnes ikke."
    case "Validation":
      return "Kontroller opplysningene og prøv igjen."
    case "Conflict":
      return "Intervjuet kan ikke endres i denne tilstanden."
    case "Network":
    case "RateLimited":
      return "Tjenesten er midlertidig utilgjengelig. Prøv igjen senere."
    case "Configuration":
      return "Intervjutjenesten er ikke tilgjengelig."
    default:
      return "Kontroller opplysningene og prøv igjen."
  }
}

const candidateUnavailable = "Invitasjonen er ikke tilgjengelig."

export const makeInterviewCommands = (
  client: EffectSdk,
  rawResponseCapability: string | null,
) => {
  const LoadInterviews = Command.define("LoadInterviews", {
    messages: [SucceededLoadInterviews, FailedLoadInterviews],
    execute: client.admin.interviews.list().pipe(
      Effect.map(({ items }) => SucceededLoadInterviews({ interviews: items })),
      Effect.catch((error) =>
        Effect.succeed(FailedLoadInterviews({ message: safeAdminError(error) }))
      ),
    ),
  })

  const ScheduleInterview = Command.define("ScheduleInterview", {
    args: {
      interviewId: InterviewId,
      datetime: S.String,
      room: S.String,
      campus: S.String,
      mapLink: S.String,
      from: S.String,
      to: S.String,
      message: S.String,
    },
    messages: [SucceededSchedule, FailedSchedule],
    execute: ({
      interviewId,
      datetime,
      room,
      campus,
      mapLink,
      from,
      to,
      message,
    }) =>
      S.decodeUnknownEffect(InterviewScheduleInput)({
        datetime,
        room,
        campus,
        mapLink,
        from,
        to,
        message,
      }).pipe(
        Effect.flatMap((input) => client.admin.interviews.schedule(interviewId, input)),
        Effect.as(SucceededSchedule()),
        Effect.catch((error) =>
          Effect.succeed(FailedSchedule({ message: safeAdminError(error) }))
        ),
      ),
  })

  const RefreshInterview = Command.define("RefreshInterview", {
    args: { interviewId: InterviewId },
    messages: [SucceededRefreshInterview, FailedSchedule],
    execute: ({ interviewId }) =>
      client.admin.interviews.read(interviewId).pipe(
        Effect.map((interview) => SucceededRefreshInterview({ interview })),
        Effect.catch((error) =>
          Effect.succeed(FailedSchedule({ message: safeAdminError(error) }))
        ),
      ),
  })

  const ReadCandidate = Command.define("ReadCandidate", {
    messages: [SucceededReadCandidate, FailedReadCandidate],
    execute: S.decodeUnknownEffect(ResponseCapability)(rawResponseCapability).pipe(
      Effect.flatMap((capability) => client.interviewResponses.read(capability)),
      Effect.map((candidate) => SucceededReadCandidate({ candidate })),
      Effect.catch(() =>
        Effect.succeed(FailedReadCandidate({ message: candidateUnavailable }))
      ),
    ),
  })

  const ConfirmCandidate = Command.define("ConfirmCandidate", {
    messages: [SucceededCandidateResponse, FailedCandidateResponse],
    execute: S.decodeUnknownEffect(ResponseCapability)(rawResponseCapability).pipe(
      Effect.flatMap((capability) => client.interviewResponses.confirm(capability)),
      Effect.as(SucceededCandidateResponse()),
      Effect.catch(() =>
        Effect.succeed(FailedCandidateResponse({ message: candidateUnavailable }))
      ),
    ),
  })

  const RejectCandidate = Command.define("RejectCandidate", {
    args: { message: S.String },
    messages: [SucceededCandidateResponse, FailedCandidateResponse],
    execute: ({ message }) => S.decodeUnknownEffect(ResponseCapability)(rawResponseCapability).pipe(
      Effect.flatMap((capability) => client.interviewResponses.reject(capability, message)),
      Effect.as(SucceededCandidateResponse()),
      Effect.catch(() =>
        Effect.succeed(FailedCandidateResponse({ message: candidateUnavailable }))
      ),
    ),
  })

  const RequestNewTimeCandidate = Command.define("RequestNewTimeCandidate", {
    args: { message: S.String },
    messages: [SucceededCandidateResponse, FailedCandidateResponse],
    execute: ({ message }) => S.decodeUnknownEffect(ResponseCapability)(rawResponseCapability).pipe(
      Effect.flatMap((capability) => client.interviewResponses.requestNewTime(capability, message)),
      Effect.as(SucceededCandidateResponse()),
      Effect.catch(() =>
        Effect.succeed(FailedCandidateResponse({ message: candidateUnavailable }))
      ),
    ),
  })

  return {
    LoadInterviews,
    ScheduleInterview,
    RefreshInterview,
    ReadCandidate,
    ConfirmCandidate,
    RejectCandidate,
    RequestNewTimeCandidate,
  }
}

export type InterviewCommands = ReturnType<typeof makeInterviewCommands>

import {
  AssignedInterviewId,
  Cycle,
  ResponseCapability,
  type EffectSdk,
  type InterviewScheduleInput,
  type InternalSdkError,
} from "@vektorprogrammet/sdk/effect"
import { Effect, Schema as S } from "effect"
import { Command } from "foldkit"
import {
  FailedAcceptCandidate,
  FailedLoadInterviews,
  FailedReadCandidate,
  FailedSchedule,
  SucceededAcceptCandidate,
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
      return "Du har ikke tilgang til denne avdelingen."
    case "NotFound":
      return "Det valgte intervjuet eller semesteret finnes ikke."
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

const CycleArgs = {
  departmentId: S.String,
  semesterId: S.String,
}
const InterviewArgs = {
  ...CycleArgs,
  interviewId: S.String,
}

export const makeInterviewCommands = (
  client: EffectSdk,
  rawResponseCapability: string | null,
) => {
  const LoadInterviews = Command.define("LoadInterviews", {
    args: CycleArgs,
    messages: [SucceededLoadInterviews, FailedLoadInterviews],
    execute: ({ departmentId, semesterId }) =>
      S.decodeUnknownEffect(Cycle)({ departmentId, semesterId }).pipe(
        Effect.flatMap((cycle) => client.admin.interviews.listAssigned(cycle)),
        Effect.map((interviews) => SucceededLoadInterviews({ interviews })),
        Effect.catch((error) =>
          Effect.succeed(FailedLoadInterviews({ message: safeAdminError(error) }))
        ),
      ),
  })

  const ScheduleInterview = Command.define("ScheduleInterview", {
    args: {
      ...InterviewArgs,
      interviewTime: S.String,
      room: S.String,
      campus: S.String,
    },
    messages: [SucceededSchedule, FailedSchedule],
    execute: ({
      departmentId,
      semesterId,
      interviewId,
      interviewTime,
      room,
      campus,
    }) =>
      Effect.all({
        cycle: S.decodeUnknownEffect(Cycle)({ departmentId, semesterId }),
        id: S.decodeUnknownEffect(AssignedInterviewId)(interviewId),
      }).pipe(
        Effect.flatMap(({ cycle, id }) => {
          const input: InterviewScheduleInput = { interviewTime, room, campus }
          return client.admin.interviews.scheduleForCycle(cycle, id, input)
        }),
        Effect.as(SucceededSchedule()),
        Effect.catch((error) =>
          Effect.succeed(FailedSchedule({ message: safeAdminError(error) }))
        ),
      ),
  })

  const RefreshInterview = Command.define("RefreshInterview", {
    args: InterviewArgs,
    messages: [SucceededRefreshInterview, FailedSchedule],
    execute: ({ departmentId, semesterId, interviewId }) =>
      Effect.all({
        cycle: S.decodeUnknownEffect(Cycle)({ departmentId, semesterId }),
        id: S.decodeUnknownEffect(AssignedInterviewId)(interviewId),
      }).pipe(
        Effect.flatMap(({ cycle, id }) =>
          client.admin.interviews.readAssigned(cycle, id)
        ),
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

  const AcceptCandidate = Command.define("AcceptCandidate", {
    messages: [SucceededAcceptCandidate, FailedAcceptCandidate],
    execute: S.decodeUnknownEffect(ResponseCapability)(rawResponseCapability).pipe(
      Effect.flatMap((capability) => client.interviewResponses.accept(capability)),
      Effect.as(SucceededAcceptCandidate()),
      Effect.catch(() =>
        Effect.succeed(FailedAcceptCandidate({ message: candidateUnavailable }))
      ),
    ),
  })

  return {
    LoadInterviews,
    ScheduleInterview,
    RefreshInterview,
    ReadCandidate,
    AcceptCandidate,
  }
}

export type InterviewCommands = ReturnType<typeof makeInterviewCommands>

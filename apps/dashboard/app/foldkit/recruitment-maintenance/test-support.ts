import { AssessmentCorrection } from "@vektorprogrammet/domain/recruitment";
import { Instant } from "@vektorprogrammet/domain/time";
import {
  DepartmentId,
  PersonId,
  RecruitmentInterviewId,
  InterviewStaffingManagement,
  RecruitmentMaintenanceCommand,
} from "@vektorprogrammet/http-api";
import { Effect, Schema } from "effect";
import { Command } from "foldkit";
import {
  CompletedPrepareEdit,
  FailedLoad,
  FailedSave,
  SucceededQuestionnaires,
  SucceededStaffing,
  SucceededSave,
} from "./message";
import { init, Mode, type Model } from "./model";

export const testCommandId = "correction-window-command-0029";

export const testInterviewId = "correction-window-interview-0029";

export const staffingModel = (assessmentCorrection: AssessmentCorrection): Model => ({
  ...init("Staffing"),
  status: "Ready",
  selectedId: testInterviewId,
  commandId: testCommandId,
  expectedRevision: 4,
  staffing: InterviewStaffingManagement.make({
    interviews: [
      {
        interviewId: RecruitmentInterviewId.make(testInterviewId),
        departmentId: DepartmentId.make("correction-window-department"),
        applicantName: "Synthetic applicant",
        interviewerPersonId: PersonId.make("correction-window-primary"),
        coInterviewerPersonId: PersonId.make("correction-window-co"),
        revision: 4,
        terminal: true,
        assessmentCorrection,
      },
    ],
    candidates: [],
    history: [],
  }),
});

export const closedObservation = (canReopen = true) =>
  AssessmentCorrection.cases.Closed.make({
    sequence: 2,
    canCorrect: false,
    canReopen,
    canClose: false,
  });

export const openObservation = (
  canCorrect = false,
  canClose = true,
  endsAt = "2031-09-14T13:00:00Z",
) =>
  AssessmentCorrection.cases.Open.make({
    sequence: 3,
    openedBy: PersonId.make("correction-window-primary"),
    endsAt: Schema.decodeSync(Instant)(endsAt),
    canCorrect,
    canReopen: false,
    canClose,
  });

export const expiredObservation = (canReopen = true) =>
  AssessmentCorrection.cases.Expired.make({
    sequence: 3,
    openedBy: PersonId.make("correction-window-primary"),
    endsAt: Schema.decodeSync(Instant)("2031-09-14T13:00:00Z"),
    canCorrect: false,
    canReopen,
    canClose: false,
  });

const loadMessages = [SucceededQuestionnaires, SucceededStaffing, FailedLoad] as const;

type LoadResponse = Schema.Schema.Type<(typeof loadMessages)[number]>;

/** Story and Scene resolve these definitions; an accidental execute is observable. */
export const testCommands = (onExecute: () => void = () => {}) => ({
  Load: Command.define("LoadRecruitmentMaintenance", {
    args: { mode: Mode, requestId: Schema.Int },
    messages: loadMessages,
    execute: ({ requestId }): Effect.Effect<LoadResponse> =>
      Effect.sync(() => {
        onExecute();

        return FailedLoad({ requestId, denied: false });
      }),
  }),
  Save: Command.define("SaveRecruitmentMaintenance", {
    args: { command: RecruitmentMaintenanceCommand },
    messages: [SucceededSave, FailedSave],
    execute: ({ command }) =>
      Effect.sync(() => {
        onExecute();

        return FailedSave({
          commandId: command.commandId,
          conflict: false,
          message: "Uncertain response",
        });
      }),
  }),
  PrepareEdit: Command.define("PrepareMaintenanceEdit", {
    messages: [CompletedPrepareEdit],
    execute: Effect.sync(() => {
      onExecute();

      return CompletedPrepareEdit({ commandId: "new-correction-window-command-0029" });
    }),
  }),
});

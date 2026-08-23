import {
  RecruitmentScheduleCommandSchema,
  type RecruitmentScheduleCommand,
} from "@vektorprogrammet/sdk/effect";
import { Dialog } from "@foldkit/ui";
import { Match as M, Option, Schema as S } from "effect";
import { AsyncData, Command, FieldValidation } from "foldkit";
import type { SchedulingCommands } from "./command";
import { GotScheduleDialogMessage, type Message } from "./message";
import { SchedulingBoardData, type Model, type ReadyModel } from "./model";

const roomRules = FieldValidation.makeRules({
  required: "Feltet må fylles ut.",
  isEmpty: (value) => value.trim() === "",
  rules: [[(value) => value.trim().length <= 250, "Rom kan ikke være lengre enn 250 tegn."]],
});
const messageRules = FieldValidation.makeRules({
  required: "Feltet må fylles ut.",
  isEmpty: (value) => value.trim() === "",
  rules: [
    [(value) => value.trim().length <= 2_000, "Meldingen kan ikke være lengre enn 2000 tegn."],
  ],
});

const scheduledAtRules = FieldValidation.makeRules({
  required: "Velg tidspunkt.",
  isEmpty: (value) => value.trim() === "",
  rules: [
    [
      (value) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          value.trim(),
        ) && Number.isFinite(Date.parse(value)),
      "Bruk et gyldig tidspunkt med tidssone, for eksempel 2026-09-14T15:00:00+02:00.",
    ],
  ],
});
const campusRules = FieldValidation.makeRules({
  required: "",
  isEmpty: () => false,
  rules: [
    [
      (value) => value.trim().length === 0 || value.trim().length <= 250,
      "Campus kan ikke være lengre enn 250 tegn.",
    ],
  ],
});
const secureMapLink = (value: string): boolean => {
  const normalized = value.trim();
  if (normalized.length === 0) return true;
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" && url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
};
const mapLinkRules = FieldValidation.makeRules({
  required: "",
  isEmpty: () => false,
  rules: [[secureMapLink, "Kartlenken må være en HTTPS-adresse uten brukernavn eller passord."]],
});

const emptyField = () => FieldValidation.NotValidated({ value: "" });

const mapDialogCommands = (commands: ReadonlyArray<Command.Command<Dialog.Message>>) =>
  Command.mapMessages(commands, (message) => GotScheduleDialogMessage({ message }));

const clearSchedule = (model: ReadyModel): ReadyModel => ({
  ...model,
  selectedInterviewId: null,
  scheduledAt: emptyField(),
  room: emptyField(),
  campus: emptyField(),
  mapLink: emptyField(),
  message: emptyField(),
  isScheduling: false,
  scheduleError: null,
});


const successFeedback = (
  state: "Pending" | "Processing" | "Delivered" | "Failed" | "Quarantined",
): string => {
  switch (state) {
    case "Pending":
      return "Intervjuet er planlagt. Invitasjonen er lagt i kø for sending.";
    case "Processing":
      return "Intervjuet er planlagt. Invitasjonen behandles for sending.";
    case "Delivered":
      return "Intervjuet er planlagt, og invitasjonen er levert.";
    case "Failed":
      return "Intervjuet er planlagt, men invitasjonen kunne ikke leveres.";
    case "Quarantined":
      return "Intervjuet er planlagt, men invitasjonen krever oppfølging.";
  }
};

export const makeUpdate =
  ({ LoadSchedulingBoard, ScheduleInterview }: SchedulingCommands) =>
  (model: Model, message: Message): readonly [Model, ReadonlyArray<Command.Command<Message>>] => {
    if (model._tag === "InvalidInput") return [model, []];

    return M.value(message).pipe(
      M.withReturnType<readonly [Model, ReadonlyArray<Command.Command<Message>>]>(),
      M.tagsExhaustive({
        RequestedBoardRefresh: () => {
          if (model.isScheduling) return [model, []];
          const requestId = model.boardRequestId + 1;
          const [scheduleDialog, dialogCommands] = Dialog.close(model.scheduleDialog);
          return [
            {
              ...clearSchedule(model),
              scheduleDialog,
              board: SchedulingBoardData.Loading(),
              boardRequestId: requestId,
              feedback: null,
              commandSequence: model.commandSequence + 1,
            },
            [...mapDialogCommands(dialogCommands), LoadSchedulingBoard({ requestId })],
          ];
        },
        SucceededLoadSchedulingBoard: ({ requestId, board }) =>
          requestId !== model.boardRequestId
            ? [model, []]
            : [
                {
                  ...model,
                  board: SchedulingBoardData.Success({ data: board }),
                  feedback: null,
                },
                [],
              ],
        FailedLoadSchedulingBoard: ({ requestId, message: failureMessage }) =>
          requestId !== model.boardRequestId
            ? [model, []]
            : [
                {
                  ...clearSchedule(model),
                  board: SchedulingBoardData.Failure({ error: failureMessage }),
                  feedback: null,
                },
                [],
              ],
        OpenedSchedule: ({ interviewId }) => {
          if (model.isScheduling) return [model, []];
          const board = AsyncData.getData(model.board);
          if (board._tag === "None") return [model, []];
          const interview = board.value.interviews.find(
            (candidate) => candidate.interviewId === interviewId,
          );
          if (interview === undefined || interview.schedule !== null) return [model, []];
          const [scheduleDialog, dialogCommands] = Dialog.open(model.scheduleDialog);
          return [
            {
              ...clearSchedule(model),
              scheduleDialog,
              selectedInterviewId: interviewId,
              feedback: null,
              commandSequence: model.commandSequence + 1,
            },
            mapDialogCommands(dialogCommands),
          ];
        },
        ClosedSchedule: () => {
          if (model.isScheduling) return [model, []];
          const [scheduleDialog, dialogCommands] = Dialog.close(model.scheduleDialog);
          return [
            {
              ...clearSchedule(model),
              scheduleDialog,
              commandSequence: model.commandSequence + 1,
            },
            mapDialogCommands(dialogCommands),
          ];
        },
        UpdatedScheduledAt: ({ value }) => [
          {
            ...model,
            scheduledAt: FieldValidation.validate(scheduledAtRules)(value),
            scheduleError: null,
            feedback: null,
            commandSequence: model.commandSequence + 1,
          },
          [],
        ],
        UpdatedRoom: ({ value }) => [
          {
            ...model,
            room: FieldValidation.validate(roomRules)(value),
            scheduleError: null,
            feedback: null,
            commandSequence: model.commandSequence + 1,
          },
          [],
        ],
        UpdatedCampus: ({ value }) => [
          {
            ...model,
            campus: FieldValidation.validate(campusRules)(value),
            scheduleError: null,
            feedback: null,
            commandSequence: model.commandSequence + 1,
          },
          [],
        ],
        UpdatedMapLink: ({ value }) => [
          {
            ...model,
            mapLink: FieldValidation.validate(mapLinkRules)(value),
            scheduleError: null,
            feedback: null,
            commandSequence: model.commandSequence + 1,
          },
          [],
        ],
        UpdatedMessage: ({ value }) => [
          {
            ...model,
            message: FieldValidation.validate(messageRules)(value),
            scheduleError: null,
            feedback: null,
            commandSequence: model.commandSequence + 1,
          },
          [],
        ],
        SubmittedSchedule: () => {
          if (model.isScheduling || model.selectedInterviewId === null) return [model, []];
          const board = AsyncData.getData(model.board);
          if (board._tag === "None") return [model, []];
          const interview = board.value.interviews.find(
            (candidate) => candidate.interviewId === model.selectedInterviewId,
          );
          if (interview === undefined || interview.schedule !== null) {
            return [
              {
                ...model,
                scheduleError: "Intervjuet er ikke lenger tilgjengelig for planlegging. Hent oversikten på nytt.",
              },
              [],
            ];
          }

          const scheduledAt = FieldValidation.validate(scheduledAtRules)(model.scheduledAt.value);
          const room = FieldValidation.validate(roomRules)(model.room.value);
          const campus = FieldValidation.validate(campusRules)(model.campus.value);
          const mapLink = FieldValidation.validate(mapLinkRules)(model.mapLink.value);
          const scheduleMessage = FieldValidation.validate(messageRules)(model.message.value);
          const fieldsAreValid =
            FieldValidation.isValid(scheduledAtRules)(scheduledAt) &&
            FieldValidation.isValid(roomRules)(room) &&
            FieldValidation.isValid(campusRules)(campus) &&
            FieldValidation.isValid(mapLinkRules)(mapLink) &&
            FieldValidation.isValid(messageRules)(scheduleMessage);

          if (!fieldsAreValid) {
            return [
              {
                ...model,
                scheduledAt,
                room,
                campus,
                mapLink,
                message: scheduleMessage,
                scheduleError: "Kontroller feltene og prøv igjen.",
                feedback: null,
              },
              [],
            ];
          }

          let command: RecruitmentScheduleCommand;
          try {
            command = S.decodeUnknownSync(RecruitmentScheduleCommandSchema)(
              {
                commandId: `${model.commandIdSeed}-${model.commandSequence}`,
                interviewId: interview.interviewId,
                expectedRevision: interview.revision,
                scheduledAt: scheduledAt.value.trim(),
                room: room.value.trim(),
                campus: campus.value.trim().length === 0 ? null : campus.value.trim(),
                mapLink: mapLink.value.trim().length === 0 ? null : mapLink.value.trim(),
                message: scheduleMessage.value.trim(),
              },
              { onExcessProperty: "error" },
            );
          } catch {
            return [
              {
                ...model,
                scheduledAt,
                room,
                campus,
                mapLink,
                message: scheduleMessage,
                scheduleError: "Kontroller feltene og prøv igjen.",
                feedback: null,
              },
              [],
            ];
          }

          const requestId = model.boardRequestId + 1;
          return [
            {
              ...model,
              scheduledAt,
              room,
              campus,
              mapLink,
              message: scheduleMessage,
              isScheduling: true,
              scheduleError: null,
              feedback: null,
              boardRequestId: requestId,
            },
            [ScheduleInterview({ requestId, command })],
          ];
        },
        SucceededSchedule: ({ requestId, board }) => {
          if (requestId !== model.boardRequestId || !model.isScheduling) return [model, []];
          const scheduledInterview = board.interviews.find(
            (interview) => interview.interviewId === model.selectedInterviewId,
          );
          if (
            scheduledInterview === undefined ||
            scheduledInterview.schedule === null ||
            scheduledInterview.responseState !== "Pending" ||
            scheduledInterview.notificationState === null
          ) {
            return [
              {
                ...model,
                board: SchedulingBoardData.Success({ data: board }),
                isScheduling: false,
                scheduleError:
                  "Intervjuoversikten bekreftet ikke den lagrede planen. Hent oversikten på nytt.",
                feedback: null,
              },
              [],
            ];
          }
          const [scheduleDialog, dialogCommands] = Dialog.close(model.scheduleDialog);
          return [
            {
              ...clearSchedule(model),
              scheduleDialog,
              board: SchedulingBoardData.Success({ data: board }),
              feedback: successFeedback(scheduledInterview.notificationState),
              commandSequence: model.commandSequence + 1,
            },
            mapDialogCommands(dialogCommands),
          ];
        },
        FailedSchedule: ({ requestId, message: failureMessage }) =>
          requestId !== model.boardRequestId
            ? [model, []]
            : [
                {
                  ...model,
                  isScheduling: false,
                  scheduleError: failureMessage,
                  feedback: null,
                },
                [],
              ],
        GotScheduleDialogMessage: ({ message: dialogMessage }) => {
          if (model.isScheduling && dialogMessage._tag === "RequestedClose") return [model, []];
          const [scheduleDialog, dialogCommands, output] = Dialog.update(
            model.scheduleDialog,
            dialogMessage,
          );
          const next = { ...model, scheduleDialog };
          return [
            Option.isSome(output) && output.value._tag === "Closed"
              ? {
                  ...clearSchedule(next),
                  commandSequence: model.commandSequence + 1,
                }
              : next,
            mapDialogCommands(dialogCommands),
          ];
        },
      }),
    );
  };

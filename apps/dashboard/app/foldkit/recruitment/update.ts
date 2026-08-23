import { RecruitmentAssignmentCommandSchema } from "@vektorprogrammet/sdk/effect";
import { Dialog } from "@foldkit/ui";
import { Match as M, Option, Schema as S } from "effect";
import { AsyncData, Command } from "foldkit";
import type { RecruitmentCommands } from "./command";
import { GotAssignmentDialogMessage, type Message } from "./message";
import { AssignmentBoardData, type Model, type ReadyModel } from "./model";

const mapDialogCommands = (commands: ReadonlyArray<Command.Command<Dialog.Message>>) =>
  Command.mapMessages(commands, (message) => GotAssignmentDialogMessage({ message }));

const clearAssignment = (model: ReadyModel): ReadyModel => ({
  ...model,
  selectedApplicationId: null,
  selectedInterviewerPersonId: null,
  selectedInterviewSchemaId: null,
  isAssigning: false,
  assignmentError: null,
});

const boardFrom = (model: ReadyModel) => AsyncData.getData(model.board);

export const makeUpdate =
  ({ LoadAssignmentBoard, AssignApplicant }: RecruitmentCommands) =>
  (model: Model, message: Message): readonly [Model, ReadonlyArray<Command.Command<Message>>] => {
    if (model._tag === "InvalidInput") return [model, []];

    return M.value(message).pipe(
      M.withReturnType<readonly [Model, ReadonlyArray<Command.Command<Message>>]>(),
      M.tagsExhaustive({
        SelectedFilter: ({ status }) => {
          if (model.isAssigning) return [model, []];
          const requestId = model.boardRequestId + 1;
          const [assignmentDialog, dialogCommands] = Dialog.close(model.assignmentDialog);
          return [
            {
              ...clearAssignment(model),
              assignmentDialog,
              selectedFilter: status,
              boardRequestId: requestId,
              board: AssignmentBoardData.Loading(),
              feedback: null,
            },
            [...mapDialogCommands(dialogCommands), LoadAssignmentBoard({ status, requestId })],
          ];
        },
        SucceededLoadBoard: ({ requestId, board }) =>
          requestId !== model.boardRequestId
            ? [model, []]
            : [
                { ...model, board: AssignmentBoardData.Success({ data: board }), feedback: null },
                [],
              ],
        FailedLoadBoard: ({ requestId, message }) =>
          requestId !== model.boardRequestId
            ? [model, []]
            : [
                {
                  ...clearAssignment(model),
                  board: AssignmentBoardData.Failure({ error: message }),
                  feedback: null,
                },
                [],
              ],
        OpenedAssignment: ({ applicationId }) => {
          if (model.isAssigning) return [model, []];
          const board = boardFrom(model);
          if (board._tag === "None") return [model, []];
          const candidate = board.value.candidates.find(
            (item) => item.applicationId === applicationId,
          );
          if (candidate === undefined || candidate.interviewState !== "Unassigned") {
            return [model, []];
          }
          const [assignmentDialog, dialogCommands] = Dialog.open(model.assignmentDialog);
          return [
            {
              ...model,
              assignmentDialog,
              selectedApplicationId: applicationId,
              selectedInterviewerPersonId: null,
              selectedInterviewSchemaId: null,
              assignmentError: null,
              feedback: null,
            },
            mapDialogCommands(dialogCommands),
          ];
        },
        ClosedAssignment: () => {
          if (model.isAssigning) return [model, []];
          const [assignmentDialog, dialogCommands] = Dialog.close(model.assignmentDialog);
          return [
            {
              ...clearAssignment(model),
              assignmentDialog,
              commandSequence: model.commandSequence + 1,
            },
            mapDialogCommands(dialogCommands),
          ];
        },
        SelectedInterviewer: ({ personId }) => {
          if (model.isAssigning) return [model, []];
          const board = boardFrom(model);
          if (
            board._tag === "None" ||
            !board.value.interviewers.some((option) => option.personId === personId)
          ) {
            return [model, []];
          }
          return [{ ...model, selectedInterviewerPersonId: personId, assignmentError: null }, []];
        },
        SelectedSchema: ({ interviewSchemaId }) => {
          if (model.isAssigning) return [model, []];
          const board = boardFrom(model);
          if (
            board._tag === "None" ||
            !board.value.interviewSchemas.some(
              (option) => option.interviewSchemaId === interviewSchemaId && option.active,
            )
          ) {
            return [model, []];
          }
          return [
            { ...model, selectedInterviewSchemaId: interviewSchemaId, assignmentError: null },
            [],
          ];
        },
        SubmittedAssignment: () => {
          if (model.isAssigning || model.selectedApplicationId === null) return [model, []];
          if (
            model.selectedInterviewerPersonId === null ||
            model.selectedInterviewSchemaId === null
          ) {
            return [{ ...model, assignmentError: "Velg både intervjuer og intervjuskjema." }, []];
          }
          const board = boardFrom(model);
          if (board._tag === "None") return [model, []];
          const candidate = board.value.candidates.find(
            (item) => item.applicationId === model.selectedApplicationId,
          );
          const validInterviewer = board.value.interviewers.some(
            (option) => option.personId === model.selectedInterviewerPersonId,
          );
          const validSchema = board.value.interviewSchemas.some(
            (option) =>
              option.interviewSchemaId === model.selectedInterviewSchemaId && option.active,
          );
          if (
            candidate === undefined ||
            candidate.interviewState !== "Unassigned" ||
            !validInterviewer ||
            !validSchema
          ) {
            return [
              {
                ...model,
                assignmentError: "Valget er ikke lenger gyldig. Oppdater oversikten.",
              },
              [],
            ];
          }
          const command = S.decodeUnknownSync(RecruitmentAssignmentCommandSchema)(
            {
              commandId: `${model.commandIdSeed}-${model.commandSequence}`,
              applicationId: model.selectedApplicationId,
              interviewerPersonId: model.selectedInterviewerPersonId,
              interviewSchemaId: model.selectedInterviewSchemaId,
            },
            { onExcessProperty: "error" },
          );
          return [
            { ...model, isAssigning: true, assignmentError: null, feedback: null },
            [
              AssignApplicant({
                command,
                status: model.selectedFilter,
              }),
            ],
          ];
        },
        SucceededAssignment: ({ board }) => {
          const [assignmentDialog, dialogCommands] = Dialog.close(model.assignmentDialog);
          return [
            {
              ...clearAssignment(model),
              assignmentDialog,
              board: AssignmentBoardData.Success({ data: board }),
              feedback: "Intervjuet er tildelt.",
              commandSequence: model.commandSequence + 1,
            },
            mapDialogCommands(dialogCommands),
          ];
        },
        FailedAssignment: ({ message }) => [
          {
            ...model,
            isAssigning: false,
            assignmentError: message,
            feedback: null,
          },
          [],
        ],
        GotAssignmentDialogMessage: ({ message: dialogMessage }) => {
          if (model.isAssigning && dialogMessage._tag === "RequestedClose") return [model, []];
          const [assignmentDialog, dialogCommands, output] = Dialog.update(
            model.assignmentDialog,
            dialogMessage,
          );
          const next = { ...model, assignmentDialog };
          return [
            Option.isSome(output) && output.value._tag === "Closed"
              ? {
                  ...clearAssignment(next),
                  commandSequence: model.commandSequence + 1,
                }
              : next,
            mapDialogCommands(dialogCommands),
          ];
        },
      }),
    );
  };

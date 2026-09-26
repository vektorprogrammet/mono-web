import { Predicate } from "effect";
import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { Dialog } from "@foldkit/ui";
import { Match as M, Option, Schema as S } from "effect";
import { AsyncData, Command, Update } from "foldkit";
import { CreateApplicationInterviewInputSchema } from "./bridge";
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

export const updateFor =
  ({ LoadAssignmentBoard, CreateApplicationInterview }: RecruitmentCommands) =>
  (model: Model, message: Message): Update.Return<Model, Message> => {
    if (!Predicate.isTagged(model, "Ready")) return ({ model: model, commands: [] });

    return M.value(message).pipe(
      M.withReturnType<Update.Return<Model, Message>>(),
      M.tagsExhaustive({
        SelectedFilter: ({ status }) => {
          if (model.isAssigning) return ({ model: model, commands: [] });
          const requestId = model.boardRequestId + 1;
          const { model: assignmentDialog, commands: dialogCommands = [] } = Dialog.close(model.assignmentDialog);

          return ({ model: 
            {
              ...clearAssignment(model),
              assignmentDialog,
              selectedFilter: status,
              boardRequestId: requestId,
              board: AssignmentBoardData.Loading(),
              feedback: null,
            }, commands: [...mapDialogCommands(dialogCommands), LoadAssignmentBoard({ status, requestId })] });
        },
        SucceededLoadBoard: ({ requestId, board }) =>
          requestId !== model.boardRequestId
            ? ({ model: model, commands: [] })
            : ({ model: 
                { ...model, board: AssignmentBoardData.Success({ data: board }), feedback: null }, commands: [] }),
        FailedLoadBoard: ({ requestId, message }) =>
          requestId !== model.boardRequestId
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...clearAssignment(model),
                  board: AssignmentBoardData.Failure({ error: message }),
                  feedback: null,
                }, commands: [] }),
        OpenedAssignment: ({ applicationId }) => {
          if (model.isAssigning) return ({ model: model, commands: [] });
          const board = boardFrom(model);

          if (Option.isNone(board)) return ({ model: model, commands: [] });

          const candidate = board.value.candidates.find(
            (item) => item.applicationId === applicationId,
          );

          if (candidate === undefined || candidate.interviewState !== "Unassigned") {
            return ({ model: model, commands: [] });
          }

          const { model: assignmentDialog, commands: dialogCommands = [] } = Dialog.open(model.assignmentDialog);

          return ({ model: 
            {
              ...model,
              assignmentDialog,
              selectedApplicationId: applicationId,
              selectedInterviewerPersonId: null,
              selectedInterviewSchemaId: null,
              assignmentError: null,
              feedback: null,
            }, commands: mapDialogCommands(dialogCommands) });
        },
        ClosedAssignment: () => {
          if (model.isAssigning) return ({ model: model, commands: [] });
          const { model: assignmentDialog, commands: dialogCommands = [] } = Dialog.close(model.assignmentDialog);

          return ({ model: 
            {
              ...clearAssignment(model),
              assignmentDialog,
              commandSequence: model.commandSequence + 1,
            }, commands: mapDialogCommands(dialogCommands) });
        },
        SelectedInterviewer: ({ personId }) => {
          if (model.isAssigning) return ({ model: model, commands: [] });
          const board = boardFrom(model);

          if (
            Option.isNone(board) ||
            !board.value.interviewers.some((option) => option.personId === personId)
          ) {
            return ({ model: model, commands: [] });
          }

          return ({ model: { ...model, selectedInterviewerPersonId: personId, assignmentError: null }, commands: [] });
        },
        SelectedSchema: ({ interviewSchemaId }) => {
          if (model.isAssigning) return ({ model: model, commands: [] });
          const board = boardFrom(model);

          if (
            Option.isNone(board) ||
            !board.value.interviewSchemas.some(
              (option) => option.interviewSchemaId === interviewSchemaId && option.active,
            )
          ) {
            return ({ model: model, commands: [] });
          }

          return ({ model: 
            { ...model, selectedInterviewSchemaId: interviewSchemaId, assignmentError: null }, commands: [] });
        },
        SubmittedAssignment: () => {
          if (model.isAssigning || model.selectedApplicationId === null) return ({ model: model, commands: [] });

          if (
            model.selectedInterviewerPersonId === null ||
            model.selectedInterviewSchemaId === null
          ) {
            return ({ model: { ...model, assignmentError: "Velg både intervjuer og intervjuskjema." }, commands: [] });
          }

          const board = boardFrom(model);

          if (Option.isNone(board)) return ({ model: model, commands: [] });

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
            return ({ model: 
              {
                ...model,
                assignmentError: "Valget er ikke lenger gyldig. Oppdater oversikten.",
              }, commands: [] });
          }

          const input = S.decodeSync(CreateApplicationInterviewInputSchema)(
            {
              params: { applicationId: model.selectedApplicationId },
              headers: {
                "idempotency-key": IdempotencyKey.make(
                  `${model.idempotencyKeySeed}-${model.commandSequence}`,
                ),
              },
              payload: {
                interviewerPersonId: model.selectedInterviewerPersonId,
                interviewSchemaId: model.selectedInterviewSchemaId,
              },
            },
            { onExcessProperty: "error" },
          );

          return ({ model: 
            { ...model, isAssigning: true, assignmentError: null, feedback: null }, commands: [
              CreateApplicationInterview({
                input,
                status: model.selectedFilter,
              }),
            ] });
        },
        SucceededAssignment: ({ board }) => {
          const { model: assignmentDialog, commands: dialogCommands = [] } = Dialog.close(model.assignmentDialog);

          return ({ model: 
            {
              ...clearAssignment(model),
              assignmentDialog,
              board: AssignmentBoardData.Success({ data: board }),
              feedback: "Intervjuet er tildelt.",
              commandSequence: model.commandSequence + 1,
            }, commands: mapDialogCommands(dialogCommands) });
        },
        FailedAssignment: ({ message }) => ({ model: 
          {
            ...model,
            isAssigning: false,
            assignmentError: message,
            feedback: null,
          }, commands: [] }),
        GotAssignmentDialogMessage: ({ message: dialogMessage }) => {
          if (model.isAssigning && Predicate.isTagged(dialogMessage, "RequestedClose")) return ({ model: model, commands: [] });

          const { model: assignmentDialog, commands: dialogCommands = [], outMessage: output } = Dialog.update(
            model.assignmentDialog,
            dialogMessage,
          );

          const next = { ...model, assignmentDialog };

          return ({ model: 
            output !== undefined && Predicate.isTagged(output, "Closed")
              ? {
                  ...clearAssignment(next),
                  commandSequence: model.commandSequence + 1,
                }
              : next, commands: mapDialogCommands(dialogCommands) });
        },
      }),
    );
  };

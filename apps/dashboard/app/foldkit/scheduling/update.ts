import type { RecruitmentInterviewQuestionSnapshot } from "@vektorprogrammet/domain/recruitment";
import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { Dialog } from "@foldkit/ui";
import { Match as M, Option, Schema as S } from "effect";
import { AsyncData, Command, FieldValidation } from "foldkit";
import {
  CancelInterviewInputSchema,
  FinalizeInterviewInputSchema,
  ScheduleInterviewInputSchema,
} from "../recruitment/bridge";
import type { SchedulingCommands } from "./command";
import { GotConductDialogMessage, GotScheduleDialogMessage, type Message } from "./message";
import { ConductData, SchedulingBoardData, type Model, type ReadyModel } from "./model";

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
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.trim()) &&
        Number.isFinite(Date.parse(value)),
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
const scoreRules = FieldValidation.makeRules({
  required: "Velg en score.",
  isEmpty: (value) => value.trim() === "",
  rules: [[(value) => /^(?:[0-9]|10)$/u.test(value.trim()), "Velg en score fra 0 til 10."]],
});

const conductDialogCommands = (commands: ReadonlyArray<Command.Command<Dialog.Message>>) =>
  Command.mapMessages(commands, (message) => GotConductDialogMessage({ message }));

const emptyScore = () => ({
  explanatoryPower: emptyField(),
  roleModel: emptyField(),
  suitability: emptyField(),
});

const clearConduct = (
  model: ReadyModel,
  conductFeedback: ReadyModel["conductFeedback"] = null,
): ReadyModel => ({
  ...model,
  selectedInterviewId: null,
  conduct: ConductData.Idle(),
  conductRequestId: model.conductRequestId + 1,
  conductGeneration: model.conductGeneration + 1,
  pendingConductAction: null,
  answers: [],
  answerErrors: [],
  score: emptyScore(),
  conductValidationFeedback: null,
  conductFeedback,
  isConducting: false,
});
const answerFor = (model: ReadyModel, questionId: string) =>
  model.answers.find((answer) => answer.questionId === questionId);

const validAnswer = (
  question: RecruitmentInterviewQuestionSnapshot,
  answer: string | ReadonlyArray<string>,
) => {
  if (question.kind === "text") return typeof answer === "string";
  if (question.kind === "check") {
    return (
      Array.isArray(answer) &&
      answer.length > 0 &&
      answer.every((value) => question.alternatives.includes(value))
    );
  }
  return typeof answer === "string" && question.alternatives.includes(answer);
};
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
  ({
    LoadSchedulingBoard,
    ScheduleInterview,
    ReadInterviewConduct,
    FinalizeInterview,
    CancelInterview,
  }: SchedulingCommands) =>
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
                scheduleError:
                  "Intervjuet er ikke lenger tilgjengelig for planlegging. Hent oversikten på nytt.",
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

          let input;
          try {
            input = S.decodeUnknownSync(ScheduleInterviewInputSchema)(
              {
                params: { interviewId: interview.interviewId },
                headers: {
                  "idempotency-key": IdempotencyKey.make(
                    `${model.idempotencyKeySeed}-${model.commandSequence}`,
                  ),
                  "if-match": interview.etag,
                },
                payload: {
                  scheduledAt: scheduledAt.value.trim(),
                  room: room.value.trim(),
                  campus: campus.value.trim().length === 0 ? null : campus.value.trim(),
                  mapLink: mapLink.value.trim().length === 0 ? null : mapLink.value.trim(),
                  message: scheduleMessage.value.trim(),
                },
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
            [ScheduleInterview({ requestId, input })],
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
        OpenedConduct: ({ interviewId }) => {
          if (model.isScheduling || model.isConducting) return [model, []];
          const board = AsyncData.getData(model.board);
          if (board._tag === "None") return [model, []];
          const interview = board.value.interviews.find(
            (candidate) => candidate.interviewId === interviewId,
          );
          if (
            interview === undefined ||
            interview.schedule === null ||
            interview.responseState !== "Accepted"
          ) {
            return [model, []];
          }
          const requestId = model.conductRequestId + 1;
          const generation = model.conductGeneration + 1;
          return [
            {
              ...clearConduct(model),
              selectedInterviewId: interviewId,
              conduct: ConductData.Loading(),
              conductRequestId: requestId,
              conductGeneration: generation,
              commandSequence: model.commandSequence + 1,
            },
            [ReadInterviewConduct({ requestId, generation, interviewId })],
          ];
        },
        ClosedConduct: () => {
          if (model.isConducting) return [model, []];
          return [clearConduct(model), []];
        },
        SucceededConduct: ({ requestId, generation, interviewId, detail }) => {
          if (
            requestId !== model.conductRequestId ||
            generation !== model.conductGeneration ||
            interviewId !== model.selectedInterviewId
          ) {
            return [model, []];
          }
          return [
            {
              ...model,
              conduct: ConductData.Success({ data: detail }),
              answers: detail.answers.map((answer) => ({
                questionId: answer.questionId,
                answer: answer.answer,
              })),
              answerErrors: [],
              score:
                detail.score === null
                  ? emptyScore()
                  : {
                      explanatoryPower: FieldValidation.NotValidated({
                        value: String(detail.score.explanatoryPower),
                      }),
                      roleModel: FieldValidation.NotValidated({
                        value: String(detail.score.roleModel),
                      }),
                      suitability: FieldValidation.NotValidated({
                        value: String(detail.score.suitability),
                      }),
                    },
              conductFeedback: null,
              conductValidationFeedback: null,
            },
            [],
          ];
        },
        FailedConduct: ({ requestId, generation, interviewId, failure }) =>
          requestId !== model.conductRequestId ||
          generation !== model.conductGeneration ||
          interviewId !== model.selectedInterviewId
            ? [model, []]
            : [
                {
                  ...model,
                  conduct: ConductData.Failure({ error: failure }),
                  conductFeedback: failure,
                },
                [],
              ],
        ChangedAnswer: ({ questionId, answer }) => {
          const current = AsyncData.getData(model.conduct);
          if (current._tag === "None" || model.isConducting) return [model, []];
          const question = current.value.questions.find(
            (candidate) => candidate.questionId === questionId,
          );
          if (question === undefined) return [model, []];
          const answerErrors = model.answerErrors.filter(
            (error) => error.questionId !== questionId,
          );
          if (!validAnswer(question, answer)) {
            return [
              {
                ...model,
                answerErrors: [
                  ...answerErrors,
                  { questionId, message: "Velg et gyldig svaralternativ." },
                ],
                conductValidationFeedback: "Kontroller svarene før du fullfører intervjuet.",
              },
              [],
            ];
          }
          return [
            {
              ...model,
              answers: [
                ...model.answers.filter((candidate) => candidate.questionId !== questionId),
                { questionId, answer },
              ],
              answerErrors,
              conductValidationFeedback: null,
              conductFeedback: null,
              commandSequence: model.commandSequence + 1,
            },
            [],
          ];
        },
        ChangedScore: ({ axis, value }) => [
          {
            ...model,
            score: {
              ...model.score,
              [axis]: FieldValidation.validate(scoreRules)(value),
            },
            conductValidationFeedback: null,
            conductFeedback: null,
            commandSequence: model.commandSequence + 1,
          },
          [],
        ],
        SubmittedFinalize: () => {
          if (model.isConducting || model.pendingConductAction !== null) return [model, []];
          const current = AsyncData.getData(model.conduct);
          if (
            current._tag === "None" ||
            current.value.completionState === "Completed" ||
            current.value.cancellationState === "Cancelled" ||
            !current.value.canFinalize
          ) {
            return [
              { ...model, conductValidationFeedback: "Intervjuet kan ikke fullføres nå." },
              [],
            ];
          }
          const answerErrors = current.value.questions.flatMap((question) => {
            const answer = answerFor(model, question.questionId);
            return answer === undefined || !validAnswer(question, answer.answer)
              ? [{ questionId: question.questionId, message: "Svar på spørsmålet." }]
              : [];
          });
          const score = {
            explanatoryPower: FieldValidation.validate(scoreRules)(
              model.score.explanatoryPower.value,
            ),
            roleModel: FieldValidation.validate(scoreRules)(model.score.roleModel.value),
            suitability: FieldValidation.validate(scoreRules)(model.score.suitability.value),
          };
          if (
            answerErrors.length > 0 ||
            !FieldValidation.isValid(scoreRules)(score.explanatoryPower) ||
            !FieldValidation.isValid(scoreRules)(score.roleModel) ||
            !FieldValidation.isValid(scoreRules)(score.suitability)
          ) {
            return [
              {
                ...model,
                answerErrors,
                score,
                conductValidationFeedback: "Svar på alle spørsmål og velg alle tre scorer.",
              },
              [],
            ];
          }
          const [conductDialog, dialogCommands] = Dialog.open(model.conductDialog);
          return [
            {
              ...model,
              score,
              answerErrors: [],
              pendingConductAction: "Finalize",
              conductDialog,
              conductValidationFeedback: null,
            },
            conductDialogCommands(dialogCommands),
          ];
        },
        SubmittedCancel: () => {
          const current = AsyncData.getData(model.conduct);
          if (
            model.isConducting ||
            model.pendingConductAction !== null ||
            current._tag === "None" ||
            !current.value.canCancel ||
            current.value.completionState === "Completed" ||
            current.value.cancellationState === "Cancelled"
          ) {
            return [{ ...model, conductValidationFeedback: "Intervjuet kan ikke avlyses nå." }, []];
          }
          const [conductDialog, dialogCommands] = Dialog.open(model.conductDialog);
          return [
            { ...model, pendingConductAction: "Cancel", conductDialog },
            conductDialogCommands(dialogCommands),
          ];
        },
        ConfirmedFinalize: () => {
          if (model.pendingConductAction !== "Finalize" || model.selectedInterviewId === null) {
            return [model, []];
          }
          const current = AsyncData.getData(model.conduct);
          const board = AsyncData.getData(model.board);
          const interview =
            board._tag === "Some"
              ? board.value.interviews.find(
                  (candidate) => candidate.interviewId === model.selectedInterviewId,
                )
              : undefined;
          if (current._tag === "None" || interview === undefined) return [model, []];
          const score = {
            explanatoryPower: Number(model.score.explanatoryPower.value),
            roleModel: Number(model.score.roleModel.value),
            suitability: Number(model.score.suitability.value),
          };
          let input;
          try {
            input = S.decodeUnknownSync(FinalizeInterviewInputSchema)(
              {
                params: { interviewId: model.selectedInterviewId },
                headers: {
                  "idempotency-key": IdempotencyKey.make(
                    `${model.idempotencyKeySeed}-${model.commandSequence}`,
                  ),
                  "if-match": interview.etag,
                },
                payload: {
                  answers: model.answers,
                  score,
                },
              },
              { onExcessProperty: "error" },
            );
          } catch {
            return [
              { ...model, conductValidationFeedback: "Kontroller svarene og prøv igjen." },
              [],
            ];
          }
          const requestId = model.conductRequestId + 1;
          const [conductDialog, dialogCommands] = Dialog.close(model.conductDialog);
          return [
            {
              ...model,
              conductDialog,
              pendingConductAction: null,
              isConducting: true,
              conductRequestId: requestId,
              conductFeedback: null,
            },
            [
              ...conductDialogCommands(dialogCommands),
              FinalizeInterview({
                requestId,
                generation: model.conductGeneration,
                interviewId: model.selectedInterviewId,
                input,
              }),
            ],
          ];
        },
        ConfirmedCancel: () => {
          if (model.pendingConductAction !== "Cancel" || model.selectedInterviewId === null) {
            return [model, []];
          }
          const current = AsyncData.getData(model.conduct);
          const board = AsyncData.getData(model.board);
          const interview =
            board._tag === "Some"
              ? board.value.interviews.find(
                  (candidate) => candidate.interviewId === model.selectedInterviewId,
                )
              : undefined;
          if (current._tag === "None" || interview === undefined) return [model, []];
          let input;
          try {
            input = S.decodeUnknownSync(CancelInterviewInputSchema)(
              {
                params: { interviewId: model.selectedInterviewId },
                headers: {
                  "idempotency-key": IdempotencyKey.make(
                    `${model.idempotencyKeySeed}-${model.commandSequence}`,
                  ),
                  "if-match": interview.etag,
                },
                payload: {},
              },
              { onExcessProperty: "error" },
            );
          } catch {
            return [{ ...model, conductValidationFeedback: "Intervjuet kunne ikke avlyses." }, []];
          }
          const requestId = model.conductRequestId + 1;
          const [conductDialog, dialogCommands] = Dialog.close(model.conductDialog);
          return [
            {
              ...model,
              conductDialog,
              pendingConductAction: null,
              isConducting: true,
              conductRequestId: requestId,
              conductFeedback: null,
            },
            [
              ...conductDialogCommands(dialogCommands),
              CancelInterview({
                requestId,
                generation: model.conductGeneration,
                interviewId: model.selectedInterviewId,
                input,
              }),
            ],
          ];
        },
        SucceededFinalize: ({ requestId, generation, interviewId }) => {
          if (
            requestId !== model.conductRequestId ||
            generation !== model.conductGeneration ||
            interviewId !== model.selectedInterviewId ||
            !model.isConducting
          ) {
            return [model, []];
          }
          const conductRequestId = requestId + 1;
          const boardRequestId = model.boardRequestId + 1;
          const current = AsyncData.getData(model.conduct);
          const board = AsyncData.getData(model.board);
          return [
            {
              ...model,
              conduct:
                current._tag === "Some"
                  ? ConductData.Refreshing({ data: current.value })
                  : ConductData.Loading(),
              conductRequestId,
              board:
                board._tag === "Some"
                  ? SchedulingBoardData.Refreshing({ data: board.value })
                  : SchedulingBoardData.Loading(),
              boardRequestId,
              isConducting: false,
              conductFeedback: null,
              conductValidationFeedback: null,
            },
            [
              ReadInterviewConduct({
                requestId: conductRequestId,
                generation,
                interviewId,
              }),
              LoadSchedulingBoard({ requestId: boardRequestId }),
            ],
          ];
        },
        SucceededCancel: ({ requestId, generation, interviewId }) => {
          if (
            requestId !== model.conductRequestId ||
            generation !== model.conductGeneration ||
            interviewId !== model.selectedInterviewId ||
            !model.isConducting
          ) {
            return [model, []];
          }
          const conductRequestId = requestId + 1;
          const boardRequestId = model.boardRequestId + 1;
          const current = AsyncData.getData(model.conduct);
          return [
            {
              ...model,
              conduct:
                current._tag === "Some"
                  ? ConductData.Refreshing({ data: current.value })
                  : ConductData.Loading(),
              conductRequestId,
              board: SchedulingBoardData.Loading(),
              boardRequestId,
              isConducting: false,
              conductFeedback: null,
              conductValidationFeedback: null,
            },
            [
              ReadInterviewConduct({
                requestId: conductRequestId,
                generation,
                interviewId,
              }),
              LoadSchedulingBoard({ requestId: boardRequestId }),
            ],
          ];
        },
        FailedFinalize: ({ requestId, generation, interviewId, failure }) => {
          if (
            requestId !== model.conductRequestId ||
            generation !== model.conductGeneration ||
            interviewId !== model.selectedInterviewId ||
            !model.isConducting
          ) {
            return [model, []];
          }
          return failure._tag === "Conflict"
            ? [clearConduct(model, failure), []]
            : [{ ...model, isConducting: false, conductFeedback: failure }, []];
        },
        FailedCancel: ({ requestId, generation, interviewId, failure }) => {
          if (
            requestId !== model.conductRequestId ||
            generation !== model.conductGeneration ||
            interviewId !== model.selectedInterviewId ||
            !model.isConducting
          ) {
            return [model, []];
          }
          return failure._tag === "Conflict"
            ? [clearConduct(model, failure), []]
            : [{ ...model, isConducting: false, conductFeedback: failure }, []];
        },
        ClosedConductConfirmation: () => {
          if (model.isConducting) return [model, []];
          const [conductDialog, dialogCommands] = Dialog.close(model.conductDialog);
          return [
            { ...model, conductDialog, pendingConductAction: null },
            conductDialogCommands(dialogCommands),
          ];
        },
        GotConductDialogMessage: ({ message: dialogMessage }) => {
          if (model.isConducting && dialogMessage._tag === "RequestedClose") return [model, []];
          const [conductDialog, dialogCommands, output] = Dialog.update(
            model.conductDialog,
            dialogMessage,
          );
          return [
            output._tag === "Some" && output.value._tag === "Closed"
              ? { ...model, conductDialog, pendingConductAction: null }
              : { ...model, conductDialog },
            conductDialogCommands(dialogCommands),
          ];
        },
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

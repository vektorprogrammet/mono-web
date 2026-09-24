import { Predicate } from "effect";
import type { RecruitmentInterviewQuestionSnapshot } from "@vektorprogrammet/http-api"
import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { Dialog } from "@foldkit/ui";
import { Match as M, Option, Schema as S } from "effect";
import { AsyncData, Command, FieldValidation, Update } from "foldkit";
import {
  CancelInterviewInputSchema,
  FinalizeInterviewInputSchema,
  CorrectInterviewAssessmentInputSchema,
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
  conductEtag: null,
  conductRequestId: model.conductRequestId + 1,
  conductGeneration: model.conductGeneration + 1,
  pendingConductAction: null,
  answers: [],
  answerErrors: [],
  score: emptyScore(),
  recommendation: null,
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
  if (question.kind === "text") return Predicate.isString(answer);

  if (question.kind === "check") {
    return (
      Array.isArray(answer) &&
      answer.length > 0 &&
      answer.every((value) => question.alternatives.includes(value))
    );
  }

  return Predicate.isString(answer) && question.alternatives.includes(answer);
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

export const updateFor =
  ({
    LoadSchedulingBoard,
    ScheduleInterview,
    ReadInterviewConduct,
    FinalizeInterview,
    CorrectInterviewAssessment,
    CancelInterview,
  }: SchedulingCommands) =>
  (model: Model, message: Message): Update.Return<Model, Message> => {
    if (!Predicate.isTagged(model, "Ready")) return ({ model: model, commands: [] });

    return M.value(message).pipe(
      M.withReturnType<Update.Return<Model, Message>>(),
      M.tagsExhaustive({
        RequestedBoardRefresh: () => {
          if (model.isScheduling) return ({ model: model, commands: [] });
          const requestId = model.boardRequestId + 1;
          const { model: scheduleDialog, commands: dialogCommands = [] } = Dialog.close(model.scheduleDialog);

          return ({ model: 
            {
              ...clearSchedule(model),
              selectedInterviewId: model.selectedInterviewId,
              scheduleDialog,
              board: SchedulingBoardData.Loading(),
              boardRequestId: requestId,
              feedback: null,
              commandSequence: model.commandSequence + 1,
            }, commands: [...mapDialogCommands(dialogCommands), LoadSchedulingBoard({ requestId })] });
        },
        SucceededLoadSchedulingBoard: ({ requestId, board }) =>
          requestId !== model.boardRequestId
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  board: SchedulingBoardData.Success({ data: board }),
                  feedback: null,
                }, commands: [] }),
        FailedLoadSchedulingBoard: ({ requestId, message: failureMessage }) =>
          requestId !== model.boardRequestId
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...clearSchedule(model),
                  board: SchedulingBoardData.Failure({ error: failureMessage }),
                  feedback: null,
                }, commands: [] }),
        OpenedSchedule: ({ interviewId }) => {
          if (model.isScheduling) return ({ model: model, commands: [] });
          const board = AsyncData.getData(model.board);

          if (Option.isNone(board)) return ({ model: model, commands: [] });

          const interview = board.value.interviews.find(
            (candidate) => candidate.interviewId === interviewId,
          );

          if (interview === undefined || interview.schedule !== null) return ({ model: model, commands: [] });
          const { model: scheduleDialog, commands: dialogCommands = [] } = Dialog.open(model.scheduleDialog);

          return ({ model: 
            {
              ...clearSchedule(model),
              scheduleDialog,
              selectedInterviewId: interviewId,
              feedback: null,
              commandSequence: model.commandSequence + 1,
            }, commands: mapDialogCommands(dialogCommands) });
        },
        ClosedSchedule: () => {
          if (model.isScheduling) return ({ model: model, commands: [] });
          const { model: scheduleDialog, commands: dialogCommands = [] } = Dialog.close(model.scheduleDialog);

          return ({ model: 
            {
              ...clearSchedule(model),
              scheduleDialog,
              commandSequence: model.commandSequence + 1,
            }, commands: mapDialogCommands(dialogCommands) });
        },
        UpdatedScheduledAt: ({ value }) => ({ model: 
          {
            ...model,
            scheduledAt: FieldValidation.validate(scheduledAtRules)(value),
            scheduleError: null,
            feedback: null,
            commandSequence: model.commandSequence + 1,
          }, commands: [] }),
        UpdatedRoom: ({ value }) => ({ model: 
          {
            ...model,
            room: FieldValidation.validate(roomRules)(value),
            scheduleError: null,
            feedback: null,
            commandSequence: model.commandSequence + 1,
          }, commands: [] }),
        UpdatedCampus: ({ value }) => ({ model: 
          {
            ...model,
            campus: FieldValidation.validate(campusRules)(value),
            scheduleError: null,
            feedback: null,
            commandSequence: model.commandSequence + 1,
          }, commands: [] }),
        UpdatedMapLink: ({ value }) => ({ model: 
          {
            ...model,
            mapLink: FieldValidation.validate(mapLinkRules)(value),
            scheduleError: null,
            feedback: null,
            commandSequence: model.commandSequence + 1,
          }, commands: [] }),
        UpdatedMessage: ({ value }) => ({ model: 
          {
            ...model,
            message: FieldValidation.validate(messageRules)(value),
            scheduleError: null,
            feedback: null,
            commandSequence: model.commandSequence + 1,
          }, commands: [] }),
        SubmittedSchedule: () => {
          if (model.isScheduling || model.selectedInterviewId === null) return ({ model: model, commands: [] });
          const board = AsyncData.getData(model.board);

          if (Option.isNone(board)) return ({ model: model, commands: [] });

          const interview = board.value.interviews.find(
            (candidate) => candidate.interviewId === model.selectedInterviewId,
          );

          if (interview === undefined || interview.schedule !== null) {
            return ({ model: 
              {
                ...model,
                scheduleError:
                  "Intervjuet er ikke lenger tilgjengelig for planlegging. Hent oversikten på nytt.",
              }, commands: [] });
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
            return ({ model: 
              {
                ...model,
                scheduledAt,
                room,
                campus,
                mapLink,
                message: scheduleMessage,
                scheduleError: "Kontroller feltene og prøv igjen.",
                feedback: null,
              }, commands: [] });
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
            return ({ model: 
              {
                ...model,
                scheduledAt,
                room,
                campus,
                mapLink,
                message: scheduleMessage,
                scheduleError: "Kontroller feltene og prøv igjen.",
                feedback: null,
              }, commands: [] });
          }

          const requestId = model.boardRequestId + 1;

          return ({ model: 
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
            }, commands: [ScheduleInterview({ requestId, input })] });
        },
        SucceededSchedule: ({ requestId, board }) => {
          if (requestId !== model.boardRequestId || !model.isScheduling) return ({ model: model, commands: [] });

          const scheduledInterview = board.interviews.find(
            (interview) => interview.interviewId === model.selectedInterviewId,
          );

          if (
            scheduledInterview === undefined ||
            scheduledInterview.schedule === null ||
            scheduledInterview.responseState !== "Pending" ||
            scheduledInterview.notificationState === null
          ) {
            return ({ model: 
              {
                ...model,
                board: SchedulingBoardData.Success({ data: board }),
                isScheduling: false,
                scheduleError:
                  "Intervjuoversikten bekreftet ikke den lagrede planen. Hent oversikten på nytt.",
                feedback: null,
              }, commands: [] });
          }

          const { model: scheduleDialog, commands: dialogCommands = [] } = Dialog.close(model.scheduleDialog);

          return ({ model: 
            {
              ...clearSchedule(model),
              scheduleDialog,
              board: SchedulingBoardData.Success({ data: board }),
              feedback: successFeedback(scheduledInterview.notificationState),
              commandSequence: model.commandSequence + 1,
            }, commands: mapDialogCommands(dialogCommands) });
        },
        FailedSchedule: ({ requestId, message: failureMessage }) =>
          requestId !== model.boardRequestId
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  isScheduling: false,
                  scheduleError: failureMessage,
                  feedback: null,
                }, commands: [] }),
        OpenedConduct: ({ interviewId }) => {
          if (model.isScheduling || model.isConducting) return ({ model: model, commands: [] });
          const board = AsyncData.getData(model.board);

          if (Option.isNone(board)) return ({ model: model, commands: [] });

          const interview = board.value.interviews.find(
            (candidate) => candidate.interviewId === interviewId,
          );

          if (
            interview === undefined ||
            interview.schedule === null ||
            interview.responseState !== "Accepted"
          ) {
            return ({ model: model, commands: [] });
          }

          const requestId = model.conductRequestId + 1;
          const generation = model.conductGeneration + 1;

          return ({ model: 
            {
              ...clearConduct(model),
              selectedInterviewId: interviewId,
              conduct: ConductData.Loading(),
              conductRequestId: requestId,
              conductGeneration: generation,
              commandSequence: model.commandSequence + 1,
            }, commands: [ReadInterviewConduct({ requestId, generation, interviewId })] });
        },
        ClosedConduct: () => {
          if (model.isConducting) return ({ model: model, commands: [] });

          return ({ model: clearConduct(model), commands: [] });
        },
        SucceededConduct: ({ requestId, generation, interviewId, detail, etag }) => {
          if (
            requestId !== model.conductRequestId ||
            generation !== model.conductGeneration ||
            interviewId !== model.selectedInterviewId
          ) {
            return ({ model: model, commands: [] });
          }

          return ({ model: 
            {
              ...model,
              conduct: ConductData.Success({ data: detail }),
              conductEtag: etag,
              recommendation: detail.recommendation,
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
            }, commands: [] });
        },
        FailedConduct: ({ requestId, generation, interviewId, failure }) =>
          requestId !== model.conductRequestId ||
          generation !== model.conductGeneration ||
          interviewId !== model.selectedInterviewId
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  conduct: ConductData.Failure({ error: failure }),
                  conductFeedback: failure,
                }, commands: [] }),
        ChangedAnswer: ({ questionId, answer }) => {
          const current = AsyncData.getData(model.conduct);

          if (
            Option.isNone(current) ||
            model.isConducting ||
            Predicate.isTagged(model.conduct, "Refreshing")
          )
            return ({ model: model, commands: [] });

          const question = current.value.questions.find(
            (candidate) => candidate.questionId === questionId,
          );

          if (question === undefined) return ({ model: model, commands: [] });

          const answerErrors = model.answerErrors.filter(
            (error) => error.questionId !== questionId,
          );

          if (!validAnswer(question, answer)) {
            return ({ model: 
              {
                ...model,
                conductGeneration: model.conductGeneration + 1,
                answerErrors: [
                  ...answerErrors,
                  { questionId, message: "Velg et gyldig svaralternativ." },
                ],
                conductValidationFeedback: "Kontroller svarene før du fullfører intervjuet.",
              }, commands: [] });
          }

          return ({ model: 
            {
              ...model,
              conductGeneration: model.conductGeneration + 1,
              answers: [
                ...model.answers.filter((candidate) => candidate.questionId !== questionId),
                { questionId, answer },
              ],
              answerErrors,
              conductValidationFeedback: null,
              conductFeedback: null,
              commandSequence: model.commandSequence + 1,
            }, commands: [] });
        },
        ChangedRecommendation: ({ value }) =>
          model.isConducting ||
          model.pendingConductAction !== null ||
          Predicate.isTagged(model.conduct, "Refreshing")
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  recommendation: value,
                  conductGeneration: model.conductGeneration + 1,
                  commandSequence: model.commandSequence + 1,
                  conductValidationFeedback: null,
                }, commands: [] }),
        ChangedScore: ({ axis, value }) =>
          model.isConducting ||
          model.pendingConductAction !== null ||
          Predicate.isTagged(model.conduct, "Refreshing")
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  score: {
                    ...model.score,
                    [axis]: FieldValidation.validate(scoreRules)(value),
                  },
                  conductValidationFeedback: null,
                  conductFeedback: null,
                  commandSequence: model.commandSequence + 1,
                }, commands: [] }),
        SubmittedFinalize: () => {
          if (model.isConducting || model.pendingConductAction !== null) return ({ model: model, commands: [] });
          const current = AsyncData.getData(model.conduct);

          if (
            Option.isNone(current) ||
            current.value.cancellationState === "Cancelled" ||
            (current.value.completionState !== "Completed" && !current.value.canFinalize)
          ) {
            return ({ model: 
              { ...model, conductValidationFeedback: "Intervjuet kan ikke endres nå." }, commands: [] });
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
            model.recommendation === null ||
            answerErrors.length > 0 ||
            !FieldValidation.isValid(scoreRules)(score.explanatoryPower) ||
            !FieldValidation.isValid(scoreRules)(score.roleModel) ||
            !FieldValidation.isValid(scoreRules)(score.suitability)
          ) {
            return ({ model: 
              {
                ...model,
                answerErrors,
                score,
                conductValidationFeedback:
                  "Svar på alle spørsmål, velg alle tre scorer og en anbefaling.",
              }, commands: [] });
          }

          const { model: conductDialog, commands: dialogCommands = [] } = Dialog.open(model.conductDialog);

          return ({ model: 
            {
              ...model,
              score,
              answerErrors: [],
              pendingConductAction: current.value.completionState === "Completed" ? "Correct" : "Finalize",
              conductDialog,
              conductValidationFeedback: null,
            }, commands: conductDialogCommands(dialogCommands) });
        },
        SubmittedCancel: () => {
          const current = AsyncData.getData(model.conduct);

          if (
            model.isConducting ||
            model.pendingConductAction !== null ||
            Option.isNone(current) ||
            !current.value.canCancel ||
            current.value.completionState === "Completed" ||
            current.value.cancellationState === "Cancelled"
          ) {
            return ({ model: { ...model, conductValidationFeedback: "Intervjuet kan ikke avlyses nå." }, commands: [] });
          }

          const { model: conductDialog, commands: dialogCommands = [] } = Dialog.open(model.conductDialog);

          return ({ model: 
            { ...model, pendingConductAction: "Cancel", conductDialog }, commands: conductDialogCommands(dialogCommands) });
        },
        ConfirmedFinalize: () => {
          if ((model.pendingConductAction !== "Finalize" && model.pendingConductAction !== "Correct") || model.selectedInterviewId === null) {
            return ({ model: model, commands: [] });
          }

          const current = AsyncData.getData(model.conduct);

          if (Option.isNone(current) || model.conductEtag === null) return ({ model: model, commands: [] });

          const score = {
            explanatoryPower: Number(model.score.explanatoryPower.value),
            roleModel: Number(model.score.roleModel.value),
            suitability: Number(model.score.suitability.value),
          };

          const requestId = model.conductRequestId + 1;
          let command: Command.Command<Message>;

          try {
            const base = {
              params: { interviewId: model.selectedInterviewId },
              headers: {
                "idempotency-key": IdempotencyKey.make(
                  `${model.idempotencyKeySeed}-${model.commandSequence}`,
                ),
                "if-match": model.conductEtag,
              },
            } as const;

            command =
              model.pendingConductAction === "Correct"
                ? CorrectInterviewAssessment({ requestId, generation: model.conductGeneration, interviewId: model.selectedInterviewId, input: S.decodeUnknownSync(CorrectInterviewAssessmentInputSchema)(
                    {
                      ...base,
                      payload: {
                        expectedRevision: current.value.revision,
                        answers: model.answers,
                        score,
                        recommendation: model.recommendation,
                      },
                    },
                    { onExcessProperty: "error" },
                  ) })
                : FinalizeInterview({ requestId, generation: model.conductGeneration, interviewId: model.selectedInterviewId, input: S.decodeUnknownSync(FinalizeInterviewInputSchema)(
                    {
                      ...base,
                      payload: {
                        answers: model.answers,
                        score,
                        recommendation: model.recommendation,
                      },
                    },
                    { onExcessProperty: "error" },
                  ) });

          } catch {
            return ({ model: 
              { ...model, conductValidationFeedback: "Kontroller svarene og prøv igjen." }, commands: [] });
          }


          const { model: conductDialog, commands: dialogCommands = [] } = Dialog.close(model.conductDialog);

          return ({ model: 
            {
              ...model,
              conductDialog,
              pendingConductAction: null,
              isConducting: true,
              conductRequestId: requestId,
              conductFeedback: null,
            }, commands: [
              ...conductDialogCommands(dialogCommands),
              command,

            ] });
        },
        ConfirmedCancel: () => {
          if (model.pendingConductAction !== "Cancel" || model.selectedInterviewId === null) {
            return ({ model: model, commands: [] });
          }

          const current = AsyncData.getData(model.conduct);
          const board = AsyncData.getData(model.board);

          const interview =
            Option.isSome(board)
              ? board.value.interviews.find(
                  (candidate) => candidate.interviewId === model.selectedInterviewId,
                )
              : undefined;

          if (Option.isNone(current) || interview === undefined) return ({ model: model, commands: [] });
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
            return ({ model: { ...model, conductValidationFeedback: "Intervjuet kunne ikke avlyses." }, commands: [] });
          }

          const requestId = model.conductRequestId + 1;
          const { model: conductDialog, commands: dialogCommands = [] } = Dialog.close(model.conductDialog);

          return ({ model: 
            {
              ...model,
              conductDialog,
              pendingConductAction: null,
              isConducting: true,
              conductRequestId: requestId,
              conductFeedback: null,
            }, commands: [
              ...conductDialogCommands(dialogCommands),
              CancelInterview({
                requestId,
                generation: model.conductGeneration,
                interviewId: model.selectedInterviewId,
                input,
              }),
            ] });
        },
        SucceededFinalize: ({ requestId, generation, interviewId }) => {
          if (
            requestId !== model.conductRequestId ||
            generation !== model.conductGeneration ||
            interviewId !== model.selectedInterviewId ||
            !model.isConducting
          ) {
            return ({ model: model, commands: [] });
          }

          const conductRequestId = requestId + 1;
          const boardRequestId = model.boardRequestId + 1;
          const current = AsyncData.getData(model.conduct);
          const board = AsyncData.getData(model.board);

          return ({ model: 
            {
              ...model,
              conduct:
                Option.isSome(current)
                  ? ConductData.Refreshing({ data: current.value })
                  : ConductData.Loading(),
              conductRequestId,
              board:
                Option.isSome(board)
                  ? SchedulingBoardData.Refreshing({ data: board.value })
                  : SchedulingBoardData.Loading(),
              boardRequestId,
              isConducting: false,
              conductFeedback: null,
              conductValidationFeedback: null,
            }, commands: [
              ReadInterviewConduct({
                requestId: conductRequestId,
                generation,
                interviewId,
              }),
              LoadSchedulingBoard({ requestId: boardRequestId }),
            ] });
        },
        SucceededCorrection: ({ requestId, generation, interviewId }) => {
          if (
            requestId !== model.conductRequestId ||
            generation !== model.conductGeneration ||
            interviewId !== model.selectedInterviewId ||
            !model.isConducting
          ) {
            return ({ model: model, commands: [] });
          }

          const conductRequestId = requestId + 1;
          const boardRequestId = model.boardRequestId + 1;
          const current = AsyncData.getData(model.conduct);
          const board = AsyncData.getData(model.board);

          return ({ model: 
            {
              ...model,
              conduct:
                Option.isSome(current)
                  ? ConductData.Refreshing({ data: current.value })
                  : ConductData.Loading(),
              conductRequestId,
              conductFeedback: null,
              conductValidationFeedback: null,
              board:
                Option.isSome(board)
                  ? SchedulingBoardData.Refreshing({ data: board.value })
                  : SchedulingBoardData.Loading(),
              boardRequestId,
              isConducting: false,
            }, commands: [
              ReadInterviewConduct({ requestId: conductRequestId, generation, interviewId }),
              LoadSchedulingBoard({ requestId: boardRequestId }),
            ] });
        },
        SucceededCancel: ({ requestId, generation, interviewId }) => {
          if (
            requestId !== model.conductRequestId ||
            generation !== model.conductGeneration ||
            interviewId !== model.selectedInterviewId ||
            !model.isConducting
          ) {
            return ({ model: model, commands: [] });
          }

          const conductRequestId = requestId + 1;
          const boardRequestId = model.boardRequestId + 1;
          const current = AsyncData.getData(model.conduct);

          return ({ model: 
            {
              ...model,
              conduct:
                Option.isSome(current)
                  ? ConductData.Refreshing({ data: current.value })
                  : ConductData.Loading(),
              conductRequestId,
              board: SchedulingBoardData.Loading(),
              boardRequestId,
              isConducting: false,
              conductFeedback: null,
              conductValidationFeedback: null,
            }, commands: [
              ReadInterviewConduct({
                requestId: conductRequestId,
                generation,
                interviewId,
              }),
              LoadSchedulingBoard({ requestId: boardRequestId }),
            ] });
        },
        FailedCorrection: ({ requestId, generation, interviewId, failure }) => {
          if (
            requestId !== model.conductRequestId ||
            generation !== model.conductGeneration ||
            interviewId !== model.selectedInterviewId ||
            !model.isConducting
          ) {
            return ({ model: model, commands: [] });
          }

          return Predicate.isTagged(failure, "Conflict")
            ? ({ model: 
                {
                  ...model,
                  isConducting: false,
                  pendingConductAction: null,
                  conductFeedback: failure,
                  conductValidationFeedback:
                    "Intervjuet er endret. Utkastet er beholdt; åpne intervjuet på nytt for å hente gjeldende versjon.",
                }, commands: [] })
            : ({ model: { ...model, isConducting: false, conductFeedback: failure }, commands: [] });
        },
        FailedFinalize: ({ requestId, generation, interviewId, failure }) => {
          if (
            requestId !== model.conductRequestId ||
            generation !== model.conductGeneration ||
            interviewId !== model.selectedInterviewId ||
            !model.isConducting
          ) {
            return ({ model: model, commands: [] });
          }

          return Predicate.isTagged(failure, "Conflict")
            ? ({ model: 
                {
                  ...model,
                  isConducting: false,
                  pendingConductAction: null,
                  conductFeedback: failure,
                  conductValidationFeedback:
                    "Intervjuet er endret. Utkastet er beholdt; åpne intervjuet på nytt for å hente gjeldende versjon.",
                }, commands: [] })
            : ({ model: { ...model, isConducting: false, conductFeedback: failure }, commands: [] });
        },
        FailedCancel: ({ requestId, generation, interviewId, failure }) => {
          if (
            requestId !== model.conductRequestId ||
            generation !== model.conductGeneration ||
            interviewId !== model.selectedInterviewId ||
            !model.isConducting
          ) {
            return ({ model: model, commands: [] });
          }

          return Predicate.isTagged(failure, "Conflict")
            ? ({ model: clearConduct(model, failure), commands: [] })
            : ({ model: { ...model, isConducting: false, conductFeedback: failure }, commands: [] });
        },
        ClosedConductConfirmation: () => {
          if (model.isConducting) return ({ model: model, commands: [] });
          const { model: conductDialog, commands: dialogCommands = [] } = Dialog.close(model.conductDialog);

          return ({ model: 
            { ...model, conductDialog, pendingConductAction: null }, commands: conductDialogCommands(dialogCommands) });
        },
        GotConductDialogMessage: ({ message: dialogMessage }) => {
          if (model.isConducting && Predicate.isTagged(dialogMessage, "RequestedClose")) return ({ model: model, commands: [] });

          const { model: conductDialog, commands: dialogCommands = [], outMessage: output } = Dialog.update(
            model.conductDialog,
            dialogMessage,
          );

          return ({ model: 
            output !== undefined && Predicate.isTagged(output, "Closed")
              ? { ...model, conductDialog, pendingConductAction: null }
              : { ...model, conductDialog }, commands: conductDialogCommands(dialogCommands) });
        },
        GotScheduleDialogMessage: ({ message: dialogMessage }) => {
          if (model.isScheduling && Predicate.isTagged(dialogMessage, "RequestedClose")) return ({ model: model, commands: [] });

          const { model: scheduleDialog, commands: dialogCommands = [], outMessage: output } = Dialog.update(
            model.scheduleDialog,
            dialogMessage,
          );

          const next = { ...model, scheduleDialog };

          return ({ model: 
            output !== undefined && Predicate.isTagged(output, "Closed")
              ? {
                  ...clearSchedule(next),
                  commandSequence: model.commandSequence + 1,
                }
              : next, commands: mapDialogCommands(dialogCommands) });
        },
      }),
    );
  };

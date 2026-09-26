import { Match, Option, Predicate, Schema } from "effect";
import { RecruitmentMaintenanceCommand, PersonId } from "@vektorprogrammet/http-api";
import type { Update } from "foldkit";
import type { MaintenanceCommands } from "./command";
import type { Message } from "./message";
import { Mutation, type Model } from "./model";

const selectedFields = (
  model: Model,
  id: string,
): Pick<Model, "selectedId" | "expectedRevision" | "draft" | "primary" | "co" | "reason"> => {
  const questionnaire = model.questionnaires?.questionnaires.find(
    (entry) => entry.interviewSchemaId === id,
  );

  const interview = model.staffing?.interviews.find((entry) => entry.interviewId === id);

  return {
    selectedId: id,
    expectedRevision:
      model.mode === "Questionnaires" ? (questionnaire?.revision ?? 0) : (interview?.revision ?? 0),
    draft: questionnaire
      ? {
          name: questionnaire.name,
          active: questionnaire.active,
          questions: questionnaire.questions.map((question) => ({
            questionId: question.questionId,
            prompt: question.prompt,
            helpText: question.helpText ?? "",
            kind: question.kind,
            alternatives: question.alternatives,
          })),
        }
      : { name: "", active: false, questions: [] },
    primary: interview?.interviewerPersonId ?? "",
    co: interview?.coInterviewerPersonId ?? "",
    reason: "",
  };
};

const move = <A>(items: ReadonlyArray<A>, index: number, direction: number): ReadonlyArray<A> => {
  const target = index + direction;

  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target]!, next[index]!];

  return next;
};

export const updateFor =
  (commands: MaintenanceCommands) =>
  (model: Model, message: Message): Update.Return<Model, Message> => {
    const locked =
      model.status !== "Ready" || ["Pending", "Failed", "Conflict"].includes(model.mutation._tag);

    const unchanged = { model, commands: [] };

    const edit = (next: Partial<Model>): Update.Return<Model, Message> =>
      locked
        ? unchanged
        : { model: { ...model, ...next, mutation: Mutation.cases.Idle.make({}) }, commands: [] };

    const questions = model.draft.questions;

    return Match.value(message).pipe(
      Match.withReturnType<Update.Return<Model, Message>>(),
      Match.tagsExhaustive({
        SelectedRecord: (message) => edit(selectedFields(model, message.id)),
        ChangedName: (message) => edit({ draft: { ...model.draft, name: message.value } }),
        ChangedActive: (message) => edit({ draft: { ...model.draft, active: message.value } }),
        ChangedReason: (message) => edit({ reason: message.value }),
        ChangedPrimary: (message) => edit({ primary: message.value }),
        ChangedCo: (message) => edit({ co: message.value }),
        AddedQuestion: () =>
          edit({
            nextQuestion: model.nextQuestion + 1,
            draft: {
              ...model.draft,
              questions: [
                ...questions,
                {
                  questionId: `question:${model.commandId}:${model.nextQuestion}`,
                  prompt: "",
                  helpText: "",
                  kind: "text",
                  alternatives: [],
                },
              ],
            },
          }),
        RemovedQuestion: (message) =>
          edit({
            draft: {
              ...model.draft,
              questions: questions.filter((_, index) => index !== message.index),
            },
          }),
        MovedQuestion: (message) =>
          edit({
            draft: { ...model.draft, questions: move(questions, message.index, message.direction) },
          }),
        ChangedQuestionText: (message) =>
          edit({
            draft: {
              ...model.draft,
              questions: questions.map((question, index) =>
                index === message.index
                  ? { ...question, [message.field]: message.value }
                  : question,
              ),
            },
          }),
        ChangedQuestionKind: (message) =>
          edit({
            draft: {
              ...model.draft,
              questions: questions.map((question, index) =>
                index === message.index
                  ? {
                      ...question,
                      kind: message.kind,
                      alternatives:
                        message.kind === "text"
                          ? []
                          : question.alternatives.length === 0
                            ? [""]
                            : question.alternatives,
                    }
                  : question,
              ),
            },
          }),
        AddedAlternative: (message) =>
          edit({
            draft: {
              ...model.draft,
              questions: questions.map((question, index) =>
                index === message.index
                  ? { ...question, alternatives: [...question.alternatives, ""] }
                  : question,
              ),
            },
          }),
        RemovedAlternative: (message) =>
          edit({
            draft: {
              ...model.draft,
              questions: questions.map((question, index) =>
                index === message.index
                  ? {
                      ...question,
                      alternatives: question.alternatives.filter(
                        (_, alternative) => alternative !== message.alternative,
                      ),
                    }
                  : question,
              ),
            },
          }),
        MovedAlternative: (message) =>
          edit({
            draft: {
              ...model.draft,
              questions: questions.map((question, index) =>
                index === message.index
                  ? {
                      ...question,
                      alternatives: move(
                        question.alternatives,
                        message.alternative,
                        message.direction,
                      ),
                    }
                  : question,
              ),
            },
          }),
        ChangedAlternative: (message) =>
          edit({
            draft: {
              ...model.draft,
              questions: questions.map((question, index) =>
                index === message.index
                  ? {
                      ...question,
                      alternatives: question.alternatives.map((value, alternative) =>
                        alternative === message.alternative ? message.value : value,
                      ),
                    }
                  : question,
              ),
            },
          }),
        RefreshedMaintenance: () => {
          if (Predicate.isTagged(model.mutation, "Pending") || model.status === "Loading")
            return unchanged;
          const requestId = model.requestId + 1;

          return {
            model: { ...model, status: "Loading", requestId },
            commands: [commands.Load({ mode: model.mode, requestId })],
          };
        },
        SucceededQuestionnaires: (message) => {
          if (message.requestId !== model.requestId) return unchanged;
          const next = { ...model, questionnaires: message.data };

          return {
            model: {
              ...next,
              ...selectedFields(next, model.selectedId),
              status: "Ready",
              commandId: message.commandId,
              mutation: Predicate.isTagged(model.mutation, "Saved")
                ? model.mutation
                : Mutation.cases.Idle.make({}),
            },
            commands: [],
          };
        },
        SucceededStaffing: (message) => {
          if (message.requestId !== model.requestId) return unchanged;
          const next = { ...model, staffing: message.data };

          return {
            model: {
              ...next,
              ...selectedFields(next, model.selectedId),
              status: "Ready",
              commandId: message.commandId,
              mutation: Predicate.isTagged(model.mutation, "Saved")
                ? model.mutation
                : Mutation.cases.Idle.make({}),
            },
            commands: [],
          };
        },
        FailedLoad: (message) =>
          message.requestId !== model.requestId
            ? unchanged
            : { model: { ...model, status: message.denied ? "Denied" : "Failed" }, commands: [] },
        SucceededSave: (message) => {
          if (
            !Predicate.isTagged(model.mutation, "Pending") ||
            message.commandId !== model.mutation.command.commandId
          )
            return unchanged;
          const requestId = model.requestId + 1;

          return {
            model: {
              ...model,
              selectedId: Predicate.isTagged(message.result, "QuestionnaireSaved")
                ? message.result.interviewSchemaId
                : message.result.interviewId,
              expectedRevision: message.result.revision,
              mutation: Mutation.cases.Saved.make({}),
              status: "Loading",
              requestId,
            },
            commands: [commands.Load({ mode: model.mode, requestId })],
          };
        },
        FailedSave: (message) => {
          if (
            !Predicate.isTagged(model.mutation, "Pending") ||
            message.commandId !== model.mutation.command.commandId
          )
            return unchanged;

          return {
            model: {
              ...model,
              mutation: message.conflict
                ? Mutation.cases.Conflict.make({ message: message.message })
                : Mutation.cases.Failed.make({
                    command: model.mutation.command,
                    message: message.message,
                  }),
            },
            commands: [],
          };
        },
        RetriedMaintenance: () =>
          !Predicate.isTagged(model.mutation, "Failed")
            ? unchanged
            : {
                model: {
                  ...model,
                  mutation: Mutation.cases.Pending.make({ command: model.mutation.command }),
                },
                commands: [commands.Save({ command: model.mutation.command })],
              },
        ResumedEditing: () =>
          !Predicate.isTagged(model.mutation, "Failed")
            ? unchanged
            : { model, commands: [commands.PrepareEdit()] },
        CompletedPrepareEdit: (message) =>
          !Predicate.isTagged(model.mutation, "Failed")
            ? unchanged
            : {
                model: {
                  ...model,
                  commandId: message.commandId,
                  mutation: Mutation.cases.Idle.make({}),
                },
                commands: [],
              },
        SubmittedMaintenance: () => {
          if (locked) return unchanged;
          const common = { commandId: model.commandId, reason: model.reason };

          const definition = {
            ...model.draft,
            questions: questions.map((question, ordinal) => ({
              ...question,
              helpText: question.helpText === "" ? null : question.helpText,
              ordinal,
            })),
          };

          let command: Option.Option<RecruitmentMaintenanceCommand> = Option.none();

          if (model.mode === "Questionnaires") {
            const selected = model.questionnaires?.questionnaires.find(
              (entry) => entry.interviewSchemaId === model.selectedId,
            );

            if (model.selectedId === "")
              command = RecruitmentMaintenanceCommand.cases.CreateQuestionnaire.makeOption({
                ...common,
                ...definition,
              });
            else if (selected)
              command = RecruitmentMaintenanceCommand.cases.ReviseQuestionnaire.makeOption({
                ...common,
                ...definition,
                interviewSchemaId: selected.interviewSchemaId,
                expectedRevision: model.expectedRevision,
              });
          } else {
            const selected = model.staffing?.interviews.find(
              (entry) => entry.interviewId === model.selectedId,
            );

            const pair = Schema.decodeOption(
              Schema.Struct({
                interviewerPersonId: PersonId,
                coInterviewerPersonId: Schema.NullOr(PersonId),
              }),
            )({
              interviewerPersonId: model.primary,
              coInterviewerPersonId: model.co === "" ? null : model.co,
            });

            if (selected && Option.isSome(pair))
              command = RecruitmentMaintenanceCommand.cases.ChangeInterviewStaffing.makeOption({
                ...common,
                ...pair.value,
                interviewId: selected.interviewId,
                expectedRevision: model.expectedRevision,
              });
          }

          const terminal =
            model.mode === "Staffing" &&
            model.staffing?.interviews.find((entry) => entry.interviewId === model.selectedId)
              ?.terminal;

          if (
            Option.isNone(command) ||
            terminal ||
            (model.mode === "Questionnaires" && model.draft.active && questions.length === 0)
          )
            return {
              model: {
                ...model,
                mutation: Mutation.cases.Invalid.make({
                  message: terminal
                    ? "Intervjuet er fullført eller avlyst."
                    : "Fyll ut navn, spørsmål, gyldige og ulike svaralternativer og begrunnelse. Aktive skjemaer må ha minst ett spørsmål. For bemanning må en hovedintervjuer være valgt.",
                }),
              },
              commands: [],
            };

          return {
            model: { ...model, mutation: Mutation.cases.Pending.make({ command: command.value }) },
            commands: [commands.Save({ command: command.value })],
          };
        },
      }),
    );
  };

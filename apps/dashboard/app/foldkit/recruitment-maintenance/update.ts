import { Match, Option, Predicate, Schema } from "effect";
import { Dialog } from "@foldkit/ui";
import { Instant } from "@vektorprogrammet/domain/time";
import { Command } from "foldkit";
import { RecruitmentMaintenanceCommand, PersonId } from "@vektorprogrammet/http-api";
import type { Update } from "foldkit";
import { FocusCorrectionReopen, type MaintenanceCommands } from "./command";
import { CompletedCancelWorkflowFocus, GotCorrectionDialogMessage, type Message } from "./message";
import { Mutation, type Model, type WorkflowFocusTicket } from "./model";

const decodeInstant = Schema.decodeUnknownOption(Instant);

const dialogCommands = (
  commands: ReadonlyArray<Command.Command<Dialog.Message>>,
  generation: number,
  ticket?: WorkflowFocusTicket,
): ReadonlyArray<Command.Command<Message>> => Command.mapMessages(commands, (message) =>
  ticket === undefined
    ? GotCorrectionDialogMessage({ message, generation })
    : GotCorrectionDialogMessage({ message, generation, ticket }),
);

const sameTicket = (left: WorkflowFocusTicket | null | undefined, right: WorkflowFocusTicket): boolean =>
  left !== null && left !== undefined && left.interviewId === right.interviewId &&
  left.requestId === right.requestId && left.commandId === right.commandId;

const canFocusReopen = (model: Model, ticket: WorkflowFocusTicket): boolean => {
  const observation = model.staffing?.interviews.find((entry) => entry.interviewId === ticket.interviewId)?.assessmentCorrection;

  return model.status === "Ready" && model.selectedId === ticket.interviewId &&
    model.requestId === ticket.requestId && !model.correctionDialog.isOpen &&
    Predicate.isTagged(model.mutation, "Saved") && observation !== undefined &&
    Predicate.isTagged(observation, "Closed") && observation.canReopen;
};

const selectedFields = (
  model: Model,
  id: string,
): Pick<
  Model,
  | "selectedId"
  | "expectedRevision"
  | "draft"
  | "primary"
  | "co"
  | "reason"
  | "correctionAction"
  | "correctionReason"
  | "correctionEndsAt"
> => {
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
    correctionAction: null,
    correctionReason: "",
    correctionEndsAt: "",
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
      locked || model.correctionDialog.isOpen
        ? unchanged
        : { model: { ...model, ...next, mutation: Mutation.cases.Idle.make({}) }, commands: [] };

    // Cancellation clears intent immediately. Replacements are admitted only from native
    // cancellation completion; NotFound does not authorize a queued stale result.
    const cancelFocus = (next: Model): Update.Return<Model, Message> => {
      const intent = model.workflowFocus;

      if (intent === null) return { model: next, commands: [] };

      if (intent.phase === "Reloading") return {
        model: { ...next, workflowFocus: null, requestId: model.requestId + 1, reloadAfterCancel: model.requestId, status: "Loading" },
        commands: [commands.CancelLoad(model.requestId)],
      };

      return {
        model: { ...next, workflowFocus: null, cancellingFocus: intent.ticket },
        commands: [FocusCorrectionReopen.Interrupt({ interviewId: intent.ticket.interviewId }, (outcome) => CompletedCancelWorkflowFocus({ ticket: intent.ticket, outcome }))],
      };
    };

    const questions = model.draft.questions;

    return Match.value(message).pipe(
      Match.withReturnType<Update.Return<Model, Message>>(),
      Match.tagsExhaustive({
        CompletedCancelMaintenanceLoad: ({ requestId }) => {
          if (model.reloadAfterCancel !== requestId) return unchanged;

          return { model: { ...model, reloadAfterCancel: null }, commands: [commands.Load({ mode: model.mode, requestId: model.requestId })] };
        },
        CompletedCancelWorkflowFocus: ({ ticket }) => sameTicket(model.cancellingFocus, ticket)
          ? { model: { ...model, cancellingFocus: null }, commands: [] } : unchanged,
        CompletedWorkflowFocus: ({ ticket }) => sameTicket(model.workflowFocus?.ticket, ticket) && model.workflowFocus?.phase === "Focusing"
          ? { model: { ...model, workflowFocus: null }, commands: [] } : unchanged,
        FailedWorkflowFocus: ({ ticket }) => sameTicket(model.workflowFocus?.ticket, ticket) && model.workflowFocus?.phase === "Focusing"
          ? { model: { ...model, workflowFocus: null }, commands: [] } : unchanged,
        OpenedCorrectionWindow: ({ action }) => {
          if (locked || model.correctionDialog.isOpen || model.dialogClosing || model.cancellingFocus !== null || model.workflowFocus !== null || model.mode !== "Staffing")
            return unchanged;

          const selected = model.staffing?.interviews.find(
            (entry) => entry.interviewId === model.selectedId,
          );

          if (
            !selected ||
            !(action === "Reopen"
              ? selected.assessmentCorrection.canReopen
              : selected.assessmentCorrection.canClose)
          )
            return unchanged;
          const opened = Dialog.open(model.correctionDialog);

          const retained =
            model.correctionAction === action &&
            model.correctionSequence === selected.assessmentCorrection.sequence;

          return {
            model: {
              ...model,
              correctionDialog: opened.model,
              dialogGeneration: model.dialogGeneration + 1,
              correctionAction: action,
              correctionSequence: selected.assessmentCorrection.sequence,
              correctionReason: retained ? model.correctionReason : "",
              correctionEndsAt: retained ? model.correctionEndsAt : "",
              mutation: Mutation.cases.Idle.make({}),
            },
            commands: dialogCommands(opened.commands ?? [], model.dialogGeneration + 1),
          };
        },
        ChangedCorrectionReason: ({ value }) =>
          locked || !model.correctionDialog.isOpen
            ? unchanged
            : {
                model: {
                  ...model,
                  correctionReason: value,
                  mutation: Mutation.cases.Idle.make({}),
                },
                commands: [],
              },
        ChangedCorrectionEndsAt: ({ value }) =>
          locked || !model.correctionDialog.isOpen || model.correctionAction !== "Reopen"
            ? unchanged
            : {
                model: {
                  ...model,
                  correctionEndsAt: value,
                  mutation: Mutation.cases.Idle.make({}),
                },
                commands: [],
              },
        GotCorrectionDialogMessage: ({ message, generation, ticket }) => {
          if (generation !== model.dialogGeneration) return unchanged;

          if (Predicate.isTagged(model.mutation, "Pending") && Predicate.isTagged(message, "RequestedClose")) return unchanged;
          const completed = Predicate.isTagged(message, "CompletedCloseDialog");

          if (completed && model.closingTicket !== null && (ticket === undefined || !sameTicket(model.closingTicket, ticket))) return unchanged;

          // An already-running native Close owns release. Late acquisition/show receipts
          // must not launch a second same-id Close that could outlive the release barrier.
          if (model.dialogClosing && !model.correctionDialog.isOpen && (Predicate.isTagged(message, "SucceededShowDialog") || Predicate.isTagged(message, "SucceededAcquireResources"))) return unchanged;
          const next = Dialog.update(model.correctionDialog, message);
          const nextModel = { ...model, correctionDialog: next.model, closingTicket: completed ? null : model.closingTicket, dialogClosing: completed ? false : model.dialogClosing || (next.commands ?? []).some((command) => command.name === Dialog.CloseDialog.name) };

          if (completed && ticket !== undefined && model.workflowFocus?.phase === "Closing" && sameTicket(model.workflowFocus.ticket, ticket) && canFocusReopen(nextModel, ticket)) {
            return { model: { ...nextModel, workflowFocus: { ticket, phase: "Focusing" } }, commands: [FocusCorrectionReopen(ticket)] };
          }

          if (Predicate.isTagged(message, "RequestedClose") || Predicate.isTagged(message, "Unmounted") || Predicate.isTagged(message, "FailedShowDialog") || Predicate.isTagged(message, "FailedAcquireResources")) {
            const cancelled = cancelFocus(nextModel);

            return { model: cancelled.model, commands: [...(cancelled.commands ?? []), ...dialogCommands(next.commands ?? [], model.dialogGeneration)] };
          }

          return { model: nextModel, commands: dialogCommands(next.commands ?? [], model.dialogGeneration) };
        },
        SubmittedCorrectionWindow: () => {
          if (
            locked ||
            !model.correctionDialog.isOpen ||
            model.correctionAction === null ||
            model.mode !== "Staffing"
          )
            return unchanged;

          const selected = model.staffing?.interviews.find(
            (entry) => entry.interviewId === model.selectedId,
          );

          if (
            !selected ||
            selected.assessmentCorrection.sequence !== model.correctionSequence ||
            !(model.correctionAction === "Reopen"
              ? selected.assessmentCorrection.canReopen
              : selected.assessmentCorrection.canClose)
          ) {
            return {
              model: {
                ...model,
                mutation: Mutation.cases.Invalid.make({
                  message:
                    "Serveren tillater ikke denne endringen i den viste versjonen. Last gjeldende versjon.",
                }),
              },
              commands: [],
            };
          }

          const common = {
            commandId: model.commandId,
            interviewId: selected.interviewId,
            reason: model.correctionReason,
            expectedSequence: model.correctionSequence,
          };

          const endsAt = decodeInstant(model.correctionEndsAt);

          const command: Option.Option<
            | typeof RecruitmentMaintenanceCommand.cases.CloseAssessmentCorrection.Type
            | typeof RecruitmentMaintenanceCommand.cases.ReopenAssessmentCorrection.Type
          > =
            model.correctionAction === "Close"
              ? RecruitmentMaintenanceCommand.cases.CloseAssessmentCorrection.makeOption(common)
              : Option.isSome(endsAt)
                ? RecruitmentMaintenanceCommand.cases.ReopenAssessmentCorrection.makeOption({
                    ...common,
                    endsAt: endsAt.value,
                  })
                : Option.none();

          if (Option.isNone(command)) {
            return {
              model: {
                ...model,
                mutation: Mutation.cases.Invalid.make({
                  message:
                    "Skriv en begrunnelse (maks 2000 tegn) og, ved gjenåpning, et gyldig sluttidspunkt med tidssone.",
                }),
              },
              commands: [],
            };
          }

          return {
            model: { ...model, mutation: Mutation.cases.Pending.make({ command: command.value }) },
            commands: [commands.Save({ command: command.value })],
          };
        },
        SelectedRecord: (message) => {
          if (Predicate.isTagged(model.mutation, "Pending") || model.reloadAfterCancel !== null) return unchanged;

          if (model.correctionDialog.isOpen && model.workflowFocus?.phase !== "Reloading") return unchanged;

          if (locked && model.workflowFocus === null) return unchanged;
          const closed = model.workflowFocus?.phase === "Reloading" ? Dialog.close(model.correctionDialog) : { model: model.correctionDialog, commands: [] };
          const cancelled = cancelFocus({ ...model, ...selectedFields(model, message.id), mutation: Mutation.cases.Idle.make({}), correctionDialog: closed.model, dialogClosing: model.dialogClosing || (closed.commands ?? []).length > 0 });

          return { model: cancelled.model, commands: [...(cancelled.commands ?? []), ...dialogCommands(closed.commands ?? [], model.dialogGeneration)] };
        },
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
          if (Predicate.isTagged(model.mutation, "Pending") || model.reloadAfterCancel !== null || (model.status === "Loading" && model.workflowFocus === null)) return unchanged;
          const closed = Dialog.close(model.correctionDialog);
          const cancelled = cancelFocus({ ...model, correctionDialog: closed.model, dialogClosing: model.dialogClosing || (closed.commands ?? []).length > 0, correctionAction: null, status: "Loading", requestId: model.requestId + 1 });

          return {
            model: cancelled.model,
            commands: [...(cancelled.commands ?? []), ...dialogCommands(closed.commands ?? [], model.dialogGeneration),
              ...(model.workflowFocus?.phase === "Reloading" ? [] : [commands.Load({ mode: model.mode, requestId: cancelled.model.requestId })])],
          };
        },
        SucceededQuestionnaires: (message) => {
          if (message.requestId !== model.requestId || model.status !== "Loading") return unchanged;
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
          if (message.requestId !== model.requestId || model.status !== "Loading" || model.reloadAfterCancel !== null) return unchanged;
          const next = { ...model, staffing: message.data };

          const ready: Model = { ...next, ...selectedFields(next, model.selectedId), status: "Ready", commandId: message.commandId,
            mutation: Predicate.isTagged(model.mutation, "Saved") ? model.mutation : Mutation.cases.Idle.make({}) };

          const intent = model.workflowFocus;

          if (intent === null || intent.phase !== "Reloading" || intent.ticket.requestId !== message.requestId || intent.ticket.interviewId !== model.selectedId) return { model: ready, commands: [] };
          const closed = Dialog.close(model.correctionDialog);
          const closedModel: Model = { ...ready, correctionDialog: closed.model, dialogClosing: (closed.commands ?? []).length > 0, closingTicket: intent.ticket };
          const eligible = canFocusReopen(closedModel, intent.ticket);

          return {
            model: { ...closedModel, workflowFocus: eligible && closedModel.dialogClosing ? { ticket: intent.ticket, phase: "Closing" } : null },
            commands: dialogCommands(closed.commands ?? [], model.dialogGeneration, intent.ticket),
          };
        },
        FailedLoad: (message) => {
          if (message.requestId !== model.requestId || model.status !== "Loading" || model.reloadAfterCancel !== null) return unchanged;
          const closed = Dialog.close(model.correctionDialog);

          return { model: { ...model, correctionDialog: closed.model, dialogClosing: (closed.commands ?? []).length > 0, workflowFocus: null, status: message.denied ? "Denied" : "Failed" }, commands: dialogCommands(closed.commands ?? [], model.dialogGeneration) };
        },
        SucceededSave: (message) => {
          if (
            !Predicate.isTagged(model.mutation, "Pending") ||
            message.commandId !== model.mutation.command.commandId
          )
            return unchanged;

          const correlated = Match.value(model.mutation.command).pipe(
            Match.tag(
              "ReopenAssessmentCorrection",
              (command) =>
                Predicate.isTagged(message.result, "AssessmentCorrectionReopened") &&
                message.result.interviewId === command.interviewId,
            ),
            Match.tag(
              "CloseAssessmentCorrection",
              (command) =>
                Predicate.isTagged(message.result, "AssessmentCorrectionClosed") &&
                message.result.interviewId === command.interviewId,
            ),
            Match.tag(
              "ChangeInterviewStaffing",
              (command) =>
                Predicate.isTagged(message.result, "InterviewStaffingChanged") &&
                message.result.interviewId === command.interviewId,
            ),
            Match.tag(
              "ReviseQuestionnaire",
              (command) =>
                Predicate.isTagged(message.result, "QuestionnaireSaved") &&
                message.result.interviewSchemaId === command.interviewSchemaId,
            ),
            Match.tag("CreateQuestionnaire", () =>
              Predicate.isTagged(message.result, "QuestionnaireSaved"),
            ),
            Match.exhaustive,
          );

          if (!correlated) return unchanged;
          const requestId = model.requestId + 1;

          const focusTicket = Predicate.isTagged(model.mutation.command, "CloseAssessmentCorrection") && model.correctionDialog.isOpen
            ? { interviewId: model.mutation.command.interviewId, requestId, commandId: model.mutation.command.commandId } : null;

          const closed = focusTicket === null ? Dialog.close(model.correctionDialog) : { model: model.correctionDialog, commands: [] };

          return {
            model: {
              ...model,
              correctionDialog: closed.model,
              dialogClosing: (closed.commands ?? []).length > 0,
              workflowFocus: focusTicket === null ? null : { ticket: focusTicket, phase: "Reloading" },
              selectedId: Predicate.isTagged(message.result, "QuestionnaireSaved")
                ? message.result.interviewSchemaId
                : message.result.interviewId,
              expectedRevision:
                "revision" in message.result ? message.result.revision : model.expectedRevision,
              mutation: Mutation.cases.Saved.make({}),
              status: "Loading",
              requestId,
            },
            commands: [
              ...dialogCommands(closed.commands ?? [], model.dialogGeneration),
              commands.Load({ mode: model.mode, requestId }),
            ],
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
          if (model.correctionDialog.isOpen) return unchanged;

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

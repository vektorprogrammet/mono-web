import { Dialog } from "@foldkit/ui";
import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { Match as M, Option, Predicate } from "effect";
import { AsyncData, Command, Update } from "foldkit";
import type { TeamApplicationsCommands } from "./command";
import { draftFromIntake, intakePatchFrom } from "./intake";
import { GotDeleteDialogMessage, type Message } from "./message";
import {
  DEADLINE_INPUT_ID,
  DETAIL_HEADING_ID,
  DetailData,
  LIST_HEADING_ID,
  Mutation,
  MutationRequest,
  PageData,
  type IntakeDraft,
  type Model,
} from "./model";

type Return = Update.Return<Model, Message>;

/**
 * Repeats the idempotency key of the identical request whose outcome is unknown, so a retry
 * returns the original result. Any other request consumes a fresh key.
 */
const keyFor = (model: Model, isIdentical: (uncertain: MutationRequest) => boolean) =>
  model.uncertainRequest !== null && isIdentical(model.uncertainRequest)
    ? { commandId: model.uncertainRequest.commandId, commandSequence: model.commandSequence }
    : {
        commandId: IdempotencyKey.make(`${model.idempotencyKeySeed}-${model.commandSequence}`),
        commandSequence: model.commandSequence + 1,
      };

const dialogCommands = (commands: ReadonlyArray<Command.Command<Dialog.Message>>) =>
  Command.mapMessages(commands, (message) => GotDeleteDialogMessage({ message }));

export const updateFor = ({
  LoadPage,
  ReadApplication,
  DeleteApplication,
  ReviseIntake,
  Focus,
}: TeamApplicationsCommands) => {
  const unchanged = (model: Model): Return => ({ model, commands: [] });

  const loadPage = (model: Model, cursor: string | null, pageNumber: number): Return => {
    const requestId = model.pageRequestId + 1;
    const held = AsyncData.getData(model.page);

    return {
      model: {
        ...model,
        page: Option.isSome(held) ? PageData.Refreshing({ data: held.value }) : PageData.Loading(),
        pageCursor: cursor,
        pageNumber,
        pageRequestId: requestId,
      },
      commands: [LoadPage({ teamId: model.teamId, cursor, requestId })],
    };
  };

  const reloadPage = (model: Model): Return => loadPage(model, model.pageCursor, model.pageNumber);

  const withoutDetail = (model: Model): Model => ({
    ...model,
    selectedApplicationId: null,
    detail: DetailData.Idle(),
    detailRequestId: model.detailRequestId + 1,
  });

  const closeDeleteDialog = (model: Model): Return => {
    if (!model.deleteDialog.isOpen) return unchanged(model);
    const { model: deleteDialog, commands = [] } = Dialog.close(model.deleteDialog);

    return { model: { ...model, deleteDialog }, commands: dialogCommands(commands) };
  };

  const sequence = (first: Return, next: (model: Model) => Return): Return => {
    const second = next(first.model);

    return {
      model: second.model,
      commands: [...(first.commands ?? []), ...(second.commands ?? [])],
    };
  };

  const editDraft = (model: Model, edit: (draft: IntakeDraft) => IntakeDraft): Return =>
    model.intakeDraft === null || !Predicate.isTagged(model.mutation, "Idle")
      ? unchanged(model)
      : { model: { ...model, intakeDraft: edit(model.intakeDraft), notice: null }, commands: [] };

  return (model: Model, message: Message): Return =>
    M.value(message).pipe(
      M.withReturnType<Return>(),
      M.tagsExhaustive({
        RequestedFirstPage: () =>
          AsyncData.isPending(model.page) || model.pageNumber === 1
            ? unchanged(model)
            : loadPage({ ...withoutDetail(model), notice: null }, null, 1),
        RequestedNextPage: () => {
          const held = AsyncData.getData(model.page);

          if (AsyncData.isPending(model.page) || Option.isNone(held)) return unchanged(model);
          const nextCursor = held.value.nextCursor;

          return nextCursor === undefined
            ? unchanged(model)
            : loadPage({ ...withoutDetail(model), notice: null }, nextCursor, model.pageNumber + 1);
        },
        RetriedPage: () => (AsyncData.isPending(model.page) ? unchanged(model) : reloadPage(model)),
        SucceededLoadPage: ({ requestId, page }) => {
          if (requestId !== model.pageRequestId) return unchanged(model);
          const held = AsyncData.getData(model.page);

          // A read that started before a saved intake change must not roll the intake back.
          const intake =
            Option.isSome(held) && held.value.intake.revision > page.intake.revision
              ? held.value.intake
              : page.intake;

          return {
            model: {
              ...model,
              page: PageData.Success({ data: { ...page, intake } }),
              intakeDraft:
                model.intakeDraft !== null && model.intakeDraft.basedOnEtag === intake.etag
                  ? model.intakeDraft
                  : draftFromIntake(intake),
            },
            commands: [],
          };
        },
        FailedLoadPage: ({ requestId, failure }) => {
          if (requestId !== model.pageRequestId) return unchanged(model);
          const held = AsyncData.getData(model.page);

          if (failure === "Unavailable" && Option.isSome(held)) {
            return {
              model: { ...model, page: PageData.Stale({ data: held.value, error: failure }) },
              commands: [],
            };
          }

          // Lost authority or a vanished team: drop every cached private field.
          return closeDeleteDialog({
            ...withoutDetail(model),
            page: PageData.Failure({ error: failure }),
            intakeDraft: null,
          });
        },
        OpenedApplication: ({ applicationId }) => {
          if (Option.isNone(AsyncData.getData(model.page))) return unchanged(model);
          const requestId = model.detailRequestId + 1;

          return {
            model: {
              ...model,
              selectedApplicationId: applicationId,
              detail: DetailData.Loading(),
              detailRequestId: requestId,
              notice: null,
            },
            commands: [
              ReadApplication({ applicationId, requestId }),
              Focus({ selector: `#${DETAIL_HEADING_ID}` }),
            ],
          };
        },
        ClosedApplication: () => {
          if (model.selectedApplicationId === null || model.deleteDialog.isOpen) {
            return unchanged(model);
          }

          return {
            model: withoutDetail(model),
            commands: [
              Focus({ selector: `[data-application-id="${model.selectedApplicationId}"] button` }),
            ],
          };
        },
        SucceededReadApplication: ({ requestId, application }) =>
          requestId !== model.detailRequestId
            ? unchanged(model)
            : {
                model: { ...model, detail: DetailData.Success({ data: application }) },
                commands: [],
              },
        FailedReadApplication: ({ requestId, failure }) => {
          if (requestId !== model.detailRequestId) return unchanged(model);
          const failed = { ...model, detail: DetailData.Failure({ error: failure }) };

          // A denial or a vanished application can mean changed membership or a deletion elsewhere.
          return failure === "Unavailable" ? unchanged(failed) : reloadPage(failed);
        },
        RequestedDelete: () => {
          if (
            !Predicate.isTagged(model.detail, "Success") ||
            !model.detail.data.canManage ||
            !Predicate.isTagged(model.mutation, "Idle")
          ) {
            return unchanged(model);
          }

          const { model: deleteDialog, commands = [] } = Dialog.open(model.deleteDialog);

          return {
            model: { ...model, deleteDialog, notice: null },
            commands: dialogCommands(commands),
          };
        },
        ConfirmedDelete: () => {
          if (
            !model.deleteDialog.isOpen ||
            !Predicate.isTagged(model.mutation, "Idle") ||
            !Predicate.isTagged(model.detail, "Success")
          ) {
            return unchanged(model);
          }

          const applicationId = model.detail.data.applicationId;

          const { commandId, commandSequence } = keyFor(
            model,
            (uncertain) =>
              Predicate.isTagged(uncertain, "DeleteApplication") &&
              uncertain.applicationId === applicationId,
          );

          const requestId = model.mutationRequestId + 1;

          return {
            model: {
              ...model,
              mutation: Mutation.cases.Sending.make({
                request: MutationRequest.cases.DeleteApplication.make({ applicationId, commandId }),
              }),
              mutationRequestId: requestId,
              commandSequence,
            },
            commands: [DeleteApplication({ applicationId, commandId, requestId })],
          };
        },
        CancelledDelete: () =>
          Predicate.isTagged(model.mutation, "Sending")
            ? unchanged(model)
            : closeDeleteDialog(model),
        GotDeleteDialogMessage: ({ message: dialogMessage }) => {
          if (
            Predicate.isTagged(model.mutation, "Sending") &&
            Predicate.isTagged(dialogMessage, "RequestedClose")
          ) {
            return unchanged(model);
          }

          const { model: deleteDialog, commands = [] } = Dialog.update(
            model.deleteDialog,
            dialogMessage,
          );

          return { model: { ...model, deleteDialog }, commands: dialogCommands(commands) };
        },
        SucceededDelete: ({ requestId }) => {
          if (
            requestId !== model.mutationRequestId ||
            !Predicate.isTagged(model.mutation, "Sending")
          ) {
            return unchanged(model);
          }

          const settled: Model = {
            ...withoutDetail(model),
            mutation: Mutation.cases.Idle.make({}),
            uncertainRequest: null,
            notice: "Deleted",
          };

          return sequence(sequence(closeDeleteDialog(settled), reloadPage), (next) => ({
            model: next,
            commands: [Focus({ selector: `#${LIST_HEADING_ID}` })],
          }));
        },
        FailedDelete: ({ requestId, failure }) => {
          if (
            requestId !== model.mutationRequestId ||
            !Predicate.isTagged(model.mutation, "Sending")
          ) {
            return unchanged(model);
          }

          const closed = closeDeleteDialog({
            ...model,
            mutation: Mutation.cases.Idle.make({}),
            uncertainRequest: failure === "Unavailable" ? model.mutation.request : null,
            notice: failure,
          });

          return M.value(failure).pipe(
            M.when("NotFound", () => sequence(closed, (next) => reloadPage(withoutDetail(next)))),
            M.when("Denied", () =>
              sequence(sequence(closed, reloadPage), (next) => {
                if (next.selectedApplicationId === null) return unchanged(next);
                const detailRequestId = next.detailRequestId + 1;

                return {
                  model: { ...next, detail: DetailData.Loading(), detailRequestId },
                  commands: [
                    ReadApplication({
                      applicationId: next.selectedApplicationId,
                      requestId: detailRequestId,
                    }),
                  ],
                };
              }),
            ),
            M.orElse(() => closed),
          );
        },
        ToggledAcceptApplication: ({ isChecked }) =>
          editDraft(model, (draft) => ({ ...draft, acceptApplication: isChecked })),
        ChangedDeadline: ({ value }) =>
          editDraft(model, (draft) => ({ ...draft, deadline: value })),
        ClearedDeadline: () => editDraft(model, (draft) => ({ ...draft, deadline: "" })),
        SubmittedIntake: () => {
          const held = AsyncData.getData(model.page);

          if (
            Option.isNone(held) ||
            !held.value.canManage ||
            model.intakeDraft === null ||
            !Predicate.isTagged(model.mutation, "Idle")
          ) {
            return unchanged(model);
          }

          const etag = held.value.intake.etag;

          return M.value(intakePatchFrom(held.value.intake, model.intakeDraft)).pipe(
            M.withReturnType<Return>(),
            M.tagsExhaustive({
              NoChange: () => ({ model: { ...model, notice: "NoChange" }, commands: [] }),
              InvalidDeadline: () => ({
                model: { ...model, notice: null },
                commands: [Focus({ selector: `#${DEADLINE_INPUT_ID}` })],
              }),
              Patch: ({ patch }) => {
                const { commandId, commandSequence } = keyFor(
                  model,
                  (uncertain) =>
                    Predicate.isTagged(uncertain, "ReviseIntake") &&
                    uncertain.etag === etag &&
                    uncertain.patch.acceptApplication === patch.acceptApplication &&
                    uncertain.patch.deadline === patch.deadline,
                );

                const requestId = model.mutationRequestId + 1;

                return {
                  model: {
                    ...model,
                    mutation: Mutation.cases.Sending.make({
                      request: MutationRequest.cases.ReviseIntake.make({ etag, patch, commandId }),
                    }),
                    mutationRequestId: requestId,
                    commandSequence,
                    notice: null,
                  },
                  commands: [
                    ReviseIntake({ teamId: model.teamId, etag, patch, commandId, requestId }),
                  ],
                };
              },
            }),
          );
        },
        SucceededReviseIntake: ({ requestId, intake }) => {
          if (
            requestId !== model.mutationRequestId ||
            !Predicate.isTagged(model.mutation, "Sending")
          ) {
            return unchanged(model);
          }

          return {
            model: {
              ...model,
              page: AsyncData.map(model.page, (page) => ({ ...page, intake })),
              intakeDraft: draftFromIntake(intake),
              mutation: Mutation.cases.Idle.make({}),
              uncertainRequest: null,
              notice: "IntakeSaved",
            },
            commands: [],
          };
        },
        FailedReviseIntake: ({ requestId, failure }) => {
          if (
            requestId !== model.mutationRequestId ||
            !Predicate.isTagged(model.mutation, "Sending")
          ) {
            return unchanged(model);
          }

          const settled: Model = {
            ...model,
            mutation: Mutation.cases.Idle.make({}),
            uncertainRequest: failure === "Unavailable" ? model.mutation.request : null,
            notice: failure,
          };

          // A stale revision or lost leadership needs the current intake and projection.
          return failure === "Stale" || failure === "Denied"
            ? reloadPage(settled)
            : unchanged(settled);
        },
        CompletedFocus: () => unchanged(model),
      }),
    );
};

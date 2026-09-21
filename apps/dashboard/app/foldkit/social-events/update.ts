import { Schema as S, Match as M } from "effect";
import { Command } from "foldkit";
import { SocialEventsCreateCommand, type SocialEventsListInput } from "./bridge";
import type { SocialEventsCommandFactories } from "./command";
import type { Message } from "./message";
import type { Model, SocialEventDraft, SocialEventsFailure } from "./model";

export type UpdateResult = readonly [Model, ReadonlyArray<Command.Command<Message>>];

const invalidDraftFailure: SocialEventsFailure = {
  _tag: "Failed",
  tag: "InvalidDraft",
  message: "Fyll ut avdeling, semester, tittel og gyldige start- og sluttidspunkt.",
};

const listQuery = (draft: SocialEventDraft): SocialEventsListInput | null =>
  draft.departmentId === null || draft.semesterId === null
    ? null
    : { departmentId: draft.departmentId, semesterId: draft.semesterId };

const toRfc3339Instant = (value: string): string => {
  if (value.length === 0) return value;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : value;
};

const createCommand = (
  draft: SocialEventDraft,
  commandId: string,
): S.Schema.Type<typeof SocialEventsCreateCommand> | null => {
  const query = listQuery(draft);
  if (query === null) return null;
  try {
    return S.decodeUnknownSync(SocialEventsCreateCommand)(
      {
        commandId,
        ...query,
        audience: draft.audience,
        title: draft.title,
        description: draft.description,
        link: draft.link.trim() === "" ? null : draft.link,
        startAt: toRfc3339Instant(draft.startAt),
        endAt: toRfc3339Instant(draft.endAt),
      },
      { onExcessProperty: "error" },
    );
  } catch {
    return null;
  }
};

const isKnownDepartment = (model: Model, departmentId: string | null): boolean =>
  departmentId === null ||
  (model.scope._tag === "Success" &&
    model.scope.data.departments.some((department) => department.departmentId === departmentId));

const isKnownSemester = (model: Model, semesterId: string | null): boolean =>
  semesterId === null ||
  (model.scope._tag === "Success" &&
    model.scope.data.semesters.some((semester) => semester.semesterId === semesterId));

const loadSelectedList = (
  model: Model,
  commands: SocialEventsCommandFactories,
  draft: SocialEventDraft = model.draft,
): UpdateResult => {
  const query = listQuery(draft);
  if (query === null) return [{ ...model, draft, list: { _tag: "Idle" } }, []];
  const requestId = model.requestId + 1;
  return [
    { ...model, draft, requestId, list: { _tag: "Loading" } },
    [commands.LoadList({ requestId, query })],
  ];
};

export const makeUpdate =
  (commands: SocialEventsCommandFactories) =>
  (model: Model, message: Message): UpdateResult =>
    M.value(message).pipe(
      M.withReturnType<UpdateResult>(),
      M.tagsExhaustive({
        LoadedScope: ({ requestId, scope }) => {
          if (requestId !== model.requestId) return [model, []];
          const draft: SocialEventDraft = {
            ...model.draft,
            departmentId: scope.departments[0]?.departmentId ?? null,
            semesterId: scope.semesters[0]?.semesterId ?? null,
          };
          const query = listQuery(draft);
          if (query === null) {
            return [
              {
                ...model,
                scope: { _tag: "Success", data: scope },
                draft,
                list: { _tag: "Idle" },
                failure: null,
              },
              [],
            ];
          }
          const listRequestId = model.requestId + 1;
          return [
            {
              ...model,
              scope: { _tag: "Success", data: scope },
              draft,
              list: { _tag: "Loading" },
              requestId: listRequestId,
              failure: null,
            },
            [commands.LoadList({ requestId: listRequestId, query })],
          ];
        },
        FailedScope: ({ requestId, failure }) =>
          requestId !== model.requestId
            ? [model, []]
            : [
                { ...model, scope: { _tag: "Failure", error: failure }, list: { _tag: "Idle" } },
                [],
              ],
        RetriedScope: () => {
          if (model.pendingCommand !== null) return [model, []];
          const requestId = model.requestId + 1;
          return [
            {
              ...model,
              scope: { _tag: "Loading" },
              list: { _tag: "Idle" },
              requestId,
              failure: null,
              success: false,
            },
            [commands.LoadScope({ requestId })],
          ];
        },
        SelectedDepartment: ({ departmentId }) => {
          if (model.pendingCommand !== null || !isKnownDepartment(model, departmentId)) {
            return [model, []];
          }
          if (departmentId === model.draft.departmentId) return [model, []];
          const draft = { ...model.draft, departmentId };
          const [next, emitted] = loadSelectedList(model, commands, draft);
          return [{ ...next, failure: null, success: false }, emitted];
        },
        SelectedSemester: ({ semesterId }) => {
          if (model.pendingCommand !== null || !isKnownSemester(model, semesterId))
            return [model, []];
          if (semesterId === model.draft.semesterId) return [model, []];
          const draft = { ...model.draft, semesterId };
          const [next, emitted] = loadSelectedList(model, commands, draft);
          return [{ ...next, failure: null, success: false }, emitted];
        },
        SelectedAudience: ({ audience }) =>
          model.pendingCommand !== null
            ? [model, []]
            : [
                { ...model, draft: { ...model.draft, audience }, failure: null, success: false },
                [],
              ],
        ChangedTitle: ({ value }) =>
          model.pendingCommand !== null
            ? [model, []]
            : [
                {
                  ...model,
                  draft: { ...model.draft, title: value },
                  failure: null,
                  success: false,
                },
                [],
              ],
        ChangedDescription: ({ value }) =>
          model.pendingCommand !== null
            ? [model, []]
            : [
                {
                  ...model,
                  draft: { ...model.draft, description: value },
                  failure: null,
                  success: false,
                },
                [],
              ],
        ChangedLink: ({ value }) =>
          model.pendingCommand !== null
            ? [model, []]
            : [
                { ...model, draft: { ...model.draft, link: value }, failure: null, success: false },
                [],
              ],
        ChangedStartAt: ({ value }) =>
          model.pendingCommand !== null
            ? [model, []]
            : [
                {
                  ...model,
                  draft: { ...model.draft, startAt: value },
                  failure: null,
                  success: false,
                },
                [],
              ],
        ChangedEndAt: ({ value }) =>
          model.pendingCommand !== null
            ? [model, []]
            : [
                {
                  ...model,
                  draft: { ...model.draft, endAt: value },
                  failure: null,
                  success: false,
                },
                [],
              ],
        LoadedList: ({ requestId, list }) =>
          requestId !== model.requestId
            ? [model, []]
            : [{ ...model, list: { _tag: "Success", data: list } }, []],
        FailedList: ({ requestId, failure }) =>
          requestId !== model.requestId
            ? [model, []]
            : [{ ...model, list: { _tag: "Failure", error: failure } }, []],
        RetriedList: () => {
          if (model.pendingCommand !== null) return [model, []];
          const query = listQuery(model.draft);
          if (query === null) return [model, []];
          const requestId = model.requestId + 1;
          return [
            { ...model, requestId, list: { _tag: "Loading" } },
            [commands.LoadList({ requestId, query })],
          ];
        },
        SubmittedCreate: ({ commandId }) => {
          if (
            model.pendingCommand !== null ||
            model.list._tag === "Idle" ||
            model.list._tag === "Loading"
          ) {
            return [model, []];
          }
          const command = createCommand(model.draft, commandId);
          if (command === null) {
            return [{ ...model, failure: invalidDraftFailure, success: false }, []];
          }
          const requestId = model.requestId + 1;
          return [
            {
              ...model,
              requestId,
              commandSequence: model.commandSequence + 1,
              pendingCommand: "Create",
              failure: null,
              success: false,
            },
            [commands.Create({ requestId, command })],
          ];
        },
        SucceededCreate: ({ requestId }) => {
          if (requestId !== model.requestId || model.pendingCommand !== "Create")
            return [model, []];
          const query = listQuery(model.draft);
          if (query === null) return [model, []];
          const listRequestId = model.requestId + 1;
          return [
            {
              ...model,
              requestId: listRequestId,
              pendingCommand: null,
              failure: null,
              success: true,
              // The create response never changes rendered rows. Only LoadedList may do that.
              list: { _tag: "Loading" },
            },
            [commands.LoadList({ requestId: listRequestId, query })],
          ];
        },
        FailedCreate: ({ requestId, failure }) =>
          requestId !== model.requestId || model.pendingCommand !== "Create"
            ? [model, []]
            : [
                {
                  ...model,
                  pendingCommand: null,
                  failure,
                  success: false,
                },
                [],
              ],
        DismissedFailure: () => [{ ...model, failure: null }, []],
      }),
    );

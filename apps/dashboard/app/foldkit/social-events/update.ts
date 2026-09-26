import { Predicate } from "effect";
import { Schema as S, Match as M } from "effect";
import { Update } from "foldkit";
import { SocialEventsCreateCommand, type SocialEventsListInput } from "./bridge";
import type { SocialEventsCommandFactories } from "./command";
import type { Message } from "./message";
import { type Model, type SocialEventDraft, SocialEventsFailure, ListState, ScopeState } from "./model";

export type UpdateResult = Update.Return<Model, Message>;

const invalidDraftFailure: SocialEventsFailure = SocialEventsFailure.cases.Failed.make({
  tag: "InvalidDraft",
  message: "Fyll ut avdeling, semester, tittel og gyldige start- og sluttidspunkt.",
});

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
    return S.decodeSync(SocialEventsCreateCommand)(
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
  (Predicate.isTagged(model.scope, "Success") &&
    model.scope.data.departments.some((department) => department.departmentId === departmentId));

const isKnownSemester = (model: Model, semesterId: string | null): boolean =>
  semesterId === null ||
  (Predicate.isTagged(model.scope, "Success") &&
    model.scope.data.semesters.some((semester) => semester.semesterId === semesterId));

const loadSelectedList = (
  model: Model,
  commands: SocialEventsCommandFactories,
  draft: SocialEventDraft = model.draft,
): UpdateResult => {
  const query = listQuery(draft);

  if (query === null) return ({ model: { ...model, draft, list: ListState.cases.Idle.make({}) }, commands: [] });
  const requestId = model.requestId + 1;

  return ({ model: 
    { ...model, draft, requestId, list: ListState.cases.Loading.make({}) }, commands: [commands.LoadList({ requestId, query })] });
};

export const updateFor =
  (commands: SocialEventsCommandFactories) =>
  (model: Model, message: Message): UpdateResult =>
    M.value(message).pipe(
      M.withReturnType<UpdateResult>(),
      M.tagsExhaustive({
        LoadedScope: ({ requestId, scope }) => {
          if (requestId !== model.requestId) return ({ model: model, commands: [] });

          const draft: SocialEventDraft = {
            ...model.draft,
            departmentId: scope.departments[0]?.departmentId ?? null,
            semesterId: scope.semesters[0]?.semesterId ?? null,
          };

          const query = listQuery(draft);

          if (query === null) {
            return ({ model: 
              {
                ...model,
                scope: ScopeState.cases.Success.make({ data: scope }),
                draft,
                list: ListState.cases.Idle.make({}),
                failure: null,
              }, commands: [] });
          }

          const listRequestId = model.requestId + 1;

          return ({ model: 
            {
              ...model,
              scope: ScopeState.cases.Success.make({ data: scope }),
              draft,
              list: ListState.cases.Loading.make({}),
              requestId: listRequestId,
              failure: null,
            }, commands: [commands.LoadList({ requestId: listRequestId, query })] });
        },
        FailedScope: ({ requestId, failure }) =>
          requestId !== model.requestId
            ? ({ model: model, commands: [] })
            : ({ model: 
                { ...model, scope: ScopeState.cases.Failure.make({ error: failure }), list: ListState.cases.Idle.make({}) }, commands: [] }),
        RetriedScope: () => {
          if (model.pendingCommand !== null) return ({ model: model, commands: [] });
          const requestId = model.requestId + 1;

          return ({ model: 
            {
              ...model,
              scope: ScopeState.cases.Loading.make({}),
              list: ListState.cases.Idle.make({}),
              requestId,
              failure: null,
              success: false,
            }, commands: [commands.LoadScope({ requestId })] });
        },
        SelectedDepartment: ({ departmentId }) => {
          if (model.pendingCommand !== null || !isKnownDepartment(model, departmentId)) {
            return ({ model: model, commands: [] });
          }

          if (departmentId === model.draft.departmentId) return ({ model: model, commands: [] });
          const draft = { ...model.draft, departmentId };
          const { model: next, commands: emitted = [] } = loadSelectedList(model, commands, draft);

          return ({ model: { ...next, failure: null, success: false }, commands: emitted });
        },
        SelectedSemester: ({ semesterId }) => {
          if (model.pendingCommand !== null || !isKnownSemester(model, semesterId))
            return ({ model: model, commands: [] });

          if (semesterId === model.draft.semesterId) return ({ model: model, commands: [] });
          const draft = { ...model.draft, semesterId };
          const { model: next, commands: emitted = [] } = loadSelectedList(model, commands, draft);

          return ({ model: { ...next, failure: null, success: false }, commands: emitted });
        },
        SelectedAudience: ({ audience }) =>
          model.pendingCommand !== null
            ? ({ model: model, commands: [] })
            : ({ model: 
                { ...model, draft: { ...model.draft, audience }, failure: null, success: false }, commands: [] }),
        ChangedTitle: ({ value }) =>
          model.pendingCommand !== null
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  draft: { ...model.draft, title: value },
                  failure: null,
                  success: false,
                }, commands: [] }),
        ChangedDescription: ({ value }) =>
          model.pendingCommand !== null
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  draft: { ...model.draft, description: value },
                  failure: null,
                  success: false,
                }, commands: [] }),
        ChangedLink: ({ value }) =>
          model.pendingCommand !== null
            ? ({ model: model, commands: [] })
            : ({ model: 
                { ...model, draft: { ...model.draft, link: value }, failure: null, success: false }, commands: [] }),
        ChangedStartAt: ({ value }) =>
          model.pendingCommand !== null
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  draft: { ...model.draft, startAt: value },
                  failure: null,
                  success: false,
                }, commands: [] }),
        ChangedEndAt: ({ value }) =>
          model.pendingCommand !== null
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  draft: { ...model.draft, endAt: value },
                  failure: null,
                  success: false,
                }, commands: [] }),
        LoadedList: ({ requestId, list }) =>
          requestId !== model.requestId
            ? ({ model: model, commands: [] })
            : ({ model: { ...model, list: ListState.cases.Success.make({ data: list }) }, commands: [] }),
        FailedList: ({ requestId, failure }) =>
          requestId !== model.requestId
            ? ({ model: model, commands: [] })
            : ({ model: { ...model, list: ListState.cases.Failure.make({ error: failure }) }, commands: [] }),
        RetriedList: () => {
          if (model.pendingCommand !== null) return ({ model: model, commands: [] });
          const query = listQuery(model.draft);

          if (query === null) return ({ model: model, commands: [] });
          const requestId = model.requestId + 1;

          return ({ model: 
            { ...model, requestId, list: ListState.cases.Loading.make({}) }, commands: [commands.LoadList({ requestId, query })] });
        },
        SubmittedCreate: ({ commandId }) => {
          if (
            model.pendingCommand !== null ||
            Predicate.isTagged(model.list, "Idle") ||
            Predicate.isTagged(model.list, "Loading")
          ) {
            return ({ model: model, commands: [] });
          }

          const command = createCommand(model.draft, commandId);

          if (command === null) {
            return ({ model: { ...model, failure: invalidDraftFailure, success: false }, commands: [] });
          }

          const requestId = model.requestId + 1;

          return ({ model: 
            {
              ...model,
              requestId,
              commandSequence: model.commandSequence + 1,
              pendingCommand: "Create",
              failure: null,
              success: false,
            }, commands: [commands.Create({ requestId, command })] });
        },
        SucceededCreate: ({ requestId }) => {
          if (requestId !== model.requestId || model.pendingCommand !== "Create")
            return ({ model: model, commands: [] });
          const query = listQuery(model.draft);

          if (query === null) return ({ model: model, commands: [] });
          const listRequestId = model.requestId + 1;

          return ({ model: 
            {
              ...model,
              requestId: listRequestId,
              pendingCommand: null,
              failure: null,
              success: true,
              // The create response never changes rendered rows. Only LoadedList may do that.
              list: ListState.cases.Loading.make({}),
            }, commands: [commands.LoadList({ requestId: listRequestId, query })] });
        },
        FailedCreate: ({ requestId, failure }) =>
          requestId !== model.requestId || model.pendingCommand !== "Create"
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  pendingCommand: null,
                  failure,
                  success: false,
                }, commands: [] }),
        DismissedFailure: () => ({ model: { ...model, failure: null }, commands: [] }),
      }),
    );

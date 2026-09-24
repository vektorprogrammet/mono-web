import { Schema as S } from "effect";
import {
  CreateSocialEventRequest,
  SocialEventAudience,
  SocialEventListResource,
  SocialEventScopeResource,
} from "./bridge";

export const SocialEventsRequestId = S.Int.check(S.isGreaterThanOrEqualTo(1));

export const SocialEventsFailureTag = S.Literals([
  "UnauthenticatedActor",
  "NotInScope",
  "InvalidScope",
  "ValidationFailed",
  "CommandConflict",
  "SocialEventsDecodeError",
  "SocialEventsPersistenceError",
  "Network",
  "Configuration",
  "InvalidDraft",
]);

export type SocialEventsFailureTag = S.Schema.Type<typeof SocialEventsFailureTag>;

export const SocialEventsFailure = S.TaggedUnion({
  Denied: {
    tag: S.Literals(["UnauthenticatedActor", "NotInScope"]),
    message: S.String,
  },
  Failed: {
    tag: S.Literals([
      "InvalidScope",
      "ValidationFailed",
      "CommandConflict",
      "SocialEventsDecodeError",
      "SocialEventsPersistenceError",
      "Network",
      "Configuration",
      "InvalidDraft",
    ]),
    message: S.String,
  },
});

export type SocialEventsFailure = S.Schema.Type<typeof SocialEventsFailure>;

export const SocialEventDraft = S.Struct({
  departmentId: S.NullOr(CreateSocialEventRequest.fields.departmentId),
  semesterId: S.NullOr(CreateSocialEventRequest.fields.semesterId),
  audience: SocialEventAudience,
  title: S.String,
  description: S.String,
  link: S.String,
  startAt: S.String,
  endAt: S.String,
});

export type SocialEventDraft = S.Schema.Type<typeof SocialEventDraft>;

export const ScopeState = S.TaggedUnion({
  Idle: {},
  Loading: {},
  Success: { data: SocialEventScopeResource },
  Failure: { error: SocialEventsFailure },
});

export type ScopeState = S.Schema.Type<typeof ScopeState>;

export const ListState = S.TaggedUnion({
  Idle: {},
  Loading: {},
  Success: { data: SocialEventListResource },
  Failure: { error: SocialEventsFailure },
});

export type ListState = S.Schema.Type<typeof ListState>;

export const Model = S.Struct({
  scope: ScopeState,
  list: ListState,
  draft: SocialEventDraft,
  requestId: SocialEventsRequestId,
  commandSequence: S.Int.check(S.isGreaterThanOrEqualTo(1)),
  commandSeed: S.String,
  pendingCommand: S.NullOr(S.Literal("Create")),
  failure: S.NullOr(SocialEventsFailure),
  success: S.Boolean,
});

export type Model = S.Schema.Type<typeof Model>;


export const emptyDraft = (): SocialEventDraft => ({
  departmentId: null,
  semesterId: null,
  audience: "TeamMembers",
  title: "",
  description: "",
  link: "",
  startAt: "",
  endAt: "",
});

export const init = (): Model => ({
  scope: ScopeState.cases.Loading.make({}),
  list: ListState.cases.Idle.make({}),
  draft: emptyDraft(),
  requestId: 1,
  commandSequence: 1,
  commandSeed: globalThis.crypto.randomUUID().replaceAll("-", ""),
  pendingCommand: null,
  failure: null,
  success: false,
});

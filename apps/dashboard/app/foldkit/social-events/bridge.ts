import {
  CreateSocialEventRequest,
  SocialEventAudience,
  SocialEventListResource,
  SocialEventResource,
  SocialEventScopeResource,
} from "@vektorprogrammet/domain/social-events";
import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { Schema as S } from "effect";

export {
  CreateSocialEventRequest,
  SocialEventAudience,
  SocialEventListResource,
  SocialEventResource,
  SocialEventScopeResource,
};

export const SocialEventsBridgeErrorTag = S.Literals([
  "UnauthenticatedActor",
  "NotInScope",
  "InvalidScope",
  "ValidationFailed",
  "CommandConflict",
  "SocialEventsDecodeError",
  "SocialEventsPersistenceError",
  "Network",
  "Configuration",
]);
export type SocialEventsBridgeErrorTag = S.Schema.Type<typeof SocialEventsBridgeErrorTag>;

export const SocialEventsBridgeFailure = S.Struct({
  error: S.Struct({ tag: SocialEventsBridgeErrorTag }),
});
export type SocialEventsBridgeFailure = S.Schema.Type<typeof SocialEventsBridgeFailure>;

export const socialEventsBridgeFailure = (
  tag: SocialEventsBridgeErrorTag,
): SocialEventsBridgeFailure => ({ error: { tag } });

export const SocialEventsListInput = S.Struct({
  departmentId: CreateSocialEventRequest.fields.departmentId,
  semesterId: CreateSocialEventRequest.fields.semesterId,
});
export type SocialEventsListInput = S.Schema.Type<typeof SocialEventsListInput>;

export const SocialEventsCreateCommand = S.Struct({
  commandId: IdempotencyKey,
  ...CreateSocialEventRequest.fields,
});
export type SocialEventsCreateCommand = S.Schema.Type<typeof SocialEventsCreateCommand>;

const ListOperation = S.Struct({ operation: S.Literal("list"), query: SocialEventsListInput });
const CreateOperation = S.Struct({
  operation: S.Literal("create"),
  ...SocialEventsCreateCommand.fields,
});

export const SocialEventsBridgeOperation = S.Union([ListOperation, CreateOperation]);
export type SocialEventsBridgeOperation = S.Schema.Type<typeof SocialEventsBridgeOperation>;
export const SocialEventsBridgeOperationJson = S.fromJsonString(SocialEventsBridgeOperation);

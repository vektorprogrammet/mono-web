import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { Schema as S } from "effect";
import { taggedStruct } from "foldkit/schema";
import {
  CreateSocialEventRequest,
  SocialEventAudience,
  SocialEventListResource,
  SocialEventScopeResource,
} from "./bridge";
import { SocialEventsFailure, SocialEventsRequestId } from "./model";

export const LoadedScope = taggedStruct("LoadedScope", {
  requestId: SocialEventsRequestId,
  scope: SocialEventScopeResource,
});

export const FailedScope = taggedStruct("FailedScope", {
  requestId: SocialEventsRequestId,
  failure: SocialEventsFailure,
});

export const RetriedScope = taggedStruct("RetriedScope", {});

export const SelectedDepartment = taggedStruct("SelectedDepartment", {
  departmentId: S.NullOr(CreateSocialEventRequest.fields.departmentId),
});

export const SelectedSemester = taggedStruct("SelectedSemester", {
  semesterId: S.NullOr(CreateSocialEventRequest.fields.semesterId),
});

export const SelectedAudience = taggedStruct("SelectedAudience", { audience: SocialEventAudience });

export const ChangedTitle = taggedStruct("ChangedTitle", { value: S.String });

export const ChangedDescription = taggedStruct("ChangedDescription", { value: S.String });

export const ChangedLink = taggedStruct("ChangedLink", { value: S.String });

export const ChangedStartAt = taggedStruct("ChangedStartAt", { value: S.String });

export const ChangedEndAt = taggedStruct("ChangedEndAt", { value: S.String });

export const LoadedList = taggedStruct("LoadedList", {
  requestId: SocialEventsRequestId,
  list: SocialEventListResource,
});

export const FailedList = taggedStruct("FailedList", {
  requestId: SocialEventsRequestId,
  failure: SocialEventsFailure,
});

export const RetriedList = taggedStruct("RetriedList", {});

export const SubmittedCreate = taggedStruct("SubmittedCreate", { commandId: IdempotencyKey });

export const SucceededCreate = taggedStruct("SucceededCreate", {
  requestId: SocialEventsRequestId,
});

export const FailedCreate = taggedStruct("FailedCreate", {
  requestId: SocialEventsRequestId,
  failure: SocialEventsFailure,
});

export const DismissedFailure = taggedStruct("DismissedFailure", {});

export const Message = S.Union([
  LoadedScope,
  FailedScope,
  RetriedScope,
  SelectedDepartment,
  SelectedSemester,
  SelectedAudience,
  ChangedTitle,
  ChangedDescription,
  ChangedLink,
  ChangedStartAt,
  ChangedEndAt,
  LoadedList,
  FailedList,
  RetriedList,
  SubmittedCreate,
  SucceededCreate,
  FailedCreate,
  DismissedFailure,
]);

export type Message = S.Schema.Type<typeof Message>;

import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { Schema as S } from "effect";
import { m } from "foldkit/message";
import {
  CreateSocialEventRequest,
  SocialEventAudience,
  SocialEventListResource,
  SocialEventScopeResource,
} from "./bridge";
import { SocialEventsFailure, SocialEventsRequestId } from "./model";

export const LoadedScope = m("LoadedScope", {
  requestId: SocialEventsRequestId,
  scope: SocialEventScopeResource,
});
export const FailedScope = m("FailedScope", {
  requestId: SocialEventsRequestId,
  failure: SocialEventsFailure,
});
export const RetriedScope = m("RetriedScope");

export const SelectedDepartment = m("SelectedDepartment", {
  departmentId: S.NullOr(CreateSocialEventRequest.fields.departmentId),
});
export const SelectedSemester = m("SelectedSemester", {
  semesterId: S.NullOr(CreateSocialEventRequest.fields.semesterId),
});
export const SelectedAudience = m("SelectedAudience", { audience: SocialEventAudience });
export const ChangedTitle = m("ChangedTitle", { value: S.String });
export const ChangedDescription = m("ChangedDescription", { value: S.String });
export const ChangedLink = m("ChangedLink", { value: S.String });
export const ChangedStartAt = m("ChangedStartAt", { value: S.String });
export const ChangedEndAt = m("ChangedEndAt", { value: S.String });

export const LoadedList = m("LoadedList", {
  requestId: SocialEventsRequestId,
  list: SocialEventListResource,
});
export const FailedList = m("FailedList", {
  requestId: SocialEventsRequestId,
  failure: SocialEventsFailure,
});
export const RetriedList = m("RetriedList");

export const SubmittedCreate = m("SubmittedCreate", { commandId: IdempotencyKey });
export const SucceededCreate = m("SucceededCreate", {
  requestId: SocialEventsRequestId,
});
export const FailedCreate = m("FailedCreate", {
  requestId: SocialEventsRequestId,
  failure: SocialEventsFailure,
});
export const DismissedFailure = m("DismissedFailure");

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

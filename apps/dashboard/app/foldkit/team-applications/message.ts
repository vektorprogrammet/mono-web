import { Dialog } from "@foldkit/ui";
import {
  TeamApplicationId,
  TeamApplicationIntakeResource,
  TeamApplicationListResponse,
  TeamApplicationResource,
} from "@vektorprogrammet/http-api";
import { Schema as S } from "effect";
import { taggedStruct } from "foldkit/schema";
import { MutationFailure, ReadFailure, RequestId } from "./model";

export const RequestedFirstPage = taggedStruct("RequestedFirstPage", {});

export const RequestedNextPage = taggedStruct("RequestedNextPage", {});

export const RetriedPage = taggedStruct("RetriedPage", {});

export const SucceededLoadPage = taggedStruct("SucceededLoadPage", {
  requestId: RequestId,
  page: TeamApplicationListResponse,
});

export const FailedLoadPage = taggedStruct("FailedLoadPage", {
  requestId: RequestId,
  failure: ReadFailure,
});

export const OpenedApplication = taggedStruct("OpenedApplication", {
  applicationId: TeamApplicationId,
});

export const ClosedApplication = taggedStruct("ClosedApplication", {});

export const SucceededReadApplication = taggedStruct("SucceededReadApplication", {
  requestId: RequestId,
  application: TeamApplicationResource,
});

export const FailedReadApplication = taggedStruct("FailedReadApplication", {
  requestId: RequestId,
  failure: ReadFailure,
});

export const RequestedDelete = taggedStruct("RequestedDelete", {});

export const ConfirmedDelete = taggedStruct("ConfirmedDelete", {});

export const CancelledDelete = taggedStruct("CancelledDelete", {});

export const GotDeleteDialogMessage = taggedStruct("GotDeleteDialogMessage", {
  message: Dialog.Message,
});

export const SucceededDelete = taggedStruct("SucceededDelete", { requestId: RequestId });

export const FailedDelete = taggedStruct("FailedDelete", {
  requestId: RequestId,
  failure: MutationFailure,
});

export const ToggledAcceptApplication = taggedStruct("ToggledAcceptApplication", {
  isChecked: S.Boolean,
});

export const ChangedDeadline = taggedStruct("ChangedDeadline", { value: S.String });

export const ClearedDeadline = taggedStruct("ClearedDeadline", {});

export const SubmittedIntake = taggedStruct("SubmittedIntake", {});

export const SucceededReviseIntake = taggedStruct("SucceededReviseIntake", {
  requestId: RequestId,
  intake: TeamApplicationIntakeResource,
});

export const FailedReviseIntake = taggedStruct("FailedReviseIntake", {
  requestId: RequestId,
  failure: MutationFailure,
});

export const CompletedFocus = taggedStruct("CompletedFocus", {});

export const Message = S.Union([
  RequestedFirstPage,
  RequestedNextPage,
  RetriedPage,
  SucceededLoadPage,
  FailedLoadPage,
  OpenedApplication,
  ClosedApplication,
  SucceededReadApplication,
  FailedReadApplication,
  RequestedDelete,
  ConfirmedDelete,
  CancelledDelete,
  GotDeleteDialogMessage,
  SucceededDelete,
  FailedDelete,
  ToggledAcceptApplication,
  ChangedDeadline,
  ClearedDeadline,
  SubmittedIntake,
  SucceededReviseIntake,
  FailedReviseIntake,
  CompletedFocus,
]);

export type Message = S.Schema.Type<typeof Message>;

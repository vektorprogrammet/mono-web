import { Schema as S } from "effect";
import { m } from "foldkit/message";

export const ChangedScheduleDate = m("ChangedScheduleDate", { value: S.String });
export const ChangedStartTime = m("ChangedStartTime", { value: S.String });
export const ChangedEndTime = m("ChangedEndTime", { value: S.String });
export const SelectedDecision = m("SelectedDecision", {
  value: S.Literals(["CompleteService", "CancelService", "MarkUnfulfilledService"]),
});
export const ChangedEvidenceSource = m("ChangedEvidenceSource", { value: S.String });
export const ChangedReason = m("ChangedReason", { value: S.String });
export const ToggledAttendee = m("ToggledAttendee", { personId: S.String });
export const SelectedCommitment = m("SelectedCommitment", { commitmentId: S.String });
export const Message = S.Union([
  ChangedScheduleDate,
  ChangedStartTime,
  ChangedEndTime,
  SelectedDecision,
  ChangedEvidenceSource,
  ChangedReason,
  ToggledAttendee,
  SelectedCommitment,
]);
export type Message = S.Schema.Type<typeof Message>;

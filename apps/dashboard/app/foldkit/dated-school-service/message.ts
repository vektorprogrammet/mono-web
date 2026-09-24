import { Schema as S } from "effect";
import { taggedStruct } from "foldkit/schema";

export const ChangedScheduleDate = taggedStruct("ChangedScheduleDate", { value: S.String });

export const ChangedStartTime = taggedStruct("ChangedStartTime", { value: S.String });

export const ChangedEndTime = taggedStruct("ChangedEndTime", { value: S.String });

export const SelectedDecision = taggedStruct("SelectedDecision", {
  value: S.Literals(["CompleteService", "CancelService", "MarkUnfulfilledService"]),
});

export const ChangedEvidenceSource = taggedStruct("ChangedEvidenceSource", { value: S.String });

export const ChangedReason = taggedStruct("ChangedReason", { value: S.String });

export const ToggledAttendee = taggedStruct("ToggledAttendee", { personId: S.String });

export const SelectedCommitment = taggedStruct("SelectedCommitment", { commitmentId: S.String });

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

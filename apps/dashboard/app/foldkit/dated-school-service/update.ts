import { Update } from "foldkit";
import { Match } from "effect";
import type { Message } from "./message";
import type { Model } from "./model";

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Match.value(message).pipe(
    Match.withReturnType<Update.Return<Model, Message>>(),
    Match.tagsExhaustive({
      ChangedScheduleDate: ({ value }) => ({ model: { ...model, scheduleDate: value }, commands: [] }),
      ChangedStartTime: ({ value }) => ({ model: { ...model, startTime: value }, commands: [] }),
      ChangedEndTime: ({ value }) => ({ model: { ...model, endTime: value }, commands: [] }),
      SelectedDecision: ({ value }) => ({ model: { ...model, decision: value, attendedPersonIds: [], reason: "", evidenceSource: "" }, commands: [] }),
      ChangedEvidenceSource: ({ value }) => ({ model: { ...model, evidenceSource: value }, commands: [] }),
      ChangedReason: ({ value }) => ({ model: { ...model, reason: value }, commands: [] }),
      SelectedCommitment: ({ commitmentId }) => ({ model: 
        { ...model, selectedCommitmentId: commitmentId, decision: "CompleteService", attendedPersonIds: [], evidenceSource: "", reason: "" }, commands: [] }),
      ToggledAttendee: ({ personId }) => ({ model: 
        {
          ...model,
          attendedPersonIds: model.attendedPersonIds.includes(personId)
            ? model.attendedPersonIds.filter((id) => id !== personId)
            : [...model.attendedPersonIds, personId],
        }, commands: [] }),
    }),
  );

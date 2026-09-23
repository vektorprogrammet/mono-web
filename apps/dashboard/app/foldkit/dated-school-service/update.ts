import { Match } from "effect";
import type { Message } from "./message";
import type { Model } from "./model";

export const update = (model: Model, message: Message): readonly [Model, readonly []] =>
  Match.value(message).pipe(
    Match.withReturnType<readonly [Model, readonly []]>(),
    Match.tagsExhaustive({
      ChangedScheduleDate: ({ value }) => [{ ...model, scheduleDate: value }, []],
      ChangedStartTime: ({ value }) => [{ ...model, startTime: value }, []],
      ChangedEndTime: ({ value }) => [{ ...model, endTime: value }, []],
      SelectedDecision: ({ value }) => [{ ...model, decision: value, attendedPersonIds: [], reason: "", evidenceSource: "" }, []],
      ChangedEvidenceSource: ({ value }) => [{ ...model, evidenceSource: value }, []],
      ChangedReason: ({ value }) => [{ ...model, reason: value }, []],
      SelectedCommitment: ({ commitmentId }) => [
        { ...model, selectedCommitmentId: commitmentId, decision: "CompleteService", attendedPersonIds: [], evidenceSource: "", reason: "" },
        [],
      ],
      ToggledAttendee: ({ personId }) => [
        {
          ...model,
          attendedPersonIds: model.attendedPersonIds.includes(personId)
            ? model.attendedPersonIds.filter((id) => id !== personId)
            : [...model.attendedPersonIds, personId],
        },
        [],
      ],
    }),
  );

import type { TeamApplicationIntakeMergePatch } from "@vektorprogrammet/http-api";
import { Data, Option, type Types } from "effect";
import type { IntakeDraft, TeamApplicationIntake } from "./model";
import { instantFromOsloDateTimeLocal, osloDateTimeLocalFromInstant } from "./oslo-time";

export const draftFromIntake = (intake: TeamApplicationIntake): IntakeDraft => ({
  basedOnEtag: intake.etag,
  acceptApplication: intake.acceptApplication,
  deadline: intake.deadline === null ? "" : osloDateTimeLocalFromInstant(intake.deadline),
});

export type IntakePatchResult = Data.TaggedEnum<{
  Patch: { readonly patch: TeamApplicationIntakeMergePatch };
  NoChange: {};
  InvalidDeadline: {};
}>;

export const IntakePatchResult = Data.taggedEnum<IntakePatchResult>();

/**
 * Builds a merge patch with only the settings the leader changed. An absent key keeps the
 * stored value, so an untouched deadline keeps its full stored precision.
 */
export const intakePatchFrom = (
  intake: TeamApplicationIntake,
  draft: IntakeDraft,
): IntakePatchResult => {
  const observed = draftFromIntake(intake);
  const patch: Types.Mutable<TeamApplicationIntakeMergePatch> = {};

  if (draft.acceptApplication !== observed.acceptApplication) {
    patch.acceptApplication = draft.acceptApplication;
  }

  if (draft.deadline !== observed.deadline) {
    const deadline =
      draft.deadline === "" ? Option.some(null) : instantFromOsloDateTimeLocal(draft.deadline);

    if (Option.isNone(deadline)) return IntakePatchResult.InvalidDeadline();
    patch.deadline = deadline.value;
  }

  return Object.keys(patch).length === 0
    ? IntakePatchResult.NoChange()
    : IntakePatchResult.Patch({ patch });
};

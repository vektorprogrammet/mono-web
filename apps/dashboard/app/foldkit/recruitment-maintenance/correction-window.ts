import type { AssessmentCorrection } from "@vektorprogrammet/domain/recruitment";
import { DateTime, Match } from "effect";

/** Server observation only: this presentation never reads time or grants permission. */
export const correctionWindowDescription = (observation: AssessmentCorrection): string =>
  Match.value(observation).pipe(
    Match.tag("Ordinary", () => "Ordinær retting før opptaksbeslutningen er lukket."),
    Match.tag(
      "Closed",
      () =>
        "Ordinær retting er lukket. Et avgrenset rettingsvindu må åpnes før vurderingen kan rettes.",
    ),
    Match.tag(
      "Open",
      (window) =>
        `Rettingsvindu åpnet av ${window.openedBy}. Slutter ${DateTime.formatIso(window.endsAt)}. Den som åpnet vinduet, kan ikke rette under sitt eget vindu.`,
    ),
    Match.tag(
      "Expired",
      (window) =>
        `Rettingsvinduet åpnet av ${window.openedBy} utløp ${DateTime.formatIso(window.endsAt)}. Det er allerede stengt for retting og kan ikke lukkes manuelt.`,
    ),
    Match.exhaustive,
  );

type CorrectionReopenTarget = Readonly<{ id: string; selector: string }>;

/** Derives the Reopen button's stable id and eligible focus selector from its interview.
 * @construct ui-target
 * @remarks The view and Command share this identity; disabled controls never match the selector.
 * @sideEffects None. This is a pure projection of a decoded interview identity.
 * @example
 * const target = correctionReopenTarget("interview-42");
 * // Render target.id, then use target.selector in the native workflow focus Command.
 * @avoid Do not reuse the Close button's node or infer server eligibility from this identity.
 */
export const correctionReopenTarget = (
  interviewId: string,
): CorrectionReopenTarget => {
  let id = "rm-correction-reopen";

  for (let index = 0; index < interviewId.length; index++) {
    id += "-" + interviewId.charCodeAt(index).toString(16);
  }

  return { id, selector: `[id="${id}"]:not([disabled])` };
};

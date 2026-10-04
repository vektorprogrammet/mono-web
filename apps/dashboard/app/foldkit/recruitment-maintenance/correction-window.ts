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

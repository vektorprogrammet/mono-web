import { DateTime, Match } from "effect";
import type { Instant } from "../time.js";
import type { ApplicationAdmissionEvidence } from "./evidence.js";
import type { AdmissionOutcome } from "./outcome.js";

/**
 * Admission standing of the application's own period and semester at one instant.
 *
 * @remarks
 * Both windows are half-open. Closed decisions use frozen evidence, including preserved
 * historical outcomes whose assessment provenance is unavailable. Before closure a new
 * applicant needs completed, uncancelled conduct: Ja/Nei take precedence and Kanskje needs
 * an explicit decision. Returning registration still needs its explicit decision. Neither
 * an account link nor an announcement is a prerequisite for standing.
 *
 * @sideEffects None: consumes decoded evidence and does not read the clock or storage.
 * @example
 * ```ts
 * const admitted = admissionStanding(evidence, at) === "Admitted";
 * ```
 * @avoid Using a department's other period, cached preflight time, or live assessments after closure.
 * @construct policy
 */
export const admissionStanding = (
  /** Decoded canonical evidence, frozen at decision closure. */
  evidence: ApplicationAdmissionEvidence,
  /** The committing command instant, obtained after its fences and lock waits. */
  at: Instant,
): /** Effective admitted/rejected standing, or null without current eligibility. */ AdmissionOutcome | null => {
  const milliseconds = DateTime.toEpochMillis(at);

  if (
    milliseconds < DateTime.toEpochMillis(evidence.periodOpensAt) ||
    milliseconds >= DateTime.toEpochMillis(evidence.periodClosesAt) ||
    milliseconds < DateTime.toEpochMillis(evidence.semesterStartsAt) ||
    milliseconds >= DateTime.toEpochMillis(evidence.semesterEndsAt)
  )
    return null;

  if (evidence.decisionClosed) return evidence.outcome;

  return Match.value(evidence.basis).pipe(
    Match.when("Returning", () => (evidence.returningRegistered ? evidence.outcome : null)),
    Match.when("Unreviewed", () => null),
    Match.orElse(() =>
      evidence.interviewCompleted && !evidence.interviewCancelled ? evidence.outcome : null,
    ),
  );
};

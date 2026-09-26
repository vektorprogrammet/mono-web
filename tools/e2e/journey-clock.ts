/**
 * Fixture instants relative to the clock that the backend reads.
 *
 * The backend compares admission periods, semesters, claim expiries, and interview schedules with
 * its clock. A fixture that writes one of them as a literal instant expires: the journey passes
 * until the real clock passes the instant and then fails. The journey seeds hard-coded an
 * admission period that ended on 2026-09-30, so every journey that used them would have failed
 * from 2026-10-01.
 *
 * Seeds, drivers, and specs derive those instants from a journey clock instead.
 * `admissionJourneyClock` reads the backend's admission clock: ADMISSION_FIXED_NOW when the runner
 * pins one, otherwise the current time. `journeyClock` takes an instant that the caller pins
 * itself, such as a runner's fixed clock. The Oxlint rule `anti-slop/no-literal-window-instant`
 * rejects literal window bounds and accepts a literal instant as the argument of `journeyClock`.
 *
 * The module has no dependencies, so Node and Bun runners can both import it.
 */

/** Instants relative to one reference instant. */
export interface JourneyClock {
  /** The reference instant, in the form that `Date#toISOString` writes. */
  readonly now: string;
  /** The instant `days` days and `minutes` minutes after the reference; negative offsets lie before it. */
  readonly fromNow: (days: number, minutes?: number) => string;
}

/**
 * A journey clock at a reference instant that the caller pins.
 *
 * @construct test-harness
 */
export const journeyClock = (reference: string): JourneyClock => {
  const referenceTime = Date.parse(reference);

  if (!Number.isFinite(referenceTime)) {
    throw new Error(`A journey clock reference must be an RFC 3339 instant: ${reference}`);
  }

  return {
    now: new Date(referenceTime).toISOString(),
    fromNow: (days, minutes = 0) =>
      new Date(referenceTime + days * 86_400_000 + minutes * 60_000).toISOString(),
  };
};

/**
 * The backend's admission clock: ADMISSION_FIXED_NOW when the runner pins one, otherwise the
 * current time.
 *
 * @construct test-harness
 */
export const admissionJourneyClock = (): JourneyClock => {
  const fixedNow = process.env.ADMISSION_FIXED_NOW;

  if (fixedNow !== undefined && !Number.isFinite(Date.parse(fixedNow))) {
    throw new Error("ADMISSION_FIXED_NOW must be an RFC 3339 instant");
  }

  return journeyClock(fixedNow ?? new Date().toISOString());
};

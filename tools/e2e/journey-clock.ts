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
 * @remarks
 * `now` is the reference in the form that `Date#toISOString` writes, and `fromNow(days, minutes)`
 * adds whole days and minutes to it, or subtracts them for negative offsets. Seeds, drivers, and
 * specs that take their instants from one clock agree with each other on any date.
 *
 * @throws An `Error` when `reference` is not an instant that `Date.parse` reads.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * const clock = journeyClock("2031-09-15T12:00:00.000Z");
 * ```
 *
 * @avoid Writing a window bound, such as the end of an admission period, as a literal instant:
 * the journey fails once the real clock passes it, and `anti-slop/no-literal-window-instant`
 * rejects it. Derive the bound with `clock.fromNow(days)`.
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
 * @remarks
 * It reads `ADMISSION_FIXED_NOW` at each call, the variable that the backend's admission clock
 * reads, and gives a `journeyClock` at that instant, or at the current time when it is unset. So
 * the fixture instants of a journey lie where the backend it starts sees them.
 *
 * @throws An `Error` when `ADMISSION_FIXED_NOW` is set to text that `Date.parse` does not read.
 *
 * @sideEffects Reads `ADMISSION_FIXED_NOW` from the environment, and the current time when it is
 * unset.
 *
 * @example
 * ```ts
 * const { fromNow: fromJourneyNow } = admissionJourneyClock();
 * ```
 *
 * @avoid Taking fixture instants from `new Date()` while the backend runs with
 * `ADMISSION_FIXED_NOW`: the seeded windows then lie outside the backend's time. Take them from
 * this clock whenever the backend reads the admission clock.
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

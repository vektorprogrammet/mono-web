import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { PersonId } from "../organization/schema.js";
import { SchoolId } from "../schools/schema.js";
import {
  assistantPage,
  calculatedDaysServed,
  DAYS_SERVED_PAGE_SIZE,
  daysServedEntryVersion,
  daysServedEvidence,
  decodeAssistantCursor,
  evidenceSchools,
} from "./days-served.js";

const alfa = { schoolId: SchoolId.make(1), name: "Alfa skole" };

const beta = { schoolId: SchoolId.make(2), name: "Beta skole" };

describe("days served", () => {
  it("counts one person, department, semester, and date once, whatever the blocks and schools", () => {
    const evidence = daysServedEvidence(
      [
        { serviceDate: "2026-09-07", school: alfa },
        { serviceDate: "2026-09-07", school: alfa },
        { serviceDate: "2026-09-07", school: beta },
        { serviceDate: "2026-09-14", school: beta },
      ],
      [],
    );

    expect(calculatedDaysServed(evidence)).toBe(2);
    expect(evidence.dates).toEqual([
      { serviceDate: "2026-09-07", schools: [alfa, beta] },
      { serviceDate: "2026-09-14", schools: [beta] },
    ]);
  });

  it("adds an accepted legacy total as a total and never as dates", () => {
    const evidence = daysServedEvidence(
      [{ serviceDate: "2026-09-07", school: alfa }],
      [{ school: beta, workdays: 6 }],
    );

    expect(calculatedDaysServed(evidence)).toBe(7);
    expect(evidence.dates.map((date) => date.serviceDate)).toEqual(["2026-09-07"]);
    expect(evidenceSchools(evidence)).toEqual([alfa, beta]);
  });

  it("calculates zero without evidence", () => {
    expect(calculatedDaysServed(daysServedEvidence([], []))).toBe(0);
  });

  it("changes the entry version with the revision and with the evidence", () => {
    const evidence = daysServedEvidence([{ serviceDate: "2026-09-07", school: alfa }], []);

    const more = daysServedEvidence(
      [
        { serviceDate: "2026-09-07", school: alfa },
        { serviceDate: "2026-09-08", school: alfa },
      ],
      [],
    );

    const version = daysServedEntryVersion({ revision: 1, evidence });

    expect(daysServedEntryVersion({ revision: 1, evidence })).toBe(version);
    expect(daysServedEntryVersion({ revision: 2, evidence })).not.toBe(version);
    expect(daysServedEntryVersion({ revision: 1, evidence: more })).not.toBe(version);
  });
});

describe("assistant pages", () => {
  const rows = Array.from({ length: DAYS_SERVED_PAGE_SIZE + 1 }, (_, index) => ({
    lastName: `Etternavn ${String(index).padStart(3, "0")}`,
    firstName: "Fornavn",
    personId: PersonId.make(`person-${index}`),
  }));

  it.effect("continues after the last kept row and rejects a forged cursor", () =>
    Effect.gen(function* () {
      const page = assistantPage(rows, (row) => row);

      expect(page.items).toHaveLength(DAYS_SERVED_PAGE_SIZE);
      expect(page.nextCursor).toBeDefined();
      expect(yield* decodeAssistantCursor(page.nextCursor ?? "")).toEqual(
        rows[DAYS_SERVED_PAGE_SIZE - 1],
      );
      expect(assistantPage(rows.slice(1), (row) => row).nextCursor).toBeUndefined();

      const forged = yield* Effect.exit(decodeAssistantCursor("bm90LWEtY3Vyc29y"));

      expect(Exit.isFailure(forged)).toBe(true);
    }),
  );
});

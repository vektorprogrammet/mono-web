import { describe, expect, it } from "@effect/vitest";
import { Effect, Random, Schema } from "effect";
import { Arbitrary } from "effect/unstable/arbitrary";
import { DepartmentId, PersonId, SemesterId } from "../organization/index.js";
import { SchoolId } from "../schools/index.js";
import {
  DraftBlock,
  buildPlacementDraft,
  draftPlacements,
  placementSupplyOf,
  type DraftSearch,
  type PlacementDraftInput,
} from "./scheduler.js";
import { TeachingBlock, TeachingDay } from "./schema.js";

const seeded = (seed: number | string): Random.Random =>
  Effect.runSync(
    Effect.gen(function* () {
      return yield* Random.Random;
    }).pipe(Random.withSeed(seed)),
  );

const bounded = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum, maximum }))));

const slot = Arbitrary.all({
  schoolId: Arbitrary.map(bounded(1, 3), SchoolId.make),
  day: Arbitrary.schema(TeachingDay),
  block: Arbitrary.schema(TeachingBlock),
  places: bounded(0, 3),
});

/** A non-empty weekday set, from a five-bit mask. */
const availableDays = Arbitrary.map(bounded(1, 31), (mask) =>
  TeachingDay.literals.filter((_, day) => (mask & (1 << day)) !== 0),
);

const assistant = Arbitrary.all({ days: availableDays, block: Arbitrary.schema(DraftBlock) });

const input = Arbitrary.map(
  Arbitrary.all({
    slots: Arbitrary.array(slot, { minLength: 4, maxLength: 24 }),
    assistants: Arbitrary.array(assistant, { minLength: 2, maxLength: 18 }),
  }),
  ({ slots, assistants }): PlacementDraftInput => ({
    slots,
    assistants: assistants.map((entry, index) => ({
      ...entry,
      personId: PersonId.make(`person-${String(index).padStart(2, "0")}`),
    })),
  }),
);

const seed = bounded(0, 1_000_000);

/** Small enough for hundreds of cases; the properties hold for every budget. */
const search: DraftSearch = { restarts: 3, iterations: 150, neighbours: 20 };

const greedy: DraftSearch = { restarts: 1, iterations: 0, neighbours: 1 };

const propertyOptions = { arbitrary: { seed: 26092026, runs: 200, size: 30 } } as const;

const halves = (block: string) => (block === "Both" ? ["1", "2"] : [block]);

const accepted: Record<typeof DraftBlock.Type, ReadonlyArray<string>> = {
  "1": ["1"],
  "2": ["2"],
  Either: ["1", "2"],
  Both: ["Both"],
};

describe("placement drafting", () => {
  it.prop(
    "never fills a school, weekday, and block beyond its places",
    { input, seed },
    ({ input, seed }) => {
      const plan = draftPlacements(input, seeded(seed), search);
      const places = new Map<string, number>();
      const used = new Map<string, number>();

      for (const entry of input.slots) {
        const key = `${entry.schoolId}:${entry.day}:${entry.block}`;
        places.set(key, (places.get(key) ?? 0) + entry.places);
      }

      for (const assignment of plan.assignments) {
        for (const block of halves(assignment.block)) {
          const key = `${assignment.schoolId}:${assignment.day}:${block}`;
          used.set(key, (used.get(key) ?? 0) + 1);
        }
      }

      for (const [key, count] of used) expect(count).toBeLessThanOrEqual(places.get(key) ?? 0);

      expect(plan.filledPlaces).toBe([...used.values()].reduce((sum, count) => sum + count, 0));
      expect(plan.filledPlaces).toBeLessThanOrEqual(plan.openPlaces);
    },
    propertyOptions,
  );

  it.prop(
    "places each assistant at most once, on an available weekday in an accepted block",
    { input, seed },
    ({ input, seed }) => {
      const plan = draftPlacements(input, seeded(seed), search);
      const byPerson = new Map(input.assistants.map((entry) => [entry.personId, entry]));

      for (const assignment of plan.assignments) {
        const entry = byPerson.get(assignment.personId);

        expect(entry?.days).toContain(assignment.day);
        // An assistant in both blocks is one assignment: both halves of one weekday and school.
        expect(accepted[entry?.block ?? "Both"]).toContain(assignment.block);
      }

      expect(
        [...plan.assignments.map((assignment) => assignment.personId), ...plan.unplaced].sort(),
      ).toEqual([...byPerson.keys()].sort());
    },
    propertyOptions,
  );

  it.prop(
    "gives the same draft for the same seed, whatever the input order",
    { input, seed },
    ({ input, seed }) => {
      const plan = draftPlacements(input, seeded(seed), search);

      expect(draftPlacements(input, seeded(seed), search)).toEqual(plan);
      expect(
        draftPlacements(
          { slots: [...input.slots].reverse(), assistants: [...input.assistants].reverse() },
          seeded(seed),
          search,
        ),
      ).toEqual(plan);
    },
    propertyOptions,
  );

  it.prop(
    "fills at least as many places as the greedy first fit",
    { input, seed },
    ({ input, seed }) => {
      const baseline = draftPlacements(input, seeded(seed), greedy).filledPlaces;

      expect(draftPlacements(input, seeded(seed), search).filledPlaces).toBeGreaterThanOrEqual(
        baseline,
      );
      // Restarts alone start from shuffled weekdays; the best run still keeps the baseline.
      expect(
        draftPlacements(input, seeded(seed), { ...greedy, restarts: 4 }).filledPlaces,
      ).toBeGreaterThanOrEqual(baseline);
    },
    propertyOptions,
  );

  it("moves an assistant with a choice so that an assistant without one fits", () => {
    const place = { schoolId: SchoolId.make(1), block: "1" as const, places: 1 };

    const choice: PlacementDraftInput = {
      slots: [
        { ...place, day: "Monday" },
        { ...place, day: "Tuesday" },
      ],
      assistants: [
        { personId: PersonId.make("a-flexible"), days: ["Monday", "Tuesday"], block: "Either" },
        { personId: PersonId.make("b-monday"), days: ["Monday"], block: "1" },
      ],
    };

    // The greedy fit gives Monday to the first assistant and leaves the second without a place.
    expect(draftPlacements(choice, seeded(1), greedy).filledPlaces).toBe(1);

    // One run from that greedy fit: only the annealing moves can fill the second place.
    const plan = draftPlacements(choice, seeded(1), { ...search, restarts: 1 });

    expect(plan.filledPlaces).toBe(2);
    expect(plan.assignments.map(({ personId, day }) => [personId, day])).toEqual([
      ["b-monday", "Monday"],
      ["a-flexible", "Tuesday"],
    ]);
  });

  it("needs one school with room in both blocks for an assistant in both blocks", () => {
    const plan = draftPlacements(
      {
        slots: [
          { schoolId: SchoolId.make(1), day: "Monday", block: "1", places: 1 },
          { schoolId: SchoolId.make(2), day: "Monday", block: "2", places: 1 },
        ],
        assistants: [{ personId: PersonId.make("double"), days: ["Monday"], block: "Both" }],
      },
      seeded(1),
    );

    expect(plan.assignments).toEqual([]);
    expect(plan.unplaced).toEqual(["double"]);
  });
});

describe("placement draft for a board", () => {
  const school = SchoolId.make(7);

  const person = (id: string, status: "Active" | "Pending" = "Active") => ({
    personId: PersonId.make(id),
    departmentId: DepartmentId.make("department"),
    status,
    revision: 1,
    firstName: id,
    lastName: "Assistant",
  });

  const demand = (day: "Monday" | "Tuesday", block: "1" | "2", requiredVolunteers: number) => ({
    schoolId: school,
    day,
    block,
    requiredVolunteers,
    revision: 1,
  });

  const norwegian = { language: "Norsk", preferredSchool: null } as const;

  const returning = { language: "Engelsk", preferredSchool: "Lade skole" } as const;

  it("drafts open demand within capacity for unplaced active assistants", () => {
    const draft = buildPlacementDraft(
      {
        board: {
          departmentId: DepartmentId.make("department"),
          semesterId: SemesterId.make("semester"),
          schools: [{ schoolId: school, name: "Lade skole" }],
          affiliations: [
            person("placed"),
            person("double"),
            person("single"),
            person("unavailable"),
            person("unregistered"),
            person("pending", "Pending"),
          ],
          placements: [
            {
              placementId: `placement-${"a".repeat(64)}`,
              personId: PersonId.make("placed"),
              departmentId: DepartmentId.make("department"),
              semesterId: SemesterId.make("semester"),
              schoolId: school,
              schoolName: "Lade skole",
              day: "Monday",
              block: "1",
              workdays: 4,
              active: true,
              revision: 1,
              firstName: "placed",
              lastName: "Assistant",
            },
          ],
          // Monday: capacity 2 bounds demand 3; the active placement takes one block-1 place.
          demands: [demand("Monday", "1", 3), demand("Monday", "2", 3), demand("Tuesday", "1", 1)],
        },
        availability: [
          { personId: PersonId.make("placed"), days: ["Monday"], block: "1", wishes: norwegian },
          { personId: PersonId.make("double"), days: ["Monday"], block: "Both", wishes: returning },
          {
            personId: PersonId.make("single"),
            days: ["Tuesday"],
            block: "Either",
            wishes: norwegian,
          },
          { personId: PersonId.make("unavailable"), days: [], block: "Either", wishes: norwegian },
          { personId: PersonId.make("pending"), days: ["Tuesday"], block: "1", wishes: norwegian },
        ],
        capacities: [{ schoolId: school, day: "Monday", places: 2 }],
      },
      seeded(1),
    );

    expect(draft.openPlaces).toBe(4);
    expect(draft.filledPlaces).toBe(3);
    expect(
      draft.placements.map(({ personId, day, block, workdays, schoolName, wishes }) => [
        personId,
        schoolName,
        day,
        block,
        workdays,
        wishes,
      ]),
    ).toEqual([
      ["double", "Lade skole", "Monday", "Both", 8, returning],
      ["single", "Lade skole", "Tuesday", "1", 4, norwegian],
    ]);
    // A registration without a suiting weekday keeps its wishes; no registration has none.
    expect(
      draft.unplaced.map(({ personId, reason, wishes }) => [personId, reason, wishes]),
    ).toEqual([
      ["unavailable", "NoAvailability", norwegian],
      ["unregistered", "NoAvailability", null],
    ]);
    expect(draft.openSlots.map(({ day, block, places }) => [day, block, places])).toEqual([
      ["Monday", "2", 1],
    ]);
  });

  it("takes the weekdays not marked unavailable, and both blocks for eight weeks", () => {
    const stated = {
      mondayUnavailable: true,
      tuesdayUnavailable: false,
      wednesdayUnavailable: true,
      thursdayUnavailable: false,
      fridayUnavailable: false,
      positionWeeks: 4,
      preferredGroup: "block-2",
      language: "Engelsk",
    } as const;

    expect(placementSupplyOf(PersonId.make("assistant"), stated, "Lade skole")).toEqual({
      personId: "assistant",
      days: ["Tuesday", "Thursday", "Friday"],
      block: "2",
      wishes: returning,
    });
    expect(
      placementSupplyOf(PersonId.make("assistant"), { ...stated, preferredGroup: "all" }, null),
    ).toMatchObject({ block: "Either" });
    // An eight-week position serves both blocks, whatever block the form also named.
    expect(
      placementSupplyOf(PersonId.make("assistant"), { ...stated, positionWeeks: 8 }, null),
    ).toMatchObject({ block: "Both" });
  });
});

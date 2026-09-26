import { Effect, Random, Schema } from "effect";
import { SqlSchema } from "effect/unstable/sql";
import {
  ReturningAssistantPreferencesSchema,
  type ReturningPreferredGroup,
} from "@vektorprogrammet/domain/application";
import { PersonId } from "@vektorprogrammet/domain/organization";
import {
  PlacementScope,
  SchoolDayCapacity,
  TeachingDay,
  buildPlacementDraft,
  placementDraftSeed,
  type DraftBlock,
  type PlacementAvailability,
} from "@vektorprogrammet/domain/placements";
import { SchoolCapacityPlan } from "@vektorprogrammet/domain/schools";
import { Database } from "../service.js";
import { readPlacementBoard } from "./postgres.js";

const preferences = ReturningAssistantPreferencesSchema.fields;

/**
 * The returning registration's availability, the only native record of it: a public
 * application does not yet state weekdays or blocks. Admissions owns the registration.
 */
const findReturningAvailability = SqlSchema.findAll({
  Request: PlacementScope,
  Result: Schema.Struct({
    personId: PersonId,
    mondayUnavailable: preferences.mondayUnavailable,
    tuesdayUnavailable: preferences.tuesdayUnavailable,
    wednesdayUnavailable: preferences.wednesdayUnavailable,
    thursdayUnavailable: preferences.thursdayUnavailable,
    fridayUnavailable: preferences.fridayUnavailable,
    positionWeeks: preferences.positionWeeks,
    preferredGroup: preferences.preferredGroup,
  }),
  execute: (scope) =>
    Database.use(
      (sql) => sql`
    SELECT DISTINCT ON (registration.person_id) registration.person_id AS "personId",
      registration.monday_unavailable AS "mondayUnavailable",
      registration.tuesday_unavailable AS "tuesdayUnavailable",
      registration.wednesday_unavailable AS "wednesdayUnavailable",
      registration.thursday_unavailable AS "thursdayUnavailable",
      registration.friday_unavailable AS "fridayUnavailable",
      registration.position_weeks AS "positionWeeks",
      registration.preferred_group AS "preferredGroup"
    FROM public.admission_returning_registrations AS registration
    WHERE registration.department_id = ${scope.departmentId}
      AND registration.semester_id = ${scope.semesterId}
    ORDER BY registration.person_id, registration.revision DESC, registration.registered_at DESC`,
    ),
});

const findCapacityPlans = SqlSchema.findAll({
  Request: PlacementScope,
  Result: Schema.Struct({
    schoolId: SchoolCapacityPlan.json.fields.schoolId,
    monday: SchoolCapacityPlan.json.fields.monday,
    tuesday: SchoolCapacityPlan.json.fields.tuesday,
    wednesday: SchoolCapacityPlan.json.fields.wednesday,
    thursday: SchoolCapacityPlan.json.fields.thursday,
    friday: SchoolCapacityPlan.json.fields.friday,
  }),
  execute: (scope) =>
    Database.use(
      (sql) => sql`
    SELECT school_id::double precision AS "schoolId", monday, tuesday, wednesday, thursday, friday
    FROM public.schools_capacity_plans
    WHERE department_id = ${scope.departmentId} AND semester_id = ${scope.semesterId}
    ORDER BY school_id`,
    ),
});

/** "Hele semesteret" takes either block; a named block excludes the other. */
const blockByGroup: Record<ReturningPreferredGroup, DraftBlock> = {
  all: "Either",
  "block-1": "1",
  "block-2": "2",
};

/**
 * Drafts the scoped board after caller authorization and writes nothing. The fixed seed makes
 * the same board, availability, and capacity plans give the same draft.
 */
export const readPlacementDraft = (scope: PlacementScope) =>
  Effect.gen(function* () {
    const board = yield* readPlacementBoard(scope);
    const registrations = yield* findReturningAvailability(scope);
    const plans = yield* findCapacityPlans(scope);
    const random = yield* Random.Random;

    const availability = registrations.map(
      (registration): PlacementAvailability => ({
        personId: registration.personId,
        days: TeachingDay.literals.filter(
          (day) =>
            !{
              Monday: registration.mondayUnavailable,
              Tuesday: registration.tuesdayUnavailable,
              Wednesday: registration.wednesdayUnavailable,
              Thursday: registration.thursdayUnavailable,
              Friday: registration.fridayUnavailable,
            }[day],
        ),
        // Eight weeks is a position in both blocks, as in the legacy scheduler.
        block:
          registration.positionWeeks === 8 ? "Both" : blockByGroup[registration.preferredGroup],
      }),
    );

    const capacities = plans.flatMap((plan) =>
      TeachingDay.literals.map((day) =>
        SchoolDayCapacity.make({
          schoolId: plan.schoolId,
          day,
          places: {
            Monday: plan.monday,
            Tuesday: plan.tuesday,
            Wednesday: plan.wednesday,
            Thursday: plan.thursday,
            Friday: plan.friday,
          }[day],
        }),
      ),
    );

    return buildPlacementDraft({ board, availability, capacities }, random);
  }).pipe(Random.withSeed(placementDraftSeed));

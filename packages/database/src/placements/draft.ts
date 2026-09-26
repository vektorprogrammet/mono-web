import { Effect, Random, Schema } from "effect";
import { SqlSchema } from "effect/unstable/sql";
import {
  AssistantAvailabilityFields,
  ReturningAssistantPreferencesSchema,
} from "@vektorprogrammet/domain/application";
import { PersonId } from "@vektorprogrammet/domain/organization";
import {
  PlacementScope,
  SchoolDayCapacity,
  TeachingDay,
  buildPlacementDraft,
  placementDraftSeed,
  placementSupplyOf,
  type PlacementSupply,
} from "@vektorprogrammet/domain/placements";
import { SchoolCapacityPlan } from "@vektorprogrammet/domain/schools";
import { Database } from "../service.js";
import { readPlacementBoard } from "./postgres.js";

/**
 * What a new applicant's application states, once the interview is conducted: the legacy
 * scheduler took every interviewed applicant. The applicant's Person comes through the account
 * link. Admissions owns the application.
 */
const findApplicationAvailability = SqlSchema.findAll({
  Request: PlacementScope,
  Result: Schema.Struct({ personId: PersonId, ...AssistantAvailabilityFields }),
  execute: (scope) =>
    Database.use(
      (sql) => sql`
    SELECT DISTINCT ON (link.person_id) link.person_id AS "personId",
      application.monday_unavailable AS "mondayUnavailable",
      application.tuesday_unavailable AS "tuesdayUnavailable",
      application.wednesday_unavailable AS "wednesdayUnavailable",
      application.thursday_unavailable AS "thursdayUnavailable",
      application.friday_unavailable AS "fridayUnavailable",
      application.position_weeks AS "positionWeeks",
      application.preferred_group AS "preferredGroup",
      application.language
    FROM public.admission_applications AS application
    INNER JOIN public.admission_periods AS period
      ON period.admission_period_id = application.admission_period_id
      AND period.department_id = application.department_id
    INNER JOIN public.applicant_account_links AS link
      ON link.applicant_id = application.applicant_id
    WHERE application.department_id = ${scope.departmentId}
      AND period.semester_id = ${scope.semesterId}
      AND application.position_weeks IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.recruitment_interviews AS interview
        INNER JOIN public.recruitment_interview_conducts AS conduct
          ON conduct.interview_id = interview.interview_id
        WHERE interview.application_id = application.application_id
      )
    ORDER BY link.person_id, application.submitted_at DESC, application.application_id`,
    ),
});

/** The latest returning registration of each person. Admissions owns the registration. */
const findReturningAvailability = SqlSchema.findAll({
  Request: PlacementScope,
  Result: Schema.Struct({
    personId: PersonId,
    ...AssistantAvailabilityFields,
    preferredSchool: ReturningAssistantPreferencesSchema.fields.preferredSchool,
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
      registration.preferred_group AS "preferredGroup",
      registration.language,
      registration.preferred_school AS "preferredSchool"
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

/**
 * Drafts the scoped board after caller authorization and writes nothing. The fixed seed makes
 * the same board, availability, and capacity plans give the same draft.
 */
export const readPlacementDraft = (scope: PlacementScope) =>
  Effect.gen(function* () {
    const board = yield* readPlacementBoard(scope);
    const applications = yield* findApplicationAvailability(scope);
    const registrations = yield* findReturningAvailability(scope);
    const plans = yield* findCapacityPlans(scope);
    const random = yield* Random.Random;

    // A returning registration replaces what the same person's application states.
    const supply = new Map<PersonId, PlacementSupply>([
      ...applications.map(
        ({ personId, ...availability }) =>
          [personId, placementSupplyOf(personId, availability, null)] as const,
      ),
      ...registrations.map(
        ({ personId, preferredSchool, ...availability }) =>
          [personId, placementSupplyOf(personId, availability, preferredSchool)] as const,
      ),
    ]);

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

    return buildPlacementDraft({ board, availability: [...supply.values()], capacities }, random);
  }).pipe(Random.withSeed(placementDraftSeed));

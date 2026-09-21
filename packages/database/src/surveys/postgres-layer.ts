import { Effect, Layer } from "effect";
import { Database } from "../service.js";
import {
  persistSchoolSurveyResponsePostgres,
  prepareSchoolSurveyResponsePostgres,
  readSchoolSurveyFormPostgres,
} from "./postgres.js";
import { SchoolSurveys } from "@vektorprogrammet/domain/surveys";

/** Live school-survey persistence bound to the process Database. */
export const SchoolSurveysLive = Layer.effect(
  SchoolSurveys,
  Effect.gen(function* () {
    const database = yield* Database;
    return SchoolSurveys.of({
      readForm: (surveyId) =>
        readSchoolSurveyFormPostgres(surveyId).pipe(Effect.provideService(Database, database)),
      prepareResponse: (input) =>
        prepareSchoolSurveyResponsePostgres(input).pipe(Effect.provideService(Database, database)),
      persistResponse: (input) =>
        persistSchoolSurveyResponsePostgres(input).pipe(Effect.provideService(Database, database)),
    });
  }),
);
